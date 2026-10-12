# Engineering an Interactive Scientific Fitting Workbench: Architecture, Workflow, and Reproducibility in the TM Lifetime Analyzer

**Authors:** [Author names and contributions]  
**Affiliations:** [Institution(s)]  
**Corresponding author:** [Name and email]  
**Target venue:** [Software engineering / research software journal]  
**Manuscript status:** Engineering paper draft; empirical evaluation, references, and release metadata remain to be completed.

## Abstract

Scientific researchers often move between instrument-generated time-series data, domain-specific
kinetic models, numerical optimization scripts, and plotting or reporting tools. This separation
can make analysis difficult to reproduce, inspect, and communicate. We describe the design and
implementation of the TM Lifetime Analyzer, a browser-based workbench for exploring,
fitting, visualizing, and exporting photoluminescence lifetime traces in rare-earth-doped
materials. The application combines a JavaScript single-page interface with a Flask/Python
service, NumPy data handling, SciPy ODE integration and optimization, and interactive plotting.
Its principal engineering features are model-family dispatch across distinct physical workflows,
data-entry and per-file batch processing, progress and cancellation for long-running fits,
fit-result visualization and persistence, and export of fitted traces and diagnostics.

We describe the system boundaries, request lifecycle, model and fitting interfaces, user
workflows, and design trade-offs. We distinguish implemented behavior from scientific
interpretation: in particular, the downshifting Tm model and the Yb/Tm upconversion model are
separate computational paths, and the current co-doped downshifting path uses an effective
Yb-dependent loss rather than explicit excited-Yb population dynamics. We do not claim
performance, usability, accuracy, or generalizability from uncontrolled example fits. Instead,
we define a reproducible evaluation protocol covering numerical correctness, route isolation,
fit quality, parameter recovery, cancellation, usability, and runtime. The manuscript provides
an engineering account and a foundation for a future empirical software-quality study; it does
not substitute for validation of the underlying physical models.

**Keywords:** research software engineering; scientific web application; computational
photophysics; ODE fitting; interactive visualization; reproducibility; Flask; numerical optimization

## 1. Introduction

Time-resolved luminescence measurements produce transient signals whose interpretation may
require coupled population models, numerical integration, parameter estimation, and experimental
metadata. A typical research workflow can involve instrument software for acquisition, spreadsheets
for inspection, separate scripts for fitting, and manually assembled figures and tables. This
fragmentation increases the effort required to repeat an analysis and makes it harder to connect
an input file, its experimental assumptions, a model configuration, the fitted curve, and the
reported result.

The TM Lifetime Analyzer was developed as an interactive workbench for this class of analysis.
It presents file loading, model selection, parameter configuration, fitting, plotting, progress
feedback, and export through one browser interface, while numerical work is performed by a
Python service. Its domain includes multiple luminescence-flow families. In particular, the
application distinguishes a Yb/Tm energy-transfer upconversion (ETUC) model from a direct-excitation
Tm downshifting model. The models share application infrastructure but do not share the same
state equations or physical assumptions.

This paper focuses on software design and implementation rather than presenting the fitted
parameters as new photophysical findings. The engineering problem is how to make a long-running,
model-dependent scientific analysis inspectable and usable without silently conflating model
families, data inputs, or fit attempts. The application addresses this through client-side
workflow management, explicit server-side dispatch, numerical routines with structured
diagnostics, and persisted fit records.

The paper makes the following contributions:

1. It documents the architecture and data flow of an interactive scientific fitting application
   implemented with a browser client and a Flask/SciPy service.
2. It describes model-family dispatch and the distinct fitting paths for ETUC, alternate
   luminescence flows, and direct Tm downshifting.
3. It explains user-facing mechanisms for per-file batch analysis, progress reporting,
   cancellation, fit comparison, and export.
4. It identifies reproducibility, scientific validity, deployment, and software-quality
   questions that require systematic evaluation before strong claims can be made.

