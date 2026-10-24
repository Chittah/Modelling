# Yb³⁺/Tm³⁺ co-doped YF₃ model: cross-relaxation, back-transfer, equations and parameter definitions

## Scope and interpretation

This document specifies the coupled eleven-state Yb³⁺/Tm³⁺ rate-equation model implemented by
`UCOdeModel.system` in `app.py` (mirrored in `Tm_test\test.py` and `copy\app.py`). It adds two
concentration-gated Tm–Tm cross-relaxation (CR) channels and a concentration-gated Tm→Yb back
energy transfer (BET) to the Yb-sensitized upconversion cascade. It is a phenomenological kinetic
model for fitting normalized time-resolved emission traces; it is not, by itself, evidence that
every included process or numerical rate is correct for a particular specimen.

The separate reduced seven-state single-Tm model is described in
`Tm_test\README_single_doped_Tm_ODE.md`. Its state indices differ from those used here (see the
final section) and it must not be mixed with the tables below.

The listed default values are software starting values, not certified literature constants.

**Notation used throughout**

- Every ODE is written with **population (gain) terms first, with a + sign**, followed by
  **depopulation (loss) terms, with a − sign**.
- Cross-relaxation events are identified uniquely by their rates: \(r_1\) (CR-G4) and
  \(r_2\) (CR-H4). The back-transfer event is \(r_{\mathrm{BET}}\). The names
  \(W_{\mathrm{cr,G4}}\) and \(W_{\mathrm{cr,H4}}\) are rate coefficients only and appear solely in
  the definitions of \(r_1\) and \(r_2\).

## State vector and units

| Variable | Index in code | Level | Role |
|---|---|---|---|
| \(Yb_g\) | `y[0]` | \(^{2}F_{7/2}\) | Yb ground state |
| \(Yb_e\) | `y[1]` | \(^{2}F_{5/2}\) | Yb excited (sensitizer) state |
| \(Tm_0\) | `y[2]` | \(^{3}H_6\) | Tm ground state |
| \(Tm_1\) | `y[3]` | \(^{3}F_4\) | Lower metastable state |
| \(Tm_2\) | `y[4]` | \(^{3}H_5\) | Fast non-radiative intermediate |
| \(Tm_3\) | `y[5]` | \(^{3}F_{2,3}\) | Phonon-relaxing intermediate |
| \(Tm_4\) | `y[6]` | — | Inactive placeholder (\(dTm_4/dt=0\)) |
| \(Tm_5\) | `y[7]` | \(^{3}H_4\) | 775 nm emitting state |
| \(Tm_6\) | `y[8]` | \(^{1}G_4\) | 477 nm and 645 nm emitting state |
| \(Tm_7\) | `y[9]` | \(^{1}D_2\) | 362 nm and 452 nm emitting state |
| \(Tm_8\) | `y[10]` | \(^{1}I_6\) | 345 nm emitting state |

Time is in milliseconds and populations are dimensionless normalized fractions, so every
first-order rate (\(R_p, A, W, k\)) is numerically in \(\mathrm{ms}^{-1}\). Do not report these as
\(\mathrm{s}^{-1}\) without multiplying by 1000.

## Governing equations

### Concentration gates and the uniquely labelled rates

With \(c_{\mathrm{Tm}}\) and \(c_{\mathrm{Yb}}\) in mol%:

\[
\chi_{\mathrm{G4}}=\mathbf{1}[c_{\mathrm{Tm}}>0.1],\qquad
\chi_{\mathrm{H4}}=\mathbf{1}[c_{\mathrm{Tm}}\ge1.0],\qquad
\chi_{\mathrm{BET}}=\mathbf{1}[c_{\mathrm{Yb}}>10.0].
\]

