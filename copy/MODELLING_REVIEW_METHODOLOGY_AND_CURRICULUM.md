# Modelling review, methodology, and learning curriculum

## Purpose and scope

This chapter explains the kinetic models implemented in the Tm³⁺/Yb³⁺ lifetime program, from the
experimental question to a fitted time trace. It is written to support academic examination and
should be read alongside [README_single_doped_Tm_ODE.md](./README_single_doped_Tm_ODE.md), which
records the direct-Tm equations and parameter definitions in greater detail.

The software contains two related but distinct models:

1. **Yb-sensitized ETU (energy-transfer upconversion):** an 11-component state vector for Yb³⁺ and
   Tm³⁺, integrated with the implicit Radau method. One Tm component is a zero-valued placeholder
   in the current equations; it is not an independently populated physical level.
2. **Direct-Tm excitation (with optional effective Yb loss):** a seven-manifold Tm³⁺ model,
   integrated in separate pulse-on and pulse-off segments using LSODA. Yb is not a dynamic species
   in this model; a concentration-scaled Tm-to-Yb loss is used when Yb is present.

The two models therefore do not represent interchangeable descriptions of the same experiment.
Model selection must follow the actual excitation mechanism. All default rates are software
starting values, not established constants for a particular sample. The implementation is in
[models.py](./backend/models.py), [fitting.py](./backend/fitting.py), and
[single_tm.py](./backend/single_tm.py).

## 1. Literature review

### 1.1 From spectroscopy to population kinetics

Trivalent lanthanide ions have partially filled 4f shells. The 4f electrons are relatively shielded
by outer 5s and 5p shells, so the energies and transition strengths are influenced by both the ion
and its host lattice. Spectroscopic states are commonly described by Russell–Saunders term labels,
such as ³H₆, ³F₄, ³H₄, ¹G₄, ¹D₂, and ¹I₆. In a crystal, each multiplet is further split into
crystal-field Stark sublevels. Consequently, a term diagram is useful for identifying pathways,
but a single term energy is a host-dependent representative rather than an exact universal energy.
Carnall, Fields, and Rajnak provide a foundational compilation for trivalent lanthanide ions [1],
while host-specific measurements are preferable when the sample composition is known.

Radiative transitions between 4f states are often weak in the free-ion electric-dipole
approximation. Judd–Ofelt theory provides a framework for describing intensity borrowing and
estimating radiative transition probabilities in rare-earth ions [2, 3]. A kinetic model can use
branch rates \(A_{ij}\) to represent radiative depopulation and branching, but the existence of a
rate parameter in an ODE does not demonstrate that its value has been measured or that all
branching ratios are known. In this program, many rates begin at priors and may remain fixed during
a particular fit.

### 1.2 Upconversion, energy transfer, and relaxation

Upconversion is the production of higher-energy emission after absorption of lower-energy pump
photons. In lanthanide-doped solids, two important mechanisms are excited-state absorption (ESA)
and energy-transfer upconversion (ETU). ESA is sequential absorption by one ion that is already
excited. ETU instead involves energy exchange between two ions: an excited donor transfers energy
to an acceptor, promoting the acceptor and returning the donor toward a lower state. Auzel reviews
these mechanisms and their application in rare-earth solids [4].

The program represents ETU using population-dependent transfer fluxes. For example, its first
Yb-to-Tm transfer is proportional to \(W_1Y_{\mathrm{b,e}}T_{\mathrm{m,0}}\): the rate increases
with the excited-Yb donor population and the available Tm ground-state acceptor population. This
is a mean-field mass-action approximation. It does not resolve individual ion-pair distances,
orientations, clustering, migration, or a distribution of local environments.

The co-doped pathway is encoded as a sequence of effective transfers and relaxations:

\[
Yb_e + Tm_0 \xrightarrow{W_1} Yb_g + Tm_2,\quad
Tm_2 \xrightarrow{k_{21}} Tm_1,\quad
Yb_e + Tm_1 \xrightarrow{W_2} Yb_g + Tm_3,\quad
Tm_3 \xrightarrow{k_{35}} Tm_5.
\]