The intended audience is software engineering and research software engineering researchers,
scientific application developers, and users who need to assess how the workbench connects
measurements to computational results.

## 2. Context and design objectives

### 2.1 Application context

The analyzer is a scientific web application for time-dependent luminescence data. The browser
interface provides multiple views, including lifetime analysis, development fitting, simulation
and composition-estimation workflows, and help content. Users load time-intensity traces, select
an excitation and emission, specify composition and experimental settings, and request a fit.
The application returns a fitted trace and associated result data for visualization and export.

The current codebase is organized around a Flask application in `test.py`, a large client-side
JavaScript controller in `static/test.js`, and the user interface in `index.html` and
`static/style.css`. The frontend uses Plotly for charts, MathJax for equation rendering, and
SheetJS for workbook export through externally hosted browser libraries. Numerical processing
uses NumPy and SciPy. These are observations of the current implementation, not a claim that the
system has been independently evaluated for production deployment.

### 2.2 Design objectives

The implementation reflects the following objectives:

- **Keep the experiment-to-result workflow in one interface.** Users should be able to load,
  inspect, fit, compare, and export a trace without transferring it between unrelated tools.
- **Keep domain computation on the server.** ODE solving and optimization use Python numerical
  libraries, while the browser handles interaction, plotting, batch orchestration, and result
  presentation.
- **Separate physical model families.** A request's luminescence type, mechanism, and material
  model determine its route to the appropriate numerical workflow.
- **Make long computations observable and interruptible.** Progress messages and cancellation
  requests are associated with a fit request identifier.
- **Preserve analysis context.** Saved plot deposits retain the fitted arrays, R², diagnostics,
  parameter metadata, and a summary of input settings.
- **Support exploratory batch work.** Downshifting files may carry distinct per-file excitation,
  emission, pulse, composition, host, and annealing inputs.

These objectives describe intended behavior. Their adequacy should be tested through user studies,
reproducibility experiments, and numerical verification.

## 3. System architecture

### 3.1 Component view

The system uses a client-server architecture:

```text
Researcher
   |
   v
Browser interface (index.html, style.css, test.js)
   |  JSON requests; request identifier
   |  progress polling and cancellation
   v
Flask application (test.py)
   |-- request validation and model-family dispatch
   |-- ETUC fitting workflow
   |-- direct Tm downshifting workflow
   |-- alternate luminescence and simulation routes
   v
Numerical libraries (NumPy, SciPy integration and optimization)
   |
   v
Structured fit result: curve, R², parameters, diagnostics, timing data
   |
   +--> browser plots, fit history, CSV/Excel exports
```

The browser owns user interaction and session-level presentation state. The Flask process owns
numerical execution and a small amount of process-local state, including physics configuration,
emission weights, and fit progress/cancellation maps. Result deposits are persisted in browser
`localStorage`; they are therefore local to the browser profile rather than a server-side,
multi-user database.

### 3.2 Backend organization

`test.py` defines the Flask application, physical models, numerical utilities, fit routines, and
HTTP routes. The principal route families currently include:

| Route | Responsibility |
|---|---|
| `/` | Serve the analyzer's static HTML interface. |
| `/fit` | Dispatch a fitting request to ETUC, direct Tm downshifting, or an alternate optimization flow. |
| `/fit_progress` | Return progress state associated with a fit request identifier. |
| `/cancel_fit` | Set the cancellation flag for a specified request. |
| `/api/configure_physics` | Configure shared fit settings used by the main workflow. |
| `/simulate_luminescence_flow` | Run a forward luminescence-flow simulation. |
| `/fit_luminescence_flow` | Fit an alternate luminescence flow. |
| `/simulate_lifetime` | Simulate a lifetime trace. |
| `/estimate_composition` | Run composition estimation. |
| `/export_csv` | Return a simple CSV representation of supplied measured and fitted arrays. |
| `/updateEmissionWeights`, `/getEmissionWeights`, `/resetEmissionWeights` | Manage emission-specific weight configuration. |

