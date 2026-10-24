from .core import *

# SECTION 3 – PHYSICS ENGINE: UCOdeModel (11-state Yb³⁺/Tm³⁺ ODE system)
# =============================================================================

class UCOdeModel:
    """11-state physics engine for Yb-Tm systems."""
    @staticmethod
    def system(t, y, params, p_width):
        (Rp, Ay, W1, W2, W3, W4, W5, k21, k35, A10, A50, A60, A61, A70, A71, A80, A81, WcrH4, Wb) = params[:19]
        WcrG4, tm_pct, yb_pct = params[19:22]
        pump = Rp if t <= p_width else 0.0
        Yb_g, Yb_e, Tm0, Tm1, Tm2, Tm3, Tm4, Tm5, Tm6, Tm7, Tm8 = y

        et_sum = (W1*Tm0 + W2*Tm1 + W3*Tm5 + W4*Tm6 + W5*Tm7)
        cr_h4 = WcrH4 * Tm5 * Tm0 if tm_pct > 1.0 else 0.0
        cr_g4 = WcrG4 * Tm6 * Tm0 if tm_pct > 0.1 else 0.0
        # Back transfer: Tm5(³H₄) + Yb_g → Tm0(³H₆) + Yb_e.
        bt = Wb * Tm5 * Yb_g if yb_pct > 10.0 else 0.0
        dyb_g = -pump * Yb_g + Ay * Yb_e + Yb_e * et_sum - bt
        dyb_e =  pump * Yb_g - Ay * Yb_e - Yb_e * et_sum + bt

        dtm0 = A10*Tm1 + A50*Tm5 + A60*Tm6 + A70*Tm7 - W1*Yb_e*Tm0 - cr_h4 - cr_g4 + bt
        dtm1 = k21*Tm2 + A61*Tm6 + A71*Tm7 + A81*Tm8 + 2*cr_h4 + cr_g4 - A10*Tm1 - W2*Yb_e*Tm1
        dtm2 = W1*Yb_e*Tm0 - k21*Tm2
        dtm3 = W2*Yb_e*Tm1 - k35*Tm3
        dtm4 = 0
        dtm5 = k35*Tm3 - A50*Tm5 - cr_h4 + cr_g4 - W3*Yb_e*Tm5 - bt
        dtm6 = W3*Yb_e*Tm5 - (A60 + A61)*Tm6 - W4*Yb_e*Tm6 - cr_g4
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


def classify_parameter_roles(state_idx, doping_yb=None, doping_tm=None):
    """Classify fitted parameters by direct/indirect influence for the selected emission state."""
    all_params = [
        "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
        "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "WcrH4", "Wb", "T_offset", "WcrG4"
    ]

    # state_idx map in this model:
    # 3->Tm1, 7->Tm5, 8->Tm6, 9->Tm7, 10->Tm8
    # Rp and Ay are always included — they govern Yb_e dynamics that feed every state.
    # Wb (back transfer) appears explicitly in dtm5 so is direct for 775 nm.
    direct_map = {
        3:  {"Rp", "Ay", "W2", "A10", "k21", "A61", "A71", "A81", "WcrH4", "WcrG4"},
        7:  {"Rp", "Ay", "W2", "k35", "A50", "W3", "WcrH4", "WcrG4", "Wb"},  # 775nm → dtm5
        8:  {"Rp", "Ay", "W3", "A60", "A61", "W4", "WcrG4"},    # 477/645nm → dtm6
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
    inactive_pathways = set()

    if doping_tm is not None:
        tm_pct = float(doping_tm)
        if tm_pct <= 0.1:
            direct.discard("WcrG4")
            inactive_pathways.add("WcrG4")
        if tm_pct <= 1.0:
            direct.discard("WcrH4")
            inactive_pathways.add("WcrH4")
    if doping_yb is not None and float(doping_yb) <= 10.0:
        direct.discard("Wb")
        inactive_pathways.add("Wb")

    all_params = [name for name in all_params if name not in inactive_pathways]
    weak.difference_update(inactive_pathways)

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
    """Return the default 21-element kinetic parameter array used for forward simulation."""
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
        5.0,   # WcrH4 – ³H₄ + ³H₆ → 2×³F₄
        0.5,   # Wb    – back energy transfer ³H₄→Yb
        0.0,   # T_offset (ms)
        5.0,   # WcrG4 – ¹G₄ + ³H₆ → ³H₄ + ³F₄
    ], dtype=float)


_SIM_PARAM_NAMES = [
    "Rp", "Ay", "W1", "W2", "W3", "W4", "W5", "k21", "k35",
    "A10", "A50", "A60", "A61", "A70", "A71", "A80", "A81", "WcrH4", "Wb", "T_offset", "WcrG4"
]
_SIM_PARAM_ALIASES = {"Wcr": "WcrH4"}


def _sim_param_index(name):
    canonical_name = _SIM_PARAM_ALIASES.get(str(name), str(name))
    try:
        return _SIM_PARAM_NAMES.index(canonical_name)
    except ValueError:
        return None

# Row in solve_ivp sol.y for each emission channel (indexed directly from ODE state vector)
_EMISSION_SOL_ROW = {"775": 7, "477": 8, "645": 8, "362": 9, "452": 9, "345": 10}

_HOST_PHONON_ENERGY_CM = {
    "NaYF4": 350.0,
    "YF3": 350.0,
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
    if p.size < 21:
        p = np.pad(p, (0, 21 - p.size))

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
    p[17] *= nr_factor  # WcrH4
    p[18] *= nr_factor  # Wb
    p[20] *= nr_factor  # WcrG4
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
    params          : array-like of length 21, or None for physical defaults

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
            args=(np.concatenate((p[:19], [p[20], float(tm_pct), float(yb_pct)])), p_width_ms),
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


__all__ = ['UCOdeModel', 'compute_trace_metrics', 'convert_metrics_time_unit', 'classify_parameter_roles', '_default_kinetic_params', '_SIM_PARAM_NAMES', '_SIM_PARAM_ALIASES', '_sim_param_index', '_EMISSION_SOL_ROW', '_HOST_PHONON_ENERGY_CM', '_parse_numeric_list', '_apply_host_annealing_influence', 'simulate_forward', 'simulate_single_doped_tm_trace', 'fit_single_doped_tm_trace', 'simulate_upconversion_mechanism_trace', 'simulate_downconversion_trace', 'simulate_downshifting_trace']
