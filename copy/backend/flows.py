from .core import *
from .models import *

# SECTION 7 – ROUTE PAYLOAD HELPERS
# =============================================================================

def _build_time_axis_from_payload(payload):
    """Read time axis from payload, or create one from (time_max_ms, num_points)."""
    unit_scale = {"ns": 1e-6, "us": 1e-3, "ms": 1.0}
    time_unit = str(payload.get("time_unit", physics_state.get("time_unit", "ns")))
    scale = float(unit_scale.get(time_unit, 1.0))

    t_input = np.asarray(payload.get("time", []), dtype=float)
    if t_input.size > 0:
        return t_input * scale

    time_max_ms = float(payload.get("time_max_ms", 15.0))
    num_points = int(np.clip(int(payload.get("num_points", 500)), 100, 3000))
    return np.linspace(0.0, time_max_ms, num_points)


def _normalise_trace(y):
    yy = np.asarray(y, dtype=float)
    if yy.size == 0:
        return yy
    yy = yy - np.min(yy)
    mx = float(np.max(yy))
    if mx > 1e-12:
        yy = yy / mx
    return yy


def _estimate_composition_convergence(score, channel_quality):
    """Classify estimator output by practical solution quality, not only optimizer termination."""
    trace_r2_values = []
    timing_error_ratios = []

    for details in (channel_quality or {}).values():
        if not isinstance(details, dict):
            continue

        r2 = details.get("r2")
        if isinstance(r2, (int, float)) and np.isfinite(r2):
            trace_r2_values.append(float(r2))

        for sim_key, tgt_key in (
            ("simulated_peak_time_ms", "target_peak_time_ms"),
            ("simulated_decay_tau_ms", "target_decay_tau_ms"),
        ):
            simulated = details.get(sim_key)
            target = details.get(tgt_key)
            if not isinstance(simulated, (int, float)) or not isinstance(target, (int, float)):
                continue
            if not np.isfinite(simulated) or not np.isfinite(target):
                continue
            timing_error_ratios.append(abs(float(simulated) - float(target)) / max(abs(float(target)), 1e-9))

    score_value = float(score) if np.isfinite(score) else float("inf")
    mean_r2 = float(np.mean(trace_r2_values)) if trace_r2_values else None
    min_r2 = float(np.min(trace_r2_values)) if trace_r2_values else None
    mean_timing_error = float(np.mean(timing_error_ratios)) if timing_error_ratios else None
    max_timing_error = float(np.max(timing_error_ratios)) if timing_error_ratios else None

    trace_ok = (
        not trace_r2_values
        or ((min_r2 is not None and min_r2 >= 0.94) and (mean_r2 is not None and mean_r2 >= 0.97))
    )
    timing_ok = (
        not timing_error_ratios
        or ((max_timing_error is not None and max_timing_error <= 0.20)
            and (mean_timing_error is not None and mean_timing_error <= 0.12))
    )

    if trace_r2_values:
        score_ok = score_value <= 0.06
    elif timing_error_ratios:
        score_ok = score_value <= 0.03
    else:
        score_ok = False

    quality_converged = bool(trace_ok and timing_ok and score_ok)
    return {
        "quality_converged": quality_converged,
        "score_ok": bool(score_ok),
        "trace_ok": bool(trace_ok),
        "timing_ok": bool(timing_ok),
        "mean_r2": mean_r2,
        "min_r2": min_r2,
        "mean_timing_error": mean_timing_error,
        "max_timing_error": max_timing_error,
    }