This table is a route inventory, not an API stability guarantee. Payload schemas and error
semantics should be formalized and versioned before external clients depend on them.

### 3.3 Frontend organization

The browser interface is implemented primarily in `static/test.js`. It performs:

- view and ribbon navigation;
- file and multi-channel upload handling;
- selection and serialization of fit inputs;
- model-mode and emission UI updates;
- request submission, progress polling, and cancellation;
- live status logging;
- chart rendering and fit-history management;
- CSV and Excel export.

The downshifting batch workflow is implemented within the same JavaScript file. It maintains a
row model for each uploaded file, validates required inputs, writes one row's settings into the
shared fit controls, fits files sequentially, and associates deposited results with each source
file. The UI also provides controls for reviewing and deleting deposited plots. This design avoids
duplicating the main fitting endpoint for batch use, but it makes `test.js` a large controller
with substantial shared state. Componentization and explicit state ownership are appropriate
future engineering work.

### 3.4 Request and result lifecycle

A standard fit follows this sequence:

1. The user selects a file or batch row and configures the measurement and sample metadata.
2. The client normalizes its in-memory representation of the trace and builds a JSON payload.
   The payload includes time and intensity arrays, excitation and emission information, sample
   composition, pulse width, time unit, fit settings, and a unique fit request identifier.
3. The client sends the payload to `/fit`.
4. The backend registers the request, initializes progress state, and selects a model route from
   `luminescence_type`, `upconversion_mechanism`, and `material_model`.
5. The route validates/normalizes required values and runs the chosen solver and optimizer.
6. The backend returns a structured result, including fitted intensity and available diagnostics;
   progress information is updated while computation proceeds.
7. The client polls `/fit_progress`, updates the live log and busy state, and can request
   cancellation through `/cancel_fit`.
8. On completion, the UI renders the fit, computes/presents summary information, and deposits the
   result for later review and export.

The fit and progress endpoints use separate HTTP requests so the browser can remain responsive
while a fit is executing. The current progress and cancellation maps are in-memory and guarded
with thread locks. They are not durable across process restarts and are not shared between
multiple application workers. A multi-worker deployment would therefore need shared coordination
or a job queue to guarantee consistent polling and cancellation.

## 4. Scientific-computing workflows

### 4.1 Model-family dispatch

The `/fit` route separates three broad cases:

1. A single-doped Tm material model or a downshifting luminescence type is routed to the
   single-Tm downshifting fit routine.
2. Upconversion with the ETUC mechanism is routed to the Yb/Tm ETUC pipeline.
3. Other luminescence/mechanism combinations are routed to a separate luminescence optimization
   flow.

This separation is a key architectural boundary: common request handling and presentation do not
imply common physical equations. Regression tests should assert that representative requests from
each family reach the expected solver, and that downshifting-specific changes do not alter ETUC
results.

### 4.2 ETUC model

The ETUC implementation contains an 11-population state vector: two Yb³⁺ populations and nine
Tm³⁺ population slots, including a slot whose derivative is currently fixed to zero. The equations
include Yb pumping and decay, Yb-mediated transfer to Tm, Tm radiative and non-radiative
transitions, cross-relaxation, and an effective back-transfer term. During a fit, the backend
normalizes the measured intensity, maps the emission to a model state, selects active parameters,
and applies bounded numerical optimization. The precise model and parameter-role assumptions are
defined in `test.py`; the application should not be described as using a universal, fully
validated rare-earth model.

The ETUC path also supports sequential multi-channel/multi-folder fitting, fit-result transfer
between selected channels, retry directives, and visualization of deposited candidate fits.
These behaviors are implemented in the JavaScript controller and server-side ETUC fit routine.
Their effects on accuracy and analyst workload require dedicated evaluation.

### 4.3 Direct Tm downshifting model

