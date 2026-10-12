# Tm³⁺ / Yb³⁺ Downshifting – Model Guide

For a publication-style description of the implemented single-doped Tm³⁺ rate equations, all
parameter definitions, fitting conventions, and model limitations, see
[README_single_doped_Tm_ODE.md](README_single_doped_Tm_ODE.md).

## Using Downshifting (single-doped Tm and Yb/Tm co-doped)

1. Choose **Downshifting** and a material model (single-doped Tm or Yb/Tm co-doped).
2. Click **Add files** and select any number of CSV files. Each file gets its own row with its own
   time unit, excitation, emission, pulse width (µs), whether the pulse width may be optimized, Tm %, host,
   anneal temperature, and (co-doped only) Yb %.
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

## ODE model (shared by single-doped and co-doped)

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

### Yb co-doping
Adds one term only: Tm→Yb back-transfer loss `Kyb · Yb%` depopulating ³H₄ and ¹G₄. With Yb = 0
(single-doped, no Yb input) this term vanishes.

### Do the ODEs change between single and co-doped, at 260 nm or any other excitation?
No. The level scheme, rates, and entry level for every excitation (260, 356, 466, 690, 785, 1210 nm) are identical.
The only difference is the `Kyb · Yb%` term, which is zero for single-doped samples.

## Why the ODE panel lists so many decay pathways (even with one emission)

**Short answer:** the full ODE set describes the whole Tm³⁺ system physically, but a single measured emission
only depends on a few of those equations. The panel shows only the relevant ones and collapses the rest.

### 1. Why the full cascade exists
An excitation populates one entry level, and that population then relaxes downward through every lower level
(multiphonon steps `W` and radiative branching `A`). Writing the complete model means one equation per level so
that population is conserved. For 260 nm the chain is ³P₂ → ¹I₆ → ¹D₂ → ¹G₄ → ³H₄ → ³F₄ → ³H₆.
The same equation set is used for single-doped and co-doped samples.

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
- Yb co-doping (`Kyb · Yb%`) adds one extra loss on ³H₄ and ¹G₄ only, so it does not alter the 346 nm (¹I₆) trace.

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
| Kyb | Tm → Yb loss × Yb % | co-doped only | 0.5 |

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
