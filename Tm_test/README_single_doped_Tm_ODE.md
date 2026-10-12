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
| \(n_0\) | \(^{3}H_6\) | Ground state |
| \(n_1\) | \(^{3}F_4\) | Lower metastable state |
| \(n_3\) | \(^{3}H_4\) | 775 nm emitting state |
| \(n_5\) | \(^{1}G_4\) | 645 nm and 477 nm emitting state |
| \(n_6\) | \(^{1}D_2\) | 454 nm and 362 nm emitting state |
| \(n_7\) | \(^{1}I_6\) | 346 nm emitting state |
| \(n_8\) | \(^{3}P_2\) | High-lying state populated at 260 nm |

The subscripts are the model's labels; they are not a claim that all intervening spectroscopic
manifolds are explicitly represented. In the ODE solver, the time variable is in milliseconds and
the populations are dimensionless. Accordingly, first-order rates \(A\), \(W\), \(G\), and \(G_2\)
are numerically in \(\mathrm{ms}^{-1}\). This unit convention follows from passing time in ms to
the backend solver. Do not label numerical backend rates as \(\mathrm{s}^{-1}\) without converting
them by a factor of 1000.

The model initializes \(n_0(0)=1\), with every excited-state population zero. It treats populations
as normalized fractions and does not fit absolute emitted photon counts.

## Governing equations

The following equations give the implemented transfer and decay terms. Pump terms are defined
separately below because their destination depends on excitation wavelength. Let \(u_i(t)\) denote
the net pump contribution to state \(i\); thus pump terms are added to the corresponding right-hand
sides.

The model defines concentration-scaled cross-relaxation coefficients

\[
k_{\mathrm{CR}} = K_{\mathrm{cr}}\,c_{\mathrm{Tm}},
\qquad
k_{\mathrm{Yb}} = K_{\mathrm{yb}}\,c_{\mathrm{Yb}},
\]

where \(c_{\mathrm{Tm}}\) and \(c_{\mathrm{Yb}}\) are the numeric concentrations in mol%. They are
used in the mass-action terms

\[
r_1 = k_{\mathrm{CR}} n_3 n_0,
\qquad
r_2 = k_{\mathrm{CR}} n_6 n_0.
\]

The seven equations are

\[
\begin{aligned}
\frac{dn_0}{dt}={}&
A_{10}n_1+A_{30}n_3+A_{50}n_5+A_{60}n_6+A_{70}n_7
+k_{\mathrm{Yb}}(n_3+n_5)-r_1-r_2+u_0(t),\\
\frac{dn_1}{dt}={}&
A_{31}n_3+A_{51}n_5+A_{61}n_6+A_{71}n_7-A_{10}n_1
+2r_1+r_2+u_1(t),\\
\frac{dn_3}{dt}={}&
A_{53}n_5+A_{63}n_6-(A_{30}+A_{31}+k_{\mathrm{Yb}})n_3-r_1+u_3(t),\\
\frac{dn_5}{dt}={}&
W_{65}n_6-(A_{50}+A_{51}+A_{53}+k_{\mathrm{Yb}})n_5+r_2+u_5(t),\\
\frac{dn_6}{dt}={}&
W_{76}n_7-(A_{60}+A_{61}+A_{63}+W_{65})n_6-r_2+u_6(t),\\
\frac{dn_7}{dt}={}&
W_{87}n_8-(A_{70}+A_{71}+W_{76})n_7+u_7(t),\\
\frac{dn_8}{dt}={}&
-W_{87}n_8+u_8(t).
\end{aligned}
\]

For single-doped Tm, \(c_{\mathrm{Yb}}=0\), hence \(k_{\mathrm{Yb}}=0\). The two cross-relaxation
terms represent the implemented reactions

\[
^{3}H_4+{}^{3}H_6 \longrightarrow 2\,{}^{3}F_4
\quad\text{and}\quad
^{1}D_2+{}^{3}H_6 \longrightarrow {}^{1}G_4+{}^{3}F_4.
\]

