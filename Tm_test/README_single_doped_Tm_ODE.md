# Single-doped Tm³⁺ downshifting model: equations and parameter definitions

## Scope and interpretation

This document specifies the single-Tm rate-equation model currently implemented by
`run_fitting_single_tm` in `test.py`. The model has seven tracked Tm³⁺ manifolds and represents
their populations during a finite excitation pulse and subsequent decay. It is a phenomenological
kinetic model for fitting normalized time-resolved emission traces; it is not, by itself, evidence
that every included process or numerical rate is correct for a particular specimen.

The same Tm rate equations are used for single-doped and Yb/Tm co-doped downshifting. For a
single-doped sample, the Yb-transfer coefficient is set to zero. The separate ETUC model is not
described here.

The parameter values listed below as defaults are software starting values, not certified
literature constants. The fitted values, applicability of each pathway, and assumptions about
excitation and instrument response should be checked against the experiment before the equations
are used in a manuscript.

## State vector and units

The state vector is

| Variable | Tm³⁺ manifold | Role |
|---|---|---|
| \(Tm_0\) | \(^{3}H_6\) | Ground state |
| \(Tm_1\) | \(^{3}F_4\) | Lower metastable state |
| \(Tm_3\) | \(^{3}H_4\) | 775 nm emitting state |
| \(Tm_5\) | \(^{1}G_4\) | 645 nm and 477 nm emitting state |
| \(Tm_6\) | \(^{1}D_2\) | 454 nm and 362 nm emitting state |
| \(Tm_7\) | \(^{1}I_6\) | 346 nm emitting state |
| \(Tm_8\) | \(^{3}P_2\) | High-lying state populated at 260 nm |

The subscripts are the model's labels; they are not a claim that all intervening spectroscopic
manifolds are explicitly represented. In the ODE solver, the time variable is in milliseconds and
the populations are dimensionless. Accordingly, first-order rates \(A\), \(W\), \(G\), and \(G_2\)
are numerically in \(\mathrm{ms}^{-1}\). This unit convention follows from passing time in ms to
the backend solver. Do not label numerical backend rates as \(\mathrm{s}^{-1}\) without converting
them by a factor of 1000.

The model initializes \(Tm_0(0)=1\), with every excited-state population zero. It treats populations
as normalized fractions and does not fit absolute emitted photon counts.

## Governing equations

The following equations give the implemented transfer and decay terms. Pump terms are defined
separately below because their destination depends on excitation wavelength. Let \(u_i(t)\) denote
the net pump contribution to state \(i\); thus pump terms are added to the corresponding right-hand
sides.

The model defines concentration-scaled cross-relaxation coefficients

\[
W_{\mathrm{cr}} = K_{\mathrm{cr}}\,c_{\mathrm{Tm}},
\qquad
k_{\mathrm{Yb}} = K_{\mathrm{yb}}\,c_{\mathrm{Yb}},
\]

where \(c_{\mathrm{Tm}}\) and \(c_{\mathrm{Yb}}\) are the numeric concentrations in mol%. They are
used in the mass-action terms

\[
r_1 = W_{\mathrm{cr}} Tm_3 Tm_0,
\qquad
r_2 = W_{\mathrm{cr}} Tm_6 Tm_0.
\]

The pre-extension equations are shown below; the concentration-gated CR and back-transfer
subsection later in this chapter updates the CR and Yb terms to the current implementation.

\[
\begin{aligned}
\frac{dTm_0}{dt}={}&
A_{10}Tm_1+A_{30}Tm_3+A_{50}Tm_5+A_{60}Tm_6+A_{70}Tm_7
+k_{\mathrm{Yb}}(Tm_3+Tm_5)-r_1-r_2+u_0(t),\\
\frac{dTm_1}{dt}={}&
A_{31}Tm_3+A_{51}Tm_5+A_{61}Tm_6+A_{71}Tm_7-A_{10}Tm_1
+2r_1+r_2+u_1(t),\\
\frac{dTm_3}{dt}={}&
A_{53}Tm_5+A_{63}Tm_6-(A_{30}+A_{31}+k_{\mathrm{Yb}})Tm_3-r_1+u_3(t),\\
\frac{dTm_5}{dt}={}&
W_{65}Tm_6-(A_{50}+A_{51}+A_{53}+k_{\mathrm{Yb}})Tm_5+r_2+u_5(t),\\
\frac{dTm_6}{dt}={}&
W_{76}Tm_7-(A_{60}+A_{61}+A_{63}+W_{65})Tm_6-r_2+u_6(t),\\
\frac{dTm_7}{dt}={}&
W_{87}Tm_8-(A_{70}+A_{71}+W_{76})Tm_7+u_7(t),\\
\frac{dTm_8}{dt}={}&
-W_{87}Tm_8+u_8(t).
\end{aligned}
\]

