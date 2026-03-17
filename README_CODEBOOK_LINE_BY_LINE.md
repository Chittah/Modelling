# TM Lifetime Analyzer - Supervisor Codebook (Line-by-Line Companion)

## Why this file exists
This is a companion README written as a book-style guide for your supervisor.
It explains what each part of the code does, with line references, call flow, and intent.

Because the project has over 5600 lines across backend and frontend, this guide uses:
- line-range explanation (every region is covered), and
- function-level explanation (every top-level function/route is covered).

This gives a practical line-by-line understanding without repeating trivial syntax details.

---

## Files covered
- `app.py` (1370 lines)
- `interactive_fitter copy.html` (4290 lines)

---

## Reading method (recommended)
1. Read one section in this codebook.
2. Open the same line range in the source file.
3. Compare the explanation with real code.
4. Move to the next range.

If your supervisor wants strict traceability, use the line ranges and function index below.

---

## APP.PY SECTION-BY-SECTION CODE AND EXPLANATION

### SECTION 1 – APP SETUP & GLOBAL STATE

```python
from flask import Flask, jsonify, request, send_from_directory
import numpy as np
import os
import traceback
import time
import threading
from scipy.optimize import differential_evolution, least_squares
from scipy.integrate import solve_ivp
import pandas as pd
from io import StringIO
from flask import Response
```
- These are imports. They bring in external libraries and modules needed for the app:
  - `Flask`: Web framework for serving the app and handling requests.
  - `jsonify`, `request`, `send_from_directory`, `Response`: Flask utilities for sending/receiving data.
  - `numpy`: Math library for arrays and calculations.
  - `os`: Operating system utilities (file paths, directories).
  - `traceback`: For error reporting.
  - `time`: For timing and progress tracking.
  - `threading`: For handling multiple fits and progress safely.
  - `differential_evolution`, `least_squares`: SciPy optimizers for fitting.
  - `solve_ivp`: SciPy ODE solver for simulating physics.
  - `pandas`: Data analysis and CSV handling.
  - `StringIO`: In-memory file for CSV export.

```python
app = Flask(__name__, static_folder=".", static_url_path="")
os.makedirs('static/plots', exist_ok=True)
```
- Initializes the Flask app and ensures the static/plots directory exists for saving charts.

```python
physics_state = {
    "configured": False,
    "doping_yb": 10.0,
    "doping_tm": 0.1,
    "time_scale": 1.0,
    "model_type": "LINEAR_UC_MODEL",
    "time_unit": "ms",
    "fit_quality": "fast"
}
```
- Stores global physics settings, matching the UI panel. These are used for fitting and simulation.

```python
fit_cancel_flags = {}
fit_cancel_lock = threading.Lock()
fit_progress_state = {}
fit_progress_lock = threading.Lock()
```
- These dictionaries and locks are used to track fit cancellation and progress.
- `threading.Lock()` ensures that only one thread can modify the state at a time, preventing race conditions.

### SECTION 2 – FIT CANCEL & PROGRESS TRACKING

```python
class FitCancelled(Exception):
    """Raised when user cancels an in-flight fit."""
```
- Custom exception for handling user cancellation of fits.

```python
def register_fit_request(fit_request_id):
    with fit_cancel_lock:
        fit_cancel_flags[fit_request_id] = False
```
- Uses a lock to safely register a new fit request.

```python
def cancel_fit_request(fit_request_id):
    with fit_cancel_lock:
        fit_cancel_flags[fit_request_id] = True
```
- Uses a lock to safely cancel a fit request.

```python
def is_fit_cancelled(fit_request_id):
    if not fit_request_id:
        return False
    with fit_cancel_lock:
        return bool(fit_cancel_flags.get(fit_request_id, False))
```
- Checks if a fit request has been cancelled.

```python
def clear_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags.pop(fit_request_id, None)
```
- Removes a fit request from the cancellation tracking.

```python
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
```
- Initializes progress tracking for a fit request.

```python
def update_fit_progress(fit_request_id, **fields):
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
```
- Uses a lock to safely update progress for a fit request.

- All access to cancellation and progress state is protected by locks, ensuring thread safety when multiple fits are running or being cancelled simultaneously.

```python
def get_fit_progress(fit_request_id):
    if not fit_request_id:
        return None
    with fit_progress_lock:
        state = fit_progress_state.get(fit_request_id)
        return dict(state) if state else None
```
- Retrieves progress state for a fit request.

```python
def clear_fit_progress(fit_request_id):
    if not fit_request_id:
        return
    with fit_progress_lock:
        fit_progress_state.pop(fit_request_id, None)
```
- Removes progress tracking for a fit request.

### SECTION 3 – PHYSICS ENGINE: UCOdeModel (11-state Yb³⁺/Tm³⁺ ODE system)