Here the model labels correspond to ³H₆ (Tm₀), ³F₄ (Tm₁), ³H₅ (Tm₂), ³F₂,₃ (Tm₃), ³H₄
(Tm₅), ¹G₄ (Tm₆), ¹D₂ (Tm₇), and ¹I₆ (Tm₈). Further ETU steps \(W_3,W_4,W_5\) promote
Tm₅→Tm₆→Tm₇→Tm₈. The emission observable is assigned to a radiative branch from the emitting
level, e.g. 775 nm from Tm₅, 477/645 nm from Tm₆, 362/452 nm from Tm₇, and 345 nm from Tm₈.
These are model assignments, not universal wavelength-to-term identities independent of host,
Stark splitting, or experimental spectrum.

Non-radiative multiphonon relaxation can compete with radiative decay and transfer population
between manifolds. The energy-gap law motivates a dependence of non-radiative rates on the energy
gap and host phonon spectrum; however, the program's host and annealing multipliers are empirical
scaling heuristics, not a microscopic calculation from measured phonon coupling or a fitted
energy-gap-law coefficient. Crystal structure, defects, dopant distribution, and temperature can
also affect observed lifetimes and transfer efficiency.

Cross-relaxation (CR) is an interaction in which an excited ion transfers part of its energy to a
neighboring ion, changing both populations. The model includes two Tm–Tm reactions:

\[
{}^3H_4+{}^3H_6\rightarrow 2\,{}^3F_4,\qquad
{}^1D_2+{}^3H_6\rightarrow{}^1G_4+{}^3F_4.
\]

Their rates are represented by bilinear population products and multiplied by entered Tm
concentration, with the program activating the branches above its stated concentration gates.
Likewise, ETU back-transfer from ³H₄ to ground-state Yb is switched on above the program's Yb
gate. Such thresholds are implementation choices motivated by the assumed model regime; they are
not universal phase boundaries. A mechanistic study should test these terms across concentration
series and compare fitted models rather than infer a reaction solely because the software exposes
its parameter.

Savinkov et al. measured the crystal-field structure of several Tm³⁺ multiplets in YF₃:Tm³⁺,
including ³H₆, ³H₅, ³H₄, ³F₄, ³F₂, ³F₃, and ¹G₄ [5]. Their data support using host-specific
reference energies to draw a diagram and emphasize that a term contains multiple Stark levels.
The rounded positions in the program's diagrams are for visualization only; they are not parameters
in the kinetic ODE. The higher ¹D₂ and ¹I₆ values are approximate reference positions, not values
established by that paper's reported multiplet set.

### 1.3 Why the inverse problem is not simply “read off the lifetime”

An emission trace is an indirect observation of hidden state populations. The model predicts a
state vector \(y(t)\), while the detector records an intensity related to one emitting population,
its radiative rate, optical collection, instrument response, and noise. In a simplified channel:

\[
I_{\mathrm{pred}}(t)=s\,\left[h_{\mathrm{IRF}} *
\left(A_{ij}n_i(t)\right)\right],
\]

where \(s\) is an unknown multiplicative scale, \(h_{\mathrm{IRF}}\) is the instrument-response
function, and \(*\) denotes convolution. The program uses a Gaussian IRF approximation whose width
is tied to sample interval and pulse width; it is not a measured instrument response. It also fits
normalized or scaled trace shapes. Therefore, a good fit does not by itself determine absolute
quantum yield, absolute concentration of excited ions, or every radiative branching probability.

When only one channel is observed, parameters can be confounded. For example, a normalized decay
may constrain the total loss rate from an observed state more strongly than its separate radiative
and non-radiative components. An unknown signal scale can trade off against rate amplitudes.
Upstream feeding rates may have similar effects on peak time or rise shape. Structural
identifiability asks whether ideal, noise-free observations could uniquely determine parameters;
practical identifiability asks whether the actual sampling and noise allow useful estimates.
Profile likelihood and sensitivity analysis are established tools for this distinction [6].
Additional emission channels, independent lifetime measurements, concentration series, and
independent pulse/IRF measurements can improve identifiability.

## 2. Methodology: from unknown observations to testable parameters

### 2.1 Formulate the experimental question

Start with the measured quantities and experimental conditions:

- the time axis and its units;
- excitation wavelength and pulse duration;
- emission channel or spectrally integrated window;
- host material and dopant concentrations;
- whether excitation is direct to Tm³⁺ or sensitized by Yb³⁺;
- known baseline, detector response, and instrument response information.

