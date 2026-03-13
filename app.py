from flask import Flask, jsonify, request, send_from_directory
import numpy as np
import os
import traceback
import time
from scipy.optimize import differential_evolution, least_squares
from scipy.integrate import solve_ivp

import pandas as pd
from io import StringIO
from flask import Response

# Initialize Flask with your static folder settings
app = Flask(__name__, static_folder=".", static_url_path="")
os.makedirs('static/plots', exist_ok=True)

# Global configuration to match your website settings panel
physics_state = {
    "configured": False,
    "doping_yb": 10.0,
    "doping_tm": 0.1,
    "time_scale": 1.0,
    "model_type": "LINEAR_UC_MODEL",
    "time_unit": "ms",
    "fit_quality": "fast"
}

class UCOdeModel:
    """11-state physics engine for Yb-Tm systems."""
    @staticmethod
    def system(t, y, params, p_width):
        (Rp, Ay, W1, W2, W3, W4, W5, k21, k35, A10, A50, A60, A61, A70, A71, A80, A81, Wcr, Wb) = params[:19]
        pump = Rp if t <= p_width else 0.0
        Yb_g, Yb_e, Tm0, Tm1, Tm2, Tm3, Tm4, Tm5, Tm6, Tm7, Tm8 = y
        
        et_sum = (W1*Tm0 + W2*Tm1 + W3*Tm5 + W4*Tm6 + W5*Tm7)
        # Back energy transfer: Tm5(³H₄) + Yb_g → Tm0(³H₆) + Yb_e
        bt = Wb * Tm5 * Yb_g
        dyb_g = -pump * Yb_g + Ay * Yb_e + Yb_e * et_sum - bt
        dyb_e =  pump * Yb_g - Ay * Yb_e - Yb_e * et_sum + bt
        
        dtm0 = A10*Tm1 + A50*Tm5 + A60*Tm6 + A70*Tm7 - W1*Yb_e*Tm0 - Wcr*Tm5*Tm0 + bt
        dtm1 = k21*Tm2 + A61*Tm6 + A71*Tm7 + A81*Tm8 + 2*Wcr*Tm5*Tm0 - A10*Tm1 - W2*Yb_e*Tm1
        dtm2 = W1*Yb_e*Tm0 - k21*Tm2
        dtm3 = W2*Yb_e*Tm1 - k35*Tm3
        dtm4 = 0 
        dtm5 = W2*Yb_e*Tm1 - A50*Tm5 - Wcr*Tm5*Tm0 - W3*Yb_e*Tm5 - bt
        dtm6 = W3*Yb_e*Tm5 - (A60 + A61)*Tm6 - W4*Yb_e*Tm6
        dtm7 = W4*Yb_e*Tm6 - (A70 + A71)*Tm7 - W5*Yb_e*Tm7
        dtm8 = W5*Yb_e*Tm7 - (A81)*Tm8
        return [dyb_g, dyb_e, dtm0, dtm1, dtm2, dtm3, dtm4, dtm5, dtm6, dtm7, dtm8]