\[
\begin{aligned}
r_1&=\chi_{\mathrm{G4}}\,W_{\mathrm{cr,G4}}\,Tm_6Tm_0,
&&{}^{1}G_4+{}^{3}H_6\to{}^{3}H_4+{}^{3}F_4 \quad(\text{CR-G4}),\\
r_2&=\chi_{\mathrm{H4}}\,W_{\mathrm{cr,H4}}\,Tm_5Tm_0,
&&{}^{3}H_4+{}^{3}H_6\to2\,{}^{3}F_4 \quad(\text{CR-H4}),\\
r_{\mathrm{BET}}&=\chi_{\mathrm{BET}}\,W_b\,Tm_5Yb_g,
&&{}^{3}H_4+\mathrm{Yb}({}^{2}F_{7/2})\to{}^{3}H_6+\mathrm{Yb}({}^{2}F_{5/2}).
\end{aligned}
\]

The \(^{1}G_4\) CR and BET gates are strict (off at exactly 0.1 mol% Tm and 10 mol% Yb); the
\(^{3}H_4\) CR gate is inclusive (on at exactly 1.0 mol% Tm). The gates encode the requested
concentration regimes; they do not imply an abrupt physical transition at those compositions.

| Composition | Active extra channels | Qualitative effect |
|---|---|---|
| Tm \(\le0.1\) mol% | none | No concentration-gated CR. |
| \(0.1<\) Tm \(<1.0\) mol% | \(r_1\) | Depletes \(^{1}G_4\) (blue quenching), feeds \(^{3}H_4\) (775 nm enhancement). |
| Tm \(\ge1.0\) mol% | \(r_1\) and \(r_2\) | \(r_2\) drains \(^{3}H_4\) and can offset the \(r_1\) enhancement. |
| Yb \(\le10\) mol% | none | No back-transfer. |
| Yb \(>10\) mol% | \(r_{\mathrm{BET}}\) | Extra \(^{3}H_4\) loss; excites Yb. |

The gates are independent and can be active simultaneously.

### General summation form

Collect the states in \(\mathbf{x}=(Yb_g,Yb_e,Tm_0,\ldots,Tm_8)\) and number the elementary events
\(j\in\mathcal{R}\) (table below). Let \(\nu_{ij}\) be the net change of state \(i\) per event \(j\),
and \(\nu_{ij}^{+}=\max(\nu_{ij},0)\), \(\nu_{ij}^{-}=\max(-\nu_{ij},0)\). Then

\[
\boxed{\displaystyle
\frac{dx_i}{dt}
=\underbrace{\sum_{j\in\mathcal{R}}\nu_{ij}^{+}\,r_j(\mathbf{x},t)}_{\text{population (+)}}
-\underbrace{\sum_{j\in\mathcal{R}}\nu_{ij}^{-}\,r_j(\mathbf{x},t)}_{\text{depopulation (−)}},
\qquad i=1,\ldots,11.}
\]

States not listed in a row have \(\nu_{ij}=0\). \(R_p(t)=R_p\) for \(t\le t_p\) and zero afterwards.

| Event \(j\) | Rate \(r_j\) | Nonzero \(\nu_{ij}\) |
|---|---|---|
| Yb pump | \(R_p(t)Yb_g\) | \(Yb_g\,{-}1,\ Yb_e\,{+}1\) |
| Yb decay | \(A_yYb_e\) | \(Yb_e\,{-}1,\ Yb_g\,{+}1\) |
| ET1 | \(W_1Yb_eTm_0\) | \(Yb_e{-}1,\ Yb_g{+}1,\ Tm_0{-}1,\ Tm_2{+}1\) |
| ET2 | \(W_2Yb_eTm_1\) | \(Yb_e{-}1,\ Yb_g{+}1,\ Tm_1{-}1,\ Tm_3{+}1\) |
| ET3 | \(W_3Yb_eTm_5\) | \(Yb_e{-}1,\ Yb_g{+}1,\ Tm_5{-}1,\ Tm_6{+}1\) |
| ET4 | \(W_4Yb_eTm_6\) | \(Yb_e{-}1,\ Yb_g{+}1,\ Tm_6{-}1,\ Tm_7{+}1\) |
| ET5 | \(W_5Yb_eTm_7\) | \(Yb_e{-}1,\ Yb_g{+}1,\ Tm_7{-}1,\ Tm_8{+}1\) |
| \(k_{21}\) | \(k_{21}Tm_2\) | \(Tm_2{-}1,\ Tm_1{+}1\) |
| \(k_{35}\) | \(k_{35}Tm_3\) | \(Tm_3{-}1,\ Tm_5{+}1\) |
| \(A_{10}\) | \(A_{10}Tm_1\) | \(Tm_1{-}1,\ Tm_0{+}1\) |
| \(A_{50}\) | \(A_{50}Tm_5\) | \(Tm_5{-}1,\ Tm_0{+}1\) |
| \(A_{60}\) | \(A_{60}Tm_6\) | \(Tm_6{-}1,\ Tm_0{+}1\) |
| \(A_{61}\) | \(A_{61}Tm_6\) | \(Tm_6{-}1,\ Tm_1{+}1\) |
| \(A_{70}\) | \(A_{70}Tm_7\) | \(Tm_7{-}1,\ Tm_0{+}1\) |
| \(A_{71}\) | \(A_{71}Tm_7\) | \(Tm_7{-}1,\ Tm_1{+}1\) |
| \(A_{81}\) | \(A_{81}Tm_8\) | \(Tm_8{-}1,\ Tm_1{+}1\) |
| CR-G4 | \(r_1\) | \(Tm_6{-}1,\ Tm_0{-}1,\ Tm_5{+}1,\ Tm_1{+}1\) |
| CR-H4 | \(r_2\) | \(Tm_5{-}1,\ Tm_0{-}1,\ Tm_1{+}2\) |
| BET | \(r_{\mathrm{BET}}\) | \(Tm_5{-}1,\ Yb_g{-}1,\ Tm_0{+}1,\ Yb_e{+}1\) |