The time unit must be consistent. The code converts the entered pulse width in microseconds to
milliseconds and integrates kinetic rates in \(\mathrm{ms}^{-1}\). A rate reported in
\(\mathrm{s}^{-1}\) must be converted before comparing it numerically with a fitted backend
parameter.

### 2.2 Choose state variables and assumptions

Let \(n_i(t)\) denote the fractional population of model manifold \(i\). In a rate-equation model,
the state variables are not individual ion trajectories; they are ensemble-average populations.
The kinetics are written as

\[
\frac{d\mathbf{y}}{dt}=\mathbf{f}(t,\mathbf{y},\boldsymbol{\theta}),
\]

where \(\mathbf{y}\) contains populations and \(\boldsymbol{\theta}\) contains rates, concentrations,
pulse parameters, and nuisance parameters.

The current ETUC state vector is ordered as
\([Yb_g,Yb_e,Tm_0,Tm_1,Tm_2,Tm_3,Tm_4,Tm_5,Tm_6,Tm_7,Tm_8]\). \(Tm_4\) is currently
assigned zero derivative and serves as a placeholder; it is not a populated active manifold. The
direct-Tm vector is \([H6,F4,H4,G4,D2,I6,P2]\), with excitation destinations selected by wavelength.

These are simplified models: they assume homogeneous populations within each manifold, effective
first-order radiative/non-radiative rates, and mean-field ETU/CR fluxes. The direct-Tm model's
optional Yb effect is only a sink from selected excited Tm manifolds; it is not an explicit
Yb excitation-and-relaxation model. In particular, the direct-Tm model must not be interpreted as
simulating Yb-sensitized ETUC.

### 2.3 Translate mechanisms into fluxes and ODE terms

For a one-way first-order transition \(i\to j\) with rate \(k\), the flux is
\(v=k n_i\). Its contribution is \(-v\) to \(dn_i/dt\) and \(+v\) to \(dn_j/dt\). For a
bimolecular reaction with two distinct reactants \(i\) and \(j\), a mean-field flux is
\(v=k n_i n_j\), with stoichiometric coefficients applied to all reactants and products.
Writing each reaction as a flux before assembling the ODE makes conservation checks tractable.

For the direct-Tm model, a finite square pulse gives a pump term \(G n_0\) during the pulse and
zero thereafter. With stepwise excitation, an ESA flux \(G_2n_{\mathrm{entry}}\) moves population
from the entry manifold to an upper manifold only while the pulse is on. The code initializes the
sample in the Tm ground state and sets excited-state populations to zero.

For ETUC, the Yb pump transfers population between \(Yb_g\) and \(Yb_e\). Each ETU rate is
proportional to \(Yb_e\) and its Tm acceptor population. The equations also include \(k_{21}\),
\(k_{35}\), radiative branches, concentration-gated cross-relaxation, and concentration-gated
back-transfer. The fitting code initializes Yb and Tm populations from entered molar percentages
converted to fractions; this differs from the normalized single-Tm model's \(H6(0)=1\).

In compact notation, let \(x_i=Tm_i\), let \(p(t)=R_p\) during the pump pulse and \(p(t)=0\)
afterwards, and define the aggregate ETU flux per excited Yb ion

\[
Q=W_1x_0+W_2x_1+W_3x_5+W_4x_6+W_5x_7.
\]

The implemented Yb equations are

\[
\dot Y_g=-pY_g+A_yY_e+Y_eQ-B,\qquad
\dot Y_e=pY_g-A_yY_e-Y_eQ+B,
\]

where \(B=W_bx_5Y_g\) only when the Yb concentration exceeds 10.0 mol%.
Define \(C_H=W_{\mathrm{cr,H4}}x_5x_0\) when Tm concentration exceeds 1.0 mol%, otherwise
\(C_H=0\), and \(C_G=W_{\mathrm{cr,G4}}x_6x_0\) when it exceeds 0.1 mol%, otherwise \(C_G=0\).
The active Tm equations are