For single-doped Tm, \(c_{\mathrm{Yb}}=0\), hence \(k_{\mathrm{Yb}}=0\). The two cross-relaxation
terms represent the implemented reactions

\[
^{3}H_4+{}^{3}H_6 \longrightarrow 2\,{}^{3}F_4
\quad\text{and}\quad
^{1}D_2+{}^{3}H_6 \longrightarrow {}^{1}G_4+{}^{3}F_4.
\]

The factors \(2r_1\) and \(r_2\) in \(dTm_1/dt\) follow from the product states in these reactions.
The current implementation scales these terms linearly with the entered Tm mol% and forms the
bilinear products from normalized populations. Thus \(K_{\mathrm{cr}}\) is an effective
concentration-scaled coefficient in this model, not automatically a transferable bimolecular
constant in physical volume units.

### Concentration-gated CR and back-transfer extension

The current ODE implementation uses strict concentration thresholds. With \(c_{\mathrm{Tm}}\) and
\(c_{\mathrm{Yb}}\) as numeric concentrations in mol%, define

\[
\chi_{\mathrm{G4}}=\mathbf{1}[c_{\mathrm{Tm}}>0.1],\qquad
\chi_{\mathrm{D2}}=\mathbf{1}[c_{\mathrm{Tm}}>0.1],\qquad
\chi_{\mathrm{H4}}=\mathbf{1}[c_{\mathrm{Tm}}\ge1.0],\qquad
\chi_{\mathrm{Yb}}=\mathbf{1}[c_{\mathrm{Yb}}>10.0].
\]

The cross-relaxation rates (effective \(\mathrm{ms}^{-1}\) on the normalized population products) are

\[
\begin{aligned}
r_{\mathrm{H4}}&=\chi_{\mathrm{H4}}K_{\mathrm{cr,H4}}c_{\mathrm{Tm}}\,Tm_3Tm_0,
&{}^{3}H_4+{}^{3}H_6&\to2\,{}^{3}F_4,\\
r_{\mathrm{G4}}&=\chi_{\mathrm{G4}}K_{\mathrm{cr,G4}}c_{\mathrm{Tm}}\,Tm_5Tm_0,
&{}^{1}G_4+{}^{3}H_6&\to{}^{3}H_4+{}^{3}F_4,\\
r_{\mathrm{D2}}&=\chi_{\mathrm{D2}}K_{\mathrm{cr}}c_{\mathrm{Tm}}\,Tm_6Tm_0,
&{}^{1}D_2+{}^{3}H_6&\to{}^{1}G_4+{}^{3}F_4.
\end{aligned}
\]

Here the state labels are \(Tm_3={}^{3}H_4\), \(Tm_5={}^{1}G_4\), \(Tm_6={}^{1}D_2\),
and \(Tm_1={}^{3}F_4\). \(K_{\mathrm{cr,G4}}\) and \(K_{\mathrm{cr,H4}}\) are independent
fitted parameters for the \(^{1}G_4\)-fed 775 nm enhancement and the higher-concentration
\(^{3}H_4\) quenching pathway. The legacy \(^{1}D_2\) channel retains its own \(K_{\mathrm{cr}}\)
coefficient. Relative to the seven baseline equations above, the two principal CR additions are

\[
\begin{aligned}
\dot{Tm}_0&\mathrel{+}= -r_{\mathrm{G4}}-r_{\mathrm{H4}},&
\dot{Tm}_1&\mathrel{+}= r_{\mathrm{G4}}+2r_{\mathrm{H4}},\\
\dot{Tm}_3&\mathrel{+}= r_{\mathrm{G4}}-r_{\mathrm{H4}},&
\dot{Tm}_5&\mathrel{+}= -r_{\mathrm{G4}},
\end{aligned}
\]

