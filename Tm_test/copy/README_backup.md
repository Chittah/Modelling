# Troubleshooting, Remedies, and Improvement Suggestions

## Fitting Quality and Decay Time Difference Logic

The fitting pipeline applies strict criteria for fit acceptance:

- **Target R² threshold**: Fit must reach the required R² value for acceptance.
- **Decay time difference**: If the absolute difference between fitted and measured decay tau (1/e) is greater than 0.1, the fit is rejected and improvement suggestions are provided.

### Troubleshooting Workflow

1. **Fit fails R² or decay time difference criteria**:
    - The log and summary will indicate the dominant error region (early, peak, tail).
    - Improvement suggestions are generated based on the error region:
        - *Early*: Tune pulse width, baseline, or enable early-rise enhancement.
        - *Peak*: Enhance apex weighting or check detector saturation.
        - *Tail*: Re-check baseline correction and long-time SNR.
    - For decay time difference >0.1, suggestions focus on timing alignment and baseline stability.
2. **Remedies are shown in the log and summary**:
    - These are now documented here instead of the UI.
    - For each emission, review the remedy list and apply recommended actions before retrying the fit.

### Example Improvement Suggestions

- "Decay tau difference >0.1: Check baseline, pulse width, and timing alignment."
- "Peak mismatch: Enhance apex weighting or check detector saturation."
- "Early-rise mismatch: Tune pulse width and enable early-rise enhancement."
- "Tail mismatch: Re-check baseline correction and long-time SNR."