\[
\begin{aligned}
\dot x_0={}&A_{10}x_1+A_{50}x_5+A_{60}x_6+A_{70}x_7-W_1Y_ex_0-C_H-C_G+B,\\
\dot x_1={}&k_{21}x_2+A_{61}x_6+A_{71}x_7+A_{81}x_8
             +2C_H+C_G-A_{10}x_1-W_2Y_ex_1,\\
\dot x_2={}&W_1Y_ex_0-k_{21}x_2,\\
\dot x_3={}&W_2Y_ex_1-k_{35}x_3,\\
\dot x_4={}&0,\\
\dot x_5={}&k_{35}x_3-A_{50}x_5-C_H+C_G-W_3Y_ex_5-B,\\
\dot x_6={}&W_3Y_ex_5-(A_{60}+A_{61})x_6-W_4Y_ex_6-C_G,\\
\dot x_7={}&W_4Y_ex_6-(A_{70}+A_{71})x_7-W_5Y_ex_7,\\
\dot x_8={}&W_5Y_ex_7-A_{81}x_8.
\end{aligned}
\]

The \(2C_H\) term counts the two ³F₄ products of the H₄ cross-relaxation reaction; \(C_G\)
contributes one ³F₄ and one ¹G₄ product. The current equations therefore conserve the tracked
Tm ion total under internal transfer, radiative branching, and these CR reactions, apart from
numerical error. The complete seven-state direct-Tm equations, excitation mapping, and emission
assignments are given in [README_single_doped_Tm_ODE.md](./README_single_doped_Tm_ODE.md).

For every reaction, check the stoichiometric bookkeeping. In the absence of sources and sinks,
Yb population should be conserved by pump, decay, ETU, and back-transfer. Tm population should be
conserved by internal transfer, relaxation, radiative branching, and the modeled CR reactions
when all product stoichiometry is included. For an ODE with a pump and radiative transitions to
the ground manifold, the total tracked ion population should remain constant up to numerical error.
These invariants are valuable unit tests, but do not alone prove that the physical pathway is
correct.

### 2.4 Define the observable and data treatment

The model selects an emitting manifold and maps its population to an emission observable. In direct
Tm mode, the code uses a channel rate times the corresponding manifold population (for example,
\(A_{30}H4\) for the 775 nm model signal), applies a fitted scale, and convolves with an approximate
Gaussian IRF. In ETUC, the code uses the appropriate state population; the 477 and 645 nm branches
are explicitly mapped to their respective radiative-rate-weighted Tm₆ signals.

This observation model should be revised if independent measurements provide a calibrated IRF,
absolute photon counts, or detector spectral sensitivity. A baseline or time-zero offset should be
included only when supported by the acquisition and fitting design. The code fits a time offset and
allows pulse-width optimization within configured bounds; these nuisance parameters can correlate
with pump and feeding rates.

### 2.5 Numerical integration in the implemented program

The fitting objective requires many forward ODE solutions. Accuracy and stability must therefore be
balanced against optimizer cost.

| Method | Principle and strengths | Limitations and appropriate use |
|---|---|---|
| Explicit Euler | \(y_{k+1}=y_k+h f(t_k,y_k)\). Very simple, transparent, and useful for hand calculations and teaching. | First-order accuracy and a restrictive stability limit for fast decays. A step that is acceptable for slow manifolds can destabilize fast channels or produce negative populations. Not the production solver here. |
| Classical RK4 | Four explicit slope evaluations per step; global error is \(O(h^4)\) for smooth solutions at fixed step size. Useful for non-stiff problems and a transparent benchmark. | A fixed step still has a stability restriction. Increasing order does not remove stiffness; pulse discontinuities require placing a step boundary exactly at pulse-off. Not the production solver here. |
| Radau | Implicit Radau IIA collocation method; SciPy's `Radau` is fifth-order and designed for stiff problems, with an embedded error estimate. Robust for systems containing widely separated time scales. | Each step is more expensive than an explicit method, and nonlinear systems must be solved internally. Used by the current ETUC forward/fitting path. |
| LSODA | ODEPACK solver that automatically switches between non-stiff Adams and stiff BDF formulas based on stiffness detection. Convenient when stiffness is uncertain or changes over time. | Automatic switching is not a guarantee of lower cost or higher accuracy in every case; tolerances and solver success still require checking. Used by the current direct-Tm model. |