and \(r_{\mathrm{D2}}\) remains the existing \(^{1}D_2\) CR rate. Thus
\(^{1}G_4+{}^{3}H_6\) directly feeds the \(^{3}H_4\) state observed at 775 nm, while the separately
gated \(^{3}H_4+{}^{3}H_6\to2\,{}^{3}F_4\) channel consumes that state and competes with 775 nm
emission.

Tm-to-Yb back energy transfer is

\[
b_{\mathrm{Yb}}=\chi_{\mathrm{Yb}}K_{\mathrm{yb}}c_{\mathrm{Yb}}\,Tm_3,
\qquad
{}^{3}H_4+\mathrm{Yb}^{3+}({}^{2}F_{7/2})
\to{}^{3}H_6+\mathrm{Yb}^{3+}({}^{2}F_{5/2}).
\]

It contributes \(+b_{\mathrm{Yb}}\) to \(\dot{Tm}_0\) and \(-b_{\mathrm{Yb}}\) to
\(\dot{Tm}_3\); the excited Yb population is not explicitly represented in the seven-state model.
This replaces the earlier simplified Yb loss from both \(^{3}H_4\) and \(^{1}G_4\). The pathway is
zero for \(c_{\mathrm{Yb}}\le10.0\) mol%. Each Tm–Tm CR reaction and this
back-transfer conserve total tracked Tm population. The concentration-linear scaling is an
effective model assumption; fitted coefficients should not be interpreted as universal microscopic
constants without independent validation.

## Excitation terms

The ground-state pump rate is \(G(t)=G\) while the pulse is on and zero after it ends. Define
\(p(t)=G(t)Tm_0(t)\). Its contribution is \(-p(t)\) in \(dTm_0/dt\) and \(+p(t)\) in the excited
state shown below. In explicit notation:

\[
u_0(t)=-p(t),\qquad u_i(t)=+p(t)
\]

for the direct-excitation entry state \(i\), with all other \(u_j=0\) unless the ESA term below is
active. In code, \(G(t)\) is a constant effective pump rate during a rectangular pulse of fitted
duration \(t_p\); it is not calculated from an independently measured absorption cross-section and
photon flux.

| Nominal excitation | Backend entry state | Additional excited-state absorption (ESA) while pulse is on |
|---|---|---|
| 260 nm | \(^{3}P_2\) (\(Tm_8\)) | None |
| 356 nm | \(^{1}D_2\) (\(Tm_6\)) | None |
| 466 nm | \(^{1}G_4\) (\(Tm_5\)) | None |
| 690 nm | \(^{3}H_4\) (\(Tm_3\)) | \(^{3}H_4\to{}^{1}D_2\) |
| 785 nm | \(^{3}H_4\) (\(Tm_3\)) | \(^{3}H_4\to{}^{1}G_4\) |
| 1210 nm | \(^{3}H_4\) (\(Tm_3\)) | \(^{3}H_4\to{}^{1}G_4\) |

For stepwise excitation, the ESA flux is

\[
f_{\mathrm{ESA}}(t)=
\begin{cases}
G_2 Tm_3(t),&0\leq t\leq t_p,\\
0,&t>t_p,
\end{cases}
\]

and is subtracted from \(dTm_3/dt\) and added to \(dTm_6/dt\) for 690 nm, or to \(dTm_5/dt\) for
785/1210 nm. \(G_2\) is an effective ESA rate, not a separately measured cross-section.

**Important implementation limitation:** although some UI descriptions discuss intermediate
manifolds for 690 or 1210 nm excitation, this backend model does not explicitly track
\(^{3}F_{2,3}\) or \(^{3}H_5\). In particular, its 1210 nm entry is directly assigned to
\(^{3}H_4\). This is a simplifying assumption that should be made explicit and independently
validated before interpreting those excitation cases as a detailed physical excitation pathway.

The pulse duration is optimized around the user-entered value (normally ±30%). If the initial fit
is exceptionally poor, an additional pulse-width rescue can test a broader, shorter range. The
fitted time offset shifts the trace relative to the model's time origin.