Each CR and BET event conserves the total number of tracked Tm ions through its coefficients.

### Specific equations for all 11 states (population first, then depopulation)

Define the total Yb→Tm transfer factor
\(E_{\mathrm{Tm}}=W_1Tm_0+W_2Tm_1+W_3Tm_5+W_4Tm_6+W_5Tm_7\).

\[
\begin{aligned}
\frac{dYb_g}{dt}={}&A_yYb_e+Yb_eE_{\mathrm{Tm}}-R_p(t)Yb_g-r_{\mathrm{BET}},\\[2pt]
\frac{dYb_e}{dt}={}&R_p(t)Yb_g+r_{\mathrm{BET}}-A_yYb_e-Yb_eE_{\mathrm{Tm}},\\[2pt]
\frac{dTm_0}{dt}={}&A_{10}Tm_1+A_{50}Tm_5+A_{60}Tm_6+A_{70}Tm_7+r_{\mathrm{BET}}
-W_1Yb_eTm_0-r_1-r_2,\\[2pt]
\frac{dTm_1}{dt}={}&k_{21}Tm_2+A_{61}Tm_6+A_{71}Tm_7+A_{81}Tm_8+r_1+2r_2
-A_{10}Tm_1-W_2Yb_eTm_1,\\[2pt]
\frac{dTm_2}{dt}={}&W_1Yb_eTm_0-k_{21}Tm_2,\\[2pt]
\frac{dTm_3}{dt}={}&W_2Yb_eTm_1-k_{35}Tm_3,\\[2pt]
\frac{dTm_4}{dt}={}&0,\\[2pt]
\frac{dTm_5}{dt}={}&k_{35}Tm_3+r_1
-A_{50}Tm_5-W_3Yb_eTm_5-r_2-r_{\mathrm{BET}},\\[2pt]
\frac{dTm_6}{dt}={}&W_3Yb_eTm_5
-(A_{60}+A_{61})Tm_6-W_4Yb_eTm_6-r_1,\\[2pt]
\frac{dTm_7}{dt}={}&W_4Yb_eTm_6
-(A_{70}+A_{71})Tm_7-W_5Yb_eTm_7,\\[2pt]
\frac{dTm_8}{dt}={}&W_5Yb_eTm_7-A_{81}Tm_8.
\end{aligned}
\]

With the rates written out, the three equations that carry the new physics are

