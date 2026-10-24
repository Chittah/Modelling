from .core import *
from .models import *

# SECTION 6 – MAIN ODE FITTING ENGINE  (run_fitting)
# =============================================================================

# SECTION 5b – SINGLE-DOPED Tm³⁺ ODE MODEL (direct excitation, optional Yb)
# =============================================================================
_ST_LEVELS = ["H6", "F4", "H4", "G4", "D2", "I6", "P2"]   # ³H₆ ³F₄ ³H₄ ¹G₄ ¹D₂ ¹I₆ ³P₂
_ST_ORDER  = ["P2", "I6", "D2", "G4", "H4", "F4"]         # cascade, top -> bottom
_ST_NAMES  = ["G", "G2", "A10", "A30", "A31", "A50", "A51", "A53", "A60", "A61", "A63",
              "A70", "A71", "W87", "W76", "W65", "Kcr", "Kyb", "T_offset"]
_ST_DEFAULTS = dict(G=20.0, G2=1.0, A10=0.12, A30=0.35, A31=0.25, A50=0.6, A51=0.5, A53=0.05,
                    A60=1.0, A61=3.0, A63=0.3, A70=3.0, A71=4.0, W87=500.0, W76=1.0, W65=0.5,
                    Kcr=2.0, Kyb=0.5, T_offset=0.0)
_ST_BOUNDS = {"G": (0.05, 3000.0), "G2": (1e-3, 500.0), "W87": (5.0, 5000.0),
              "W76": (1e-3, 300.0), "W65": (1e-3, 300.0), "Kcr": (1e-3, 200.0), "Kyb": (1e-3, 200.0)}
# excitation (nm) -> entry level (+ ESA target for stepwise pumping)
_ST_EXCITATION = {260: {"entry": "P2"}, 356: {"entry": "D2"}, 466: {"entry": "G4"},
                  785: {"entry": "H4", "esa": "G4"}, 690: {"entry": "H4", "esa": "D2"},
                  1210: {"entry": "H4", "esa": "G4"}}
# emission (nm) -> (emitting level, radiative rate that defines the observable)
_ST_OBS = {"346": ("I6", "A71"), "345": ("I6", "A71"), "362": ("D2", "A60"), "454": ("D2", "A61"),
           "452": ("D2", "A61"), "477": ("G4", "A50"), "645": ("G4", "A51"),
           "775": ("H4", "A30"), "1800": ("F4", "A10")}
_ST_LEVEL_PARAMS = {"P2": ["W87"], "I6": ["A70", "A71", "W76"], "D2": ["A60", "A61", "A63", "W65"],
                    "G4": ["A50", "A51", "A53"], "H4": ["A30", "A31"], "F4": ["A10"]}
# Emissions offered per excitation (the measured channels; other excitations use level reachability only)
_ST_ALLOWED_EMISSIONS = {260: {"346"}, 356: {"454", "775"}, 466: {"645"}}
_ST_FEEDER = {"P2": ["W87"], "I6": ["W76"], "D2": ["W65", "A63"], "G4": ["A53"], "H4": ["A31"], "F4": []}


def _st_resolve_excitation(nm, tol=10.0):
    try:
        nm = float(nm)
    except (TypeError, ValueError):
        return None, None
    k = min(_ST_EXCITATION, key=lambda w: abs(w - nm))
    return (k, _ST_EXCITATION[k]) if abs(k - nm) <= tol else (None, None)


def _st_top_index(exc):
    idx = [_ST_ORDER.index(exc["entry"])]
    if exc.get("esa"):
        idx.append(_ST_ORDER.index(exc["esa"]))
    return min(idx)


def _st_reachable(exc, level):
    return _ST_ORDER.index(level) >= _st_top_index(exc)


def _st_active_names(exc, level, tm_pct, yb_pct, lock_G):
    active = {"T_offset"}
    if not lock_G:
        active.add("G")
    if exc.get("esa"):
        active.add("G2")
        active.update(_ST_LEVEL_PARAMS[exc["entry"]])
    for lvl in _ST_ORDER[_st_top_index(exc):_ST_ORDER.index(level)]:
        active.update(_ST_FEEDER[lvl])
    active.update(_ST_LEVEL_PARAMS[level])
    if tm_pct >= 0.3 and _ST_ORDER.index(level) >= _ST_ORDER.index("D2"):
        active.add("Kcr")
    if yb_pct > 0 and _ST_ORDER.index(level) >= _ST_ORDER.index("G4"):
        active.add("Kyb")
    return [n for n in _ST_NAMES if n in active]