## Emission mechanism and the reasoning behind each equation

Level energies below are approximate and are shown for orientation only; the model uses rates, not
energies.

```
 ~10³ cm⁻¹
  38  ─ ³P₂  (Tm₈) ◄══ 260 nm pump (G)
          ┆ W₈₇  (multiphonon, fastest step)
  35  ─ ¹I₆  (Tm₇) ──A₇₁──► ³F₄   346 nm      (also A₇₀ ──► ³H₆)
          ┆ W₇₆
  28  ─ ¹D₂  (Tm₆) ◄══ 356 nm pump (G)
          │  A₆₁ ──► ³F₄  454 nm,   A₆₀ ──► ³H₆  362 nm,   A₆₃ ──► ³H₄
          ┆ W₆₅
  21  ─ ¹G₄  (Tm₅) ◄══ 466 nm pump (G)
          │  A₅₁ ──► ³F₄  645 nm,   A₅₀ ──► ³H₆  477 nm,   A₅₃ ──► ³H₄
  12.6─ ³H₄  (Tm₃) ◄══ 690 / 785 / 1210 nm entry (G)
          │  A₃₀ ──► ³H₆  775 nm,   A₃₁ ──► ³F₄
          │  ESA (G₂): ³H₄ ═► ¹D₂ (690 nm)  or  ³H₄ ═► ¹G₄ (785, 1210 nm)
  5.6 ─ ³F₄  (Tm₁) ──A₁₀──► ³H₆  1800 nm
   0  ─ ³H₆  (Tm₀)  ground state

 ┆ = non-radiative (W)    │ / ──► = radiative (A)    ═► = pump or ESA

 Cross-relaxation:
   Tm > 0.1%: ¹G₄ + ³H₆ ──r_G4──► ³H₄ + ³F₄   (blue quenching; 775 nm enhancement)
   Tm ≥ 1.0%: ³H₄ + ³H₆ ──r_H4──► 2 ³F₄       (quenches the enhanced 775 nm channel)
   Tm > 0.1%: ¹D₂ + ³H₆ ──r_D2──► ¹G₄ + ³F₄   (existing model pathway)
 Yb back-transfer (enabled above 10 mol% Yb):
   ³H₄ + Yb³⁺(²F₇/₂) ──b_Yb──► ³H₆ + Yb³⁺(²F₅/₂)
```

Each level equation follows one rule: the right-hand side lists what feeds the level (gains) and every
way it can empty (losses). The measured trace for an emission is the emitting level's population
multiplied by that transition's radiative rate.

| Level | Gains | Losses | Reason |
|---|---|---|---|
| ³P₂ (Tm₈) | pump (260 nm only) | W₈₇ | No radiative channel is included. It empties into ¹I₆ by multiphonon decay, and W₈₇ is the largest rate. |
| ¹I₆ (Tm₇) | W₈₇·Tm₈ | A₇₀, A₇₁, W₇₆ | A₇₁ is the 346 nm emission. W₇₆ passes population down to ¹D₂. |
| ¹D₂ (Tm₆) | W₇₆·Tm₇, pump (356 nm) | A₆₀, A₆₁, A₆₃, W₆₅, r₂ | 362 nm (A₆₀) and 454 nm (A₆₁) are emitted here. A₆₃ feeds ³H₄ and W₆₅ feeds ¹G₄. |
| ¹G₄ (Tm₅) | W₆₅·Tm₆, r_D2, pump (466 nm) | A₅₀, A₅₁, A₅₃, r_G4 | r_G4 transfers population onward to ³H₄ + ³F₄. |
| ³H₄ (Tm₃) | A₅₃·Tm₅, A₆₃·Tm₆, r_G4, pump (690, 785, 1210 nm) | A₃₀, A₃₁, b_Yb, r_H4, G₂ (ESA) | 775 nm (A₃₀) is emitted here. |
| ³F₄ (Tm₁) | A₃₁·Tm₃, A₅₁·Tm₅, A₆₁·Tm₆, A₇₁·Tm₇, 2r_H4 + r_G4 + r_D2 | A₁₀ | It collects decay from levels above it and both CR product channels. |
| ³H₆ (Tm₀) | radiative returns A₁₀…A₇₀, b_Yb | r_H4, r_G4, r_D2, G·Tm₀ | CR consumes a ground-state ion; back-transfer restores one. |