The downshifting routine tracks seven Tm³⁺ manifolds and supports excitation-dependent entry
states, finite pulse excitation, optional ESA, selected radiative observables, and effective
Tm–Tm cross-relaxation. The separate single-Tm ODE manuscript documents its implemented equations
and assumptions. In co-doped downshifting, the current implementation adds a Yb-concentration-
dependent effective loss on selected Tm states; it does not evolve explicit excited-Yb populations.
This is distinct from the ETUC model.

The backend uses `solve_ivp` with LSODA for the segmented pulse-on/pulse-off integration. Fit
parameters include a subset selected for the requested excitation and emission, an observed-level
rate scale, pulse width, and time offset. The fitting routine uses differential evolution for
global exploration, least-squares refinement, adaptive residual weighting, a tail-weighted polish,
and a pulse-width rescue in specified conditions. A phenomenological slow-tail component may be
tested when ODE-only fit quality is inadequate; it is an observation-level extension, not another
tracked Tm state.

The downshifting implementation has several consequential assumptions:

- the entered pump is approximated by a rectangular pulse with effective excitation rate(s);
- initial population is assigned to the Tm ground state at the shifted time origin;
- a Gaussian response approximation is derived from pulse duration and sampling interval rather
  than a measured instrument-response function;
- time series are normalized and fitted as traces, so absolute emission yield is not identified;
- effective concentration terms do not automatically have independently validated microscopic
  units;
- the Yb-related term in this path is not an explicit Yb state model.

Consequently, fit quality is not proof of physical validity, and fitted parameters may be
non-identifiable from a single normalized channel.

### 4.4 Simulation and composition estimation

The application also exposes forward simulation and inverse composition-estimation workflows.
The backend defines forward simulation helpers for the main ODE and for simpler surrogate traces,
and routes simulation and composition estimation through dedicated endpoints. The frontend exposes
these capabilities through the Lifetime Generator interface and can use a prior fit to populate
subsequent inputs.

For a software engineering account, these features are described as workflows in the same
application rather than as independently validated scientific estimators. Claims about
composition-recovery accuracy require reference compositions, blinded test sets, uncertainty
calibration, and an explicit definition of the score and acceptance criteria.

## 5. User workflows and interaction design

### 5.1 Single-trace fitting

The single-trace workflow is designed to progress from file selection to fit inspection in a
linear sequence: load a trace, provide or review experimental settings, select model and emission,
configure fit preferences, start the fit, inspect the measured and predicted curves, review
diagnostics, and export results. The UI provides busy and loading states while the backend runs
and exposes cancellation rather than requiring a browser refresh.

### 5.2 Batch downshifting

The batch interface represents each file as a row with per-file time unit, excitation, emission,
pulse width, Tm concentration, host, anneal temperature, and optional Yb concentration. Values may
be inferred from filenames but remain editable. Validation occurs before fitting. Files are then
processed sequentially using the shared fit endpoint, with row status and live-log messages
indicating progress.

For an individual batch row, retries can vary optimizer seed and fit weights; the workflow retains
the best result according to R² and marks a deposited best-fit entry. This is an operational
selection rule, not a scientific acceptance test. A more complete decision rule should consider
measurement uncertainty, residual structure, timing constraints, parameter plausibility, and
model diagnostics in addition to R².

### 5.3 Multi-channel ETUC

The ETUC workflow organizes files into folders and emission slots, builds a sequence of channel
fits, records fit history, and can transfer selected parameter information between runs.
The sequence can be cancelled and reports retry activity. This supports comparison of channels
from a sample but also introduces dependencies on sequence order and carry-forward rules. Those
dependencies need to be made explicit in exported provenance and tested for order sensitivity.

### 5.4 Result history and export

