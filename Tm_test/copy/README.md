# Tm³⁺ / Yb³⁺ Downshifting – Model Guide

## Backend layout

`app.py` remains the compatibility entry point and can be run with `python app.py`. The Flask
application is implemented in `backend/`, split by responsibility: `core.py` owns the shared app
and fit state, `models.py` contains the Yb-sensitized co-doped ODE and analysis helpers,
`single_tm.py` contains the direct-Tm excitation model and fitter (with optional Yb co-doping),
`fitting.py` contains the co-doped ODE optimizer,
`flows.py` contains the separated luminescence-flow solvers, and `routes.py` registers the Flask
endpoints.

For a publication-style description of the implemented direct-Tm rate equations, all
parameter definitions, fitting conventions, and model limitations, see
[README_single_doped_Tm_ODE.md](README_single_doped_Tm_ODE.md).

For a broader literature review, methodology chapter, discussion of Euler/RK4/Radau/LSODA, and
guided study curriculum, see
[MODELLING_REVIEW_METHODOLOGY_AND_CURRICULUM.md](MODELLING_REVIEW_METHODOLOGY_AND_CURRICULUM.md).

## Using Downshifting (direct Tm excitation, with or without Yb)

1. Choose **Downshifting**. Direct-Tm excitation supports Yb-free and Yb/Tm co-doped samples;
   Yb-sensitized ETUC is a separate model.
2. Click **Add files** and select any number of CSV files. Each file gets its own row with its own
   time unit, excitation, emission, pulse width (µs), whether the pulse width may be optimized, Tm %, host,
   anneal temperature, and optional Yb % for direct-Tm fits (required for co-doped ETUC).
   Values are auto-guessed from the file name (`Ex260`, `Em346`, `Tm0_1`, `Yb10`, `YF3`, `500C`).
   Time-unit and pulse-width defaults are ns and 400 µs. Pulse-width optimization is off by default so a verified
   instrument pulse remains fixed; enable it only when the pulse duration is uncertain.
3. **Copy row 1 inputs to all** is available for files that share the same settings.
4. **FIT ALL FILES** fits the rows one by one; each row shows its R².

### Excitation
Available: 260, 356, 466, 690, 785, 1210 nm, or **Other…**. A value within ±10 nm of a line snaps to the
closest one (the lines are ≥ 90 nm apart, so this is unambiguous and covers lamp/monochromator bandwidth).
Beyond ±10 nm the file is rejected rather than guessed.

### Allowed emissions
| Excitation | Emission |
|---|---|
| 260 nm | 346 nm only |
| 356 nm | 454 nm, 775 nm |
| 466 nm | 645 nm only |
| 690 / 785 / 1210 nm | 454, 645, 775 nm (as supported by the model) |

The explicitly constrained direct-Tm fit pairs are 260/346, 356/454, 356/775, and 466/645 nm;
the backend checks each against its corresponding emitting state and observation rate. Yb is
optional in this direct-excitation model. A positive Yb concentration activates the effective
Tm-to-Yb loss from ³H₄ and ¹G₄, not Yb-sensitized pumping or explicit Yb population dynamics.

## Energy-level transfer simulation

Choose an emission wavelength in the diagram and select **Run transfer** to animate the selected
ETUC or single-doped Tm route directly on the energy-level diagram. For ETUC, representative Yb
ions begin in ²F₇/₂; their displayed number and marker size scale with the entered Yb concentration.
Each transfer excites a Yb donor, shows its dipole–dipole interaction with Tm, and returns the donor
to its ground state. Tm relaxation is animated separately while Yb remains at ground. When enabled
by Yb concentration, the ³H₄ back-transfer branch is shown before the selected emission, alongside
the surviving Tm path.
Animated ions use separate ground- and excited-state colors. Above the modeled Tm concentration
gates, the Wcr,H4 and Wcr,G4 competing branches show their excited and ground-state Tm partners;
the Wb branch distinguishes the depleted Tm ion from the Yb ion excited by back-transfer. The
selected radiative transition brightens while its emission step runs.