Multiphonon steps (W) hand population to the next level and never return it to the ground state, so the
sum of all populations stays constant.

Cross-relaxation terms are bilinear products of excited- and ground-state populations. The
\(^{1}G_4\) and \(^{1}D_2\) channels activate above 0.1 mol% Tm; the separate \(^{3}H_4\) channel
activates at or above 1.0 mol% Tm. Each is scaled linearly with entered Tm mol%. Yb back-transfer
activates only above 10 mol% Yb.

The pump \(G\,Tm_0\) is a rectangular pulse of width \(t_p\). It is not computed from a cross-section
and a photon flux, so \(G\) and \(G_2\) are effective rates.

## Parameter definitions

Here \(A_{ij}\) denotes the first-order radiative decay rate from the upper state whose label is
\(i\) to the state labelled \(j\). \(W_{ij}\) denotes an effective non-radiative relaxation rate.
All tabulated defaults are the code's initialization values in \(\mathrm{ms}^{-1}\); they are not
asserted to be sample-specific measured constants.

| Symbol | Transition or role | Default | Interpretation in the equations |
|---|---|---:|---|
| \(G\) | Pump from \(^{3}H_6\) | 20.0 | Effective ground-state excitation rate during the pulse; destination depends on excitation wavelength. |
| \(G_2\) | ESA from \(^{3}H_4\) | 1.0 | Effective second-step excitation rate during the pulse for 690, 785, and 1210 nm cases. |
| \(A_{10}\) | \(^{3}F_4\to{}^{3}H_6\) | 0.12 | Radiative depopulation of \(Tm_1\); associated modeled signal at 1800 nm. |
| \(A_{30}\) | \(^{3}H_4\to{}^{3}H_6\) | 0.35 | Radiative branch from \(Tm_3\); associated modeled signal at 775 nm. |
| \(A_{31}\) | \(^{3}H_4\to{}^{3}F_4\) | 0.25 | Radiative branch from \(Tm_3\) into \(Tm_1\). |
| \(A_{50}\) | \(^{1}G_4\to{}^{3}H_6\) | 0.6 | Radiative branch from \(Tm_5\), associated in the model with 477 nm. |
| \(A_{51}\) | \(^{1}G_4\to{}^{3}F_4\) | 0.5 | Radiative branch from \(Tm_5\), associated with 645 nm. |
| \(A_{53}\) | \(^{1}G_4\to{}^{3}H_4\) | 0.05 | Radiative feeding of the 775 nm emitting state \(Tm_3\). |
| \(A_{60}\) | \(^{1}D_2\to{}^{3}H_6\) | 1.0 | Radiative branch from \(Tm_6\), associated with 362 nm. |
| \(A_{61}\) | \(^{1}D_2\to{}^{3}F_4\) | 3.0 | Radiative branch from \(Tm_6\), associated with 454 nm. |
| \(A_{63}\) | \(^{1}D_2\to{}^{3}H_4\) | 0.3 | Radiative feeding of \(Tm_3\) from \(Tm_6\). |
| \(A_{70}\) | \(^{1}I_6\to{}^{3}H_6\) | 3.0 | Radiative branch from \(Tm_7\). |
| \(A_{71}\) | \(^{1}I_6\to{}^{3}F_4\) | 4.0 | Radiative branch from \(Tm_7\), associated with 345/346 nm. |
| \(W_{87}\) | \(^{3}P_2\to{}^{1}I_6\) | 500.0 | Effective non-radiative feed from \(Tm_8\) to the 346 nm emitting state. |
| \(W_{76}\) | \(^{1}I_6\to{}^{1}D_2\) | 1.0 | Effective non-radiative feed from \(Tm_7\) to \(Tm_6\). |
| \(W_{65}\) | \(^{1}D_2\to{}^{1}G_4\) | 0.5 | Effective non-radiative feed from \(Tm_6\) to \(Tm_5\). |
| \(K_{\mathrm{cr}}\) | D₂-to-ground Tm–Tm CR coefficient | 2.0 | Multiplied by Tm mol% for the existing \(^{1}D_2+{}^{3}H_6\) channel; enabled only above 0.1 mol% Tm. |
| \(K_{\mathrm{cr,H4}}\) | H₄-to-ground Tm–Tm CR coefficient | 2.0 | Separate \(^{3}H_4+{}^{3}H_6\to2\,{}^{3}F_4\) fit; enabled at or above 1.0 mol% Tm. |
| \(K_{\mathrm{cr,G4}}\) | G₄-to-ground Tm–Tm CR coefficient | 2.0 | Separate \(^{1}G_4+{}^{3}H_6\to{}^{3}H_4+{}^{3}F_4\) fit; enabled only above 0.1 mol% Tm. |
| \(K_{\mathrm{yb}}\) | Tm-to-Yb back-transfer coefficient | 0.5 | Multiplied by Yb mol%; H₄ back-transfer is enabled only above 10 mol% Yb. |
| \(T_{\mathrm{offset}}\) | Time-zero shift | 0.0 | Shifts model time relative to measured time; bounded by the fitter. |
| \(t_p\) | Pulse duration | User input | Rectangular pulse duration, normally fitted within ±30% of the entered pulse. |
| \(L_{\mathrm{obs}}\) | Observed-level rate scale | 1.0 multiplier | Multiplies all radiative rates for the observed level by one common factor, retaining their branching ratios. This is a fitted log-scale variable. |