def compute_trace_metrics(time_axis, y):
    """Compute rise/decay timing metrics for a normalized trace."""
    t = np.asarray(time_axis, dtype=float)
    yy = np.asarray(y, dtype=float)

    if t.size == 0 or yy.size == 0 or t.size != yy.size:
        return {
            "peak_time": None,
            "peak_value": None,
            "rise_time_10_90": None,
            "decay_tau_1e": None,
            "decay_time_90_10": None,
        }

    peak_idx = int(np.argmax(yy))
    peak_val = float(yy[peak_idx])
    peak_t = float(t[peak_idx])
    eps = 1e-12

    rise_time_10_90 = None
    if peak_idx > 0 and peak_val > eps:
        y_rise = yy[:peak_idx + 1]
        t_rise = t[:peak_idx + 1]
        i10 = np.where(y_rise >= 0.1 * peak_val)[0]
        i90 = np.where(y_rise >= 0.9 * peak_val)[0]
        if i10.size > 0 and i90.size > 0:
            t10 = float(t_rise[i10[0]])
            t90 = float(t_rise[i90[0]])
            rise_time_10_90 = max(0.0, t90 - t10)

    decay_tau_1e = None
    decay_time_90_10 = None
    if peak_idx < (yy.size - 1) and peak_val > eps:
        y_decay = yy[peak_idx:]
        t_decay = t[peak_idx:]

        ie = np.where(y_decay <= peak_val / np.e)[0]
        if ie.size > 0:
            decay_tau_1e = max(0.0, float(t_decay[ie[0]] - peak_t))

        i90d = np.where(y_decay <= 0.9 * peak_val)[0]
        i10d = np.where(y_decay <= 0.1 * peak_val)[0]
        if i90d.size > 0 and i10d.size > 0:
            t90d = float(t_decay[i90d[0]])
            t10d = float(t_decay[i10d[0]])
            decay_time_90_10 = max(0.0, t10d - t90d)

    return {
        "peak_time": peak_t,
        "peak_value": peak_val,
        "rise_time_10_90": rise_time_10_90,
        "decay_tau_1e": decay_tau_1e,
        "decay_time_90_10": decay_time_90_10,
    }


def convert_metrics_time_unit(metrics, ms_per_unit):
    """Convert time metrics from internal ms to selected time unit."""
    if ms_per_unit <= 0:
        return metrics

    out = dict(metrics)
    factor = 1.0 / ms_per_unit
    for key in ["peak_time", "rise_time_10_90", "decay_tau_1e", "decay_time_90_10"]:
        v = out.get(key)
        if v is not None:
            out[key] = float(v) * factor
    return out


def classify_parameter_roles(state_idx):
    """Classify fitted parameters by direct/indirect influence for the selected emission state."""
    all_params = [
        "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
        "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "Wcr", "Wb", "T_offset"
    ]

    # state_idx map in this model:
    # 3->Tm1, 7->Tm5, 8->Tm6, 9->Tm7, 10->Tm8
    # Rp and Ay are always included — they govern Yb_e dynamics that feed every state.
    # Wb (back transfer) appears explicitly in dtm5 so is direct for 775 nm.
    direct_map = {
        3:  {"Rp", "Ay", "W2", "A10", "k21", "A61", "A71", "A81", "Wcr"},
        7:  {"Rp", "Ay", "W2", "A50", "W3", "Wcr", "Wb"},        # 775nm → dtm5
        8:  {"Rp", "Ay", "W3", "A60", "A61", "W4"},               # 477/645nm → dtm6
        9:  {"Rp", "Ay", "W4", "A70", "A71", "W5"},               # 452/362nm → dtm7
        10: {"Rp", "Ay", "W5", "A81"},                             # 345nm → dtm8
    }
    weak_map = {
        3: {"A50", "A60", "A70", "A80", "W3", "W4", "W5"},
        7: {"A10", "A70", "A71", "A80", "A81", "W5"},
        8: {"A10", "A50", "A70", "A71", "A80", "A81"},
        9: {"A10", "A50", "A60", "A61", "A80", "A81"},
        10: {"A10", "A50", "A60", "A61", "A70", "A71"},
    }

    direct = set(direct_map.get(state_idx, set()))
    weak = set(weak_map.get(state_idx, set()))

    # T_offset is always a direct alignment parameter for all emissions.
    direct.add("T_offset")

    indirect = [p for p in all_params if (p not in direct and p not in weak)]

    return {
        "direct": sorted(list(direct)),
        "indirect": sorted(indirect),
        "weakly_identifiable": sorted(list(weak)),
        "note": "Direct: appears explicitly in the selected-state equation. Indirect: influences through coupled populations. Weakly identifiable: usually lower sensitivity for this emission channel.",
    }

