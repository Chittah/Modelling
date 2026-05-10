# TM Lifetime Analyzer

**Advanced Multilevel ODE Fitting for Yb³⁺/Tm³⁺ Upconversion Photoluminescence Dynamics**

A PhD-level research tool that fits experimental photoluminescence lifetime decay curves to an 11-state coupled ODE model of the Yb³⁺ → Tm³⁺ energy-transfer upconversion (ETUC) system. Built for materials-science researchers working with rare-earth doped phosphors.

---

## Features

- **11-state ODE physics engine** — full Yb³⁺/Tm³⁺ energy-level model with 20 kinetic parameters
- **8 emission channels**: 1800, 1230, 775, 477, 645, 452, 362, 345 nm
- **Multi-channel batch fitting** — fit all emissions in sequence with automatic 775 nm calibration
- **Adaptive quality loop** — automatic retry with weight escalation and tolerance checking
- **Per-emission quality profiles** — tuned error limits, scoring weights, and retry strategies
- **Forward simulation** — predict lifetime curves from composition + physics inputs
- **Composition estimation** — rank Yb/Tm % combinations by timing similarity to a target
- **Host-lattice & annealing corrections** — phonon-energy-dependent scaling of kinetic rates
- **Interactive Plotly charts** — zoomable, exportable decay-curve visualisations
- **CSV & Excel export** — rich metadata headers, multi-sheet XLSX for all deposited runs
- **Persistent emission weights** — per-emission peak/early/tolerance settings saved to disk

---

## Quick Start

### Prerequisites

- Python 3.8+
- pip

### Installation

```bash
# Clone or copy the project folder
cd test4

# Install dependencies
pip install flask numpy scipy pandas
```

### Running

```bash
python app.py
```

The server starts at **http://localhost:5050**. Open in a browser to access the full UI.

---

## Architecture

### Three-file separated architecture

| File | Lines | Role |
|------|-------|------|
| `app.py` | ~2 955 | Flask backend — ODE solver, optimisation, all REST API routes |
| `interactive_fitter copy.html` | ~1 690 | HTML template — structure and layout only |
| `static/css/style.css` | ~840 | All CSS styles (extracted from original monolith) |
| `static/js/app.js` | ~5 100 | All JavaScript — UI logic, ODE databases, charting, fitting orchestration |

The backend serves the HTML file and provides a JSON API. The frontend handles all user interaction, chart rendering, file parsing, multi-channel orchestration, and result management.

### Backend Sections (app.py)

| Section | Lines | Purpose |
|---------|-------|---------|
| 1 — App Setup & Global State | 1–40 | Flask init, `physics_state` config, thread locks |
| 2 — Fit Cancel & Progress | 41–119 | Per-request cancellation and progress tracking |
| 3 — Physics Engine (UCOdeModel) | 120–149 | 11-state ODE system: `dy/dt = f(y, params)` |
| 4 — Metric & Analysis Utilities | 150–265 | Timing feature extraction, parameter-role classification |
| 5 — Kinetic Constants & Simulation | 266–633 | Default params, host corrections, forward simulation, single-Tm model |
| 6 — Main Fitting Engine | 634–1467 | `run_fitting()` — DE + LS optimisation with adaptive retry |
| 7 — Route Payload Helpers | 1468–1531 | Payload parsing, emission weight persistence |
| 8 — Luminescence Flow Solvers | 1532–1722 | Simulation and fitting orchestrators |
| 9 — Flask Routes | 1723–2949 | 13 REST endpoints |
| 10 — Entry Point | 2950–2955 | `app.run()` |

### Frontend Sections (static/js/app.js)

The JavaScript is organized into 23 numbered sections with a Table of Contents at the top:

| Section | Content |
|---------|---------|
| 1 — TOC | Section index |
| 2 — Global Variables | State, constants, quality profiles, **ODE databases** |
| 2d — ODE Databases | ETUC (Yb/Tm co-doped), **Single-Doped Tm** (785/1210/690 nm), ESA, PA, EMMUC, CUSC, DC |
| 3 — DOM Helpers | `safeGetElement`, `safeSetText`, upload state |
| 4 — API Helper | `apiPost()` — centralised fetch wrapper |
| 5–7 — Weights UI | Emission weight management |
| 8–9 — Logging & Progress | Live fit log, progress polling |
| 10–12 — Deposits | Run history with best-fit tracking |
| 13–14 — File I/O | CSV/JSON parsing, file upload |
| 15 — Plotting | Raw data charting |
| 16–17 — Luminescence Flow | Mechanism selection, sub-panel display, **ODE rendering** |
| 18–20 — Main Fitting | `fitData()` orchestrator |
| 21 — Export | CSV and XLSX export |
| 22 — Utilities | Number formatting, colours |
| 23 — Lifetime Generator | Forward simulation & composition estimator UI |
| 24 — Init | Boot sequence |

---

## User Interface

### Sidebar Navigation