## Measured-emission model

For an emission assigned to level \(i\), the backend forms the model signal as

\[
I_{\mathrm{model}}(t)\propto A_{ij}Tm_i(t),
\]

then convolves that signal with an approximate Gaussian instrument-response kernel and applies a
fitted multiplicative scale during least-squares evaluation. The implemented emission mappings are:

| Emission label | Tracked state | Rate used for observable |
|---|---|---|
| 345 or 346 nm | \(^{1}I_6\), \(Tm_7\) | \(A_{71}Tm_7\) |
| 362 nm | \(^{1}D_2\), \(Tm_6\) | \(A_{60}Tm_6\) |
| 452 or 454 nm | \(^{1}D_2\), \(Tm_6\) | \(A_{61}Tm_6\) |
| 477 nm | \(^{1}G_4\), \(Tm_5\) | \(A_{50}Tm_5\) |
| 645 nm | \(^{1}G_4\), \(Tm_5\) | \(A_{51}Tm_5\) |
| 775 nm | \(^{3}H_4\), \(Tm_3\) | \(A_{30}Tm_3\) |
| 1800 nm | \(^{3}F_4\), \(Tm_1\) | \(A_{10}Tm_1\) |

The code's instrument-response approximation uses a Gaussian width derived from the sample interval
and pulse duration; it is not a measured instrument response function (IRF). The fitted trace is
normalized/scaled, so the fit principally constrains time-dependent shape. It does not independently
determine absolute transition probabilities, collection efficiency, or quantum yield.

## Which parameters are fitted?

The active set depends on the excitation, observed level, concentration, and optional co-doping.
In general, it can include:

- \(G\), unless the pump rate is explicitly locked;
- \(G_2\) and entry-level decay parameters for stepwise-excitation cases;
- feeder rates along the cascade between the entry and observed states;
- radiative rates at the observed state, represented by their priors multiplied by the single
  \(L_{\mathrm{obs}}\) scale;
- \(K_{\mathrm{cr}}\) when the entered Tm concentration is at least 0.3 mol%;
- \(K_{\mathrm{yb}}\) only when Yb is present;
- \(T_{\mathrm{offset}}\) and pulse duration.

Rates outside the fitted pathway generally remain fixed at their software priors. For example,
the 260 nm / 346 nm trace mainly identifies the \(^{3}P_2\to{}^{1}I_6\) feed and the total loss
shape of \(^{1}I_6\), not every downstream cascade rate. A single normalized trace usually cannot
identify all radiative branches independently. The common \(L_{\mathrm{obs}}\) scale preserves the
assumed branch ratios rather than claiming that the data measured each branch separately.

The optimizer uses a weighted residual objective for parameter estimation, then reports R² from
the full fitted trace. Adaptive refinements and tail/pulse rescue steps may follow. R² is a
goodness-of-fit statistic, not a test that the rate equations are physically unique or correct.
Parameter confidence intervals and global identifiability are not calculated by this implementation.