DEFAULT_EMISSION_WEIGHTS = {
    '1800': {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '1230': {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '775':  {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '645':  {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '477':  {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '452':  {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '362':  {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
    '345':  {'peak': 1.27, 'early': 1.3, 'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01}},
}

def _copy_default_emission_weights():
    return {
        em: {
            'peak': float(v['peak']),
            'early': float(v['early']),
            'tolerances': {
                'peak': float(v['tolerances']['peak']),
                'decay': float(v['tolerances']['decay']),
                'rise': float(v['tolerances']['rise']),
            },
        }
        for em, v in DEFAULT_EMISSION_WEIGHTS.items()
    }


def _sanitize_weight_entry(emission, entry):
    base = _copy_default_emission_weights().get(str(emission), {
        'peak': 1.27,
        'early': 1.3,
        'tolerances': {'peak': 0.01, 'decay': 0.01, 'rise': 0.01},
    })
    if not isinstance(entry, dict):
        return base

    peak = entry.get('peak', base['peak'])
    early = entry.get('early', base['early'])
    tols = entry.get('tolerances', {})
    if not isinstance(tols, dict):
        tols = {}

    return {
        'peak': float(np.clip(float(peak), 1.0, 10.0)),
        'early': float(np.clip(float(early), 1.0, 10.0)),
        'tolerances': {
            'peak': float(np.clip(float(tols.get('peak', base['tolerances']['peak'])), 0.0001, 1.0)),
            'decay': float(np.clip(float(tols.get('decay', base['tolerances']['decay'])), 0.0001, 1.0)),
            'rise': float(np.clip(float(tols.get('rise', base['tolerances']['rise'])), 0.0001, 1.0)),
        },
    }


# Store emission weights in memory

def load_weights():
    """Memory-only mode: keep defaults/current in-process values."""
    return

def save_weights():
    """Memory-only mode: no file is written."""
    return

# =============================================================================
# SECTION 8 – LUMINESCENCE FLOW SOLVERS
# =============================================================================

def solve_luminescence_simulation_flow(payload):
    """
    Separate simulation pipeline for luminescence path selection.
    This is intentionally distinct from ETUC optimization.
    """
    lum_type = str(payload.get("luminescence_type", "upconversion")).lower()
    up_mech = str(payload.get("upconversion_mechanism", "etuc")).lower()
    model_system = str(payload.get("material_model", "co_doped_yb_tm")).lower()
    if model_system == "single_doped_tm":
        lum_type = "downshifting"

    t_ms = _build_time_axis_from_payload(payload)
    if t_ms.size == 0:
        raise ValueError("Time axis is empty")

    if model_system == "single_doped_tm":
        s = payload.get("single_tm_params") or {}
        y = simulate_single_doped_tm_trace(
            t_ms,
            tau_fast_ms=float(s.get("tau_fast_ms", 0.25)),
            tau_slow_ms=float(s.get("tau_slow_ms", 1.5)),
            mix_alpha=float(s.get("mix_alpha", 0.65)),
            rise_ms=float(s.get("rise_ms", 0.05)),
        )
        return {
            "ok": True,
            "flow": {"luminescence_type": lum_type, "mechanism": up_mech, "material_model": model_system},
            "time_ms": t_ms.tolist(),
            "channels": {
                str(payload.get("emission", "775")): {
                    "intensity": y.tolist(),
                    "metrics": compute_trace_metrics(t_ms, y),
                }
            },
        }

    if lum_type == "upconversion" and up_mech == "etuc":
        emissions = payload.get("emissions")
        if not emissions:
            emissions = [str(payload.get("emission", "477"))]
        yb = float(payload.get("doping_yb", physics_state.get("doping_yb", 10.0)))
        tm = float(payload.get("doping_tm", physics_state.get("doping_tm", 0.1)))
        pulse_us = float(payload.get("pulse_width_us", 400.0))

        params = _default_kinetic_params()
        lit_params = payload.get("lit_params") or {}
        if isinstance(lit_params, dict):
            for name, val in lit_params.items():
                param_index = _sim_param_index(name)
                if param_index is not None:
                    params[param_index] = float(val)

        host_material = payload.get("host_material", "NaYF4")
        annealing_c = float(payload.get("annealing_c", 500.0))
        phonon_energy_cm = payload.get("phonon_energy_cm", None)
        if phonon_energy_cm is not None:
            phonon_energy_cm = float(phonon_energy_cm)
        host_mole_factor = float(payload.get("host_mole_factor", 5.0))
        traces = simulate_forward(
            yb,
            tm,
            [str(e) for e in emissions],
            pulse_us,
            t_ms,
            params,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )
        channels = {
            em: {"intensity": arr.tolist(), "metrics": compute_trace_metrics(t_ms, arr)}
            for em, arr in traces.items()
        }
        _, influence = _apply_host_annealing_influence(
            params,
            host_material=host_material,
            annealing_c=annealing_c,
            phonon_energy_cm=phonon_energy_cm,
            host_mole_factor=host_mole_factor,
        )
        return {
            "ok": True,
            "flow": {"luminescence_type": lum_type, "mechanism": up_mech, "material_model": model_system},
            "time_ms": t_ms.tolist(),
            "channels": channels,
            "influence_model": influence,
        }

    mech_params = payload.get("mechanism_params") or {}
    if lum_type == "upconversion":
        y = simulate_upconversion_mechanism_trace(t_ms, mechanism=up_mech, params=mech_params)
    elif lum_type == "downconversion":
        y = simulate_downconversion_trace(t_ms, params=mech_params)
    else:
        y = simulate_downshifting_trace(t_ms, params=mech_params)

    return {
        "ok": True,
        "flow": {"luminescence_type": lum_type, "mechanism": up_mech, "material_model": model_system},
        "time_ms": t_ms.tolist(),
        "channels": {
            str(payload.get("emission", "477")): {
                "intensity": y.tolist(),
                "metrics": compute_trace_metrics(t_ms, y),
            }
        },
    }


def solve_luminescence_optimization_flow(payload):
    """Separate optimization pipeline for non-ETUC/single-doped options."""
    np.random.seed(42)  # Ensure full reproducibility across every run
    t_ms = _build_time_axis_from_payload(payload)
    i_meas = _normalise_trace(payload.get("intensity", []))
    if t_ms.size == 0 or i_meas.size == 0 or t_ms.size != i_meas.size:
        raise ValueError("Optimization requires matching measured time and intensity arrays")

    model_system = str(payload.get("material_model", "co_doped_yb_tm")).lower()
    lum_type = str(payload.get("luminescence_type", "upconversion")).lower()
    up_mech = str(payload.get("upconversion_mechanism", "etuc")).lower()
    if model_system == "single_doped_tm":
        lum_type = "downshifting"

    # Single-doped Tm has a dedicated optimizer.
    if model_system == "single_doped_tm":
        result = fit_single_doped_tm_trace(t_ms, i_meas)
        return {
            "ok": True,
            "flow": {"luminescence_type": lum_type, "mechanism": up_mech, "material_model": model_system},
            "time_ms": t_ms.tolist(),
            **result,
        }

    # Non-ETUC flows currently optimize a compact surrogate parameter set.
    mech_params = payload.get("mechanism_params") or {}

    if lum_type == "upconversion":
        mech_name = up_mech
        sim_fun = lambda tt, p: simulate_upconversion_mechanism_trace(tt, mechanism=mech_name, params=p)
    elif lum_type == "downconversion":
        sim_fun = lambda tt, p: simulate_downconversion_trace(tt, params=p)
    else:
        sim_fun = lambda tt, p: simulate_downshifting_trace(tt, params=p)

    x0 = np.array([
        float(mech_params.get("tau_ms", 1.5)),
        float(mech_params.get("rise_ms", 0.08)),
        float(mech_params.get("amp", 1.0)),
    ], dtype=float)
    lb = np.array([0.05, 0.001, 0.10], dtype=float)
    ub = np.array([12.0, 2.000, 5.00], dtype=float)

    def residuals(x):
        p = {"tau_ms": float(x[0]), "rise_ms": float(x[1]), "amp": float(x[2])}
        yy = sim_fun(t_ms, p)
        return i_meas - yy

    res = least_squares(residuals, x0=x0, bounds=(lb, ub), method="trf", loss="soft_l1", max_nfev=700)
    x = res.x if res.success else x0
    p_best = {"tau_ms": float(x[0]), "rise_ms": float(x[1]), "amp": float(x[2])}
    y_fit = sim_fun(t_ms, p_best)
    sse = float(np.sum((i_meas - y_fit) ** 2))
    denom = float(np.sum((i_meas - np.mean(i_meas)) ** 2) + 1e-12)
    r2 = 1.0 - sse / denom

    return {
        "ok": True,
        "flow": {"luminescence_type": lum_type, "mechanism": up_mech, "material_model": model_system},
        "time_ms": t_ms.tolist(),
        "measured_intensity": i_meas.tolist(),
        "fitted_intensity": y_fit.tolist(),
        "r2": float(r2),
        "params": p_best,
        "timing_metrics": {
            "time_unit": "ms",
            "measured": compute_trace_metrics(t_ms, i_meas),
            "fitted": compute_trace_metrics(t_ms, y_fit),
        },
        "diagnostics": {
            "success": bool(res.success),
            "nfev": int(getattr(res, "nfev", 0) or 0),
            "cost": float(getattr(res, "cost", 0.0) or 0.0),
            "message": str(getattr(res, "message", "")),
            "note": "Surrogate non-ETUC optimizer; ETUC still uses full multilevel ODE optimizer.",
        },
    }


# =============================================================================


__all__ = ['_build_time_axis_from_payload', '_normalise_trace', '_estimate_composition_convergence', 'DEFAULT_EMISSION_WEIGHTS', '_copy_default_emission_weights', '_sanitize_weight_entry', 'load_weights', 'save_weights', 'solve_luminescence_simulation_flow', 'solve_luminescence_optimization_flow']
