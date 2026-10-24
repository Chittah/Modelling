from .core import *
from .models import *
from .fitting import *
from .single_tm import *
from .flows import *

emission_weights = _copy_default_emission_weights()

# SECTION 9 – FLASK ROUTES
# =============================================================================

@app.route("/export_csv", methods=["POST"])
def export_csv():
    data = request.get_json()
    # Create CSV content
    output = "Time_ms,Measured_Intensity,Fitted_Intensity\n"
    for t, m, f in zip(data['time'], data['measured'], data['fitted']):
        output += f"{t},{m},{f}\n"

    return Response(
        output,
        mimetype="text/csv",
        headers={"Content-disposition": "attachment; filename=fit_results.csv"}
    )
@app.route("/")
def index():
    """Serves your interactive_fitter copy.html as the main page."""
    return send_from_directory(app.static_folder, "interactive_fitter copy.html")

@app.route("/fit", methods=["POST"])
def fit():
    fit_request_id = None
    try:
        t0 = time.perf_counter()
        payload = request.get_json() or {}
        fit_request_id = str(payload.get("fit_request_id", "")).strip() or None
        register_fit_request(fit_request_id)
        init_fit_progress(fit_request_id)
        update_fit_progress(fit_request_id, status="running", phase="prepare", message="Preparing fit input data.")

        lum_type = str(payload.get("luminescence_type", "upconversion")).lower()
        up_mech = str(payload.get("upconversion_mechanism", "etuc")).lower()
        model_system = str(payload.get("material_model", "co_doped_yb_tm")).lower()
        if model_system == "single_doped_tm" or lum_type == "downshifting":
            return _fit_single_tm_route(payload, fit_request_id, t0)
        is_etuc_pipeline = (lum_type == "upconversion" and up_mech == "etuc" and model_system != "single_doped_tm")

        # Non-ETUC paths are solved by a dedicated optimization flow.
        if not is_etuc_pipeline:
            update_fit_progress(
                fit_request_id,
                status="running",
                phase="luminescence_dispatch",
                message=f"Solving {lum_type}/{up_mech} with separated optimization flow.",
            )
            out = solve_luminescence_optimization_flow(payload)
            update_fit_progress(
                fit_request_id,
                status="completed",
                phase="completed",
                message="Luminescence flow optimization completed.",
            )
            return jsonify(out)

        time_data = np.array(payload.get("time", []), dtype=float)
        intensity = np.array(payload.get("intensity", []), dtype=float)

        if not physics_state["configured"]:
            return jsonify({"error": "Configure Physics first"}), 400

        intensity = intensity - np.min(intensity)
        # Use 99.5th-percentile as the normalisation reference so that isolated
        # noise spikes do not compress the entire trace to near-zero.
        p_peak = float(np.percentile(intensity, 99.5)) if intensity.size > 10 else float(np.max(intensity))
        if p_peak > 1e-10:
            intensity = np.clip(intensity / p_peak, 0.0, 1.0)
        else:
            intensity = np.zeros_like(intensity)
        t_ms = time_data * physics_state["time_scale"]

        # State Mapping for 11-state model
        emission_map = {
            "1800": 3,
            "775": 7,
            "800": 7,
            "477": 8,
            "475": 8,
            "645": 8,
            "650": 8,
            "452": 9,
            "450": 9,
            "362": 9,
            "363": 9,
            "345": 10,
            "347": 10,
        }
        state_idx = emission_map.get(str(payload.get("emission")), 8)

        requested_quality = payload.get("fit_quality", physics_state.get("fit_quality", "fast"))
        optimize_all_points = bool(payload.get("optimize_all_points", False))
        emission_value = str(payload.get("emission"))
        use_775_calibration = bool(payload.get("use_775_calibration", emission_value == "775"))
        requested_target_r2 = float(payload.get("target_r2", 0.9999))
        fit_time_budget_s = float(payload.get("fit_time_budget_s", 0.0) or 0.0)
        fit_deadline = (time.perf_counter() + fit_time_budget_s) if fit_time_budget_s > 0 else None
        requested_adaptive_cycles = int(payload.get("adaptive_max_cycles", 4))
        requested_peak_window_boost = float(payload.get("peak_window_boost", 1.0))
        requested_early_rise_boost = float(payload.get("early_rise_boost", 1.0))
        # Get user-saved weights for this emission from emission_weights dict
        user_weights = emission_weights.get(emission_value, {})
        user_peak_weight = user_weights.get('peak')
        user_early_weight = user_weights.get('early')

        # Use the larger of payload value and saved value — the payload now
        # carries the fresh UI input; the saved dict may lag behind the debounce.
        if user_peak_weight is not None:
            saved_peak = float(np.clip(user_peak_weight, 1.0, 10.0))
            requested_peak_window_boost = max(requested_peak_window_boost, saved_peak)
            print(f"✅ Peak weight: payload={float(payload.get('peak_window_boost', 1.0)):.2f}, saved={saved_peak:.2f} → using {requested_peak_window_boost:.2f} for {emission_value}")

        if user_early_weight is not None:
            saved_early = float(np.clip(user_early_weight, 1.0, 10.0))
            requested_early_rise_boost = max(requested_early_rise_boost, saved_early)
            print(f"✅ Early weight: payload={float(payload.get('early_rise_boost', 1.0)):.2f}, saved={saved_early:.2f} → using {requested_early_rise_boost:.2f} for {emission_value}")

        # Read tolerances: prefer values sent directly in the fit payload (always
        # fresh from the UI inputs), fall back to persisted emission_weights.
        user_tolerances = user_weights.get('tolerances', {})

        peak_tolerance = float(payload.get('peak_tolerance', user_tolerances.get('peak', 0.01)))
        rise_tolerance = float(payload.get('rise_tolerance', user_tolerances.get('rise', 0.01)))
        decay_tolerance = float(payload.get('decay_tolerance', user_tolerances.get('decay', 0.01)))

        print(f"Using tolerances for {emission_value}: peak={peak_tolerance}, rise={rise_tolerance}, decay={decay_tolerance}")

        if ("doping_yb" not in payload) or ("doping_tm" not in payload):
            return jsonify({
                "error": "Missing required fields: doping_yb and doping_tm must be provided in the fit request payload.",
                "error_code": "MISSING_DOPING",
                "required_fields": ["doping_yb", "doping_tm"],
            }), 400

        try:
            fit_doping_yb = float(payload.get("doping_yb"))
            fit_doping_tm = float(payload.get("doping_tm"))
        except (TypeError, ValueError):
            return jsonify({
                "error": "Invalid doping values: doping_yb and doping_tm must be numeric.",
                "error_code": "INVALID_DOPING",
            }), 400

        if (not np.isfinite(fit_doping_yb)) or (not np.isfinite(fit_doping_tm)):
            return jsonify({
                "error": "Invalid doping values: doping_yb and doping_tm must be finite numbers.",
                "error_code": "INVALID_DOPING",
            }), 400

        lit_params = payload.get("lit_params", {})
        if not isinstance(lit_params, dict):
            lit_params = {}
        else:
            lit_params = dict(lit_params)

        host_material = payload.get("host") or payload.get("host_material") or "NaYF4"
        annealing_c = float(payload.get("anneal_temp", payload.get("annealing_c", 500.0)) or 500.0)
        phonon_energy_cm = payload.get("phonon_energy_cm", payload.get("phonon_energy_nr", None))
        if phonon_energy_cm is not None:
            phonon_energy_cm = float(phonon_energy_cm)
        host_mole_factor = float(payload.get("host_mole_factor", 5.0) or 5.0)

        # Build influenced parameter prior from defaults + user overrides.
        prior = _default_kinetic_params()
        for name, val in lit_params.items():
            param_index = _sim_param_index(name)
            if param_index is not None:
                prior[param_index] = float(val)
        prior_influenced, influence_model = _apply_host_annealing_influence(
            prior,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )
        lit_params = {
            name: float(prior_influenced[i])
            for i, name in enumerate(_SIM_PARAM_NAMES)
        }

        # Optional frontend-provided time-zero shift hint (ms).
        # This seeds T_offset for optimization; it is still optimized (not fixed).
        requested_time_offset_ms = float(payload.get("time_offset_ms", 0.0) or 0.0)
        max_offset_hint = float(np.max(t_ms) * 0.3) if t_ms.size else 0.0
        lit_params["T_offset"] = float(np.clip(requested_time_offset_ms, 0.0, max_offset_hint))
        cancel_checker = (lambda: is_fit_cancelled(fit_request_id)) if fit_request_id else None

        def progress_cb(info):
            update_fit_progress(
                fit_request_id,
                status="running",
                quality_attempt=requested_quality,
                optimize_all_points=bool(optimize_all_points),
                **(info or {}),
            )

        update_fit_progress(
            fit_request_id,
            status="running",
            phase="run_fitting",
            message=f"Running {requested_quality} fit (all_points={bool(optimize_all_points)}).",
            target_r2=float(requested_target_r2),
            adaptive_max_cycles=int(np.clip(requested_adaptive_cycles, 1, 50)),
            peak_window_boost=float(np.clip(requested_peak_window_boost, 1.0, 10.0)),
            early_rise_boost=float(np.clip(requested_early_rise_boost, 1.0, 10.0)),
        )

        fit_y, best_params, sse, diag = run_fitting(
            t_ms, intensity, payload.get("pulse_width_us", 400),
            state_idx,
            fit_doping_yb,
            fit_doping_tm,
            requested_quality,
            optimize_all_points=optimize_all_points,
            lit_params=lit_params,
            use_775_calibration=use_775_calibration,
            emission_key=emission_value,
            cancel_checker=cancel_checker,
            target_r2=requested_target_r2,
            adaptive_max_cycles=requested_adaptive_cycles,
            peak_window_boost=requested_peak_window_boost,
            early_rise_boost=requested_early_rise_boost,
            peak_tolerance=peak_tolerance,
            rise_tolerance=rise_tolerance,
            decay_tolerance=decay_tolerance,
            progress_callback=progress_cb,
            deadline=fit_deadline,
        )

        # Automatic best-fit search: sweep quality/all-points combinations and keep
        # the candidate with the lowest SSE (highest R^2), while tracking all changes
        # attempted for troubleshooting visibility.
        try_best_match = bool(payload.get("try_best_match", True))
        target_r2 = float(payload.get("target_r2", 0.9999))
        target_r2 = float(np.clip(target_r2, 0.0, 0.999995))
        denom = np.sum((intensity - np.mean(intensity))**2) + 1e-12

        quality_order = ["fast", "balanced", "accurate"]
        requested_quality = requested_quality if requested_quality in quality_order else "fast"
        requested_idx = quality_order.index(requested_quality)

        candidate_plan = []
        seen_plan = set()

        def add_candidate(q, all_points, reason):
            key = (q, bool(all_points))
            if key in seen_plan:
                return
            seen_plan.add(key)
            candidate_plan.append((q, bool(all_points), reason))

        add_candidate(requested_quality, optimize_all_points, "requested")

        if try_best_match:
            for q in quality_order[requested_idx:]:
                add_candidate(q, optimize_all_points, "quality_sweep")

        # For very high R^2 targets, include full-point optimization attempts.
        if try_best_match and target_r2 >= 0.9997 and not optimize_all_points:
            base_qualities = quality_order[requested_idx:] if try_best_match else [requested_quality]
            for q in base_qualities:
                add_candidate(q, True, "all_points_for_high_target")

        # For high target R2, run one strict accurate+all-points pass for any
        # supported emission to tighten apex and rise alignment consistently.
        if try_best_match and emission_value in emission_map and target_r2 >= 0.9999:
            add_candidate("accurate", True, f"{emission_value}_strict_peak_pass")

        # First fit already computed above; use it as baseline.
        current_r2 = 1.0 - sse / denom
        best_fit = fit_y
        best_params_all = best_params
        best_sse = float(sse)
        best_diag = dict(diag)
        best_quality = requested_quality
        best_all_points = bool(optimize_all_points)

        attempt_logs = [{
            "quality": requested_quality,
            "optimize_all_points": bool(optimize_all_points),
            "reason": "requested",
            "r2": float(current_r2),
            "sse": float(sse),
            "accepted": True,
            "from_cached_run": True,
        }]

        pulse_us = payload.get("pulse_width_us", 400)
        for idx_attempt, (q, all_points, reason) in enumerate(candidate_plan, start=1):
            if q == requested_quality and bool(all_points) == bool(optimize_all_points):
                continue
            if (1.0 - (best_sse / denom)) >= target_r2 and best_diag.get("all_tolerances_met", False):
                attempt_logs.append({
                    "quality": q, "optimize_all_points": bool(all_points), "reason": reason,
                    "r2": float(1.0 - (best_sse / denom)), "sse": float(best_sse),
                    "accepted": False, "from_cached_run": False,
                    "skipped": "target R2 and tolerances already met",
                })
                break
            if fit_deadline is not None and time.perf_counter() > fit_deadline:
                update_fit_progress(
                    fit_request_id, status="running", phase="time_budget",
                    message="Fit time budget reached; skipping remaining candidates.",
                )
                break
            update_fit_progress(
                fit_request_id,
                status="running",
                phase="quality_sweep",
                attempt_index=idx_attempt,
                attempts_total=len(candidate_plan),
                quality_attempt=q,
                optimize_all_points=bool(all_points),
                message=(
                    f"Trying candidate {idx_attempt}/{len(candidate_plan)}: "
                    f"quality={q}, all_points={bool(all_points)} ({reason})."
                ),
            )

            def candidate_progress_cb(info, _q=q, _all=bool(all_points)):
                update_fit_progress(
                    fit_request_id,
                    status="running",
                    quality_attempt=_q,
                    optimize_all_points=_all,
                    **(info or {}),
                )

            fit_y_c, best_params_c, sse_c, diag_c = run_fitting(
                t_ms,
                intensity,
                pulse_us,
                state_idx,
                fit_doping_yb,
                fit_doping_tm,
                q,
                optimize_all_points=all_points,
                lit_params=lit_params,
                use_775_calibration=use_775_calibration,
                emission_key=emission_value,
                cancel_checker=cancel_checker,
                target_r2=requested_target_r2,
                adaptive_max_cycles=requested_adaptive_cycles,
                peak_window_boost=requested_peak_window_boost,
                early_rise_boost=requested_early_rise_boost,
                progress_callback=candidate_progress_cb,
                peak_tolerance=peak_tolerance,
                rise_tolerance=rise_tolerance,
                decay_tolerance=decay_tolerance,
                deadline=fit_deadline,
            )

            r2_c = 1.0 - (float(sse_c) / denom)
            accepted = float(sse_c) < best_sse
            attempt_logs.append({
                "quality": q,
                "optimize_all_points": bool(all_points),
                "reason": reason,
                "r2": float(r2_c),
                "sse": float(sse_c),
                "accepted": bool(accepted),
                "from_cached_run": False,
            })

            if accepted:
                best_fit = fit_y_c
                best_params_all = best_params_c
                best_sse = float(sse_c)
                best_diag = dict(diag_c)
                best_quality = q
                best_all_points = bool(all_points)

        fit_y, best_params, sse, diag = best_fit, best_params_all, best_sse, best_diag
        achieved_r2 = 1.0 - (best_sse / denom)

        diag["selected_from"] = requested_quality
        diag["selected_quality"] = best_quality
        diag["selected_optimize_all_points"] = bool(best_all_points)
        diag["target_r2"] = float(target_r2)
        diag["target_reached"] = bool(achieved_r2 >= target_r2)
        diag["r2_gap_to_target"] = float(max(0.0, target_r2 - achieved_r2))
        diag["best_fit_attempts"] = attempt_logs

        # Troubleshooting block: includes every attempted strategy and why 0.9995
        # may remain unreachable for a given trace/noise profile.
        i_pk = int(np.argmax(intensity))
        abs_err = np.abs(intensity - fit_y)
        early_mae = float(np.mean(abs_err[:max(i_pk, 1)]))
        peak_lo = max(0, i_pk - max(2, intensity.size // 12))
        peak_hi = min(intensity.size, i_pk + max(2, intensity.size // 12))
        peak_mae = float(np.mean(abs_err[peak_lo:peak_hi])) if peak_hi > peak_lo else 0.0
        tail_mae = float(np.mean(abs_err[i_pk:])) if i_pk < intensity.size else 0.0
        dominant_region = max(
            [("early", early_mae), ("peak", peak_mae), ("tail", tail_mae)],
            key=lambda x: x[1]
        )[0]

        attempted_change_lines = [
            f"{a['quality']} | all_points={a['optimize_all_points']} | reason={a['reason']} | "
            f"R2={a['r2']:.6f} | accepted={a['accepted']}"
            for a in attempt_logs
        ]

        recommendations = []
        error_code = "OK"
        secondary_error_codes = []
        influence_info = influence_model if isinstance(influence_model, dict) else {}
        combined_nr_factor = float(influence_info.get("combined_nr_factor", 1.0) or 1.0)
        host_nr_factor = float(influence_info.get("host_nr_factor", 1.0) or 1.0)
        anneal_nr_factor = float(influence_info.get("anneal_nr_factor", 1.0) or 1.0)
        mole_nr_factor = float(influence_info.get("mole_nr_factor", 1.0) or 1.0)
        nr_is_critical = (combined_nr_factor > 1.30) or (combined_nr_factor < 0.75)
        nr_is_warning = ((combined_nr_factor > 1.25) and (combined_nr_factor <= 1.30)) or ((combined_nr_factor >= 0.75) and (combined_nr_factor < 0.80))
        nr_severity = "critical" if nr_is_critical else ("warning" if nr_is_warning else "nominal")
        nr_band_distance = 0.0
        if combined_nr_factor > 1.30:
            nr_band_distance = combined_nr_factor - 1.30
        elif combined_nr_factor < 0.75:
            nr_band_distance = 0.75 - combined_nr_factor

        if achieved_r2 < target_r2:
            error_code = "FIT-E00"
            recommendations.append(
                f"[FIT-E00] Target R2 {target_r2:.4f} not reached; best achieved {achieved_r2:.6f}. "
                "This usually indicates experimental noise/normalization limits rather than optimizer failure."
            )
            if dominant_region == "early":
                error_code = "FIT-E11"
                recommendations.append("[FIT-E11] Dominant error region is early rise: verify pulse width and time-zero alignment (T_offset), then enable early-rise enhancement only if mismatch remains.")
            elif dominant_region == "peak":
                error_code = "FIT-E12"
                recommendations.append("[FIT-E12] Dominant error region is peak window: tune local peak weight or check detector saturation near apex.")
            else:
                error_code = "FIT-E13"
                recommendations.append("[FIT-E13] Dominant error region is tail: re-check baseline correction and long-time SNR.")

            if nr_is_critical:
                secondary_error_codes.append("FIT-E31")
                recommendations.append(
                    f"[FIT-E31] Host/annealing non-radiative scaling is far from nominal: combined_nr_factor={combined_nr_factor:.4f} "
                    f"(host={host_nr_factor:.4f}, anneal={anneal_nr_factor:.4f}, mole={mole_nr_factor:.4f}). "
                    "Revisit host mole factor, lattice phonon energy, and annealing temperature assumptions before over-tuning kinetics."
                )
            elif nr_is_warning:
                secondary_error_codes.append("FIT-E31-WARN")
                recommendations.append(
                    f"[FIT-E31-WARN] Host/annealing non-radiative scaling is near alert band: combined_nr_factor={combined_nr_factor:.4f} "
                    f"(host={host_nr_factor:.4f}, anneal={anneal_nr_factor:.4f}, mole={mole_nr_factor:.4f}). "
                    "Treat this as a caution before escalating kinetic weights."
                )

        diag["troubleshooting"] = {
            "summary": (
                f"Best strategy selected: quality={best_quality}, all_points={best_all_points}, "
                f"R2={achieved_r2:.6f}."
            ),
            "target_r2": float(target_r2),
            "achieved_r2": float(achieved_r2),
            "target_reached": bool(achieved_r2 >= target_r2),
            "primary_error_code": error_code,
            "error_code": error_code,
            "secondary_error_codes": secondary_error_codes,
            "legacy_error_code": {
                "FIT-E11": "FIT-E01",
                "FIT-E12": "FIT-E02",
                "FIT-E13": "FIT-E03",
                "FIT-E21": "FIT-E04",
                "FIT-E22": "FIT-E05",
            }.get(error_code, error_code),
            "nr_diagnostics": {
                "combined_nr_factor": float(combined_nr_factor),
                "host_nr_factor": float(host_nr_factor),
                "anneal_nr_factor": float(anneal_nr_factor),
                "mole_nr_factor": float(mole_nr_factor),
                "severity": nr_severity,
                "critical_range": "<0.75 or >1.30",
                "warning_range": "0.75-0.80 or 1.25-1.30",
                "distance_from_critical_band": float(nr_band_distance),
            },
            "dominant_error_region": dominant_region,
            "region_mae": {
                "early": early_mae,
                "peak": peak_mae,
                "tail": tail_mae,
            },
            "changes_applied": attempted_change_lines,
            "recommendations": recommendations,
            "code_legend": {
                "FIT-E00": "Global quality gap: target R2 not reached",
                "FIT-E11": "Early-rise mismatch dominates",
                "FIT-E12": "Peak-window mismatch dominates",
                "FIT-E13": "Tail mismatch dominates",
                "FIT-E21": "Timing mismatch despite acceptable R2",
                "FIT-E22": "Decay tau difference exceeds threshold",
                "FIT-E31": "Host/annealing influence likely over-constraining fit",
                "FIT-E31-WARN": "Host/annealing influence near alert band",
                "FIT-E41": "Peak timing tolerance not met",
                "FIT-E42": "Rise time tolerance not met",
                "FIT-E43": "Decay tau tolerance not met",
            },
        }

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        elapsed_min = elapsed_ms / 60000.0

        r2 = 1.0 - (sse / denom)

        param_names = [
            "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
            "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "WcrH4", "Wb", "T_offset", "WcrG4"
        ]
        params_all = {name: float(val) for name, val in zip(param_names, best_params)}
        all_units = {
            "Rp": "ms-1",
            "Ay": "ms-1",
            "W1": "ms-1",
            "W2": "ms-1",
            "W3": "ms-1",
            "W4": "ms-1",
            "W5": "ms-1",
            "k21": "ms-1",
            "k35": "ms-1",
            "A10": "ms-1",
            "A50": "ms-1",
            "A60": "ms-1",
            "A61": "ms-1",
            "A70": "ms-1",
            "A71": "ms-1",
            "A80": "ms-1",
            "A81": "ms-1",
            "WcrH4": "ms-1",
            "Wb":  "ms-1",
            "T_offset": "ms",
            "WcrG4": "ms-1",
        }

        measured_metrics = compute_trace_metrics(t_ms, intensity)
        fitted_metrics = compute_trace_metrics(t_ms, fit_y)
        param_roles = classify_parameter_roles(state_idx, fit_doping_yb, fit_doping_tm)

        peak_time_abs_err = None
        rise_time_abs_err = None
        decay_tau_abs_err = None
        if isinstance(measured_metrics, dict) and isinstance(fitted_metrics, dict):
            if measured_metrics.get("peak_time") is not None and fitted_metrics.get("peak_time") is not None:
                peak_time_abs_err = abs(float(fitted_metrics["peak_time"]) - float(measured_metrics["peak_time"]))
            if measured_metrics.get("rise_time_10_90") is not None and fitted_metrics.get("rise_time_10_90") is not None:
                rise_time_abs_err = abs(float(fitted_metrics["rise_time_10_90"]) - float(measured_metrics["rise_time_10_90"]))
            if measured_metrics.get("decay_tau_1e") is not None and fitted_metrics.get("decay_tau_1e") is not None:
                decay_tau_abs_err = abs(float(fitted_metrics["decay_tau_1e"]) - float(measured_metrics["decay_tau_1e"]))

        rise_ratio_err = None if rise_time_abs_err is None else rise_time_abs_err / max(abs(float(measured_metrics.get("rise_time_10_90") or 0.0)), 1e-12)
        decay_ratio_err = None if decay_tau_abs_err is None else decay_tau_abs_err / max(abs(float(measured_metrics.get("decay_tau_1e") or 0.0)), 1e-12)
        peak_ratio_err = None if peak_time_abs_err is None else peak_time_abs_err / max(abs(float(measured_metrics.get("peak_time") or 0.0)), 1e-12)

        timing_mismatch_warning = any([
            rise_ratio_err is not None and rise_ratio_err > 0.20,
            decay_ratio_err is not None and decay_ratio_err > 0.20,
            peak_ratio_err is not None and peak_ratio_err > 0.15,
        ])

        troubleshooting_block = diag.get("troubleshooting") if isinstance(diag, dict) else None
        if isinstance(troubleshooting_block, dict):
            # Tighter fitting logic: decay tau difference >0.1 triggers rejection and improvement suggestions
            decay_tau_threshold = 0.1
            if decay_tau_abs_err is not None and decay_tau_abs_err > decay_tau_threshold:
                troubleshooting_block["error_code"] = "FIT-E22"
                troubleshooting_block["primary_error_code"] = "FIT-E22"
                troubleshooting_block["legacy_error_code"] = "FIT-E05"
                troubleshooting_block["target_reached"] = False
                troubleshooting_block.setdefault("recommendations", []).append(
                    f"[FIT-E22] Decay tau difference ({decay_tau_abs_err:.3f}) exceeds threshold ({decay_tau_threshold}). Check baseline, pulse width, and timing alignment."
                )
            elif troubleshooting_block.get("target_reached") and timing_mismatch_warning:
                troubleshooting_block["error_code"] = "FIT-E21"
                troubleshooting_block["primary_error_code"] = "FIT-E21"
                troubleshooting_block["legacy_error_code"] = "FIT-E04"
                troubleshooting_block.setdefault("recommendations", []).append(
                    "[FIT-E21] Timing mismatch remains despite acceptable R²: prefer the solution with lower rise/peak timing error, especially for 345/362 multi-channel runs."
                )
            troubleshooting_block["timing_error_abs"] = {
                "peak_time": peak_time_abs_err,
                "rise_time_10_90": rise_time_abs_err,
                "decay_tau_1e": decay_tau_abs_err,
            }
            troubleshooting_block["timing_error_ratio"] = {
                "peak_time": peak_ratio_err,
                "rise_time_10_90": rise_ratio_err,
                "decay_tau_1e": decay_ratio_err,
            }

            # Tolerance-based error codes: check user-set tolerances
            # Proposals are based on the *actual weights used* in this fit and the
            # *relative error distribution* across regions, so the next retry can
            # explore around the proven-good weights rather than blindly escalating.
            tol_info = diag.get("tolerance_achieved", {})
            tol_targets = diag.get("tolerance_targets", {})
            used_peak_w = diag.get("peak_window_boost", 1.0)
            used_early_w = diag.get("early_rise_boost", 1.0)

            # Compute per-region error severity to distribute weight emphasis.
            peak_err = tol_info.get("peak")
            rise_err = tol_info.get("rise")
            decay_err = tol_info.get("decay")
            peak_tgt = tol_targets.get("peak", 0.01)
            rise_tgt = tol_targets.get("rise", 0.01)
            decay_tgt = tol_targets.get("decay", 0.01)

            # Fractional gap: how far each error is from its target (0 = met)
            peak_gap = max(0, (peak_err or 0) - peak_tgt) / max(peak_tgt, 1e-12)
            rise_gap = max(0, (rise_err or 0) - rise_tgt) / max(rise_tgt, 1e-12)
            decay_gap = max(0, (decay_err or 0) - decay_tgt) / max(decay_tgt, 1e-12)
            total_gap = peak_gap + rise_gap + decay_gap + 1e-12

            # Weight adjustment: scale relative to which region needs the most help,
            # anchored on the weights that actually produced the current best fit.
            tol_codes_added = []
            if peak_err is not None and peak_tgt is not None:
                if peak_err > peak_tgt:
                    tol_codes_added.append("FIT-E41")
                    # Proportional to this region's share of total error
                    region_share = peak_gap / total_gap
                    # Small multiplicative bump on the used weight, scaled by region share
                    boost_proposal = min(10.0, max(used_peak_w, used_peak_w * (1.0 + 0.15 * region_share * (peak_gap + 1))))
                    extra_cycles = max(2, min(8, int(2 + peak_gap)))
                    troubleshooting_block.setdefault("recommendations", []).append(
                        f"[FIT-E41] Peak timing tolerance not met: error {peak_err:.4f} > target {peak_tgt:.4f}. "
                        f"Proposed: increase peak weight to {boost_proposal:.2f}, add {extra_cycles} adaptive cycles."
                    )
                    troubleshooting_block.setdefault("proposed_actions", []).append({
                        "code": "FIT-E41", "action": "boost_peak",
                        "peak_window_boost": round(boost_proposal, 3),
                        "used_weight": round(used_peak_w, 3),
                        "extra_adaptive_cycles": extra_cycles,
                    })
            if rise_err is not None and rise_tgt is not None:
                if rise_err > rise_tgt:
                    tol_codes_added.append("FIT-E42")
                    region_share = rise_gap / total_gap
                    boost_proposal = min(10.0, max(used_early_w, used_early_w * (1.0 + 0.15 * region_share * (rise_gap + 1))))
                    extra_cycles = max(3, min(10, int(3 + rise_gap * 1.5)))
                    troubleshooting_block.setdefault("recommendations", []).append(
                        f"[FIT-E42] Rise time tolerance not met: error {rise_err:.4f} > target {rise_tgt:.4f}. "
                        f"Proposed: increase early-rise weight to {boost_proposal:.2f}, switch to long mode, add {extra_cycles} adaptive cycles."
                    )
                    troubleshooting_block.setdefault("proposed_actions", []).append({
                        "code": "FIT-E42", "action": "boost_early_rise",
                        "early_rise_boost": round(boost_proposal, 3),
                        "used_weight": round(used_early_w, 3),
                        "fit_mode": "long",
                        "extra_adaptive_cycles": extra_cycles,
                    })
            if decay_err is not None and decay_tgt is not None:
                if decay_err > decay_tgt:
                    tol_codes_added.append("FIT-E43")
                    extra_cycles = max(3, min(10, int(3 + decay_gap * 2)))
                    troubleshooting_block.setdefault("recommendations", []).append(
                        f"[FIT-E43] Decay tau tolerance not met: error {decay_err:.4f} > target {decay_tgt:.4f}. "
                        f"Proposed: switch to long mode, add {extra_cycles} adaptive cycles."
                    )
                    troubleshooting_block.setdefault("proposed_actions", []).append({
                        "code": "FIT-E43", "action": "improve_decay",
                        "fit_mode": "long",
                        "extra_adaptive_cycles": extra_cycles,
                    })
            if tol_codes_added:
                # Set the most specific tolerance error as the primary code if no
                # more severe code (E22, E21) is already present
                current_code = troubleshooting_block.get("error_code", "OK")
                if current_code in ("OK", "FIT-E00", "FIT-E11", "FIT-E12", "FIT-E13"):
                    troubleshooting_block["error_code"] = tol_codes_added[0]
                    troubleshooting_block["primary_error_code"] = tol_codes_added[0]
                    troubleshooting_block["target_reached"] = False
            troubleshooting_block["tolerance_codes"] = tol_codes_added

        # Only expose parameters that appear directly in the selected emission's ODE equation.
        direct_params = set(param_roles["direct"])  # already includes T_offset
        selected_params = {k: v for k, v in params_all.items() if k in direct_params}
        param_units = {k: v for k, v in all_units.items() if k in direct_params}

        # Extra guided parameters from 775 calibration stage (non-direct but informative for transfer).
        guided_names = [p for p in diag.get("guided_params", []) if p in params_all]
        guide_parameters = {k: params_all[k] for k in guided_names}

        update_fit_progress(
            fit_request_id,
            status="completed",
            phase="completed",
            current_r2=float(r2),
            message=f"Fit completed.",
        )

        return jsonify({
            "r2": float(r2),
            "fitted_intensity": fit_y.tolist(),
            "measured_intensity": intensity.tolist(),
            "params": {
                "R_P": float(best_params[0]),
                "W_ET1": float(best_params[2]),
                **({"W_CR_H4": float(best_params[17])} if "WcrH4" in selected_params else {}),
                **({"Wb": float(best_params[18])} if "Wb" in selected_params else {}),
                "T_offset": float(best_params[19]),
                **({"W_CR_G4": float(best_params[20])} if "WcrG4" in selected_params else {}),
            },
            "ode_parameters": selected_params,
            "ode_parameter_units": param_units,
            "ode_parameter_time_base": "ms",
            "guide_parameters": guide_parameters,
            "parameter_roles": param_roles,
            "timing_metrics": {
                "time_unit": "ms",
                "measured": measured_metrics,
                "fitted": fitted_metrics,
            },
            "influence_model": influence_model,
            "diagnostics": {
                **diag,
                "elapsed_ms": float(elapsed_ms),
                "elapsed_min": float(elapsed_min)
            },
        })
    except FitCancelled:
        update_fit_progress(fit_request_id, status="cancelled", phase="cancelled", message="Fit cancelled by user.")
        return jsonify({
            "cancelled": True,
            "fit_request_id": fit_request_id,
        }), 200
    except Exception:
        update_fit_progress(fit_request_id, status="error", phase="error", message="Fit failed due to backend error.")
        return jsonify({"error": traceback.format_exc()}), 500
    finally:
        clear_fit_request(fit_request_id)
        clear_fit_progress(fit_request_id)


@app.route("/fit_progress", methods=["GET"])
def fit_progress():
    fit_request_id = str(request.args.get("fit_request_id", "")).strip()
    if not fit_request_id:
        return jsonify({"error": "Missing fit_request_id"}), 400

    progress = get_fit_progress(fit_request_id)
    if not progress:
        return jsonify({"fit_request_id": fit_request_id, "found": False}), 200

    return jsonify({
        "fit_request_id": fit_request_id,
        "found": True,
        **progress,
    })


@app.route("/cancel_fit", methods=["POST"])
def cancel_fit():
    payload = request.get_json() or {}
    fit_request_id = str(payload.get("fit_request_id", "")).strip()
    if not fit_request_id:
        return jsonify({"error": "Missing fit_request_id"}), 400

    cancel_fit_request(fit_request_id)
    return jsonify({"ok": True, "fit_request_id": fit_request_id})

@app.route("/api/configure_physics", methods=["POST"])
def configure_physics():
    config = request.get_json() or {}
    time_unit = str(config.get("time_unit", "ns"))
    time_scale = {"ns": 1e-6, "us": 1e-3, "ms": 1.0}.get(time_unit, 1.0)
    host = str(config.get("host", "NaYF4"))
    phonon_energy_cm = float(config.get("phonon_energy_cm", 350.0) or 350.0)
    fit_quality = str(config.get("fit_quality", physics_state.get("fit_quality", "fast")))

    # Lightweight regime tag used by frontend status text.
    if phonon_energy_cm < 300.0:
        regime = "very_low_phonon"
    elif phonon_energy_cm < 420.0:
        regime = "low_phonon"
    elif phonon_energy_cm < 600.0:
        regime = "medium_phonon"
    else:
        regime = "high_phonon"

    physics_state.update({
        "configured": True,
        "time_scale": time_scale,
        "doping_yb": float(config.get("doping_yb", 10.0)),
        "doping_tm": float(config.get("doping_tm", 0.1)),
        "time_unit": time_unit,
        "fit_quality": fit_quality,
    })
    return jsonify({
        "success": True,
        "model_selected": "multilevel_ode",
        "regime": regime,
        "w_et_upper": 150.0,
        "w_cr_g4_active": bool(physics_state.get("doping_tm", 0.0) > 0.1),
        "w_cr_h4_active": bool(physics_state.get("doping_tm", 0.0) > 1.0),
        "w_b_active": bool(physics_state.get("doping_yb", 0.0) > 10.0),
        "time_scale_factor": float(time_scale),
        "host": host,
        "phonon_energy_cm": phonon_energy_cm,
        "fit_quality": fit_quality,
    })


@app.route("/simulate_luminescence_flow", methods=["POST"])
def simulate_luminescence_flow_route():
    """Simulate selected luminescence pathway without optimization."""
    try:
        payload = request.get_json() or {}
        out = solve_luminescence_simulation_flow(payload)
        return jsonify(out)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/fit_luminescence_flow", methods=["POST"])
def fit_luminescence_flow_route():
    """Optimize selected luminescence pathway using its dedicated solver."""
    try:
        payload = request.get_json() or {}
        out = solve_luminescence_optimization_flow(payload)
        return jsonify(out)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

@app.route("/simulate_lifetime", methods=["POST"])
def simulate_lifetime_route():
    """
    Forward ODE simulation — no fitting. Returns normalized intensity traces
    per emission channel for a given sample composition and kinetic parameters.
    """
    try:
        payload = request.get_json() or {}
        yb_pct      = float(payload.get("yb_pct", 10.0))
        tm_pct      = float(payload.get("tm_pct", 0.1))
        emissions   = [str(e) for e in (payload.get("emissions") or ["775", "477", "645", "362", "345"])]
        pulse_us    = float(payload.get("pulse_us", 400.0))
        time_max_ms = float(payload.get("time_max_ms", 15.0))
        num_points  = int(np.clip(int(payload.get("num_points", 500)), 100, 2000))
        host_material = payload.get("host_material", "NaYF4")
        annealing_c = float(payload.get("annealing_c", 500.0))
        phonon_energy_cm = payload.get("phonon_energy_cm", None)
        if phonon_energy_cm is not None:
            phonon_energy_cm = float(phonon_energy_cm)
        host_mole_factor = float(payload.get("host_mole_factor", 5.0))
        yb_values = _parse_numeric_list(payload.get("yb_values"))
        tm_values = _parse_numeric_list(payload.get("tm_values"))
        sweep_mode = str(payload.get("sweep_mode", "paired")).lower()
        user_params = payload.get("lit_params") or {}

        params = _default_kinetic_params()
        for name, val in user_params.items():
            param_index = _sim_param_index(name)
            if param_index is not None:
                params[param_index] = float(val)

        t_arr  = np.linspace(0.0, time_max_ms, num_points)

        do_sweep = (len(yb_values) > 1) or (len(tm_values) > 1)
        if do_sweep:
            if not yb_values:
                yb_values = [yb_pct]
            if not tm_values:
                tm_values = [tm_pct]

            pairs = []
            if sweep_mode == "grid":
                for yb_i in yb_values:
                    for tm_i in tm_values:
                        pairs.append((float(yb_i), float(tm_i)))
            else:
                n = max(len(yb_values), len(tm_values))
                for i in range(n):
                    yb_i = float(yb_values[i]) if i < len(yb_values) else float(yb_values[-1])
                    tm_i = float(tm_values[i]) if i < len(tm_values) else float(tm_values[-1])
                    pairs.append((yb_i, tm_i))

            sweeps = []
            for yb_i, tm_i in pairs:
                traces_i = simulate_forward(
                    yb_i,
                    tm_i,
                    emissions,
                    pulse_us,
                    t_arr,
                    params,
                    host_material=host_material,
                    annealing_c=annealing_c,
                    phonon_energy_cm=phonon_energy_cm,
                    host_mole_factor=host_mole_factor,
                )
                channels_i = {}
                for em, intensity_arr in traces_i.items():
                    channels_i[em] = {
                        "intensity": intensity_arr.tolist(),
                        "metrics": compute_trace_metrics(t_arr, intensity_arr),
                    }
                sweeps.append({
                    "label": f"Yb {yb_i:.3f}% / Tm {tm_i:.3f}%",
                    "yb_pct": yb_i,
                    "tm_pct": tm_i,
                    "channels": channels_i,
                })

            _, influence = _apply_host_annealing_influence(
                params,
                host_material=host_material,
                annealing_c=annealing_c,
                phonon_energy_cm=phonon_energy_cm,
                host_mole_factor=host_mole_factor,
            )
            return jsonify({
                "ok": True,
                "time": t_arr.tolist(),
                "sweeps": sweeps,
                "sweep_mode": sweep_mode,
                "host_material": host_material,
                "annealing_c": annealing_c,
                "host_mole_factor": host_mole_factor,
                "influence_model": influence,
            })

        traces = simulate_forward(
            yb_pct,
            tm_pct,
            emissions,
            pulse_us,
            t_arr,
            params,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )

        channels = {}
        for em, intensity_arr in traces.items():
            metrics = compute_trace_metrics(t_arr, intensity_arr)
            channels[em] = {
                "intensity": intensity_arr.tolist(),
                "metrics": metrics,
            }

        _, influence = _apply_host_annealing_influence(
            params,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )
        return jsonify({
            "ok": True,
            "time": t_arr.tolist(),
            "channels": channels,
            "yb_pct": yb_pct,
            "tm_pct": tm_pct,
            "host_material": host_material,
            "annealing_c": annealing_c,
            "host_mole_factor": host_mole_factor,
            "influence_model": influence,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/estimate_composition", methods=["POST"])
def estimate_composition_route():
    """
    Estimate Yb% and Tm% from timing metrics (peak time + decay τ) and/or full
    traces per channel, with all kinetic rate parameters held fixed.

    Two input modes (can be mixed per channel):
      1. Timing targets  – {emission: {peak_time_ms: X, decay_tau_ms: Y}}
      2. Full traces     – {emission: {time: [...], intensity: [...]}}

    The optimizer searches only the 2-D composition space (Yb%, Tm%) using
    differential_evolution and returns the best estimate, channel-level quality,
    and a ±15 % heuristic confidence range.
    """
    try:
        np.random.seed(42)  # Ensure full reproducibility across every run
        payload      = request.get_json() or {}
        channels_raw = payload.get("channels") or {}
        user_params  = payload.get("lit_params") or {}
        yb_range     = [float(v) for v in (payload.get("yb_range") or [1.0, 50.0])]
        tm_range     = [float(v) for v in (payload.get("tm_range") or [0.01, 5.0])]
        pulse_us     = float(payload.get("pulse_us", 400.0))
        host_material = payload.get("host_material", "NaYF4")
        annealing_c = float(payload.get("annealing_c", 500.0))
        phonon_energy_cm = payload.get("phonon_energy_cm", None)
        if phonon_energy_cm is not None:
            phonon_energy_cm = float(phonon_energy_cm)
        host_mole_factor = float(payload.get("host_mole_factor", 5.0))
        optimize_kinetics = bool(payload.get("optimize_kinetics", False))
        iterative_rounds = int(np.clip(int(payload.get("iterative_rounds", 1)), 1, 20))
        de_maxiter = int(np.clip(int(payload.get("de_maxiter", 50)), 10, 500))
        kinetics_scale_bounds = payload.get("kinetics_scale_bounds") or [0.7, 1.3]
        scale_lo = float(np.clip(float(kinetics_scale_bounds[0]), 0.4, 1.0))
        scale_hi = float(np.clip(float(kinetics_scale_bounds[1]), 1.0, 3.0))
        if scale_hi <= scale_lo:
            scale_lo, scale_hi = 0.7, 1.3

        if not channels_raw:
            return jsonify({"error": "No channel data provided"}), 400

        params = _default_kinetic_params()
        for name, val in user_params.items():
            param_index = _sim_param_index(name)
            if param_index is not None:
                params[param_index] = float(val)

        candidate_kinetics = payload.get("kinetics_to_optimize") or [
            "W1", "W2", "W3", "k21", "k35", "WcrH4", "WcrG4", "Wb", "A50", "A60", "A61"
        ]
        kinetic_names = [
            _SIM_PARAM_NAMES[index] for k in candidate_kinetics
            if (index := _sim_param_index(k)) is not None and _SIM_PARAM_NAMES[index] not in {"T_offset", "Rp"}
        ]
        kinetic_names = list(dict.fromkeys(kinetic_names))
        tm_max = min(5.0, max(0.01, float(tm_range[1])))
        yb_max = min(50.0, max(0.5, float(yb_range[1])))
        if tm_max <= 0.1:
            kinetic_names = [name for name in kinetic_names if name != "WcrG4"]
        if tm_max <= 1.0:
            kinetic_names = [name for name in kinetic_names if name != "WcrH4"]
        if yb_max <= 10.0:
            kinetic_names = [name for name in kinetic_names if name != "Wb"]
        optimize_kinetics = optimize_kinetics and bool(kinetic_names)

        # Parse per-channel reference data
        target_metrics   = {}   # emission → {peak_time_ms, decay_tau_ms}
        full_trace_data  = {}   # emission → {time: ndarray, intensity: ndarray}

        for emission, ch_data in channels_raw.items():
            em = str(emission)
            if "time" in ch_data and "intensity" in ch_data:
                t_ch = np.asarray(ch_data["time"], dtype=float)
                i_ch = _normalise_trace(ch_data["intensity"])
                if t_ch.size >= 10 and i_ch.size == t_ch.size:
                    full_trace_data[em] = {"time": t_ch, "intensity": i_ch}
                    m = compute_trace_metrics(t_ch, i_ch)
                    if m["peak_time"] is not None:
                        target_metrics[em] = {
                            "peak_time_ms": float(m["peak_time"]),
                            "decay_tau_ms": float(m["decay_tau_1e"] or 0.0),
                        }
            elif "peak_time_ms" in ch_data or "decay_tau_ms" in ch_data:
                target_metrics[em] = {
                    "peak_time_ms": float(ch_data.get("peak_time_ms", 0.0)),
                    "decay_tau_ms": float(ch_data.get("decay_tau_ms", 0.0)),
                }

        if not target_metrics and not full_trace_data:
            return jsonify({"error": "No usable reference data found in channels"}), 400

        emissions_list = sorted(set(list(target_metrics) + list(full_trace_data)),
                                key=lambda e: ["775","477","645","362","452","345"].index(e)
                                if e in ["775","477","645","362","452","345"] else 99)
        has_full = bool(full_trace_data)

        def _build_estimator_time_axis():
            if full_trace_data:
                all_times = [entry["time"] for entry in full_trace_data.values() if entry["time"].size > 1]
                global_max = max(float(np.max(tt)) for tt in all_times)
                max_points_seen = max(int(tt.size) for tt in all_times)
                n_points = int(np.clip(max(1400, max_points_seen, int(global_max * 260.0)), 1400, 6000))
            else:
                positive_windows = [
                    float(v["peak_time_ms"]) + 8.0 * max(float(v["decay_tau_ms"]), 0.5)
                    for v in target_metrics.values()
                    if float(v.get("peak_time_ms", 0.0)) > 0.0
                ]
                global_max = max(positive_windows) if positive_windows else 15.0
                n_points = int(np.clip(max(1600, int(global_max * 280.0)), 1600, 6000))

            global_max = max(global_max, max(float(pulse_us) / 1000.0, 0.25))
            early_end = min(global_max * 0.22, max(float(pulse_us) / 1000.0 * 10.0, 0.8))
            if early_end <= 0.0 or early_end >= global_max:
                return np.linspace(0.0, global_max, n_points)

            early_points = int(np.clip(int(n_points * 0.45), 450, n_points - 300))
            late_points = max(n_points - early_points + 1, 300)
            return np.unique(np.concatenate([
                np.linspace(0.0, early_end, early_points, endpoint=False),
                np.linspace(early_end, global_max, late_points),
            ]))

        def _metric_log_error(observed, target):
            if observed is None or target is None:
                return 3.0
            observed = float(observed)
            target = float(target)
            if (not np.isfinite(observed)) or (not np.isfinite(target)) or target <= 0.0:
                return 3.0
            return float(np.log((observed + 1e-9) / (target + 1e-9)))

        ref_t = _build_estimator_time_axis()
        _ch_weights = {"775": 1.0, "477": 1.0, "645": 0.8, "362": 1.0, "452": 0.8, "345": 0.9}

        def _score(x):
            yb, tm = float(x[0]), float(x[1])
            p_trial = np.asarray(params, dtype=float).copy()
            if optimize_kinetics:
                for i, name in enumerate(kinetic_names):
                    idx = _SIM_PARAM_NAMES.index(name)
                    mult = float(x[2 + i])
                    p_trial[idx] = params[idx] * mult

            traces = simulate_forward(
                yb,
                tm,
                emissions_list,
                pulse_us,
                ref_t,
                p_trial,
                host_material=host_material,
                annealing_c=annealing_c,
                phonon_energy_cm=phonon_energy_cm,
                host_mole_factor=host_mole_factor,
            )
            total = 0.0
            denom = 0.0
            for em in emissions_list:
                w = _ch_weights.get(em, 1.0)
                sim = traces.get(em, np.zeros(ref_t.size))
                if has_full and em in full_trace_data:
                    meas = full_trace_data[em]["intensity"]
                    t_meas = full_trace_data[em]["time"]
                    sim_on = np.interp(t_meas, ref_t, sim, left=0.0, right=0.0)
                    sse = np.sum((meas - sim_on) ** 2)
                    var = np.sum((meas - np.mean(meas)) ** 2) + 1e-12
                    total += w * (1.0 - max(-1.0, 1.0 - sse / var))
                    denom += w
                elif em in target_metrics:
                    m = compute_trace_metrics(ref_t, sim)
                    ref = target_metrics[em]
                    channel_score = 0.0
                    channel_weight = 0.0
                    if float(ref.get("peak_time_ms", 0.0)) > 0.0:
                        pt_err = _metric_log_error(m["peak_time"], ref["peak_time_ms"])
                        channel_score += 1.15 * (pt_err ** 2)
                        channel_weight += 1.15
                    if float(ref.get("decay_tau_ms", 0.0)) > 0.0:
                        dt_err = _metric_log_error(m["decay_tau_1e"], ref["decay_tau_ms"])
                        channel_score += 1.35 * (dt_err ** 2)
                        channel_weight += 1.35
                    if channel_weight > 0.0:
                        total += w * (channel_score / channel_weight)
                        denom += w
            return total / (denom + 1e-12)

        bounds_de = [
            (max(0.5,  yb_range[0]), min(50.0, yb_range[1])),
            (max(0.01, tm_range[0]), min(5.0,  tm_range[1])),
        ]
        if optimize_kinetics:
            bounds_de.extend([(scale_lo, scale_hi)] * len(kinetic_names))

        best_result = None
        for round_idx in range(iterative_rounds):
            de_result = differential_evolution(
                _score,
                bounds=bounds_de,
                maxiter=de_maxiter,
                popsize=14,
                seed=42 + round_idx,
                tol=1e-4,
                polish=True,
            )
            if (best_result is None) or (float(de_result.fun) < float(best_result.fun)):
                best_result = de_result

        de_result = best_result
        best_yb = float(de_result.x[0])
        best_tm = float(de_result.x[1])

        p_best = np.asarray(params, dtype=float).copy()
        optimized_lit_params = {}
        if optimize_kinetics:
            for i, name in enumerate(kinetic_names):
                idx = _SIM_PARAM_NAMES.index(name)
                scale = float(de_result.x[2 + i])
                p_best[idx] = params[idx] * scale
                optimized_lit_params[name] = float(p_best[idx])

        best_traces = simulate_forward(
            best_yb,
            best_tm,
            emissions_list,
            pulse_us,
            ref_t,
            p_best,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )
        channel_quality = {}
        for em in emissions_list:
            sim = best_traces.get(em, np.zeros(ref_t.size))
            if has_full and em in full_trace_data:
                meas = full_trace_data[em]["intensity"]
                t_meas = full_trace_data[em]["time"]
                sim_on = np.interp(t_meas, ref_t, sim, left=0.0, right=0.0)
                sse = float(np.sum((meas - sim_on) ** 2))
                var = float(np.sum((meas - np.mean(meas)) ** 2)) + 1e-12
                channel_quality[em] = {"r2": round(max(-1.0, 1.0 - sse / var), 5)}
            elif em in target_metrics:
                m = compute_trace_metrics(ref_t, sim)
                ref = target_metrics[em]
                channel_quality[em] = {
                    "simulated_peak_time_ms": round(m["peak_time"] or 0.0, 4),
                    "target_peak_time_ms":    round(ref["peak_time_ms"], 4),
                    "simulated_decay_tau_ms": round(m["decay_tau_1e"] or 0.0, 4),
                    "target_decay_tau_ms":    round(ref["decay_tau_ms"], 4),
                }

        _, influence = _apply_host_annealing_influence(
            p_best,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )
        convergence_summary = _estimate_composition_convergence(float(de_result.fun), channel_quality)
        optimizer_converged = bool(de_result.success)
        converged = bool(optimizer_converged or convergence_summary["quality_converged"])
        if optimizer_converged:
            convergence_note = "Optimizer reported convergence within the configured iteration budget."
        elif convergence_summary["quality_converged"]:
            convergence_note = "Iteration budget was reached, but the best estimate satisfied the quality thresholds."
        else:
            convergence_note = "Iteration budget was reached before the estimate met the quality thresholds."

        return jsonify({
            "ok":          True,
            "best_yb_pct": round(best_yb, 2),
            "best_tm_pct": round(best_tm, 3),
            "score":       float(de_result.fun),
            "converged":   converged,
            "optimizer_converged": optimizer_converged,
            "quality_converged": bool(convergence_summary["quality_converged"]),
            "convergence_note": convergence_note,
            "convergence_metrics": convergence_summary,
            "host_material": host_material,
            "annealing_c": annealing_c,
            "host_mole_factor": host_mole_factor,
            "kinetics_optimized": bool(optimize_kinetics),
            "kinetics_names": kinetic_names,
            "iterative_rounds": iterative_rounds,
            "de_maxiter": de_maxiter,
            "optimized_lit_params": optimized_lit_params,
            "influence_model": influence,
            "channel_quality": channel_quality,
            "confidence": {
                "yb_range": (round(max(0.5,  best_yb * 0.85), 2), round(min(50.0, best_yb * 1.15), 2)),
                "tm_range": (round(max(0.01, best_tm * 0.85), 3), round(min(5.0,  best_tm * 1.15), 3)),
                "note": "Heuristic ±15% range. Narrow bounds, add more channels, and optionally optimize kinetics for tighter estimates.",
            },
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
@app.route('/updateEmissionWeights', methods=['POST'])
def update_emission_weights():
    """
    Update weights and error tolerances for a specific emission.
    """
    try:
        data = request.get_json() or {}

        emission = data.get('emission')
        peak_weight = data.get('peakWeight')
        early_weight = data.get('earlyWeight')
        error_tolerance = data.get('errorTolerance', {})

        # Validate
        if not emission:
            return jsonify({'error': 'Emission not specified'}), 400

        if emission not in emission_weights:
            emission_weights[emission] = _sanitize_weight_entry(emission, {})

        # Update weights
        if peak_weight is not None:
            emission_weights[emission]['peak'] = float(np.clip(float(peak_weight), 1.0, 10.0))

        if early_weight is not None:
            emission_weights[emission]['early'] = float(np.clip(float(early_weight), 1.0, 10.0))

        # Update error tolerances
        if error_tolerance:
            if 'peak' in error_tolerance:
                emission_weights[emission]['tolerances']['peak'] = float(np.clip(float(error_tolerance['peak']), 0.0001, 1.0))
            if 'decay' in error_tolerance:
                emission_weights[emission]['tolerances']['decay'] = float(np.clip(float(error_tolerance['decay']), 0.0001, 1.0))
            if 'rise' in error_tolerance:
                emission_weights[emission]['tolerances']['rise'] = float(np.clip(float(error_tolerance['rise']), 0.0001, 1.0))

        # Save to file
        save_weights()

        print(f"✅ Updated weights for {emission}: peak={emission_weights[emission]['peak']}, early={emission_weights[emission]['early']}")

        return jsonify({
            'success': True,
            'message': f'Updated weights for {emission} nm',
            'weights': emission_weights[emission]
        })

    except Exception as e:
        print(f"Error in update_emission_weights: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/getEmissionWeights', methods=['GET'])
def get_emission_weights():
    """
    Get current weights for all emissions or specific one.
    """
    try:
        emission = request.args.get('emission')

        if emission:
            if emission in emission_weights:
                return jsonify({
                    'emission': emission,
                    'weights': emission_weights[emission]
                })
            else:
                return jsonify({
                    'emission': emission,
                    'weights': _sanitize_weight_entry(emission, {})
                })
        else:
            return jsonify(emission_weights)

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/resetEmissionWeights', methods=['POST'])
def reset_emission_weights():
    """Reset weights to default values for all emissions"""
    global emission_weights

    emission_weights = _copy_default_emission_weights()

    save_weights()

    return jsonify({'success': True, 'message': 'All weights reset to defaults'})
load_weights()



# =============================================================================


__all__ = ['export_csv', 'index', 'fit', 'fit_progress', 'cancel_fit', 'configure_physics', 'simulate_luminescence_flow_route', 'fit_luminescence_flow_route', 'simulate_lifetime_route', 'estimate_composition_route', 'update_emission_weights', 'get_emission_weights', 'reset_emission_weights']