Fit deposits store the source filename, timestamp, summary metadata, R², diagnostics, parameter
values, measured data, fitted data, and result markup in browser local storage. Users can revisit
deposited plots, select a deposit for download, or export collections to CSV/Excel. Storage
capacity, browser-profile locality, schema evolution, and possible loss when local storage is
cleared are limitations. The current export paths should be tested to ensure that the selected
best result and its actual per-file inputs are represented consistently.

## 6. Numerical and data-handling design

### 6.1 Trace normalization and preprocessing

In the fitting routes, the signal is shifted by its minimum and normalized against a high
percentile or another workflow-specific scale. Time values are converted into milliseconds for
the downshifting solver. Preprocessing choices influence fitted shape, especially for low-signal
tails and traces with nonzero background. The software should therefore preserve raw arrays and
record all preprocessing operations in result provenance. R² should be interpreted together with
residuals and fit diagnostics, not as a standalone physical validation measure.

### 6.2 Optimization

For direct Tm fitting, an initial multi-start global search is performed with differential
evolution, followed by bounded least-squares refinement. Parameter values are represented using
logarithmic coordinates when positive, while time offset and observation scaling use their own
parameterizations. The objective combines weighted residual terms, including a linear-scale
component, a log-domain component, and a peak-height penalty. The returned R² is computed on the
full trace after fitting.

Subsequent adaptive cycles use measured-versus-fitted residual structure to update region
weights. A tail polish may emphasize later points, and a pulse-width rescue may widen the pulse
search if the initial fit is very poor. A slow-tail component may be tried if the ODE-only fit
misses a quality criterion. Retry seeds and user-controlled retry counts are intended to explore
alternative starts; they do not guarantee convergence to a global optimum.

The implementation uses bounded parameters and multiple fit stages, but the current workflow
does not provide a general posterior distribution, confidence interval, profile likelihood, or
formal identifiability analysis. The best fit is therefore an optimizer-selected point estimate,
not a complete uncertainty analysis.

### 6.3 Progress and cancellation

The backend maintains per-request progress and cancellation state in dictionaries protected by
thread locks. Progress records contain a sequence number, status, message, update time, and
phase-specific fields. The browser polls for updates and sends cancellation requests using the
same request identifier. Numerical routines check the cancellation flag at computational
boundaries. This improves responsiveness but does not preempt an individual native-library call
instantaneously.

This process-local design fits a single-process interactive deployment. For horizontally scaled
deployment, a shared job store, task queue, durable cancellation mechanism, and expiration policy
for completed request records would be needed.

## 7. Implementation and deployment

The application is implemented in Python with Flask, NumPy, and SciPy; the frontend uses
HTML/CSS/JavaScript and browser libraries for plotting, mathematical typesetting, and spreadsheet
export. No frontend build system is required by the current source layout. Browser libraries are
loaded from CDNs, which creates an external availability and supply-chain dependency.

The current project layout includes a main server module, static interface assets, model
documentation, and manuscript drafts. The inspected project tree does not establish a packaged
release process, a versioned public API, or an automated continuous-integration test suite.
Deployment details (supported Python and browser versions, exact dependency pins, production WSGI
server, and configuration) must be added to the release documentation before reproducibility or
operational-readiness claims are made.

The server contains process-global configuration and progress state. It should be deployed as a
single-user or controlled research service unless access control, request isolation, and
multi-worker behavior are implemented and evaluated. No claims of multi-tenant security are made
in this paper.

## 8. Evaluation methodology

### 8.1 Current evidence

The present manuscript documents source-level behavior and architecture. It does not report a
controlled benchmark, formal usability study, external user study, validated reference dataset,
or statistically powered comparison. Example application logs and screenshots are useful
debugging artifacts, but they are not sufficient evidence of accuracy, speedup, reliability, or
generalizability. No numerical or usability results are claimed here.

### 8.2 Proposed research questions

A publication-ready evaluation should investigate at least the following questions:

- **RQ1 (Numerical correctness):** Does the implementation recover known parameters and expected
  traces on synthetic cases generated independently from the fit implementation?
