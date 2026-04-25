import os

# ── Force single-threaded BLAS/LAPACK BEFORE numpy is imported ──────────────
# Radau uses implicit Jacobian solves via BLAS.  With multiple threads the
# floating-point reduction order is non-deterministic, which causes different
# adaptive step sizes to be chosen on every run → zero reproducibility.
os.environ.setdefault("OMP_NUM_THREADS",      "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS",      "1")
os.environ.setdefault("BLIS_NUM_THREADS",     "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
# ────────────────────────────────────────────────────────────────────────────

from flask import Flask, jsonify, request, send_from_directory
import numpy as np
import traceback
import time
import threading
from scipy.optimize import differential_evolution, least_squares
from scipy.integrate import solve_ivp

from flask import Response


# =============================================================================
# SECTION 1 – APP SETUP & GLOBAL STATE
# =============================================================================

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

fit_cancel_flags = {}
fit_cancel_lock = threading.Lock()
fit_progress_state = {}
fit_progress_lock = threading.Lock()


# =============================================================================
# SECTION 2 – FIT CANCEL & PROGRESS TRACKING
# =============================================================================

class FitCancelled(Exception):
    """Raised when user cancels an in-flight fit."""


def register_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags[fit_request_id] = False


def cancel_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags[fit_request_id] = True


def is_fit_cancelled(fit_request_id):
    if not fit_request_id:
        return False
    with fit_cancel_lock:
        return bool(fit_cancel_flags.get(fit_request_id, False))


def clear_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags.pop(fit_request_id, None)


def init_fit_progress(fit_request_id):
    if not fit_request_id:
        return
    with fit_progress_lock:
        fit_progress_state[fit_request_id] = {
            "seq": 0,
            "status": "running",
            "message": "Fit request received.",
            "updated_at": time.time(),
        }


def update_fit_progress(fit_request_id, **fields):
    if not fit_request_id:
        return
    with fit_progress_lock:
        state = fit_progress_state.get(fit_request_id, {
            "seq": 0,
            "status": "running",
            "message": "",
            "updated_at": time.time(),
        })
        state["seq"] = int(state.get("seq", 0)) + 1
        state.update(fields)
        state["updated_at"] = time.time()
        fit_progress_state[fit_request_id] = state


def get_fit_progress(fit_request_id):
    if not fit_request_id:
        return None
    with fit_progress_lock:
        state = fit_progress_state.get(fit_request_id)
        return dict(state) if state else None


def clear_fit_progress(fit_request_id):
    if not fit_request_id:
        return
    with fit_progress_lock:
        fit_progress_state.pop(fit_request_id, None)


# =============================================================================
# SECTION 3 – PHYSICS ENGINE: UCOdeModel (11-state Yb³⁺/Tm³⁺ ODE system)
# =============================================================================

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
        dtm8 = W5*Yb_e*Tm7 - A81*Tm8  # Tm8 has no ground-state decay (A80≡0 for this system)
        return [dyb_g, dyb_e, dtm0, dtm1, dtm2, dtm3, dtm4, dtm5, dtm6, dtm7, dtm8]


# =============================================================================
# SECTION 4 – METRIC & ANALYSIS UTILITIES
# =============================================================================

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
        10: {"Rp", "Ay", "W4", "W5", "A81"},               # 345nm → dtm8 (only A81; Tm8 has no ground-state decay)
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


# =============================================================================
# SECTION 5 – KINETIC CONSTANTS & FORWARD ODE SIMULATION
# =============================================================================

def _default_kinetic_params():
    """Return the default 20-element kinetic parameter array used for forward simulation."""
    return np.array([
        5.0,   # Rp    – pump rate (ms^-1)
        1.0,   # Ay    – Yb spontaneous decay rate
        5.0,   # W1    – ET1 Yb→Tm(³H₆→³H₅)
        5.0,   # W2    – ET2 Yb→Tm(³F₄→³H₄)
        2.0,   # W3    – ET3 Yb→Tm(³H₄→¹G₄)
        1.0,   # W4    – ET4 Yb→Tm(¹G₄→¹D₂)
        0.5,   # W5    – ET5 Yb→Tm(¹D₂→³P)
        50.0,  # k21   – Tm(³H₅→³F₄) fast NR
        20.0,  # k35   – Tm(³F₂→³H₄) phonon relaxation
        1.0,   # A10   – Tm1→Tm0 (1800 nm)
        0.33,  # A50   – Tm5→Tm0 (775 nm)
        2.0,   # A60   – Tm6→Tm0 (477 nm)
        0.5,   # A61   – Tm6→Tm1 (645 nm)
        1.5,   # A70   – Tm7→Tm0 (362 nm)
        0.5,   # A71   – Tm7→Tm1 (452 nm)
        2.0,   # A80   – Tm8→Tm0
        2.0,   # A81   – Tm8→Tm1 (345 nm)
        5.0,   # Wcr   – cross-relaxation
        0.5,   # Wb    – back energy transfer ³H₄→Yb
        0.0,   # T_offset (ms)
    ], dtype=float)


_SIM_PARAM_NAMES = [
    "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
    "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "Wcr", "Wb", "T_offset"
]

# Row in solve_ivp sol.y for each emission channel (indexed directly from ODE state vector)
_EMISSION_SOL_ROW = {"775": 7, "477": 8, "645": 8, "362": 9, "452": 9, "345": 10}

_HOST_PHONON_ENERGY_CM = {
    "NaYF4": 350.0,
    "YF3": 360.0,
    "GdF3": 370.0,
    "Y2O3": 550.0,
    "YLF": 450.0,
    "YAG": 700.0,
}


def _parse_numeric_list(values):
    if not isinstance(values, (list, tuple)):
        return []
    out = []
    for v in values:
        try:
            fv = float(v)
            if np.isfinite(fv):
                out.append(fv)
        except Exception:
            continue
    return out


def _apply_host_annealing_influence(
    base_params,
    host_material="NaYF4",
    annealing_c=500.0,
    phonon_energy_cm=None,
    host_mole_factor=5.0,
):
    """Apply host/lattice/annealing scaling to kinetic parameters for simulation/estimation."""
    p = np.asarray(base_params, dtype=float).copy()
    if p.size < 20:
        p = np.pad(p, (0, 20 - p.size))

    host_key = str(host_material or "NaYF4")
    default_phonon = float(_HOST_PHONON_ENERGY_CM.get(host_key, 350.0))
    phonon_cm = float(default_phonon if phonon_energy_cm is None else phonon_energy_cm)
    phonon_cm = float(np.clip(phonon_cm, 120.0, 1200.0))
    anneal = float(annealing_c if annealing_c is not None else 500.0)
    host_mole = float(host_mole_factor if host_mole_factor is not None else 5.0)
    host_mole = float(np.clip(host_mole, 1.0, 20.0))

    # Host influence: higher phonon hosts generally increase non-radiative channels.
    host_nr_factor = float(np.power(max(phonon_cm, 150.0) / 350.0, 0.55))
    host_et_factor = float(np.power(350.0 / max(phonon_cm, 150.0), 0.20))
    host_rad_factor = float(np.power(350.0 / max(phonon_cm, 150.0), 0.08))

    # Annealing influence: moderate annealing improves crystallinity, excessive annealing can re-introduce defects.
    quality = float(np.clip((anneal - 300.0) / 500.0, -0.4, 1.0))
    over_anneal = max(anneal - 900.0, 0.0)
    anneal_et_factor = 1.0 + 0.20 * quality
    anneal_rad_factor = 1.0 + 0.08 * quality
    anneal_nr_factor = 1.0 - 0.25 * quality + 0.15 * (over_anneal / 600.0)

    # Host mole factor (reference 5) modulates dopant interaction density.
    host_mole_ratio = host_mole / 5.0
    mole_et_factor = float(np.power(1.0 / max(host_mole_ratio, 1e-6), 0.35))
    mole_nr_factor = float(np.power(1.0 / max(host_mole_ratio, 1e-6), 0.15))
    mole_rad_factor = float(np.power(max(host_mole_ratio, 1e-6), 0.08))

    et_factor = host_et_factor * anneal_et_factor * mole_et_factor
    nr_factor = host_nr_factor * anneal_nr_factor * mole_nr_factor
    rad_factor = host_rad_factor * anneal_rad_factor * mole_rad_factor

    # ET terms
    p[2:7] *= et_factor
    # Non-radiative / back-transfer dominated terms
    p[7] *= nr_factor   # k21
    p[8] *= nr_factor   # k35
    p[17] *= nr_factor  # Wcr
    p[18] *= nr_factor  # Wb
    # Radiative terms (and Yb intrinsic decay)
    p[1] *= rad_factor  # Ay
    p[9:17] *= rad_factor

    return p, {
        "host_material": host_key,
        "annealing_c": anneal,
        "phonon_cm": phonon_cm,
        "host_mole_factor": host_mole,
        "host_mole_ratio_vs5": host_mole_ratio,
        "mole_et_factor": mole_et_factor,
        "mole_nr_factor": mole_nr_factor,
        "mole_rad_factor": mole_rad_factor,
        "host_nr_factor": host_nr_factor,
        "host_et_factor": host_et_factor,
        "host_rad_factor": host_rad_factor,
        "anneal_nr_factor": anneal_nr_factor,
        "anneal_et_factor": anneal_et_factor,
        "anneal_rad_factor": anneal_rad_factor,
        "combined_nr_factor": nr_factor,
        "combined_et_factor": et_factor,
        "combined_rad_factor": rad_factor,
    }


def simulate_forward(
    yb_pct,
    tm_pct,
    emissions_list,
    pulse_us,
    time_arr,
    params=None,
    host_material="NaYF4",
    annealing_c=500.0,
    phonon_energy_cm=None,
    host_mole_factor=5.0,
):
    """
    Pure forward ODE simulation — no fitting, no optimization.

    Runs the UCOdeModel for given composition and returns a normalized intensity
    trace per emission channel. Shares the same ODE system and observable mapping
    as run_fitting so results are directly comparable with fitted traces.

    Parameters
    ----------
    yb_pct, tm_pct : float  – doping concentrations in %
    emissions_list  : list of str  – e.g. ['775', '477', '345']
    pulse_us        : float  – excitation pulse width in µs
    time_arr        : 1-D np.ndarray  – time axis in ms
    params          : array-like of length 20, or None for physical defaults

    Returns
    -------
    dict  {emission_str: np.ndarray of normalized intensity (0–1)}
    """
    p_base = _default_kinetic_params() if params is None else np.asarray(params, dtype=float).copy()
    p, _ = _apply_host_annealing_influence(
        p_base,
        host_material=host_material,
        annealing_c=annealing_c,
        phonon_energy_cm=phonon_energy_cm,
        host_mole_factor=host_mole_factor,
    )

    p_width_ms = max(float(pulse_us) / 1000.0, 1e-6)
    yb_frac = float(yb_pct) / 100.0
    tm_frac = float(tm_pct) / 100.0
    y0_sim = [yb_frac, 0.0, tm_frac, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]

    t_arr = np.asarray(time_arr, dtype=float)
    t_offset = float(p[19])
    t_shifted = t_arr - t_offset
    mask = t_shifted >= 0.0

    zero_result = {str(em): np.zeros(t_arr.size) for em in emissions_list}
    if not np.any(mask):
        return zero_result

    t_eval = t_shifted[mask]
    t_end = float(t_eval[-1])
    if t_end <= 0:
        return zero_result

    try:
        sol = solve_ivp(
            UCOdeModel.system,
            [0.0, t_end],
            y0_sim,
            t_eval=t_eval,
            args=(p[:19], p_width_ms),
            method="Radau",
            rtol=1e-8,
            atol=1e-11,
        )
    except Exception:
        return zero_result

    if (not sol.success) or (sol.y.shape[1] != t_eval.size):
        return zero_result

    results = {}
    for em in emissions_list:
        em_s = str(em)
        row = _EMISSION_SOL_ROW.get(em_s)
        if row is None or row >= sol.y.shape[0]:
            results[em_s] = np.zeros(t_arr.size)
            continue

        if em_s == "477":
            obs = p[11] * sol.y[row]    # A60 * Tm6
        elif em_s == "645":
            obs = p[12] * sol.y[row]    # A61 * Tm6
        else:
            obs = sol.y[row]

        obs = np.clip(obs, 0.0, np.inf)
        full_obs = np.zeros(t_arr.size)
        full_obs[mask] = obs
        mx = float(np.max(full_obs))
        if mx > 1e-12:
            full_obs /= mx
        results[em_s] = full_obs

    return results


def simulate_single_doped_tm_trace(time_ms, tau_fast_ms=0.3, tau_slow_ms=1.5, mix_alpha=0.65, rise_ms=0.05):
    """Single-doped Tm surrogate trace: finite rise + bi-exponential decay."""
    t = np.asarray(time_ms, dtype=float)
    t = np.clip(t, 0.0, np.inf)
    tau_fast = max(float(tau_fast_ms), 1e-6)
    tau_slow = max(float(tau_slow_ms), 1e-6)
    alpha = float(np.clip(float(mix_alpha), 0.0, 1.0))
    rise = max(float(rise_ms), 1e-6)

    rise_term = 1.0 - np.exp(-t / rise)
    decay_term = alpha * np.exp(-t / tau_fast) + (1.0 - alpha) * np.exp(-t / tau_slow)
    y = np.clip(rise_term * decay_term, 0.0, np.inf)
    mx = float(np.max(y))
    if mx > 1e-12:
        y /= mx
    return y


def fit_single_doped_tm_trace(time_ms, intensity, initial_guess=None):
    """Optimize a single-doped Tm surrogate model against measured trace."""
    t = np.asarray(time_ms, dtype=float)
    y = np.asarray(intensity, dtype=float)
    if t.size < 8 or y.size != t.size:
        raise ValueError("Need at least 8 points with matching time/intensity sizes")

    y = (y - np.min(y)) / (np.max(y) + 1e-12)

    x0 = np.array(initial_guess or [0.25, 1.50, 0.65, 0.05], dtype=float)
    lb = np.array([0.01, 0.05, 0.05, 0.001], dtype=float)
    ub = np.array([3.00, 12.0, 0.95, 1.000], dtype=float)

    def residuals(x):
        yy = simulate_single_doped_tm_trace(
            t,
            tau_fast_ms=float(x[0]),
            tau_slow_ms=float(x[1]),
            mix_alpha=float(x[2]),
            rise_ms=float(x[3]),
        )
        return y - yy

    res = least_squares(residuals, x0=x0, bounds=(lb, ub), method="trf", loss="soft_l1", max_nfev=800)
    x_best = res.x if res.success else x0
    y_fit = simulate_single_doped_tm_trace(t, x_best[0], x_best[1], x_best[2], x_best[3])
    sse = float(np.sum((y - y_fit) ** 2))
    denom = float(np.sum((y - np.mean(y)) ** 2) + 1e-12)
    r2 = 1.0 - sse / denom

    return {
        "fitted_intensity": y_fit,
        "measured_intensity": y,
        "r2": float(r2),
        "params": {
            "tau_fast_ms": float(x_best[0]),
            "tau_slow_ms": float(x_best[1]),
            "mix_alpha": float(x_best[2]),
            "rise_ms": float(x_best[3]),
        },
        "metrics": {
            "measured": compute_trace_metrics(t, y),
            "fitted": compute_trace_metrics(t, y_fit),
        },
        "diagnostics": {
            "success": bool(res.success),
            "nfev": int(getattr(res, "nfev", 0) or 0),
            "cost": float(getattr(res, "cost", 0.0) or 0.0),
            "message": str(getattr(res, "message", "")),
        },
    }


def simulate_upconversion_mechanism_trace(time_ms, mechanism="etuc", params=None):
    """Surrogate trace generators for non-ETUC upconversion mechanisms."""
    p = dict(params or {})
    t = np.asarray(time_ms, dtype=float)
    t = np.clip(t, 0.0, np.inf)

    tau = max(float(p.get("tau_ms", 1.5)), 1e-6)
    rise = max(float(p.get("rise_ms", 0.08)), 1e-6)
    amp = max(float(p.get("amp", 1.0)), 1e-12)

    mech = str(mechanism or "etuc").lower()
    if mech == "esa":
        y = amp * np.power((1.0 - np.exp(-t / rise)), 1.6) * np.exp(-t / tau)
    elif mech == "photon_avalanche":
        t0 = max(float(p.get("threshold_ms", 0.25)), 1e-6)
        sharp = max(float(p.get("sharpness", 12.0)), 1.0)
        gate = 1.0 / (1.0 + np.exp(-sharp * (t - t0)))
        y = amp * gate * np.exp(-t / tau)
    elif mech == "energy_migration_mediated":
        tau_mig = max(float(p.get("migration_ms", 0.35)), 1e-6)
        y = amp * (1.0 - np.exp(-t / tau_mig)) * np.exp(-t / tau)
    elif mech == "cooperative":
        y = amp * np.power((1.0 - np.exp(-t / rise)), 2.0) * np.exp(-t / tau)
    else:
        # ETUC default surrogate is intentionally smooth and close to standard rise+decay.
        y = amp * (1.0 - np.exp(-t / rise)) * np.exp(-t / tau)

    y = np.clip(y, 0.0, np.inf)
    mx = float(np.max(y))
    if mx > 1e-12:
        y /= mx
    return y


def simulate_downconversion_trace(time_ms, params=None):
    """Simple downconversion response model (single exponential by default)."""
    p = dict(params or {})
    t = np.asarray(time_ms, dtype=float)
    tau = max(float(p.get("tau_ms", 2.4)), 1e-6)
    y = np.exp(-np.clip(t, 0.0, np.inf) / tau)
    mx = float(np.max(y))
    if mx > 1e-12:
        y /= mx
    return y


def simulate_downshifting_trace(time_ms, params=None):
    """Simple downshifting response model with finite rise + decay."""
    p = dict(params or {})
    t = np.asarray(time_ms, dtype=float)
    tau = max(float(p.get("tau_ms", 1.8)), 1e-6)
    rise = max(float(p.get("rise_ms", 0.10)), 1e-6)
    y = (1.0 - np.exp(-np.clip(t, 0.0, np.inf) / rise)) * np.exp(-np.clip(t, 0.0, np.inf) / tau)
    mx = float(np.max(y))
    if mx > 1e-12:
        y /= mx
    return y


# =============================================================================
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
                 progress_callback=None):
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
    # 477/645 depend strongly on the Tm5 feeder chain. Keeping these fixed can
    # cause broad/late peaks at higher Tm concentrations, so unlock them here.
    # Wb (back-transfer) always included since it directly sets the Yb effective
    # lifetime, which dominates the long-time tail visible in 477/645 nm.
    if emission_key_s in {"477", "645"}:
        # k35 (Tm3→Tm5) is the only path feeding Tm5 regardless of Tm concentration.
        # W1 (first ET step) is rate-limiting at low Yb since effective W1*Yb_e is halved.
        feeder_params = {"W2", "A50", "Wcr", "Wb", "k35"}
        if yb_pct < 7.0 or tm_pct < 0.3:
            feeder_params.add("W1")
        if tm_pct >= 0.8:
            feeder_params.update({"k21"})
        active_set.update(feeder_params)
        guided_params_used = sorted(list(set(guided_params_used).union(feeder_params)))

    # 362/452 (Tm7 channels) are one step downstream of Tm6 and are sensitive to
    # upstream feeder terms; keep these adjustable to avoid severe underfitting.
    if emission_key_s in {"362", "452"}:
        feeder_params = {"W3", "A60", "A61", "Wcr"}
        if tm_pct >= 0.8:
            feeder_params.update({"W2", "A50", "k35"})
        if tm_pct >= 1.5:
            feeder_params.update({"Wb"})
        active_set.update(feeder_params)
        guided_params_used = sorted(list(set(guided_params_used).union(feeder_params)))

    # 345/347 (Tm8 channel) is a 5-photon process requiring the full cascade of
    # upstream ET rates unlocked.  A80 is excluded (Tm8 has no ground-state decay).
    if emission_key_s in {"345", "347"}:
        feeder_params = {"W3", "W4", "A60", "A61", "A70", "A71", "Wcr"}
        if tm_pct >= 0.5:
            feeder_params.update({"W2", "A50", "k35", "Wb"})
        active_set.update(feeder_params)
        guided_params_used = sorted(list(set(guided_params_used).union(feeder_params)))

    # First 775 run can estimate feeder-chain terms that guide later 477/645 fits.
    if use_775_calibration and state_idx == 7:
        guided_params = {"W1", "k21", "A10"}
        active_set.update(guided_params)
        guided_params_used = sorted(list(set(guided_params_used).union(guided_params)))

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
    # At low Yb concentrations the effective pump rate Rp*Yb_g and ET rates Wi*Yb_e
    # are halved compared to 10% Yb, so the optimizer needs more room on Rp and W1-W3.
    if yb_pct < 7.0:
        low_yb_cap = 300.0
        all_bounds[0] = (all_bounds[0][0], low_yb_cap)  # Rp
        all_bounds[2] = (all_bounds[2][0], low_yb_cap)  # W1
        all_bounds[3] = (all_bounds[3][0], low_yb_cap)  # W2
        all_bounds[4] = (all_bounds[4][0], low_yb_cap)  # W3
    # High-order emission channels (345/362 nm) require fast cascaded ET rates that
    # can legitimately exceed the 150 ms⁻¹ default cap.  Rp, W4, W5, and for the
    # Tm8 channel also A81 is allowed up to 300 ms⁻¹ (A80 inactive in this system).
    if emission_key_s in {"345", "347", "362", "452"}:
        high_cap = 300.0
        all_bounds[0]  = (all_bounds[0][0],  high_cap)   # Rp
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
                args=(params_all[:19], p_width_ms),  # pass physical params + fitted pulse width
                method="Radau",
                rtol=1e-8,
                atol=1e-11,
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
        early_res = (0.95 * early_rise_boost) * (measured[early_mask] - fitted[early_mask])

        # Penalize integrated early overshoot/undershoot
        area_m = np.trapz(measured[early_mask], t_arr[early_mask])
        area_f = np.trapz(fitted[early_mask], t_arr[early_mask])
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
        area_over = np.trapz(np.maximum(fitted[pre_peak_mask] - measured[pre_peak_mask], 0.0), t_arr[pre_peak_mask])
        area_ref = np.trapz(np.clip(measured[pre_peak_mask], 0.0, np.inf), t_arr[pre_peak_mask]) + 1e-12
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
        return bool(callable(cancel_checker) and cancel_checker())

    res_global = differential_evolution(
        objective,
        bounds_active,
        maxiter=cfg["de_maxiter"],
        popsize=cfg["de_popsize"],
        seed=42,
        tol=1e-3,
        polish=False,
        callback=de_cancel_callback,
    )

    check_cancel()

    res_local = least_squares(
        residual_vector,
        x0=res_global.x,
        bounds=(lower, upper),
        method="trf",
        loss="soft_l1",
        f_scale=0.05,
        max_nfev=cfg["ls_nfev"],
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

    while (r2_not_met or tol_exceeded) and adapt_cycles_done < MAX_ADAPT_CYCLES:
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
    }
    # Return the full 19-vector so the route handler can reference all param names uniformly.
    return final_y, best_full, final_sse, diagnostics