The factors \(2r_1\) and \(r_2\) in \(dn_1/dt\) follow from the product states in these reactions.
The current implementation scales these terms linearly with the entered Tm mol% and forms the
bilinear products from normalized populations. Thus \(K_{\mathrm{cr}}\) is an effective
concentration-scaled coefficient in this model, not automatically a transferable bimolecular
constant in physical volume units.

The \(k_{\mathrm{Yb}}\) terms represent donor Tm³⁺ returning to its ground state after transferring
excitation to Yb³⁺. This optional loss is applied to \(^{3}H_4\) and \(^{1}G_4\) in the implementation;
it is absent in single-doped fits.

## Excitation terms

The ground-state pump rate is \(G(t)=G\) while the pulse is on and zero after it ends. Define
\(p(t)=G(t)n_0(t)\). Its contribution is \(-p(t)\) in \(dn_0/dt\) and \(+p(t)\) in the excited
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
| 260 nm | \(^{3}P_2\) (\(n_8\)) | None |
| 356 nm | \(^{1}D_2\) (\(n_6\)) | None |
| 466 nm | \(^{1}G_4\) (\(n_5\)) | None |
| 690 nm | \(^{3}H_4\) (\(n_3\)) | \(^{3}H_4\to{}^{1}D_2\) |
| 785 nm | \(^{3}H_4\) (\(n_3\)) | \(^{3}H_4\to{}^{1}G_4\) |
| 1210 nm | \(^{3}H_4\) (\(n_3\)) | \(^{3}H_4\to{}^{1}G_4\) |

For stepwise excitation, the ESA flux is

\[
f_{\mathrm{ESA}}(t)=
\begin{cases}
G_2 n_3(t),&0\leq t\leq t_p,\\
0,&t>t_p,
\end{cases}
\]

and is subtracted from \(dn_3/dt\) and added to \(dn_6/dt\) for 690 nm, or to \(dn_5/dt\) for
785/1210 nm. \(G_2\) is an effective ESA rate, not a separately measured cross-section.

**Important implementation limitation:** although some UI descriptions discuss intermediate
manifolds for 690 or 1210 nm excitation, this backend model does not explicitly track
\(^{3}F_{2,3}\) or \(^{3}H_5\). In particular, its 1210 nm entry is directly assigned to
\(^{3}H_4\). This is a simplifying assumption that should be made explicit and independently
validated before interpreting those excitation cases as a detailed physical excitation pathway.

The pulse duration is optimized around the user-entered value (normally ±30%). If the initial fit
is exceptionally poor, an additional pulse-width rescue can test a broader, shorter range. The
fitted time offset shifts the trace relative to the model's time origin.

## Parameter definitions

Here \(A_{ij}\) denotes the first-order radiative decay rate from the upper state whose label is
\(i\) to the state labelled \(j\). \(W_{ij}\) denotes an effective non-radiative relaxation rate.
All tabulated defaults are the code's initialization values in \(\mathrm{ms}^{-1}\); they are not
asserted to be sample-specific measured constants.