| View | Purpose |
|------|---------|
| 🏠 **Home** | Project overview, quick-start guide, emission reference |
| 🔬 **Lifetime Analyzer** | Main workspace — upload data, configure, fit, review results |
| 🧪 **Development Fitting** | Per-emission weight tuning and comparison |
| 📊 **Lifetime Generator** | Forward ODE simulation and composition estimation |
| ❓ **Help** | Troubleshooting, error code reference, physics model docs |

### Analyzer Ribbon Tabs

| Tab | Controls |
|-----|----------|
| 📄 Data File | Upload mode (single / multi-channel / folder), file input, slot grid |
| ⚗️ Sample Composition | Yb %, Tm %, host material, annealing, phonon energy |
| ⚛️ Physics Parameters | All 20 kinetic rate constants |
| ⚙️ Advanced Settings | Fit quality, target R², max cycles, boost weights, calibration toggles |
| 🔧 Mechanism Parameters | ESA / PA / EMMUC / CUSC / DC / Single-doped Tm sub-panels with inline ODE equations |
| ▶ Run Settings | Batch run configuration |

---

## Physics Model

### ODE State Vector (11 elements)

$$\vec{y} = [Yb_g,\ Yb_e,\ Tm_0,\ Tm_1,\ Tm_2,\ Tm_3,\ Tm_4,\ Tm_5,\ Tm_6,\ Tm_7,\ Tm_8]$$

### Energy Levels & Emissions

| State | Ion | Manifold | Emission |
|-------|-----|----------|----------|
| Yb_g | Yb³⁺ | ²F₇/₂ | — |
| Yb_e | Yb³⁺ | ²F₅/₂ | 980 nm |
| Tm0 | Tm³⁺ | ³H₆ | ground |
| Tm1 | Tm³⁺ | ³F₄ | 1800 nm |
| Tm2 | Tm³⁺ | ³H₅ | 1230 nm |
| Tm3 | Tm³⁺ | ³F₂,₃ | — (NR) |
| Tm4 | Tm³⁺ | ³F₂ | — (inactive) |
| Tm5 | Tm³⁺ | ³H₄ | **775 nm** |
| Tm6 | Tm³⁺ | ¹G₄ | **477 nm**, **645 nm** |
| Tm7 | Tm³⁺ | ¹D₂ | **362 nm**, **452 nm** |
| Tm8 | Tm³⁺ | ³P₂/¹I₆ | **345 nm** |

### 20 Kinetic Parameters

| # | Symbol | Physical meaning |
|---|--------|-----------------|
| 0 | Rp | Pump rate (ms⁻¹) |
| 1 | Ay | Yb spontaneous decay rate |
| 2 | W1 | ET1: Yb → Tm (³H₆ → ³H₅) |
| 3 | W2 | ET2: Yb → Tm (³F₄ → ³H₄) |
| 4 | W3 | ET3: Yb → Tm (³H₄ → ¹G₄) |
| 5 | W4 | ET4: Yb → Tm (¹G₄ → ¹D₂) |
| 6 | W5 | ET5: Yb → Tm (¹D₂ → ³P) |
| 7 | k21 | Tm ³H₅ → ³F₄ non-radiative |
| 8 | k35 | Tm ³F₂ → ³H₄ phonon relaxation |
| 9 | A10 | 1800 nm radiative (Tm1 → Tm0) |
| 10 | A50 | 775 nm radiative (Tm5 → Tm0) |
| 11 | A60 | 477 nm radiative (Tm6 → Tm0) |
| 12 | A61 | 645 nm radiative (Tm6 → Tm1) |
| 13 | A70 | 362 nm radiative (Tm7 → Tm0) |
| 14 | A71 | 452 nm radiative (Tm7 → Tm1) |
| 15 | A80 | UV radiative (Tm8 → Tm0) |
| 16 | A81 | 345 nm radiative (Tm8 → Tm1) |
| 17 | Wcr | Cross-relaxation rate |
| 18 | Wb | Back energy transfer ³H₄ → Yb |
| 19 | T_offset | Time offset (ms) |

### Optimisation Strategy

1. **Differential Evolution** (global search) — SciPy's `differential_evolution` with configurable `maxiter` and `popsize`
2. **Trust-Region Reflective** (local polish) — `least_squares(method='trf')` refinement
3. **Adaptive retry** — up to N cycles with weight escalation and tolerance tightening
4. **Per-emission parameter selection** — only params directly affecting the target emission are optimised; feeder-chain params are unlocked for downstream emissions (477, 645)

---

## Luminescence Mechanism Selection

The app supports multiple upconversion and luminescence mechanisms beyond the primary ETUC system.

### Material Model Selector

| Model | Description |
|-------|-------------|
| **Co-doped Yb/Tm** | Full 11-state ODE system with Yb³⁺ sensitizer |
| **Single-doped Tm** | Tm³⁺ absorbs directly — no Yb sensitizer |

### Upconversion Mechanisms