\[
\begin{aligned}
\frac{dTm_5}{dt}&=k_{35}Tm_3+\chi_{\mathrm{G4}}W_{\mathrm{cr,G4}}Tm_6Tm_0
-A_{50}Tm_5-W_3Yb_eTm_5-\chi_{\mathrm{H4}}W_{\mathrm{cr,H4}}Tm_5Tm_0-\chi_{\mathrm{BET}}W_bTm_5Yb_g,\\
\frac{dTm_6}{dt}&=W_3Yb_eTm_5
-(A_{60}+A_{61})Tm_6-W_4Yb_eTm_6-\chi_{\mathrm{G4}}W_{\mathrm{cr,G4}}Tm_6Tm_0,\\
\frac{dTm_0}{dt}&=A_{10}Tm_1+A_{50}Tm_5+A_{60}Tm_6+A_{70}Tm_7+\chi_{\mathrm{BET}}W_bTm_5Yb_g
-W_1Yb_eTm_0-r_1-r_2.
\end{aligned}
\]

## Excitation terms

There is no direct pump on any Tm state. Excitation enters only through \(Yb_g\): while
\(t\le t_p\), the term \(R_pYb_g\) moves population into \(Yb_e\), which then feeds the Tm ladder
through ET1–ET5 in sequence
(\(^{3}H_6\to{}^{3}H_5\), \(^{3}F_4\to{}^{3}F_{2,3}\), \(^{3}H_4\to{}^{1}G_4\),
\(^{1}G_4\to{}^{1}D_2\), \(^{1}D_2\to{}^{1}I_6\)). The pump is a rectangular pulse of width
\(t_p\); \(R_p\) is an effective rate, not computed from a cross-section and photon flux.

## Emission mechanism and the reasoning behind each equation

```text
   ¹I₆  (Tm₈) ◄── ET5 ── ¹D₂ (Tm₇)   Tm₈ ──A₈₁──► ³F₄   345 nm
   ¹D₂  (Tm₇) ◄── ET4 ── ¹G₄ (Tm₆)   Tm₇ ──A₇₁──► ³F₄   452 nm,  A₇₀ ──► ³H₆  362 nm
   ¹G₄  (Tm₆) ◄── ET3 ── ³H₄ (Tm₅)   Tm₆ ──A₆₀──► ³H₆   477 nm,  A₆₁ ──► ³F₄  645 nm
   ³H₄  (Tm₅) ◄── k₃₅ ── ³F₂,₃ (Tm₃) Tm₅ ──A₅₀──► ³H₆   775 nm
   ³F₂,₃(Tm₃) ◄── ET2 ── ³F₄ (Tm₁)
   ³H₅  (Tm₂) ◄── ET1 ── ³H₆ (Tm₀);  k₂₁: Tm₂ ──► Tm₁ ;  A₁₀: Tm₁ ──► Tm₀

 Cross-relaxation:
   r1 (Tm > 0.1 %) : ¹G₄ + ³H₆ ──► ³H₄ + ³F₄   (blue quenching, 775 nm gain)
   r2 (Tm ≥ 1.0 %) : ³H₄ + ³H₆ ──► 2 ³F₄       (775 nm quenching)
 Back-transfer (Yb > 10 %):
   r_BET : ³H₄ + Yb(²F₇/₂) ──► ³H₆ + Yb(²F₅/₂)
```