The exact program configuration is `solve_ivp(method="Radau")` for ETUC and
`solve_ivp(method="LSODA")` for direct-Tm excitation, with relative and absolute tolerances staged
during optimization. The single-Tm implementation explicitly integrates from time zero to pulse-off
and then continues with the pump off. The ETUC right-hand side switches pump off at the pulse
boundary during a single integration. For a discontinuous right-hand side, a stronger numerical
protocol is to split the ETUC solve exactly at pulse-off too, then compare the resulting trace and
fit to the current implementation.

Euler and RK4 are useful educational and independent verification methods, not necessarily
replacement solvers. A sound comparison uses the same model, initial state, pulse boundary, output
times, and tolerances. Reduce explicit step size systematically and compare against a tight-tolerance
Radau/LSODA solution. Check maximum absolute and relative trace differences, population
non-negativity, conservation residuals, and the stability of fitted parameters. Agreement at one
output grid is weaker evidence than convergence as the step size or error tolerance is tightened.

### 2.6 Parameter estimation: from trace mismatch to fitted values

The fitting procedure is a bounded nonlinear inverse problem. In outline, the program:

1. selects parameters judged relevant to the excitation, emission, concentration, and active
   pathway; other parameters are fixed at priors or defaults;
2. samples a reduced set of data points when requested by the fit-quality mode, retaining broad
   time coverage and emphasizing rise/peak regions;
3. generates candidate parameter sets using differential evolution, a stochastic global-search
   algorithm;
4. refines candidates with bounded trust-region reflective least squares (`least_squares`, method
   `trf`), initially using a robust `soft_l1` loss;
5. re-evaluates the selected parameters on the full trace and may apply adaptive, tail-focused, or
   pulse-width refinement steps depending on model and fit conditions;
6. reports fit metrics such as \(R^2\) and timing measures.

The residual combines linear and logarithmic trace differences, with weighting and additional
emphasis on regions such as the peak, early rise, and tail. Thus the optimizer's target is not
always identical to unweighted ordinary least squares or to maximum likelihood under a specified
noise distribution. A reported \(R^2\) is a descriptive goodness-of-fit statistic, not proof of a
unique mechanism, correct uncertainty, or predictive validity.

The direct-Tm model groups the observed state's radiative rates into a common fitted scale in
specified cases because a normalized trace generally cannot separate all observed-state branches.
This is a sensible reduction of the inverse problem, but it preserves the assumed prior branching
ratios; it does not measure them independently. The ETUC model also fits only selected parameter
subsets per emission and concentration regime. Therefore, fitted and fixed parameters must be
distinguished clearly in scientific reporting.

### 2.7 Validation and reporting protocol

Before interpreting fitted constants physically, the following checks are recommended:

1. **Equation verification:** trace each code term to a written reaction and stoichiometric change.
   Unit-test the ODE right-hand side against simple limiting cases.
2. **Conservation and positivity:** test total-ion balance and ensure negative populations are
   negligible at the chosen solver tolerances. Do not silently clip state populations inside the
   kinetic equations to hide integration problems.
3. **Solver convergence:** compare Radau/LSODA tolerances and, for selected test cases, an
   independently implemented high-accuracy reference. Split integrations at pulse discontinuities.
4. **Residual inspection:** plot residuals against time and inspect baseline, early rise, peak,
   crossover, and tail separately. A high \(R^2\) can hide systematic errors in a low-amplitude
   but mechanistically important region.
5. **Identifiability:** inspect parameter correlations, local sensitivities, repeated initial
   guesses, and profile likelihood or bootstrap intervals. Report bounds and parameters fixed to
   priors.
6. **Model comparison:** compare nested pathway hypotheses (for example with/without CR or
   back-transfer) using an appropriate likelihood or information criterion, concentration-series
   consistency, and residual structure. Gating terms should be tested against data, not accepted
   only because a fit improves.
7. **External validation:** fit selected conditions and predict withheld concentrations, pulse
   widths, or emission channels where the model supports them. Do not call a fitted trace an
   independent validation trace.
8. **Reproducibility:** record the exact code revision, data preprocessing, units, excitation,
   emission, concentrations, host, pulse, fixed priors, free parameters, solver, tolerances,
   optimizer settings, random seed, and convergence diagnostics.

In a manuscript, distinguish (i) spectroscopic evidence for a manifold, (ii) assumed reaction
topology, (iii) numerically fitted effective rate parameters, and (iv) independent physical
measurements. These are four different levels of evidence.