def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None):
    p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
    y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc

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
        "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "Wcr", "Wb", "T_offset"
    ]
    param_roles = classify_parameter_roles(state_idx)
    active_set = set(param_roles["direct"])          # always includes T_offset

    guided_params_used = []
    # First 775 run can estimate feeder-chain terms that guide later 477/645 fits.
    if use_775_calibration and state_idx == 7:
        guided_params = {"W1", "k21", "A10"}
        active_set.update(guided_params)
        guided_params_used = sorted(list(guided_params))

    active_indices = [i for i, n in enumerate(all_param_names) if n in active_set]
    fixed_param_names = [n for i, n in enumerate(all_param_names) if i not in active_indices]

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
        5.0,   # Wcr   – cross-relaxation
        0.5,   # Wb    – back energy transfer Tm5(³H₄)→Yb_g→Yb_e
        0.0,   # T_offset
    ], dtype=float)

    # Apply any user-supplied literature overrides (all except Rp and T_offset can be preset).
    if lit_params and isinstance(lit_params, dict):
        for name, val in lit_params.items():
            if name in all_param_names:
                idx_p = all_param_names.index(name)
                param_defaults[idx_p] = float(val)

    all_bounds = [(1e-4, 150.0)] * 18 + [(0.0, 50.0)] + [(0.0, max_offset)]
    bounds_active = [all_bounds[i] for i in active_indices]

    # Fit pulse width as a nuisance parameter to absorb instrument/timing uncertainty.
    fit_pulse_width = True
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
                args=(params_all[:19], p_width_ms),  # pass physical params + fitted pulse width
                method="Radau",
                rtol=1e-6,
                atol=1e-9,
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

    def tail_residual_terms(t_arr, measured, fitted, sqrt_tail):
        i_pk = int(np.argmax(measured))
        tail_mask = np.arange(t_arr.size) >= i_pk
        if np.sum(tail_mask) < 6:
            tail_mask = np.arange(t_arr.size) >= (t_arr.size // 2)

        tail_res = 0.55 * sqrt_tail[tail_mask] * (measured[tail_mask] - fitted[tail_mask])

        area_m = np.trapz(measured[tail_mask], t_arr[tail_mask])
        area_f = np.trapz(fitted[tail_mask], t_arr[tail_mask])
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
        early_res = 0.95 * (measured[early_mask] - fitted[early_mask])

        # Penalize integrated early overshoot/undershoot
        area_m = np.trapz(measured[early_mask], t_arr[early_mask])
        area_f = np.trapz(fitted[early_mask], t_arr[early_mask])
        area_pen = 5.5 * (area_f - area_m) / (abs(area_m) + 1e-12)
        return early_res, area_pen

    def residual_vector(x_active):
        params_all, p_width_ms = unpack_active(x_active)
        modeled, _ = simulate(params_all, p_width_ms, t_fit)
        if modeled is None:
            return np.full_like(i_fit, 1e6)
        fitted = apply_weighted_scale(i_fit, modeled, weights_fit)
        lin_res, log_res, i_pk_m, i_pk_f = residual_core(i_fit, fitted, sqrt_w_fit)
        tail_res, tail_area_pen = tail_residual_terms(t_fit, i_fit, fitted, sqrt_tail_fit)
        early_res, early_area_pen = early_residual_terms(t_fit, i_fit, fitted)
        t_span = np.ptp(t_fit) + 1e-12
        peak_time_pen = 8.0 * (t_fit[i_pk_f] - t_fit[i_pk_m]) / t_span
        peak_amp_pen = 7.5 * (fitted[i_pk_f] - i_fit[i_pk_m])
        return np.concatenate([lin_res, log_res, early_res, tail_res, np.array([peak_time_pen, peak_amp_pen, early_area_pen, tail_area_pen])])

    def residual_vector_full(x_active):
        params_all, p_width_ms = unpack_active(x_active)
        modeled, _ = simulate(params_all, p_width_ms, time_ms)
        if modeled is None:
            return np.full_like(intensity, 1e6)
        fitted = apply_weighted_scale(intensity, modeled, weights_full)
        lin_res, log_res, i_pk_m, i_pk_f = residual_core(intensity, fitted, sqrt_w_full)
        tail_res, tail_area_pen = tail_residual_terms(time_ms, intensity, fitted, sqrt_tail_full)
        early_res, early_area_pen = early_residual_terms(time_ms, intensity, fitted)
        t_span = np.ptp(time_ms) + 1e-12
        peak_time_pen = 8.0 * (time_ms[i_pk_f] - time_ms[i_pk_m]) / t_span
        peak_amp_pen = 7.5 * (fitted[i_pk_f] - intensity[i_pk_m])
        return np.concatenate([lin_res, log_res, early_res, tail_res, np.array([peak_time_pen, peak_amp_pen, early_area_pen, tail_area_pen])])

    def objective(x_active):
        r = residual_vector(x_active)
        return float(np.dot(r, r))

    def objective_full(x_active):
        r = residual_vector_full(x_active)
        return float(np.dot(r, r))

    res_global = differential_evolution(
        objective,
        bounds_active,
        maxiter=cfg["de_maxiter"],
        popsize=cfg["de_popsize"],
        seed=42,
        tol=1e-3,
        polish=False,
    )

    res_local = least_squares(
        residual_vector,
        x0=res_global.x,
        bounds=(lower, upper),
        method="trf",
        loss="soft_l1",
        f_scale=0.05,
        max_nfev=cfg["ls_nfev"],
    )

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
        r2_now = 1.0 - final_sse / denom
        i_pk_m = int(np.argmax(intensity))
        i_pk_f = int(np.argmax(final_y))
        peak_time_err = abs(time_ms[i_pk_f] - time_ms[i_pk_m]) / (np.ptp(time_ms) + 1e-12)
        peak_amp_err = abs(final_y[i_pk_f] - intensity[i_pk_m]) / (abs(intensity[i_pk_m]) + 1e-12)

        if (r2_now < 0.9995) or (peak_time_err > 0.02) or (peak_amp_err > 0.05):
            res_refine = least_squares(
                residual_vector_full,
                x0=best_active,
                bounds=(lower, upper),
                method="trf",
                loss="soft_l1",
                f_scale=0.04,
                max_nfev=400,
            )
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
        params_all, p_width_ms = unpack_active(x_active)
        modeled, _ = simulate(params_all, p_width_ms, time_ms)
        if modeled is None:
            return np.full_like(intensity, 1e6)
        fitted = apply_weighted_scale(intensity, modeled, ones_full)
        base = intensity - fitted
        tail = 0.45 * sqrt_tail_full * (intensity - fitted)
        return np.concatenate([base, tail])

    polish_budget = {
        "fast": (3, 600),
        "balanced": (4, 900),
        "accurate": (5, 1400),
    }.get(fit_quality, (3, 600))
    max_passes, nfev_per_pass = polish_budget

    for _ in range(max_passes):
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

    final_r2 = 1.0 - final_sse / denom

    de_nit = int(getattr(res_global, "nit", 0) or 0)
    de_nfev = int(getattr(res_global, "nfev", 0) or 0)
    ls_nfev = int(getattr(res_local, "nfev", 0) or 0)
    total_evals = de_nfev + ls_nfev + refine_nfev + polish_nfev_total

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
            "total_evaluations": total_evals,
        },
        "achieved_r2": float(final_r2),
    }
    # Return the full 19-vector so the route handler can reference all param names uniformly.
    return final_y, best_full, final_sse, diagnostics