| Level | Gains (+) | Losses (−) | Reason |
|---|---|---|---|
| \(Yb_g\) | \(A_yYb_e\), \(Yb_eE_{\mathrm{Tm}}\) | \(R_pYb_g\), \(r_{\mathrm{BET}}\) | Pump excites it; decay and all transfers return it; BET consumes it. |
| \(Yb_e\) | \(R_pYb_g\), \(r_{\mathrm{BET}}\) | \(A_yYb_e\), \(Yb_eE_{\mathrm{Tm}}\) | Sensitizer reservoir; BET re-excites it. |
| \(Tm_0\) (³H₆) | \(A_{10}Tm_1\), \(A_{50}Tm_5\), \(A_{60}Tm_6\), \(A_{70}Tm_7\), \(r_{\mathrm{BET}}\) | \(W_1Yb_eTm_0\), \(r_1\), \(r_2\) | CR uses a ground-state ion as partner; BET restores one. |
| \(Tm_1\) (³F₄) | \(k_{21}Tm_2\), \(A_{61}Tm_6\), \(A_{71}Tm_7\), \(A_{81}Tm_8\), \(r_1\), \(2r_2\) | \(A_{10}Tm_1\), \(W_2Yb_eTm_1\) | Collects decay and both CR products. |
| \(Tm_2\) (³H₅) | \(W_1Yb_eTm_0\) | \(k_{21}Tm_2\) | Fast non-radiative relay. |
| \(Tm_3\) (³F₂,₃) | \(W_2Yb_eTm_1\) | \(k_{35}Tm_3\) | Relaxes to ³H₄. |
| \(Tm_4\) | — | — | Inactive. |
| \(Tm_5\) (³H₄, 775 nm) | \(k_{35}Tm_3\), \(r_1\) | \(A_{50}Tm_5\), \(W_3Yb_eTm_5\), \(r_2\), \(r_{\mathrm{BET}}\) | \(r_1\) enhances 775 nm; \(r_2\) and BET add losses. |
| \(Tm_6\) (¹G₄, 477/645 nm) | \(W_3Yb_eTm_5\) | \((A_{60}+A_{61})Tm_6\), \(W_4Yb_eTm_6\), \(r_1\) | \(r_1\) is the blue-quenching term. |
| \(Tm_7\) (¹D₂, 362/452 nm) | \(W_4Yb_eTm_6\) | \((A_{70}+A_{71})Tm_7\), \(W_5Yb_eTm_7\) | — |
| \(Tm_8\) (¹I₆, 345 nm) | \(W_5Yb_eTm_7\) | \(A_{81}Tm_8\) | \(A_{80}\equiv0\) in this system. |

These descriptions follow the implemented equations, not a claim that every intermediate
manifold or relaxation route is resolved.

## Parameter definitions

All defaults are the initialization values of `_default_kinetic_params()` in \(\mathrm{ms}^{-1}\).

| Symbol | Transition or role | Default |
|---|---|---|
| \(R_p\) | Effective Yb pump rate during the pulse | 5.0 |
| \(A_y\) | Yb \(^{2}F_{5/2}\) spontaneous decay | 1.0 |
| \(W_1\) | ET1, Yb→Tm (\(^{3}H_6\to{}^{3}H_5\)) | 5.0 |
| \(W_2\) | ET2, Yb→Tm (\(^{3}F_4\to{}^{3}F_{2,3}\)) | 5.0 |
| \(W_3\) | ET3, Yb→Tm (\(^{3}H_4\to{}^{1}G_4\)) | 2.0 |
| \(W_4\) | ET4, Yb→Tm (\(^{1}G_4\to{}^{1}D_2\)) | 1.0 |
| \(W_5\) | ET5, Yb→Tm (\(^{1}D_2\to{}^{1}I_6\)) | 0.5 |
| \(k_{21}\) | \(Tm_2\to Tm_1\) fast non-radiative | 50.0 |
| \(k_{35}\) | \(Tm_3\to Tm_5\) phonon relaxation | 20.0 |
| \(A_{10}\) | \(Tm_1\to Tm_0\) (1800 nm) | 1.0 |
| \(A_{50}\) | \(Tm_5\to Tm_0\) (775 nm) | 0.33 |
| \(A_{60}\) | \(Tm_6\to Tm_0\) (477 nm) | 2.0 |
| \(A_{61}\) | \(Tm_6\to Tm_1\) (645 nm) | 0.5 |
| \(A_{70}\) | \(Tm_7\to Tm_0\) (362 nm) | 1.5 |
| \(A_{71}\) | \(Tm_7\to Tm_1\) (452 nm) | 0.5 |
| \(A_{80}\) | \(Tm_8\to Tm_0\) (not used by the ODE) | 2.0 |
| \(A_{81}\) | \(Tm_8\to Tm_1\) (345 nm) | 2.0 |
| \(W_{\mathrm{cr,H4}}\) | Coefficient of \(r_2\) (CR-H4) | 5.0 |
| \(W_b\) | Coefficient of \(r_{\mathrm{BET}}\) | 0.5 |
| \(W_{\mathrm{cr,G4}}\) | Coefficient of \(r_1\) (CR-G4) | 5.0 |
| \(T_{\mathrm{offset}}\) | Time shift of the trace (ms) | 0.0 |