## Where Yb enters the model, and why 260 nm and 356 nm traces are not affected

The Yb back-transfer term is \(b_{\mathrm{Yb}}=K_{\mathrm{yb}}c_{\mathrm{Yb}}Tm_3\), enabled only
when Yb exceeds 10 mol%. It transfers the donor \(^{3}H_4\) ion to \(^{3}H_6\);
no \(^{1}G_4\) loss is assigned to this reaction. The excited Yb state is not explicitly tracked by
this seven-state model.

Population in this model flows only downward through the cascade
\(^{3}P_2\to{}^{1}I_6\to{}^{1}D_2\to{}^{1}G_4\to{}^{3}H_4\to{}^{3}F_4\). Nothing flows back up, so a loss
at a lower level cannot change the population of a higher level. Consequently:

| Excitation | Emission | Emitting level | Yb term acts on it? |
|---|---|---|---|
| 260 nm | 346 nm | \(^{1}I_6\) (\(Tm_7\)) | No |
| 356 nm | 454 nm | \(^{1}D_2\) (\(Tm_6\)) | No |
| 356 nm | 775 nm | \(^{3}H_4\) (\(Tm_3\)) | Yes |
| 466 nm | 645 nm | \(^{1}G_4\) (\(Tm_5\)) | Yes |

For the 260 nm / 346 nm and 356 nm / 454 nm traces the fitted curve is therefore identical with and
without Yb. In the fit, \(K_{\mathrm{yb}}\) is still listed as free whenever Yb > 0, but for these
traces the data cannot constrain it and it stays near its starting value. Cross-relaxation
(\(W_{\mathrm{cr}}\)) is independent of Yb and does act on \(^{3}H_4\) and \(^{1}D_2\).

This is a property of how the model is built, not a measured result. Real Yb\(^{3+}\) can couple to
higher Tm\(^{3+}\) levels, and Yb\(^{3+}\) has no resonant absorption at 260 nm, so any Yb effect on
the 346 nm or 454 nm decay would have to arise from energy transfer from Tm\(^{3+}\), which this model
does not include. If Yb changes those decays experimentally, a Yb loss term would have to be added to
\(^{1}I_6\) and \(^{1}D_2\) in the model.

## Assumptions and limitations to state in a publication

1. **Effective levels.** Seven manifolds are explicitly tracked; other states and fast relaxation
   steps are lumped into effective rates or omitted.
2. **Pulse shape.** Excitation is rectangular, with constant effective \(G\) and (where relevant)
   \(G_2\); arbitrary laser temporal profiles are not represented.
3. **Initial condition.** The model starts with all population in \(^{3}H_6\) at the fitted time
   origin. Pre-pulse excitation and long-lived initial populations are not included.
4. **Instrument response.** Detection response is approximated by a Gaussian inferred from sampling
   and pulse duration rather than supplied as a measured IRF.
5. **Concentration dependence.** Cross-relaxation is a chosen bilinear population term scaled by
   numeric mol%; verify its concentration convention and range before interpreting \(K_{\mathrm{cr}}\)
   as a material constant.
6. **Co-dopant term.** The optional Yb term is an effective Tm donor loss with ground-state return;
   detailed Yb level dynamics are outside this model.
7. **Slow-tail extension.** If enabled and the ODE-only fit is inadequate, the fitting routine may
   add a phenomenological slow exponential to the observed trace. That component is not one of the
   Tm population ODE states and should not be presented as an established microscopic pathway.
8. **Model validation.** Confirm excitation assignment, emission branching assignments, units,
   pulse-width/time-zero calibration, baseline treatment, and residual structure against independent
   experimental information. Do not add or remove pathways solely to maximize R².

## Reproducibility note

For a publication, report the excitation wavelength and assumed entry state, detected emission and
assigned transition, sample composition, host and anneal conditions, time/pulse units, initial
condition, included transfer terms, instrument-response treatment, fitted versus fixed parameters,
normalization/baseline procedure, and optimization settings. Report the implemented effective-rate
units consistently as \(\mathrm{ms}^{-1}\), or convert all rates and time quantities consistently
before presenting them in another unit system.