def _st_rhs(t, y, p, on, ie, ie_esa, tm_pct, yb_pct):
    H6, F4, H4, G4, D2, I6, P2 = y
    (G, G2, A10, A30, A31, A50, A51, A53, A60, A61, A63,
     A70, A71, W87, W76, W65, Kcr, Kyb) = p[:18]
    cr = Kcr * tm_pct          # Tm–Tm cross-relaxation, scales with Tm mol%
    yb = Kyb * yb_pct          # Tm -> Yb loss, scales with Yb mol%
    cr1 = cr * H4 * H6         # ³H₄ + ³H₆ -> 2 ³F₄
    cr2 = cr * D2 * H6         # ¹D₂ + ³H₆ -> ¹G₄ + ³F₄
    d = [
        A10*F4 + A30*H4 + A50*G4 + A60*D2 + A70*I6 + yb*(H4 + G4) - cr1 - cr2,
        A31*H4 + A51*G4 + A61*D2 + A71*I6 - A10*F4 + 2.0*cr1 + cr2,
        A53*G4 + A63*D2 - (A30 + A31 + yb)*H4 - cr1,
        W65*D2 - (A50 + A51 + A53 + yb)*G4 + cr2,
        W76*I6 - (A60 + A61 + A63 + W65)*D2 - cr2,
        W87*P2 - (A70 + A71 + W76)*I6,
        -W87*P2,
    ]
    exc = (G if on else 0.0) * H6          # direct (or GSA) pumping out of ³H₆
    d[0] -= exc
    d[ie] += exc
    if ie_esa is not None and on:          # stepwise pumping: entry level -> ESA target
        f = G2 * y[ie]
        d[ie] -= f
        d[ie_esa] += f
    return d


def _st_integrate(p, t_eval, pulse_ms, ie, ie_esa, tm_pct, yb_pct, rtol, atol):
    """Two segments: pump on until pulse_ms, then pump off (no discontinuity inside a step)."""
    y0 = np.zeros(7)
    y0[0] = 1.0
    out = np.zeros((7, t_eval.size))
    on = t_eval <= pulse_ms
    seg1 = np.unique(np.append(t_eval[on], pulse_ms))
    s1 = solve_ivp(lambda t, y: _st_rhs(t, y, p, True, ie, ie_esa, tm_pct, yb_pct),
                   [0.0, pulse_ms], y0, t_eval=seg1, method="LSODA", rtol=rtol, atol=atol)
    if (not s1.success) or s1.y.shape[1] != seg1.size:
        return None
    out[:, on] = s1.y[:, np.searchsorted(seg1, t_eval[on])]
    t_off = t_eval[~on]
    if t_off.size:
        s2 = solve_ivp(lambda t, y: _st_rhs(t, y, p, False, ie, ie_esa, tm_pct, yb_pct),
                       [pulse_ms, float(t_off[-1])], s1.y[:, -1], t_eval=t_off,
                       method="LSODA", rtol=rtol, atol=atol)
        if (not s2.success) or s2.y.shape[1] != t_off.size:
            return None
        out[:, ~on] = s2.y
    return out


def _irf_convolve(signal, t_eval, pulse_ms):
    if signal.size < 5 or t_eval.size < 2:
        return signal
    dt = float(np.median(np.diff(t_eval)))
    if dt <= 0:
        return signal
    sigma = max(1.5 * dt, 0.045 * pulse_ms) / 2.355
    radius = int(np.ceil(4.0 * sigma / dt))
    if radius < 1:
        return signal
    g = np.arange(-radius, radius + 1) * dt
    k = np.exp(-0.5 * (g / sigma) ** 2)
    k /= k.sum() + 1e-12
    return np.convolve(signal, k, mode="same")


def _st_model(p, pulse_ms, t_arr, emission, exc, tm_pct, yb_pct, rtol=1e-8, atol=1e-11):
    ts = t_arr - p[_ST_NAMES.index("T_offset")]
    mask = ts >= 0
    if not np.any(mask):
        return None
    ie = _ST_LEVELS.index(exc["entry"])
    ie_esa = _ST_LEVELS.index(exc["esa"]) if exc.get("esa") else None
    sol = _st_integrate(p, ts[mask], pulse_ms, ie, ie_esa, tm_pct, yb_pct, rtol, atol)
    if sol is None:
        return None
    lvl, a = _ST_OBS[emission]
    obs = np.clip(p[_ST_NAMES.index(a)] * sol[_ST_LEVELS.index(lvl)], 0.0, np.inf)
    out = np.zeros(t_arr.size)
    out[mask] = _irf_convolve(obs, ts[mask], pulse_ms)
    return out


def _st_tol_errors(t, y, f):
    m, fm = compute_trace_metrics(t, y), compute_trace_metrics(t, f)

    def ratio(key):
        a, b = m.get(key), fm.get(key)
        return None if a is None or b is None else abs(b - a) / max(abs(a), 1e-12)
    return ratio("peak_time"), ratio("rise_time_10_90"), ratio("decay_tau_1e")