| Symbol | Transition or role | Default | Interpretation in the equations |
|---|---|---:|---|
| \(G\) | Pump from \(^{3}H_6\) | 20.0 | Effective ground-state excitation rate during the pulse; destination depends on excitation wavelength. |
| \(G_2\) | ESA from \(^{3}H_4\) | 1.0 | Effective second-step excitation rate during the pulse for 690, 785, and 1210 nm cases. |
| \(A_{10}\) | \(^{3}F_4\to{}^{3}H_6\) | 0.12 | Radiative depopulation of \(n_1\); associated modeled signal at 1800 nm. |
| \(A_{30}\) | \(^{3}H_4\to{}^{3}H_6\) | 0.35 | Radiative branch from \(n_3\); associated modeled signal at 775 nm. |
| \(A_{31}\) | \(^{3}H_4\to{}^{3}F_4\) | 0.25 | Radiative branch from \(n_3\) into \(n_1\). |
| \(A_{50}\) | \(^{1}G_4\to{}^{3}H_6\) | 0.6 | Radiative branch from \(n_5\), associated in the model with 477 nm. |
| \(A_{51}\) | \(^{1}G_4\to{}^{3}F_4\) | 0.5 | Radiative branch from \(n_5\), associated with 645 nm. |
| \(A_{53}\) | \(^{1}G_4\to{}^{3}H_4\) | 0.05 | Radiative feeding of the 775 nm emitting state \(n_3\). |
| \(A_{60}\) | \(^{1}D_2\to{}^{3}H_6\) | 1.0 | Radiative branch from \(n_6\), associated with 362 nm. |
| \(A_{61}\) | \(^{1}D_2\to{}^{3}F_4\) | 3.0 | Radiative branch from \(n_6\), associated with 454 nm. |
| \(A_{63}\) | \(^{1}D_2\to{}^{3}H_4\) | 0.3 | Radiative feeding of \(n_3\) from \(n_6\). |
| \(A_{70}\) | \(^{1}I_6\to{}^{3}H_6\) | 3.0 | Radiative branch from \(n_7\). |
| \(A_{71}\) | \(^{1}I_6\to{}^{3}F_4\) | 4.0 | Radiative branch from \(n_7\), associated with 345/346 nm. |
| \(W_{87}\) | \(^{3}P_2\to{}^{1}I_6\) | 500.0 | Effective non-radiative feed from \(n_8\) to the 346 nm emitting state. |
| \(W_{76}\) | \(^{1}I_6\to{}^{1}D_2\) | 1.0 | Effective non-radiative feed from \(n_7\) to \(n_6\). |
| \(W_{65}\) | \(^{1}D_2\to{}^{1}G_4\) | 0.5 | Effective non-radiative feed from \(n_6\) to \(n_5\). |
| \(K_{\mathrm{cr}}\) | Tm–Tm cross-relaxation coefficient | 2.0 | Multiplied by entered Tm mol% to give the coefficient in \(r_1,r_2\). |
| \(K_{\mathrm{yb}}\) | Tm-to-Yb transfer coefficient | 0.5 | Multiplied by entered Yb mol%; used only in co-doped mode and set to zero for single-doped Tm. |
| \(T_{\mathrm{offset}}\) | Time-zero shift | 0.0 | Shifts model time relative to measured time; bounded by the fitter. |
| \(t_p\) | Pulse duration | User input | Rectangular pulse duration, normally fitted within ±30% of the entered pulse. |
| \(L_{\mathrm{obs}}\) | Observed-level rate scale | 1.0 multiplier | Multiplies all radiative rates for the observed level by one common factor, retaining their branching ratios. This is a fitted log-scale variable. |

## Measured-emission model

For an emission assigned to level \(i\), the backend forms the model signal as

\[
I_{\mathrm{model}}(t)\propto A_{ij}n_i(t),
\]

then convolves that signal with an approximate Gaussian instrument-response kernel and applies a
fitted multiplicative scale during least-squares evaluation. The implemented emission mappings are:

| Emission label | Tracked state | Rate used for observable |
|---|---|---|
| 345 or 346 nm | \(^{1}I_6\), \(n_7\) | \(A_{71}n_7\) |
| 362 nm | \(^{1}D_2\), \(n_6\) | \(A_{60}n_6\) |
| 452 or 454 nm | \(^{1}D_2\), \(n_6\) | \(A_{61}n_6\) |
| 477 nm | \(^{1}G_4\), \(n_5\) | \(A_{50}n_5\) |
| 645 nm | \(^{1}G_4\), \(n_5\) | \(A_{51}n_5\) |
| 775 nm | \(^{3}H_4\), \(n_3\) | \(A_{30}n_3\) |
| 1800 nm | \(^{3}F_4\), \(n_1\) | \(A_{10}n_1\) |

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