```python
class UCOdeModel:
    """11-state physics engine for Yb-Tm systems."""
    @staticmethod
    def system(t, y, params, p_width):
        (Rp, Ay, W1, W2, W3, W4, W5, k21, k35, A10, A50, A60, A61, A70, A71, A80, A81, Wcr, Wb) = params[:19]
        pump = Rp if t <= p_width else 0.0
        Yb_g, Yb_e, Tm0, Tm1, Tm2, Tm3, Tm4, Tm5, Tm6, Tm7, Tm8 = y
        et_sum = (W1*Tm0 + W2*Tm1 + W3*Tm5 + W4*Tm6 + W5*Tm7)
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
```
- This class defines the ODE system for the physics model. Each variable represents a population or rate in the Yb-Tm system. The equations describe how populations change over time due to pumping, decay, energy transfer, and back transfer.

### SECTION 4 – METRIC UTILITIES & PARAMETER CLASSIFICATION (Lines 181–300)

```python
def compute_trace_metrics(t, yy):
    """Compute peak, rise, and decay metrics for a time-intensity trace."""
    peak_idx = int(np.argmax(yy))
    peak_val = float(yy[peak_idx])
    peak_t = float(t[peak_idx])
    eps = 1e-12
    rise_time_10_90 = None
    if peak_idx > 0 and peak_val > eps:
        y_rise = yy[:peak_idx+1]
        t_rise = t[:peak_idx+1]
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
    direct_map = {
        3:  {"Rp", "Ay", "W2", "A10", "k21", "A61", "A71", "A81", "Wcr"},
        7:  {"Rp", "Ay", "W2", "A50", "W3", "Wcr", "Wb"},
        8:  {"Rp", "Ay", "W3", "A60", "A61", "W4"},
        9:  {"Rp", "Ay", "W4", "A70", "A71", "W5"},
        10: {"Rp", "Ay", "W5", "A81"},
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
    direct.add("T_offset")
    indirect = [p for p in all_params if (p not in direct and p not in weak)]
    return {
        "direct": sorted(list(direct)),
        "indirect": sorted(indirect),
        "weakly_identifiable": sorted(list(weak)),
        "note": "Direct: appears explicitly in the selected-state equation. Indirect: influences through coupled populations. Weakly identifiable: usually lower sensitivity for this emission channel.",
    }
```

**Explanation:**
- `compute_trace_metrics`: Calculates key metrics (peak time/value, rise time, decay tau, decay time) for a time-intensity trace. Used to quantify fit quality and physical behavior.
- `convert_metrics_time_unit`: Converts metrics from internal ms to user-selected units (e.g., µs, ms, s).
- `classify_parameter_roles`: Categorizes kinetic parameters as direct, indirect, or weakly identifiable for each emission channel. This helps the fitting engine decide which parameters to optimize for a given channel.

### SECTION 5 – KINETIC CONSTANTS & FORWARD ODE SIMULATION (Lines 301–420)

```python
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

_EMISSION_SOL_ROW = {"775": 7, "477": 8, "645": 8, "362": 9, "452": 9, "345": 10}

_HOST_PHONON_ENERGY_CM = {
    "NaYF4": 350.0,
    "YF3": 360.0,
    "GdF3": 370.0,
    "Y2O3": 550.0,
    "YLF": 450.0,
    "YAG": 700.0,
}
```

**Explanation:**
- `_default_kinetic_params`: Returns the default kinetic parameter array (20 values) for simulation. Each value corresponds to a physical rate or transfer constant.
- `_SIM_PARAM_NAMES`: List of parameter names for reference and mapping.
- `_EMISSION_SOL_ROW`: Maps emission wavelengths to ODE solution rows (state vector indices).
- `_HOST_PHONON_ENERGY_CM`: Maps host materials to their phonon energies (used for scaling non-radiative rates).

### SECTION 5 (continued) – HOST/LATTICE/ANNEALING INFLUENCE & FORWARD SIMULATION (Lines 421–480)

```python
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
```

**Explanation:**
- `_apply_host_annealing_influence`: Scales kinetic parameters based on host material, annealing temperature, phonon energy, and mole factor. This models how physical conditions affect upconversion rates and efficiencies.

### SECTION 5 (continued) – PURE FORWARD SIMULATION (Lines 421–480)

```python
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
            rtol=1e-6,
            atol=1e-9,
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
```

**Explanation:**
- `simulate_forward`: Runs a pure ODE simulation for given doping, pulse, and host parameters. Returns normalized intensity traces for each emission channel. Used for physical prediction and comparison with fitted results.

### SECTION 5 (continued) – SURROGATE TRACE MODELS (Lines 481–600)

```python
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
```

