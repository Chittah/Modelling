from .core import *
from .models import *

# SECTION 6 – MAIN ODE FITTING ENGINE  (run_fitting)
# =============================================================================

def run_fitting(time_ms, intensity, pulse_us,
                 state_idx,
                 doping_yb,
                 doping_tm,
                 fit_quality="fast",
                 optimize_all_points=False,
                 lit_params=None,
                 use_775_calibration=False,
                 emission_key=None, cancel_checker=None,
                 target_r2=0.9990,
                 adaptive_max_cycles=4,
                 peak_window_boost=1.0,
                 early_rise_boost=1.0,
                 peak_tolerance=0.01,
                 rise_tolerance=0.01,
                 decay_tolerance=0.01,
                 progress_callback=None, deadline=None):
    np.random.seed(42)  # Ensure full reproducibility across every run
    p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
    y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
    emission_key_s = str(emission_key)
    tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
    yb_pct = float(doping_yb) if np.isfinite(doping_yb) else 0.0
    peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 10.0))
    early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 10.0))

    def check_cancel():
        if callable(cancel_checker) and cancel_checker():
            raise FitCancelled("Fit cancelled by user")

    def report_progress(**kwargs):
        if callable(progress_callback):
            try:
                progress_callback(kwargs)
            except Exception:
                pass

    check_cancel()
    report_progress(phase="initialise", message="Initialising optimizer.")
    # Wall-clock budget: stages that can be cut short check this and keep the best solution so far.
    def over_budget():
        return deadline is not None and time.perf_counter() > deadline

    # ODE tolerance staging: the global (DE) search runs on loose tolerances (about 2.7x cheaper per
    # solve in benchmarks); everything from the local least-squares stage onward uses tight ones.
    ode_tol = {"rtol": 1e-6, "atol": 1e-9}
    quality_cfg = {
        "fast": {"de_maxiter": 12, "de_popsize": 6, "ls_nfev": 180, "max_points": 320},
        "balanced": {"de_maxiter": 22, "de_popsize": 8, "ls_nfev": 350, "max_points": 600},
        "accurate": {"de_maxiter": 35, "de_popsize": 10, "ls_nfev": 600, "max_points": 1200},
    }
    cfg = quality_cfg.get(fit_quality, quality_cfg["fast"])

    max_offset = np.max(time_ms) * 0.3

    # ── Reduced parameter space: only optimise the direct params for this emission ──
    all_param_names = [
        "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
        "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "WcrH4", "Wb", "T_offset", "WcrG4"
    ]
    param_roles = classify_parameter_roles(state_idx, yb_pct, tm_pct)
    active_set = set(param_roles["direct"])          # always includes T_offset

    guided_params_used = []
    # 477/645 depend strongly on the Tm5 feeder chain. Keeping these fixed can
    # cause broad/late peaks at higher Tm concentrations, so unlock them here.
    # Wb (back-transfer) always included since it directly sets the Yb effective
    # lifetime, which dominates the long-time tail visible in 477/645 nm.
    if emission_key_s in {"477", "645"}:
        # k35 (Tm3→Tm5) is the only path feeding Tm5 regardless of Tm concentration.
        # W1 (first ET step) is rate-limiting at low Yb since effective W1*Yb_e is halved.
        feeder_params = {"W2", "A50", "WcrH4", "WcrG4", "Wb", "k35"}
        if yb_pct < 7.0 or tm_pct < 0.3:
            feeder_params.add("W1")
        if tm_pct >= 0.8:
            feeder_params.update({"k21"})
        active_set.update(feeder_params)
        guided_params_used = sorted(list(set(guided_params_used).union(feeder_params)))

    # 362/452 (Tm7 channels) are one step downstream of Tm6 and are sensitive to
    # upstream feeder terms; keep these adjustable to avoid severe underfitting.
    if emission_key_s in {"362", "452"}:
        feeder_params = {"W3", "A60", "A61", "WcrH4", "WcrG4"}
        if tm_pct >= 0.8:
            feeder_params.update({"W2", "A50", "k35"})
        if tm_pct >= 1.5:
            feeder_params.update({"Wb"})
        active_set.update(feeder_params)
        guided_params_used = sorted(list(set(guided_params_used).union(feeder_params)))

    # 345/347 (Tm8 channel) is a 5-photon process requiring the full cascade of
    # upstream ET rates unlocked.  A80 is excluded (Tm8 has no ground-state decay).
    if emission_key_s in {"345", "347"}:
        feeder_params = {"W3", "W4", "A60", "A61", "A70", "A71", "WcrH4", "WcrG4"}
        if tm_pct >= 0.5:
            feeder_params.update({"W2", "A50", "k35", "Wb"})
        active_set.update(feeder_params)
        guided_params_used = sorted(list(set(guided_params_used).union(feeder_params)))

    # First 775 run can estimate feeder-chain terms that guide later 477/645 fits.
    if use_775_calibration and state_idx == 7:
        guided_params = {"W1", "k21", "A10"}
        active_set.update(guided_params)
        guided_params_used = sorted(list(set(guided_params_used).union(guided_params)))

    inactive_ode_params = set()
    if tm_pct <= 0.1:
        active_set.discard("WcrG4")
        inactive_ode_params.add("WcrG4")
    if tm_pct <= 1.0:
        active_set.discard("WcrH4")
        inactive_ode_params.add("WcrH4")
    if yb_pct <= 10.0:
        active_set.discard("Wb")
        inactive_ode_params.add("Wb")

    active_indices = [i for i, n in enumerate(all_param_names) if n in active_set]
    fixed_param_names = [
        n for i, n in enumerate(all_param_names)
        if i not in active_indices and n not in inactive_ode_params
    ]
    guided_params_used = [name for name in guided_params_used if name not in inactive_ode_params]

    # Physical defaults for parameters held fixed during optimisation.
    # These are overridden by lit_params values passed from the UI.
    param_defaults = np.array([
        5.0,   # Rp    – pump rate (ms^-1)
        1.0,   # Ay    – Yb spontaneous decay
        5.0,   # W1    – ET Yb→Tm0→Tm2
        5.0,   # W2    – ET Yb→Tm1→Tm3
        2.0,   # W3    – ET Yb→Tm5→Tm6
        1.0,   # W4    – ET Yb→Tm6→Tm7
        0.5,   # W5    – ET Yb→Tm7→Tm8
        50.0,  # k21   – Tm2→Tm1 fast non-radiative
        20.0,  # k35   – Tm3→Tm5 phonon relaxation
        1.0,   # A10   – Tm1→Tm0 (1800 nm)
        0.33,  # A50   – Tm5→Tm0 (775 nm)
        2.0,   # A60   – Tm6→Tm0
        0.5,   # A61   – Tm6→Tm1
        1.5,   # A70   – Tm7→Tm0
        0.5,   # A71   – Tm7→Tm1
        2.0,   # A80   – Tm8→Tm0
        2.0,   # A81   – Tm8→Tm1 (345 nm)
        5.0,   # WcrH4 – ³H₄ + ³H₆ → 2×³F₄
        0.5,   # Wb    – back energy transfer Tm5(³H₄)→Yb_g→Yb_e
        0.0,   # T_offset
        5.0,   # WcrG4 – ¹G₄ + ³H₆ → ³H₄ + ³F₄
    ], dtype=float)

    # Apply user-supplied kinetic parameter overrides (all except Rp and T_offset can be preset).
    if lit_params and isinstance(lit_params, dict):
        for name, val in lit_params.items():
            if name == "Wcr":
                name = "WcrH4"
            if name in all_param_names:
                idx_p = all_param_names.index(name)
                param_defaults[idx_p] = float(val)

    all_bounds = [(1e-4, 150.0)] * 18 + [(0.0, 50.0), (0.0, max_offset), (1e-4, 150.0)]
    # At low Yb concentrations the effective pump rate Rp*Yb_g and ET rates Wi*Yb_e
    # are halved compared to 10% Yb, so the optimizer needs more room on Rp and W1-W3.
    if 0.0 < yb_pct < 10.0:
        # Effective ET/pump rates are W*Yb_e, so equivalent dynamics at lower Yb need proportionally
        # larger rate constants: scale the cap by 10/Yb (150 -> up to 600 ms^-1).
        low_yb_cap = float(np.clip(150.0 * (10.0 / yb_pct), 150.0, 600.0))
        for _bi in (0, 2, 3, 4):  # Rp, W1, W2, W3
            all_bounds[_bi] = (all_bounds[_bi][0], max(all_bounds[_bi][1], low_yb_cap))
    # High-order emission channels (345/362 nm) require fast cascaded ET rates that
    # can legitimately exceed the 150 ms⁻¹ default cap.  Rp, W4, W5, and for the
    # Tm8 channel also A81 is allowed up to 300 ms⁻¹ (A80 inactive in this system).
    if emission_key_s in {"345", "347", "362", "452"}:
        high_cap = 300.0
        all_bounds[0]  = (all_bounds[0][0], max(all_bounds[0][1], high_cap))   # Rp
        all_bounds[5]  = (all_bounds[5][0],  high_cap)   # W4
        all_bounds[6]  = (all_bounds[6][0],  high_cap)   # W5
        if emission_key_s in {"345", "347"}:
            all_bounds[16] = (all_bounds[16][0], high_cap)  # A81 (Tm8→Tm1, 345 nm)
    bounds_active = [all_bounds[i] for i in active_indices]

    # Fit pulse width as a nuisance parameter to absorb instrument/timing uncertainty.
    fit_pulse_width = True
    if emission_key_s == "477":
        # Blue channel often needs a wider IRF window to capture sharp rise at
        # high Tm where timing mismatch dominates R^2 loss.
        p_ms_lower = max(1e-6, 0.55 * p_ms_nominal)
        p_ms_upper = max(p_ms_lower + 1e-6, 1.35 * p_ms_nominal)
    else:
        p_ms_lower = max(1e-6, 0.85 * p_ms_nominal)
        p_ms_upper = max(p_ms_lower + 1e-6, 1.15 * p_ms_nominal)
    if fit_pulse_width:
        bounds_active.append((p_ms_lower, p_ms_upper))

    lower = np.array([b[0] for b in bounds_active], dtype=float)
    upper = np.array([b[1] for b in bounds_active], dtype=float)

    # Index of T_offset within the *active* vector (for peak-anchor correction)
    t_off_active = next(j for j, gi in enumerate(active_indices) if all_param_names[gi] == "T_offset")

    n_active_params = len(active_indices)

    def unpack_active(x_active):
        """Split active vector into full 20-parameter set and pulse width (ms)."""
        x = np.asarray(x_active, dtype=float)
        x_params = x[:n_active_params]
        full = param_defaults.copy()
        for local_i, global_i in enumerate(active_indices):
            full[global_i] = x_params[local_i]

        p_width_ms = p_ms_nominal
        if fit_pulse_width and x.size > n_active_params:
            p_width_ms = float(np.clip(x[n_active_params], p_ms_lower, p_ms_upper))
        return full, p_width_ms

    def convolve_with_irf(signal, t_eval, p_width_ms):
        """Apply Gaussian IRF convolution on simulated trace segment."""
        if signal.size < 5:
            return signal

        dt = float(np.median(np.diff(t_eval))) if t_eval.size > 1 else 0.0
        if dt <= 0:
            return signal

        # Use a modest IRF tied to pulse width to correct peak/early-decay shoulder.
        irf_fwhm_ms = max(1.5 * dt, 0.045 * p_width_ms)
        sigma = irf_fwhm_ms / 2.355
        if sigma <= 0:
            return signal

        radius = int(np.ceil((4.0 * sigma) / dt))
        if radius < 1:
            return signal

        grid = np.arange(-radius, radius + 1, dtype=float) * dt
        kernel = np.exp(-0.5 * (grid / sigma) ** 2)
        kernel /= (np.sum(kernel) + 1e-12)
        return np.convolve(signal, kernel, mode="same")

    def select_fit_indices(t_arr, y_arr, max_points):
        n = t_arr.size
        if n <= max_points:
            return np.arange(n, dtype=int)

        # Preserve rise/peak details while keeping full-tail coverage.
        peak_idx = int(np.argmax(y_arr))
        high_idx = np.where(y_arr >= 0.55 * np.max(y_arr))[0]
        rise_start = max(0, peak_idx - max(10, n // 20))
        rise_end = min(n, peak_idx + max(10, n // 25))
        rise_idx = np.arange(rise_start, rise_end, dtype=int)

        n_uniform = max(32, int(max_points * 0.6))
        uniform_idx = np.linspace(0, n - 1, n_uniform, dtype=int)

        extra_budget = max_points - uniform_idx.size
        n_high = max(0, min(extra_budget // 2, high_idx.size))
        n_rise = max(0, min(extra_budget - n_high, rise_idx.size))

        if n_high > 0:
            high_idx = high_idx[np.linspace(0, high_idx.size - 1, n_high, dtype=int)]
        else:
            high_idx = np.array([], dtype=int)

        if n_rise > 0:
            rise_idx = rise_idx[np.linspace(0, rise_idx.size - 1, n_rise, dtype=int)]
        else:
            rise_idx = np.array([], dtype=int)

        merged = np.unique(np.concatenate([uniform_idx, high_idx, rise_idx, np.array([0, n - 1], dtype=int)]))
        return merged[:max_points]

    if optimize_all_points:
        t_fit = time_ms
        i_fit = intensity
    else:
        idx = select_fit_indices(time_ms, intensity, cfg["max_points"])
        t_fit = time_ms[idx]
        i_fit = intensity[idx]

    def build_weights(t_arr, y_arr):
        t_norm = (t_arr - np.min(t_arr)) / (np.ptp(t_arr) + 1e-12)
        peak_weight = np.power(np.clip(y_arr, 0.0, 1.0), 0.6)
        early_weight = np.exp(-3.0 * t_norm)
        return 0.25 + 0.55 * peak_weight + 0.20 * early_weight

    weights_fit = build_weights(t_fit, i_fit)
    sqrt_w_fit = np.sqrt(weights_fit)
    weights_full = build_weights(time_ms, intensity)
    sqrt_w_full = np.sqrt(weights_full)

    def build_tail_weights(t_arr, y_arr):
        peak_idx = int(np.argmax(y_arr))
        t_peak = t_arr[peak_idx]
        denom_t = (np.max(t_arr) - t_peak) + 1e-12
        t_tail = np.clip((t_arr - t_peak) / denom_t, 0.0, 1.0)
        # Heavier emphasis at late decay where current fit is slightly too fast.
        return 0.15 + 0.85 * np.power(t_tail, 1.2)

    tail_w_fit = build_tail_weights(t_fit, i_fit)
    tail_w_full = build_tail_weights(time_ms, intensity)
    sqrt_tail_fit = np.sqrt(tail_w_fit)
    sqrt_tail_full = np.sqrt(tail_w_full)

    def simulate(params_all, p_width_ms, t_arr):
        t_shifted = t_arr - params_all[19]   # T_offset is now at index 19
        mask = t_shifted >= 0
        if not np.any(mask):
            return None, None

        t_eval = t_shifted[mask]
        try:
            sol = solve_ivp(
                UCOdeModel.system,
                [0, float(np.max(t_shifted))],
                y0,
                t_eval=t_eval,
                args=(np.concatenate((params_all[:19], [params_all[20], tm_pct, yb_pct])), p_width_ms),
                method="Radau",
                rtol=ode_tol["rtol"],
                atol=ode_tol["atol"],
            )
        except Exception:
            return None, None

        if (not sol.success) or (sol.y.shape[1] != t_eval.size):
            return None, None

        modeled = np.zeros_like(t_arr)
        # Channel-specific observable for Tm6 emissions:
        # 477 nm uses A60*Tm6, 645 nm uses A61*Tm6.
        if str(emission_key) == "477":
            obs = params_all[11] * sol.y[8]   # A60 * Tm6
        elif str(emission_key) == "645":
            obs = params_all[12] * sol.y[8]   # A61 * Tm6
        else:
            obs = sol.y[state_idx]

        obs = np.clip(obs, 0.0, np.inf)
        obs = convolve_with_irf(obs, t_eval, p_width_ms)
        modeled[mask] = obs
        return modeled, mask

    def apply_weighted_scale(measured, modeled, fit_weights):
        smm = np.sum(fit_weights * modeled * modeled)
        smy = np.sum(fit_weights * modeled * measured)
        scale = smy / (smm + 1e-12)
        fitted = np.clip(scale * modeled, 0.0, np.inf)
        return fitted

    def residual_core(measured, fitted, sqrt_w):
        eps = 1e-8
        lin_res = sqrt_w * (measured - fitted)
        log_res = 0.25 * sqrt_w * (np.log(fitted + eps) - np.log(measured + eps))
        i_pk_m = int(np.argmax(measured))
        i_pk_f = int(np.argmax(fitted))
        return lin_res, log_res, i_pk_m, i_pk_f

    def rise_time_10_90_fast(t_arr, y_arr):
        """Fast 10-90% rise estimate up to the trace apex."""
        if t_arr.size < 4 or y_arr.size != t_arr.size:
            return None
        i_pk = int(np.argmax(y_arr))
        if i_pk < 2:
            return None
        peak = float(y_arr[i_pk])
        if peak <= 1e-12:
            return None
        y_rise = y_arr[:i_pk + 1]
        i10 = np.where(y_rise >= 0.1 * peak)[0]
        i90 = np.where(y_rise >= 0.9 * peak)[0]
        if i10.size == 0 or i90.size == 0:
            return None
        t10 = float(t_arr[i10[0]])
        t90 = float(t_arr[i90[0]])
        return max(0.0, t90 - t10)

    def tail_residual_terms(t_arr, measured, fitted, sqrt_tail):
        i_pk = int(np.argmax(measured))
        tail_mask = np.arange(t_arr.size) >= i_pk
        if np.sum(tail_mask) < 6:
            tail_mask = np.arange(t_arr.size) >= (t_arr.size // 2)

        tail_res = 0.55 * sqrt_tail[tail_mask] * (measured[tail_mask] - fitted[tail_mask])

        area_m = np.trapezoid(measured[tail_mask], t_arr[tail_mask])
        area_f = np.trapezoid(fitted[tail_mask], t_arr[tail_mask])
        area_pen = 4.0 * (area_f - area_m) / (abs(area_m) + 1e-12)
        return tail_res, area_pen

    def early_residual_terms(t_arr, measured, fitted):
        n = t_arr.size
        if n < 8:
            return np.array([], dtype=float), 0.0

        t0 = np.min(t_arr)
        t1 = np.max(t_arr)
        t_cut = t0 + 0.30 * (t1 - t0)
        early_mask = t_arr <= t_cut
        if np.sum(early_mask) < 5:
            early_mask = np.arange(n) < max(5, n // 4)

        # Emphasize early mismatch (where current overshoot persists)
        early_res = (0.95 * early_rise_boost) * (measured[early_mask] - fitted[early_mask])

        # Penalize integrated early overshoot/undershoot
        area_m = np.trapezoid(measured[early_mask], t_arr[early_mask])
        area_f = np.trapezoid(fitted[early_mask], t_arr[early_mask])
        area_pen = (5.5 * early_rise_boost) * (area_f - area_m) / (abs(area_m) + 1e-12)
        return early_res, area_pen

    def overshoot_residual_terms(t_arr, measured, fitted):
        """Asymmetric penalty: discourage fitted trace rising above measured trace."""
        n = t_arr.size
        if n < 8:
            return np.array([], dtype=float), 0.0

        i_pk = int(np.argmax(measured))
        pre_peak_mask = np.arange(n) <= i_pk
        if np.sum(pre_peak_mask) < 5:
            pre_peak_mask = np.arange(n) < max(5, n // 3)

        # Positive-only overshoot in rise/peak region.
        rise_peak_over = np.maximum(fitted[pre_peak_mask] - measured[pre_peak_mask], 0.0)

        # Strongly penalize overshoot near apex where user expects fitted<=measured.
        peak_val = float(measured[i_pk]) if n > 0 else 0.0
        near_peak_mask = measured >= (0.92 * peak_val if peak_val > 1e-12 else 0.0)
        if np.sum(near_peak_mask) < 4:
            half = max(2, n // 30)
            lo = max(0, i_pk - half)
            hi = min(n, i_pk + half + 1)
            near_peak_mask = np.zeros(n, dtype=bool)
            near_peak_mask[lo:hi] = True
        peak_over = np.maximum(fitted[near_peak_mask] - measured[near_peak_mask], 0.0)

        overshoot_res = np.concatenate([
            1.80 * rise_peak_over,
            2.40 * peak_over,
        ])

        # Scalar guard for total pre-peak overshoot area.
        area_over = np.trapezoid(np.maximum(fitted[pre_peak_mask] - measured[pre_peak_mask], 0.0), t_arr[pre_peak_mask])
        area_ref = np.trapezoid(np.clip(measured[pre_peak_mask], 0.0, np.inf), t_arr[pre_peak_mask]) + 1e-12
        area_over_pen = 9.0 * (area_over / area_ref)
        return overshoot_res, area_over_pen

    def peak_window_residual_terms(measured, fitted):
        """Extra local residual around the measured apex to tighten peak matching."""
        n = measured.size
        if n < 10:
            return np.array([], dtype=float), 0.0

        i_pk = int(np.argmax(measured))
        peak_val = float(measured[i_pk])
        if peak_val <= 1e-12:
            return np.array([], dtype=float), 0.0

        # Prefer value-based mask near apex; fallback to a symmetric local window.
        mask = measured >= (0.90 * peak_val)
        if np.sum(mask) < 5:
            half = max(2, n // 35)
            lo = max(0, i_pk - half)
            hi = min(n, i_pk + half + 1)
            mask = np.zeros(n, dtype=bool)
            mask[lo:hi] = True

        # Global apex emphasis for all channels, with small per-channel tuning.
        peak_scale = 1.34
        peak_point_scale = 11.6
        if emission_key_s == "645":
            peak_scale = 1.40
            peak_point_scale = 12.4
        elif emission_key_s == "477":
            if tm_pct >= 0.8:
                peak_scale = 1.42
                peak_point_scale = 13.2
            elif tm_pct >= 0.3:
                peak_scale = 1.36
                peak_point_scale = 12.2
            else:
                peak_scale = 1.31
                peak_point_scale = 11.4
        elif emission_key_s in {"345", "347", "362", "452"}:
            peak_scale = 1.38
            peak_point_scale = 12.0

        if peak_window_boost > 1.0:
            peak_scale *= peak_window_boost
            peak_point_scale *= peak_window_boost

        peak_res = peak_scale * (measured[mask] - fitted[mask])
        peak_point_pen = peak_point_scale * (fitted[i_pk] - measured[i_pk])
        return peak_res, peak_point_pen

    def residual_vector(x_active):
        check_cancel()
        params_all, p_width_ms = unpack_active(x_active)
        modeled, _ = simulate(params_all, p_width_ms, t_fit)
        if modeled is None:
            return np.full_like(i_fit, 1e6)
        fitted = apply_weighted_scale(i_fit, modeled, weights_fit)
        lin_res, log_res, i_pk_m, i_pk_f = residual_core(i_fit, fitted, sqrt_w_fit)
        tail_res, tail_area_pen = tail_residual_terms(t_fit, i_fit, fitted, sqrt_tail_fit)
        early_res, early_area_pen = early_residual_terms(t_fit, i_fit, fitted)
        over_res, over_area_pen = overshoot_residual_terms(t_fit, i_fit, fitted)
        peak_res, peak_point_pen = peak_window_residual_terms(i_fit, fitted)
        t_span = np.ptp(t_fit) + 1e-12
        peak_time_pen = 8.0 * (t_fit[i_pk_f] - t_fit[i_pk_m]) / t_span
        peak_amp_pen = 7.5 * (fitted[i_pk_f] - i_fit[i_pk_m])
        late_peak_pen = 14.0 * max(0.0, (t_fit[i_pk_f] - t_fit[i_pk_m]) / t_span)

        rise_m = rise_time_10_90_fast(t_fit, i_fit)
        rise_f = rise_time_10_90_fast(t_fit, fitted)
        late_rise_pen = 0.0
        if rise_m is not None and rise_f is not None:
            late_rise_pen = 11.0 * max(0.0, (rise_f - rise_m) / (rise_m + 1e-12))

        return np.concatenate([
            lin_res,
            log_res,
            early_res,
            over_res,
            peak_res,
            tail_res,
            np.array([
                peak_time_pen,
                peak_amp_pen,
                peak_point_pen,
                early_area_pen,
                tail_area_pen,
                over_area_pen,
                late_peak_pen,
                late_rise_pen,
            ]),
        ])

    def residual_vector_full(x_active):
        check_cancel()
        params_all, p_width_ms = unpack_active(x_active)
        modeled, _ = simulate(params_all, p_width_ms, time_ms)
        if modeled is None:
            return np.full_like(intensity, 1e6)
        fitted = apply_weighted_scale(intensity, modeled, weights_full)
        lin_res, log_res, i_pk_m, i_pk_f = residual_core(intensity, fitted, sqrt_w_full)
        tail_res, tail_area_pen = tail_residual_terms(time_ms, intensity, fitted, sqrt_tail_full)
        early_res, early_area_pen = early_residual_terms(time_ms, intensity, fitted)
        over_res, over_area_pen = overshoot_residual_terms(time_ms, intensity, fitted)
        peak_res, peak_point_pen = peak_window_residual_terms(intensity, fitted)
        t_span = np.ptp(time_ms) + 1e-12
        peak_time_pen = 8.0 * (time_ms[i_pk_f] - time_ms[i_pk_m]) / t_span
        peak_amp_pen = 7.5 * (fitted[i_pk_f] - intensity[i_pk_m])
        late_peak_pen = 14.0 * max(0.0, (time_ms[i_pk_f] - time_ms[i_pk_m]) / t_span)

        rise_m = rise_time_10_90_fast(time_ms, intensity)
        rise_f = rise_time_10_90_fast(time_ms, fitted)
        late_rise_pen = 0.0
        if rise_m is not None and rise_f is not None:
            late_rise_pen = 11.0 * max(0.0, (rise_f - rise_m) / (rise_m + 1e-12))

        return np.concatenate([
            lin_res,
            log_res,
            early_res,
            over_res,
            peak_res,
            tail_res,
            np.array([
                peak_time_pen,
                peak_amp_pen,
                peak_point_pen,
                early_area_pen,
                tail_area_pen,
                over_area_pen,
                late_peak_pen,
                late_rise_pen,
            ]),
        ])

    def objective(x_active):
        check_cancel()
        r = residual_vector(x_active)
        return float(np.dot(r, r))

    def objective_full(x_active):
        check_cancel()
        r = residual_vector_full(x_active)
        return float(np.dot(r, r))

    # SciPy may pass convergence as a keyword argument in some versions.
    def de_cancel_callback(_xk, convergence=None):
        return bool(callable(cancel_checker) and cancel_checker()) or over_budget()
     # Seed DE with the prior so the population contains at least one good member.
    x_seed = np.array(
        [float(np.clip(param_defaults[gi], lower[j], upper[j])) for j, gi in enumerate(active_indices)]
        + ([float(np.clip(p_ms_nominal, p_ms_lower, p_ms_upper))] if fit_pulse_width else []),
        dtype=float,
    )
    res_global = differential_evolution(
        objective,
        bounds_active,
        maxiter=cfg["de_maxiter"],
        popsize=cfg["de_popsize"],
        seed=42,
        tol=1e-3,
        polish=False,
        callback=de_cancel_callback,
        x0=x_seed
    )
    ode_tol.update(rtol=1e-8, atol=1e-11)  # tight tolerances for all later stages
    if over_budget():
        report_progress(phase="time_budget",
                        message="Fit time budget reached during global search; finishing with the best solution so far.")

    check_cancel()

    res_local = least_squares(
        residual_vector,
        x0=res_global.x,
        bounds=(lower, upper),
        method="trf",
        loss="soft_l1",
        f_scale=0.05,
        max_nfev=(20 if over_budget() else cfg["ls_nfev"]),
    )

    check_cancel()

    best_active = res_local.x if res_local.success else res_global.x
    best_full, best_pulse_ms = unpack_active(best_active)
    final_modeled, _ = simulate(best_full, best_pulse_ms, time_ms)
    if final_modeled is None:
        raise RuntimeError("Fit failed: ODE solver did not converge for best parameters")

    final_y = apply_weighted_scale(intensity, final_modeled, weights_full)
    final_sse = float(np.sum((intensity - final_y) ** 2))

    # Peak-anchor correction: nudge T_offset to align peaks.
    i_pk_m = int(np.argmax(intensity))
    i_pk_f = int(np.argmax(final_y))
    dt_peak = time_ms[i_pk_m] - time_ms[i_pk_f]
    if abs(dt_peak) > 0:
        candidate_active = best_active.copy()
        candidate_active[t_off_active] = np.clip(
            candidate_active[t_off_active] + dt_peak,
            lower[t_off_active], upper[t_off_active]
        )
        if objective_full(candidate_active) < objective_full(best_active):
            candidate_full, candidate_pulse_ms = unpack_active(candidate_active)
            candidate_modeled, _ = simulate(candidate_full, candidate_pulse_ms, time_ms)
            if candidate_modeled is not None:
                best_active = candidate_active
                best_full, best_pulse_ms = unpack_active(best_active)
                final_y = apply_weighted_scale(intensity, candidate_modeled, weights_full)
                final_sse = float(np.sum((intensity - final_y) ** 2))

    denom = np.sum((intensity - np.mean(intensity)) ** 2) + 1e-12

    refine_nfev = 0
    polish_passes_done = 0
    polish_nfev_total = 0

    if fit_quality == "fast":
        check_cancel()
        r2_now = 1.0 - final_sse / denom
        i_pk_m = int(np.argmax(intensity))
        i_pk_f = int(np.argmax(final_y))
        peak_time_err = abs(time_ms[i_pk_f] - time_ms[i_pk_m]) / (np.ptp(time_ms) + 1e-12)
        peak_amp_err = abs(final_y[i_pk_f] - intensity[i_pk_m]) / (abs(intensity[i_pk_m]) + 1e-12)

        fast_refine_r2 = 0.9999
        fast_refine_peak_time = 0.015
        fast_refine_peak_amp = 0.04
        if emission_key_s == "477":
            fast_refine_r2 = 0.9997
            fast_refine_peak_time = 0.015
            fast_refine_peak_amp = 0.035
        elif emission_key_s in {"345", "347", "362", "452"}:
            fast_refine_peak_time = 0.012
            fast_refine_peak_amp = 0.03

        if (r2_now < fast_refine_r2) or (peak_time_err > fast_refine_peak_time) or (peak_amp_err > fast_refine_peak_amp):
            res_refine = least_squares(
                residual_vector_full,
                x0=best_active,
                bounds=(lower, upper),
                method="trf",
                loss="soft_l1",
                f_scale=0.035 if emission_key_s == "477" else 0.04,
                max_nfev=550 if emission_key_s == "477" else 400,
            )
            check_cancel()
            refine_nfev = int(getattr(res_refine, "nfev", 0) or 0)
            if res_refine.success and (objective_full(res_refine.x) < objective_full(best_active)):
                candidate_full, candidate_pulse_ms = unpack_active(res_refine.x)
                candidate_modeled, _ = simulate(candidate_full, candidate_pulse_ms, time_ms)
                if candidate_modeled is not None:
                    best_active = res_refine.x
                    best_full, best_pulse_ms = unpack_active(best_active)
                    final_y = apply_weighted_scale(intensity, candidate_modeled, weights_full)
                    final_sse = float(np.sum((intensity - final_y) ** 2))

    # ── Final precision polish: pure L2 on full data to maximise R² ──
    # Uniform-weighted OLS residual directly minimises SSE (= maximises R²).
    ones_full = np.ones_like(intensity)

    def residual_l2(x_active):
        check_cancel()
        params_all, p_width_ms = unpack_active(x_active)
        modeled, _ = simulate(params_all, p_width_ms, time_ms)
        if modeled is None:
            return np.full_like(intensity, 1e6)
        fitted = apply_weighted_scale(intensity, modeled, ones_full)
        base = intensity - fitted
        tail = 0.45 * sqrt_tail_full * (intensity - fitted)
        over_res, over_area_pen = overshoot_residual_terms(time_ms, intensity, fitted)
        return np.concatenate([base, tail, over_res, np.array([over_area_pen])])

    polish_budget = {
        "fast": (3, 600),
        "balanced": (4, 900),
        "accurate": (5, 1400),
    }.get(fit_quality, (3, 600))
    max_passes, nfev_per_pass = polish_budget

    for _ in range(max_passes):
        if over_budget():
            break
        check_cancel()
        r2_now = 1.0 - final_sse / denom
        if r2_now >= 0.9999:
            break
        res_polish = least_squares(
            residual_l2,
            x0=best_active,
            bounds=(lower, upper),
            method="trf",
            loss="linear",   # pure L2 — directly minimises SSE
            max_nfev=nfev_per_pass,
        )
        check_cancel()
        polish_passes_done += 1
        polish_nfev_total += int(getattr(res_polish, "nfev", 0) or 0)
        if not res_polish.success:
            break
        cand_full, cand_pulse_ms = unpack_active(res_polish.x)
        cand_modeled, _ = simulate(cand_full, cand_pulse_ms, time_ms)
        if cand_modeled is None:
            break
        cand_y = apply_weighted_scale(intensity, cand_modeled, ones_full)
        cand_sse = float(np.sum((intensity - cand_y) ** 2))
        if cand_sse < final_sse:
            best_active = res_polish.x
            best_full, best_pulse_ms = unpack_active(best_active)
            final_y = cand_y
            final_sse = cand_sse

    # ── Adaptive R² refinement ──────────────────────────────────────────────────
    # If R² < target OR any timing tolerance is exceeded after the L2 polish
    # passes, diagnose which region (early rise, peak window, tail) carries the
    # most residual error, proportionally boost the weights on that region, and
    # re-run a local refinement.  Repeats up to MAX_ADAPT_CYCLES times; stops
    # early if no SSE improvement is made so we never overfit one region at the
    # expense of another.
    R2_TARGET = float(np.clip(float(target_r2), 0.0, 0.999995))
    MAX_ADAPT_CYCLES = int(np.clip(int(adaptive_max_cycles), 1, 50))
    adapt_cycles_done = 0
    improvement_threshold = 1e-6  # Minimum relative SSE improvement to continue adaptive cycles

    def _compute_tolerance_errors(fitted_y):
        """Return (peak_err, rise_err, decay_err) as fractional ratio errors."""
        meas_m = compute_trace_metrics(time_ms, intensity)
        fit_m = compute_trace_metrics(time_ms, fitted_y)
        p_err = r_err = d_err = None
        if meas_m.get("peak_time") is not None and fit_m.get("peak_time") is not None:
            p_err = abs(fit_m["peak_time"] - meas_m["peak_time"]) / max(abs(meas_m["peak_time"]), 1e-12)
        if meas_m.get("rise_time_10_90") is not None and fit_m.get("rise_time_10_90") is not None:
            r_err = abs(fit_m["rise_time_10_90"] - meas_m["rise_time_10_90"]) / max(abs(meas_m["rise_time_10_90"]), 1e-12)
        if meas_m.get("decay_tau_1e") is not None and fit_m.get("decay_tau_1e") is not None:
            d_err = abs(fit_m["decay_tau_1e"] - meas_m["decay_tau_1e"]) / max(abs(meas_m["decay_tau_1e"]), 1e-12)
        return p_err, r_err, d_err

    def _tolerances_exceeded(fitted_y):
        """True if any timing tolerance is not yet satisfied."""
        p_err, r_err, d_err = _compute_tolerance_errors(fitted_y)
        if p_err is not None and p_err > peak_tolerance:
            return True
        if r_err is not None and r_err > rise_tolerance:
            return True
        if d_err is not None and d_err > decay_tolerance:
            return True
        return False

    tol_exceeded = _tolerances_exceeded(final_y)
    r2_not_met = (1.0 - final_sse / denom) < R2_TARGET
    p_e, r_e, d_e = _compute_tolerance_errors(final_y)
    report_progress(
        phase="adaptive_refine",
        adaptive_completed_cycles=0,
        adaptive_max_cycles=MAX_ADAPT_CYCLES,
        current_r2=float(1.0 - final_sse / denom),
        tolerances_exceeded=bool(tol_exceeded),
        tolerance_errors={"peak": p_e, "rise": r_e, "decay": d_e},
        message=f"Adaptive refinement started (max {MAX_ADAPT_CYCLES} cycles). "
                f"Tolerances met: {not tol_exceeded}.",
    )

    consecutive_no_improve = 0
    MAX_NO_IMPROVE = 3  # Allow up to 3 strategy changes before giving up

    while (r2_not_met or tol_exceeded) and adapt_cycles_done < MAX_ADAPT_CYCLES and not over_budget():
        check_cancel()
        adapt_cycles_done += 1

        # ── Diagnose worst region ──
        res_abs = np.abs(intensity - final_y)
        i_pk = int(np.argmax(intensity))
        n_tot = len(intensity)
        pk_half = max(2, n_tot // 12)
        pk_lo = max(0, i_pk - pk_half)
        pk_hi = min(n_tot, i_pk + pk_half)

        early_err = float(np.mean(res_abs[:max(1, i_pk)]))
        peak_err  = float(np.mean(res_abs[pk_lo:pk_hi]))
        tail_err  = float(np.mean(res_abs[i_pk:]))
        total_err = early_err + peak_err + tail_err + 1e-12

        frac_early = early_err / total_err
        frac_peak  = peak_err  / total_err
        frac_tail  = tail_err  / total_err

        # Boost grows with each cycle; increase more aggressively after
        # consecutive no-improvement cycles to escape local minima
        boost_extra = 0.3 * consecutive_no_improve
        boost   = min(5.0, 1.0 + 0.6 * adapt_cycles_done + boost_extra)
        w_early = 1.0 + boost * frac_early
        w_peak  = 1.0 + boost * frac_peak
        w_tail  = 1.0 + boost * frac_tail

        # On repeated no-improvement, shift focus to the worst tolerance region
        if consecutive_no_improve > 0:
            p_e_now, r_e_now, d_e_now = _compute_tolerance_errors(final_y)
            tol_errors = [
                ("early", p_e_now if p_e_now is not None else 0.0, peak_tolerance),
                ("early", r_e_now if r_e_now is not None else 0.0, rise_tolerance),
                ("tail",  d_e_now if d_e_now is not None else 0.0, decay_tolerance),
            ]
            # Find worst tolerance violation and boost its region
            worst_tol = max(tol_errors, key=lambda x: x[1] / max(x[2], 1e-12))
            if worst_tol[0] == "early":
                w_early *= 1.0 + 0.5 * consecutive_no_improve
            else:
                w_tail *= 1.0 + 0.5 * consecutive_no_improve

        # ── Build spatially-varying weight array ──
        adapt_w = np.ones(n_tot, dtype=float)
        early_mask_a = np.arange(n_tot) < i_pk
        peak_mask_a  = np.zeros(n_tot, dtype=bool)
        peak_mask_a[pk_lo:pk_hi] = True
        tail_mask_a  = np.arange(n_tot) >= i_pk
        adapt_w[early_mask_a] *= w_early
        adapt_w[peak_mask_a]  *= w_peak
        adapt_w[tail_mask_a]  *= w_tail
        adapt_sqrt_w = np.sqrt(adapt_w)

        # Alternate loss function after consecutive no-improvement:
        # soft_l1 is more robust to outliers and may find a different minimum
        use_soft_l1 = consecutive_no_improve >= 2

        # Default-argument capture so each loop iteration gets its own binding
        def residual_adaptive(x_active,
                              _sqrt_w=adapt_sqrt_w,
                              _tail_sqrt=sqrt_tail_full,
                              _w_tail=w_tail):
            check_cancel()
            params_all, p_width_ms = unpack_active(x_active)
            modeled, _ = simulate(params_all, p_width_ms, time_ms)
            if modeled is None:
                return np.full_like(intensity, 1e6)
            fitted = apply_weighted_scale(intensity, modeled, ones_full)
            base = _sqrt_w * (intensity - fitted)
            tail = 0.45 * _w_tail * _tail_sqrt * (intensity - fitted)
            over_res, over_area_pen = overshoot_residual_terms(time_ms, intensity, fitted)
            return np.concatenate([base, tail, over_res, np.array([over_area_pen])])

        # Increase max function evaluations on retries
        adapt_nfev = nfev_per_pass + consecutive_no_improve * 200

        res_adapt = least_squares(
            residual_adaptive,
            x0=best_active,
            bounds=(lower, upper),
            method="trf",
            loss="soft_l1" if use_soft_l1 else "linear",
            f_scale=0.05 if use_soft_l1 else 1.0,
            max_nfev=adapt_nfev,
        )
        check_cancel()
        polish_passes_done  += 1
        polish_nfev_total   += int(getattr(res_adapt, "nfev", 0) or 0)

        if not res_adapt.success and consecutive_no_improve >= MAX_NO_IMPROVE:
            break
        cand_full, cand_pulse_ms = unpack_active(res_adapt.x)
        cand_modeled, _ = simulate(cand_full, cand_pulse_ms, time_ms)
        if cand_modeled is None:
            if consecutive_no_improve >= MAX_NO_IMPROVE:
                break
            consecutive_no_improve += 1
            continue
        # Accept only when overall (unweighted) SSE improves — guards against
        # over-correcting one region at the expense of the rest.
        cand_y   = apply_weighted_scale(intensity, cand_modeled, ones_full)
        cand_sse = float(np.sum((intensity - cand_y) ** 2))
        if cand_sse < final_sse:
            best_active    = res_adapt.x
            best_full, best_pulse_ms = unpack_active(best_active)
            final_y        = cand_y
            final_sse      = cand_sse
            consecutive_no_improve = 0  # Reset on improvement
            tol_exceeded = _tolerances_exceeded(final_y)
            r2_not_met = (1.0 - final_sse / denom) < R2_TARGET
            p_e, r_e, d_e = _compute_tolerance_errors(final_y)
            report_progress(
                phase="adaptive_refine",
                adaptive_completed_cycles=adapt_cycles_done,
                adaptive_max_cycles=MAX_ADAPT_CYCLES,
                current_r2=float(1.0 - final_sse / denom),
                tolerances_exceeded=bool(tol_exceeded),
                tolerance_errors={"peak": p_e, "rise": r_e, "decay": d_e},
                message=(
                    f"Adaptive loop {adapt_cycles_done}/{MAX_ADAPT_CYCLES} completed "
                    f"(R2={1.0 - final_sse / denom:.6f}). "
                    f"Tolerances met: {not tol_exceeded}."
                ),
            )
        else:
            consecutive_no_improve += 1
            strategy_desc = "soft_l1 loss" if use_soft_l1 else "boosted weights"
            if consecutive_no_improve >= MAX_NO_IMPROVE:
                report_progress(
                    phase="adaptive_refine",
                    adaptive_completed_cycles=adapt_cycles_done,
                    adaptive_max_cycles=MAX_ADAPT_CYCLES,
                    current_r2=float(1.0 - final_sse / denom),
                    message=(
                        f"Adaptive loop {adapt_cycles_done}/{MAX_ADAPT_CYCLES} made no improvement "
                        f"after {consecutive_no_improve} strategy changes; stopping."
                    ),
                )
                break
            else:
                report_progress(
                    phase="adaptive_refine",
                    adaptive_completed_cycles=adapt_cycles_done,
                    adaptive_max_cycles=MAX_ADAPT_CYCLES,
                    current_r2=float(1.0 - final_sse / denom),
                    message=(
                        f"Adaptive loop {adapt_cycles_done}/{MAX_ADAPT_CYCLES} no SSE improvement "
                        f"with {strategy_desc}; changing strategy "
                        f"({consecutive_no_improve}/{MAX_NO_IMPROVE} attempts)."
                    ),
                )

    final_r2 = 1.0 - final_sse / denom

    de_nit = int(getattr(res_global, "nit", 0) or 0)
    de_nfev = int(getattr(res_global, "nfev", 0) or 0)
    ls_nfev = int(getattr(res_local, "nfev", 0) or 0)
    total_evals = de_nfev + ls_nfev + refine_nfev + polish_nfev_total

    final_tol_p, final_tol_r, final_tol_d = _compute_tolerance_errors(final_y)
    # Parameters pinned at a bound mean the box is too small (typical at low Yb), not that the
    # optimiser is slow - surface them in the live log and the diagnostics.
    at_bounds = []
    for _j, _gi in enumerate(active_indices):
        _name = all_param_names[_gi]
        if _name == "T_offset":
            continue
        _v = float(best_active[_j])
        if _v >= 0.98 * float(upper[_j]):
            at_bounds.append(f"{_name}(max)")
        elif _v <= max(1.05 * float(lower[_j]), float(lower[_j]) + 1e-9):
            at_bounds.append(f"{_name}(min)")
    if at_bounds:
        report_progress(
            phase="bounds_check",
            message="Parameters at their bounds: " + ", ".join(at_bounds) +
                    ". Widen bounds or revisit composition / pulse inputs if R2 is low.",
        )
    diagnostics = {
        "fit_quality": fit_quality,
        "n_points_full": int(time_ms.size),
        "n_points_opt": int(t_fit.size),
        "optimize_all_points": bool(optimize_all_points),
        "n_active_params": len(active_indices),
        "n_optimized_variables": int(len(active_indices) + (1 if fit_pulse_width else 0)),
        "n_fixed_params": int(len(fixed_param_names)),
        "active_params": [all_param_names[i] for i in active_indices],
        "fixed_params": fixed_param_names,
        "use_775_calibration": bool(use_775_calibration and state_idx == 7),
        "guided_params": guided_params_used,
        "fitted_pulse_width_us": float(best_pulse_ms * 1000.0),
        "optimization": {
            "de_iterations": de_nit,
            "de_evaluations": de_nfev,
            "local_evaluations": ls_nfev,
            "refine_evaluations": refine_nfev,
            "polish_passes": polish_passes_done,
            "polish_evaluations": polish_nfev_total,
            "adaptive_r2_cycles": adapt_cycles_done,
            "total_evaluations": total_evals,
        },
        "achieved_r2": float(final_r2),
        "target_r2": float(R2_TARGET),
        "adaptive_max_cycles": int(MAX_ADAPT_CYCLES),
        "peak_window_boost": float(peak_window_boost),
        "early_rise_boost": float(early_rise_boost),
        "tolerance_targets": {
            "peak": float(peak_tolerance),
            "rise": float(rise_tolerance),
            "decay": float(decay_tolerance),
        },
        "tolerance_achieved": {
            "peak": final_tol_p,
            "rise": final_tol_r,
            "decay": final_tol_d,
        },
        "all_tolerances_met": not _tolerances_exceeded(final_y),
        "params_at_bounds": at_bounds,
        "time_budget_hit": bool(over_budget()),
    }
    # Return the full 19-vector so the route handler can reference all param names uniformly.
    return final_y, best_full, final_sse, diagnostics


# =============================================================================


__all__ = ['run_fitting']