- **RQ2 (Model-routing isolation):** Do request combinations consistently invoke the intended
  model family, and do changes in downshifting behavior leave ETUC regression outputs unchanged?
- **RQ3 (Workflow reliability):** How often do upload, fitting, cancellation, progress reporting,
  persistence, and export complete correctly across representative files and browsers?
- **RQ4 (Usability):** Can target researchers correctly configure experiments, interpret fit
  diagnostics, and retrieve the appropriate fitted result?
- **RQ5 (Computational performance):** How do runtime and memory scale with number of samples,
  trace length, number of channels, fit mode, and retry count?

### 8.3 Recommended experimental protocol

For RQ1, generate synthetic curves from an independently implemented forward solver with known
parameters. Add controlled noise, baseline offsets, sampling changes, and pulse-response
variation. Split cases into parameter-recovery, model-mismatch, and edge-condition sets. Report
parameter error, trace residual metrics, solver failures, runtime, and uncertainty coverage.
Avoid testing a fitter only on traces generated by the same code path, since that can conceal
shared implementation errors.

For RQ2, add route-level tests that exercise each model-family dispatch combination. Capture
golden regression outputs for the ETUC reference set before modifying adjacent paths. Verify
that invalid and unsupported combinations produce explicit errors and do not silently fall back
to another model.

For RQ3, test file formats and malformed inputs, progress sequence monotonicity, cancellation
latency, repeated request identifiers, browser reload behavior, local-storage limits, and
consistency between on-screen results and exports. Test single-file and multi-file batches,
including per-file inputs that differ.

For RQ4, conduct a task-based study with domain researchers. Tasks should include selecting an
excitation/emission pair, entering sample composition and pulse information, detecting an
unsupported configuration, comparing fits, exporting the selected best fit, and explaining what
R² and model assumptions do and do not establish. Record task completion, error rates, time,
help requests, and a validated usability instrument where appropriate.

For RQ5, benchmark a pinned environment on a declared hardware platform. Vary trace length,
optimizer mode, sample count, number of channels, and retries; report median and dispersion over
repeated runs. Include numerical-library versions, thread configuration, data sizes, and
termination criteria. Do not combine machine-dependent times into a single unqualified
performance claim.

### 8.4 Reporting and data availability

The final paper should include the exact source revision, environment lockfile, test commands,
input data license and access route, synthetic data-generation code, benchmark scripts, machine
specification, and analysis notebooks or scripts. Experimental files may contain sensitive or
unpublished data; publication should use permission-cleared, anonymized data or independently
generated synthetic cases.

## 9. Discussion

### 9.1 Engineering contribution

The main contribution is integration: a browser-accessible workflow brings data selection,
domain-specific model selection, numerical fitting, progress feedback, visualization, result
history, and export into one interactive system. The architecture separates browser orchestration
from numerical execution while keeping a common request-response contract. This enables a
researcher to inspect a fit in the context of its source file and experimental settings.

The integration also creates engineering risks. A large client controller coordinates many
views and fitting modes, and several workflows share mutable interface and backend state.
Process-local progress maps and browser-local persistence constrain deployment. The absence of a
formal plugin or model registry makes adding new scientific mechanisms dependent on explicit
dispatch and frontend wiring. These are meaningful topics for future refactoring and evaluation,
not evidence that the architecture is already extensible at scale.

### 9.2 Scientific software is not validated by interface quality

An interactive UI can improve access and transparency but cannot validate an ODE, parameter
prior, physical unit, or mechanism. In this project, a high R² can coexist with non-identifiable
parameters or an incorrect model structure. Likewise, automated retries choose among candidate
fits using implemented criteria; they do not establish that the selected result is physically
correct. Scientific validation requires independent experiments, uncertainty estimates,
calibration checks, and explicit model criticism.

### 9.3 Threats to validity