## 3. Suggested academic methodology text

The following can be adapted for a thesis after replacing bracketed details with the experiment's
actual conditions and adding the specific dataset and instrument citations:

> Time-resolved emission was interpreted using a phenomenological population-rate model for
> Tm³⁺- and Yb³⁺-doped material. The state vector comprised the ground and excited manifolds
> represented in the selected excitation model. Population transfer was described by coupled
> ordinary differential equations. First-order radiative and non-radiative processes were
> represented by linear population terms, while ETU and cross-relaxation were represented by
> mean-field products of donor and acceptor populations. A finite pump pulse was applied as a
> piecewise-constant excitation term, with the pump removed after the measured pulse duration.
> The initial populations were set according to the selected model and entered dopant
> concentrations.
>
> The predicted emission signal was calculated from the population of the assigned emitting
> manifold and its channel-specific radiative-rate factor. The predicted signal was scaled to the
> measured intensity and convolved with the instrument-response representation used by the
> software. Kinetic parameters were estimated by bounded nonlinear optimization. Differential
> evolution was used to identify candidate parameter regions, followed by trust-region reflective
> least-squares refinement. The residual objective included weighted linear and logarithmic
> discrepancies, with additional emphasis on selected temporal regions. Parameters outside the
> active pathway were held at their specified priors. The reported fitted constants should
> therefore be interpreted as effective parameters conditional on the assumed state scheme,
> observable mapping, fixed priors, concentration gates, and pulse/response model.
>
> The ETUC system was integrated using the implicit Radau method and the direct-Tm system using
> LSODA, with relative and absolute error tolerances specified in the computational configuration.
> The direct-Tm pulse-on and pulse-off intervals were integrated separately. Numerical adequacy
> was assessed by [insert actual solver/tolerance convergence tests], and model adequacy was
> assessed from [insert residual analysis, identifiability analysis, independent validation, and
> model-comparison procedure actually performed]. Unless those tests are completed, this last
> sentence should not imply that they were performed.

**Important:** do not claim the placeholder ETUC state is a physical population, that the GUI energy
diagram energies enter the ODE, that direct-Tm mode dynamically models Yb, or that an approximate
IRF is a measured IRF.

## 4. Learning curriculum: from unknowns to a defensible model

This curriculum is designed as a six-module sequence. A learner can complete it over six weeks
(approximately 3–5 hours each week), or use the modules as examination preparation. Each module
ends with a small product that can be discussed orally.

| Module | Learning goals | Study and practice | Checkpoint |
|---|---|---|---|
| **1. Spectroscopy and level diagrams** | Read term symbols; distinguish multiplets from Stark sublevels; explain host dependence, radiative transition, and non-radiative relaxation. | Read the Tm³⁺ sections of Carnall et al. and the YF₃:Tm³⁺ study [1, 5]. Draw a level diagram and annotate which energies are measured, approximate, or merely schematic. | Explain why a level diagram's cm⁻¹ axis is not a rate equation and why host-specific data matter. |
| **2. Mechanism to reaction network** | Distinguish direct excitation, ESA, ETU, CR, back-transfer, and multiphonon relaxation. | Read Auzel [4]. Translate each proposed process into a reaction, donor/acceptor, and stoichiometric vector. Mark processes not represented by the current code. | Given a reaction, write its flux and identify each gain/loss term. |
| **3. ODE construction and units** | Derive \(d\mathbf{y}/dt=S\mathbf{v}\); track units; check initial conditions, conservation, and concentration scaling. | Re-derive one ETU step, one CR step, and one pump term on paper. Verify the Yb and Tm balance equations by summing derivatives. | Demonstrate that every term has units of population per time and explain the mol%-scaled effective coefficient caveat. |
| **4. Numerical methods and stiffness** | Explain local/global error, stability, adaptivity, stiffness, and pulse discontinuities; compare Euler, RK4, Radau, and LSODA. | Implement Euler and RK4 for a two-state decay, then compare to a tight-tolerance implicit solve. Repeat with one fast and one slow rate and with a pulse-off boundary. Read SciPy's `solve_ivp` documentation [7] and Hindmarsh/Petzold [8, 9]. | Explain why a fine-looking Euler curve can still have biased fitted rates, and why Radau/LSODA are used here. |
| **5. Inverse problems and identifiability** | Separate forward simulation from parameter estimation; understand bounds, priors, residual weights, nuisance parameters, and confounding. | Fit a synthetic trace with known parameters. Change one prior, remove one emission channel, and compare parameter estimates. Read Raue et al. [6]. | State which parameters are estimable from one normalized channel and which are conditional on priors or grouped rates. |
| **6. Model criticism and examination defense** | Evaluate whether a pathway is supported, not merely drawable or fit-able; design solver, residual, and holdout checks. | Prepare a short methods section and a 5-minute defense of one fitted route. Include residual plots, a solver/tolerance check, one identifiability limitation, and one alternative model. | Defend the difference between numerical convergence, statistical fit quality, parameter identifiability, and physical validation. |