def run_fitting_single_tm(time_ms, intensity, pulse_us, exc_key, emission, tm_pct, yb_pct,
                          prior=None, lock_G=None, fit_quality="fast", optimize_all_points=False,
                          target_r2=0.999, adaptive_max_cycles=4, peak_boost=1.0, early_boost=1.0,
                          peak_tol=0.01, rise_tol=0.10, decay_tol=0.10, time_offset_ms=0.0,
                          deadline=None, cancel_checker=None, progress_callback=None, seed=42,
                          fit_pulse_width=True):
    np.random.seed(seed)
    exc = _ST_EXCITATION[exc_key]
    level, _ = _ST_OBS[emission]

    def check_cancel():
        if callable(cancel_checker) and cancel_checker():
            raise FitCancelled("Fit cancelled by user")

    def over_budget():
        return deadline is not None and time.perf_counter() > deadline

    def report(**kw):
        if callable(progress_callback):
            try:
                progress_callback(kw)
            except Exception:
                pass

    base = dict(_ST_DEFAULTS)
    for k, v in (prior or {}).items():
        if k in base and np.isfinite(float(v)):
            base[k] = float(v)
    if yb_pct <= 0:
        base["Kyb"] = 0.0
    if lock_G:
        base["G"] = float(lock_G)
    max_off = float(np.max(time_ms)) * 0.3
    base["T_offset"] = float(np.clip(time_offset_ms, 0.0, max_off))

    active = _st_active_names(exc, level, tm_pct, yb_pct, bool(lock_G))
    # A normalised trace cannot separate the observed level's individual rates (only their sum matters),
    # so they are fitted as ONE scale factor "Lobs" that keeps the prior branching ratios.
    obs_group = list(_ST_LEVEL_PARAMS[level])
    free = [nm for nm in active if nm not in obs_group] + ["Lobs"]
    p_nom = max(float(pulse_us) / 1000.0, 1e-6)
    pulse_epsilon = max(p_nom * 1e-9, 1e-12)
    p_lo, p_hi = ((0.7 * p_nom, 1.3 * p_nom) if fit_pulse_width
                  else (p_nom - pulse_epsilon, p_nom + pulse_epsilon))
    na = len(free)

    def bnd(name):
        if name == "T_offset":
            return (0.0, max_off)
        if name == "Lobs":
            return (-2.0, 2.0)
        lo, hi = _ST_BOUNDS.get(name, (1e-3, 100.0))
        return (np.log10(lo), np.log10(hi))

    bounds = [bnd(nm) for nm in free] + [(p_lo, p_hi)]
    lower = np.array([b[0] for b in bounds])
    upper = np.array([b[1] for b in bounds])

    def u_from_base():
        u = []
        for nm in free:
            lo, hi = bnd(nm)
            if nm == "Lobs":
                u.append(0.0)
            elif nm == "T_offset":
                u.append(np.clip(base[nm], lo, hi))
            else:
                u.append(np.clip(np.log10(max(base[nm], 1e-9)), lo, hi))
        return np.array(u + [np.clip(p_nom, p_lo, p_hi)], dtype=float)

    def unpack(u):
        p = np.array([base[nm] for nm in _ST_NAMES], dtype=float)
        for j, nm in enumerate(free):
            if nm == "Lobs":
                for gname in obs_group:
                    p[_ST_NAMES.index(gname)] = base[gname] * 10.0 ** u[j]
            elif nm == "T_offset":
                p[_ST_NAMES.index(nm)] = u[j]
            else:
                p[_ST_NAMES.index(nm)] = 10.0 ** u[j]
        return p, float(u[na])

    cfg = {"fast": (12, 6, 180, 300), "balanced": (22, 8, 350, 600),
           "accurate": (35, 10, 600, 1200)}.get(fit_quality, (12, 6, 180, 300))
    de_iter, de_pop, ls_nfev, max_pts = cfg

    npts = time_ms.size
    if optimize_all_points or npts <= max_pts:
        idx = np.arange(npts)
    else:
        pk = int(np.argmax(intensity))
        w = max(10, npts // 20)
        idx = np.unique(np.concatenate([np.linspace(0, npts - 1, int(max_pts * 0.65), dtype=int),
                                        np.arange(max(0, pk - w), min(npts, pk + w)), [0, npts - 1]]))
    t_fit, y_fit = time_ms[idx], intensity[idx]

    def weights(t, y):
        tn = (t - t.min()) / (np.ptp(t) + 1e-12)
        return np.sqrt(0.25 + 0.55 * peak_boost * np.clip(y, 0, 1) ** 0.6
                       + 0.20 * early_boost * np.exp(-3.0 * tn))

    tol = {"rtol": 1e-6, "atol": 1e-9}     # loose for the global search, tight afterwards

    def resid(u, t, y, sw):
        check_cancel()
        p, pw = unpack(u)
        m = _st_model(p, pw, t, emission, exc, tm_pct, yb_pct, tol["rtol"], tol["atol"])
        if m is None:
            return np.full(2 * y.size + 1, 1e3)
        s = np.sum(sw ** 2 * m * y) / (np.sum(sw ** 2 * m * m) + 1e-12)
        f = np.clip(s * m, 0.0, None)
        return np.concatenate([sw * (y - f),
                               0.2 * sw * (np.log(f + 0.01) - np.log(y + 0.01)),
                               [8.0 * peak_boost * (f.max() - y.max())]])

    sw_fit = weights(t_fit, y_fit)
    report(phase="initialise", message=f"Single-Tm fit: {exc_key} nm -> {emission} nm, "
           f"free: {', '.join(free)} (Lobs = observed-level rates scaled together) + "
           f"{'fitted pulse width' if fit_pulse_width else 'fixed pulse width'}.")

    def obj(u):
        r = resid(u, t_fit, y_fit, sw_fit)
        return float(np.dot(r, r))

    denom = float(np.sum((intensity - intensity.mean()) ** 2)) + 1e-12

    def evaluate(u):
        p, pw = unpack(u)
        m = _st_model(p, pw, time_ms, emission, exc, tm_pct, yb_pct)
        if m is None:
            return None, None, p, pw
        s = np.sum(m * intensity) / (np.sum(m * m) + 1e-12)
        f = np.clip(s * m, 0.0, None)
        return f, float(np.sum((intensity - f) ** 2)), p, pw

    # Starting guess for the observed-level rate scale from the measured post-peak decay time.
    u_tail = None
    try:
        ipk0 = int(np.argmax(intensity))
        seg = slice(ipk0, None)
        ts, ys = time_ms[seg], intensity[seg] / max(float(intensity[ipk0]), 1e-12)
        sel = (ys < 0.7) & (ys > 0.1)
        if sel.sum() >= 4:
            slope = np.polyfit(ts[sel], np.log(ys[sel]), 1)[0]
            if slope < 0 and "Lobs" in free:
                r0 = sum(base[g] for g in obs_group)
                u_tail = u_from_base()
                u_tail[free.index("Lobs")] = float(np.clip(np.log10(max(-slope, 1e-6) / max(r0, 1e-9)), -2, 2))
    except Exception:
        u_tail = None

    n_starts = {"fast": 3, "balanced": 4, "accurate": 5}.get(fit_quality, 3)
    start_r2_goal = min(float(target_r2), 0.99)
    best_u, best_sse = None, None
    rng = np.random.default_rng(seed)
    for k in range(n_starts):
        if k > 0 and (over_budget() or (1.0 - best_sse / denom) >= start_r2_goal):
            break
        check_cancel()
        if k == 0:
            x0 = u_from_base()
        elif k == 1 and u_tail is not None:
            x0 = u_tail
        else:
            x0 = lower + rng.random(lower.size) * (upper - lower)
        tol.update(rtol=1e-6, atol=1e-9)
        res_g = differential_evolution(
            obj, bounds, maxiter=de_iter, popsize=de_pop, seed=seed + k, tol=1e-3, polish=False, x0=x0,
            callback=lambda xk, convergence=None: bool(
                (callable(cancel_checker) and cancel_checker()) or over_budget()))
        tol.update(rtol=1e-8, atol=1e-11)
        check_cancel()
        res_l = least_squares(resid, res_g.x, bounds=(lower, upper), args=(t_fit, y_fit, sw_fit),
                              method="trf", loss="soft_l1", f_scale=0.05,
                              max_nfev=20 if over_budget() else ls_nfev)
        cand = res_l.x if res_l.success else res_g.x
        _, c_sse, _, _ = evaluate(cand)
        if c_sse is not None and (best_sse is None or c_sse < best_sse):
            best_u, best_sse = cand, c_sse
        if k > 0:
            report(phase="retry", message=f"Retry {k}/{n_starts - 1}: best R2={1.0 - best_sse / denom:.5f}")
    if best_u is None:
        raise RuntimeError("Single-Tm fit failed: ODE solver did not converge")

    fy, sse, p_best, pw_best = evaluate(best_u)
    if fy is None:
        raise RuntimeError("Single-Tm fit failed: ODE solver did not converge")

    def tol_state(f):
        pe_, re_, de_ = _st_tol_errors(time_ms, intensity, f)
        bad_ = any(e is not None and e > t for e, t in ((pe_, peak_tol), (re_, rise_tol), (de_, decay_tol)))
        return pe_, re_, de_, bad_

    cycles, strikes = 0, 0
    ones = np.ones(npts)
    while cycles < adaptive_max_cycles and not over_budget():
        check_cancel()
        pe, re, de, bad = tol_state(fy)
        if (1.0 - sse / denom) >= target_r2 and not bad:
            break
        cycles += 1
        ipk = int(np.argmax(intensity))
        h = max(2, npts // 12)
        lo_i, hi_i = max(0, ipk - h), min(npts, ipk + h)
        r_abs = np.abs(intensity - fy)
        e_early = r_abs[:max(1, ipk)].mean()
        e_peak = r_abs[lo_i:hi_i].mean()
        e_tail = r_abs[ipk:].mean()
        tot = e_early + e_peak + e_tail + 1e-12
        b = min(5.0, 1.0 + 0.6 * cycles)
        w = ones.copy()
        w[:ipk] *= 1 + b * e_early / tot
        w[lo_i:hi_i] *= 1 + b * e_peak / tot
        w[ipk:] *= 1 + b * e_tail / tot
        r = least_squares(resid, best_u, bounds=(lower, upper), args=(time_ms, intensity, np.sqrt(w)),
                          method="trf", loss="linear", max_nfev=200 + 100 * strikes)
        cf, csse, cp, cpw = evaluate(r.x)
        if cf is not None and csse < sse:
            best_u, fy, sse, p_best, pw_best, strikes = r.x, cf, csse, cp, cpw, 0
        else:
            strikes += 1
            if strikes >= 2:
                break
        report(phase="adaptive_refine", adaptive_completed_cycles=cycles,
               adaptive_max_cycles=adaptive_max_cycles, current_r2=float(1.0 - sse / denom),
               message=f"Adaptive loop {cycles}/{adaptive_max_cycles} (R2={1.0 - sse / denom:.6f}).")

    # Tail polish: a slow, slightly non-exponential tail carries little absolute weight, so it is
    # under-fitted by the plain residuals. Re-fit with relative (tail-weighted) residuals and keep the
    # result only if the tail error drops clearly while the overall R2 barely changes.
    if not over_budget() and npts > 20:
        try:
            check_cancel()
            ipk_t = int(np.argmax(intensity))
            post = np.zeros(npts)
            post[ipk_t:] = 1.0
            rel_w = post / (intensity + 0.05)

            def tail_err(f_):
                return float(np.sum(post * np.abs(f_ - intensity) / (intensity + 0.05)) / max(post.sum(), 1.0))

            def resid_tail(u):
                check_cancel()
                p_, pw_ = unpack(u)
                m_ = _st_model(p_, pw_, time_ms, emission, exc, tm_pct, yb_pct)
                if m_ is None:
                    return np.full(2 * npts, 1e3)
                s_ = np.sum(m_ * intensity) / (np.sum(m_ * m_) + 1e-12)
                f_ = np.clip(s_ * m_, 0.0, None)
                return np.concatenate([(intensity - f_), 0.5 * rel_w * (intensity - f_)])

            r_t = least_squares(resid_tail, best_u, bounds=(lower, upper), method="trf", loss="linear",
                                max_nfev=150)
            tf, tsse, tp, tpw = evaluate(r_t.x)
            if tf is not None and (tsse - sse) / denom <= 0.003 and tail_err(tf) < 0.95 * tail_err(fy):
                best_u, fy, sse, p_best, pw_best = r_t.x, tf, tsse, tp, tpw
                report(phase="tail_polish", current_r2=float(1.0 - sse / denom),
                       message=f"Tail polish accepted (R2={1.0 - sse / denom:.6f}).")
        except FitCancelled:
            raise
        except Exception:
            pass

    # Wide pulse-width rescue: if the +-30% pulse-width window cannot reproduce the data (e.g. the entered
    # pulse is much longer than the real excitation), retry with the lower pulse bound opened up and keep
    # the result only if it clearly improves the SSE. Good fits never reach this branch.
    if fit_pulse_width and (1.0 - sse / denom) < 0.95 and not over_budget():
        try:
            lower_w = lower.copy()
            upper_w = upper.copy()
            lower_w[na] = 0.03 * p_nom
            if "T_offset" in free:
                jt = free.index("T_offset")
                ipk_o = int(np.argmax(intensity))
                above = np.where(intensity[:ipk_o + 1] >= 0.03)[0]
                t_on = float(time_ms[above[0]]) if above.size else 0.0
                if t_on > 0.0:
                    lower_w[jt] = max(lower_w[jt], 0.7 * t_on)
                    upper_w[jt] = min(upper_w[jt], 1.05 * t_on)
            cands = []
            for frac in (0.12, 0.3):
                u0 = np.array(best_u, dtype=float)
                u0[na] = np.clip(frac * p_nom, lower_w[na], p_hi)
                cands.append(u0)
            for k_w, u0 in enumerate(cands):
                if over_budget():
                    break
                check_cancel()
                tol.update(rtol=1e-6, atol=1e-9)
                res_gw = differential_evolution(
                    obj, list(zip(lower_w, upper_w)), maxiter=de_iter, popsize=de_pop, seed=142 + k_w,
                    tol=1e-3, polish=False, x0=np.clip(u0, lower_w, upper_w),
                    callback=lambda xk, convergence=None: bool(
                        (callable(cancel_checker) and cancel_checker()) or over_budget()))
                tol.update(rtol=1e-8, atol=1e-11)
                check_cancel()
                r_w = least_squares(resid, res_gw.x, bounds=(lower_w, upper_w),
                                    args=(t_fit, y_fit, sw_fit), method="trf", loss="soft_l1",
                                    f_scale=0.05, max_nfev=ls_nfev)
                wf, wsse, wp, wpw = evaluate(r_w.x)
                if wf is not None and wsse < 0.9 * sse:
                    best_u, fy, sse, p_best, pw_best = r_w.x, wf, wsse, wp, wpw
                    report(phase="retry", message=f"Pulse-width rescue: pulse {pw_best * 1000.0:.1f} us, "
                           f"R2={1.0 - sse / denom:.5f}")
        except FitCancelled:
            raise
        except Exception:
            pass

    # Slow-tail component: the ODE cascade decays near-exponentially and cannot generate a long, low-level
    # tail (host/defect afterglow, energy migration, trap release). Fit "ODE trace + a*exp(-(t-t_pk)/tau_s)"
    # with the ODE parameters re-optimised, and keep it only if the SSE drops by >= 15 %.
    slow_tail = None
    if (1.0 - sse / denom) < 0.995 and npts > 30:
        try:
            from scipy.optimize import nnls
            check_cancel()
            ipk_s = int(np.argmax(intensity))
            t_pk = float(time_ms[ipk_s])
            span = float(time_ms[-1] - t_pk)
            if span > 0:
                dt_s = np.where(time_ms >= t_pk, time_ms - t_pk, 0.0)
                on_s = (time_ms >= t_pk).astype(float)
                tau_lo, tau_hi = max(0.02 * span, 1e-6), 2.0 * span
                rel_s = on_s / (intensity + 0.05)

                def tail_shape(log_tau):
                    return on_s * np.exp(-dt_s / 10.0 ** log_tau)

                def mix(u_, log_tau):
                    p_, pw_ = unpack(u_)
                    m_ = _st_model(p_, pw_, time_ms, emission, exc, tm_pct, yb_pct)
                    if m_ is None:
                        return None, None, None
                    tsh = tail_shape(log_tau)
                    A = np.vstack([m_, tsh]).T
                    Aw = np.vstack([A, 0.5 * rel_s[:, None] * A])
                    bw = np.concatenate([intensity, 0.5 * rel_s * intensity])
                    coef, _ = nnls(Aw, bw)
                    return coef[0] * m_ + coef[1] * tsh, coef, tsh

                def resid_slow(v):
                    check_cancel()
                    f_, _, _ = mix(v[:-1], v[-1])
                    if f_ is None:
                        return np.full(2 * npts, 1e3)
                    return np.concatenate([intensity - f_, 0.5 * rel_s * (intensity - f_)])

                lo_s = np.append(lower, np.log10(tau_lo))
                hi_s = np.append(upper, np.log10(tau_hi))
                starts = [best_u] + ([u_tail] if u_tail is not None else [])
                best_s = None
                for u0 in starts:
                    for lt in np.log10(np.geomspace(tau_lo, tau_hi, 4)[1:3]):
                        if over_budget() and best_s is not None:
                            break
                        v0 = np.clip(np.append(u0, lt), lo_s, hi_s)
                        r_s = least_squares(resid_slow, v0, bounds=(lo_s, hi_s), method="trf",
                                            loss="linear", max_nfev=120)
                        f_s, coef_s, _ = mix(r_s.x[:-1], r_s.x[-1])
                        if f_s is None or coef_s[1] <= 0:
                            continue
                        sse_s = float(np.sum((intensity - f_s) ** 2))
                        if best_s is None or sse_s < best_s[0]:
                            best_s = (sse_s, r_s.x, f_s, coef_s)
                if best_s is not None and best_s[0] < 0.85 * sse:
                    sse, v_s, fy, coef_s = best_s
                    best_u = v_s[:-1]
                    p_best, pw_best = unpack(best_u)
                    slow_tail = {"amplitude": float(coef_s[1] / max(coef_s[0] * 1.0, 1e-12)),
                                 "tau_ms": float(10.0 ** v_s[-1])}
                    report(phase="tail_polish", current_r2=float(1.0 - sse / denom),
                           message=f"Slow-tail component accepted: tau={slow_tail['tau_ms']:.3g} ms, "
                                   f"R2={1.0 - sse / denom:.5f}")
        except FitCancelled:
            raise
        except Exception:
            pass

    r2 = 1.0 - sse / denom
    pe, re, de, bad = tol_state(fy)
    at_bounds = [nm for j, nm in enumerate(free) if nm != "T_offset" and
                 (best_u[j] >= upper[j] - 0.02 or best_u[j] <= lower[j] + 0.02)]
    if at_bounds:
        report(phase="bounds_check", message="Parameters at their bounds: " + ", ".join(at_bounds))
    diag = {
        "fit_quality": fit_quality, "n_points_full": int(npts), "n_points_opt": int(t_fit.size),
        "optimize_all_points": bool(optimize_all_points), "active_params": active,
        "fixed_params": [x for x in _ST_NAMES if x not in active],
        "n_optimized_variables": na + int(fit_pulse_width), "n_fixed_params": len(_ST_NAMES) - na,
        "fitted_pulse_width_us": pw_best * 1000.0, "pulse_width_optimized": bool(fit_pulse_width),
        "guided_params": [],
        "optimization": {"de_iterations": int(getattr(res_g, "nit", 0) or 0),
                         "de_evaluations": int(getattr(res_g, "nfev", 0) or 0),
                         "local_evaluations": int(getattr(res_l, "nfev", 0) or 0),
                         "refine_evaluations": 0, "polish_passes": 0, "polish_evaluations": 0,
                         "adaptive_r2_cycles": cycles},
        "target_r2": float(target_r2), "achieved_r2": float(r2),
        "adaptive_max_cycles": int(adaptive_max_cycles),
        "peak_window_boost": float(peak_boost), "early_rise_boost": float(early_boost),
        "tolerance_targets": {"peak": peak_tol, "rise": rise_tol, "decay": decay_tol},
        "tolerance_achieved": {"peak": pe, "rise": re, "decay": de},
        "all_tolerances_met": not bad, "params_at_bounds": at_bounds,
        "time_budget_hit": bool(over_budget()),
        "slow_tail_component": slow_tail,
    }
    return fy, dict(zip(_ST_NAMES, map(float, p_best))), sse, diag


def over_target(diag, target_r2):
    return diag["achieved_r2"] >= target_r2 and diag["all_tolerances_met"]


def _fit_single_tm_route(payload, fit_request_id, t0):
    exc_key, exc = _st_resolve_excitation(payload.get("excitation_wavelength"))
    emission = str(payload.get("emission"))
    if exc is None:
        return jsonify({"error": f"Single-doped Tm has no ODE set for excitation "
                                 f"{payload.get('excitation_wavelength')} nm. Supported: "
                                 f"{sorted(_ST_EXCITATION)}.", "error_code": "UNSUPPORTED_EXCITATION"}), 400
    allowed = _ST_ALLOWED_EMISSIONS.get(exc_key)
    if emission not in _ST_OBS or not _st_reachable(exc, _ST_OBS[emission][0]) or (allowed and emission not in allowed):
        return jsonify({"error": f"{emission} nm cannot be populated by {exc_key} nm excitation in this model.",
                        "error_code": "UNREACHABLE_EMISSION"}), 400
    try:
        tm_pct = float(payload.get("doping_tm"))
        yb_pct = float(payload.get("doping_yb", 0.0) or 0.0)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid doping values.", "error_code": "INVALID_DOPING"}), 400
    if not np.isfinite(yb_pct) or yb_pct < 0:
        return jsonify({"error": "Yb doping must be finite and zero or greater.",
                        "error_code": "INVALID_DOPING"}), 400

    unit_scale = {"ns": 1e-6, "us": 1e-3, "ms": 1.0}
    t_ms = np.asarray(payload.get("time", []), dtype=float) * unit_scale.get(str(payload.get("time_unit", "ns")), 1e-6)
    y = np.asarray(payload.get("intensity", []), dtype=float)
    y = y - np.min(y)
    pk = float(np.percentile(y, 99.5)) if y.size > 10 else float(np.max(y))
    y = np.clip(y / pk, 0.0, 1.0) if pk > 1e-10 else np.zeros_like(y)

    budget = float(payload.get("fit_time_budget_s", 0.0) or 0.0)
    deadline = (time.perf_counter() + budget) if budget > 0 else None
    cancel_checker = (lambda: is_fit_cancelled(fit_request_id)) if fit_request_id else None

    def cb(info):
        update_fit_progress(fit_request_id, status="running", **(info or {}))

    quality = payload.get("fit_quality", "fast")
    target_r2 = float(np.clip(float(payload.get("target_r2", 0.999)), 0.0, 0.999995))
    kw = dict(prior=payload.get("single_tm_prior") or {}, lock_G=payload.get("single_tm_lock_G"),
              optimize_all_points=bool(payload.get("optimize_all_points", False)),
              target_r2=target_r2, adaptive_max_cycles=int(payload.get("adaptive_max_cycles", 4)),
              peak_boost=float(np.clip(float(payload.get("peak_window_boost", 1.0)), 1.0, 10.0)),
              early_boost=float(np.clip(float(payload.get("early_rise_boost", 1.0)), 1.0, 10.0)),
              peak_tol=float(payload.get("peak_tolerance", 0.01)),
              rise_tol=float(payload.get("rise_tolerance", 0.10)),
              decay_tol=float(payload.get("decay_tolerance", 0.10)),
              time_offset_ms=float(payload.get("time_offset_ms", 0.0) or 0.0),
              deadline=deadline, cancel_checker=cancel_checker, progress_callback=cb,
              seed=int(payload.get("fit_seed", 42) or 42),
              fit_pulse_width=bool(payload.get("fit_pulse_width", True)))

    fy, params, sse, diag = run_fitting_single_tm(t_ms, y, payload.get("pulse_width_us", 400), exc_key,
                                                  emission, tm_pct, yb_pct, fit_quality=quality, **kw)
    # one escalation to 'accurate' if the first pass missed its targets
    if quality != "accurate" and payload.get("try_best_match", False) and not over_target(diag, target_r2):
        fy2, params2, sse2, diag2 = run_fitting_single_tm(t_ms, y, payload.get("pulse_width_us", 400), exc_key,
                                                          emission, tm_pct, yb_pct, fit_quality="accurate", **kw)
        if sse2 < sse:
            fy, params, sse, diag = fy2, params2, sse2, diag2

    denom = float(np.sum((y - y.mean()) ** 2)) + 1e-12
    r2 = 1.0 - sse / denom
    ta, tt = diag["tolerance_achieved"], diag["tolerance_targets"]
    actions, codes = [], []
    if ta["peak"] is not None and ta["peak"] > tt["peak"]:
        codes.append("FIT-E41")
        actions.append({"code": "FIT-E41", "action": "boost_peak", "used_weight": kw["peak_boost"],
                        "peak_window_boost": round(min(10.0, kw["peak_boost"] * 1.15), 3),
                        "extra_adaptive_cycles": 3})
    if ta["rise"] is not None and ta["rise"] > tt["rise"]:
        codes.append("FIT-E42")
        actions.append({"code": "FIT-E42", "action": "boost_early_rise", "used_weight": kw["early_boost"],
                        "early_rise_boost": round(min(10.0, kw["early_boost"] * 1.15), 3),
                        "fit_mode": "long", "extra_adaptive_cycles": 4})
    if ta["decay"] is not None and ta["decay"] > tt["decay"]:
        codes.append("FIT-E43")
        actions.append({"code": "FIT-E43", "action": "improve_decay", "fit_mode": "long",
                        "extra_adaptive_cycles": 4})
    ipk = int(np.argmax(y))
    h = max(2, y.size // 12)
    ae = np.abs(y - fy)
    regions = {"early": ae[:max(ipk, 1)].mean(), "peak": ae[max(0, ipk - h):ipk + h].mean(), "tail": ae[ipk:].mean()}
    dom = max(regions, key=regions.get)
    primary = codes[0] if codes else ("OK" if r2 >= target_r2 else
                                      {"early": "FIT-E11", "peak": "FIT-E12", "tail": "FIT-E13"}[dom])
    diag["troubleshooting"] = {
        "summary": f"Single-Tm ODE fit ({exc_key} nm -> {emission} nm), R2={r2:.6f}.",
        "target_r2": target_r2, "achieved_r2": r2, "target_reached": bool(r2 >= target_r2 and not codes),
        "primary_error_code": primary, "error_code": primary, "legacy_error_code": primary,
        "secondary_error_codes": codes[1:], "dominant_error_region": dom,
        "region_mae": {k: float(v) for k, v in regions.items()},
        "changes_applied": [f"{diag['fit_quality']} | all_points={diag['optimize_all_points']}"],
        "recommendations": [f"[{a['code']}] see proposed action." for a in actions],
        "proposed_actions": actions, "tolerance_codes": codes,
    }
    elapsed = (time.perf_counter() - t0) * 1000.0
    diag["elapsed_ms"], diag["elapsed_min"] = elapsed, elapsed / 60000.0
    update_fit_progress(fit_request_id, status="completed", phase="completed",
                        current_r2=float(r2), message="Fit completed.")

    active = set(diag["active_params"])
    roles = {"direct": sorted(active), "indirect": [], "weakly_identifiable": [],
             "note": "Free: pump rate, feeder rates on the path to the observed level, the observed level's own "
                     "rates, T_offset. Everything else is held at the prior (or the value carried from an "
                     "upstream channel)."}
    return jsonify({
        "r2": float(r2), "fitted_intensity": fy.tolist(), "measured_intensity": y.tolist(),
        "params": {"G": params["G"], "T_offset": params["T_offset"]},
        "ode_parameters": {k: v for k, v in params.items() if k in active},
        "ode_parameter_units": {k: ("ms" if k == "T_offset" else "ms-1") for k in active},
        "ode_parameter_time_base": "ms", "guide_parameters": {}, "parameter_roles": roles,
        "single_tm_params_all": params,      # full set, for carry-forward to the next channel
        "timing_metrics": {"time_unit": "ms", "measured": compute_trace_metrics(t_ms, y),
                           "fitted": compute_trace_metrics(t_ms, fy)},
        "influence_model": None, "diagnostics": diag,
    })
# =============================================================================


__all__ = ['_ST_LEVELS', '_ST_ORDER', '_ST_NAMES', '_ST_DEFAULTS', '_ST_BOUNDS', '_ST_EXCITATION', '_ST_OBS', '_ST_LEVEL_PARAMS', '_ST_ALLOWED_EMISSIONS', '_ST_FEEDER', '_st_resolve_excitation', '_st_top_index', '_st_reachable', '_st_active_names', '_st_rhs', '_st_integrate', '_irf_convolve', '_st_model', '_st_tol_errors', 'run_fitting_single_tm', 'over_target', '_fit_single_tm_route']