## Measured-emission model

The observed trace for each band is taken from the population of its emitting state, clipped at
zero and normalized to its maximum:

| Band | Row of `sol.y` | Observable |
|---|---|---|
| 775 nm | 7 | \(Tm_5\) |
| 477 nm | 8 | \(A_{60}Tm_6\) |
| 645 nm | 8 | \(A_{61}Tm_6\) |
| 362 nm | 9 | \(Tm_7\) |
| 452 nm | 9 | \(Tm_7\) |
| 345 nm | 10 | \(Tm_8\) |

During fitting the model trace is additionally convolved with an instrument response function.
Consequently:

- \(r_1\) lowers the \(^{1}G_4\) population (blue quenching) while raising \(^{3}H_4\).
- \(r_2\) adds a concentration-dependent \(^{3}H_4\) sink, feeding \(^{3}F_4\).
- BET adds a further \(^{3}H_4\) sink only in the Yb-rich regime.

These are mechanistic readings of the ODE terms, not guarantees of monotonic experimental trends.

## Which parameters are fitted?

All 20 kinetic parameters plus \(T_{\mathrm{offset}}\) and the pulse width are candidates; the set
influencing a selected band directly is given by `classify_parameter_roles`. For 775 nm it is
\(R_p, A_y, W_2, A_{50}, W_3, W_{\mathrm{cr,H4}}, W_{\mathrm{cr,G4}}, W_b\); for 477/645 nm it is
\(R_p, A_y, W_3, A_{60}, A_{61}, W_4, W_{\mathrm{cr,G4}}\).

## Assumptions and limitations to state in a publication

- The gates are strict, piecewise switches; no smooth threshold, migration, clustering, or
  concentration quenching beyond the listed pathways is modelled.
- \(W_{\mathrm{cr,G4}}\), \(W_{\mathrm{cr,H4}}\) and \(W_b\) are effective coefficients on normalized
  populations, not universal bimolecular constants. The coupled model has no explicit \(c_{\mathrm{Tm}}\)
  multiplier.
- The pump is an effective rectangular pulse; no Tm state is pumped directly.
- \(Tm_4\) is inactive and the coupled solver has no \(^{1}D_2\) CR channel.
- Fitted values need independent experimental validation.

## Relation to the reduced seven-state Tm model

The single-Tm model uses different indices (\(Tm_3={}^{3}H_4\), \(Tm_5={}^{1}G_4\),
\(Tm_6={}^{1}D_2\), \(Tm_7={}^{1}I_6\), \(Tm_8={}^{3}P_2\)), a concentration-scaled
definition \(r_1=\chi_{\mathrm{G4}}K_{\mathrm{cr,G4}}c_{\mathrm{Tm}}n_5n_0\),
\(r_2=\chi_{\mathrm{H4}}K_{\mathrm{cr,H4}}c_{\mathrm{Tm}}n_3n_0\), and a third channel
\(r_3=\chi_{\mathrm{D2}}K_{\mathrm{cr}}c_{\mathrm{Tm}}n_6n_0\)
(\(^{1}D_2+{}^{3}H_6\to{}^{1}G_4+{}^{3}F_4\), gated at \(c_{\mathrm{Tm}}>0.1\)). Its CR
contributions are, gains first,
\(\dot n_1|_{\mathrm{CR}}=r_1+2r_2+r_3\), \(\dot n_3|_{\mathrm{CR}}=r_1-r_2\),
\(\dot n_5|_{\mathrm{CR}}=r_3-r_1\), \(\dot n_6|_{\mathrm{CR}}=-r_3\),
\(\dot n_0|_{\mathrm{CR}}=-r_1-r_2-r_3\). Its BET is
\(r_{\mathrm{BET}}=\chi_{\mathrm{BET}}K_{\mathrm{yb}}c_{\mathrm{Yb}}n_3\) (excited Yb is not tracked).

## Reproducibility note

Equations and defaults above were transcribed from `UCOdeModel.system`, `_default_kinetic_params`
and `_EMISSION_SOL_ROW` in `app.py`. If those change, regenerate this document.