# --- ROUTES ---
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
    try:
        t0 = time.perf_counter()
        payload = request.get_json() or {}
        time_data = np.array(payload.get("time", []), dtype=float)
        intensity = np.array(payload.get("intensity", []), dtype=float)
        
        if not physics_state["configured"]:
            return jsonify({"error": "Configure Physics first"}), 400

        intensity = (intensity - np.min(intensity)) / (np.max(intensity) + 1e-10)
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

        lit_params = payload.get("lit_params", {})

        fit_y, best_params, sse, diag = run_fitting(
            t_ms, intensity, payload.get("pulse_width_us", 400),
            state_idx,
            physics_state["doping_yb"],
            physics_state["doping_tm"],
            requested_quality,
            optimize_all_points=optimize_all_points,
            lit_params=lit_params,
            use_775_calibration=use_775_calibration,
            emission_key=emission_value,
        )

        # Optional "try better and keep only if better" step.
        try_best_match = bool(payload.get("try_best_match", True))
        quality_progression = {"fast": "balanced", "balanced": "accurate", "accurate": None}
        attempted_quality = quality_progression.get(requested_quality)
        if try_best_match and attempted_quality is not None:
            fit_y_alt, best_params_alt, sse_alt, diag_alt = run_fitting(
                t_ms,
                intensity,
                payload.get("pulse_width_us", 400),
                state_idx,
                physics_state["doping_yb"],
                physics_state["doping_tm"],
                attempted_quality,
                optimize_all_points=optimize_all_points,
                lit_params=lit_params,
                use_775_calibration=use_775_calibration,
                emission_key=emission_value,
            )
            if sse_alt < sse:
                fit_y, best_params, sse, diag = fit_y_alt, best_params_alt, sse_alt, diag_alt
                diag["selected_from"] = requested_quality
                diag["selected_quality"] = attempted_quality
            else:
                diag["selected_from"] = requested_quality
                diag["selected_quality"] = requested_quality
                diag["tried_quality"] = attempted_quality

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        elapsed_min = elapsed_ms / 60000.0

        r2 = 1 - (sse / np.sum((intensity - np.mean(intensity))**2))

        param_names = [
            "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
            "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "Wcr", "Wb", "T_offset"
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
            "Wcr": "ms-1",
            "Wb":  "ms-1",
            "T_offset": "ms",
        }

        measured_metrics = compute_trace_metrics(t_ms, intensity)
        fitted_metrics = compute_trace_metrics(t_ms, fit_y)
        param_roles = classify_parameter_roles(state_idx)

        # Only expose parameters that appear directly in the selected emission's ODE equation.
        direct_params = set(param_roles["direct"])  # already includes T_offset
        selected_params = {k: v for k, v in params_all.items() if k in direct_params}
        param_units = {k: v for k, v in all_units.items() if k in direct_params}

        # Extra guided parameters from 775 calibration stage (non-direct but informative for transfer).
        guided_names = [p for p in diag.get("guided_params", []) if p in params_all]
        guide_parameters = {k: params_all[k] for k in guided_names}

        return jsonify({
            "r2": float(r2),
            "fitted_intensity": fit_y.tolist(),
            "measured_intensity": intensity.tolist(),
            "params": {
                "R_P": float(best_params[0]),
                "W_ET1": float(best_params[2]),
                "W_CR": float(best_params[17]),
                "Wb": float(best_params[18]),
                "T_offset": float(best_params[19])
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
            "diagnostics": {
                **diag,
                "elapsed_ms": float(elapsed_ms),
                "elapsed_min": float(elapsed_min)
            },
        })
    except Exception:
        return jsonify({"error": traceback.format_exc()}), 500

@app.route("/api/configure_physics", methods=["POST"])
def configure_physics():
    config = request.get_json()
    physics_state.update({
        "configured": True,
        "time_scale": {"ns": 1e-6, "us": 1e-3, "ms": 1.0}.get(config.get("time_unit"), 1.0),
        "doping_yb": float(config.get("doping_yb", 10.0)),
        "doping_tm": float(config.get("doping_tm", 0.1)),
        "time_unit": config.get("time_unit", "ms"),
        "fit_quality": config.get("fit_quality", physics_state.get("fit_quality", "fast"))
    })
    return jsonify({"success": True})

if __name__ == "__main__":
    # Ensure app.run uses 0.0.0.0 to allow access from local network if needed
    app.run(host="0.0.0.0", port=5050, debug=True)