# =============================================================================
# SECTION 7 – ROUTE PAYLOAD HELPERS
# =============================================================================

def _build_time_axis_from_payload(payload):
    """Read time axis from payload, or create one from (time_max_ms, num_points)."""
    unit_scale = {"ns": 1e-6, "us": 1e-3, "ms": 1.0}
    time_unit = str(payload.get("time_unit", physics_state.get("time_unit", "ms")))
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
emission_weights = _copy_default_emission_weights()

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
        pulse_us = float(payload.get("pulse_width_us", 100.0))

        params = _default_kinetic_params()
        lit_params = payload.get("lit_params") or {}
        if isinstance(lit_params, dict):
            for name, val in lit_params.items():
                if name in _SIM_PARAM_NAMES:
                    params[_SIM_PARAM_NAMES.index(name)] = float(val)

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
            if name in _SIM_PARAM_NAMES:
                prior[_SIM_PARAM_NAMES.index(name)] = float(val)
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
        if target_r2 >= 0.9997 and not optimize_all_points:
            base_qualities = quality_order[requested_idx:] if try_best_match else [requested_quality]
            for q in base_qualities:
                add_candidate(q, True, "all_points_for_high_target")

        # For high target R2, run one strict accurate+all-points pass for any
        # supported emission to tighten apex and rise alignment consistently.
        if emission_value in emission_map and target_r2 >= 0.9999:
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
    time_unit = str(config.get("time_unit", "ms"))
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
        "w_cr_active": bool(physics_state.get("doping_tm", 0.0) > 0.0),
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
        pulse_us    = float(payload.get("pulse_us", 100.0))
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
            if name in _SIM_PARAM_NAMES:
                params[_SIM_PARAM_NAMES.index(name)] = float(val)

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
        pulse_us     = float(payload.get("pulse_us", 100.0))
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
            if name in _SIM_PARAM_NAMES:
                params[_SIM_PARAM_NAMES.index(name)] = float(val)

        candidate_kinetics = payload.get("kinetics_to_optimize") or ["W1", "W2", "W3", "k21", "k35", "Wcr", "Wb", "A50", "A60", "A61"]
        kinetic_names = [
            str(k) for k in candidate_kinetics
            if str(k) in _SIM_PARAM_NAMES and str(k) not in {"T_offset", "Rp"}
        ]
        kinetic_names = list(dict.fromkeys(kinetic_names))
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
# SECTION 10 – APP ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    # Ensure app.run uses 0.0.0.0 to allow access from local network if needed
    app.run(host="0.0.0.0", port=5050, debug=True)