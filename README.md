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

### Two-file monolith

| File | Lines | Role |
|------|-------|------|
| `app.py` | 2 955 | Flask backend — ODE solver, optimisation, all REST API routes |
| `interactive_fitter copy.html` | 7 371 | Full frontend — HTML + CSS + JavaScript (single page application) |

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

### Frontend Sections (interactive_fitter copy.html)

| Region | Lines | Content |
|--------|-------|---------|
| CSS | 7–846 | Full stylesheet (inline) |
| CDN Scripts | 847–849 | Plotly.js, MathJax 3, SheetJS |
| HTML Views | 851–2495 | Sidebar + 5 view panels |
| JS: Global Variables | 2500–3125 | State, constants, quality profiles |
| JS: Helpers | 3126–3397 | DOM helpers, multi-channel state |
| JS: Weights UI | 3399–3830 | Emission weight management |
| JS: Logging & Progress | 3831–3890 | Live fit log, progress polling |
| JS: Deposits | 3891–4205 | Run history with best-fit tracking |
| JS: File I/O | 4206–4459 | CSV/JSON parsing, file upload |
| JS: Plotting | 4460–4484 | Raw data charting |
| JS: Physics | 4485–5183 | Physics helpers, alternative flows |
| JS: Main Fitting | 5184–6385 | `fitData()` — 1 200-line orchestrator |
| JS: Export | 6386–6802 | CSV and XLSX export |
| JS: Utilities | 6803–6917 | Number formatting, colours |
| JS: Lifetime Generator | 6918–7320 | Forward simulation & estimator UI |
| JS: Initialisation | 7321–7370 | Boot sequence |

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
| 🔧 Mechanism Parameters | ETUC / single-Tm / DC / DS sub-panels |
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
├── interactive_fitter copy.html      # Frontend UI (HTML/CSS/JS)
├── emission_weights.json             # Persisted weight settings
├── README.md                         # This file
├── README_CODEBOOK_LINE_BY_LINE.md   # Detailed line-by-line codebook
├── static/plots/                     # Generated plot images
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