| Mechanism | Key | Hallmark |
|-----------|-----|----------|
| Energy Transfer UC (ETUC) | `etuc` | Standard Yb→Tm energy transfer |
| Excited State Absorption (ESA) | `esa` | Sequential two-photon absorption by same ion; I ∝ Φ¹ |
| Photon Avalanche (PA) | `photon_avalanche` | CR looping with sharp pump threshold; I ∝ Φⁿ (n >> 2) |
| Energy Migration Mediated (EMMUC) | `energy_migration_mediated` | Core–shell energy hopping architecture |
| Cooperative Sensitization (CUSC) | `cooperative` | Two Yb simultaneously transfer to one activator; I ∝ P² |

### Additional Modes

| Mode | Description |
|------|-------------|
| **Downconversion** | Quantum cutting — one UV photon → two+ NIR photons (QY ≥ 100%) |
| **Downshifting** | Stokes-shifted emission from single-doped system |

### Single-Doped Tm³⁺ Physics

Unlike co-doped ETUC, single-doped Tm³⁺ absorbs pump photons directly via ground-state absorption (GSA). Upconversion occurs through:

- **ESA** — sequential absorption of a second photon from an excited state
- **Cross-relaxation (CR)** — energy redistribution between neighbouring Tm³⁺ ions: ³H₄ + ³H₄ → ³F₄ + ³H₆

Three excitation wavelengths are supported, each accessing different energy pathways:

| Pump λ | Transition | ESA Target | Visible Emissions |
|--------|-----------|------------|-------------------|
| 785 nm | ³H₆ → ³H₄ | ³H₄ → ¹G₄ | 477 nm (¹G₄→³H₆), 645 nm (¹G₄→³F₄) |
| 1210 nm | ³H₆ → ³H₅ | ³H₅ → ³F₂,₃ then ³H₄ → ¹G₄ | 477 nm, 645 nm (via 3-photon ladder) |
| 690 nm | ³H₆ → ³F₂,₃ → ³H₄ | ³H₄ → ¹D₂ | 362 nm (¹D₂→³H₆), 452 nm (¹D₂→³F₄) |

The ODE equations for each excitation scheme are displayed in the UI when the single-doped Tm panel is active.

> **Note:** The single-doped Tm ODE solver in `app.py` needs to be updated to handle the new physics-based parameters (`sigma_gsa`, `sigma_esa`, `w_cr`, `pump_power_mw`, `tm_conc_mol`, `excitation_nm`). The current frontend sends these fields; backend implementation is pending.

---

## API Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Serve the frontend |
| `/fit` | POST | Run ODE fitting on uploaded data |
| `/fit_progress` | GET | Poll fitting progress |
| `/cancel_fit` | POST | Cancel a running fit |
| `/api/configure_physics` | POST | Update global physics config |
| `/simulate_luminescence_flow` | POST | Run forward simulation |
| `/fit_luminescence_flow` | POST | Fit via luminescence flow |
| `/simulate_lifetime` | POST | Multi-purpose simulation endpoint |
| `/estimate_composition` | POST | Composition estimation |
| `/updateEmissionWeights` | POST | Save per-emission weights |
| `/getEmissionWeights` | GET | Retrieve saved weights |
| `/resetEmissionWeights` | POST | Reset all weights to defaults |
| `/export_csv` | POST | Generate CSV download |

---

## Error Codes

| Code | Description | Auto-proposal |
|------|-------------|---------------|
| FIT-E41 | Peak position mismatch | Increase peak window boost |
| FIT-E42 | Rise-time mismatch | Increase early rise boost |
| FIT-E43 | Decay-time mismatch | Increase early rise boost |
| FIT-E44 | Amplitude mismatch | — |
| FIT-E45 | Shape mismatch | — |
| FIT-E50 | General poor fit (R² below target) | — |

When errors relate to **doping concentration, host material, or annealing temperature**, the retry countdown extends from 10 s to 60 s to allow the user to review and adjust sample parameters.

---

## File Structure

```
test4/
├── app.py                            # Backend server (Python/Flask)
├── interactive_fitter copy.html      # Frontend UI (HTML template only)
├── static/
│   ├── css/
│   │   └── style.css                 # All CSS styles
│   ├── js/
│   │   └── app.js                    # All JavaScript logic + ODE databases
│   └── plots/                        # Generated plot images
├── emission_weights.json             # Persisted weight settings
├── README.md                         # This file
├── README_CODEBOOK_LINE_BY_LINE.md   # Detailed line-by-line codebook
├── Images/                           # Reference images
├── copy/                             # Manual backups
└── Modelling/                        # Supplementary model files
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| Flask | ≥ 2.0 | Web server and routing |
| NumPy | ≥ 1.20 | Array operations |
| SciPy | ≥ 1.7 | `solve_ivp`, `differential_evolution`, `least_squares` |
| Pandas | ≥ 1.3 | CSV export formatting |

Frontend CDN dependencies (loaded in-browser):
- **Plotly.js** — interactive charts
- **MathJax 3** — equation rendering
- **SheetJS (xlsx)** — Excel export

---

## Licence

Research software — see institutional guidelines for distribution terms.