### Capstone exercise

1. Choose one dataset and write down its units, excitation/emission, composition, pulse, and IRF
   knowledge before running the optimizer.
2. Draw the smallest reaction network consistent with the hypothesized route.
3. Derive at least three ODE terms from stoichiometry by hand and compare them term-for-term with
   the implementation.
4. Fit a baseline model and one competing model; compare residual shapes and parameter stability,
   not only \(R^2\).
5. Repeat the forward solve at tighter tolerances and with an independent solver. For an explicit
   educational solver, halve the step size repeatedly and document convergence.
6. Identify two parameter combinations that may be confounded and propose an additional
   measurement or experimental condition that could separate them.
7. Present a one-page results summary that labels measured values, fixed priors, fitted effective
   rates, and uncertain mechanistic assumptions separately.

## References

1. W. T. Carnall, P. R. Fields, and K. Rajnak, “Electronic Energy Levels in the Trivalent
   Lanthanide Aquo Ions. I. Pr³⁺, Nd³⁺, Pm³⁺, Sm³⁺, Dy³⁺, Ho³⁺, Er³⁺, and Tm³⁺,” *The Journal of
   Chemical Physics* **49**(10), 4424–4442 (1968). https://doi.org/10.1063/1.1669893
2. B. R. Judd, “Optical Absorption Intensities of Rare-Earth Ions,” *Physical Review* **127**(3),
   750–761 (1962). https://doi.org/10.1103/PhysRev.127.750
3. G. S. Ofelt, “Intensities of Crystal Spectra of Rare-Earth Ions,” *The Journal of Chemical
   Physics* **37**(3), 511–520 (1962). https://doi.org/10.1063/1.1701366
4. F. Auzel, “Upconversion and Anti-Stokes Processes with f and d Ions in Solids,” *Chemical
   Reviews* **104**(1), 139–174 (2004). https://doi.org/10.1021/cr020357g
5. A. V. Savinkov, G. S. Shakurov, I. E. Mumdzhi, et al., “Spectral and magnetic properties of
   impurity Tm³⁺ ions in YF₃,” *Magnetic Resonance in Solids* **19**(2), 17202 (2017).
   https://mrsej.kpfu.ru/contents/2017/MRSej_17202.pdf
6. A. Raue, C. Kreutz, T. Maiwald, et al., “Structural and practical identifiability analysis of
   partially observed dynamical models by exploiting the profile likelihood,” *Bioinformatics*
   **25**(15), 1923–1929 (2009). https://doi.org/10.1093/bioinformatics/btp358
7. SciPy Community, “`scipy.integrate.solve_ivp` — solve an initial value problem for a system of
   ODEs,” SciPy Reference Guide. https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html
8. A. C. Hindmarsh, “ODEPACK, A Systematized Collection of ODE Solvers,” in *Scientific Computing*,
   R. S. Stepleman et al., eds., North-Holland, 1983, pp. 55–64.
9. L. Petzold, “Automatic selection of methods for solving stiff and nonstiff systems of ordinary
   differential equations,” *SIAM Journal on Scientific and Statistical Computing* **4**(1),
   136–148 (1983). https://doi.org/10.1137/0904010
10. E. Hairer and G. Wanner, *Solving Ordinary Differential Equations II: Stiff and
    Differential-Algebraic Problems*, 2nd ed., Springer, 1996. https://doi.org/10.1007/978-3-642-05221-7