**Explanation:**
- `simulate_single_doped_tm_trace`: Generates a surrogate trace for single-doped Tm (rise + bi-exponential decay). Used for comparison and quick fitting.
- `fit_single_doped_tm_trace`: Fits the surrogate model to measured data using least-squares optimization. Returns fit quality, parameters, metrics, and diagnostics.

### SECTION 5 (continued) – UP/DOWNCONVERSION & DOWNSHIFTING SURROGATE MODELS (Lines 601–660)

```python
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
```

**Explanation:**
- `simulate_upconversion_mechanism_trace`: Generates surrogate traces for various upconversion mechanisms (ESA, photon avalanche, energy migration, cooperative, ETUC). Each mechanism has its own mathematical form.
- `simulate_downconversion_trace`: Generates a simple exponential decay trace for downconversion.
- `simulate_downshifting_trace`: Generates a trace with finite rise and decay for downshifting.

---

## SECTION 6 – MAIN ODE FITTING ENGINE (run_fitting) (Lines 661–720)

```python
def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
    p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
    y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
    emission_key_s = str(emission_key)
    tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
    peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
    early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
    if emission_key_s in {"477", "645"}:
        feeder_params = {"W2", "A50", "Wcr"}
        if tm_pct >= 0.8:
            feeder_params.update({"Wb", "k35"})
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
                rtol=1e-6,
                atol=1e-9,
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
    def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
        p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
        y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
        emission_key_s = str(emission_key)
        tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
        peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
        early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
        if emission_key_s in {"477", "645"}:
            feeder_params = {"W2", "A50", "Wcr"}
            if tm_pct >= 0.8:
                feeder_params.update({"Wb", "k35"})
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
                    rtol=1e-6,
                    atol=1e-9,
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
            y = (1.0 - np.exp(-np.clip(t, 0.0, np.inf
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
        def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
            p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
            y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
            emission_key_s = str(emission_key)
            tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
            peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
            early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
            if emission_key_s in {"477", "645"}:
                feeder_params = {"W2", "A50", "Wcr"}
                if tm_pct >= 0.8:
                    feeder_params.update({"Wb", "k35"})
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
                        rtol=1e-6,
                        atol=1e-9,
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
            def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
                p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
                y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
                emission_key_s = str(emission_key)
                tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
                peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
                early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
                if emission_key_s in {"477", "645"}:
                    feeder_params = {"W2", "A50", "Wcr"}
                    if tm_pct >= 0.8:
                        feeder_params.update({"Wb", "k35"})
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
                            rtol=1e-6,
                            atol=1e-9,
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
                def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
                    p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
                    y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
                    emission_key_s = str(emission_key)
                    tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
                    peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
                    early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
                    if emission_key_s in {"477", "645"}:
                        feeder_params = {"W2", "A50", "Wcr"}
                        if tm_pct >= 0.8:
                            feeder_params.update({"Wb", "k35"})
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
                                rtol=1e-6,
                                atol=1e-9,
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
                    def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
                        p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
                        y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
                        emission_key_s = str(emission_key)
                        tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
                        peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
                        early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
                        if emission_key_s in {"477", "645"}:
                            feeder_params = {"W2", "A50", "Wcr"}
                            if tm_pct >= 0.8:
                                feeder_params.update({"Wb", "k35"})
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
                                    rtol=1e-6,
                                    atol=1e-9,
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
                        def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
                            p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
                            y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
                            emission_key_s = str(emission_key)
                            tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
                            peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
                            early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
                            if emission_key_s in {"477", "645"}:
                                feeder_params = {"W2", "A50", "Wcr"}
                                if tm_pct >= 0.8:
                                    feeder_params.update({"Wb", "k35"})
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
                                        rtol=1e-6,
                                        atol=1e-9,
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
                            def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None, target_r2=0.999, adaptive_max_cycles=4, peak_window_boost=1.0, early_rise_boost=1.0, progress_callback=None):
                                p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
                                y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc
                                emission_key_s = str(emission_key)
                                tm_pct = float(doping_tm) if np.isfinite(doping_tm) else 0.0
                                peak_window_boost = float(np.clip(float(peak_window_boost), 1.0, 2.5))
                                early_rise_boost = float(np.clip(float(early_rise_boost), 1.0, 2.5)
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
                                if emission_key_s in {"477", "645"}:
                                    feeder_params = {"W2", "A50", "Wcr"}
                                    if tm_pct >= 0.8:
                                        feeder_params.update({"Wb", "k35"})
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
                                # First 775 run can estimate feeder-chain terms that guide later 477/645 fits.
                                if use_775_calibration and state_idx == 7:
                                    guided_params = {"W1", "k21", "A10"}
                                    active_set.update(guided_params)
                                    guided_params_used = sorted(list(set(guided_params_used).union(guided_params)))
                                active_indices = [i for i, n in enumerate(all_param_names) if n in