The higher-energy ETUC channels follow the ODE state assignments: 477 nm emits from ¹G₄ after W₃
promotes ³H₄; 362 nm emits from ¹D₂ after W₄ promotes ¹G₄; 345 nm emits from ¹I₆ after W₅ promotes
¹D₂.

Both diagrams now use a vertical cm⁻¹ scale and show W₁–W₅ in the Yb section. Tm level positions
are representative rounded YF₃:Tm³⁺ reference energies, not energies calculated by the ODE. The
³H₆, ³F₄, ³H₅, ³H₄, ³F₂,₃, and ¹G₄ reference values follow the measured crystal-field multiplet
energies reported by Savinkov et al. ([2017 paper](https://cyberleninka.ru/article/n/spectral-and-magnetic-properties-of-impurity-tm3-ions-in-yf3));
¹D₂, ¹I₆, and ³P₂ are approximate reference positions because that study does not report those
multiplets. The Yb³⁺ ²F₅/₂ line is placed at approximately 10,200 cm⁻¹ above ²F₇/₂. Values vary
with host and Stark sublevel.

ETUC playback starts from ³H₆ for 775 nm, from residual ³H₄ for 477/645 nm, from ¹G₄ for
362/452 nm, and from ¹D₂ for 345 nm. It animates only the remaining transfer steps from that
starting population. Direct-Tm excitation continues to start from ³H₆ and shows its pump/ESA
sequence. Ion movement remains 2 seconds and each pathway step remains 3 seconds.

The animation follows the states and reaction sequence in the active ODE, but is not a numerical
ODE population simulation. In particular, marker-size changes are qualitative and do not encode a
rate-derived population fraction. Competing cross-relaxation reactions and their concentration gates
remain identified in the diagram. Approximate pump-photon counts for measured ETUC channels are
inferred internally from the power-law data and the entered Tm concentration; the fitted slopes and
uncertainties are not displayed. Reachable single-Tm pathways outside the fitter's allowed
excitation/emission combinations are identified as illustrative only.

## Standalone motion screen

Open [`motion/index.html`](./motion/index.html) for a separate full-screen motion viewer. It
supports both Yb/Tm co-doped ETUC routes and direct Tm excitation, optionally with Yb co-doping.
The direct-Tm animation includes pump excitation, ESA, cascade relaxation, Tm cross-relaxation,
and the effective Tm-to-Yb loss from ³H₄/¹G₄ used by the fitter when Yb is present. That loss does
not model explicit Yb excitation or relaxation kinetics. The viewer has independent model,
excitation, emission, and concentration controls and does not require fitting data. The interactive
fitter also has its own route animation.

## Single-doped Tm ODE

The level scheme and rates below describe the direct-Tm model. Its seven Tm states are used
whether Yb is absent or present; optional Yb adds an effective loss term, not explicit Yb states.
Yb-sensitized ETUC uses a separate 11-state ODE system.

Levels: ³H₆ (0), ³F₄ (1), ³H₄ (2), ¹G₄ (3), ¹D₂ (4), ¹I₆ (5), ³P₂ (6).
Each population n_i obeys `dn_i/dt = feed_i − (radiative + non-radiative decay)_i + cross-relaxation + pump`.

- **Cascade (multiphonon, W) and radiative (A):** ³P₂/¹I₆ → ¹D₂ → ¹G₄ → ³H₄ → ³F₄ → ³H₆, with branching
  to the ground and intermediate levels using A-rates.
- **Pump entry level** (excitation pulse, rate `G`, switched off after the pulse width):
  - 260 nm → ³P₂ (feeds ¹I₆)
  - 356 nm → ¹D₂
  - 466 nm → ¹G₄
  - 690 nm → ³H₄, then excited-state absorption (`G2`) to ¹D₂
  - 785 / 1210 nm → ³H₄, then ESA (`G2`) to ¹G₄
- **Cross-relaxation (`Kcr · Tm%`):**
  - ³H₄ + ³H₆ → ³F₄ + ³F₄
  - ¹D₂ + ³H₆ → ¹G₄ + ³F₄
- **Observables:** 346 nm ∝ ¹I₆·A₇₁; 454 nm ∝ ¹D₂·A₆₁; 645 nm ∝ ¹G₄·A₅₁; 775 nm ∝ ³H₄·A₃₀.
- **Fitted parameters:** `G` (pump), `G2` (ESA), `T_offset`.

## Yb/Tm co-doped 775 nm pathways

The 775 nm cascade is sequential: `W1` feeds Tm2 (³H₅), `k21` transfers Tm2 to Tm1
(³F₄), `W2` feeds Tm3 (³F₂,₃), and `k35` relaxes Tm3 into Tm5 (³H₄), whose
radiative decay `A50` produces the 775 nm emission. In particular, Tm5 is fed by
`k35 · Tm3`, not directly by `W2 · Yb_e · Tm1`.
The energy-level diagram places ³F₂,₃ (Tm3) above ³H₄ (Tm5), consistent with this downward
non-radiative relaxation.

The co-doped model activates pathways from the entered dopant concentrations:

- ¹G₄ + ³H₆ → ³H₄ + ³F₄ cross-relaxation (`WcrG4`) when Tm > 0.1 mol%.
- ³H₄ + ³H₆ → 2×³F₄ cross-relaxation (`WcrH4`) when Tm > 1.0 mol%.
- ³H₄ → Yb back-transfer (`Wb`) when Yb > 10 mol%.

The equations shown for 775 nm include only the concentration-active terms. Multi-channel fitting
uses uploaded, supported emission traces only; it does not synthesize missing channels from proxy data.
ODE-parameter exports include only parameters present in that run's active ODE.

### Do the ODEs change between single and co-doped, at 260 nm or any other excitation?
Direct-Tm excitation uses the same seven-state Tm ODE at any Yb concentration; Yb > 0 adds
effective Tm-to-Yb loss from ³H₄ and ¹G₄. Yb-sensitized ETUC uses a separate 11-state ODE.
The co-doped 775 nm concentration gates do not alter either direct-Tm or ETUC fitting logic.

## Why the ODE panel lists so many decay pathways (even with one emission)

**Short answer:** the full ODE set describes the whole Tm³⁺ system physically, but a single measured emission
only depends on a few of those equations. The panel shows only the relevant ones and collapses the rest.

### 1. Why the full cascade exists
An excitation populates one entry level, and that population then relaxes downward through every lower level
(multiphonon steps `W` and radiative branching `A`). Writing the complete model means one equation per level so
that population is conserved. For 260 nm the chain is ³P₂ → ¹I₆ → ¹D₂ → ¹G₄ → ³H₄ → ³F₄ → ³H₆.
Each model uses its own equation set.

### 2. Why 260 nm looks like it has "a lot" of paths with a single 346 nm emission
- 260 nm excites ³P₂, which relaxes very fast (W₈₇ is the largest rate) into ¹I₆. ¹I₆ is the 346 nm emitter.
- ¹I₆ loses population through radiative decay to ³H₆ (A₇₀) and to ³F₄ (A₇₁), and multiphonon decay to ¹D₂ (W₇₆).
  These are the "many paths" that act directly on the 346 nm trace.
- ¹D₂, ¹G₄, ³H₄ and ³F₄ are only *filled by* ¹I₆ (slowly, via W₇₆). They never feed population back into ¹I₆,
  so they cannot change the 346 nm decay. They are listed to complete the physical picture.

### 3. What actually shapes each measured trace
A trace depends only on the levels from the excitation entry level down to the emitting level:

| Excitation | Emission | Equations that matter |
|---|---|---|
| 260 nm | 346 nm | ³P₂, ¹I₆ |
| 356 nm | 454 nm | ¹D₂ |
| 356 nm | 775 nm | ¹D₂, ¹G₄, ³H₄ |
| 466 nm | 645 nm | ¹G₄ |

### 4. What is actually fitted
The fit does not vary every rate independently. The emitting-level decay channels are lumped into a single observed
decay scale, and only a handful of parameters are free: the pump rate `G` (and `G2` for stepwise pumping),
the feeder rates along the path, `Kcr` (only for Tm ≥ 0.3 %), `Kyb` (only if Yb > 0), and `T_offset`.
Pulse width is fixed to the entered value by default in batch mode; if optimization is enabled for that row,
it is fitted within ±30 % of the entered value and a wider rescue search may run when the fit is very poor.
That is roughly 4–6 fitted parameters, not one per pathway shown, plus pulse width when enabled.

### 5. Where the extra pathways can matter
- Cross-relaxation (`Kcr · Tm%`) at higher Tm concentration shortens ³H₄ and ¹D₂ and so changes the 775 / 454 nm traces.
- In direct-Tm mode, Yb co-doping (`Kyb · Yb%`) adds effective loss on ³H₄ and ¹G₄ only,
  so it does not alter the 346 nm (¹I₆) trace.

### 6. Why fits can still miss, and the slow-tail component
Rate cascades decay (nearly) exponentially. A slow low-level tail in a measured trace (host or defect afterglow,
energy migration to traps, gating/LPF baseline artefacts) has no ODE path that can produce it, so a pure-ODE fit
tracks the fast part and misses the tail. When the ODE-only R² is below 0.995, the fitter therefore also tries
"ODE trace + a·exp(−(t−t_peak)/τ_slow)" and keeps it only if the squared error drops by at least 15 %.
The accepted τ_slow and amplitude are reported in the fit diagnostics (`slow_tail_component`).

### 7. UI note
In downshifting mode the single-Tm model panel sits in **Advanced Settings** (the Mechanism tab is hidden), shows the
pathways relevant to the selected file's emission, and keeps the others under
"Other levels in the cascade (do not affect this fit)".

## Level labels and rate constants (A₆₀, A₆₃, W₈₇ …)

Subscripts are level indices: **0** = ³H₆ (ground), **1** = ³F₄, **3** = ³H₄, **5** = ¹G₄, **6** = ¹D₂,
**7** = ¹I₆, **8** = ³P₂. `A_ij` is the radiative rate i → j (emits a photon); `W_ij` is the
non-radiative (multiphonon) rate i → j. The matching populations are Tm8, Tm7, Tm6, Tm5, Tm3, Tm1, Tm0.

| Rate | Process | Emission / role | Prior (s⁻¹) |
|---|---|---|---|
| A₁₀ | ³F₄ → ³H₆ | ~1800 nm | 0.12 |
| A₃₀ | ³H₄ → ³H₆ | 775–800 nm | 0.35 |
| A₃₁ | ³H₄ → ³F₄ | ~1450 nm | 0.25 |
| A₅₀ | ¹G₄ → ³H₆ | ~477 nm | 0.6 |
| A₅₁ | ¹G₄ → ³F₄ | **645 nm** | 0.5 |
| A₅₃ | ¹G₄ → ³H₄ | ~1200 nm | 0.05 |
| A₆₀ | ¹D₂ → ³H₆ | ~362 nm | 1.0 |
| A₆₁ | ¹D₂ → ³F₄ | **454 nm** | 3.0 |
| A₆₃ | ¹D₂ → ³H₄ | ~740 nm | 0.3 |
| A₇₀ | ¹I₆ → ³H₆ | ~290 nm | 3.0 |
| A₇₁ | ¹I₆ → ³F₄ | **346 nm** | 4.0 |
| W₈₇ | ³P₂ → ¹I₆ (multiphonon) | fast feed into ¹I₆ | 500 |
| W₇₆ | ¹I₆ → ¹D₂ (multiphonon) | ¹I₆ loss / ¹D₂ feed | 1.0 |
| W₆₅ | ¹D₂ → ¹G₄ (multiphonon) | ¹D₂ loss / ¹G₄ feed | 0.5 |
| Kcr | cross-relaxation × Tm % | active for Tm ≥ 0.3 % | 2.0 |
| Kyb | Effective Tm → Yb loss × Yb % | direct-Tm model when Yb > 0 | 0.5 |

The values are starting priors (editable in the model panel); the fit adjusts only the ones that influence the
selected emission.

## Transfer processes for each excitation

Legend: `══►` pump, `──►` multiphonon (W), `~~►` radiative (A, photon out), `┄┄►` ESA (second pump photon),
`✕` cross-relaxation.

### 260 nm (³H₆ → ³P₂) — measured: 346 nm
```
 ³P₂ (8) ◄══ 260 nm pump
   │ W87 (very fast)
   ▼
 ¹I₆ (7) ~~A71~~► ³F₄   346 nm  ← measured
   │   ~~A70~~► ³H₆     (~290 nm)
   │ W76 (slow)
   ▼
 ¹D₂ (6) ~A61~► ³F₄ (454 nm) ; A60 → ³H₆ ; A63 → ³H₄
   │ W65
   ▼
 ¹G₄ (5) ~A51~► ³F₄ (645 nm) ; A50 → ³H₆ ; A53 → ³H₄
   ▼
 ³H₄ (3) → A30 (³H₆) / A31 (³F₄) → ³F₄ (1) → A10 → ³H₆ (0)
```
Only ³P₂ and ¹I₆ shape the 346 nm trace. Lower levels are filled from ¹I₆ and cannot feed it back.

### 356 nm (³H₆ → ¹D₂) — measured: 454 or 775 nm
```
 ¹D₂ (6) ◄══ 356 nm pump
   ├~~A61~~► ³F₄   454 nm  ← measured
   ├~~A60~~► ³H₆
   ├~~A63~~► ³H₄  (feeds the 775 nm emitter)
   │ W65
   ▼
 ¹G₄ (5) ~A51/A50/A53~►  →  ³H₄ (3) ~~A30~~► ³H₆  775 nm ← measured
 ¹D₂ + ³H₆ ✕ ¹G₄ + ³F₄   (Kcr, high Tm)
```
454 nm depends on ¹D₂ only; 775 nm depends on ¹D₂ → ¹G₄ → ³H₄.

### 466 nm (³H₆ → ¹G₄) — measured: 645 nm
```
 ¹G₄ (5) ◄══ 466 nm pump
   ├~~A51~~► ³F₄   645 nm  ← measured
   ├~~A50~~► ³H₆
   └~~A53~~► ³H₄ → A30/A31 → ³F₄ → A10 → ³H₆
```

### 690 nm (³H₆ → ³H₄, then ESA to ¹D₂)
```
 ³H₄ (3) ◄══ 690 nm (GSA)
   ┄┄ 690 nm (ESA, G2) ┄┄► ¹D₂ (6) → A61 / A60 / A63, W65 → ¹G₄ (5) → …
 ³H₄ + ³H₆ ✕ ³F₄ + ³F₄   (Kcr, high Tm)
```

### 785 nm and 1210 nm (³H₆ → ³H₄, then ESA to ¹G₄)
```
 ³H₄ (3) ◄══ 785 nm (GSA)         (1210 nm: absorbed into ³H₅, relaxes to ³H₄)
   ┄┄ ESA (G2) ┄┄► ¹G₄ (5) ~A51~► 645 nm ; A50 ; A53
 ³H₄ ~~A30~~► ³H₆ (775 nm) ; ~~A31~~► ³F₄ → A10 → ³H₆
 ³H₄ + ³H₆ ✕ ³F₄ + ³F₄   (Kcr, high Tm)
```

### Yb co-doping (all excitations)
```
 ³H₄ / ¹G₄ (Tm) ──Kyb·Yb%──► Yb ²F₅/₂   (extra loss; absent when Yb = 0)
```

### Upconversion
The 980 nm Yb-sensitised ETUC model is a separate model and is unchanged.