- **Construct validity:** R² alone does not measure parameter truth, physical plausibility, or
  interpretability. A usability survey alone would not establish scientific correctness.
- **Internal validity:** synthetic-data tests can be circular if generator and fitter share
  equations or preprocessing. Reference values and forward solvers should be independently
  implemented.
- **External validity:** behavior on one host, instrument, excitation regime, or concentration
  range may not generalize to other materials or acquisition systems.
- **Conclusion validity:** fit stochasticity, limited sample counts, parameter correlation, and
  multiple retry strategies can bias observed results. Repeated runs and uncertainty reporting
  are needed.
- **Operational validity:** local storage, CDN libraries, process-local progress state, and
  development-server assumptions may behave differently in production deployments.
- **Documentation validity:** some interface copy and earlier drafts can describe broader
  scientific behavior than the backend actually implements. The release must treat executable
  code and verified tests as authoritative and reconcile documentation to that behavior.

## 10. Future work

Priority engineering improvements include:

1. Extract model implementations, API schemas, and UI workflows into smaller, testable modules.
2. Add automated unit, integration, browser, and regression tests, including explicit ETUC
   non-interference checks.
3. Add dependency pinning, a reproducible environment setup, continuous integration, and tagged
   releases.
4. Version the API and validate payload shapes, numerical bounds, array lengths, and units.
5. Introduce a job queue and shared progress store if multi-user or multi-worker deployment is
   required.
6. Store result provenance in a versioned schema with export/import support rather than relying
   exclusively on browser local storage.
7. Support measured instrument-response functions, explicit baseline/noise models, and
   uncertainty-aware objectives where justified by experimental evidence.
8. Evaluate identifiability and uncertainty using profile likelihood, bootstrap, or Bayesian
   methods appropriate to the scientific question.
9. Develop validated Yb/Tm downshifting dynamics only where independent evidence supports
   explicit Yb excitation and transfer pathways.
10. Conduct a task-based evaluation with target researchers and publish an independently
    reproducible benchmark suite.

## 11. Conclusion

The TM Lifetime Analyzer is an interactive scientific workbench that connects time-resolved
luminescence files to domain-specific fitting, live progress, plots, saved result records, and
export. Its software architecture combines a JavaScript browser client with a Flask/Python
numerical service and distinct computational routes for ETUC, downshifting, and alternate
luminescence workflows. Per-file batch processing and fit-history inspection address practical
research tasks, while progress tracking and cancellation make long numerical operations more
observable.

This manuscript records the implemented software design and its limitations. It does not assert
that the scientific models are universally valid, that the selected fits identify unique
physical parameters, or that the application has demonstrated a performance or usability
advantage. Those claims require a controlled evaluation with independent reference cases,
validated datasets, reproducible environments, and target-user studies. The resulting software
artifact is best understood as an evolving research workbench whose engineering and scientific
quality should be assessed separately and transparently.

## Declarations and submission checklist

- **Data availability:** [Specify public, restricted, or synthetic data and repository/DOI.]
- **Code availability:** [Specify public repository URL, release tag, and archival DOI.]
- **Software license:** [Add license and confirm third-party library terms.]
- **Funding:** [Funding statement.]
- **Competing interests:** [Declaration.]
- **Author contributions:** [Use the target journal's taxonomy.]
- **Ethics:** [State whether user study or human-subject approval is required.]
- **Acknowledgements:** [Contributors and facilities.]

Before submission, the authors should:

- reconcile the older scientific manuscript's model descriptions with the actual routes and
  equations;
- verify every feature claim against a tagged release;
- replace all bracketed placeholders;
- add peer-reviewed references for research software engineering, reproducibility, scientific
  visualization, and the relevant fitting methodology;
- conduct and report the evaluation described in Section 8;
- publish a replication package and a stable software release.

## References

**To be completed.** Add verified primary literature and methodological references. Do not cite
unverified numerical results or use placeholder references in a submitted manuscript.