See the [Dominant error regions and remedies](#dominant-error-regions-and-remedies) section above for detailed troubleshooting codes and recommendations.

---

**Note:** The UI no longer displays troubleshooting info, remedies, or improvement suggestions. Refer to this README for guidance.
# TM Lifetime Analyzer - Code Walkthrough README
## Proxy fitting for missing channel files


If a mandatory channel (e.g., 362 nm) does not have a file or folder, the fitting workflow uses a proxy approach: it fits the available channel (e.g., 477 nm) and attempts to generate a fit for the missing channel using the available data as a proxy. This is indicated by log messages such as "proxy 477→362".

- In proxy fitting, <b>experimental</b> refers to the measured data from the proxy channel (e.g., 477 nm), not the missing channel. All timing metrics, intensity, and error calculations are based on this proxy data.
- The proxy fit uses the best available data to estimate parameters for the missing channel. Fit quality and troubleshooting will reflect that a proxy was used, and recommendations may be shown for improving proxy accuracy.
- If the proxy fit does not meet solved criteria, retries and fallback logic are applied as usual, but the result is limited by the proxy data. Manual review is recommended for proxy fits.


This README is designed for viva/interview prep. It copies real code sections from your current project and explains:
- what each section does,
- how it works internally,
- and how it connects to other sections.

---

## 1) System architecture (high level)

- Frontend file: `interactive_fitter copy.html`
  - Handles UI, data preprocessing, sending fit requests, cancellation, plotting, and plot depository.
- Backend file: `app.py`
  - Runs ODE model and optimization, serves API routes, and handles cancellation cooperatively.

Data flow:
1. User loads data in frontend.
2. Frontend preprocesses and sends JSON payload to `/fit`.
3. Backend `/fit` calls `run_fitting(...)`.
4. `run_fitting(...)` evaluates ODE + optimization and returns fit arrays + diagnostics.
5. Frontend renders chart/results and stores run in plot depository.
6. If user clicks cancel, frontend calls `/cancel_fit` and aborts active request.

### Flowchart Diagram

```mermaid
flowchart TD
    A[User opens analyzer] --> B[Upload file or folder]
    B --> C[processMultipleFiles]
    C --> D[rawData loaded + plotRawData]

    D --> E[Apply Physics Settings]
    E --> F[POST /api/configure_physics]
    F --> G[fitDataButton enabled]

    G --> H[Click FIT DATA]
    H --> I[fitData creates currentFitRequestId]
    I --> J[Preprocess intensity<br/>baseline/smooth/normalize]
    J --> K[Build payload with fit_request_id]
    K --> L[POST /fit]

    L --> M[Backend fit route registers fit_request_id]
    M --> N[run_fitting starts]
    N --> O[differential_evolution + least_squares]
    O --> P{is_fit_cancelled?}

    P -- No --> Q[Compute fitted_intensity + diagnostics]
    Q --> R[Return JSON results]
    R --> S[Frontend plots fit on fitChart]
    S --> T[Render resultsContainer]
    T --> U[depositCurrentRun]
    U --> V[plotDeposits list updated and numbered]
    V --> W[openDepositedPlot on click]

    P -- Yes --> X[Raise FitCancelled]
    X --> Y[/fit returns cancelled: true]
    Y --> Z[Frontend shows cancelled state]

    H --> C1[Click CANCEL FIT]
    C1 --> C2[AbortController.abort]
    C1 --> C3[POST /cancel_fit]
    C3 --> C4[cancel_fit_request sets flag]
    C4 --> P
```

---

## 2) Python backend: cancellation state manager

Copied from `app.py`:

```python
fit_cancel_flags = {}
fit_cancel_lock = threading.Lock()


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
```

What it does:
- Tracks cancellation state per fitting job ID.
- Ensures thread-safe read/write using `fit_cancel_lock`.

How it connects:
- `fit()` route calls `register_fit_request(...)` when request starts.
- `cancel_fit()` route sets cancellation via `cancel_fit_request(...)`.
- `run_fitting(...)` checks `is_fit_cancelled(...)` through `cancel_checker`.
- `fit()` finally calls `clear_fit_request(...)` to avoid stale IDs.

---

## 3) Python backend: ODE physics core

Copied from `app.py`:

```python
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
```

What it does:
- Defines the coupled differential equations for all 11 populations.
- Converts physical parameters into time derivatives consumed by SciPy ODE solver.

How it connects:
- Used inside `run_fitting(...)` via `solve_ivp(UCOdeModel.system, ...)`.
- The simulated populations are then transformed into observable intensity in `simulate(...)`.

---

## 4) Python backend: optimization with cancellation hooks

Copied from `app.py`:

```python
def run_fitting(time_ms, intensity, pulse_us, state_idx, doping_yb, doping_tm, fit_quality="fast", optimize_all_points=False, lit_params=None, use_775_calibration=False, emission_key=None, cancel_checker=None):
    p_ms_nominal = max(float(pulse_us) / 1000.0, 1e-6)
    y0 = [doping_yb/100, 0, doping_tm/100, 0, 0, 0, 0, 0, 0, 0, 0] #initial conditions set from doping conc

    def check_cancel():
        if callable(cancel_checker) and cancel_checker():
            raise FitCancelled("Fit cancelled by user")

    check_cancel()
```

```python
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
```

```python
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
```

What it does:
- Runs global + local optimization of ODE parameters.
- Calls `check_cancel()` in objective/residual path to stop long runs.
- Uses DE callback to stop at generation boundary too.

How it connects:
- `fit()` supplies `cancel_checker = lambda: is_fit_cancelled(fit_request_id)`.
- If cancellation is requested, `FitCancelled` propagates to `fit()` route and returns `{"cancelled": true}`.

---

## 5) Python backend: fit route and cancel route

---

## Timing metrics note: why rise time is 10-90%

The analyzer reports rise time as 10-90% of the peak rather than 0-100%.

Why:
- 0% is not stable in real data because the baseline is affected by noise, drift, smoothing, and time-zero uncertainty.
- 100% is also unstable because the exact apex can move with sampling resolution, detector saturation, or a single noisy point.
- 10-90% isolates the main rising edge and gives a more repeatable timing metric for comparing measured and fitted traces.

In the code, this is computed in `compute_trace_metrics(...)` by locating the first time the measured or fitted trace crosses 10% of peak and 90% of peak, then taking the difference.

### Decay tau note: what `1/e` means

The analyzer also reports decay tau as `tau (1/e)`.

This does **not** mean `e` is being fitted as a separate parameter.
Instead, `1/e` is used as a numerical threshold for reporting a decay time constant:

- `e` is Euler's number, about `2.71828`
- `1/e` is about `0.3679`
- the reported decay tau is the time where the trace falls to about `36.8%` of its peak value

So this metric is extracted **after** fitting, as a summary of the decay speed.
The optimizer itself still fits the full curve by minimizing residual error over all points.

### Peak time error note: what it means

The analyzer also reports `Peak Time Error`.

This is the absolute difference between:
- the time where the measured trace reaches its maximum
- the time where the fitted trace reaches its maximum

So it is computed as:

- `Peak Time Error = | peak_time_fitted - peak_time_measured |`

This is a timing-alignment metric. A smaller value means the fit reaches its apex at nearly the same time as the experiment.

Unlike `Decay tau (1/e)`, this is not a threshold-based decay metric. It is a direct peak-location comparison.

---

## Dominant error regions and remedies

The troubleshooting block returned by fitting reports a dominant error region (`early`, `peak`, or `tail`).

Recommended remedies:
- `peak`: Use single-channel peak enhancement (apex emphasis), then re-run and confirm improved overlap near the apex.
- `early`: Use single-channel early-rise enhancement (pulse/start alignment emphasis), then re-run and check rise-time/peak-time alignment.
- `tail`: Re-check baseline correction and long-time SNR before adding more optimizer complexity.

Troubleshooting error codes:
- `FIT-E00`: Target R² not reached (overall quality gap).
- `FIT-E11` (legacy `FIT-E01`): Early-rise dominant mismatch. First tune pulse width and `T_offset`; enable early-rise enhancement only if mismatch remains.
- `FIT-E12` (legacy `FIT-E02`): Peak-window dominant mismatch. Tune apex weighting or check detector saturation around peak.
- `FIT-E13` (legacy `FIT-E03`): Tail dominant mismatch. Re-check baseline correction and long-time SNR.
- `FIT-E21` (legacy `FIT-E04`): R² may look acceptable, but rise/peak/decay timing is still poorly aligned. Prefer the result with lower timing errors, especially for `345` and `362` nm.
- `FIT-E31`: Host/annealing influence likely dominates mismatch. Revisit host mole factor, lattice phonon energy, and annealing assumptions before over-tuning kinetics.

Workflow recommendation:
- Apply these remedies in single-channel mode first.
- Once the problematic channel is stable, run multi-channel sequence again for transfer consistency.

Automation update:
- Multi-channel sequence now applies automatic error-code-driven retries (`FIT-E11`, `FIT-E12`, `FIT-E13`, `FIT-E21`) with legacy (`FIT-E01`, `FIT-E02`, `FIT-E03`, `FIT-E04`) compatibility, using per-emission quality profiles for all main channels, tightening timing and amplitude acceptance as well as retry strength. This includes stronger 775 early-rise recovery and stricter 345/362 timing repair, reducing the need for manual single-channel pre-fitting in most runs.

---

## Non-radiative parameter modes (updated UI)

The NR panel now uses one phonon-energy source for both physics and NR inputs:
- Main editable source: `Phonon Energy (cm⁻¹) Override`
- Backend-bound value: hidden field `phononEnergy_NR`

This removes duplicate manual entry and keeps the NR value synchronized automatically.

### NR mode dropdown

`nrMode` now supports four options:
- `fit` (recommended first): minimal NR tuning for a stable first pass.
- `theoretical`: shows multiphonon controls (`C`, `alpha`) and uses host/override phonon model.
- `anchor`: shows measured lifetime anchor inputs (primary `τexp`, optional feeding `τexp`, feeding `τrad`) and enables anchor-based NR behavior.
- `manual`: exposes all NR inputs at once (both theoretical + anchor groups) for expert, full custom tuning.

Recommended order of use:
1. `fit`
2. `theoretical`
3. `anchor`
4. `manual`

Implementation notes:
- `updateNrModeUi()` controls which input groups are visible by mode.
- Anchor logic is enabled when `nrMode` is `anchor` or `manual` and `expTau3H4 > 0`.

Copied from `app.py`:

```python
@app.route("/fit", methods=["POST"])
def fit():
    fit_request_id = None
    try:
        t0 = time.perf_counter()
        payload = request.get_json() or {}
        fit_request_id = str(payload.get("fit_request_id", "")).strip() or None
        register_fit_request(fit_request_id)
```

```python
        lit_params = payload.get("lit_params", {})
        cancel_checker = (lambda: is_fit_cancelled(fit_request_id)) if fit_request_id else None

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
            cancel_checker=cancel_checker,
        )
```

```python
    except FitCancelled:
        return jsonify({
            "cancelled": True,
            "fit_request_id": fit_request_id,
        }), 200
    except Exception:
        return jsonify({"error": traceback.format_exc()}), 500
    finally:
        clear_fit_request(fit_request_id)
```

```python
@app.route("/cancel_fit", methods=["POST"])
def cancel_fit():
    payload = request.get_json() or {}
    fit_request_id = str(payload.get("fit_request_id", "")).strip()
    if not fit_request_id:
        return jsonify({"error": "Missing fit_request_id"}), 400

    cancel_fit_request(fit_request_id)
    return jsonify({"ok": True, "fit_request_id": fit_request_id})
```

What it does:
- `/fit` starts fit, maps payload to model inputs, and returns fit outputs/diagnostics.
- `/cancel_fit` marks active fit as cancelled.

How it connects:
- Frontend `fitData()` sends `fit_request_id` to `/fit`.
- Frontend `cancelFitting()` sends same `fit_request_id` to `/cancel_fit`.

---

## 6) HTML/JS frontend: shared fit state

Copied from `interactive_fitter copy.html`:

```javascript
let rawData = null;
let processedData = null;
let fittingResults = null;
let lastFitDataForExport = null;
let multipleDatasets = [];
let currentFitIndex = 0;
let selectedCation = null;
let selectedAnion = null;
let lastCalculatedPhonon = 350;
let currentFitAbortController = null;
let currentFitRequestId = null;
let plotDeposits = [];
let activeDepositIndex = -1;
```

What it does:
- Stores loaded data, current fit request, cancellation controller, and deposited plots.

How it connects:
- `fitData()` updates `currentFitAbortController/currentFitRequestId`.
- `cancelFitting()` reads and resets same variables.
- `depositCurrentRun()` pushes into `plotDeposits`.

---

## 7) HTML/JS frontend: fit request ID and depository title

Copied from `interactive_fitter copy.html`:

```javascript
function createFitRequestId() {
    return `fit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
```

```javascript
function buildRunTitle(fileName, payload, fitRes) {
    const r2 = typeof fitRes?.r2 === 'number' ? fitRes.r2.toFixed(5) : 'N/A';
    const host = payload?.host || 'NA';
    const em = payload?.emission || 'NA';
    const yb = Number(payload?.doping_yb || 0).toFixed(2);
    const tm = Number(payload?.doping_tm || 0).toFixed(3);
    const mode = payload?.fit_quality || 'fast';
    const pulse = Number(payload?.pulse_width_us || 0).toFixed(1);
    return `${fileName} | em:${em}nm | R2:${r2} | Yb:${yb}% Tm:${tm}% | Host:${host} | Mode:${mode} | Pulse:${pulse}us`;
}
```

What it does:
- Generates unique request IDs and rich plot titles with configuration + fit result context.

How it connects:
- ID is sent in payload to backend.
- Title is used on main plot and deposited plots.

---

## 8) HTML/JS frontend: plot depository open/store functions

Copied from `interactive_fitter copy.html`:

```javascript
window.openDepositedPlot = function(index) {
    const item = plotDeposits[index];
    if (!item) return;

    activeDepositIndex = index;
    renderDepositList();

    const meta = safeGetElement('plotDepotMeta');
    const resBox = safeGetElement('plotDepotResults');

    if (meta) {
        meta.textContent = `${index + 1}. ${item.title || item.fileName}`;
    }

    const trace1 = {
        x: item.time || [],
        y: item.measured || [],
        mode: 'lines',
        name: 'Experimental',
        line: { color: '#60a5fa' }
    };
    const trace2 = {
        x: item.time || [],
        y: item.fitted || [],
        mode: 'lines',
        name: 'Fit',
        line: { color: '#f97316' }
    };

    Plotly.newPlot('plotDepotChart', [trace1, trace2], {
        title: item.title || 'Deposited Fit',
        xaxis: { title: 'Time' },
        yaxis: { title: 'Intensity' },
        margin: { l: 60, r: 20, t: 60, b: 50 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(15,23,42,0.55)',
        font: { color: '#cbd5e1' }
    }, { responsive: true });

    if (resBox) {
        resBox.innerHTML = item.resultsHtml || 'No stored results summary for this run.';
    }
};
```

```javascript
function depositCurrentRun(fileName, payload, fitRes, time, measured, fitted, resultsHtml) {
    const entry = {
        fileName: fileName || 'Unknown file',
        createdAt: new Date().toISOString(),
        createdAtLabel: new Date().toLocaleString(),
        title: buildRunTitle(fileName || 'Unknown file', payload, fitRes),
        payloadSummary: {
            emission: payload?.emission,
            host: payload?.host,
            doping_yb: payload?.doping_yb,
            doping_tm: payload?.doping_tm,
            fit_quality: payload?.fit_quality,
            pulse_width_us: payload?.pulse_width_us
        },
        r2: fitRes?.r2,
        diagnostics: fitRes?.diagnostics || {},
        time,
        measured,
        fitted,
        resultsHtml
    };

    plotDeposits.push(entry);
    savePlotDeposits();
    activeDepositIndex = plotDeposits.length - 1;
    renderDepositList();
    window.openDepositedPlot(activeDepositIndex);
}
```

What it does:
- Stores each completed run in order.
- Lets user click a deposited file entry to restore graph + stored result panel.

How it connects:
- Called from end of `fitData()` after successful backend response.

---

## 9) HTML/JS frontend: cancel action

Copied from `interactive_fitter copy.html`:

```javascript
window.cancelFitting = async function() {
    if (!currentFitRequestId) {
        showStatus('warning', 'No fitting job is currently active.');
        return;
    }

    const reqId = currentFitRequestId;
    showStatus('warning', `Cancelling fit ${reqId} ...`);

    if (currentFitAbortController) {
        currentFitAbortController.abort();
    }

    try {
        await fetch('/cancel_fit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fit_request_id: reqId })
        });
    } catch (err) {
        console.warn('Cancel request could not be confirmed:', err);
    }

    const loading = safeGetElement('loadingIndicator');
    if (loading) loading.style.display = 'none';

    currentFitRequestId = null;
    currentFitAbortController = null;
    setFitUiBusy(false);

    const resContainer = safeGetElement('resultsContainer');
    if (resContainer) {
        resContainer.innerHTML = '<p style="color: #92400e; text-align: center;">Fit cancelled by user.</p>';
    }

    showStatus('warning', 'Fit cancelled. No new fit results were deposited.');
};
```

What it does:
- Cancels in two ways:
  1. local fetch abort using AbortController,
  2. backend cooperative cancellation via `/cancel_fit`.

How it connects:
- Uses same `currentFitRequestId` created in `fitData()`.
- Backend checks this ID during optimization loop.

---

## 10) HTML/JS frontend: main fit function (request -> response -> plotting -> deposit)

Copied from `interactive_fitter copy.html` (critical lines):

```javascript
window.fitData = async function() {
    const fitBtn = safeGetElement('fitDataButton');
    if (!fitBtn || fitBtn.disabled) {
        showStatus('error', '✗ Please configure settings first');
        return;
    }

    if (!rawData) {
        showStatus('error', '✗ Please load data first');
        return;
    }

    const loading = safeGetElement('loadingIndicator');
    if (loading) loading.style.display = 'block';

    setFitUiBusy(true);
    currentFitAbortController = new AbortController();
    currentFitRequestId = createFitRequestId();
```

```javascript
    const payload = {
        fit_request_id: currentFitRequestId,
        time,
        intensity,
        ...fitConfig,
        doping_yb: parseFloat(safeGetElement('dopingYbInput')?.value || '10'),
        doping_tm: parseFloat(safeGetElement('dopingTmInput')?.value || '0.5'),
        host: safeGetElement('hostSelect')?.value || 'NaYF4',
        anneal_temp: parseFloat(safeGetElement('annealSelect')?.value || '500'),
        emission: selectedEmission,
        use_775_calibration: use775Calibration,
        time_unit: safeGetElement('timeUnit')?.value || 'ms',
        pulse_width_us: parseFloat(safeGetElement('pulseWidthUs')?.value || '400'),
```

```javascript
    const response = await fetch('/fit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: currentFitAbortController.signal,
    });
```

```javascript
    fittingResults = await response.json();
    if (fittingResults.cancelled) {
        showStatus('warning', 'Fit was cancelled before completion.');
        safeGetElement('resultsContainer').innerHTML = '<p style="color: #92400e; text-align: center;">Fit cancelled by user.</p>';
        return;
    }
```

```javascript
    const fileName = safeGetElement('analyzerCurrentFile')?.textContent || 'Unknown file';
    depositCurrentRun(
        fileName,
        payload,
        fittingResults,
        time,
        intensity,
        fittingResults.fitted_intensity,
        safeGetElement('resultsContainer')?.innerHTML || ''
    );
```

What it does:
- Validates state, preprocesses data, creates job ID, sends fit request.
- Handles cancellation response and errors.
- Renders results and deposits run in ordered history.

How it connects:
- Reads UI controls from all ribbon tabs.
- Sends payload to Python `/fit`.
- Uses `depositCurrentRun(...)` and `buildRunTitle(...)` to persist run context.

---

## 11) Cross-file connection map (important for interview answers)

- Frontend `createFitRequestId()` -> payload `fit_request_id` -> backend `register_fit_request()`.
- Frontend `cancelFitting()` -> POST `/cancel_fit` -> backend `cancel_fit_request()`.
- Backend `run_fitting()` repeatedly calls `check_cancel()` -> raises `FitCancelled`.
- Backend `/fit` catches `FitCancelled` and returns `{cancelled: true}`.
- Frontend `fitData()` handles `{cancelled: true}` and avoids depositing incomplete result.
- On success, frontend `depositCurrentRun()` stores full trace + result HTML and displays it via `openDepositedPlot()`.

---

## 12) Suggested oral answers you can use

- Why do we use both AbortController and backend cancel API?
  - AbortController stops browser waiting and UI updates immediately.
  - Backend cancel flag stops CPU-heavy SciPy optimization safely.

- Why use `fit_request_id`?
  - To uniquely identify each running fit so cancellation targets the correct job.

- Why depository stores `resultsHtml` and arrays?
  - Arrays recreate plot exactly.
  - `resultsHtml` preserves detailed diagnostics panel for that run.

- Why classify active/fixed params in backend?
  - Improves identifiability and fit stability by optimizing only direct emission-relevant parameters.

---

## 13) Common Error: Small Apex Mismatch (477/645) and How to Handle It

Symptom:
- The fit tracks most of the decay tail but misses the very top of the peak (apex).

Typical causes:
1. Smoothing slightly blunts the measured apex.
2. Time alignment (`T_offset`) is close but not exact at the first few points.
3. Shared Tm6 dynamics (especially for 477/645) limit independent apex control.

### Practical test #2 (single-run validation): fit once with smoothing OFF

Do this in the UI:
1. Go to Data tab.
2. Uncheck `Smooth`.
3. Keep all other settings the same (same file, same emission, same mode).
4. Run fit again.
5. Compare new peak overlap with previous deposited run in Plots Depository.

Interpretation:
- If apex improves noticeably with smoothing OFF:
    - root cause is preprocessing blur, not core ODE structure.
    - Keep smoothing OFF for that dataset (or use smaller window).
- If apex does not improve:
    - issue is likely model/identifiability around early-time dynamics.
    - keep smoothing as originally set and tune peak-local residuals.

### Recommended handling workflow

1. Keep a baseline deposited run.
2. Run the smoothing-OFF test.
3. If improved, use that preprocessing for publication fit.
4. If not improved, apply emission-specific peak-local weighting (as currently done for 645).
5. Re-check that tail quality remains stable after peak tuning.

### How this links to current code

- Frontend smoothing toggle participates in preprocessing in `fitData()` before payload creation.
- Backend peak-local corrections are applied in `run_fitting(...)` via `peak_window_residual_terms(...)`.
- Run-to-run comparison is done in Plots Depository using `depositCurrentRun(...)` and `openDepositedPlot(...)`.

---

## 14) Other Previously Handled Errors and Remedies

### Error A: SciPy callback signature mismatch in DE

Observed error:

```text
TypeError: run_fitting.<locals>.de_cancel_callback() got an unexpected keyword argument 'convergence'
```

Cause:
- Some SciPy versions call DE callback as `callback(x, convergence=...)`.
- A positional-only callback fails.

Remedy applied:
- Updated callback signature in backend to accept keyword argument:

```python
def de_cancel_callback(_xk, convergence=None):
    return bool(callable(cancel_checker) and cancel_checker())
```

Why this works:
- It is compatible across SciPy callback call styles.

---

### Error B: `Configure Physics first` when fitting

Observed behavior:
- Backend `/fit` returns error if physics not configured.

Cause:
- `physics_state["configured"]` is false until `/api/configure_physics` is called.

Remedy:
1. Fill required fields.
2. Click `CONFIGURE` first.
3. Then click `FIT DATA`.

Code link:
- `fit()` route checks configured state before running optimization.

---

### Error C: Cancel pressed but no active job

Observed behavior:
- UI shows warning: no active fit.

Cause:
- `currentFitRequestId` is null (no running request).

Remedy:
- Start fit first, then cancel during loading.
- Current logic already handles this gracefully and prevents crashes.

---

### Error D: Missing `fit_request_id` on cancel endpoint

Observed behavior:
- `/cancel_fit` responds with:

```json
{"error": "Missing fit_request_id"}
```

Cause:
- Cancel request did not include job ID.

Remedy:
- Frontend always sends `fit_request_id: currentFitRequestId`.
- Keep this wiring unchanged when refactoring `fitData()` / `cancelFitting()`.

---

### Error E: WSL copy path failure

Observed error:

```text
cp: cannot stat '/home/.../test4': No such file or directory
```

Cause:
- Folder was under Windows-mounted path, not Linux home.

Remedy used:

```bash
cp -r /mnt/c/Users/sgakuru/cernbox/WINDOWS/Desktop/PHD_project/test4 .
```

Why this works:
- Uses absolute WSL path to the real folder location.

---

### Error F: Apex mismatch despite good tail

Observed behavior:
- Fit matches decay but misses peak top for 477/645.

Cause:
- Early-time identifiability and preprocessing blur; shared Tm6 dynamics constrain independent shape control.

Remedy applied:
1. Run smoothing-OFF validation test.
2. Added peak-local residual terms in backend.
3. Added stronger 645-specific peak-local weighting while preserving 477 baseline behavior.

---

If you want, I can also generate a second README section with interview-style Q&A for each function, e.g., "What is input/output complexity?", "Failure modes?", and "How to debug quickly?"
