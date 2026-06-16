# TM Lifetime Analyzer — Line-by-Line Codebook

> **Codebase total**: 10 326 lines across two files  
> **Backend**: `app.py` (2 955 lines, Python / Flask)  
> **Frontend**: `interactive_fitter copy.html` (7 371 lines, HTML / CSS / JavaScript)  
> **Generated**: 2025 session — all line numbers refer to the current working copy.

---

sudo apt install python3-pip
user@DESKTOP-5ETV7KT:~/Modelling$ python3 -m venv venv
user@DESKTOP-5ETV7KT:~/Modelling$ source venv/bin/activate
(venv) user@DESKTOP-5ETV7KT:~/Modelling$ pip install flask
## Table of Contents

| # | Section | File | Lines |
|---|---------|------|-------|
| 1 | [Backend — `app.py`](#1-backend--apppy) | `app.py` | 1 – 2 955 |
| 2 | [Frontend — `interactive_fitter copy.html`](#2-frontend--interactive_fitter-copyhtml) | HTML | 1 – 7 371 |
| 3 | [Data Flow Diagrams](#3-data-flow-diagrams) | — | — |
| 4 | [Shared Data Contracts (JSON payloads)](#4-shared-data-contracts) | — | — |
| 5 | [File & Directory Map](#5-file--directory-map) | — | — |

---

# 1. Backend — `app.py`

## 1.1 SECTION 1 — App Setup & Global State *(lines 1–40)*

| Lines | What | Detail |
|-------|------|--------|
| 1–14 | **Imports** | `flask`, `numpy`, `scipy.optimize` (differential_evolution, least_squares), `scipy.integrate` (solve_ivp), `pandas`, `threading`, `json`, `os`, `time`, `traceback` |
| 16–18 | Section banner | `SECTION 1 – APP SETUP & GLOBAL STATE` |
| 21–22 | **Flask app creation** | `app = Flask(__name__, static_folder=".", static_url_path="")` — serves the HTML from the working directory. Creates `static/plots/` on startup. |
| 25–34 | **`physics_state` dict** | Global mutable configuration shared across requests. Keys: `configured`, `doping_yb`, `doping_tm`, `time_scale`, `model_type`, `time_unit`, `fit_quality`. Defaults to 10 % Yb, 0.1 % Tm, LINEAR_UC_MODEL, ms, "fast". |
| 36–39 | **Concurrency primitives** | `fit_cancel_flags` dict + `fit_cancel_lock` (threading.Lock) — per-request cancellation flags. `fit_progress_state` dict + `fit_progress_lock` — per-request progress tracking. |

---

## 1.2 SECTION 2 — Fit Cancel & Progress Tracking *(lines 41–119)*

| Lines | What | Detail |
|-------|------|--------|
| 45–47 | **`FitCancelled` exception** | Custom exception raised inside the ODE solver loop when the user presses Cancel. |
| 49–76 | **Cancel flag helpers** | `register_fit_request(id)`, `cancel_fit_request(id)`, `is_fit_cancelled(id)`, `clear_fit_request(id)` — all protected by `fit_cancel_lock`. |
| 77–118 | **Progress tracking helpers** | `init_fit_progress(id)` — creates a progress dict with `phase`, `message`, `iteration`, `best_r2`, `elapsed_s`, `emission`, `cycle`, `total_cycles`. `update_fit_progress(id, **fields)`, `get_fit_progress(id)`, `clear_fit_progress(id)` — thread-safe read/write. |

---

## 1.3 SECTION 3 — Physics Engine: UCOdeModel *(lines 120–149)*

| Lines | What | Detail |
|-------|------|--------|
| 124–149 | **`UCOdeModel` class** | Static-only class. Single method `system(t, y, params, p_width)`. |
| 128 | **Parameter unpacking** | 19 kinetic rate constants extracted from `params[:19]`: `Rp, Ay, W1–W5, k21, k35, A10, A50, A60, A61, A70, A71, A80, A81, Wcr, Wb`. |
| 129 | **Pump gating** | `pump = Rp if t <= p_width else 0.0` — square pulse. |
| 130 | **State vector (11 elements)** | `[Yb_g, Yb_e, Tm0, Tm1, Tm2, Tm3, Tm4, Tm5, Tm6, Tm7, Tm8]` — ground + excited Yb, nine Tm³⁺ manifolds (³H₆ through ³P₂). |
| 132–148 | **Rate equations** | Energy-transfer terms (`W1–W5` × Yb_e × Tm_n), back-transfer (`Wb × Tm5 × Yb_g`), cross-relaxation (`Wcr × Tm5 × Tm0`), radiative decay (`A_ij × Tm_j`), non-radiative relaxation (`k21, k35`). Returns 11-element `dy/dt`. |

### State–Emission Mapping

| State index | Symbol | Manifold | Emission observed |
|-------------|--------|----------|-------------------|
| 0 | Yb_g | ²F₇/₂ | — |
| 1 | Yb_e | ²F₅/₂ | (980 nm Yb fluorescence) |
| 2 | Tm0 | ³H₆ | ground state |
| 3 | Tm1 | ³F₄ | 1800 nm (Tm1 → Tm0) |
| 4 | Tm2 | ³H₅ | 1230 nm (Tm2 → Tm0, fast NR via k21) |
| 5 | Tm3 | ³F₂,₃ | intermediate (fast NR via k35) |
| 6 | Tm4 | ³F₂ | (not active, dtm4 = 0) |
| 7 | Tm5 | ³H₄ | **775 nm** (A50 · Tm5 → Tm0) |
| 8 | Tm6 | ¹G₄ | **477 nm** (A60 · Tm6 → Tm0), **645 nm** (A61 · Tm6 → Tm1) |
| 9 | Tm7 | ¹D₂ | **362 nm** (A70 · Tm7 → Tm0), **452 nm** (A71 · Tm7 → Tm1) |
| 10 | Tm8 | ³P₂/¹I₆ | **345 nm** (A81 · Tm8 → Tm1) |

---

## 1.4 SECTION 4 — Metric & Analysis Utilities *(lines 150–265)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 154–208 | `compute_trace_metrics(time_axis, y)` | Computes timing features from a decay trace: `peak_time`, `rise_time` (10 %→90 % of rise), `decay_time` (peak → 1/e), `half_life` (peak → 50 %), `peak_amplitude`, `area_under_curve`. Returns dict. |
| 210–222 | `convert_metrics_time_unit(metrics, ms_per_unit)` | Rescales all timing metrics from ms to a user-chosen unit. |
| 224–265 | `classify_parameter_roles(state_idx)` | Given an ODE state index (e.g. 7 for Tm5/775 nm), returns which of the 20 kinetic params are **direct** (radiative/decay of that state), **feeding** (populate the state from below), **competing** (drain to other channels), or **indirect**. Used to select which params to optimize per emission. |

---

## 1.5 SECTION 5 — Kinetic Constants & Forward Simulation *(lines 266–633)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 270–292 | `_default_kinetic_params()` | Returns the 20-element default parameter vector (numpy array). Each element is annotated: Rp, Ay, W1–W5, k21, k35, A10, A50, A60–A61, A70–A71, A80–A81, Wcr, Wb, T_offset. |
| 294–298 | `_SIM_PARAM_NAMES` | List of 20 param name strings. |
| 300 | `_EMISSION_SOL_ROW` | Dict mapping emission key → state index in `sol.y`: `{775:7, 477:8, 645:8, 362:9, 452:9, 345:10}`. |
| 302–312 | `_HOST_PHONON_ENERGY_CM` | Phonon energies (cm⁻¹) for known host materials: NaYF₄ (350), YF₃ (360), GdF₃ (370), Y₂O₃ (550), YLF (450), YAG (700). |
| 314–327 | `_parse_numeric_list(values)` | Safely converts a list of values to floats, skipping non-finite entries. |
| 328–401 | `_apply_host_annealing_influence(base_params, …)` | Applies host-lattice and annealing corrections to the 20-param vector. Three scaling factors (ET, NR, radiative) computed from phonon energy, annealing temperature, and host-mole factor. Returns `(modified_params, info_dict)`. |
| 402–503 | `simulate_forward(yb_pct, tm_pct, emissions_list, pulse_us, time_arr, …)` | Pure forward ODE simulation (no fitting). Builds `y0` from doping, runs `solve_ivp(BDF)`, extracts requested emission traces, normalises, computes timing metrics. Returns dict with `traces`, `ode_params`, `metrics`, `physics_output`. |
| 504–521 | `simulate_single_doped_tm_trace(…)` | Generates a bi-exponential decay curve (fast + slow component) for single-doped Tm³⁺ (no Yb sensitiser). |
| 522–574 | `fit_single_doped_tm_trace(…)` | Fits measured data to the bi-exponential model using `least_squares`. Returns fitted params and R². |
| 575–608 | `simulate_upconversion_mechanism_trace(…)` | Demonstration trace for a named UC mechanism (ETUC, CUC, PA). Simple analytical models. |
| 609–620 | `simulate_downconversion_trace(…)` | Single-exponential DC model. |
| 621–633 | `simulate_downshifting_trace(…)` | Same idea for downshifting. |

---

## 1.6 SECTION 6 — Main ODE Fitting Engine: `run_fitting()` *(lines 634–1467)*

This is the largest single function (≈ 830 lines). It performs adaptive multi-cycle ODE fitting.

### Signature (lines 638–657)

```python
def run_fitting(time_ms, intensity, pulse_us,
                state_idx, doping_yb, doping_tm,
                fit_quality="fast", optimize_all_points=False,
                lit_params=None, use_775_calibration=False,
                emission_key=None, cancel_checker=None,
                target_r2=0.999, adaptive_max_cycles=4,
                peak_window_boost=1.0, early_rise_boost=1.0,
                peak_tolerance=0.01, rise_tolerance=0.01,
                decay_tolerance=0.01, progress_callback=None):
```

### Internal Flow

| Lines | Phase | What happens |
|-------|-------|--------------|
| 658–667 | **Init** | Parse inputs, clip boost weights to [1 , 10], build `y0` from doping %. |
| 669–694 | **Quality config** | Select DE/LS iteration counts from `fit_quality` ("fast"/"balanced"/"accurate"). |
| 696–740 | **Parameter space selection** | `classify_parameter_roles(state_idx)` determines which of the 20 params to optimise. For 477/645 nm the Tm5 feeder params (W2, A50, Wcr, optionally Wb, k35) are unlocked. Literature hints (`lit_params`) pin params when available. 775 calibration mode unlocks the full ET chain. |
| 741–850 | **Bounds construction** | Per-param lower/upper bounds built from physical constraints (positive rates, doping-scaled ceilings). |
| 851–900 | **Cost function `_residuals(x)`** | Runs `solve_ivp(BDF)` with candidate params, extracts the emission trace, normalises, applies sample weights that up-weight the peak region (controlled by `peak_window_boost`) and early-rise region (controlled by `early_rise_boost`). Returns weighted residuals array. |
| 901–960 | **Differential Evolution** | `scipy.optimize.differential_evolution` with `maxiter`, `popsize`, `tol`, `workers=-1` (parallel). Callback checks cancellation and reports progress. |
| 961–1020 | **Least-Squares polish** | `scipy.optimize.least_squares(method='trf')` starting from DE best, with `max_nfev` from quality config, bounds carried over. |
| 1021–1100 | **Tolerance checking** | Computes timing metrics (peak-time, rise-time, decay-time) of the fitted trace, calculates ratio errors vs measured data, compares against `peak_tolerance`, `rise_tolerance`, `decay_tolerance`. Builds `tolerance_achieved` and `tolerance_targets` dicts. |
| 1101–1200 | **Adaptive retry loop** | If R² < `target_r2` or any tolerance is exceeded, reruns DE+LS with perturbed bounds and boosted sample weights, up to `adaptive_max_cycles` cycles. Each cycle narrows bounds around the current best. |
| 1201–1350 | **Error code classification** | Inspects the final result and assigns diagnostic codes: FIT-E41 (peak mismatch), FIT-E42 (rise mismatch), FIT-E43 (decay mismatch), FIT-E44 (amplitude), FIT-E45 (shape), FIT-E50 (general poor fit). Each code includes a machine-readable `proposal` with `used_weight` and `emission`. |
| 1351–1467 | **Result assembly** | Builds the return dict: `r2`, `params` (20-element), `param_labels`, `param_units`, `timing_metrics`, `errors`, `error_codes`, `proposals`, `diagnostics` (including `tolerance_achieved`, `tolerance_targets`, `peak_window_boost_used`, `early_rise_boost_used`), `physics_output`, `y0`. |

---

## 1.7 SECTION 7 — Route Payload Helpers *(lines 1468–1531)*

| Lines | Item | Purpose |
|-------|------|---------|
| 1472–1486 | `_build_time_axis_from_payload(payload)` | Extracts `time_ms` array from a JSON payload; handles both raw array and `{start, end, points}` constructors. |
| 1487–1497 | `_normalise_trace(y)` | Baseline-subtracts and peak-normalises an intensity array. |
| 1498–1508 | **`emission_weights` dict** | In-memory store. Keys = emission strings (`'775'`, `'477'`, …). Values = `{peak, early, tolerances: {peak, decay, rise}}`. Default peak = 1.27, early = 1.3, all tolerances = 0.01. |
| 1509 | `WEIGHTS_FILE` | `'emission_weights.json'` — persistence path on disk. |
| 1511–1530 | `load_weights()` / `save_weights()` | JSON serialisation of `emission_weights`. `load_weights()` is called at module import time (line 2948). |

---

## 1.8 SECTION 8 — Luminescence Flow Solvers *(lines 1532–1722)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 1536–1644 | `solve_luminescence_simulation_flow(payload)` | Orchestrates a pure forward simulation: parses composition/physics, calls `simulate_forward()`, maps results, returns traces + metrics + physics info. Used by the Lifetime Generator view. |
| 1645–1722 | `solve_luminescence_optimization_flow(payload)` | Orchestrates a fit: extracts measured data from payload, calls `run_fitting()`, returns `r2`, `params`, `fitted_trace`, `timing_metrics`, `diagnostics`. Used by alternative luminescence flow routes. |

---

## 1.9 SECTION 9 — Flask Routes *(lines 1723–2949)*

### Route Table

| Lines | Route | Method | Handler | Purpose |
|-------|-------|--------|---------|---------|
| 1727–1738 | `/export_csv` | POST | `export_csv()` | Generates a CSV file from posted time/intensity columns and returns it as a download. |
| 1740–1743 | `/` | GET | `index()` | Serves `interactive_fitter copy.html`. |
| 1745–2397 | `/fit` | POST | `fit()` | **Main fitting endpoint** (≈ 650 lines). Parses the full payload (time, intensity, emission, doping, composition, weights, tolerances), spawns `run_fitting()`, streams progress via `fit_progress_state`, handles cancellation, classifies error codes, assembles JSON response including: `r2`, `params`, `param_labels`, `timing_metrics`, `errors`, `error_codes`, `proposals`, `diagnostics`, per-emission `used_weight`. |
| 2398–2423 | `/fit_progress` | GET | `fit_progress()` | Returns the current progress dict for a given `fit_request_id` (polled by the frontend every 500 ms). |
| 2424–2433 | `/cancel_fit` | POST | `cancel_fit()` | Sets the cancel flag for the given request ID. |
| 2434–2447 | `/api/configure_physics` | POST | `configure_physics()` | Updates `physics_state` with doping/model/quality settings from the UI. |
| 2448–2458 | `/simulate_luminescence_flow` | POST | `simulate_luminescence_flow_route()` | Forwards to `solve_luminescence_simulation_flow()`. |
| 2459–2468 | `/fit_luminescence_flow` | POST | `fit_luminescence_flow_route()` | Forwards to `solve_luminescence_optimization_flow()`. |
| 2469–2607 | `/simulate_lifetime` | POST | `simulate_lifetime_route()` | Multi-purpose endpoint used by the Lifetime Generator sidebar. Handles flows: `etuc` (forward ODE), `single_tm` (bi-exponential), `etuc_fit` (alias), `dc` (downconversion), `ds` (downshifting), `mechanism` (upconversion mechanism demo). Builds Plotly-compatible response. |
| 2608–2845 | `/estimate_composition` | POST | `estimate_composition_route()` | Evaluates multiple `(Yb%, Tm%)` combinations via forward ODE, ranks by timing similarity to a target, returns top candidates with scores and traces. Powers the Composition Estimator. |
| 2846–2900 | `/updateEmissionWeights` | POST | `update_emission_weights()` | Persists per-emission peak/early weights and tolerances from the UI to `emission_weights` + disk. |
| 2901–2929 | `/getEmissionWeights` | GET | `get_emission_weights()` | Returns saved weights for one or all emissions. |
| 2931–2948 | `/resetEmissionWeights` | POST | `reset_emission_weights()` | Resets all emissions to default weights (peak 1.27, early 1.3, tolerances 0.01). |

---

## 1.10 SECTION 10 — App Entry Point *(lines 2950–2955)*

```python
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=True)
```

---
---

# 2. Frontend — `interactive_fitter copy.html`

## 2.0 Document Skeleton

| Lines | Region | Content |
|-------|--------|---------|
| 1–2 | `<!DOCTYPE html>`, `<html>` | Standard HTML5 doctype |
| 3–6 | `<head>` | Charset, viewport, title ("TM Lifetime Analyzer") |
| 7–846 | `<style>` | All CSS — inline, ≈ 840 lines |
| 847–849 | **CDN scripts** | Plotly.js, MathJax 3, SheetJS (xlsx) |
| 850 | `</head>` | |
| 851–2495 | `<body>` — **HTML markup** | Header bar, sidebar, five view panels, modals |
| 2496–7370 | `<script>` | **All JavaScript** — ≈ 4 874 lines |
| 7371–7372 | `</body></html>` | Close |

---

## 2.1 CSS *(lines 7–846)*

Inline `<style>` block. Key selectors:

| Lines (approx.) | Selector / Group | Notes |
|------------------|-----------------|-------|
| 7–100 | Reset, body, layout | Flex-based full-height layout |
| 100–250 | Cards, buttons, badges | `.result-card`, `.deposit-card`, status badges |
| 250–400 | Form controls | Inputs, selectors, range sliders, dropdowns |
| 400–555 | Plot containers | `.plot-container`, `.chart-wrapper`, responsive aspect-ratios |
| 555–620 | Sidebar | `.sidebar-menu`, `.menu-item`, active/hover states |
| 594–600 | View panels | `.view-panel` — hidden by default, toggled by JS |
| 620–750 | Ribbon toolbar | `.ribbon-tab`, `.ribbon-content`, tabs active state |
| 750–846 | Modals, tooltips | Image zoom modal, overlays, progress bars |

---

## 2.2 HTML Body — Layout & Views *(lines 851–2495)*

### Header (lines 851–858)
Top application bar with title, version badge, and compact help text.

### Sidebar (lines 862–898)
Fixed-width (250 px) vertical navigation:
- **🏠 Home** — `showView('home')`
- **🔬 Lifetime Analyzer** — `showView('analyzer')`
- **🧪 Development Fitting** — `showView('development')`
- **📊 Lifetime Generator** — `showView('simulator')`
- **❓ Help & Troubleshooting** — `showView('help')`
- Status bar at bottom: live file count, status text, filename.

### View Panels

#### Home View *(lines 901–1006)*
Landing page with project overview, quick-start guide, feature highlights, and emission channel reference table.

#### Development Fitting View *(lines 1007–1058)*
A dedicated panel for per-emission weight tuning. Contains the emission selector dropdown, peak/early weight inputs, tolerance inputs, and a live comparison chart. Rendered dynamically by `renderDevelopmentFitting()`.

#### Analyzer View *(lines 1059–2002)* — **Main working view**

This is the largest HTML section and the primary user workspace.

**Ribbon Toolbar** (lines 1131–1841): Six tabbed panels at the top:

| Tab | `ribbonContent*` id | Lines | Key controls |
|-----|---------------------|-------|--------------|
| 📄 Data File | `Upload` | 1151–1273 | Upload mode toggle (single / multi-channel / folder), file input, drag-drop, multi-channel slot grid, folder queue |
| ⚗️ Sample Composition | `Sample` | 1274–1309 | Yb %, Tm %, host material dropdown, annealing temperature, phonon energy override, host-mole factor |
| ⚛️ Physics Parameters | `Physics` | 1310–1503 | 20 kinetic-param sliders/inputs grouped by category (pump, ET, NR, radiative, cross-relaxation, back-transfer, T_offset) |
| ⚙️ Advanced Settings | `Advanced` | 1504–1681 | Fit quality radio, max adaptive cycles, target R², peak window boost, early rise boost, 775-calibration toggle, optimize-all-points toggle |
| 🔧 Mechanism Parameters | `Mechanism` | 1682–1807 | Sub-panels for ETUC, CUC, PA, single-Tm, DC, DS mechanisms |
| ▶ Run Settings | `Runsettings` | 1808–1831 | Batch run configuration |

**Below the ribbon** (lines 1842–2002):
- Fit/Cancel/Continue buttons
- Status bar with progress text
- Live log panel (scrollable, max 1 000 entries)
- Plot area: raw data chart + fitted overlay
- Results panel (R², params, timing, error codes)
- Deposit list (historical runs with bold BEST FIT badge)
- Depository preview panel

#### Simulator View (Lifetime Generator) *(lines 2003–2250)*

Two sub-panels:

| Lines | Panel | Purpose |
|-------|-------|---------|
| 2014–2123 | **Forward Generator** | Composition inputs, emission checkboxes, pulse width, time range. "Simulate" button → `runAlternativeLuminescenceFlow()`. Plotly chart + equation panel. |
| 2124–2250 | **Composition Estimator** | Target timing inputs (peak, rise, decay, half-life), Yb/Tm search ranges, granularity. "Estimate" button → `/estimate_composition`. Results table + comparison chart. |

#### Help View *(lines 2251–2495)*
Troubleshooting FAQ, physics model overview, error code reference, keyboard shortcuts.

---

## 2.3 JavaScript — Global Variables *(lines 2496–3125)*

| Lines | Variable(s) | Purpose |
|-------|-------------|---------|
| 2501–2540 | `currentData`, `currentFileName`, `uploadedFiles`, `currentUploadMode`, `fitRequestId`, `fitProgressInterval`, `fitIsStopped`, `multiChannelSlotState`, `multiChannelFolderQueue`, `activeFolderIdx`, `multiChannelResults`, `plotDeposits` | Core application state |
| 2542–2553 | `MULTI_CHANNEL_SLOTS` | Array of 8 slot definitions `{id, defaultEmission, role}` for the multi-channel upload grid |
| 2553–2554 | `MULTI_CHANNEL_ORDER`, `MULTI_CHANNEL_MANDATORY` | Processing order and required subset |
| 2555–2576 | `MULTI_CHANNEL_MIN_R2` | Per-emission minimum acceptable R² thresholds (all default 0.99) |
| 2577–3090 | `MULTI_CHANNEL_QUALITY_PROFILES` | **Per-emission tuning profiles** — the largest constant block (≈ 510 lines). Each emission key (`775`, `477`, `645`, `362`, `452`, `345`) gets: error limits (rise/decay/peak/amp), scoring weights, retry controls (max retries, target increment, boost multipliers), and starting boost values. Extensively commented with physical rationale. |
| 3089–3125 | DOMContentLoaded: image modal setup | `setupModalImageClick()`, `openModal()`, `closeModal()`, `zoomModalImage()` |

---

## 2.4 JavaScript — Helper Functions *(lines 3126–3144)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 3127 | `safeGetElement(id)` | `document.getElementById` with null guard |
| 3133 | `safeGetValue(id, default)` | Get `.value` of element, return default if missing |
| 3138 | `safeSetText(id, text)` | Set `.textContent` safely |
| 3143 | `safeSetHtml(id, html)` | Set `.innerHTML` safely |
| 3148 | `setFitResultsHtml(html)` | Write to results display panel |
| 3155 | `getFitResultsHtml()` | Read from results display panel |
| 3162 | `showStatus(type, message)` | Display status bar message with colour-coded type |
| 3175 | `setFitUiBusy(isBusy)` | Toggle button disabled states during fit |
| 3190 | `createFitRequestId()` | Generate unique `fit-{timestamp}-{random}` ID |
| 3195 | `setFitStoppedState(flag)` | Set `fitIsStopped` and update Continue button |
| 3205 | `updateContinueFitButton()` | Show/hide the "Continue Fitting" button based on deposit state |
| 3222–3246 | `window.enablePeakEnhanceAndRefit()` / `window.enableEarlyEnhanceAndRefit()` | One-click actions from error-code proposals: increase peak/early weights and re-fit |

---

## 2.5 JavaScript — Multi-Channel State Management *(lines 3248–3397)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 3248 | `createEmptyMultiChannelSlotState()` | Factory for a fresh 8-slot state array |
| 3262 | `readCurrentFolderSampleConfig()` | Reads Yb %, Tm %, host, annealing, phonon from the ribbon inputs |
| 3274 | `applyFolderSampleConfig(config)` | Writes a saved config back to the ribbon inputs |
| 3291 | `makeFolderLabel(index)` | Human-friendly folder label |
| 3295 | `getActiveMultiChannelFolder()` | Returns current folder object |
| 3299 | `persistActiveFolderConfig()` | Saves current ribbon inputs to the active folder's config |
| 3305 | `syncActiveMultiChannelStateRef()` | Keeps `multiChannelSlotState` pointing at the active folder's slot state |
| 3310 | `renderMultiChannelFolderQueue()` | Renders the folder navigation bar in multi-folder mode |
| 3335 | `initialiseMultiChannelState()` | Resets everything for a fresh folder-queue upload |
| 3353 | `getLoadedMultiChannelCount()` | Counts how many slots have data |
| 3359 | `refreshSidebarFileCount()` | Updates the sidebar "Files: N" counter |
| 3367 | `findSlotIdByEmission(emission)` | Looks up slot index by emission key |
| 3373 | `getActiveUploadMode()` | Returns `'single'` or `'multi'` |
| 3377 | `syncEmissionSelection(emission)` | Syncs the emission dropdown in single-channel mode |
| 3385 | `setActiveDatasetView(data, name, emission)` | Sets `currentData`, shows the dataset in the UI |

---

## 2.6 JavaScript — Emission Weights UI *(lines 3399–3780)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 3399–3510 | `renderMultiChannelRows()` | Builds the multi-channel slot grid in the Data File ribbon tab. Each row shows emission label, filename, slot status badge, remove button. |
| 3453–3510 | `emissionDefaults` (script-level const) | Default peak/early weights per emission. Used to initialise the Development Fitting inputs. |
| 3465–3592 | DOMContentLoaded block | Wires up the emission selector, peak/early inputs, tolerance inputs, and the "Apply Weights" button. `updateInputs()` loads persisted weights; `sendWeightsToBackend()` POSTs to `/updateEmissionWeights`; `sendWeightsDebounced()` debounces input events (300 ms). |
| 3780–3830 | `renderDevelopmentFitting(emissionKey)` | Populates the Development Fitting view with the selected emission's current weights, tolerances, and a comparison chart. |

---

## 2.7 JavaScript — Live Log & Progress *(lines 3831–3890)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 3831 | `appendFitLiveLog(message)` | Appends a `<div>` to the live log panel, auto-scrolls, trims to max 1 000 entries |
| 3845 | `resetFitLiveLog()` | Clears the log |
| 3853 | `stopFitProgressPolling()` | Clears the `setInterval` that polls `/fit_progress` |
| 3860 | `startFitProgressPolling(fitRequestId)` | Starts polling `/fit_progress?id=…` every 500 ms, appends messages to log, updates progress bar |

---

## 2.8 JavaScript — Deposit System *(lines 3891–4205)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 3891 | `savePlotDeposits()` | Serialises `plotDeposits` to `localStorage` |
| 3899 | `loadPlotDeposits()` | Restores from `localStorage` |
| 3912 | `buildRunTitle(fileName, payload, fitRes)` | Formats a human-readable title for a deposited run |
| 3923–3998 | `renderDepositList()` | Renders the scrollable list of deposited fits. Identifies and **bolds the best fit** (highest R²) with a "BEST FIT" badge. Each entry shows R², emission, timestamp, and a clickable preview. |
| 3999 | `clearDepositoryPreview()` | Clears the detail/preview panel |
| 4056–4205 | `depositCurrentRun(fileName, payload, fitRes, time, measured, fitted, resultsHtml, extraFlags)` | Stores a completed run in `plotDeposits`. Saves all result data including params, timing metrics, error codes, proposals, diagnostics. Calls `savePlotDeposits()` + `renderDepositList()`. |

---

## 2.9 JavaScript — File Parsing & Upload *(lines 4206–4459)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 4207 | `parseCSVContent(content)` | Parses CSV text → `{time, intensity, headers}`. Auto-detects delimiter (comma, tab, semicolon), header row, time/intensity columns. |
| 4263 | `parseJSONContent(content)` | Parses JSON file → same format. Handles `{time:[], intensity:[]}` and array-of-objects. |
| 4285 | `processMultipleFiles(files, fileNameDiv)` | Orchestrator for multi-file upload. Reads each FileReader result, detects emission from filename, assigns to correct slot. |
| 4356 | `initializeFileUploadHandlers()` | Binds click/change events for single-file, folder, and multi-channel file inputs. |

---

## 2.10 JavaScript — Data Plotting *(lines 4460–4484)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 4461 | `plotRawData()` | Renders the currently loaded dataset onto the Plotly chart. Handles single and multi-channel overlay modes. |

---

## 2.11 JavaScript — Physics Functions *(lines 4485–4987)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 4485–4700 | Physics helper panel renderers | Functions that build the physics parameter display, WNR calculator, parameter sensitivity analysis UI |
| 4701 | `buildMultiChannelFitSequence(slotState)` | Builds the ordered sequence of `{emission, data, slotIndex}` items for multi-channel fitting. Respects `MULTI_CHANNEL_ORDER`, mandatory vs optional. |
| 4754 | `getMultiChannelMinR2(emission)` | Returns the minimum acceptable R² for a given emission from `MULTI_CHANNEL_MIN_R2` |
| 4760 | `getMultiChannelQualityProfile(emission)` | Returns the full quality profile for a given emission from `MULTI_CHANNEL_QUALITY_PROFILES` |
| 4780 | `getLuminescenceFlowSelection()` | Reads the luminescence mechanism dropdown (ETUC, single_tm, dc, ds) |
| 4789 | `collectMechanismParams()` | Gathers mechanism-specific parameters from the Mechanism ribbon tab |
| 4799 | `collectSingleTmParams()` | Gathers single-Tm bi-exponential parameters |
| 4809 | `applyMechanismSubPanel(flow)` | Shows/hides mechanism-specific sub-panels in the ribbon |

---

## 2.12 JavaScript — Alternative Luminescence Flows *(lines 4908–5183)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 4908–5183 | `async runAlternativeLuminescenceFlow(options)` | Handles all non-ETUC fitting/simulation flows. Sends to `/simulate_lifetime` or `/fit_luminescence_flow`. Processes response, renders charts, computes metrics. Used when user selects single-Tm, DC, DS, or mechanism demonstrations. |

---

## 2.13 JavaScript — Main Fitting Engine: `window.fitData()` *(lines 5184–6385)*

This is the largest JavaScript function (≈ 1 200 lines). It orchestrates the entire fitting workflow.

### High-Level Flow

```
fitData(options)
├── Check internal run flag
├── If non-ETUC flow → runAlternativeLuminescenceFlow() → return
├── If multi-channel/folder mode:
│   ├── persistActiveFolderConfig()
│   ├── buildMultiChannelFitSequence()
│   ├── For each item in sequence:
│   │   ├── Apply folder config
│   │   ├── Recursive call: fitData({internalRun: true, ...})
│   │   ├── Quality check (R², timing, error codes)
│   │   ├── Adaptive retry loop:
│   │   │   ├── scoreResult() — weighted score
│   │   │   ├── buildRetryDirective() — compute new weights/tolerances
│   │   │   ├── Countdown timer (10s or 60s if doping/host review needed)
│   │   │   ├── Retry fitData() with adjusted weights
│   │   │   └── Keep best result across retries
│   │   └── depositCurrentRun()
│   └── Summary
└── Single-channel mode:
    ├── Collect physics payload
    ├── POST /fit
    ├── Poll /fit_progress
    ├── Process result
    ├── Plot fitted curve
    ├── Render results HTML (R², params, timing, error codes, tolerance ratios)
    └── Return result
```

### Key Inner Functions (defined inside `fitData`)

| Lines | Function | Purpose |
|-------|----------|---------|
| 5257 | `getTimingErrorRatios(result)` | Computes `{rise, decay, peak}` ratio errors from `result.timing_metrics` vs measured data. |
| 5287 | `isTimingMismatchSevere(result, emission)` | Checks if any timing error exceeds the emission's quality profile limits |
| 5298 | `scoreResult(result, emission)` | Weighted score combining R² and timing errors, using quality profile weights |
| 5403 | `buildRetryDirective(result, attempt)` | Analyses the fit result, determines which boost weights to increase, calculates new tolerances. Sets `_needsUserReview = true` if errors relate to doping/host/annealing (triggers 60 s countdown instead of 10 s). Returns `{peakBoost, earlyBoost, tolerances, proposal, _needsUserReview}`. |

### Tolerance & Error Display (inside single-channel result processing)

When a fit completes, the results panel shows:
- R² value and quality badge
- All 20 fitted parameters with units
- Timing metrics (peak time, rise time, decay time, half-life)
- **Ratio errors** with pass/fail indicators (✅ / ❌) per tolerance
- Error codes (FIT-E41 through FIT-E50) with actionable proposals
- Comparison to measured data

---

## 2.14 JavaScript — CSV/Excel Export *(lines 6386–6802)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 6386 | `buildRichCsvFilename(…)` | Constructs a descriptive CSV filename including sample info, R², date |
| 6402 | `buildRichCsvHeader(…)` | Builds a multi-line CSV header with metadata: ODE params, timing metrics, physics output, R² |
| 6495 | `triggerCsvDownload(filename, csvContent)` | Creates a download link and triggers click |
| 6508 | `saveBlobWithPicker(blob, name, options)` | Uses File System Access API (if available) with fallback to download link |
| 6538 | `buildResultsJsonFilename(…)` | Filename for JSON export |
| 6549 | `window.downloadCSV()` | Exports the current fit result as CSV |
| 6601 | `window.downloadDepositedCSV()` | Exports a selected deposited run as CSV |
| 6648–6802 | `window.downloadAllResultsExcel()` | Exports all deposited runs as a multi-sheet XLSX workbook (using SheetJS). One sheet per run, plus a summary sheet. |

---

## 2.15 JavaScript — Utility Functions *(lines 6803–6917)*

General-purpose utility functions:

| Lines | Function | Purpose |
|-------|----------|---------|
| 6803–6917 | Various | Number formatting, unit conversion helpers, array statistics, colour palette generation for multi-series plots |

---

## 2.16 JavaScript — Lifetime Generator *(lines 6918–7320)*

| Lines | Function | Purpose |
|-------|----------|---------|
| 6968 | `parseCommaNumberList(text)` | Parses comma-separated number inputs for sweep parameters |
| 6974 | `buildSweepColor(seriesIdx, emissionKey)` | Generates distinct colours for multi-sweep overlays |
| 6981 | `renderSimEquationPanel(data, emissions, spacing)` | Renders the rate-equation panel below the simulation chart (MathJax-formatted ODE equations) |
| 6918–7320 | Simulator orchestration | Handles the Forward Generator and Composition Estimator panels: form collection, API calls, chart rendering, results tables |

---

## 2.17 JavaScript — Initialisation *(lines 7321–7370)*

| Lines | What | Purpose |
|-------|------|---------|
| 7322 | `window.addEventListener('load', …)` | Master initialiser. Calls `initializeFileUploadHandlers()`, `loadPlotDeposits()`, `renderDepositList()`, sets up WNR calculator inputs, smoothing window, and other final wiring. |

---
---

# 3. Data Flow Diagrams

## 3.1 Single-Channel Fit

```
User uploads CSV ──► parseCSVContent() ──► currentData
                                              │
User clicks "Fit" ──► fitData() ──────────────┘
                          │
              ┌───────────▼────────────┐
              │  Collect payload:      │
              │  time, intensity,      │
              │  emission, doping,     │
              │  weights, tolerances   │
              └───────────┬────────────┘
                          │ POST /fit
                          ▼
              ┌────────────────────────┐
              │  Flask: fit()          │
              │  ├── run_fitting()     │
              │  │   ├── DE + LS      │
              │  │   ├── adaptive     │
              │  │   │   retry loop   │
              │  │   └── tolerance    │
              │  │       check        │
              │  └── error codes +    │
              │      proposals        │
              └───────────┬────────────┘
                          │ JSON response
                          ▼
              ┌────────────────────────┐
              │  fitData() processes:  │
              │  ├── Plot result      │
              │  ├── Render metrics   │
              │  ├── Show tolerances  │
              │  └── Deposit run      │
              └────────────────────────┘
```

## 3.2 Multi-Channel Sequence

```
User uploads multi-channel folder
          │
          ▼
buildMultiChannelFitSequence()
    → ordered list: [775, 477, 645, 362, 452, 345]
          │
          ▼
    ┌─ FOR EACH emission ──────────────────────────────┐
    │                                                    │
    │  fitData({internalRun:true, emission, data})       │
    │       │                                            │
    │       ▼                                            │
    │  Quality check:                                    │
    │  ├── R² ≥ minR2?                                   │
    │  ├── isTimingMismatchSevere()?                      │
    │  └── hasErrorCode()?                               │
    │       │                                            │
    │       ├── PASS → depositCurrentRun() → next        │
    │       │                                            │
    │       └── FAIL → retry loop:                       │
    │           ├── scoreResult()                         │
    │           ├── buildRetryDirective()                 │
    │           ├── countdown (10s or 60s)                │
    │           ├── fitData({adjusted weights})           │
    │           ├── keep best result                      │
    │           └── repeat up to maxRetries               │
    │                                                    │
    └──────────────────────────────────────────────────┘
```

## 3.3 Weight Persistence Flow

```
UI input change ──► sendWeightsDebounced() (300ms)
                        │
                        ▼ POST /updateEmissionWeights
                    ┌────────────┐
                    │ Backend:   │
                    │ update     │
                    │ emission_  │
                    │ weights{}  │
                    │ + save to  │
                    │ disk (.json│)
                    └────────────┘
                        │
    On next fit: /fit handler reads emission_weights
    for used_weight fallback if UI hasn't sent explicit values
```

---

# 4. Shared Data Contracts

## 4.1 `/fit` Request Payload

```json
{
  "time": [0.0, 0.01, ...],
  "intensity": [0.0, 0.05, ...],
  "emission": "775",
  "pulse_us": 10,
  "doping_yb": 10.0,
  "doping_tm": 0.1,
  "fit_quality": "fast",
  "target_r2": 0.999,
  "max_adaptive_cycles": 4,
  "peak_window_boost": 1.27,
  "early_rise_boost": 1.3,
  "peak_tolerance": 0.01,
  "rise_tolerance": 0.01,
  "decay_tolerance": 0.01,
  "use_775_calibration": false,
  "optimize_all_points": false,
  "lit_params": null,
  "host_material": "NaYF4",
  "annealing_c": 500,
  "phonon_energy_cm": null,
  "host_mole_factor": 5.0,
  "fit_request_id": "fit-1234567890-abc"
}
```

## 4.2 `/fit` Response Payload

```json
{
  "success": true,
  "r2": 0.9987,
  "params": [5.0, 1.0, ...],
  "param_labels": ["Rp (ms⁻¹)", "Ay (ms⁻¹)", ...],
  "param_units": ["ms⁻¹", "ms⁻¹", ...],
  "time": [0.0, 0.01, ...],
  "fitted": [0.0, 0.05, ...],
  "timing_metrics": {
    "peak_time": 0.15,
    "rise_time": 0.08,
    "decay_time": 0.45,
    "half_life": 0.31,
    "peak_amplitude": 1.0,
    "area_under_curve": 0.42
  },
  "errors": ["Peak timing error 5.2%"],
  "error_codes": [
    {
      "code": "FIT-E41",
      "message": "Peak position mismatch",
      "severity": "warning",
      "proposal": {
        "action": "increase_peak_boost",
        "used_weight": 1.27,
        "emission": "775"
      }
    }
  ],
  "diagnostics": {
    "tolerance_achieved": {"peak": 0.052, "rise": 0.031, "decay": 0.018},
    "tolerance_targets": {"peak": 0.01, "rise": 0.01, "decay": 0.01},
    "peak_window_boost_used": 1.27,
    "early_rise_boost_used": 1.3,
    "adaptive_cycles_used": 3
  },
  "physics_output": { ... },
  "y0": [0.1, 0, 0.001, 0, 0, 0, 0, 0, 0, 0, 0]
}
```

## 4.3 Error Code Reference

| Code | Meaning | Proposal Action |
|------|---------|-----------------|
| FIT-E41 | Peak position mismatch | `increase_peak_boost` |
| FIT-E42 | Rise-time mismatch | `increase_early_boost` |
| FIT-E43 | Decay-time mismatch | `increase_early_boost` |
| FIT-E44 | Amplitude mismatch | — |
| FIT-E45 | Shape mismatch | — |
| FIT-E50 | General poor fit (R² < target) | — |

---

# 5. File & Directory Map

```
test4/
├── app.py                              # Flask backend (2 955 lines)
├── interactive_fitter copy.html        # Full frontend (7 371 lines)
├── emission_weights.json               # Persisted per-emission weights
├── README.md                           # Project README
├── README_CODEBOOK_LINE_BY_LINE.md     # This file
├── static/
│   └── plots/                          # Server-generated plot images
├── Images/                             # Reference images / docs
├── copy/                               # Manual backups
│   └── interactive_fitter copy.html    # Snapshot copy
└── Modelling/                          # Supplementary model files
```

---

*End of codebook.*
