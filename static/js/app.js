// ║  UC Photoluminescence Lifetime Fitter — Client-Side Logic   ║
// ╚══════════════════════════════════════════════════════════════╝
//
//  TABLE OF CONTENTS  (search "== N." to jump)
//  ─────────────────────────────────────────────
//   1. Global State               13. File Parsing
//   2. Constants & Configuration   14. File Processing
//   3. Image Modal                 15. File Upload Handlers
//   4. Helper Functions            16. Data Plotting
//   5. Multi-Channel State & UI    17. Physics Functions
//   6. Multi-Channel Actions       18. Configuration
//   7. Development Fitting         19. Fitting
//   8. Logging & Progress Polling  20. Export (CSV / Excel)
//   9. Deposit Management          21. Utility Functions
//  10. Fit Cancellation            22. Lifetime Generator
//  11. View Management             23. Initialization
//  12. Ribbon Management
//

// ==================== 1. GLOBAL STATE ====================

// --- 1a. Data & Results ---
let rawData = null;
let processedData = null;
let fittingResults = null;
let lastFitDataForExport = null;
let multipleDatasets = [];
let currentFitIndex = 0;

// --- 1b. Upload & File State ---
let uploadMode = 'single';
let singleRawData = null;
let singleActiveFileName = 'No file loaded';

// --- 1c. Multi-Channel State ---
let multiChannelFolders = [];
let multiChannelSlotState = {};
let activeMultiChannelFolderId = null;
let activeMultiChannelSlotId = null;
let pendingMultiChannelSlotId = null;
let pendingMultiChannelFolderId = null;

// --- 1d. Physics State ---
let selectedCation = null;
let selectedAnion = null;
let lastCalculatedPhonon = 350;

// --- 1e. Fit Control State ---
let currentFitAbortController = null;
let currentFitRequestId = null;
let fitProgressPoller = null;
let fitLastProgressSeq = -1;
let fitLastAdaptiveCycle = 0;
let multiFitInProgress = false;
let multiFitCancelRequested = false;
let lastCarryForwardMarker = null;

// --- 1f. Deposit & UI State ---
let plotDeposits = [];
let activeDepositIndex = -1;
let currentZoom = 1;

// ==================== 2. CONSTANTS & CONFIGURATION ====================

// --- 2a. Emission Channel Definitions ---
const EMISSION_OPTIONS = [
    { value: '1800', label: '1800 nm - ³F₄ → ³H₆' },
    { value: '1230', label: '1230 nm - ³H₅ → ³H₆' },
    { value: '775', label: '775 nm - ³H₄ → ³H₆' },
    { value: '645', label: '645 nm - ¹G₄ → ³F₄ Red' },
    { value: '477', label: '477 nm - ¹G₄ → ³H₆ Blue' },
    { value: '452', label: '452 nm - ¹D₂ → ³F₄' },
    { value: '362', label: '362 nm - ¹D₂ → ³F₄ UV' },
    { value: '345', label: '345 nm - ¹I₆ → ³F₄' },
];
window.addEventListener("DOMContentLoaded", () => {
    const select = document.getElementById("emissionSelect");

    if (!select) {
        console.error("emissionSelect not found in HTML");
        return;
    }

    EMISSION_OPTIONS.forEach(opt => {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
    });
});
// --- 2b. Multi-Channel Slot & Order Configuration ---
const MULTI_CHANNEL_SLOTS = [
    { id: 'slot775', defaultEmission: '775', role: 'mandatory' },
    { id: 'slot477', defaultEmission: '477', role: 'mandatory' },
    { id: 'slot645', defaultEmission: '645', role: 'optional' },
    { id: 'slot362', defaultEmission: '362', role: 'mandatory' },
    { id: 'slot452', defaultEmission: '452', role: 'optional' },
    { id: 'slot345', defaultEmission: '345', role: 'mandatory' },
    { id: 'slot1800', defaultEmission: '1800', role: 'optional' },
    { id: 'slot1230', defaultEmission: '1230', role: 'optional' },
];

const MULTI_CHANNEL_ORDER = ['775', '477', '645', '362', '452', '345'];
const MULTI_CHANNEL_MANDATORY = new Set(['775', '477', '362', '345']);
const MULTI_CHANNEL_MIN_R2 = {
    '775': 0.99,
    '477': 0.99,
    '645': 0.99,
    '362': 0.99,
    '452': 0.99,
    '345': 0.99,
};

const GLOBAL_FIT_CONFIG = {
    retryTargetBoost: 0.03,
    retryCycles: 16,
    earlyBoost: 1.30,
    peakBoost: 1.25
};

// --- 2c. Quality Profiles (per-emission tuning) ---
/**
 * MULTI_CHANNEL_QUALITY_PROFILES
 * 
 * Emission-specific tuning parameters that control how aggressively the fitting algorithm
 * attempts to improve fit quality for each wavelength. These values are based on the
 * physical characteristics and typical behavior of each emission channel.
 * 
 * Each profile contains:
 * - Limits: Maximum allowed errors before triggering warnings
 * - Weights: How much each error type affects the score
 * - Retry Controls: How many retry attempts and how much to increase targets
 * - Boost Values: Starting weights for peak and early-rise regions
 */
const MULTI_CHANNEL_QUALITY_PROFILES = {
    
    /**
     * 775 nm - Calibration Channel (³H₄ → ³H₆)
     * 
     * Physical characteristics:
     * - Strongest signal, highest intensity
     * - Serves as feeder-chain anchor for other emissions
     * - Used for calibration before fitting 477/645
     * - More tolerant of timing errors since it's calibration
     * 
     * Tuning rationale:
     * - Lower peak boost (1.22) because 775 is naturally strong
     * - Moderate early boost (1.34) helps with rise time calibration
     * - Moderate retry cycles (16) - calibration needs reasonable attempts
     * - 3% target increase per retry (0.03) - steady progression
     */
    '775': {
        // ERROR LIMITS (maximum allowed relative errors)
        riseLimit: 0.16,    // 16% - can tolerate moderate rise error
        decayLimit: 0.16,   // 16% - can tolerate moderate decay error
        peakLimit: 0.12,    // 12% - stricter on peak since it's calibration
        ampLimit: 0.08,     // 8%  - amplitude should be fairly accurate
        
        // SCORE WEIGHTS (how much each error penalizes the score)
        riseWeight: 0.55,   // 55% penalty for rise errors
        decayWeight: 0.32,  // 32% penalty for decay errors
        peakWeight: 0.28,   // 28% penalty for peak errors
        ampWeight: 0.30,    // 30% penalty for amplitude errors
        
        // RETRY CONTROLS
        retryTargetBoost: 0.03,  // Increase target R² by 3% each retry
        retryCycles: 16,         // Maximum 16 retry attempts
        
        // STARTING BOOST VALUES
        earlyBoost: 1.34,   // Start with 34% more weight on early rise
        peakBoost: 1.22,    // Start with 22% more weight on peak region
        
    },
    
    /**
     * 477 nm - Blue Emission (¹G₄ → ³H₆)
     * 
     * Physical characteristics:
     * - Higher energy emission
     * - Often has sharper peaks that need precise fitting
     * - More sensitive to timing mismatches
     * - Critical for blue channel analysis
     * 
     * Tuning rationale:
     * - Higher peak boost (1.28) to match sharp blue peaks
     * - Higher early boost (1.34) because rise time is critical
    * - Retry controls use global defaults
     */
    '477': {
        // ERROR LIMITS - stricter because blue emission needs higher precision
        riseLimit: 0.15,    // 15% - stricter rise limit
        decayLimit: 0.16,   // 16% - standard decay limit
        peakLimit: 0.11,    // 11% - stricter peak limit for sharp blue peaks
        ampLimit: 0.06,     // 6%  - amplitude must be very accurate
        
        // SCORE WEIGHTS - higher penalties for blue errors
        riseWeight: 0.60,   // 60% penalty - rise errors hurt more
        decayWeight: 0.30,  // 30% penalty
        peakWeight: 0.34,   // 34% penalty - peak errors penalized heavily
        ampWeight: 0.34,    // 34% penalty - amplitude errors penalized heavily
        
        // STARTING BOOST VALUES - higher to match blue characteristics
        earlyBoost: 1.34,   // 34% more early rise weight
        peakBoost: 1.28,    // 28% more peak weight (higher than 775's 1.22)
        
    },
    /**
     * 645 nm - Red Emission (¹G₄ → ³F₄)
     * 
     * Physical characteristics:
     * - Red emission often has broader peaks
     * - Can be weaker signal in some samples
     * - Rise time less critical than peak matching
     * - More tolerant of early rise errors
     * 
     * Tuning rationale:
     * - Highest peak boost (1.34) to capture broad peaks
     * - Lower early boost (1.24) because rise time is less critical
     * - Standard retry cycles (16)
     * - Moderate target increase (3% per retry)
     */
    '645': {
        // ERROR LIMITS - more tolerant of errors
        riseLimit: 0.22,    // 22% - very tolerant of rise errors
        decayLimit: 0.20,   // 20% - tolerant of decay errors
        peakLimit: 0.16,    // 16% - moderate peak tolerance
        ampLimit: 0.10,     // 10% - amplitude can vary more
        
        // SCORE WEIGHTS - lower penalties for red
        riseWeight: 0.42,   // 42% penalty - rise errors hurt less
        decayWeight: 0.28,  // 28% penalty
        peakWeight: 0.38,   // 38% penalty - peak still important
        ampWeight: 0.34,    // 34% penalty
        
        // RETRY CONTROLS - standard
        retryTargetBoost: 0.03,  // 3% increase per retry
        retryCycles: 16,         // 16 retry attempts
        
        // STARTING BOOST VALUES - peak-focused
        earlyBoost: 1.24,   // Only 24% early boost (lowest)
        peakBoost: 1.34,    // 34% peak boost (highest)
    },
    
    /**
     * 362 nm - UV Emission (¹D₂ → ³F₄ UV)
     * 
     * Physical characteristics:
     * - UV emission, higher energy
     * - Often weaker signal
     * - Sensitive to upstream feeder dynamics
     * - Needs good rise time matching
     * 
     * Tuning rationale:
     * - Higher early boost (1.34) for rise time
     * - Moderate peak boost (1.28)
     * - More retries (17) - UV is challenging
     * - More aggressive target increase (3.5% per retry)
     */
    '362': {
        // ERROR LIMITS - moderate strictness
        riseLimit: 0.16,    // 16% - stricter on rise for UV
        decayLimit: 0.16,   // 16% - standard
        peakLimit: 0.12,    // 12% - moderate
        ampLimit: 0.07,     // 7%  - amplitude matters
        
        // SCORE WEIGHTS
        riseWeight: 0.56,   // 56% penalty - rise important
        decayWeight: 0.34,  // 34% penalty
        peakWeight: 0.30,   // 30% penalty
        ampWeight: 0.32,    // 32% penalty
        
        // RETRY CONTROLS - more aggressive
        retryTargetBoost: 0.035, // 3.5% increase per retry
        retryCycles: 17,         // 17 retry attempts
        
        // STARTING BOOST VALUES
        earlyBoost: 1.34,   // 34% early boost
        peakBoost: 1.28,    // 28% peak boost
    },
    
    /**
     * 452 nm - Violet Emission (¹D₂ → ³F₄)
     * 
     * Physical characteristics:
     * - Violet emission, similar to 362 but different transition
     * - Often weaker than blue
     * - Can be noisy
     * - Depends on upper-state population
     * 
     * Tuning rationale:
     * - Moderate peak boost (1.28)
     * - Lower early boost (1.26) - rise less critical
     * - Fewer retries (15) - accept good enough
     * - Standard target increase (3% per retry)
     */
    '452': {
        // ERROR LIMITS - more tolerant
        riseLimit: 0.22,    // 22% - very tolerant
        decayLimit: 0.20,   // 20% - tolerant
        peakLimit: 0.16,    // 16% - moderate
        ampLimit: 0.10,     // 10% - amplitude can vary
        
        // SCORE WEIGHTS - lower penalties
        riseWeight: 0.46,   // 46% penalty
        decayWeight: 0.28,  // 28% penalty
        peakWeight: 0.30,   // 30% penalty
        ampWeight: 0.28,    // 28% penalty
        
        // RETRY CONTROLS - less aggressive
        retryTargetBoost: 0.03,  // 3% increase per retry
        retryCycles: 15,         // Fewer retries (15)
        
        // STARTING BOOST VALUES
        earlyBoost: 1.26,   // 26% early boost (lower)
        peakBoost: 1.28,    // 28% peak boost (moderate)
    },
    
    /**
     * 345 nm - Deep UV Emission (¹I₆ → ³F₄)
     * 
     * Physical characteristics:
     * - Highest energy emission in this set
     * - Weakest signal, often noisy
     * - Most sensitive to all timing parameters
     * - Hardest to fit well
     * 
     * Tuning rationale:
     * - Highest early boost (1.36) - rise time is critical
     * - High peak boost (1.30) - need help to match peaks
     * - Most retries (18) - hardest to fit
     * - Most aggressive target increase (4% per retry)
     */
    '345': {
        // ERROR LIMITS - strictest for deep UV
        riseLimit: 0.10,    // 10% - very strict on rise
        decayLimit: 0.10,   // 10% - very strict on decay
        peakLimit: 0.08,    // 8%  - very strict on peak
        ampLimit: 0.06,     // 6%  - amplitude must be accurate
        
        // SCORE WEIGHTS - highest penalties
        riseWeight: 0.60,   // 60% penalty - rise errors hurt most
        decayWeight: 0.40,  // 40% penalty
        peakWeight: 0.34,   // 34% penalty
        ampWeight: 0.36,    // 36% penalty
        
        // RETRY CONTROLS - most aggressive
        retryTargetBoost: 0.04,  // 4% increase per retry (most aggressive)
        retryCycles: 18,         // Most retry attempts (18)
        
        // STARTING BOOST VALUES - highest to compensate for weak signal
        earlyBoost: 1.36,   // 36% early boost (highest)
        peakBoost: 1.30,    // 30% peak boost (highest)
    }
};

// --- 2d. ODE Reference Database ---
const odeDatabase = {
    "1800": {
        latex: "\\frac{dN_1}{dt} = W_{ET2} \\cdot [Yb^*] \\cdot [N_3] + \\sum A_{i1} \\cdot [N_i] - (A_{10} + W_{ET2} \\cdot [Yb^*]) \\cdot [N_1]",
        population: ["🔄 A₅₁ · [N₅] (Recirculation from ¹G₄)", "🔄 A₆₁ · [N₆] (Recirculation from ¹D₂)", "W_ET2 · [Yb*] · [N₃]"],
        depopulation: ["A₁₀ · [N₁] (Radiative to ground)", "W_ET2 · [Yb*] · [N₁] (Up-pumping)"]
    },
    "1230": {
        latex: "\\frac{dN_2}{dt} = W_{ET2} \\cdot [Yb^*] \\cdot [N_1] - (A_{20} + W_{nr}) \\cdot [N_2]",
        population: ["W_ET2 · [Yb*] · [N₁] (From ³F₄)"],
        depopulation: ["A₂₀ · [N₂] (Radiative)", "W_nr · [N₂] (Non-radiative)"]
    },
    "775": {
        latex: "\\frac{dTm_5}{dt} = W_2 \\cdot Yb_e \\cdot Tm_1 - A_{50} \\cdot Tm_5 - W_{cr} \\cdot Tm_5 \\cdot Tm_0 - W_3 \\cdot Yb_e \\cdot Tm_5 - W_b \\cdot Tm_5 \\cdot Yb_g",
        population: ["W₂ · Ybₑ · Tm₁ (second ET feeding Tm₅)"],
        depopulation: ["A₅₀ · Tm₅ (radiative 775 nm)", "Wcr · Tm₅ · Tm₀ (cross-relaxation)", "W₃ · Ybₑ · Tm₅ (ET → ¹G₄)", "Wb · Tm₅ · Ybg (back transfer ³H₄→Yb)"]
    },
    "477": {
        latex: "\\frac{dTm_6}{dt} = W_3 \\cdot Yb_e \\cdot Tm_5 - (A_{60} + A_{61}) \\cdot Tm_6 - W_4 \\cdot Yb_e \\cdot Tm_6",
        population: ["W3 · Ybₑ · Tm₅", "Observable: I₄₇₇ ∝ A60 · Tm₆"],
        depopulation: ["A60 · Tm₆", "A61 · Tm₆", "W4 · Ybₑ · Tm₆"]
    },
    "362": {
        latex: "\\frac{dTm_7}{dt} = W_4 \\cdot Yb_e \\cdot Tm_6 - (A_{70} + A_{71}) \\cdot Tm_7 - W_5 \\cdot Yb_e \\cdot Tm_7",
        population: ["W4 · Ybₑ · Tm₆"],
        depopulation: ["A70 · Tm₇", "A71 · Tm₇", "W5 · Ybₑ · Tm₇"]
    },
    "645": {
        latex: "\\frac{dTm_6}{dt} = W_3 \\cdot Yb_e \\cdot Tm_5 - (A_{60} + A_{61}) \\cdot Tm_6 - W_4 \\cdot Yb_e \\cdot Tm_6",
        population: ["W3 · Ybₑ · Tm₅", "Observable: I₆₄₅ ∝ A61 · Tm₆"],
        depopulation: ["A60 · Tm₆", "A61 · Tm₆", "W4 · Ybₑ · Tm₆"]
    },
    "452": {
        latex: "\\frac{dTm_7}{dt} = W_4 \\cdot Yb_e \\cdot Tm_6 - (A_{70} + A_{71}) \\cdot Tm_7 - W_5 \\cdot Yb_e \\cdot Tm_7",
        population: ["W4 · Ybₑ · Tm₆"],
        depopulation: ["A70 · Tm₇", "A71 · Tm₇", "W5 · Ybₑ · Tm₇"]
    },
    "345": {
        latex: "\\frac{dTm_8}{dt} = W_5 \\cdot Yb_e \\cdot Tm_7 - A_{81} \\cdot Tm_8",
        population: ["W5 · Ybₑ · Tm₇"],
        depopulation: ["A81 · Tm₈"]
    }
};

// --- 2d-ii. Single-Doped Tm³⁺ ODE Database (no Yb sensitizer) ---
// In single-doped Tm, upconversion occurs via GSA + ESA and/or ETU between Tm ions.
// Excitation wavelengths: 785 nm (³H₆→³H₄), 1210 nm (³H₆→³H₅), 690 nm (³H₆→³F₂,₃→³H₄)
// State labels: Tm0 = ³H₆(ground), Tm1 = ³F₄, Tm2 = ³H₅, Tm3 = ³H₄, Tm4 = ³F₂,₃, Tm5 = ¹G₄, Tm6 = ¹D₂, Tm7 = ¹I₆
const odeDatabaseSingleTm = {
    "785": {
        excitation_label: "785 nm (³H₆ → ³H₄) GSA",
        description: "Direct ground-state absorption into ³H₄. ESA from ³H₄ populates ¹G₄. Cross-relaxation redistributes energy at high Tm concentrations.",
        states: {
            "Tm0": {
                latex: "\\frac{dTm_0}{dt} = -\\sigma_{GSA} \\cdot \\Phi \\cdot Tm_0 + A_{30} \\cdot Tm_3 + A_{10} \\cdot Tm_1 + W_{CR} \\cdot Tm_3^2",
                label: "³H₆ (ground)",
                population: ["A₃₀ · Tm₃ (radiative from ³H₄)", "A₁₀ · Tm₁ (radiative from ³F₄)", "W_CR · Tm₃² (cross-relaxation feeds ground)"],
                depopulation: ["σ_GSA · Φ · Tm₀ (785 nm absorption)"]
            },
            "Tm1": {
                latex: "\\frac{dTm_1}{dt} = W_{NR,21} \\cdot Tm_2 + A_{31} \\cdot Tm_3 + W_{CR} \\cdot Tm_3^2 - A_{10} \\cdot Tm_1",
                label: "³F₄",
                observable: "1800 nm: I₁₈₀₀ ∝ A₁₀ · Tm₁",
                population: ["W_NR,21 · Tm₂ (NR from ³H₅)", "A₃₁ · Tm₃ (radiative from ³H₄)", "W_CR · Tm₃² (CR product)"],
                depopulation: ["A₁₀ · Tm₁ (radiative 1800 nm)"]
            },
            "Tm3": {
                latex: "\\frac{dTm_3}{dt} = \\sigma_{GSA} \\cdot \\Phi \\cdot Tm_0 + W_{NR,43} \\cdot Tm_4 - (A_{30} + A_{31}) \\cdot Tm_3 - \\sigma_{ESA} \\cdot \\Phi \\cdot Tm_3 - 2 W_{CR} \\cdot Tm_3^2",
                label: "³H₄",
                observable: "775 nm: I₇₇₅ ∝ A₃₀ · Tm₃",
                population: ["σ_GSA · Φ · Tm₀ (ground-state absorption)", "W_NR,43 · Tm₄ (NR from ³F₂,₃)"],
                depopulation: ["(A₃₀+A₃₁) · Tm₃ (radiative)", "σ_ESA · Φ · Tm₃ (ESA to ¹G₄)", "2·W_CR · Tm₃² (cross-relaxation)"]
            },
            "Tm5": {
                latex: "\\frac{dTm_5}{dt} = \\sigma_{ESA} \\cdot \\Phi \\cdot Tm_3 - (A_{50} + A_{51}) \\cdot Tm_5",
                label: "¹G₄",
                observable: "477 nm: I₄₇₇ ∝ A₅₀ · Tm₅ | 645 nm: I₆₄₅ ∝ A₅₁ · Tm₅",
                population: ["σ_ESA · Φ · Tm₃ (ESA from ³H₄)"],
                depopulation: ["A₅₀ · Tm₅ (radiative 477 nm)", "A₅₁ · Tm₅ (radiative 645 nm)"]
            }
        },
        parameters: {
            "σ_GSA": "Ground-state absorption cross-section at 785 nm (cm²)",
            "σ_ESA": "Excited-state absorption cross-section ³H₄→¹G₄ (cm²)",
            "Φ": "Photon flux (photons·cm⁻²·s⁻¹)",
            "W_CR": "Cross-relaxation rate: ³H₄ + ³H₄ → ³F₄ + ³H₆ (s⁻¹·cm³)",
            "W_NR,21": "Non-radiative ³H₅ → ³F₄ rate (s⁻¹)",
            "W_NR,43": "Non-radiative ³F₂,₃ → ³H₄ rate (s⁻¹)"
        }
    },
    "1210": {
        excitation_label: "1210 nm (³H₆ → ³H₅) GSA",
        description: "Direct absorption into ³H₅ followed by multiphonon relaxation to ³H₄ or ESA sequences. Requires multiple sequential photon absorptions for visible upconversion.",
        states: {
            "Tm0": {
                latex: "\\frac{dTm_0}{dt} = -\\sigma_{GSA} \\cdot \\Phi \\cdot Tm_0 + A_{10} \\cdot Tm_1",
                label: "³H₆ (ground)",
                population: ["A₁₀ · Tm₁ (radiative from ³F₄)"],
                depopulation: ["σ_GSA · Φ · Tm₀ (1210 nm absorption)"]
            },
            "Tm2": {
                latex: "\\frac{dTm_2}{dt} = \\sigma_{GSA} \\cdot \\Phi \\cdot Tm_0 - W_{NR,21} \\cdot Tm_2 - \\sigma_{ESA1} \\cdot \\Phi \\cdot Tm_2",
                label: "³H₅",
                observable: "1230 nm: I₁₂₃₀ ∝ A₂₀ · Tm₂",
                population: ["σ_GSA · Φ · Tm₀ (absorption)"],
                depopulation: ["W_NR,21 · Tm₂ (NR to ³F₄)", "σ_ESA1 · Φ · Tm₂ (ESA to ³F₂,₃)"]
            },
            "Tm3": {
                latex: "\\frac{dTm_3}{dt} = W_{NR,43} \\cdot Tm_4 - (A_{30} + A_{31}) \\cdot Tm_3 - \\sigma_{ESA2} \\cdot \\Phi \\cdot Tm_3",
                label: "³H₄",
                observable: "775 nm: I₇₇₅ ∝ A₃₀ · Tm₃",
                population: ["W_NR,43 · Tm₄ (NR from ³F₂,₃)"],
                depopulation: ["(A₃₀+A₃₁) · Tm₃ (radiative)", "σ_ESA2 · Φ · Tm₃ (ESA to ¹G₄)"]
            },
            "Tm4": {
                latex: "\\frac{dTm_4}{dt} = \\sigma_{ESA1} \\cdot \\Phi \\cdot Tm_2 - W_{NR,43} \\cdot Tm_4",
                label: "³F₂,₃",
                population: ["σ_ESA1 · Φ · Tm₂ (ESA from ³H₅)"],
                depopulation: ["W_NR,43 · Tm₄ (fast NR to ³H₄)"]
            },
            "Tm5": {
                latex: "\\frac{dTm_5}{dt} = \\sigma_{ESA2} \\cdot \\Phi \\cdot Tm_3 - (A_{50} + A_{51}) \\cdot Tm_5",
                label: "¹G₄",
                observable: "477 nm: I₄₇₇ ∝ A₅₀ · Tm₅ | 645 nm: I₆₄₅ ∝ A₅₁ · Tm₅",
                population: ["σ_ESA2 · Φ · Tm₃ (ESA from ³H₄)"],
                depopulation: ["A₅₀ · Tm₅ (radiative 477 nm)", "A₅₁ · Tm₅ (radiative 645 nm)"]
            }
        },
        parameters: {
            "σ_GSA": "Ground-state absorption cross-section at 1210 nm (cm²)",
            "σ_ESA1": "ESA cross-section ³H₅→³F₂,₃ (cm²)",
            "σ_ESA2": "ESA cross-section ³H₄→¹G₄ (cm²)",
            "Φ": "Photon flux (photons·cm⁻²·s⁻¹)",
            "W_NR,21": "Non-radiative ³H₅ → ³F₄ rate (s⁻¹)",
            "W_NR,43": "Non-radiative ³F₂,₃ → ³H₄ rate (s⁻¹)"
        }
    },
    "690": {
        excitation_label: "690 nm (³H₆ → ³F₂,₃ → ³H₄) GSA",
        description: "Pumping directly to ³F₂,₃ which rapidly relaxes to ³H₄. ESA from ³H₄ reaches ¹D₂ yielding UV/blue emission.",
        states: {
            "Tm0": {
                latex: "\\frac{dTm_0}{dt} = -\\sigma_{GSA} \\cdot \\Phi \\cdot Tm_0 + A_{10} \\cdot Tm_1 + A_{30} \\cdot Tm_3",
                label: "³H₆ (ground)",
                population: ["A₁₀ · Tm₁ (from ³F₄)", "A₃₀ · Tm₃ (from ³H₄)"],
                depopulation: ["σ_GSA · Φ · Tm₀ (690 nm absorption)"]
            },
            "Tm3": {
                latex: "\\frac{dTm_3}{dt} = W_{NR,43} \\cdot Tm_4 - (A_{30} + A_{31}) \\cdot Tm_3 - \\sigma_{ESA} \\cdot \\Phi \\cdot Tm_3",
                label: "³H₄",
                observable: "775 nm: I₇₇₅ ∝ A₃₀ · Tm₃",
                population: ["W_NR,43 · Tm₄ (fast NR from ³F₂,₃)"],
                depopulation: ["(A₃₀+A₃₁) · Tm₃ (radiative)", "σ_ESA · Φ · Tm₃ (ESA to ¹D₂)"]
            },
            "Tm4": {
                latex: "\\frac{dTm_4}{dt} = \\sigma_{GSA} \\cdot \\Phi \\cdot Tm_0 - W_{NR,43} \\cdot Tm_4",
                label: "³F₂,₃",
                population: ["σ_GSA · Φ · Tm₀ (absorption)"],
                depopulation: ["W_NR,43 · Tm₄ (fast NR relaxation, ~ps)"]
            },
            "Tm6": {
                latex: "\\frac{dTm_6}{dt} = \\sigma_{ESA} \\cdot \\Phi \\cdot Tm_3 - (A_{60} + A_{61}) \\cdot Tm_6",
                label: "¹D₂",
                observable: "362 nm: I₃₆₂ ∝ A₆₀ · Tm₆ | 452 nm: I₄₅₂ ∝ A₆₁ · Tm₆",
                population: ["σ_ESA · Φ · Tm₃ (ESA from ³H₄)"],
                depopulation: ["A₆₀ · Tm₆ (radiative 362 nm)", "A₆₁ · Tm₆ (radiative 452 nm)"]
            }
        },
        parameters: {
            "σ_GSA": "Ground-state absorption cross-section at 690 nm (cm²)",
            "σ_ESA": "ESA cross-section ³H₄→¹D₂ (cm²)",
            "Φ": "Photon flux (photons·cm⁻²·s⁻¹)",
            "W_NR,43": "Non-radiative ³F₂,₃ → ³H₄ rate (s⁻¹)"
        }
    }
};

// --- 2d-iii. UC Mechanism ODE Databases ---
// ODEs for each non-ETUC upconversion mechanism

const odeDatabaseESA = {
    title: "Excited State Absorption (ESA)",
    description: "Sequential absorption of two (or more) photons by the same ion. First photon: GSA populates an intermediate level. Second photon: ESA from the intermediate reaches an emitting level. Requires long intermediate-state lifetime and high pump intensity.",
    latex_system: [
        "\\frac{dN_0}{dt} = -\\sigma_{GSA} \\cdot \\Phi \\cdot N_0 + A_{10} \\cdot N_1 + A_{20} \\cdot N_2",
        "\\frac{dN_1}{dt} = \\sigma_{GSA} \\cdot \\Phi \\cdot N_0 - \\sigma_{ESA} \\cdot \\Phi \\cdot N_1 - A_{10} \\cdot N_1",
        "\\frac{dN_2}{dt} = \\sigma_{ESA} \\cdot \\Phi \\cdot N_1 - A_{20} \\cdot N_2"
    ],
    observables: "I_em ∝ A₂₀ · N₂",
    parameters: {
        "σ_GSA": "Ground-state absorption cross-section (cm²)",
        "σ_ESA": "Excited-state absorption cross-section (cm²)",
        "Φ": "Pump photon flux (photons·cm⁻²·s⁻¹)",
        "A₁₀": "Intermediate → ground decay rate (s⁻¹)",
        "A₂₀": "Emitting → ground radiative rate (s⁻¹)"
    },
    hallmark: "I_UC ∝ Φ¹ (linear in pump power, unlike ETU which is quadratic at low power)"
};

const odeDatabasePA = {
    title: "Photon Avalanche (PA)",
    description: "A looping mechanism: weak GSA initially populates an intermediate level. ESA promotes ions further. Cross-relaxation multiplies the intermediate population exponentially, creating an avalanche-like rise above a pump threshold. Characterized by a sharp intensity threshold and nonlinear power dependence (slope > 10).",
    latex_system: [
        "\\frac{dN_0}{dt} = -\\sigma_{GSA}^{(weak)} \\cdot \\Phi \\cdot N_0 + A_{10} \\cdot N_1 + W_{CR} \\cdot N_2 \\cdot N_0",
        "\\frac{dN_1}{dt} = \\sigma_{GSA}^{(weak)} \\cdot \\Phi \\cdot N_0 + 2 W_{CR} \\cdot N_2 \\cdot N_0 - \\sigma_{ESA} \\cdot \\Phi \\cdot N_1 - A_{10} \\cdot N_1",
        "\\frac{dN_2}{dt} = \\sigma_{ESA} \\cdot \\Phi \\cdot N_1 - A_{20} \\cdot N_2 - W_{CR} \\cdot N_2 \\cdot N_0"
    ],
    observables: "I_em ∝ A₂₀ · N₂   (above pump threshold Φ_th)",
    parameters: {
        "σ_GSA(weak)": "Weak ground-state absorption cross-section (cm²); GSA is resonance-mismatched",
        "σ_ESA": "Resonant excited-state absorption cross-section (cm²); σ_ESA >> σ_GSA",
        "Φ": "Pump photon flux (photons·cm⁻²·s⁻¹)",
        "W_CR": "Cross-relaxation looping rate: N₂+N₀ → 2N₁ (s⁻¹·cm³)",
        "Φ_th": "Avalanche threshold pump flux"
    },
    hallmark: "I_UC ∝ Φⁿ with n >> 2 (typically 10–40); sharp intensity onset at Φ_th"
};

const odeDatabaseEMMUC = {
    title: "Energy Migration-Mediated Upconversion (EMMUC)",
    description: "Core–shell architecture: Yb sensitizers absorb and transfer energy to a Gd or Tm migration sublattice. Energy migrates (hops) through bridging ions until captured by an activator. Requires core/shell geometry to suppress back-transfer.",
    latex_system: [
        "\\frac{dYb_e}{dt} = R_p \\cdot Yb_g - A_{Yb} \\cdot Yb_e - W_{ET} \\cdot Yb_e \\cdot M_0",
        "\\frac{dM_i}{dt} = W_{ET} \\cdot Yb_e \\cdot M_0 - k_{mig} \\cdot M_i + k_{mig} \\cdot M_{i-1} \\quad (\\text{energy hopping chain})",
        "\\frac{dA^*}{dt} = \\eta \\cdot k_{mig} \\cdot M_{last} - A_{rad} \\cdot A^*"
    ],
    observables: "I_em ∝ A_rad · A*   (activator emission)",
    parameters: {
        "R_p": "Pump rate into Yb (s⁻¹)",
        "W_ET": "Yb → migration sublattice transfer rate (s⁻¹)",
        "k_mig": "Energy migration hopping rate between bridging ions (s⁻¹)",
        "η": "Migration → activator capture efficiency",
        "A_rad": "Activator radiative decay rate (s⁻¹)"
    },
    hallmark: "Enables UC in nanoparticles with separated sensitizer/activator; requires core/shell architecture"
};

const odeDatabaseCUSC = {
    title: "Cooperative Sensitization Upconversion (CUSC)",
    description: "Two sensitizer ions (Yb³⁺) in excited states simultaneously transfer their combined energy to one activator (Tb³⁺, Eu³⁺, etc.) in a single virtual step. No real intermediate state on the activator. Rate depends on sensitizer excited-state density squared.",
    latex_system: [
        "\\frac{dYb_e}{dt} = R_p \\cdot Yb_g - A_{Yb} \\cdot Yb_e - 2 C_{coop} \\cdot Yb_e^2 \\cdot A_0",
        "\\frac{dA^*}{dt} = C_{coop} \\cdot Yb_e^2 \\cdot A_0 - A_{rad} \\cdot A^*"
    ],
    observables: "I_em ∝ A_rad · A*   (I_UC ∝ Yb_e² → quadratic in pump power)",
    parameters: {
        "R_p": "Pump rate into Yb (s⁻¹)",
        "C_coop": "Cooperative coupling coefficient (s⁻¹·cm⁶)",
        "A_0": "Activator ground-state population",
        "A_rad": "Activator radiative rate (s⁻¹)",
        "τ_D": "Yb donor lifetime (ms)"
    },
    hallmark: "I_UC ∝ P² (strictly quadratic at all powers); typically ~10³× weaker than ETU"
};

// --- 2d-iv. Downconversion ODE Database ---
const odeDatabaseDC = {
    title: "Quantum Cutting / Downconversion",
    description: "One high-energy photon absorbed by a sensitizer (Yb–Tm, Pr, etc.) is converted into two or more lower-energy photons. Quantum yield can exceed 100%. Commonly observed in Yb³⁺–Tm³⁺ under UV excitation.",
    latex_system: [
        "\\frac{dS^*}{dt} = \\sigma_{UV} \\cdot \\Phi_{UV} \\cdot S_0 - W_{DC1} \\cdot S^* \\cdot A_0 - A_S \\cdot S^*",
        "\\frac{dA^*}{dt} = W_{DC1} \\cdot S^* \\cdot A_0 + W_{DC2} \\cdot S^{**} \\cdot A_0 - A_{rad} \\cdot A^*"
    ],
    observables: "QY = (photons emitted / photons absorbed) ≥ 100%",
    parameters: {
        "σ_UV": "UV absorption cross-section (cm²)",
        "W_DC1, W_DC2": "Sequential energy transfer rates for quantum cutting steps (s⁻¹)",
        "A_rad": "Activator radiative rate (s⁻¹)"
    },
    hallmark: "QY can exceed 100% (two NIR photons per single UV photon); I_DC ∝ Φ¹ (linear)"
};

// Combined lookup: mechanism key → ODE database entry
const mechanismOdeLookup = {
    etuc: odeDatabase,            // existing co-doped Yb/Tm database (emission-keyed)
    esa: odeDatabaseESA,
    photon_avalanche: odeDatabasePA,
    energy_migration_mediated: odeDatabaseEMMUC,
    cooperative: odeDatabaseCUSC,
    downconversion: odeDatabaseDC,
    single_doped_tm: odeDatabaseSingleTm // excitation-wavelength-keyed
};

// --- 2e. Phonon Energy Database ---
const phononEnergyDB = {
    'YF': 350, 'YF3': 350, 'NaYF': 350, 'NaYF4': 350,
    'GdF': 350, 'GdF3': 350, 'LuF': 350, 'LuF3': 350,
    'LaF': 350, 'LaF3': 350, 'YO': 550, 'Y2O3': 550,
    'GdO': 550, 'Gd2O3': 550, 'LuO': 550, 'Lu2O3': 550,
    'YCl': 250, 'YCl3': 250, 'GdCl': 250, 'GdCl3': 250,
    'LuCl': 250, 'LuCl3': 250, 'NaCl': 250,
    'YBr': 200, 'YBr3': 200, 'GdBr': 200, 'GdBr3': 200,
    'LuBr': 200, 'LuBr3': 200, 'NaBr': 200
};
// --- 2f. Development Fitting Evidence Database ---
const developmentFittingDB = {
    '1800': { title: '1800 nm development fitting', summary: 'Monitor metastable channel consistency.', remedies: ['Constrain A10 from trusted references.', 'Keep baseline drift minimal before fitting.'], evidence: [] },
    '1230': { title: '1230 nm development fitting', summary: 'Intermediate-state channel with lower signal-to-noise.', remedies: ['Increase smoothing window only if raw noise dominates.', 'Validate with decay tau rather than peak only.'], evidence: [] },
    '775': {
        title: '775 nm (3H4 -> 3H6) development fitting',
        summary: '775 serves as feeder-chain anchor; use this channel to stabilize transferred parameters before fitting 477/645.',
        remedies: [
            'Run 775 first to seed W1, k21, and A10.',
            'Use accurate + all points when transfer quality is critical.',
            'Check rise and decay timing metrics; transfer only if both are stable.'
        ],
        evidence: [
            { label: '10mol% Yb, 5mol% Tm', r2: '0.80505', file: 'Images/775-10.png' },
            { label: '10mol% Yb, 5mol% Tm', r2: '0.95819', file: 'static/plots/development/645_tm0200.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.99699', file: 'Images/775-5.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.89744', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.99569', file: 'Images/775-9.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.99950', file: 'Images/775-21.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.98995', file: 'Images/775-20.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.99975', file: 'Images/775-22.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99849', file: 'Images/775-2.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99945', file: 'Images/645.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99334', file: 'Images/775-11.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99931', file: 'Images/775-12.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.98887', file: 'Images/775-26.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.99971', file: 'Images/775-27.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' }
        ]
    },
    '645': {
        title: '645 nm (1G4 -> 3F4 Red) development fitting',
        summary: 'Current series shows strongest fit near Tm 0.5%, weaker quality at 0.2%, 1.0%, and 0.05%. Dominant mismatch is early-rise peak amplitude and shoulder over-broadening for specific concentrations.',
        remedies: [
            'Use 775 seed transfer first, then fit 645 with accurate mode and all-points enabled.',
            'Keep adaptive loops between 8-14 for 645; beyond this, monitor if SSE plateaus.',
            'At high Tm (>=1.0%), allow feeder-chain terms W2, A50, Wcr, and Wb to remain active.',
            'If peak is too low, increase 645 peak-point emphasis slightly; if tail worsens, reduce by one step.',
            'Verify baseline correction and pulse width; misalignment in t0 produces most early-peak error.'
        ],
        evidence: [
            { label: '10mol% Yb, 5mol% Tm', r2: '0.972563', file: 'Images/645-4.png' },
            { label: '10mol% Yb, 5mol% Tm', r2: '0.95819', file: 'static/plots/development/645_tm0200.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.97416', file: 'Images/645-5.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.89744', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.99673', file: 'Images/645-8.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.972563', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.99530', file: 'Images/645-15.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.99948', file: 'Images/645-13.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99651', file: 'Images/645-1.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99945', file: 'Images/645-14.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99898', file: 'Images/645-11.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99947', file: 'Images/645-12.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' }
        ]
    },
    '477': {
        title: '477 nm (1G4 -> 3H6 Blue) development fitting',
        summary: 'Blue channel is sensitive to feeder dynamics and timing; medium Tm can fit well, while high-Tm can show sharp-peak mismatch without feeder flexibility.',
        remedies: [
            'Use concentration-aware peak weighting; keep stronger 477 peak penalty for Tm >= 0.3%.',
            'Keep pulse-width fitting enabled with wider bounds for 477.',
            'At high Tm, unlock feeder terms W2, A50, Wcr and, when needed, Wb/k35.',
            'If early peak shifts, prioritize T_offset and pulse width before increasing loop count.',
            'If unresolved at high Tm, introduce explicit quenching term in Tm6 dynamics.'
        ],
        evidence: [
            { label: '10mol% Yb, 5mol% Tm', r2: '0.54237', file: 'Images/477-10.png' },
            { label: '10mol% Yb, 5mol% Tm', r2: '0.95819', file: 'static/plots/development/645_tm0200.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.88386', file: 'Images/477-4.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.89744', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.99569', file: 'Images/775.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.99950', file: 'Images/775.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.95819', file: 'Images/645.png.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.99970', file: 'Images/477-19.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99885', file: 'Images/645_tm1000.png.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99945', file: 'Images/645.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99898', file: 'Images/645.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99942', file: 'Images/477-11.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.99868', file: 'Images/477-26.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' }
        ]
    },
    '452':  { title: '452 nm development fitting',  summary: 'Upper-state channel; often sensitive to coupled transitions.', remedies: ['Use stable 645/477 fits before 452.', 'Watch over-parameterization in weakly identifiable terms.'], evidence: [] },
    '362':  {
        title: '362 nm (1D2 -> 3F4 UV) development fitting',
        summary: '362 nm is generally stable across 0.05-2.0% Tm, with strongest fits near 0.10% and 0.05%. The main failure mode appears at very low Tm (0.01%), where the modeled rise is too broad and peak amplitude collapses relative to experiment.',
        remedies: [
            'Treat 362 as a mostly well-behaved channel; use it as a consistency check for upper-state dynamics after 477/645 are stabilized.',
            'For 0.10-0.50% Tm, keep current weighting and accurate mode; these traces already fit well and do not need aggressive adaptive looping.',
            'For 1.0% Tm, prioritize early-rise alignment by checking pulse width and T_offset before changing state-population parameters.',
            'For 0.01% Tm, avoid over-smoothing and inspect normalization: the broad modeled rise suggests signal-to-noise or timing anchoring is dominating, not just optimization depth.',
            'If the very-low-Tm 362 trace remains poor, fit 452 and 477 first and transfer upper-ladder timing information before re-running 362.'
        ],
        evidence: [
            { label: '10mol% Yb, 5mol% Tm', r2: '0.972563', file: 'Images/645.png' },
            { label: '10mol% Yb, 5mol% Tm', r2: '0.95819', file: 'static/plots/development/645_tm0200.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.86598', file: 'Images/362-7.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.89744', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.93830', file: 'Images/362-8.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.99974', file: 'Images/362-11.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.95819', file: 'Images/645.png.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.99973', file: 'Images/362-14.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99885', file: 'Images/645_tm1000.png.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99969', file: 'Images/362-15.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99861', file: 'Images/362-2.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99974', file: 'Images/362-11.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' }
        ]
    },
    '345':  { 
        title: '345 nm development fitting', 
        summary: 'Top-tier UV emission can be sparse/noisy.',
        remedies: ['Use conservative smoothing and strict baseline checks.', 'Fit only after lower channels are well calibrated.'], 
        evidence: [
            { label: '10mol% Yb, 5mol% Tm', r2: '0.972563', file: 'Images/645.png' },
            { label: '10mol% Yb, 5mol% Tm', r2: '0.95819', file: 'static/plots/development/645_tm0200.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.94210', file: 'Images/345-6.png' },
            { label: '10mol% Yb, 2mol% Tm', r2: '0.89744', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.95147', file: 'Images/345-8.png' },
            { label: '10mol% Yb, 1mol% Tm', r2: '0.972563', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.97304', file: 'Images/345-17.png' },
            { label: '10mol% Yb, 0.5mol% Tm', r2: '0.99948', file: 'Images/645.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99528', file: 'Images/345-15.png' },
            { label: '10mol% Yb, 0.2mol% Tm', r2: '0.99945', file: 'Images/645.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.98140', file: 'Images/345-1.png' },
            { label: '10mol% Yb, 0.1mol% Tm', r2: '0.99916', file: 'Images/345-9.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.05mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.02mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' },
            { label: '10mol% Yb, 0.01mol% Tm', r2: '0.96117', file: 'static/plots/development/645_tm1000.png' }
        ]
    }
};

// ==================== 3. IMAGE MODAL ====================
function openModal(src) {
    const modal = document.getElementById("imageModal");
    const modalImg = document.getElementById("modalImg");
    if (!modal || !modalImg) return;

    currentZoom = 1; // reset zoom when opening
    modalImg.style.transform = `translate(-50%, -50%) scale(${currentZoom})`; // reset transform
    modalImg.style.cursor = 'zoom-in'; // reset cursor
    
    modal.style.display = "flex";   // show modal
    modalImg.src = src;             // set image source
}
function closeModal() {
    const modal = document.getElementById("imageModal");
    if (modal) {
        modal.style.display = "none";
        // Reset zoom when closing
        currentZoom = 1;
        const modalImg = document.getElementById("modalImg");
        if (modalImg) {
            modalImg.style.transform = `translate(-50%, -50%) scale(1)`;
        }
    }
}

function zoomModalImage(factor) {
    const modalImg = document.getElementById("modalImg");
    if (!modalImg) return;
    
    // Calculate new zoom level (between 0.5 and 3)
    currentZoom = Math.min(3, Math.max(0.5, currentZoom * factor));
    modalImg.style.transform = `translate(-50%, -50%) scale(${currentZoom})`;
    modalImg.style.cursor = currentZoom > 1 ? 'zoom-out' : 'zoom-in'; // smooth zoom transition
    
}

function resetModalZoom() {
    const modalImg = document.getElementById("modalImg");
    if (!modalImg) return;
    
    currentZoom = 1;
    modalImg.style.transform = `translate(-50%, -50%) scale(1)`;
    modalImg.style.cursor = 'zoom-in';
}
// Click on modal background to close
document.addEventListener('click', function(e) {
    const modal = document.getElementById("imageModal");
    if (modal && modal.style.display === 'flex') {
        if (e.target === modal) {
            closeModal();
        }
    }
});

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// Add click on image to toggle zoom (optional)
function setupModalImageClick() {
    const modalImg = document.getElementById("modalImg");
    if (!modalImg) return;
    
    modalImg.onclick = function(e) {
        e.stopPropagation();
        if (currentZoom > 1) {
            resetModalZoom();
        } else {
            zoomModalImage(1.5);
        }
    };
}

// Call this after DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    setupModalImageClick();
    
});

function zoomImage(imgElement) {
    const wrapper = imgElement.closest('.dev-card-wrapper');
    if (wrapper) {
        wrapper.classList.toggle('zoomed');
        if (wrapper.classList.contains('zoomed')) {
            wrapper.style.position = 'fixed';
            wrapper.style.top = '50%';
            wrapper.style.left = '50%';
            wrapper.style.transform = 'translate(-50%, -50%)';
            wrapper.style.width = '90vw';
            wrapper.style.height = '90vh';
            wrapper.style.zIndex = '10001';
            wrapper.style.background = 'rgba(0,0,0,0.9)';
            wrapper.style.cursor = 'zoom-out';
            imgElement.style.maxWidth = '90%';
            imgElement.style.maxHeight = '90%';
        } else {
            wrapper.style.position = '';
            wrapper.style.top = '';
            wrapper.style.left = '';
            wrapper.style.transform = '';
            wrapper.style.width = '';
            wrapper.style.height = '';
            wrapper.style.zIndex = '';
            wrapper.style.background = '';
            wrapper.style.cursor = '';
            imgElement.style.maxWidth = '100%';
            imgElement.style.maxHeight = '100%';
        }
    }
}

// ==================== 4. HELPER FUNCTIONS ====================

/**
 * Simplified POST helper — sends JSON and returns parsed response.
 * Throws on HTTP errors with the server's error message.
 */
async function apiPost(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Server error ${res.status}`);
    return json;
}

function safeGetElement(id) {
    const el = document.getElementById(id);
    if (!el) console.warn(`Element with id "${id}" not found`);
    return el;
}

function safeGetValue(id, defaultValue = '') {
    const el = safeGetElement(id);
    return el ? el.value : defaultValue;
}

function safeSetText(id, text) {
    const el = safeGetElement(id);
    if (el) el.textContent = text;
}

function safeSetHtml(id, html) {
    const el = safeGetElement(id);
    if (el) el.innerHTML = html;
}

function setFitResultsHtml(html) {
    const resContainer = document.getElementById('resultsContainer');
    if (resContainer) resContainer.innerHTML = html;
    const depotResults = document.getElementById('plotDepotResults');
    if (depotResults) depotResults.innerHTML = html;
}

function getFitResultsHtml() {
    const depotResults = document.getElementById('plotDepotResults');
    if (depotResults && depotResults.innerHTML) return depotResults.innerHTML;
    const resContainer = document.getElementById('resultsContainer');
    return resContainer?.innerHTML || '';
}

function showStatus(type, message) {
    const statusEl = safeGetElement('statusMessage');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `status-message status-${type}`;
    statusEl.style.display = 'block';
    if (type !== 'error') {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 5000);
    }
}

function setFitUiBusy(isBusy) {
    const fitBtn = safeGetElement('fitDataButton');
    const cancelBtn = safeGetElement('cancelFitButton');
    if (fitBtn) {
        fitBtn.disabled = isBusy;
        fitBtn.style.opacity = isBusy ? '0.5' : '1';
        fitBtn.style.cursor = isBusy ? 'not-allowed' : 'pointer';
    }
    if (cancelBtn) {
        cancelBtn.disabled = !isBusy;
        cancelBtn.style.opacity = isBusy ? '1' : '0.5';
        cancelBtn.style.cursor = isBusy ? 'pointer' : 'not-allowed';
    }
}

function createFitRequestId() {
    return `fit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// CONTINUE FIT button logic
function setFitStoppedState(isStopped) {
    const continueBtn = document.getElementById('continueFitButton');
    if (continueBtn) {
        continueBtn.style.display = isStopped ? 'inline-block' : 'none';
    }
}

// Example: Call setFitStoppedState(true) when fit is stopped
// Integrate with your fit status logic
// For demonstration, show CONTINUE button if FIT DATA is disabled and CANCEL FIT is disabled
function updateContinueFitButton() {
    const fitBtn = document.getElementById('fitDataButton');
    const cancelBtn = document.getElementById('cancelFitButton');
    const continueBtn = document.getElementById('continueFitButton');
    if (fitBtn && cancelBtn && continueBtn) {
        // Fit is stopped if FIT DATA is enabled OR CANCEL FIT is disabled
        const fitDisabled = fitBtn.disabled;
        const cancelDisabled = cancelBtn.disabled;
        // Show CONTINUE if fit is stopped (FIT DATA disabled, CANCEL disabled)
        continueBtn.style.display = (fitDisabled && cancelDisabled) ? 'inline-block' : 'none';
    }
}

// Call updateContinueFitButton whenever fit state changes
setInterval(updateContinueFitButton, 500); // Poll every 500ms (replace with event-driven if possible)


window.enablePeakEnhanceAndRefit = async function() {
    if (getActiveUploadMode() !== 'single') {
        showStatus('warning', 'Peak enhancement quick action is available in single-channel mode only.');
        return;
    }
    const toggle = safeGetElement('singlePeakEnhanceToggle');
    if (toggle) {
        toggle.checked = true;
    }
    appendFitLiveLog('Single-channel peak enhancement enabled. Re-running fit...');
    await window.fitData();
};

window.enableEarlyEnhanceAndRefit = async function() {
    if (getActiveUploadMode() !== 'single') {
        showStatus('warning', 'Early-rise enhancement quick action is available in single-channel mode only.');
        return;
    }
    const toggle = safeGetElement('singleEarlyEnhanceToggle');
    if (toggle) {
        toggle.checked = true;
    }
    appendFitLiveLog('Single-channel early-rise enhancement enabled. Re-running fit...');
    await window.fitData();
};

// ==================== 5. MULTI-CHANNEL STATE & UI ====================
function createEmptyMultiChannelSlotState() {
    const state = {};
    MULTI_CHANNEL_SLOTS.forEach(slot => {
        state[slot.id] = {
            emission: slot.defaultEmission,
            fileName: '',
            data: null,
            metadata: null,
            role: slot.role,
        };
    });
    return state;
}

function readCurrentFolderSampleConfig() {
    return {
        dopingYb: safeGetElement('dopingYbInput')?.value || '',
        dopingTm: safeGetElement('dopingTmInput')?.value || '',
        host: safeGetElement('hostSelect')?.value || '',
        anneal: safeGetElement('annealSelect')?.value || '',
        pulseWidthUs: safeGetElement('pulseWidthUs')?.value || '',
        timeUnit: safeGetElement('timeUnit')?.value || '',
        excitationWavelength: safeGetElement('excitationWavelength')?.value || '980',
    };
}

function applyFolderSampleConfig(config) {
    if (!config) return;
    const setValue = (id, value) => {
        const el = safeGetElement(id);
        if (!el || value == null || value === '') return;
        el.value = value;
    };
    setValue('dopingYbInput', config.dopingYb);
    setValue('dopingTmInput', config.dopingTm);
    setValue('hostSelect', config.host);
    setValue('annealSelect', config.anneal);
    setValue('pulseWidthUs', config.pulseWidthUs);
    setValue('timeUnit', config.timeUnit);
    setValue('excitationWavelength', config.excitationWavelength);
    updateExcitationEnergy();
}

function makeFolderLabel(index) {
    return `Folder ${index + 1}`;
}

function getActiveMultiChannelFolder() {
    return multiChannelFolders.find(folder => folder.id === activeMultiChannelFolderId) || null;
}

function persistActiveFolderConfig() {
    const folder = getActiveMultiChannelFolder();
    if (!folder) return;
    folder.sampleConfig = readCurrentFolderSampleConfig();
}

function syncActiveMultiChannelStateRef() {
    const folder = getActiveMultiChannelFolder();
    multiChannelSlotState = folder?.slotState || {};
}

function renderMultiChannelFolderQueue() {
    const host = safeGetElement('multiFolderQueue');
    if (!host) return;

    if (!multiChannelFolders.length) {
        host.innerHTML = '<div style="font-size:10px; color:#64748b;">No folders added yet.</div>';
        return;
    }

    host.innerHTML = multiChannelFolders.map((folder, idx) => {
        const isActive = folder.id === activeMultiChannelFolderId;
        const loadedCount = Object.values(folder.slotState || {}).filter(item => item && item.data).length;
        return `
            <div style="display:flex; gap:8px; align-items:center; border:1px solid ${isActive ? '#16a34a' : '#cbd5e1'}; background:${isActive ? '#ecfdf5' : '#fff'}; border-radius:6px; padding:6px 8px;">
                <button type="button" onclick="selectMultiChannelFolder('${folder.id}')" style="flex:1; text-align:left; border:none; background:transparent; color:${isActive ? '#166534' : '#1f2937'}; cursor:pointer; font-size:11px; font-weight:700;">
                    ${folder.name || makeFolderLabel(idx)} (${loadedCount} file${loadedCount === 1 ? '' : 's'})
                </button>
                <button type="button" onclick="removeMultiChannelFolder('${folder.id}')" style="padding:5px 8px; border:1px solid #dc2626; background:#fff; color:#dc2626; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer;" ${multiFitInProgress ? 'disabled' : ''}>
                    Remove
                </button>
            </div>
        `;
    }).join('');
}

function initialiseMultiChannelState() {
    multiChannelFolders = [];
    activeMultiChannelFolderId = null;
    activeMultiChannelSlotId = null;
    pendingMultiChannelSlotId = null;
    pendingMultiChannelFolderId = null;

    const folderId = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    multiChannelFolders.push({
        id: folderId,
        name: makeFolderLabel(0),
        slotState: createEmptyMultiChannelSlotState(),
        sampleConfig: readCurrentFolderSampleConfig(),
    });
    activeMultiChannelFolderId = folderId;
    syncActiveMultiChannelStateRef();
}

function getLoadedMultiChannelCount() {
    return multiChannelFolders.reduce((total, folder) => {
        return total + Object.values(folder.slotState || {}).filter(item => item && item.data).length;
    }, 0);
}

function refreshSidebarFileCount() {
    const sidebarCount = safeGetElement('sidebarFileCount');
    if (!sidebarCount) return;
    sidebarCount.textContent = uploadMode === 'multi'
        ? String(getLoadedMultiChannelCount())
        : String(multipleDatasets.length);
}

function findSlotIdByEmission(emission) {
    const entries = Object.entries(multiChannelSlotState);
    const match = entries.find(([, item]) => item.emission === emission && item.data);
    return match ? match[0] : null;
}

function getActiveUploadMode() {
    return uploadMode;
}

function syncEmissionSelection(emission) {
    const emissionSelect = safeGetElement('emissionSelect');
    if (emissionSelect && emission) {
        emissionSelect.value = emission;
    }
    updateActivePhysics();
}

function setActiveDatasetView(data, fileName, emission = '') {
    rawData = data || null;
    if (data && data.time && data.time.length) {
        safeSetText('analyzerCurrentFile', fileName || 'Loaded file');
        safeSetText('active-filename-display', fileName || 'Loaded file');
        safeSetText('analyzerFileInfo', `${data.time.length} data points${emission ? ` | ${emission} nm` : ''}`);
        plotRawData();
    } else {
        safeSetText('analyzerCurrentFile', 'No file loaded');
        safeSetText('active-filename-display', 'No file loaded...');
        safeSetText('analyzerFileInfo', 'Upload data to begin');
    }
}

function renderMultiChannelRows() {
    const host = safeGetElement('multiChannelRows');
    if (!host) return;

    const activeFolder = getActiveMultiChannelFolder();
    if (!activeFolder) {
        host.innerHTML = '<div style="font-size:10px; color:#64748b;">No active folder selected.</div>';
        return;
    }

    host.innerHTML = MULTI_CHANNEL_SLOTS.map(slot => {
        const state = multiChannelSlotState[slot.id] || {};
        const fileLoaded = Boolean(state.data);
        const isCarryForwardSource = Boolean(
            lastCarryForwardMarker &&
            lastCarryForwardMarker.folderId === activeFolder.id &&
            lastCarryForwardMarker.slotId === slot.id
        );
        const emissionOptions = EMISSION_OPTIONS.map(opt => `
            <option value="${opt.value}" ${state.emission === opt.value ? 'selected' : ''}>${opt.label}</option>
        `).join('');
        const badgeColor = slot.role === 'mandatory' ? '#b45309' : '#475569';
        const statusColor = isCarryForwardSource ? '#166534' : (fileLoaded ? '#166534' : '#64748b');
        const statusTextBase = fileLoaded ? state.fileName : 'No file loaded';
        const statusText = isCarryForwardSource
            ? `${statusTextBase} · Carry-forward source`
            : statusTextBase;
        const rowBorderColor = isCarryForwardSource ? '#22c55e' : '#fed7aa';
        const rowBackground = isCarryForwardSource ? '#f0fdf4' : '#fff';
        return `
            <div style="display:grid; grid-template-columns:minmax(140px, 1fr) minmax(120px, 0.9fr) auto auto; gap:8px; align-items:center; border:2px solid ${rowBorderColor}; background:${rowBackground}; border-radius:6px; padding:8px;">
                <div>
                    <div style="font-size:10px; color:${badgeColor}; font-weight:700; text-transform:uppercase; margin-bottom:4px;">${slot.role}</div>
                    <select id="${slot.id}_emission" onchange="handleMultiChannelEmissionChange('${slot.id}')" style="width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:5px; font-size:11px;">
                        ${emissionOptions}
                    </select>
                </div>
                <button type="button" class="multi-ode-btn" onclick="previewMultiChannelSlot('${slot.id}')" style="padding:7px 10px; border:1px solid #cbd5e1; background:#eff6ff; color:#1d4ed8; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer;" ${multiFitInProgress ? 'disabled' : ''}>
                    Show ODE
                </button>
                <button type="button" onclick="uploadMultiChannelFile('${slot.id}')" style="padding:7px 10px; border:1px solid #0f766e; background:#14b8a6; color:#fff; border-radius:5px; font-size:11px; font-weight:700; cursor:pointer;" ${multiFitInProgress ? 'disabled' : ''}>
                    Upload
                </button>
                <button type="button" onclick="deleteMultiChannelFile('${slot.id}')" style="padding:7px 10px; border:1px solid #dc2626; background:${fileLoaded ? '#ef4444' : '#fff'}; color:${fileLoaded ? '#fff' : '#dc2626'}; border-radius:5px; font-size:11px; font-weight:700; cursor:pointer;" ${multiFitInProgress ? 'disabled' : ''}>
                    Delete
                </button>
                <div style="grid-column:1 / -1; font-size:10px; color:${statusColor}; line-height:1.4;">
                    <strong>${activeFolder.name} | ${state.emission || 'Emission'} nm:</strong> ${statusText}
                </div>
            </div>
        `;
    }).join('');
}
// Default weights (script-level so fitData can access them)
const emissionDefaults = {
    1800: { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    1230: { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    775:  { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    645:  { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    477:  { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    452:  { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    362:  { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } },
    345:  { peak: 1.27, early: 1.3, tolerances: { peak: 0.01, decay: 0.10, rise: 0.10 } }
};

// Download log as text file
document.addEventListener('DOMContentLoaded', function() {
    const downloadbtn = document.getElementById('downloadLogBtn');
    if (downloadbtn) {
        downloadbtn.onclick = function() {
            const logEl = safeGetElement('fitLiveLog');
            if (!logEl) {
                    alert('No log element found.');
                    return;
            }
            let lines = [];
            for (let i = 0; i < logEl.children.length; i++) {
                lines.push(logEl.children[i].textContent);
            }
            if (!lines.length) {
                    alert('No log entries to download.');
                    return;
            }
            const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'fit_log.txt';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 200);
        };
    }
    const deletebtn = document.getElementById('deleteLogBtn');
    if (deletebtn) {
        deletebtn.onclick = function() {
            const logEl = document.getElementById('fitLiveLog');
            if (logEl) {
                logEl.innerHTML = '';
            }
        };
    }

    const selector = document.getElementById('emissionSelector');
    const peakInput = document.getElementById('peakWeightInput');
    const earlyInput = document.getElementById('earlyWeightInput');
    const applyWeightsBtn = document.getElementById('applyWeightsBtn');
   
    // Load values when emission changes
    function updateInputs() {
        const val = selector.value;

        if (!val || !emissionDefaults[val]) return;
        
        peakInput.value = emissionDefaults[val].peak;
        earlyInput.value = emissionDefaults[val].early;

        // Load per-emission tolerances into the tolerance inputs
        const tols = emissionDefaults[val].tolerances || {};
        const errPeakEl = document.getElementById('errPeak');
        const errDecayEl = document.getElementById('errDecay');
        const errRiseEl = document.getElementById('errRise');
        if (errPeakEl) errPeakEl.value = tols.peak ?? 0.01;
        if (errDecayEl) errDecayEl.value = tols.decay ?? 0.10;
        if (errRiseEl) errRiseEl.value = tols.rise ?? 0.10;
    }

    selector.addEventListener('change', updateInputs);

    // Send current emission weights to backend
    function sendWeightsToBackend() {
        const emission = selector.value;

        if (!emission || !emissionDefaults[emission]) return;
        
        const peakWeight = parseFloat(peakInput.value);
        const earlyWeight = parseFloat(earlyInput.value);

        if(!Number.isFinite(peakWeight) || !Number.isFinite(earlyWeight)) return;
           // -------------------- TOLERANCE INPUTS (ADDED) --------------------
        const peakErr = parseFloat(document.getElementById('errPeak')?.value);
        const decayErr = parseFloat(document.getElementById('errDecay')?.value);
        const riseErr  = parseFloat(document.getElementById('errRise')?.value);

        const errorTolerance = {
            peak: Number.isFinite(peakErr) ? peakErr : 0.01,
            decay: Number.isFinite(decayErr) ? decayErr : 0.10,
            rise: Number.isFinite(riseErr) ? riseErr : 0.10
        };

        // Update local storage (weights + tolerances)
        emissionDefaults[emission].peak = peakWeight;
        emissionDefaults[emission].early = earlyWeight;
        if (!emissionDefaults[emission].tolerances) emissionDefaults[emission].tolerances = {};
        emissionDefaults[emission].tolerances.peak = errorTolerance.peak;
        emissionDefaults[emission].tolerances.decay = errorTolerance.decay;
        emissionDefaults[emission].tolerances.rise = errorTolerance.rise;

        // POST to backend
        apiPost('/updateEmissionWeights', { emission, peakWeight, earlyWeight, errorTolerance })
            .then(response => console.log('Backend response:', response))
            .catch(err => console.error('Failed to send weights:', err));
    }

    // Send updates live when inputs change (debounced 300ms)
    let timeout;
    function sendWeightsDebounced() {
        clearTimeout(timeout);
        timeout = setTimeout(sendWeightsToBackend, 300);
    }

    peakInput.addEventListener('input', sendWeightsDebounced);
    earlyInput.addEventListener('input', sendWeightsDebounced);
    // Also send when tolerance inputs change
    ['errPeak', 'errDecay', 'errRise'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', sendWeightsDebounced);
    });

    // Save button as backup
    if (applyWeightsBtn) {
        applyWeightsBtn.addEventListener('click', sendWeightsToBackend);
    }

    // Initialize first selection
    if (selector.value && emissionDefaults[selector.value]){
         updateInputs();}

});

// ==================== 6. MULTI-CHANNEL ACTIONS ====================
window.addMultiChannelFolder = function() {
    if (multiFitInProgress) {
        showStatus('warning', 'Cannot add folders while a multi-channel run is in progress.');
        return;
    }
    persistActiveFolderConfig();
    const folderId = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const folderName = makeFolderLabel(multiChannelFolders.length);
    multiChannelFolders.push({
        id: folderId,
        name: folderName,
        slotState: createEmptyMultiChannelSlotState(),
        sampleConfig: readCurrentFolderSampleConfig(),
    });
    activeMultiChannelFolderId = folderId;
    syncActiveMultiChannelStateRef();
    renderMultiChannelFolderQueue();
    renderMultiChannelRows();
    refreshSidebarFileCount();
    showStatus('success', `Added ${folderName}.`);
};

window.selectMultiChannelFolder = function(folderId) {
    if (multiFitInProgress) {
        showStatus('warning', 'Folder switching is locked while a multi-channel run is in progress.');
        return;
    }
    const next = multiChannelFolders.find(folder => folder.id === folderId);
    if (!next) return;
    persistActiveFolderConfig();
    activeMultiChannelFolderId = next.id;
    syncActiveMultiChannelStateRef();
    applyFolderSampleConfig(next.sampleConfig);
    renderMultiChannelFolderQueue();
    renderMultiChannelRows();
    const loadedEntry = Object.entries(multiChannelSlotState).find(([, item]) => item.data);
    if (loadedEntry) {
        previewMultiChannelSlot(loadedEntry[0]);
    } else {
        setActiveDatasetView(null, 'No file loaded');
    }
    refreshSidebarFileCount();
};

window.removeMultiChannelFolder = function(folderId) {
    if (multiFitInProgress) {
        showStatus('warning', 'Cannot remove folders while a multi-channel run is in progress.');
        return;
    }
    if (multiChannelFolders.length <= 1) {
        showStatus('warning', 'At least one folder is required.');
        return;
    }
    const idx = multiChannelFolders.findIndex(folder => folder.id === folderId);
    if (idx < 0) return;
    const removed = multiChannelFolders.splice(idx, 1)[0];
    if (activeMultiChannelFolderId === folderId) {
        const fallback = multiChannelFolders[Math.max(0, idx - 1)] || multiChannelFolders[0];
        activeMultiChannelFolderId = fallback?.id || null;
    }
    syncActiveMultiChannelStateRef();
    const active = getActiveMultiChannelFolder();
    if (active) applyFolderSampleConfig(active.sampleConfig);
    renderMultiChannelFolderQueue();
    renderMultiChannelRows();
    refreshSidebarFileCount();
    showStatus('success', `Removed ${removed.name}.`);
};

window.captureFolderComposition = function() {
    persistActiveFolderConfig();
    const folder = getActiveMultiChannelFolder();
    if (!folder) return;
    showStatus('success', `Saved composition settings for ${folder.name}.`);
};

window.switchUploadMode = function(mode) {
    uploadMode = mode === 'multi' ? 'multi' : 'single';
    const singleEl = safeGetElement('singleUploadControls');
    const multiEl = safeGetElement('multiUploadControls');
    const emissionSelect = safeGetElement('emissionSelect');

    if (singleEl) singleEl.style.display = uploadMode === 'single' ? 'block' : 'none';
    if (multiEl) multiEl.style.display = uploadMode === 'multi' ? 'block' : 'none';
    if (emissionSelect) {
        emissionSelect.disabled = uploadMode === 'multi';
        emissionSelect.style.background = uploadMode === 'multi' ? '#f8fafc' : '#fff';
    }

    const fitBtn = safeGetElement('fitDataButton');
    if (fitBtn) {
        fitBtn.textContent = uploadMode === 'multi' ? '⚡ FIT LOADED CHANNELS' : '⚡ FIT MY DATA';
    }

    if (uploadMode === 'single') {
        persistActiveFolderConfig();
        setActiveDatasetView(singleRawData, singleActiveFileName);
    } else {
        const activeFolder = getActiveMultiChannelFolder();
        if (activeFolder) applyFolderSampleConfig(activeFolder.sampleConfig);
        renderMultiChannelFolderQueue();
        if (activeMultiChannelSlotId && multiChannelSlotState[activeMultiChannelSlotId]?.data) {
            previewMultiChannelSlot(activeMultiChannelSlotId);
        } else {
            renderMultiChannelRows();
        }
    }

    refreshSidebarFileCount();
    updateLuminescenceFlowUi();
};

window.handleMultiChannelEmissionChange = function(slotId) {
    const state = multiChannelSlotState[slotId];
    const select = safeGetElement(`${slotId}_emission`);
    if (!state || !select) return;

    const newEmission = select.value;
    const duplicate = Object.entries(multiChannelSlotState).find(([otherId, item]) => {
        return otherId !== slotId && item.emission === newEmission && item.data;
    });
    if (duplicate) {
        showStatus('warning', `Emission ${newEmission} nm is already assigned to ${duplicate[1].fileName}. Choose a different emission or delete the existing one first.`);
        select.value = state.emission;
        return;
    }

    state.emission = newEmission;
    if (state.data) {
        previewMultiChannelSlot(slotId);
    } else {
        syncEmissionSelection(newEmission);
    }
    renderMultiChannelRows();
};

window.uploadMultiChannelFile = function(slotId) {
    pendingMultiChannelSlotId = slotId;
    pendingMultiChannelFolderId = activeMultiChannelFolderId;
    const input = safeGetElement('multiChannelFileInput');
    if (input) input.click();
};

window.previewMultiChannelSlot = function(slotId) {
    const state = multiChannelSlotState[slotId];
    if (!state) return;
    activeMultiChannelSlotId = slotId;
    syncEmissionSelection(state.emission);
    if (state.data) {
        const activeFolder = getActiveMultiChannelFolder();
        const labelPrefix = activeFolder?.name ? `${activeFolder.name} | ` : '';
        setActiveDatasetView(state.data, `${labelPrefix}${state.fileName || `${state.emission} nm`}`, state.emission);
    }
};

window.deleteMultiChannelFile = function(slotId) {
    const state = multiChannelSlotState[slotId];
    if (!state || !state.data) {
        showStatus('warning', 'No multi-channel file loaded in that row.');
        return;
    }
    const removedName = state.fileName;
    state.fileName = '';
    state.data = null;
    state.metadata = null;
    if (activeMultiChannelSlotId === slotId) {
        const nextLoaded = Object.entries(multiChannelSlotState).find(([, item]) => item.data);
        if (nextLoaded) {
            previewMultiChannelSlot(nextLoaded[0]);
        } else {
            setActiveDatasetView(null, 'No file loaded');
        }
    }
    renderMultiChannelRows();
    renderMultiChannelFolderQueue();
    refreshSidebarFileCount();
    showStatus('success', `Removed ${removedName} from ${getActiveMultiChannelFolder()?.name || 'folder'}.`);
};

// ==================== 7. DEVELOPMENT FITTING EVIDENCE ====================
function renderDevelopmentFitting(emissionKey) {
    const key = developmentFittingDB[emissionKey] ? emissionKey : '775';
    const cfg = developmentFittingDB[key];

    safeSetText('devEmissionTitle', cfg.title || 'Development fitting');
    safeSetText('devEmissionSummary', cfg.summary || 'No summary available yet.');

    const remediesEl = safeGetElement('devRemedyList');
    if (remediesEl) {
        const remedies = cfg.remedies || [];
        remediesEl.innerHTML = remedies.length
            ? remedies.map(item => `<li>${item}</li>`).join('')
            : '<li>No remedies recorded yet.</li>';
    }

    const gridEl = safeGetElement('devEvidenceGrid');
    if (gridEl) {
        const evidence = cfg.evidence || [];
        if (!evidence.length) {
            gridEl.innerHTML = '<div style="padding:10px; border:1px dashed #94a3b8; border-radius:8px; color:#64748b; font-size:12px;">No development image saved yet for this emission.</div>';
        } else {
            gridEl.innerHTML = evidence.map((ev, idx) => `
               <div class="dev-card" onclick="toggleDevCard(this)" style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; transition:0.3s; cursor:pointer;">
                    <div style="padding:8px 10px; border-bottom:1px solid #e2e8f0; font-size:11px; color:#334155; font-weight:700; display:flex; justify-content:space-between; gap:8px;">
                        <span>${ev.label || `Development ${idx + 1}`}</span>
                        <span style="color:#0f766e;">R²: ${ev.r2 || 'N/A'}</span>
                    </div>
                    <div class="dev-card-wrapper" onclick="this.classList.toggle('zoomed')"
                         style="height:170px; background:#f8fafc; display:flex; align-items:center; justify-content:center; position:relative; cursor: zoom-in; transition:0.3s;">
                        <img src="${ev.file}" alt="${ev.label || 'development image'}" 
                            style="max-width:100%; max-height:100%; object-fit:contain; cursor:pointer;"
                            onclick="openModalImage('${ev.file}')"
                            onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                        <div style="display:none; padding:10px; text-align:center; font-size:11px; color:#64748b; line-height:1.5;">Image not found.<br>Expected: ${ev.file}</div>
                    </div>
                </div>
            `).join('');
        }
    }

    const selectEl = safeGetElement('devEmissionSelect');
    if (selectEl && selectEl.value !== key) {
        selectEl.value = key;
    }
}

window.updateDevelopmentFitting = function() {
    const selected = safeGetElement('devEmissionSelect')?.value || '645';
    renderDevelopmentFitting(selected);
};

// ==================== 8. LOGGING & PROGRESS POLLING ====================
function appendFitLiveLog(message) {
    const logEl = safeGetElement('fitLiveLog');
    if (!logEl) return;
    const stamp = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.textContent = `[${stamp}] ${message}`;
    line.style.padding = '2px 0';
    logEl.appendChild(line);
    while (logEl.children.length > 1000) {
        logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
}

function resetFitLiveLog() {
    const logEl = safeGetElement('fitLiveLog');
    if (!logEl) return;
    logEl.innerHTML = '';
    fitLastProgressSeq = -1;
    fitLastAdaptiveCycle = 0;
}

function stopFitProgressPolling() {
    if (fitProgressPoller) {
        clearInterval(fitProgressPoller);
        fitProgressPoller = null;
    }
}

function startFitProgressPolling(fitRequestId) {
    stopFitProgressPolling();
    fitLastProgressSeq = -1;
    fitLastAdaptiveCycle = 0;

    fitProgressPoller = setInterval(async () => {
        if (!fitRequestId) return;
        try {
            const res = await fetch(`/fit_progress?fit_request_id=${encodeURIComponent(fitRequestId)}`);
            if (!res.ok) return;
            const p = await res.json();
            if (!p.found) return;

            const seq = Number(p.seq || 0);
            if (seq > fitLastProgressSeq) {
                fitLastProgressSeq = seq;
                if (p.message) {
                    appendFitLiveLog(p.message);
                }
            }

            const doneCycles = Number(p.adaptive_completed_cycles || 0);
            if (doneCycles > fitLastAdaptiveCycle) {
                fitLastAdaptiveCycle = doneCycles;
            }
        } catch (_err) {
            // Silent polling errors keep UI responsive during fit.
        }
    }, 900);
}

// ==================== 9. DEPOSIT MANAGEMENT ====================
function savePlotDeposits() {
    try {
        localStorage.setItem('tm_plot_deposits', JSON.stringify(plotDeposits));
    } catch (err) {
        console.warn('Could not persist plot deposits:', err);
    }
}

function loadPlotDeposits() {
    try {
        const raw = localStorage.getItem('tm_plot_deposits');
        plotDeposits = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(plotDeposits)) {
            plotDeposits = [];
        }
    } catch (err) {
        plotDeposits = [];
        console.warn('Could not restore plot deposits:', err);
    }
}

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

function renderDepositList() {
    const listEl = safeGetElement('plotDepotList');
    if (!listEl) return;

    if (!plotDeposits.length) {
        listEl.innerHTML = '<div style="padding: 8px; color: #64748b;">No plots deposited yet.</div>';
        return;
    }

    listEl.innerHTML = plotDeposits.map((item, idx) => {
        const isActive = idx === activeDepositIndex;
        const isBest = item.isBestFit;
        return `
            <button onclick="openDepositedPlot(${idx})" style="
                width: 100%;
                text-align: left;
                margin-bottom: 6px;
                border: ${isBest ? '2px solid #16a34a' : ('1px solid ' + (isActive ? '#1d4ed8' : '#cbd5e1'))};
                background: ${isBest ? '#dcfce7' : (isActive ? '#dbeafe' : '#ffffff')};
                color: #1f2937;
                border-radius: 5px;
                padding: 8px;
                cursor: pointer;
                font-size: 11px;
            ">
                <div style="font-weight: 700; color: ${isBest ? '#166534' : '#1e3a8a'};">${isBest ? '★ ' : ''}${idx + 1}. ${item.fileName || 'Unnamed file'}${isBest ? ' <span style="font-size:10px; background:#16a34a; color:#fff; padding:1px 5px; border-radius:3px; margin-left:4px;">BEST FIT</span>' : ''}</div>
                <div style="margin-top: 3px; color: #475569;">${item.createdAtLabel || ''}${isBest && item.r2 != null ? ' | R²=' + item.r2.toFixed(6) : ''}</div>
            </button>
        `;
    }).join('');
}

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
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#f8fafc',
        font: { color: '#1f2937' }
    }, { responsive: true });

    if (resBox) {
        resBox.innerHTML = item.resultsHtml || 'No stored results summary for this run.';
    }
};

function clearDepositoryPreview() {
    const meta = safeGetElement('plotDepotMeta');
    const resBox = safeGetElement('plotDepotResults');
    if (meta) {
        meta.textContent = 'Select a deposited file name to preview its graph and results.';
    }
    if (resBox) {
        resBox.innerHTML = 'Result summary will appear here.';
    }
    if (typeof Plotly !== 'undefined') {
        Plotly.purge('plotDepotChart');
    }
}

window.deleteSelectedDepositedPlot = function() {
    if (!plotDeposits.length) {
        showStatus('warning', 'No deposited plots to delete.');
        return;
    }
    if (activeDepositIndex < 0 || activeDepositIndex >= plotDeposits.length) {
        showStatus('warning', 'Select a deposited plot first.');
        return;
    }

    const removed = plotDeposits.splice(activeDepositIndex, 1)[0];
    savePlotDeposits();

    if (!plotDeposits.length) {
        activeDepositIndex = -1;
        renderDepositList();
        clearDepositoryPreview();
    } else {
        activeDepositIndex = Math.min(activeDepositIndex, plotDeposits.length - 1);
        renderDepositList();
        window.openDepositedPlot(activeDepositIndex);
    }

    const name = removed?.fileName || 'selected plot';
    showStatus('success', `Deleted ${name} from plot depository.`);
};

window.clearAllDepositedPlots = function() {
    if (!plotDeposits.length) {
        showStatus('warning', 'No deposited plots to clear.');
        return;
    }
    const ok = confirm('Clear all deposited plots? This cannot be undone.');
    if (!ok) return;

    plotDeposits = [];
    activeDepositIndex = -1;
    savePlotDeposits();
    renderDepositList();
    clearDepositoryPreview();
    showStatus('success', 'All deposited plots cleared.');
};

function depositCurrentRun(fileName, payload, fitRes, time, measured, fitted, resultsHtml, extraFlags) {
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
            anneal_temp: payload?.anneal_temp,
            time_unit: payload?.time_unit,
            pulse_width_us: payload?.pulse_width_us,
            excitation_wavelength: payload?.excitation_wavelength,
            fit_quality: payload?.fit_quality
        },
        r2: fitRes?.r2,
        diagnostics: fitRes?.diagnostics || {},
        ode_parameters: fitRes?.ode_parameters || {},
        ode_parameter_units: fitRes?.ode_parameter_units || {},
        guide_parameters: fitRes?.guide_parameters || {},
        timing_metrics: fitRes?.timing_metrics || {},
        physics_output: fitRes?.physics_output || null,
        parameter_roles: fitRes?.parameter_roles || {},
        isBestFit: !!(extraFlags && extraFlags.isBestFit),
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

// ==================== 10. FIT CANCELLATION ====================
window.cancelFitting = async function() {
    if (!currentFitRequestId && !multiFitInProgress) {
        showStatus('warning', 'No fitting job is currently active.');
        return;
    }

    const reqId = currentFitRequestId;
    if (multiFitInProgress) {
        multiFitCancelRequested = true;
        appendFitLiveLog('Cancellation requested for multi-channel sequence.');
    }
    showStatus('warning', reqId ? `Cancelling fit ${reqId} ...` : 'Cancelling multi-channel sequence ...');

    if (currentFitAbortController) {
        currentFitAbortController.abort();
    }

    if (reqId) {
        try {
            await apiPost('/cancel_fit', { fit_request_id: reqId });
        } catch (err) {
            console.warn('Cancel request could not be confirmed:', err);
        }
    }

    const loading = safeGetElement('loadingIndicator');
    if (!multiFitInProgress && loading) loading.style.display = 'none';
    stopFitProgressPolling();
    appendFitLiveLog('Fit cancelled by user.');

    currentFitRequestId = null;
    currentFitAbortController = null;
    if (!multiFitInProgress) {
        setFitUiBusy(false);
    }

    const resContainer = safeGetElement('resultsContainer');
    if (resContainer) {
        resContainer.innerHTML = '<p style="color: #92400e; text-align: center;">Fit cancelled by user.</p>';
    }

    showStatus('warning', multiFitInProgress
        ? 'Cancellation requested. Multi-channel sequence is stopping...'
        : 'Fit cancelled. No new fit results were deposited.');
};

// ==================== 11. VIEW MANAGEMENT ====================
window.showView = function(viewName) {
    // Hide all views
    ['homeView', 'analyzerView', 'developmentView', 'simulatorView', 'helpView'].forEach(view => {
        const panel = safeGetElement(view);
        if (panel) panel.style.display = 'none';
    });
    
    // Show selected view
    const selectedView = safeGetElement(viewName + 'View');
    if (selectedView) selectedView.style.display = 'block';
    
    // Update sidebar
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
        item.style.color = '#bdc3c7';
        item.style.background = 'transparent';
        item.style.borderLeft = '4px solid transparent';
    });
    
    const activeItem = document.querySelector(`.menu-item[data-view="${viewName}"]`);
    if (activeItem) {
        activeItem.classList.add('active');
        activeItem.style.color = 'white';
        activeItem.style.background = 'rgba(52, 152, 219, 0.2)';
        activeItem.style.borderLeft = '4px solid #3498db';
    }
    
    // Update sidebar status
    const statusMap = { home: 'Welcome', analyzer: 'Analyzer Active', development: 'Development Fitting', simulator: 'Lifetime Generator', help: 'Help Center' };
    const colorMap = { home: '#3498db', analyzer: '#27ae60', development: '#f59e0b', simulator: '#8e44ad', help: '#f39c12' };
    safeSetText('sidebarStatus', statusMap[viewName] || 'Ready');
    const statusEl = safeGetElement('sidebarStatus');
    if (statusEl) statusEl.style.color = colorMap[viewName] || '#27ae60';
};

// ==================== 12. RIBBON MANAGEMENT ====================
window.showRibbonTab = function(tabName) {
    const contents = ['upload', 'sample', 'measurement', 'physics', 'advanced', 'mechanism', 'runsettings'];
    contents.forEach(id => {
        const el = safeGetElement('ribbonContent' + id.charAt(0).toUpperCase() + id.slice(1));
        if (el) el.style.display = 'none';
    });
    
    const selected = safeGetElement('ribbonContent' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (selected) selected.style.display = 'block';
    
    document.querySelectorAll('.ribbon-tab').forEach(tab => {
        tab.style.background = 'transparent';
        tab.style.borderBottom = '3px solid transparent';
        tab.style.color = '#6b7280';
    });
    
    const activeTab = safeGetElement('ribbonTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (activeTab) {
        activeTab.style.background = 'white';
        activeTab.style.borderBottom = '3px solid #667eea';
        activeTab.style.color = '#667eea';
    }
};

// ==================== 13. FILE PARSING ====================
function parseCSVContent(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    const metadata = {};
    let dataStartIdx = 0;
    
    // Try to detect metadata
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const line = lines[i].trim();
        if (line.includes(',')) {
            const parts = line.split(',').map(p => p.trim());
            if (parts.length >= 2) {
                const first = parseFloat(parts[0]);
                const second = parseFloat(parts[1]);
                if (isNaN(first) || isNaN(second)) {
                    metadata[parts[0]] = parts[1];
                    dataStartIdx = i + 1;
                } else {
                    break;
                }
            }
        } else if (line.includes(':')) {
            const parts = line.split(':').map(p => p.trim());
            if (parts.length >= 2) {
                metadata[parts[0]] = parts[1];
                dataStartIdx = i + 1;
            }
        } else {
            break;
        }
    }
    
    const time = [];
    const intensity = [];
    
    for (let i = dataStartIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(/[,\s]+/);
        if (parts.length >= 2) {
            const t = parseFloat(parts[0]);
            const I = parseFloat(parts[1]);
            if (!isNaN(t) && !isNaN(I)) {
                time.push(t);
                intensity.push(I);
            }
        }
    }
    
    if (time.length === 0) {
        throw new Error('No valid numeric data found');
    }
    
    return { time, intensity, metadata };
}

function parseJSONContent(content) {
    const data = JSON.parse(content);
    let time, intensity;
    
    if (data.data && data.data.time && data.data.intensity) {
        time = data.data.time;
        intensity = data.data.intensity;
    } else if (Array.isArray(data)) {
        time = data.map(d => d.time || d.t || d[0]);
        intensity = data.map(d => d.intensity || d.i || d[1]);
    } else {
        throw new Error('Invalid JSON format');
    }
    
    if (!Array.isArray(time) || !Array.isArray(intensity) || time.length === 0) {
        throw new Error('JSON must contain time and intensity arrays');
    }
    
    return { time, intensity, metadata: data.metadata || {} };
}

// ==================== 14. FILE PROCESSING ====================
function processMultipleFiles(files, fileNameDiv) {
    multipleDatasets = [];
    currentFitIndex = 0;
    
    Array.from(files).forEach((file, index) => {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            try {
                const content = e.target.result;
                let data = null;
                
                if (file.name.endsWith('.json')) {
                    data = parseJSONContent(content);
                } else {
                    data = parseCSVContent(content);
                }
                
                if (data) {
                    let displayName = file.name;
                    if (data.metadata && Object.keys(data.metadata).length > 0) {
                        const metaParts = Object.entries(data.metadata)
                            .map(([k, v]) => `${k}: ${v}`);
                        displayName = metaParts.join(' | ');
                    }
                    
                    multipleDatasets.push({
                        name: file.name,
                        displayName: displayName,
                        data: data
                    });
                    
                    // Load first file automatically
                    if (multipleDatasets.length === 1) {
                        rawData = data;
                        singleRawData = data;
                        currentFitIndex = 0;
                        singleActiveFileName = file.name;
                        
                        // Update UI
                        safeSetText('fileName', '✓ ' + file.name);
                        safeSetText('analyzerCurrentFile', file.name);
                        safeSetText('active-filename-display', file.name);
                        safeSetText('analyzerFileInfo', `${data.time.length} data points`);
                        
                        const deleteBtn = safeGetElement('deleteDataBtn');
                        if (deleteBtn) deleteBtn.style.display = 'block';
                        
                        plotRawData();
                    }
                    
                    // Update file count
                    refreshSidebarFileCount();
                    
                    showStatus('success', `✓ Loaded ${file.name}`);
                }
            } catch (err) {
                console.error('Error processing file:', err);
                showStatus('error', `✗ Error loading ${file.name}: ${err.message}`);
            }
        };
        
        reader.onerror = () => {
            showStatus('error', `✗ Error reading ${file.name}`);
        };
        
        reader.readAsText(file);
    });
}

// ==================== 15. FILE UPLOAD HANDLERS ====================
function initializeFileUploadHandlers() {
    const uploadFileBtn = safeGetElement('uploadFileBtn');
    const uploadFolderBtn = safeGetElement('uploadFolderBtn');
    const fileInput = safeGetElement('fileInput');
    const folderInput = safeGetElement('folderInput');
    const multiChannelFileInput = safeGetElement('multiChannelFileInput');
    
    if (uploadFileBtn && fileInput) {
        uploadFileBtn.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            const fileNameDiv = safeGetElement('fileName');
            
            if (!files || files.length === 0) {
                if (fileNameDiv) fileNameDiv.textContent = 'No file selected';
                return;
            }
            
            if (fileNameDiv) {
                fileNameDiv.textContent = files.length === 1 ? 
                    `✓ ${files[0].name}` : `✓ ${files.length} files selected`;
            }
            
            processMultipleFiles(files, fileNameDiv);
            fileInput.value = ''; // Allow re-upload of same file
        });
    }
    
    if (uploadFolderBtn && folderInput) {
        uploadFolderBtn.addEventListener('click', () => folderInput.click());
        
        folderInput.addEventListener('change', (e) => {
            const files = e.target.files;
            const folderNameDiv = safeGetElement('folderName');
            
            if (!files || files.length === 0) {
                if (folderNameDiv) folderNameDiv.textContent = 'No folder selected';
                return;
            }
            
            if (folderNameDiv) {
                folderNameDiv.textContent = `📁 ${files.length} files selected`;
                folderNameDiv.style.display = 'block';
            }
            
            processMultipleFiles(files, folderNameDiv);
        });
    }

    if (multiChannelFileInput) {
        multiChannelFileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            const slotId = pendingMultiChannelSlotId;
            const folderId = pendingMultiChannelFolderId;
            pendingMultiChannelSlotId = null;
            pendingMultiChannelFolderId = null;
            multiChannelFileInput.value = '';

            if (!slotId || !files.length) {
                return;
            }

            const targetFile = files[0];
            if (files.length > 1) {
                showStatus('warning', 'Multi-channel upload accepts one file per emission. Using the first selected file only.');
            }

            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const content = evt.target.result;
                    const parsed = targetFile.name.endsWith('.json')
                        ? parseJSONContent(content)
                        : parseCSVContent(content);
                    const folder = multiChannelFolders.find(item => item.id === folderId) || getActiveMultiChannelFolder();
                    const state = folder?.slotState?.[slotId];
                    if (!state) return;
                    state.fileName = targetFile.name;
                    state.data = parsed;
                    state.metadata = parsed.metadata || {};
                    if (folder?.id && folder.id !== activeMultiChannelFolderId) {
                        activeMultiChannelFolderId = folder.id;
                        syncActiveMultiChannelStateRef();
                    }
                    activeMultiChannelSlotId = slotId;
                    renderMultiChannelRows();
                    renderMultiChannelFolderQueue();
                    refreshSidebarFileCount();
                    previewMultiChannelSlot(slotId);
                    showStatus('success', `✓ Loaded ${targetFile.name} for ${state.emission} nm in ${folder?.name || 'active folder'}.`);
                } catch (err) {
                    console.error('Error processing multi-channel file:', err);
                    showStatus('error', `✗ Error loading ${targetFile.name}: ${err.message}`);
                }
            };
            reader.onerror = () => {
                showStatus('error', `✗ Error reading ${targetFile.name}`);
            };
            reader.readAsText(targetFile);
        });
    }
}

// ==================== 16. DATA PLOTTING ====================
function plotRawData() {
    if (!rawData || !rawData.time || rawData.time.length === 0) {
        console.warn('No data to plot');
        return;
    }
    
    const trace = {
        x: rawData.time,
        y: rawData.intensity,
        mode: 'markers',
        name: 'Experimental Data',
        marker: { size: 5, color: '#667eea', opacity: 0.7 }
    };
    
    const layout = {
        title: `Raw Data (${rawData.time.length} points)`,
        xaxis: { title: 'Time' },
        yaxis: { title: 'Intensity' },
        margin: { l: 70, r: 20, t: 50, b: 50 }
    };
    
    Plotly.newPlot('fitChart', [trace], layout, { responsive: true });
}

// ==================== 17. PHYSICS FUNCTIONS ====================
window.updateActivePhysics = function() {
    const emission = safeGetElement('emissionSelect')?.value;
    if (!emission) return;
    
    const odeData = odeDatabase[emission];
    if (!odeData) return;
    
    safeSetText('math-ode', '$$' + odeData.latex + '$$');
    safeSetHtml('pop-logic', odeData.population.map(t => '• ' + t).join('<br>'));
    safeSetHtml('depop-logic', odeData.depopulation.map(t => '• ' + t).join('<br>'));
    
    if (typeof MathJax !== 'undefined') {
        MathJax.typesetPromise([safeGetElement('math-ode')]).catch(err => console.log('MathJax error:', err));
    }
};

window.updateExcitationEnergy = function() {
    const wavelengthInput = safeGetElement('excitationWavelength');
    const energyDisplay = safeGetElement('excitationEnergyDisplay');
    if (!wavelengthInput || !energyDisplay) return;
    
    const wavelength = parseFloat(wavelengthInput.value);
    if (isNaN(wavelength) || wavelength <= 0) {
        energyDisplay.textContent = '⚡ Energy: Invalid wavelength';
        energyDisplay.style.color = '#ef4444';
        return;
    }
    
    const energyEv = 1239.84 / wavelength;
    const energyKjMol = energyEv * 96.485;
    energyDisplay.textContent = `⚡ Energy: ${energyEv.toFixed(3)} eV | ${energyKjMol.toFixed(1)} kJ/mol`;
    energyDisplay.style.color = '#667eea';
};

window.selectElement = function(symbol, type, evt) {
    if (type === 'cation') {
        selectedCation = symbol;
        document.querySelectorAll('.element-btn.cation').forEach(btn => btn.classList.remove('selected'));
        evt.target.closest('.element-btn').classList.add('selected');
    } else {
        selectedAnion = symbol;
        document.querySelectorAll('.element-btn.anion').forEach(btn => btn.classList.remove('selected'));
        evt.target.closest('.element-btn').classList.add('selected');
    }
    
    if (selectedCation && selectedAnion) {
        calculateLatticeEnergy(selectedCation, selectedAnion);
    }
};

window.calculateLatticeEnergy = function(cation, anion) {
    let formula = '';
    if (anion === 'O') {
        formula = `${cation}2O3`;
    } else {
        formula = `${cation}${anion}3`;
    }
    
    const lookupKey = `${cation}${anion}`;
    let phononEnergy = phononEnergyDB[lookupKey] || phononEnergyDB[formula] || 400;
    
    let phononRegime, ucEfficiency;
    if (phononEnergy < 300) {
        phononRegime = 'Very Low Phonon';
        ucEfficiency = 'Excellent';
    } else if (phononEnergy <= 400) {
        phononRegime = 'Low Phonon (Fluoride)';
        ucEfficiency = 'Excellent';
    } else if (phononEnergy <= 500) {
        phononRegime = 'Medium Phonon';
        ucEfficiency = 'Good';
    } else {
        phononRegime = 'High Phonon (Oxide)';
        ucEfficiency = 'Moderate';
    }
    
    safeSetText('latticeFormula', formula);
    safeSetText('phononEnergyValue', `${phononEnergy} cm⁻¹`);
    safeSetText('phononRegime', phononRegime);
    safeSetText('ucEfficiency', ucEfficiency);
    
    lastCalculatedPhonon = phononEnergy;
    
    const autoSync = safeGetElement('autoSyncPhonon')?.checked;
    if (autoSync) {
        const phononInput = safeGetElement('phononEnergyInput');
        const phononNR = safeGetElement('phononEnergy_NR');
        if (phononInput) phononInput.value = phononEnergy;
        if (phononNR) phononNR.value = phononEnergy;
        
        const syncStatus = safeGetElement('phononSyncStatus');
        if (syncStatus) {
            syncStatus.style.display = 'block';
            syncStatus.textContent = '✓ Synced to ' + phononEnergy + ' cm⁻¹';
            setTimeout(() => { syncStatus.style.display = 'none'; }, 3000);
        }
    }
};

window.syncPhononToInput = function() {
    if (lastCalculatedPhonon) {
        const phononInput = safeGetElement('phononEnergyInput');
        const phononNR = safeGetElement('phononEnergy_NR');
        if (phononInput) phononInput.value = lastCalculatedPhonon;
        if (phononNR) phononNR.value = lastCalculatedPhonon;
        
        const syncStatus = safeGetElement('phononSyncStatus');
        if (syncStatus) {
            syncStatus.style.display = 'block';
            syncStatus.textContent = '✓ Applied: ' + lastCalculatedPhonon + ' cm⁻¹';
            setTimeout(() => { syncStatus.style.display = 'none'; }, 3000);
        }
    }
};

window.updateWnrCalculation = function() {
    const tauFeeding = parseFloat(safeGetElement('tauFeeding3F4')?.value);
    const tauRad = parseFloat(safeGetElement('tauRad3H4')?.value);
    const wnrCalc = safeGetElement('wnr-calculated');
    const wnrValue = safeGetElement('wnr-value');
    
    if (!isNaN(tauFeeding) && !isNaN(tauRad) && tauFeeding > 0 && tauRad > 0) {
        const w_nr = (1000.0 / tauFeeding) - (1000.0 / tauRad);
        if (wnrValue) wnrValue.textContent = w_nr.toFixed(2);
        if (wnrCalc) {
            wnrCalc.style.display = 'block';
            wnrCalc.style.background = w_nr > 0 ? '#fff3cd' : '#ffebee';
        }
    } else if (wnrCalc) {
        wnrCalc.style.display = 'none';
    }
};

window.updateNrModeUi = function() {
    const mode = (safeGetElement('nrMode')?.value || 'theoretical').toLowerCase();
    const anchorGroup = safeGetElement('nrAnchorInputGroup');
    const expTauGroup = safeGetElement('nrExpTauGroup');
    const theoryGroup = safeGetElement('nrTheoryInputs');
    const help = safeGetElement('nrModeHelp');

    const isTheoretical = mode === 'theoretical';
    const isAnchor = mode === 'anchor';
    const isManual = mode === 'manual';
    const isFit = mode === 'fit';

    if (anchorGroup) anchorGroup.style.display = (isAnchor || isManual) ? 'block' : 'none';
    if (expTauGroup) expTauGroup.style.display = (isAnchor || isManual) ? 'block' : 'none';
    if (theoryGroup) theoryGroup.style.display = (isTheoretical || isManual) ? 'grid' : 'none';

    if (help) {
        if (isTheoretical) {
            help.textContent = '💡 Step 2: Theoretical mode uses phonon energy with C and α constants.';
        } else if (isAnchor) {
            help.textContent = '💡 Step 3: Fill Primary Anchor τexp first; Optional Feeding τexp can be left blank; then set τrad(Feeding).';
        } else if (isManual) {
            help.textContent = '💡 Step 4: Manual mode exposes all NR inputs for expert tuning.';
        } else {
            help.textContent = '💡 Step 1 (recommended): Fit-assisted mode for the first run with minimal NR tuning.';
        }
    }
};

window.syncPhysicsConstants = function() {
    try {
        const phononEnergy = parseFloat(safeGetElement('phononEnergy_NR')?.value || '350');
        const expTau3H4 = parseFloat(safeGetElement('expTau3H4')?.value || '0');
        const tauFeedingInput = parseFloat(safeGetElement('tauFeeding3F4')?.value || '0');
        const tauRad3H4 = parseFloat(safeGetElement('tauRad3H4')?.value || '0');
        const timeOffset = parseFloat(safeGetElement('timeOffset')?.value || '0');
        const nrMode = safeGetElement('nrMode')?.value || 'theoretical';
        const couplingC = parseFloat(safeGetElement('couplingC')?.value || '1.0e7');
        const alphaParam = parseFloat(safeGetElement('alphaParam')?.value || '4.0e-3');
        let tauFeeding3F4 = tauFeedingInput;
        if ((nrMode === 'anchor' || nrMode === 'manual') && !(tauFeeding3F4 > 0) && expTau3H4 > 0) {
            tauFeeding3F4 = expTau3H4;
            const tauFeedingInputEl = safeGetElement('tauFeeding3F4');
            if (tauFeedingInputEl) tauFeedingInputEl.value = String(expTau3H4);
        }
        
        const useAnchor = ((nrMode === 'anchor' || nrMode === 'manual') && expTau3H4 > 0);
        
        window.nonRadiativeConfig = {
            phonon_energy_cm: phononEnergy,
            exp_tau_3H4_us: expTau3H4,
            tau_feeding_3F4_us: tauFeeding3F4,
            tau_rad_3H4_us: tauRad3H4,
            time_offset_ms: timeOffset,
            nr_mode: nrMode,
            coupling_constant: couplingC,
            alpha_parameter: alphaParam,
            use_anchor: useAnchor
        };
        
        const applyBtn = safeGetElement('applyConstantsBtn');
        if (applyBtn) {
            const originalText = applyBtn.innerHTML;
            applyBtn.innerHTML = useAnchor ? '🔒 Anchor Mode Active!' : '✓ Constants Applied!';
            applyBtn.style.background = useAnchor ? 
                'linear-gradient(135deg, #dc3545 0%, #fd7e14 100%)' : 
                'linear-gradient(135deg, #28a745 0%, #20c997 100%)';
            
            setTimeout(() => {
                applyBtn.innerHTML = originalText;
                applyBtn.style.background = 'linear-gradient(135deg, #28a745 0%, #20c997 100%)';
            }, 2000);
        }
        
        showStatus('success', `✓ Physics constants applied (Mode: ${nrMode})`);
        
    } catch (err) {
        console.error('Error in syncPhysicsConstants:', err);
        showStatus('error', '✗ Error applying constants');
    }
};

// --- 17b. Multi-Channel Build & Luminescence Flow ---
function buildMultiChannelFitSequence(slotState = multiChannelSlotState) {
    const emissionToSlot = {};
    Object.entries(slotState || {}).forEach(([slotId, item]) => {
        if (item && item.data && item.emission && !emissionToSlot[item.emission]) {
            emissionToSlot[item.emission] = { slotId, ...item };
        }
    });

    const fallbackSourceByTarget = {
        '362': '477',
        '345': '362',
    };

    const sequence = [];
    for (const emission of MULTI_CHANNEL_ORDER) {
        const entry = emissionToSlot[emission];
        if (entry) {
            sequence.push({
                emission,
                slotId: entry.slotId,
                fileName: entry.fileName,
                data: entry.data,
                sourceEmission: emission,
                usedFallbackSource: false,
            });
            continue;
        }

        const fallbackSource = fallbackSourceByTarget[emission];
        const fallbackEntry = fallbackSource ? emissionToSlot[fallbackSource] : null;
        if (fallbackEntry) {
            sequence.push({
                emission,
                slotId: fallbackEntry.slotId,
                fileName: `${fallbackEntry.fileName} (proxy ${fallbackSource}→${emission})`,
                data: fallbackEntry.data,
                sourceEmission: fallbackSource,
                usedFallbackSource: true,
            });
            continue;
        }

        if (MULTI_CHANNEL_MANDATORY.has(emission)) {
            if (!sequence.length && emission === '775') {
                throw new Error('Multi-channel mode requires a 775 nm file to start the sequence.');
            }
            break;
        }
    }

    return sequence;
}

function getMultiChannelMinR2(emission) {
    const key = String(emission || '');
    const v = MULTI_CHANNEL_MIN_R2[key];
    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0.90;
}

function getMultiChannelQualityProfile(emission) {
    const key = String(emission || '');
    const profile = MULTI_CHANNEL_QUALITY_PROFILES[key] || {};
    return {
        riseLimit: 0.22,
        decayLimit: 0.22,
        peakLimit: 0.16,
        ampLimit: 0.10,
        riseWeight: 0.48,
        decayWeight: 0.30,
        peakWeight: 0.28,
        ampWeight: 0.28,
        ...GLOBAL_FIT_CONFIG,
        ...profile,
    };
}

function getLuminescenceFlowSelection() {
    const uiLumType = (safeGetElement('luminescenceTypeSelect')?.value || 'upconversion').toLowerCase();
    const upconversionMechanism = (safeGetElement('upconversionMechanismSelect')?.value || 'etuc').toLowerCase();
    const materialModel = (safeGetElement('materialModelSelect')?.value || 'co_doped_yb_tm').toLowerCase();
    const luminescenceType = materialModel === 'single_doped_tm' ? 'downshifting' : uiLumType;
    const isEtuc = luminescenceType === 'upconversion' && upconversionMechanism === 'etuc' && materialModel !== 'single_doped_tm';
    return { luminescenceType, upconversionMechanism, materialModel, isEtuc };
}

function collectMechanismParams() {
    return {
        tau_ms: parseFloat(safeGetElement('flowTauMs')?.value || '1.5'),
        rise_ms: parseFloat(safeGetElement('flowRiseMs')?.value || '0.08'),
        amp: parseFloat(safeGetElement('flowAmp')?.value || '1.0'),
        threshold_ms: parseFloat(safeGetElement('flowThresholdMs')?.value || '0.25'),
        sharpness: parseFloat(safeGetElement('flowSharpness')?.value || '12.0'),
    };
}

function collectSingleTmParams() {
    return {
        excitation_nm: parseInt(safeGetElement('singleTmExcWavelength')?.value || '785'),
        sigma_gsa: parseFloat(safeGetElement('singleTmSigmaGSA')?.value || '0.5'),
        sigma_esa: parseFloat(safeGetElement('singleTmSigmaESA')?.value || '0.3'),
        w_cr: parseFloat(safeGetElement('singleTmWcr')?.value || '2.0'),
        pump_power_mw: parseFloat(safeGetElement('singleTmPumpPower')?.value || '200'),
        tm_conc_mol: parseFloat(safeGetElement('singleTmConc')?.value || '1.0'),
        rise_ms: parseFloat(safeGetElement('flowRiseMs')?.value || '0.08'),
    };
}

// --- Single-doped Tm ODE display (called on wavelength change) ---
window.updateSingleTmOdeDisplay = function() {
    const wl = safeGetElement('singleTmExcWavelength')?.value || '785';
    const db = odeDatabaseSingleTm[wl];
    const eqDiv = safeGetElement('singleTmOdeEquations');
    const emDiv = safeGetElement('singleTmEmissions');
    if (!db || !eqDiv) return;

    let html = '<div style="font-size:10px;font-weight:700;color:#4338ca;margin-bottom:6px;">' + db.excitation_label + '</div>';
    html += '<div style="font-size:9px;color:#475569;margin-bottom:8px;line-height:1.3;">' + db.description + '</div>';
    for (const [key, state] of Object.entries(db.states)) {
        html += '<div style="margin-bottom:6px;padding:4px 6px;background:#f8fafc;border-radius:3px;">';
        html += '<div style="font-size:9px;font-weight:600;color:#1e293b;margin-bottom:2px;">' + key + ' — ' + state.label + '</div>';
        html += '<div style="font-size:12px;">\\(' + state.latex + '\\)</div>';
        if (state.observable) {
            html += '<div style="font-size:9px;color:#059669;margin-top:2px;">📍 ' + state.observable + '</div>';
        }
        html += '</div>';
    }
    eqDiv.innerHTML = html;

    // Emissions info
    if (emDiv) {
        let emHtml = '<strong>Observable emissions for ' + wl + ' nm excitation:</strong><br>';
        for (const state of Object.values(db.states)) {
            if (state.observable) emHtml += '• ' + state.observable + '<br>';
        }
        emDiv.innerHTML = emHtml;
    }
    // Re-typeset MathJax
    if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([eqDiv]);
};

// --- Render ODEs for any generic mechanism panel ---
function renderGenericMechanismOdes(db, targetDivId) {
    const el = safeGetElement(targetDivId);
    if (!el || !db) return;
    let html = '<div style="font-size:10px;font-weight:700;color:#334155;margin-bottom:4px;">' + db.title + '</div>';
    html += '<div style="font-size:9px;color:#475569;margin-bottom:6px;line-height:1.3;">' + db.description + '</div>';
    if (db.latex_system) {
        db.latex_system.forEach((eq, i) => {
            html += '<div style="margin-bottom:3px;font-size:12px;">\\(' + eq + '\\)</div>';
        });
    }
    if (db.hallmark) {
        html += '<div style="font-size:9px;color:#7c3aed;margin-top:4px;font-style:italic;">⚡ ' + db.hallmark + '</div>';
    }
    if (db.observables) {
        html += '<div style="font-size:9px;color:#059669;margin-top:3px;">📍 ' + db.observables + '</div>';
    }
    el.innerHTML = html;
    if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([el]);
}

// Show/hide mechanism-specific sub-panels inside ribbonContentMechanism
function applyMechanismSubPanel(flow) {
    const allPanels = ['mechParamsPA', 'mechParamsESA', 'mechParamsEMMUC', 'mechParamsCUSC', 'mechParamsDC', 'singleDopedTmPanel'];
    allPanels.forEach(id => { const el = safeGetElement(id); if (el) el.style.display = 'none'; });

    const mechTitles = {
        esa: 'Excited State Absorption (ESA)',
        photon_avalanche: 'Photon Avalanche',
        energy_migration_mediated: 'Energy Migration Mediated UC (EMMUC)',
        cooperative: 'Cooperative Sensitization (CUSC)',
    };
    let titleText = 'Mechanism Parameters';

    if (flow.materialModel === 'single_doped_tm' || flow.luminescenceType === 'downshifting') {
        const p = safeGetElement('singleDopedTmPanel'); if (p) p.style.display = 'block';
        titleText = 'Single-Doped Tm³⁺ Parameters';
        updateSingleTmOdeDisplay();
    } else if (flow.luminescenceType === 'downconversion') {
        const p = safeGetElement('mechParamsDC'); if (p) p.style.display = 'block';
        titleText = 'Downconversion Parameters';
        renderGenericMechanismOdes(odeDatabaseDC, 'dcOdeDisplay');
    } else {
        const panelMap = {
            esa: 'mechParamsESA',
            photon_avalanche: 'mechParamsPA',
            energy_migration_mediated: 'mechParamsEMMUC',
            cooperative: 'mechParamsCUSC',
        };
        const odeMap = {
            esa: ['odeDatabaseESA', 'esaOdeDisplay'],
            photon_avalanche: ['odeDatabasePA', 'paOdeDisplay'],
            energy_migration_mediated: ['odeDatabaseEMMUC', 'emmucOdeDisplay'],
            cooperative: ['odeDatabaseCUSC', 'cuscOdeDisplay'],
        };
        const panelId = panelMap[flow.upconversionMechanism];
        if (panelId) { const p = safeGetElement(panelId); if (p) p.style.display = 'block'; }
        titleText = mechTitles[flow.upconversionMechanism] || 'Mechanism Parameters';
        // Render ODE equations
        const odePair = odeMap[flow.upconversionMechanism];
        if (odePair) {
            const dbRef = { esa: odeDatabaseESA, photon_avalanche: odeDatabasePA, energy_migration_mediated: odeDatabaseEMMUC, cooperative: odeDatabaseCUSC };
            renderGenericMechanismOdes(dbRef[flow.upconversionMechanism], odePair[1]);
        }
    }
    const titleEl = safeGetElement('mechanismTabTitle');
    if (titleEl) titleEl.textContent = titleText;
}

window.updateLuminescenceFlowUi = function() {
    const flow = getLuminescenceFlowSelection();
    const lumTypeSelect = safeGetElement('luminescenceTypeSelect');
    const upWrap = safeGetElement('upconversionMechanismWrap');
    const etucHint = safeGetElement('etucFlowHint');
    const fitBtn = safeGetElement('fitDataButton');

    // ETUC-only ribbon tabs
    const etucOnlyTabs = ['ribbonTabPhysics', 'ribbonTabAdvanced'];
    // Non-ETUC ribbon tabs
    const nonEtucTabs = ['ribbonTabMechanism', 'ribbonTabRunsettings'];

    if (flow.materialModel === 'single_doped_tm' && lumTypeSelect) {
        lumTypeSelect.value = 'downshifting';
    }

    if (upWrap) upWrap.style.display = flow.luminescenceType === 'upconversion' ? 'block' : 'none';

    if (flow.isEtuc) {
        // Show ETUC tabs, hide non-ETUC tabs
        etucOnlyTabs.forEach(id => { const el = safeGetElement(id); if (el) el.style.display = ''; });
        nonEtucTabs.forEach(id => { const el = safeGetElement(id); if (el) el.style.display = 'none'; });
        // If a non-ETUC tab is currently active, switch to upload tab
        const activeCont = document.querySelector('.ribbon-content[style*="display: block"], .ribbon-content[style*="display:block"]');
        if (activeCont && (activeCont.id === 'ribbonContentMechanism' || activeCont.id === 'ribbonContentRunsettings')) {
            showRibbonTab('upload');
        }
        if (etucHint) {
            etucHint.style.display = 'block';
            etucHint.style.borderLeftColor = '#10b981';
            etucHint.style.background = '#ecfdf5';
            etucHint.style.color = '#065f46';
            etucHint.textContent = 'ETUC selected: current full ODE fitting pipeline (as planned) will be used.';
        }
        if (fitBtn) fitBtn.textContent = getActiveUploadMode() === 'multi' ? '⚡ FIT LOADED CHANNELS' : '⚡ FIT DATA';
    } else {
        // Hide ETUC tabs, show non-ETUC tabs
        etucOnlyTabs.forEach(id => { const el = safeGetElement(id); if (el) el.style.display = 'none'; });
        nonEtucTabs.forEach(id => { const el = safeGetElement(id); if (el) el.style.display = ''; });
        // If an ETUC-only tab is currently active, switch to mechanism tab
        const activeCont2 = document.querySelector('.ribbon-content[style*="display: block"], .ribbon-content[style*="display:block"]');
        if (activeCont2 && (activeCont2.id === 'ribbonContentPhysics' || activeCont2.id === 'ribbonContentAdvanced')) {
            showRibbonTab('mechanism');
        }
        // Populate mechanism sub-panel
        applyMechanismSubPanel(flow);

        if (etucHint) {
            etucHint.style.display = 'block';
            const mechLabel = flow.materialModel === 'single_doped_tm'
                ? 'Single-doped Tm / Downshifting'
                : flow.luminescenceType === 'downconversion'
                    ? 'Downconversion'
                    : ({ esa: 'ESA', photon_avalanche: 'Photon Avalanche', energy_migration_mediated: 'EMMUC', cooperative: 'CUSC' }[flow.upconversionMechanism] || flow.upconversionMechanism);
            etucHint.style.borderLeftColor = '#f59e0b';
            etucHint.style.background = '#fffbeb';
            etucHint.style.color = '#92400e';
            etucHint.textContent = mechLabel + ' selected: fill in the Mechanism Parameters and Run Settings tabs, then click ⚡.';
        }
        if (fitBtn) {
            const mode = safeGetElement('luminescenceRunModeSelect')?.value || 'simulate';
            fitBtn.textContent = mode === 'fit' ? '⚡ RUN FLOW FIT' : '⚡ RUN FLOW MODEL';
        }
    }
};

async function runAlternativeLuminescenceFlow(options = {}) {
    const flow = getLuminescenceFlowSelection();
    const sourceData = options.sourceData || rawData;
    const runMode = (safeGetElement('luminescenceRunModeSelect')?.value || 'simulate').toLowerCase();
    const selectedEmission = options.emission || safeGetElement('emissionSelect')?.value || '477';
    const useFit = runMode === 'fit';

    if (useFit && !sourceData) {
        showStatus('error', '✗ Upload data first to run non-ETUC fitting');
        return;
    }

    const payload = {
        luminescence_type: flow.luminescenceType,
        upconversion_mechanism: flow.upconversionMechanism,
        material_model: flow.materialModel,
        mechanism_params: collectMechanismParams(),
        single_tm_params: collectSingleTmParams(),
        emission: selectedEmission,
        doping_yb: parseFloat(safeGetElement('dopingYbInput')?.value || '10'),
        doping_tm: parseFloat(safeGetElement('dopingTmInput')?.value || '0.5'),
        time_unit: safeGetElement('timeUnit')?.value || 'ms',
        pulse_width_us: parseFloat(safeGetElement('pulseWidthUs')?.value || '400'),
        time_max_ms: parseFloat(safeGetElement('simTimeMax')?.value || '15'),
        num_points: parseInt(safeGetElement('simPoints')?.value || '500', 10),
    };

    if (sourceData) {
        payload.time = [...sourceData.time];
        payload.intensity = [...sourceData.intensity];
    }

    const endpoint = useFit ? '/fit_luminescence_flow' : '/simulate_luminescence_flow';
    showStatus('info', `⏳ Running ${flow.luminescenceType}/${flow.upconversionMechanism} (${runMode})...`);
    const result = await apiPost(endpoint, payload);
    if (result.error) {
        throw new Error(result.error);
    }

    const t = result.time_ms || payload.time || [];
    if (Array.isArray(result.fitted_intensity) && Array.isArray(result.measured_intensity)) {
        Plotly.newPlot('fitChart', [
            { x: t, y: result.measured_intensity, type: 'scatter', mode: 'lines', name: 'Experimental', line: { color: '#3b82f6', width: 2 } },
            { x: t, y: result.fitted_intensity, type: 'scatter', mode: 'lines', name: 'Flow Fit', line: { color: '#f97316', width: 2 } },
        ], {
            title: `${flow.luminescenceType} | ${flow.upconversionMechanism} | R²=${(result.r2 || 0).toFixed(5)}`,
            xaxis: { title: 'Time (ms)' },
            yaxis: { title: 'Normalized Intensity' },
            margin: { l: 60, r: 20, t: 45, b: 50 },
        }, { responsive: true });
    } else if (result.channels && t.length) {
        const traces = Object.entries(result.channels).map(([em, ch]) => ({
            x: t,
            y: ch.intensity || [],
            type: 'scatter',
            mode: 'lines',
            name: `${em} nm`,
            line: { width: 2 },
        }));
        Plotly.newPlot('fitChart', traces, {
            title: `${flow.luminescenceType} | ${flow.upconversionMechanism} | simulated`,
            xaxis: { title: 'Time (ms)' },
            yaxis: { title: 'Normalized Intensity' },
            margin: { l: 60, r: 20, t: 45, b: 50 },
        }, { responsive: true });
    }

    if (result.r2 != null) {
        showStatus('success', `✓ Flow completed (R²=${Number(result.r2).toFixed(5)})`);
    } else {
        showStatus('success', '✓ Flow simulation completed');
    }
    return result;
}

// ==================== 18. CONFIGURATION ====================
window.applyPhysicsSettings = function() {
    console.log('🔧 CONFIGURE button clicked - starting physics configuration...');
    
    const statusDiv = safeGetElement('statusMessage');
    if (!statusDiv) {
        console.error('❌ statusMessage element not found');
        return;
    }
    
    statusDiv.textContent = '⏳ Validating fields...';
    statusDiv.style.color = '#ffa500';
    statusDiv.style.display = 'block';
    
    // Validate required fields
    const missingFields = [];
    
    const timeUnit = safeGetElement('timeUnit')?.value;
    if (!timeUnit) missingFields.push('Time Unit');
    
    const materialModel = (safeGetElement('materialModelSelect')?.value || 'co_doped_yb_tm').toLowerCase();

    const dopingYb = safeGetElement('dopingYbInput')?.value;
    if (materialModel !== 'single_doped_tm' && !dopingYb) missingFields.push('Yb Doping');
    
    const dopingTm = safeGetElement('dopingTmInput')?.value;
    if (!dopingTm) missingFields.push('Tm Doping');
    
    const host = safeGetElement('hostSelect')?.value;
    if (!host) missingFields.push('Host Material');
    
    const annealTemp = safeGetElement('annealSelect')?.value;
    if (!annealTemp) missingFields.push('Annealing Temperature');
    
    let emission = safeGetElement('emissionSelect')?.value;
    if (getActiveUploadMode() === 'single') {
        if (!emission) missingFields.push('Emission Wavelength');
    } else {
        const loadedFolder = multiChannelFolders.find(folder =>
            Object.values(folder.slotState || {}).some(item => item && item.data)
        );
        const loadedEntry = loadedFolder
            ? Object.entries(loadedFolder.slotState || {}).find(([, item]) => item && item.data)
            : null;
        if (!loadedFolder || !loadedEntry) {
            missingFields.push('At least one multi-channel file');
        } else {
            emission = loadedEntry[1].emission;
            syncEmissionSelection(emission);
        }
    }
    
    const pulseWidth = safeGetElement('pulseWidthUs')?.value;
    if (!pulseWidth) missingFields.push('Pulse Width');
    
    if (missingFields.length > 0) {
        statusDiv.innerHTML = `<span style="color: #ff4444;">⚠️ Missing: ${missingFields.join(', ')}</span>`;
        return;
    }
    
    statusDiv.textContent = '⏳ Collecting physics parameters...';
    
    // ===== COLLECT ALL PHYSICS PARAMETERS =====
    
    // Get non-radiative parameters
    const phononEnergy = parseFloat(safeGetElement('phononEnergy_NR')?.value || '350');
    const expTau3H4 = parseFloat(safeGetElement('expTau3H4')?.value || '0');
    const tauFeedingInput = parseFloat(safeGetElement('tauFeeding3F4')?.value || '0');
    const tauRad3H4 = parseFloat(safeGetElement('tauRad3H4')?.value || '0');
    const timeOffset = parseFloat(safeGetElement('timeOffset')?.value || '0');
    const nrMode = safeGetElement('nrMode')?.value || 'theoretical';
    const couplingC = parseFloat(safeGetElement('couplingC')?.value || '1.0e7');
    const alphaParam = parseFloat(safeGetElement('alphaParam')?.value || '4.0e-3');
    let tauFeeding3F4 = tauFeedingInput;
    if ((nrMode === 'anchor' || nrMode === 'manual') && !(tauFeeding3F4 > 0) && expTau3H4 > 0) {
        tauFeeding3F4 = expTau3H4;
        const tauFeedingInputEl = safeGetElement('tauFeeding3F4');
        if (tauFeedingInputEl) tauFeedingInputEl.value = String(expTau3H4);
    }
    
    const useAnchor = ((nrMode === 'anchor' || nrMode === 'manual') && expTau3H4 > 0);
    
    // Store in global config for frontend use
    window.nonRadiativeConfig = {
        phonon_energy_cm: phononEnergy,
        exp_tau_3H4_us: expTau3H4,
        tau_feeding_3F4_us: tauFeeding3F4,
        tau_rad_3H4_us: tauRad3H4,
        time_offset_ms: timeOffset,
        nr_mode: nrMode,
        coupling_constant: couplingC,
        alpha_parameter: alphaParam,
        use_anchor: useAnchor
    };
    
    console.log('✅ Frontend physics config saved:', window.nonRadiativeConfig);
    
    // Get lattice energy from display (if available)
    const latticeEnergyText = safeGetElement('latticeFormula')?.textContent || '';
    const latticeEnergy = 3500; // Default value
    
    // Get advanced settings that are actually consumed by backend
    const fitMode = safeGetElement('fitModeSelect')?.value || 'fast';
    const configuredQuality = fitMode === 'long' ? 'accurate' : 'fast';
    
    // Build configuration payload for backend
    const configPayload = {
        time_unit: timeUnit,
        doping_yb: parseFloat(dopingYb),
        doping_tm: parseFloat(dopingTm),
        anneal_temp: parseFloat(annealTemp),
        host: host,
        lattice_energy: latticeEnergy,
        phonon_energy_cm: phononEnergy,
        fit_quality: configuredQuality,
        nr_config: window.nonRadiativeConfig
    };
    
    console.log('📤 Sending configuration to backend:', configPayload);
    statusDiv.textContent = '⏳ Sending to backend...';
    
    // ===== SEND CONFIGURATION TO BACKEND =====
    apiPost('/api/configure_physics', configPayload)
    .then(data => {
        console.log('✅ Backend configuration successful:', data);
        
        // Store the response in global for later use
        window.physicsConfig = data;
        
        // Update summary panel
        const summary = safeGetElement('parameterSummary');
        if (summary) {
            summary.style.display = 'block';
            safeSetText('fileNameDisplay', safeGetElement('analyzerCurrentFile')?.textContent || '-');
            safeSetText('timeUnitDisplay', timeUnit);
            safeSetText('ybDisplay', dopingYb);
            safeSetText('tmDisplay', dopingTm);
            safeSetText('hostDisplay', host);
            safeSetText('tempDisplay', annealTemp);
            safeSetText('emissionDisplay', emission);
            safeSetText('phononCM', phononEnergy.toString());
            safeSetText('nrModeDisplay', nrMode);
        }
        
        // Enable fit button
        const fitBtn = safeGetElement('fitDataButton');
        if (fitBtn) {
            fitBtn.disabled = false;
            fitBtn.style.opacity = '1';
            fitBtn.style.cursor = 'pointer';
            fitBtn.title = 'Ready to fit with configured physics';
            console.log('✅ FIT DATA button enabled');
        }
        
        // Show success message
        statusDiv.textContent = `✓ Configuration complete | Model: ${data.model_selected || 'multilevel_ode'} | W_CR: ${data.w_cr_active ? 'Active' : 'Inactive'}`;
        statusDiv.style.color = '#4ade80';
        
        // Show model info in console
        console.log(`📊 Model selected: ${data.model_selected}`);
        console.log(`📊 Regime: ${data.regime}`);
        console.log(`📊 W_ET upper bound: ${data.w_et_upper} ms⁻¹`);
        console.log(`📊 Cross-relaxation: ${data.w_cr_active ? 'Active' : 'Inactive'}`);
        console.log(`📊 Time scale factor: ${data.time_scale_factor}`);
        
        // Reset border colors
        ['timeUnit', 'dopingYbInput', 'dopingTmInput', 'hostSelect', 'annealSelect', 'emissionSelect', 'pulseWidthUs']
            .forEach(id => {
                const el = safeGetElement(id);
                if (el) el.style.borderColor = '#ddd';
            });
        
    })
    .catch(error => {
        console.error('❌ Error configuring backend:', error);
        statusDiv.textContent = `✗ Configuration error: ${error.message}`;
        statusDiv.style.color = '#ff4444';
        
        // Keep fit button disabled
        const fitBtn = safeGetElement('fitDataButton');
        if (fitBtn) {
            fitBtn.disabled = true;
            fitBtn.style.opacity = '0.5';
        }
    });
};
// ==================== 19. FITTING ====================

window.fitData = async function(options = {}) {
    const internalRun = Boolean(options.internalRun);
    const fitBtn = safeGetElement('fitDataButton');
    if (!internalRun && (!fitBtn || fitBtn.disabled)) {
        showStatus('error', '✗ Please configure settings first');
        return;
    }

    const flowSelection = getLuminescenceFlowSelection();
    if (!internalRun && !flowSelection.isEtuc) {
        try {
            return await runAlternativeLuminescenceFlow(options);
        } catch (err) {
            console.error('Alternative luminescence flow error:', err);
            showStatus('error', `✗ ${err.message}`);
            return;
        }
    }

    if (!internalRun && getActiveUploadMode() === 'multi') {
        persistActiveFolderConfig();
        const queuedFolders = [];
        for (const folder of multiChannelFolders) {
            try {
                const folderSeq = buildMultiChannelFitSequence(folder.slotState || {});
                if (!folderSeq.length) continue;
                const snapshotSeq = folderSeq.map(item => ({
                    ...item,
                    fileName: item.fileName,
                    data: {
                        time: Array.isArray(item.data?.time) ? [...item.data.time] : [],
                        intensity: Array.isArray(item.data?.intensity) ? [...item.data.intensity] : [],
                        metadata: item.data?.metadata ? { ...item.data.metadata } : {},
                    },
                    folderName: folder.name || 'Folder',
                    folderId: folder.id,
                    folderSampleConfig: folder.sampleConfig ? { ...folder.sampleConfig } : null,
                }));
                queuedFolders.push({
                    id: folder.id,
                    name: folder.name || 'Folder',
                    sampleConfig: folder.sampleConfig ? { ...folder.sampleConfig } : null,
                    sequence: snapshotSeq,
                });
            } catch (err) {
                showStatus('warning', `Skipping ${folder.name || 'folder'}: ${err.message}`);
            }
        }

        const sequence = queuedFolders.flatMap(folder => folder.sequence);

        if (!sequence.length) {
            showStatus('error', '✗ No multi-channel files are loaded for the required sequence.');
            return;
        }

        const loading = safeGetElement('loadingIndicator');
        if (loading) loading.style.display = 'block';
        setFitUiBusy(true);
        resetFitLiveLog();
        appendFitLiveLog(`Multi-folder queue started: ${queuedFolders.length} folder(s), ${sequence.length} channel run(s).`);
        multiFitInProgress = true;
        multiFitCancelRequested = false;
        lastCarryForwardMarker = null;
        renderMultiChannelRows();

        // Always re-seed transfer state at the beginning of a multi-channel run.
        // This ensures the first 775 step performs calibration even after prior runs.
        window.fitTransferState = { seeded775: false };

        try {
            const getTimingErrorRatios = (result) => {
                const tm = result?.timing_metrics || {};
                const measured = tm.measured || {};
                const fitted = tm.fitted || {};
                const measuredIntensity = Array.isArray(result?.measured_intensity) ? result.measured_intensity : [];
                const fittedIntensity = Array.isArray(result?.fitted_intensity) ? result.fitted_intensity : [];

                const riseAbs = (typeof measured.rise_time_10_90 === 'number' && typeof fitted.rise_time_10_90 === 'number')
                    ? Math.abs(fitted.rise_time_10_90 - measured.rise_time_10_90)
                    : null;
                const decayAbs = (typeof measured.decay_tau_1e === 'number' && typeof fitted.decay_tau_1e === 'number')
                    ? Math.abs(fitted.decay_tau_1e - measured.decay_tau_1e)
                    : null;
                const peakAbs = (typeof measured.peak_time === 'number' && typeof fitted.peak_time === 'number')
                    ? Math.abs(fitted.peak_time - measured.peak_time)
                    : null;

                const riseRatio = riseAbs != null ? riseAbs / Math.max(Math.abs(measured.rise_time_10_90 || 0), 1e-9) : null;
                const decayRatio = decayAbs != null ? decayAbs / Math.max(Math.abs(measured.decay_tau_1e || 0), 1e-9) : null;
                const peakRatio = peakAbs != null ? peakAbs / Math.max(Math.abs(measured.peak_time || 0), 1e-9) : null;
                const measuredPeak = measuredIntensity.length ? Math.max(...measuredIntensity) : null;
                const fittedPeak = fittedIntensity.length ? Math.max(...fittedIntensity) : null;
                const ampAbs = (measuredPeak != null && fittedPeak != null)
                    ? Math.abs(fittedPeak - measuredPeak)
                    : null;
                const ampRatio = ampAbs != null ? ampAbs / Math.max(Math.abs(measuredPeak || 0), 1e-9) : null;

                return { riseAbs, decayAbs, peakAbs, ampAbs, riseRatio, decayRatio, peakRatio, ampRatio };
            };

            const isTimingMismatchSevere = (result, emission) => {
                const e = getTimingErrorRatios(result);
                const profile = getMultiChannelQualityProfile(emission);
                return Boolean(
                    (e.riseRatio != null && e.riseRatio > profile.riseLimit) ||
                    (e.decayRatio != null && e.decayRatio > profile.decayLimit) ||
                    (e.peakRatio != null && e.peakRatio > profile.peakLimit) ||
                    (e.ampRatio != null && e.ampRatio > profile.ampLimit)
                );
            };

            const scoreResult = (result, emission) => {
                const r2 = (result && typeof result.r2 === 'number') ? result.r2 : -Infinity;
                if (!Number.isFinite(r2)) return -Infinity;
                const e = getTimingErrorRatios(result);
                const profile = getMultiChannelQualityProfile(emission);
                const riseP = (e.riseRatio != null && Number.isFinite(e.riseRatio)) ? e.riseRatio : 0;
                const decayP = (e.decayRatio != null && Number.isFinite(e.decayRatio)) ? e.decayRatio : 0;
                const peakP = (e.peakRatio != null && Number.isFinite(e.peakRatio)) ? e.peakRatio : 0;
                const ampP = (e.ampRatio != null && Number.isFinite(e.ampRatio)) ? e.ampRatio : 0;
                return r2 - 0.12 * (
                    profile.riseWeight * riseP +
                    profile.decayWeight * decayP +
                    profile.peakWeight * peakP +
                    profile.ampWeight * ampP
                );
            };

            const applyFixedDefaultsFromResult = (result) => {
                if (!result || typeof result !== 'object') return;
                const odeParams = result.ode_parameters || {};
                const guideParams = result.guide_parameters || {};
                Object.entries({ ...guideParams, ...odeParams }).forEach(([name, value]) => {
                    const input = safeGetElement(`lit_${name}`);
                    if (!input) return;
                    if (typeof value !== 'number' || !Number.isFinite(value)) return;
                    input.value = Number(value).toPrecision(6);
                });
            };

            let activeRunFolderId = null;

            for (let index = 0; index < sequence.length; index++) {
                if (multiFitCancelRequested) {
                    const abortErr = new Error('Multi-channel sequence cancelled by user.');
                    abortErr.name = 'AbortError';
                    throw abortErr;
                }
                const item = sequence[index];
                if (item.folderId && item.folderId !== activeRunFolderId) {
                    activeRunFolderId = item.folderId;
                    if (item.folderSampleConfig) {
                        applyFolderSampleConfig(item.folderSampleConfig);
                    }
                    appendFitLiveLog(`Starting ${item.folderName} (${sequence.filter(x => x.folderId === item.folderId).length} channel(s)).`);
                }

                const prevItem = index > 0 ? sequence[index - 1] : null;
                const isFirst775 = item.emission === '775' && (!prevItem || prevItem.folderId !== item.folderId);
                const minAcceptR2 = getMultiChannelMinR2(item.emission);
                const qualityProfile = getMultiChannelQualityProfile(item.emission);
                if (activeMultiChannelFolderId === item.folderId) {
                    previewMultiChannelSlot(item.slotId);
                }
                if (item.usedFallbackSource) {
                    appendFitLiveLog(`Fallback source engaged: using ${item.sourceEmission} nm data to fit ${item.emission} nm.`);
                }
                appendFitLiveLog(`Sequence ${index + 1}/${sequence.length}: ${item.folderName} -> fitting ${item.emission} nm from ${item.fileName}.`);
                const runResult = await window.fitData({
                    internalRun: true,
                    sourceData: item.data,
                    emission: item.emission,
                    fileName: `${item.folderName} | ${item.fileName}`,
                    force775Calibration: isFirst775,
                    manageUiBusy: false,
                    showLoading: false,
                    resetLiveLog: false,
                });

                let bestResult = runResult;
                // Track the weights that produced the best result so retries
                // explore around proven-good values, not monotonically increasing.
                let bestWeights = {
                    peak: runResult?.diagnostics?.peak_window_boost || 1.0,
                    early: runResult?.diagnostics?.early_rise_boost || 1.0,
                };
                const bestR2 = (res) => (res && typeof res.r2 === 'number' ? res.r2 : -Infinity);
                const extractCodes = (result) => {
                    const code = result?.diagnostics?.troubleshooting?.error_code || 'OK';
                    const legacy = result?.diagnostics?.troubleshooting?.legacy_error_code || code;
                    const effective = code || legacy || 'OK';
                    return { code, legacy, effective };
                };
                const hasErrorCode = (result) => {
                    const { code, legacy, effective } = extractCodes(result);
                    return ![code, legacy, effective].every(v => v === 'OK' || v === '');
                };
                const isSolved = (result) => {
                    if (!result || typeof result.r2 !== 'number') return false;
                    return result.r2 >= minAcceptR2 && !isTimingMismatchSevere(result, item.emission) && !hasErrorCode(result);
                };
                const shouldRetry = (result) => {
                    if (!result || typeof result.r2 !== 'number') return true;
                    return result.r2 < minAcceptR2 || isTimingMismatchSevere(result, item.emission) || hasErrorCode(result);
                };
                const signatureOf = (result) => {
                    const tm = result?.timing_metrics?.fitted || {};
                    const { effective } = extractCodes(result);
                    return [
                        typeof result?.r2 === 'number' ? result.r2.toFixed(6) : 'NA',
                        effective || 'OK',
                        typeof tm.peak_time === 'number' ? tm.peak_time.toFixed(6) : 'NA',
                        typeof tm.rise_time_10_90 === 'number' ? tm.rise_time_10_90.toFixed(6) : 'NA',
                        typeof tm.decay_tau_1e === 'number' ? tm.decay_tau_1e.toFixed(6) : 'NA',
                    ].join('|');
                };
                const buildRetryDirective = (result, attempt) => {
                    const troubleshooting = result?.diagnostics?.troubleshooting || {};
                    const { code, legacy, effective } = extractCodes(result);
                    const codeBag = [code, legacy, effective];
                    const dominant = String(troubleshooting.dominant_error_region || '').toLowerCase();
                    const recommendationText = (troubleshooting.recommendations || []).join(' ').toLowerCase();
                    const codeIs = (list) => codeBag.some(v => list.includes(v));
                    const wantsEarly = dominant.includes('early') || recommendationText.includes('early') || codeIs(['FIT-E11', 'FIT-E01']);
                    const wantsPeak = dominant.includes('peak') || recommendationText.includes('peak') || codeIs(['FIT-E12', 'FIT-E02']);
                    const wantsTiming = dominant.includes('timing') || dominant.includes('tail') || recommendationText.includes('timing') || codeIs(['FIT-E13', 'FIT-E03', 'FIT-E21', 'FIT-E04']);
                    const wantsDecay = dominant.includes('decay') || recommendationText.includes('decay') || codeIs(['FIT-E22', 'FIT-E05', 'FIT-E43']);
                    const wantsHost = codeIs(['FIT-E31']) || recommendationText.includes('host') || recommendationText.includes('anneal');
                    const wantsToleranceFix = codeIs(['FIT-E41', 'FIT-E42', 'FIT-E43']);

                    const targetBoost = Math.max(0.015, qualityProfile.retryTargetBoost + Math.min(0.02, attempt * 0.003));
                    const escalation = qualityProfile._escalationCount || 0;
                    const directive = {
                        label: 'strict isolated settings',
                        options: {
                            forceNoTransfer: true,
                            fitModeOverride: 'long',
                            targetR2Override: Math.min(0.99999, Math.max(0.98, minAcceptR2 + targetBoost + escalation * 0.005)),
                            adaptiveMaxCyclesOverride: Math.max(qualityProfile.retryCycles, 12 + attempt + escalation * 2),
                        },
                    };

                    if (wantsEarly || wantsTiming) {
                        directive.label = wantsTiming ? 'timing-focused correction profile' : 'early-rise correction profile';
                        // Use bestWeights as center, not a linearly-increasing formula
                        directive.options.earlyRiseBoostOverride = Math.min(10.0, Math.max(qualityProfile.earlyBoost, bestWeights.early * (1.0 + 0.05 * escalation)));
                    }
                    if (wantsPeak || wantsTiming) {
                        directive.label = wantsTiming ? 'timing-focused correction profile' : 'peak-window correction profile';
                        directive.options.peakWindowBoostOverride = Math.min(10.0, Math.max(qualityProfile.peakBoost, bestWeights.peak * (1.0 + 0.05 * escalation)));
                    }
                    if (wantsHost) {
                        directive.label = 'host-influence stabilization profile';
                        directive.options.adaptiveMaxCyclesOverride = Math.max(directive.options.adaptiveMaxCyclesOverride, 16 + attempt);
                    }
                    if (wantsDecay) {
                        directive.label = 'decay-tau correction profile';
                        directive.options.fitModeOverride = 'long';
                        directive.options.adaptiveMaxCyclesOverride = Math.max(directive.options.adaptiveMaxCyclesOverride, 14 + attempt);
                    }
                    if (wantsToleranceFix) {
                        directive.label = 'tolerance-driven correction profile';
                        directive.options.fitModeOverride = 'long';
                        directive.options.adaptiveMaxCyclesOverride = Math.max(directive.options.adaptiveMaxCyclesOverride, 14 + attempt);
                        // Anchor on bestWeights (proven best) with small exploration range
                        directive.options.earlyRiseBoostOverride = Math.min(10.0, Math.max(qualityProfile.earlyBoost, bestWeights.early * (1.0 + 0.05 * escalation)));
                        directive.options.peakWindowBoostOverride = Math.min(10.0, Math.max(qualityProfile.peakBoost, bestWeights.peak * (1.0 + 0.05 * escalation)));
                    }

                    // Apply backend-computed proposed actions.
                    // Backend proposals are now anchored on the weights that actually
                    // produced the current best result (used_weight field), rather than
                    // blindly escalating from a linear formula.
                    const proposedActions = troubleshooting.proposed_actions || [];
                    const proposedSummaryParts = [];
                    for (const action of proposedActions) {
                        if (action.action === 'boost_peak' && action.peak_window_boost) {
                            // Use the backend-proposed value only if it improves on bestWeights
                            const proposed = action.peak_window_boost;
                            directive.options.peakWindowBoostOverride = Math.max(
                                directive.options.peakWindowBoostOverride || 1.0,
                                proposed
                            );
                            const usedW = action.used_weight || bestWeights.peak;
                            proposedSummaryParts.push(`peak weight: ${usedW.toFixed(2)} → ${proposed.toFixed(2)}, +${action.extra_adaptive_cycles || 0} cycles`);
                        }
                        if (action.action === 'boost_early_rise' && action.early_rise_boost) {
                            const proposed = action.early_rise_boost;
                            directive.options.earlyRiseBoostOverride = Math.max(
                                directive.options.earlyRiseBoostOverride || 1.0,
                                proposed
                            );
                            if (action.fit_mode) directive.options.fitModeOverride = action.fit_mode;
                            const usedW = action.used_weight || bestWeights.early;
                            proposedSummaryParts.push(`early-rise weight: ${usedW.toFixed(2)} → ${proposed.toFixed(2)}, mode=${action.fit_mode || 'default'}, +${action.extra_adaptive_cycles || 0} cycles`);
                        }
                        if (action.action === 'improve_decay') {
                            if (action.fit_mode) directive.options.fitModeOverride = action.fit_mode;
                            proposedSummaryParts.push(`decay: mode=${action.fit_mode || 'long'}, +${action.extra_adaptive_cycles || 0} cycles`);
                        }
                        if (action.extra_adaptive_cycles) {
                            directive.options.adaptiveMaxCyclesOverride = Math.max(
                                directive.options.adaptiveMaxCyclesOverride,
                                directive.options.adaptiveMaxCyclesOverride + action.extra_adaptive_cycles
                            );
                        }
                    }
                    if (proposedActions.length > 0) {
                        directive.label = 'proposed-solution correction profile';
                    }
                    directive._proposedSummary = proposedSummaryParts.join(' | ');

                    // Flag errors related to doping, host, or annealing temperature
                    // so the countdown gives 60s for the user to adjust settings.
                    const recText = recommendationText;
                    directive._needsUserReview = wantsHost
                        || recText.includes('doping') || recText.includes('composition')
                        || recText.includes('anneal') || recText.includes('temperature')
                        || codeIs(['MISSING_DOPING', 'INVALID_DOPING']);

                    return directive;
                };

                if (shouldRetry(runResult)) {
                    const firstCodes = extractCodes(runResult);
                    qualityProfile._escalationCount = 0; // Reset escalation for this emission
                    appendFitLiveLog(
                        `Auto-retry triggered for ${item.emission} nm (R²=${(runResult?.r2 ?? 0).toFixed(5)}, code=${firstCodes.effective}${firstCodes.legacy && firstCodes.legacy !== firstCodes.effective ? `, legacy=${firstCodes.legacy}` : ''}).`
                    );

                    const userMaxRetries = parseInt(safeGetElement('maxRetriesInput')?.value, 10);
                    const maxRetryAttempts = Math.max(4, Math.min(25, Number.isFinite(userMaxRetries) ? userMaxRetries : qualityProfile.retryCycles));
                    const seenSignatures = new Set();
                    let previousSignature = signatureOf(runResult);
                    seenSignatures.add(previousSignature);

                    for (let attempt = 1; attempt <= maxRetryAttempts; attempt++) {
                        console.log(`Retry ${attempt}/${maxRetryAttempts} started.`);
                        if (multiFitCancelRequested) {
                            const abortErr = new Error('Multi-channel sequence cancelled by user.');
                            abortErr.name = 'AbortError';
                            throw abortErr;
                        }

                        const retry = buildRetryDirective(bestResult, attempt);
                        console.log(`Retry directive:`, retry);

                        // Default undefined overrides to quality profile values before perturbation
                        if (retry.options.peakWindowBoostOverride == null || !Number.isFinite(retry.options.peakWindowBoostOverride)) {
                            retry.options.peakWindowBoostOverride = qualityProfile.peakBoost || 1.27;
                        }
                        if (retry.options.earlyRiseBoostOverride == null || !Number.isFinite(retry.options.earlyRiseBoostOverride)) {
                            retry.options.earlyRiseBoostOverride = qualityProfile.earlyBoost || 1.3;
                        }

                        // Perturbation strategy: explore AROUND the best-producing weights,
                        // not monotonically increasing. Use bestWeights as center.
                        const hasProposedActions = !!(retry._proposedSummary);
                        const escCount = qualityProfile._escalationCount || 0;
                        if (!hasProposedActions) {
                            // When no backend proposals, perturb around bestWeights
                            const perturbRange = 0.1 + 0.05 * escCount;
                            retry.options.peakWindowBoostOverride = Math.min(10.0, Math.max(1.0,
                                bestWeights.peak + (Math.random() * 2 - 1) * perturbRange * bestWeights.peak));
                            retry.options.earlyRiseBoostOverride = Math.min(10.0, Math.max(1.0,
                                bestWeights.early + (Math.random() * 2 - 1) * perturbRange * bestWeights.early));
                        } else {
                            // With backend proposals: use the proposed values but apply
                            // a small exploration jitter (±5%) so we don't repeat identical attempts
                            if (attempt > 1) {
                                const jitter = 0.03 * escCount + 0.02;
                                retry.options.peakWindowBoostOverride = Math.min(10.0, Math.max(1.0,
                                    retry.options.peakWindowBoostOverride * (1 + (Math.random() * 2 - 1) * jitter)));
                                retry.options.earlyRiseBoostOverride = Math.min(10.0, Math.max(1.0,
                                    retry.options.earlyRiseBoostOverride * (1 + (Math.random() * 2 - 1) * jitter)));
                            }
                        }
                        retry.options.adaptiveMaxCyclesOverride = Math.min(50, retry.options.adaptiveMaxCyclesOverride + attempt);

                        const fmtOverride = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(3) : 'default';

                        // ── Countdown with proposed values & skip button ──
                        // Extend to 60s for doping/host/annealing errors so user can adjust settings
                        const needsReview = retry._needsUserReview === true;
                        const countdownSeconds = needsReview ? 60 : 10;
                        let skipRetry = false;

                        // Log: first show the backend-proposed solution (matches troubleshooting panel)
                        appendFitLiveLog(`─── Retry ${attempt}/${maxRetryAttempts} for ${item.emission} nm using ${retry.label} ───`);
                        if (retry._proposedSummary) {
                            appendFitLiveLog(`Backend recommendation: ${retry._proposedSummary}`);
                        }
                        // Log: then show the ACTUAL values that will be sent (after all overrides)
                        const actualSummary = `peak weight = ${fmtOverride(retry.options.peakWindowBoostOverride)}, ` +
                            `early-rise weight = ${fmtOverride(retry.options.earlyRiseBoostOverride)}, ` +
                            `adaptive cycles = ${retry.options.adaptiveMaxCyclesOverride ?? 'default'}, ` +
                            `mode = ${retry.options.fitModeOverride || 'default'}`;
                        appendFitLiveLog(`Actual values for this retry: ${actualSummary}`);

                        // Log a warning for user-review errors so the user knows to check settings
                        if (needsReview) {
                            appendFitLiveLog(`⚠️ Error may relate to doping, host, or annealing temperature. 60s pause for you to review settings.`);
                        }

                        // Create countdown UI in live log
                        const logEl = safeGetElement('fitLiveLog');
                        const countdownRow = document.createElement('div');
                        countdownRow.style.cssText = needsReview
                            ? 'padding:8px 10px; margin:4px 0; background:#fee2e2; border:2px solid #dc2626; border-radius:6px; display:flex; align-items:center; gap:10px; font-size:12px; color:#991b1b;'
                            : 'padding:6px 8px; margin:4px 0; background:#fef3c7; border:1px solid #f59e0b; border-radius:6px; display:flex; align-items:center; gap:10px; font-size:12px; color:#92400e;';
                        const countdownText = document.createElement('span');
                        countdownText.style.fontWeight = '600';
                        countdownText.textContent = `Starting in ${countdownSeconds}s...`;
                        const skipBtn = document.createElement('button');
                        skipBtn.textContent = 'Stop & Skip to Next Emission';
                        skipBtn.style.cssText = 'padding:4px 10px; background:#ef4444; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px; font-weight:700;';
                        countdownRow.appendChild(countdownText);
                        countdownRow.appendChild(skipBtn);
                        if (logEl) {
                            logEl.appendChild(countdownRow);
                            logEl.scrollTop = logEl.scrollHeight;
                        }

                        // Countdown promise: resolves to 'skip' or 'proceed'
                        const countdownResult = await new Promise((resolve) => {
                            let remaining = countdownSeconds;
                            skipBtn.addEventListener('click', () => resolve('skip'), { once: true });
                            const timer = setInterval(() => {
                                remaining--;
                                if (remaining <= 0) {
                                    clearInterval(timer);
                                    resolve('proceed');
                                } else {
                                    countdownText.textContent = `Starting in ${remaining}s...`;
                                }
                                if (multiFitCancelRequested) {
                                    clearInterval(timer);
                                    resolve('skip');
                                }
                            }, 1000);
                        });

                        // Clean up countdown UI
                        if (countdownRow.parentNode) countdownRow.parentNode.removeChild(countdownRow);

                        if (countdownResult === 'skip') {
                            appendFitLiveLog(`⏭ User skipped retry for ${item.emission} nm. Moving to next emission.`);
                            skipRetry = true;
                            break;
                        }

                        appendFitLiveLog(`Proceeding with retry ${attempt}/${maxRetryAttempts}...`);
                        
                        const retryResult = await window.fitData({
                            internalRun: true,
                            sourceData: item.data,
                            emission: item.emission,
                            fileName: item.fileName,
                            force775Calibration: isFirst775,
                            manageUiBusy: false,
                            showLoading: false,
                            resetLiveLog: false,
                            ...retry.options,
                        });

                        if (!retryResult || !Number.isFinite(retryResult.r2)) {
                            appendFitLiveLog(`Invalid result encountered; skipping retry.`);
                            continue;
                        }

                        const improvementThreshold = 1e-6;
                        if (Math.abs(retryResult.r2 - bestResult.r2) < improvementThreshold) {
                            // Instead of stopping: escalate strategy for next attempt
                            appendFitLiveLog(`${item.emission} nm produced negligible improvement; escalating strategy.`);
                            // Force more aggressive settings for next iteration
                            qualityProfile._escalationCount = (qualityProfile._escalationCount || 0) + 1;
                            continue;
                        }
                        if (scoreResult(retryResult, item.emission) >= scoreResult(bestResult, item.emission)) {
                            bestResult = retryResult;
                            // Update bestWeights to reflect the weights that produced this improvement
                            bestWeights = {
                                peak: retryResult?.diagnostics?.peak_window_boost || bestWeights.peak,
                                early: retryResult?.diagnostics?.early_rise_boost || bestWeights.early,
                            };
                            qualityProfile._escalationCount = 0; // Reset escalation on improvement
                        }

                        if (isSolved(bestResult)) {
                            appendFitLiveLog(`${item.emission} nm reached solved criteria; continuing to next emission.`);
                            break;
                        }

                        const sig = signatureOf(retryResult);
                        console.log(`Current signature: ${sig}, Previous signature: ${previousSignature}`);
                        if (seenSignatures.has(sig)) {
                            // Same exact signature seen before - but don't stop, escalate
                            const escalations = (qualityProfile._escalationCount || 0);
                            if (escalations >= 3) {
                                appendFitLiveLog(`${item.emission} nm produced the same fitting result ${escalations} times; stopping retries.`);
                                break;
                            }
                            appendFitLiveLog(`${item.emission} nm same result detected; changing strategy (escalation ${escalations + 1}/3).`);
                            qualityProfile._escalationCount = escalations + 1;
                            continue;
                        }
                        seenSignatures.add(sig);
                        previousSignature = sig;
                    
                    }
                    if (!isSolved(bestResult)) {
                        appendFitLiveLog(
                            `${item.emission} nm remains below solved criteria after ${maxRetryAttempts} retries ` +
                            `(best R²=${bestR2(bestResult).toFixed(5)}, target=${minAcceptR2.toFixed(2)}). Continuing sequence with best available fit.`
                        );
                    }
                }

                const finalResult = bestResult;

                // Mark the deposit entry corresponding to the best result.
                // Find all deposits for this emission from this retry batch and
                // set isBestFit on the one matching bestResult's R².
                if (finalResult && typeof finalResult.r2 === 'number') {
                    const bestR2Val = finalResult.r2;
                    const emStr = String(item.emission);
                    let bestIdx = -1;
                    let bestScore = -Infinity;
                    const isTimingPassForDeposit = (dep) => {
                        const tolA = dep?.diagnostics?.tolerance_achieved || {};
                        const tolT = dep?.diagnostics?.tolerance_targets || {};
                        const checks = [
                            [tolA.peak, tolT.peak],
                            [tolA.rise, tolT.rise],
                            [tolA.decay, tolT.decay],
                        ].filter(([a, t]) => Number.isFinite(a) && Number.isFinite(t));
                        return checks.length > 0 && checks.every(([a, t]) => a <= t);
                    };
                    for (let di = plotDeposits.length - 1; di >= 0; di--) {
                        const dep = plotDeposits[di];
                        if (String(dep.payloadSummary?.emission) !== emStr) break;
                        // Clear any previous best-fit marks for this emission batch
                        dep.isBestFit = false;
                        const depR2 = typeof dep.r2 === 'number' ? dep.r2 : -Infinity;
                        const timingPass = isTimingPassForDeposit(dep);
                        const depScore = (timingPass ? 1000.0 : 0.0) + depR2;
                        if (depScore >= bestScore) {
                            bestScore = depScore;
                            bestIdx = di;
                        }
                    }
                    if (bestIdx >= 0) {
                        plotDeposits[bestIdx].isBestFit = true;
                        // Inject the BEST FIT badge into stored resultsHtml
                        const badgeHtml = '<div style="margin:8px 0; padding:8px 12px; background:#dcfce7; border:2px solid #16a34a; border-radius:6px; text-align:center; font-size:14px; font-weight:800; color:#166534;">★ BEST FIT ★</div>';
                        if (plotDeposits[bestIdx].resultsHtml && !plotDeposits[bestIdx].resultsHtml.includes('BEST FIT')) {
                            plotDeposits[bestIdx].resultsHtml = plotDeposits[bestIdx].resultsHtml.replace(
                                /(<div style="margin:18px[^>]*>Run:[^<]*<\/div>)/,
                                '$1' + badgeHtml
                            );
                        }
                        savePlotDeposits();
                        activeDepositIndex = bestIdx;
                        renderDepositList();
                        window.openDepositedPlot(bestIdx);
                        const bestTimingPass = isTimingPassForDeposit(plotDeposits[bestIdx]);
                        appendFitLiveLog(`Best fit for ${item.emission} nm selected: deposit #${bestIdx + 1} (R²=${bestR2Val.toFixed(6)}, timing-pass=${bestTimingPass ? 'yes' : 'no'}).`);
                    }
                }

                // Carry-forward defaults must come only from the selected best fit,
                // never from intermediate lower-quality retry attempts.
                applyFixedDefaultsFromResult(finalResult);
                lastCarryForwardMarker = {
                    folderId: item.folderId || null,
                    slotId: item.slotId || null,
                    emission: item.emission || '',
                    sourceEmission: item.sourceEmission || item.emission || '',
                };
                if (activeMultiChannelFolderId === item.folderId) {
                    renderMultiChannelRows();
                }

                // Store per-emission result so Lifetime Generator "Auto-fill" can read it
                if (finalResult) {
                    window.multiChannelResults = window.multiChannelResults || {};
                    window.multiChannelResults[String(item.emission)] = finalResult;
                    window.lastFitResult = finalResult;  // keep lastFitResult up-to-date with each emission
                }

                if (isTimingMismatchSevere(finalResult, item.emission)) {
                    const e = getTimingErrorRatios(finalResult);
                    appendFitLiveLog(
                        `Warning: ${item.emission} nm still shows timing mismatch after auto-retries ` +
                        `(rise ratio=${e.riseRatio != null ? e.riseRatio.toFixed(3) : 'N/A'}, ` +
                        `decay ratio=${e.decayRatio != null ? e.decayRatio.toFixed(3) : 'N/A'}, ` +
                        `peak ratio=${e.peakRatio != null ? e.peakRatio.toFixed(3) : 'N/A'}, ` +
                        `amp ratio=${e.ampRatio != null ? e.ampRatio.toFixed(3) : 'N/A'}).`
                    );
                }

                if (multiFitCancelRequested) {
                    const abortErr = new Error('Multi-channel sequence cancelled by user.');
                    abortErr.name = 'AbortError';
                    throw abortErr;
                }

                if (isFirst775 && finalResult && typeof finalResult.r2 === 'number' && finalResult.r2 < 0.8) {
                    throw new Error(
                        `775 nm calibration failed in multi-channel mode (R²=${finalResult.r2.toFixed(4)}). ` +
                        'Sequence stopped to avoid propagating poor transfer to later channels.'
                    );
                }
            }
            showStatus('success', `✓ Multi-folder queue completed: ${queuedFolders.length} folder(s), ${sequence.length} channel run(s).`);
            appendFitLiveLog(`Queue finished successfully for ${queuedFolders.length} folder(s).`);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                showStatus('warning', 'Multi-channel fitting cancelled.');
            } else {
                console.error('Multi-channel fitting error:', err);
                showStatus('error', `✗ Multi-channel fitting stopped: ${err.message}`);
            }
        } finally {
            multiFitInProgress = false;
            multiFitCancelRequested = false;
            if (loading) loading.style.display = 'none';
            currentFitRequestId = null;
            currentFitAbortController = null;
            setFitUiBusy(false);
        }
        return;
    }

    const sourceData = options.sourceData || rawData;
    if (!sourceData) {
        showStatus('error', '✗ Please load data first');
        return;
    }

    const manageUiBusy = options.manageUiBusy !== false;
    const showLoading = options.showLoading !== false;
    const resetLog = options.resetLiveLog !== false;
    const loading = safeGetElement('loadingIndicator');
    const selectedEmission = options.emission || safeGetElement('emissionSelect')?.value || '477';
    const displayFileName = options.fileName || safeGetElement('analyzerCurrentFile')?.textContent || 'Unknown file';

    if (showLoading && loading) loading.style.display = 'block';

    if (manageUiBusy) {
        setFitUiBusy(true);
    }

    currentFitAbortController = new AbortController();
    currentFitRequestId = createFitRequestId();

    try {
        const time = [...sourceData.time];
        let intensity = [...sourceData.intensity];

        if (safeGetElement('baselineCorrection')?.checked) {
            const t0 = time[0], tN = time[time.length - 1];
            const I0 = intensity[0], IN = intensity[intensity.length - 1];
            if (tN !== t0) {
                const slope = (IN - I0) / (tN - t0);
                intensity = intensity.map((I, i) => Math.max(I - (I0 + slope * (time[i] - t0)), 0));
            }
        }

        if (safeGetElement('smoothing')?.checked) {
            const windowSize = parseInt(safeGetElement('smoothingWindow')?.value || '5', 10);
            const half = Math.floor(windowSize / 2);
            const smoothed = [...intensity];
            for (let i = half; i < intensity.length - half; i++) {
                let sum = 0;
                for (let j = -half; j <= half; j++) sum += intensity[i + j];
                smoothed[i] = sum / windowSize;
            }
            intensity = smoothed;
        }

        if (safeGetElement('normalization')?.checked) {
            const maxVal = Math.max(...intensity);
            if (maxVal > 0) intensity = intensity.map(v => v / maxVal);
        }

        processedData = { time, intensity };

        const estimateEarlyTimeMetrics = (tArr, yArr) => {
            if (!Array.isArray(tArr) || !Array.isArray(yArr) || tArr.length < 8 || yArr.length !== tArr.length) {
                return { valid: false };
            }
            const yPeak = Math.max(...yArr);
            if (!Number.isFinite(yPeak) || yPeak <= 0) {
                return { valid: false };
            }
            const yThreshold = 0.03 * yPeak;
            let onsetIdx = yArr.findIndex(v => Number.isFinite(v) && v >= yThreshold);
            if (onsetIdx < 0) onsetIdx = 0;
            const tOnset = tArr[Math.max(0, onsetIdx)];
            const tPeak = tArr[Math.max(0, yArr.indexOf(yPeak))];
            const riseWindow = (Number.isFinite(tPeak) && Number.isFinite(tOnset)) ? Math.max(0, tPeak - tOnset) : null;
            return {
                valid: Number.isFinite(tOnset) && Number.isFinite(tPeak),
                tOnset,
                tPeak,
                riseWindow,
                yPeak,
            };
        };

        const earlyMetrics = estimateEarlyTimeMetrics(time, intensity);

        const fitMode = options.fitModeOverride || safeGetElement('fitModeSelect')?.value || 'fast';
        const isLongMode = fitMode === 'long';
        const isSingleMode = getActiveUploadMode() === 'single' && !internalRun;
        const emissionProfile = getMultiChannelQualityProfile(selectedEmission);

        // Read user-set weights for the current emission from the weight inputs.
        // These always take priority over toggle-based defaults.
        const userPeakWeight = parseFloat(safeGetElement('peakWeightInput')?.value);
        const userEarlyWeight = parseFloat(safeGetElement('earlyWeightInput')?.value);
        const hasPeakWeight = Number.isFinite(userPeakWeight) && userPeakWeight > 1.0;
        const hasEarlyWeight = Number.isFinite(userEarlyWeight) && userEarlyWeight > 1.0;

        const peakEnhanceEnabled = options.peakWindowBoostOverride != null
            ? true
            : (hasPeakWeight || (isSingleMode && safeGetElement('singlePeakEnhanceToggle')?.checked === true));
        const peakWindowBoost = options.peakWindowBoostOverride != null
            ? Math.min(10.0, Math.max(1.0, Number(options.peakWindowBoostOverride)))
            : (hasPeakWeight ? Math.min(10.0, userPeakWeight)
               : (peakEnhanceEnabled ? Math.max(1.28, emissionProfile.peakBoost) : 1.0));
        const earlyEnhanceEnabled = options.earlyRiseBoostOverride != null
            ? true
            : (hasEarlyWeight || (isSingleMode && safeGetElement('singleEarlyEnhanceToggle')?.checked === true));
        let earlyRiseBoost = options.earlyRiseBoostOverride != null
            ? Math.min(10.0, Math.max(1.0, Number(options.earlyRiseBoostOverride)))
            : (hasEarlyWeight ? Math.min(10.0, userEarlyWeight)
               : (earlyEnhanceEnabled ? Math.max(1.26, Number(emissionProfile.earlyBoost) || 1.26) : 1.0));
        if (isNaN(earlyRiseBoost) || earlyRiseBoost == null) {
            console.warn("Invalid earlyRiseBoost value detected. Defaulting to 1.0.");
            earlyRiseBoost = 1.0;
        }
        const targetR2InputVal = safeGetElement('targetR2Input')?.value;
        const adaptiveCyclesInputVal = safeGetElement('adaptiveMaxCyclesInput')?.value;
        const targetR2Raw = options.targetR2Override != null ? options.targetR2Override : (targetR2InputVal || '0.9990');
        const adaptiveCyclesRaw = options.adaptiveMaxCyclesOverride != null ? options.adaptiveMaxCyclesOverride : (adaptiveCyclesInputVal || '8');
        const targetR2 = Math.min(
            0.999995,
            Math.max(0.90, parseFloat(targetR2Raw))
        );
        const adaptiveMaxCycles = Math.min(
            50,
            Math.max(1, parseInt(adaptiveCyclesRaw, 10))
        );
        const fitConfig = {
            fit_quality: isLongMode ? 'accurate' : 'fast',
            try_best_match: isLongMode,
            optimize_all_points: isLongMode,
            target_r2: targetR2,
            adaptive_max_cycles: adaptiveMaxCycles,
        };
        window.fitTransferState = window.fitTransferState || { seeded775: false };
        const autoTransfer = safeGetElement('autoTransfer775')?.checked !== false;
        const transferEnabled = options.forceNoTransfer === true ? false : autoTransfer;
        const use775Calibration = options.force775Calibration === true
            ? true
            : (transferEnabled && selectedEmission === '775' && !window.fitTransferState.seeded775);

        const configuredTimeOffsetMs = Number(window.nonRadiativeConfig?.time_offset_ms);
        const inferredTimeOffsetMs = earlyMetrics.valid ? Math.max(0.0, Number(earlyMetrics.tOnset)) : 0.0;
        const selectedTimeOffsetMs = Number.isFinite(configuredTimeOffsetMs)
            ? Math.max(0.0, configuredTimeOffsetMs)
            : inferredTimeOffsetMs;

        const pulseWidthUsVal = parseFloat(safeGetElement('pulseWidthUs')?.value || '400');
        const pulseWidthMsVal = Number.isFinite(pulseWidthUsVal) ? pulseWidthUsVal / 1000.0 : 0.4;
        if (earlyMetrics.valid) {
            appendFitLiveLog(
                `Early-time check: onset≈${earlyMetrics.tOnset.toFixed(4)} ms, peak≈${earlyMetrics.tPeak.toFixed(4)} ms, rise window≈${(earlyMetrics.riseWindow ?? 0).toFixed(4)} ms, pulse≈${pulseWidthMsVal.toFixed(4)} ms.`
            );
            if ((earlyMetrics.riseWindow != null) && (pulseWidthMsVal > 0) && (pulseWidthMsVal > 2.5 * Math.max(earlyMetrics.riseWindow, 1e-6))) {
                appendFitLiveLog('Warning: pulse width is much larger than measured rise window. Verify pulse-width calibration from raw data.');
            }
            if (Number.isFinite(configuredTimeOffsetMs) && Math.abs(configuredTimeOffsetMs - inferredTimeOffsetMs) > 0.05) {
                appendFitLiveLog(
                    `Warning: configured time offset (${configuredTimeOffsetMs.toFixed(4)} ms) differs from inferred onset (${inferredTimeOffsetMs.toFixed(4)} ms). Verify time-zero alignment.`
                );
            }
        }

        const payload = {
            fit_request_id: currentFitRequestId,
            time,
            intensity,
            ...fitConfig,
            luminescence_type: flowSelection.luminescenceType,
            upconversion_mechanism: flowSelection.upconversionMechanism,
            material_model: flowSelection.materialModel,
            mechanism_params: collectMechanismParams(),
            single_tm_params: collectSingleTmParams(),
            doping_yb: parseFloat(safeGetElement('dopingYbInput')?.value || '10'),
            doping_tm: parseFloat(safeGetElement('dopingTmInput')?.value || '0.5'),
            host: safeGetElement('hostSelect')?.value || 'NaYF4',
            anneal_temp: parseFloat(safeGetElement('annealSelect')?.value || '500'),
            emission: selectedEmission,
            use_775_calibration: use775Calibration,
            peak_window_boost: peakWindowBoost,
            early_rise_boost: earlyRiseBoost,
            // Use per-emission tolerances: for the emission being fitted,
            // look up stored values; fall back to DOM inputs for single-channel.
            peak_tolerance: (emissionDefaults[selectedEmission]?.tolerances?.peak)
                ?? (parseFloat(document.getElementById('errPeak')?.value) || 0.01),
            rise_tolerance: (emissionDefaults[selectedEmission]?.tolerances?.rise)
                ?? (parseFloat(document.getElementById('errRise')?.value) || 0.10),
            decay_tolerance: (emissionDefaults[selectedEmission]?.tolerances?.decay)
                ?? (parseFloat(document.getElementById('errDecay')?.value) || 0.10),
            time_unit: safeGetElement('timeUnit')?.value || 'ms',
            pulse_width_us: parseFloat(safeGetElement('pulseWidthUs')?.value || '400'),
            time_offset_ms: selectedTimeOffsetMs,
            lit_params: {
                Ay: parseFloat(safeGetElement('lit_Ay')?.value || '1.0'),
                W1: parseFloat(safeGetElement('lit_W1')?.value || '5.0'),
                W2: parseFloat(safeGetElement('lit_W2')?.value || '5.0'),
                W3: parseFloat(safeGetElement('lit_W3')?.value || '2.0'),
                W4: parseFloat(safeGetElement('lit_W4')?.value || '1.0'),
                W5: parseFloat(safeGetElement('lit_W5')?.value || '0.5'),
                k21: parseFloat(safeGetElement('lit_k21')?.value || '50.0'),
                k35: parseFloat(safeGetElement('lit_k35')?.value || '20.0'),
                A10: parseFloat(safeGetElement('lit_A10')?.value || '1.0'),
                A50: parseFloat(safeGetElement('lit_A50')?.value || '0.33'),
                A60: parseFloat(safeGetElement('lit_A60')?.value || '2.0'),
                A61: parseFloat(safeGetElement('lit_A61')?.value || '0.5'),
                A70: parseFloat(safeGetElement('lit_A70')?.value || '1.5'),
                A71: parseFloat(safeGetElement('lit_A71')?.value || '0.5'),
                A80: parseFloat(safeGetElement('lit_A80')?.value || '2.0'),
                A81: parseFloat(safeGetElement('lit_A81')?.value || '2.0'),
                Wcr: parseFloat(safeGetElement('lit_Wcr')?.value || '5.0'),
                Wb: parseFloat(safeGetElement('lit_Wb')?.value || '0.5'),
            },
            excitation_wavelength: parseFloat(safeGetElement('excitationWavelength')?.value || '980'),
            smoothing_window: parseInt(safeGetElement('smoothingWindow')?.value || '5', 10),
            model: 'multilevel_ode',
            ...(window.nonRadiativeConfig && {
                nr_mode: window.nonRadiativeConfig.nr_mode,
                phonon_energy_cm: window.nonRadiativeConfig.phonon_energy_cm,
                exp_tau_3H4_us: window.nonRadiativeConfig.exp_tau_3H4_us,
                tau_feeding_3F4_us: window.nonRadiativeConfig.tau_feeding_3F4_us,
                tau_rad_3H4_us: window.nonRadiativeConfig.tau_rad_3H4_us,
                coupling_constant: window.nonRadiativeConfig.coupling_constant,
                alpha_parameter: window.nonRadiativeConfig.alpha_parameter,
                use_anchor: window.nonRadiativeConfig.use_anchor,
            })
        };

        showStatus('info', `⏳ Fitting in progress (${currentFitRequestId})`);
        if (resetLog) {
            resetFitLiveLog();
        }
        appendFitLiveLog(`Fit started: target R²=${targetR2.toFixed(6)}, max adaptive loops=${adaptiveMaxCycles}.`);
        startFitProgressPolling(currentFitRequestId);

        const response = await fetch('/fit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: currentFitAbortController.signal,
        });

        if (!response.ok) {
            let errorData = {};
            try {
                errorData = await response.json();
            } catch (_parseErr) {
                errorData = {};
            }
            const backendError = errorData.error || `Server error: ${response.status}`;
            const backendCode = errorData.error_code || '';
            const err = new Error(backendError);
            err.backendStatus = response.status;
            err.backendCode = backendCode;
            err.backendPayload = errorData;
            throw err;
        }

        fittingResults = await response.json();
        if (fittingResults.cancelled) {
            showStatus('warning', 'Fit was cancelled before completion.');
            appendFitLiveLog('Backend reported fit cancellation.');
            setFitResultsHtml('<p style="color: #92400e; text-align: center;">Fit cancelled by user.</p>');
            return;
        }
        if (fittingResults.error) {
            throw new Error(fittingResults.error);
        }

        const exportTime = processedData ? processedData.time : [];
        lastFitDataForExport = {
            time: exportTime,
            measured: fittingResults.measured_intensity,
            fitted: fittingResults.fitted_intensity
        };

        const mainTitle = buildRunTitle(
            displayFileName,
            payload,
            fittingResults
        );
        const trace1 = { x: time, y: intensity, mode: 'lines', name: 'Experimental', line: { color: '#667eea' } };
        const trace2 = { x: time, y: fittingResults.fitted_intensity, mode: 'lines', name: 'Fit', line: { color: '#764ba2' } };
        Plotly.newPlot('fitChart', [trace1, trace2], {
            title: mainTitle,
            xaxis: { title: 'Time' },
            yaxis: { title: 'Intensity' }
        });

        let qualityClass = 'quality-poor';
        let qualityText = 'Poor';
        if (fittingResults.r2 > 0.99) { qualityClass = 'quality-excellent'; qualityText = 'Excellent'; }
        else if (fittingResults.r2 > 0.95) { qualityClass = 'quality-good'; qualityText = 'Good'; }
        else if (fittingResults.r2 > 0.90) { qualityClass = 'quality-acceptable'; qualityText = 'Acceptable'; }

        const fmtNum = (v, d = 6) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'N/A');
        const fmtSci = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? Number(v).toExponential(d) : 'N/A');
        const tm = fittingResults.timing_metrics || {};
        const tmMeasured = tm.measured || {};
        const tmFitted = tm.fitted || {};
        const diagnostics = fittingResults.diagnostics || {};
        const optDiag = diagnostics.optimization || {};
        const odeParams = fittingResults.ode_parameters || {};
        const odeUnits = fittingResults.ode_parameter_units || {};
        const guideParams = fittingResults.guide_parameters || {};
        const paramRoles = fittingResults.parameter_roles || {};
        const timeUnit = tm.time_unit || (safeGetElement('timeUnit')?.value || 'ms');

        if (selectedEmission === '775' && diagnostics.use_775_calibration) {
            window.fitTransferState.seeded775 = true;
        }

        Object.entries({ ...guideParams, ...odeParams }).forEach(([name, value]) => {
            const input = safeGetElement(`lit_${name}`);
            if (!input) return;
            if (typeof value !== 'number' || !Number.isFinite(value)) return;
            input.value = Number(value).toPrecision(6);
        });

        const peakTimeErr = (
            typeof tmMeasured.peak_time === 'number' && typeof tmFitted.peak_time === 'number'
        ) ? Math.abs(tmFitted.peak_time - tmMeasured.peak_time) : null;
        const riseErr = (
            typeof tmMeasured.rise_time_10_90 === 'number' && typeof tmFitted.rise_time_10_90 === 'number'
        ) ? Math.abs(tmFitted.rise_time_10_90 - tmMeasured.rise_time_10_90) : null;
        const decayErr = (
            typeof tmMeasured.decay_tau_1e === 'number' && typeof tmFitted.decay_tau_1e === 'number'
        ) ? Math.abs(tmFitted.decay_tau_1e - tmMeasured.decay_tau_1e) : null;

        // Ratio errors: these match what the backend tolerance system actually checks
        const tolAchieved = diagnostics.tolerance_achieved || {};
        const tolTargets = diagnostics.tolerance_targets || {};
        const peakRatioErr = tolAchieved.peak;
        const riseRatioErr = tolAchieved.rise;
        const decayRatioErr = tolAchieved.decay;
        const peakTolTarget = tolTargets.peak;
        const riseTolTarget = tolTargets.rise;
        const decayTolTarget = tolTargets.decay;
        const timingAcceptance = summarizeTimingAcceptance(diagnostics, fittingResults.r2);
        const timingPass = timingAcceptance.timing_pass;
        const physicallyAccepted = timingAcceptance.physically_accepted;
        const failedTimingTerms = timingAcceptance.failed_terms || [];
        const failedTimingTermsText = failedTimingTerms.length ? failedTimingTerms.join(', ') : 'None';
        const failedTimingBadgesHtml = failedTimingTerms.length
            ? failedTimingTerms
                .map(term => `<span style="display:inline-block; margin:0 6px 4px 0; padding:2px 8px; border-radius:999px; background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; font-size:11px; font-weight:700;">${term}</span>`)
                .join('')
            : '<span style="color:#166534; font-weight:700;">None</span>';
        const streakContextKey = [
            safeGetElement('hostSelect')?.value || 'host',
            safeGetElement('dopingYbInput')?.value || 'yb',
            safeGetElement('dopingTmInput')?.value || 'tm',
            selectedEmission || 'emission',
        ].join('|');
        const timingPassStreak = updateTimingPassStreak(streakContextKey, physicallyAccepted);
        const tightenSuggestion = timingPassStreak >= 3
            ? getToleranceTighteningSuggestion(timingAcceptance.tolerance_targets)
            : null;
        const tightenSuggestionHtml = tightenSuggestion
            ? `<div style="margin-top:8px; padding:8px 10px; border-radius:6px; border:1px solid #fde68a; background:#fffbeb; color:#92400e; font-size:11px; line-height:1.45;"><strong>Auto-suggestion:</strong> ${timingPassStreak} consecutive timing passes for this sample/emission. Try tighter tolerances next run: peak ≤ ${fmtNum(tightenSuggestion.peak, 3)}, rise ≤ ${fmtNum(tightenSuggestion.rise, 3)}, decay ≤ ${fmtNum(tightenSuggestion.decay, 3)}.</div>`
            : '';
        const timingStatusLabel = physicallyAccepted ? 'PASS' : 'FAIL';
        const timingStatusColor = physicallyAccepted ? '#16a34a' : '#dc2626';
        const timingStatusReason = physicallyAccepted
            ? 'Timing tolerances met.'
            : 'Timing tolerances not met (R² alone is insufficient).';
        if (!physicallyAccepted) {
            qualityClass = 'quality-poor';
            qualityText = 'Timing-Fail';
        }
        const tolStatus = (achieved, target) => {
            if (achieved == null || target == null) return '';
            return achieved <= target
                ? ' <span style="color:#16a34a;font-weight:700;">✓</span>'
                : ` <span style="color:#dc2626;font-weight:700;">✗ (target: ${fmtNum(target, 4)})</span>`;
        };

        // Highlight transferred parameters
        const transferredOde = window.transferredParams?.ode || {};
        const transferredEmission = window.transferredParams?.emission || '';
        const highlightTransferred = selectedEmission !== transferredEmission;
        const paramsRows = Object.entries(odeParams)
            .map(([k, v]) => {
                const unit = odeUnits[k] ? ` ${odeUnits[k]}` : '';
                const originalVal = highlightTransferred && transferredOde[k] !== undefined ? transferredOde[k] : undefined;
                const isTransferred = highlightTransferred && transferredOde[k] !== undefined;
                let valueHtml = `${fmtSci(v, 4)}${unit}`;
                if (isTransferred) {
                    valueHtml += ` <b>(transferred)</b>`;
                    if (originalVal !== v) {
                        valueHtml += `<br><span style="color:#6366f1;font-size:11px;">Original: ${fmtSci(originalVal, 4)}${unit}</span>`;
                    }
                }
                return `<div class="result-item"><span class="result-label">${k}</span><span class="result-value"${isTransferred ? ' style="background:#bbf7d0;color:#166534;border-radius:3px;padding:2px 6px;"' : ''}>${valueHtml}</span></div>`;
            })
            .join('');

        const transferredGuide = window.transferredParams?.guide || {};
        const guideRows = Object.entries(guideParams)
            .map(([k, v]) => {
                const unit = odeUnits[k] ? ` ${odeUnits[k]}` : ' ms-1';
                const originalVal = highlightTransferred && transferredGuide[k] !== undefined ? transferredGuide[k] : undefined;
                const isTransferred = highlightTransferred && transferredGuide[k] !== undefined;
                let valueHtml = `${fmtSci(v, 4)}${unit}`;
                if (isTransferred) {
                    valueHtml += ` <b>(transferred)</b>`;
                    if (originalVal !== v) {
                        valueHtml += `<br><span style="color:#6366f1;font-size:11px;">Original: ${fmtSci(originalVal, 4)}${unit}</span>`;
                    }
                }
                return `<div class="result-item"><span class="result-label">${k}</span><span class="result-value"${isTransferred ? ' style="background:#bbf7d0;color:#166534;border-radius:3px;padding:2px 6px;"' : ''}>${valueHtml}</span></div>`;
            })
            .join('');

        const directRoles = (paramRoles.direct || []).join(', ') || 'N/A';
        const indirectRoles = (paramRoles.indirect || []).join(', ') || 'N/A';
        const weakRoles = (paramRoles.weakly_identifiable || []).join(', ') || 'N/A';
        const rolesNote = paramRoles.note || '';
        const fixedParamsText = (diagnostics.fixed_params || []).join(', ') || 'N/A';
        const troubleshooting = diagnostics.troubleshooting || {};
        const troubleshootingChanges = (troubleshooting.changes_applied || [])
            .map(line => `<li style="margin-bottom:3px;">${line}</li>`)
            .join('');
        const troubleshootingAdvice = (troubleshooting.recommendations || [])
            .map(line => `<li style="margin-bottom:3px;">${line}</li>`)
            .join('');
        const primaryTroubleCode = troubleshooting.primary_error_code || troubleshooting.error_code || 'OK';
        const secondaryTroubleCodes = Array.isArray(troubleshooting.secondary_error_codes)
            ? troubleshooting.secondary_error_codes.filter(Boolean)
            : [];
        const secondaryTroubleText = secondaryTroubleCodes.length ? secondaryTroubleCodes.join(', ') : 'None';
        const nrDiag = troubleshooting.nr_diagnostics || {};
        const nrSeverity = String(nrDiag.severity || 'n/a').toLowerCase();
        const nrSeverityColor = nrSeverity === 'critical'
            ? '#b91c1c'
            : (nrSeverity === 'warning' ? '#b45309' : '#166534');
        const nrDiagHtml = (nrDiag && typeof nrDiag.combined_nr_factor === 'number')
            ? `<div style="margin-top:6px; padding:6px 8px; border:1px solid #fcd34d; background:#fff7ed; border-radius:6px;">
                   <div><strong>NR diagnostics:</strong> <span style="font-weight:700; color:${nrSeverityColor};">${nrSeverity.toUpperCase()}</span></div>
                   <div style="margin-top:2px;">combined=${fmtNum(nrDiag.combined_nr_factor, 4)} | host=${fmtNum(nrDiag.host_nr_factor, 4)} | anneal=${fmtNum(nrDiag.anneal_nr_factor, 4)} | mole=${fmtNum(nrDiag.mole_nr_factor, 4)}</div>
                   <div style="margin-top:2px; font-size:10px; color:#6b7280;">Critical: ${nrDiag.critical_range || 'n/a'} | Warning: ${nrDiag.warning_range || 'n/a'}</div>
               </div>`
            : '';
        const proposedActions = troubleshooting.proposed_actions || [];
        const proposedActionsHtml = proposedActions.length > 0
            ? `<div style="margin-top:6px;"><strong>Proposed Solution for Next Fit:</strong></div>
               <ul style="margin:4px 0 0 18px; padding:0;">${proposedActions.map(a => {
                   if (a.code === 'FIT-E41') {
                       const usedW = a.used_weight != null ? a.used_weight.toFixed(2) : '?';
                       return `<li style="margin-bottom:3px;">Peak weight: <strong>${usedW} &rarr; ${(a.peak_window_boost || 1.3).toFixed(2)}</strong>, add <strong>${a.extra_adaptive_cycles || 2}</strong> adaptive cycles.</li>`;
                   }
                   if (a.code === 'FIT-E42') {
                       const usedW = a.used_weight != null ? a.used_weight.toFixed(2) : '?';
                       return `<li style="margin-bottom:3px;">Early-rise weight: <strong>${usedW} &rarr; ${(a.early_rise_boost || 1.3).toFixed(2)}</strong>, switch to <strong>${a.fit_mode || 'long'}</strong> mode, add <strong>${a.extra_adaptive_cycles || 3}</strong> adaptive cycles.</li>`;
                   }
                   if (a.code === 'FIT-E43') return `<li style="margin-bottom:3px;">Switch to <strong>${a.fit_mode || 'long'}</strong> mode, add <strong>${a.extra_adaptive_cycles || 3}</strong> adaptive cycles for tail fitting.</li>`;
                   return `<li style="margin-bottom:3px;">${JSON.stringify(a)}</li>`;
               }).join('')}</ul>`
            : '';
        const canOfferPeakBoost = getActiveUploadMode() === 'single' && troubleshooting.dominant_error_region === 'peak window mismatch';
        const canOfferEarlyBoost = getActiveUploadMode() === 'single' && troubleshooting.dominant_error_region === 'early rise mismatch';
        const peakBoostCta = canOfferPeakBoost
            ? `<button onclick="enablePeakEnhanceAndRefit()" style="margin-top:8px; margin-right:6px; padding:6px 10px; border:1px solid #b45309; background:#f59e0b; color:#fff; border-radius:4px; cursor:pointer; font-size:11px; font-weight:700;">Try this in Single: Enhance Peak Window</button>`
            : '';
        const earlyBoostCta = canOfferEarlyBoost
            ? `<button onclick="enableEarlyEnhanceAndRefit()" style="margin-top:8px; padding:6px 10px; border:1px solid #155e75; background:#0891b2; color:#fff; border-radius:4px; cursor:pointer; font-size:11px; font-weight:700;">Try this in Single: Enhance Early Rise</button>`
            : '';
        const troubleshootingHtml = `
            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#92400e;">Troubleshooting</div>
            <div style="padding:8px; border:1px solid #fcd34d; background:#fffbeb; border-radius:6px; font-size:11px; color:#78350f; line-height:1.45;">
                <div><strong>Summary:</strong> ${troubleshooting.summary || 'N/A'}</div>
                <div style="margin-top:4px;"><strong>Target R²:</strong> ${fmtNum(troubleshooting.target_r2, 6)} | <strong>Achieved:</strong> ${fmtNum(troubleshooting.achieved_r2, 6)} | <strong>Reached:</strong> ${troubleshooting.target_reached ? 'Yes' : 'No'}</div>
                <div style="margin-top:4px;"><strong>Primary code:</strong> ${primaryTroubleCode} | <strong>Secondary codes:</strong> ${secondaryTroubleText}</div>
                <div style="margin-top:4px;"><strong>Dominant error region:</strong> ${troubleshooting.dominant_error_region || 'N/A'}</div>
                ${nrDiagHtml}
                <div style="margin-top:6px;"><strong>Changes Applied During Best-Fit Search:</strong></div>
                <ul style="margin:4px 0 0 18px; padding:0;">${troubleshootingChanges || '<li>No changes logged.</li>'}</ul>
                <div style="margin-top:6px;"><strong>Recommendations:</strong></div>
                <ul style="margin:4px 0 0 18px; padding:0;">${troubleshootingAdvice || '<li>No additional recommendations.</li>'}</ul>
                ${proposedActionsHtml}
                ${peakBoostCta}${earlyBoostCta}
            </div>`;

        // Demarcation between runs of different wavelengths and folders
        const isBestFitResult = fittingResults._isBestFit === true;
        const bestFitBadge = isBestFitResult
            ? '<div style="margin:8px 0; padding:8px 12px; background:#dcfce7; border:2px solid #16a34a; border-radius:6px; text-align:center; font-size:14px; font-weight:800; color:#166534;">★ BEST FIT ★</div>'
            : '';
        const runDemarcation = `<div style="margin:18px 0 12px 0; border-top:2px solid ${isBestFitResult ? '#16a34a' : '#6366f1'}; border-bottom:2px solid ${isBestFitResult ? '#16a34a' : '#6366f1'}; background:${isBestFitResult ? '#dcfce7' : '#eef2ff'}; padding:6px 0; text-align:center; font-size:13px; color:${isBestFitResult ? '#166534' : '#3730a3'}; font-weight:700;">Run: ${selectedEmission} nm | Folder: ${diagnostics.folder_name || 'N/A'}${isBestFitResult ? ' | ★ BEST FIT' : ''}</div>`;

        setFitResultsHtml(`
            ${runDemarcation}
            ${bestFitBadge}
            <div class="result-item"><span class="result-label" style="${isBestFitResult ? 'font-weight:800;' : ''}">Fit Quality (R²):</span> <span class="result-value" style="${isBestFitResult ? 'font-weight:800; font-size:14px;' : ''}">${fmtNum(fittingResults.r2, 6)} <span class="quality-indicator ${qualityClass}">${qualityText}</span></span></div>
            <div class="result-item"><span class="result-label">Timing-Gated Acceptance:</span> <span class="result-value" style="color:${timingStatusColor}; font-weight:800;">${timingStatusLabel} <span style="font-weight:500; color:#4b5563;">(${timingStatusReason})</span></span></div>
            <div class="result-item"><span class="result-label">Failed Timing Terms:</span> <span class="result-value" style="text-align:right; max-width:70%;">${failedTimingBadgesHtml}</span></div>
            ${tightenSuggestionHtml}
            <div class="result-item"><span class="result-label">Elapsed Time:</span> <span class="result-value">${fmtNum(diagnostics.elapsed_min, 3)} min</span></div>
            <div class="result-item"><span class="result-label">Fit Quality Mode:</span> <span class="result-value">${diagnostics.selected_quality || diagnostics.fit_quality || 'N/A'} (from ${diagnostics.selected_from || diagnostics.fit_quality || 'N/A'})</span></div>
            <div class="result-item"><span class="result-label">All-Point Optimization:</span> <span class="result-value">${diagnostics.optimize_all_points ? 'Yes' : 'No'}</span></div>
            <div class="result-item"><span class="result-label">Optimization Points:</span> <span class="result-value">${diagnostics.n_points_opt || 'N/A'} / ${diagnostics.n_points_full || 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Fitted Pulse Width:</span> <span class="result-value">${fmtNum(diagnostics.fitted_pulse_width_us, 3)} us</span></div>
            <div class="result-item"><span class="result-label">Optimized Variables:</span> <span class="result-value">${diagnostics.n_optimized_variables || 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Fixed Parameters:</span> <span class="result-value">${diagnostics.n_fixed_params || 'N/A'}</span></div>

            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#374151;">Solver Workload</div>
            <div class="result-item"><span class="result-label">DE Iterations:</span> <span class="result-value">${optDiag.de_iterations ?? 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">DE Evaluations:</span> <span class="result-value">${optDiag.de_evaluations ?? 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Local Evaluations:</span> <span class="result-value">${optDiag.local_evaluations ?? 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Refine Evaluations:</span> <span class="result-value">${optDiag.refine_evaluations ?? 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Polish Passes:</span> <span class="result-value">${optDiag.polish_passes ?? 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Polish Evaluations:</span> <span class="result-value">${optDiag.polish_evaluations ?? 'N/A'}</span></div>
            <div class="result-item"><span class="result-label">Total Evaluations:</span> <span class="result-value">${optDiag.total_evaluations ?? 'N/A'}</span></div>

            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#374151;">Timing Metrics (${timeUnit})</div>
            <div class="result-item"><span class="result-label">Measured Peak Time:</span> <span class="result-value">${fmtNum(tmMeasured.peak_time, 4)}</span></div>
            <div class="result-item"><span class="result-label">Fitted Peak Time:</span> <span class="result-value">${fmtNum(tmFitted.peak_time, 4)}</span></div>
            <div class="result-item"><span class="result-label">Measured Rise τ (10-90%):</span> <span class="result-value">${fmtNum(tmMeasured.rise_time_10_90, 4)}</span></div>
            <div class="result-item"><span class="result-label">Fitted Rise τ (10-90%):</span> <span class="result-value">${fmtNum(tmFitted.rise_time_10_90, 4)}</span></div>
            <div class="result-item"><span class="result-label" title="Time where the decay falls to 1/e ≈ 36.8% of peak">Measured Decay τ (1/e):</span> <span class="result-value">${fmtNum(tmMeasured.decay_tau_1e, 4)}</span></div>
            <div class="result-item"><span class="result-label" title="Time where the fitted decay falls to 1/e ≈ 36.8% of peak">Fitted Decay τ (1/e):</span> <span class="result-value">${fmtNum(tmFitted.decay_tau_1e, 4)}</span></div>
            <div class="result-item"><span class="result-label" title="Absolute difference between fitted peak time and measured peak time">Peak Time Error (abs):</span> <span class="result-value">${fmtNum(peakTimeErr, 4)}</span></div>
            <div class="result-item"><span class="result-label" title="Fractional peak error used by tolerance check">Peak Time Error (ratio):</span> <span class="result-value">${fmtNum(peakRatioErr, 4)}${tolStatus(peakRatioErr, peakTolTarget)}</span></div>
            <div class="result-item"><span class="result-label">Rise Time Error (abs):</span> <span class="result-value">${fmtNum(riseErr, 4)}</span></div>
            <div class="result-item"><span class="result-label" title="Fractional rise error used by tolerance check">Rise Time Error (ratio):</span> <span class="result-value">${fmtNum(riseRatioErr, 4)}${tolStatus(riseRatioErr, riseTolTarget)}</span></div>
            <div class="result-item"><span class="result-label">Decay τ Error (abs):</span> <span class="result-value">${fmtNum(decayErr, 4)}</span></div>
            <div class="result-item"><span class="result-label" title="Fractional decay error used by tolerance check">Decay τ Error (ratio):</span> <span class="result-value">${fmtNum(decayRatioErr, 4)}${tolStatus(decayRatioErr, decayTolTarget)}</span></div>

            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#374151;">ODE Parameters Used (units shown per parameter)</div>
            ${paramsRows || '<div class="result-item"><span class="result-label">Parameters</span><span class="result-value">N/A</span></div>'}

            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#374151;">775 Transfer Guidance Parameters</div>
            ${guideRows || '<div class="result-item"><span class="result-label">Guide Params</span><span class="result-value">N/A</span></div>'}
            <div style="margin-top:4px; font-size:10px; color:#4b5563; line-height:1.4;">W1 controls feeder population build-up before the second ET. If W1 is too low, W2 fitting becomes unstable because Tm1 reservoir is under-fed.</div>

            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#374151;">Fixed Parameter Defaults Used</div>
            <div class="result-item" style="align-items:flex-start;"><span class="result-label">Fixed names:</span><span class="result-value" style="text-align:right; max-width:70%;">${fixedParamsText}</span></div>

            <div style="margin-top:12px; margin-bottom:6px; font-weight:700; color:#374151;">Parameter Influence for Selected Emission</div>
            <div class="result-item" style="align-items:flex-start;"><span class="result-label">Direct (explicit terms):</span><span class="result-value" style="text-align:right; max-width:70%;">${directRoles}</span></div>
            <div class="result-item" style="align-items:flex-start;"><span class="result-label">Indirect (coupled states):</span><span class="result-value" style="text-align:right; max-width:70%;">${indirectRoles}</span></div>
            <div class="result-item" style="align-items:flex-start;"><span class="result-label">Weakly identifiable:</span><span class="result-value" style="text-align:right; max-width:70%;">${weakRoles}</span></div>
            <div style="margin-top:6px; font-size:10px; color:#6b7280; line-height:1.4;">${rolesNote}</div>

            ${troubleshootingHtml}
        `);

        const physicsBox = safeGetElement('physicsInsight');
        if (physicsBox && fittingResults.physics_output) {
            physicsBox.style.display = 'block';
            safeSetText('odeEquation', fittingResults.physics_output.ode.equation);
            safeSetHtml('odeNote', `<strong>${fittingResults.physics_output.ode.name}</strong><br>${fittingResults.physics_output.ode.physics_note}`);

            let constantsHTML = '<table style="width:100%;font-size:12px;"><thead><tr><th>Category</th><th>Constant</th><th>Value</th><th>Description</th></tr></thead><tbody>';
            fittingResults.physics_output.constants.forEach(c => {
                constantsHTML += `<tr><td>${c.category}</td><td>${c.constant}</td><td>${c.value}</td><td>${c.description}</td></tr>`;
            });
            constantsHTML += '</tbody></table>';
            safeSetHtml('constantsTable', constantsHTML);

            safeSetText('scale-factor-display', fittingResults.physics_output.time_scale.toExponential(1));
            safeSetText('time-unit-display', fittingResults.physics_output.time_unit);
            const scaleBadge = safeGetElement('scale-badge');
            if (scaleBadge) scaleBadge.style.display = 'block';
        }

        const mapPanel = safeGetElement('dynamics-map-panel');
        const mapImg = safeGetElement('dynamics-map-img');
        if (mapPanel && mapImg) {
            if (fittingResults.dynamics_map) {
                const mapUrl = fittingResults.dynamics_map.startsWith('/')
                    ? fittingResults.dynamics_map
                    : '/' + fittingResults.dynamics_map;

                const img = new Image();
                img.onload = function() {
                    mapImg.src = mapUrl + '?t=' + Date.now();
                    mapPanel.style.display = 'block';
                };
                img.onerror = function() {
                    mapPanel.style.display = 'none';
                };
                img.src = mapUrl;
            } else {
                mapPanel.style.display = 'none';
            }
        }

        const saveBtn = safeGetElement('saveResultsBtn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.style.opacity = '1';
        }

        const legacyDownloadBtn = document.getElementById('downloadBtn');
        if (legacyDownloadBtn) legacyDownloadBtn.style.display = 'block';

        depositCurrentRun(
            displayFileName,
            payload,
            fittingResults,
            time,
            intensity,
            fittingResults.fitted_intensity,
            getFitResultsHtml()
        );

        showStatus('success', `✓ ${selectedEmission} nm fitting completed and deposited to plot history`);
        appendFitLiveLog(`Fit completed: final R²=${(fittingResults.r2 || 0).toFixed(6)}.`);
        return fittingResults;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            showStatus('warning', 'Fit request aborted.');
            appendFitLiveLog('Fit request aborted.');
            setFitResultsHtml('<p style="color: #92400e; text-align: center;">Fit cancelled by user.</p>');
            throw err;
        } else {
            console.error('❌ Fitting error:', err);

            let errorMessage = err.message;
            const backendCode = err?.backendCode || '';
            const backendStatus = Number(err?.backendStatus || 0);
            const backendPayload = err?.backendPayload || {};
            let resultsErrorHtml = '<p style="color: #999; text-align: center;">Fitting failed. Check console for details.</p>';

            if (err.message.includes('Failed to fetch')) {
                errorMessage = 'Cannot connect to backend. Make sure Flask server is running on port 5050';
            } else if (err.message.includes('not_configured')) {
                errorMessage = 'Physics not configured. Click CONFIGURE button first';
            } else if (backendCode === 'MISSING_DOPING' || (backendStatus === 400 && /doping/i.test(err.message))) {
                errorMessage = 'Missing doping values in fit request. Please set Yb and Tm doping and run again.';
                const requiredFields = Array.isArray(backendPayload.required_fields)
                    ? backendPayload.required_fields.join(', ')
                    : 'doping_yb, doping_tm';
                resultsErrorHtml = `
                    <div style="border:1px solid #fecaca; background:#fff1f2; color:#7f1d1d; border-radius:10px; padding:12px; margin:10px 0;">
                        <div style="font-weight:700; margin-bottom:6px;">Fit request rejected (missing composition)</div>
                        <div style="font-size:13px; line-height:1.45;">
                            Required payload fields: <strong>${requiredFields}</strong><br>
                            Open sample settings and ensure both Yb% and Tm% are present before running fit.
                        </div>
                    </div>
                `;
            } else if (backendCode === 'INVALID_DOPING') {
                errorMessage = 'Invalid doping values. Yb and Tm doping must be numeric finite values.';
                resultsErrorHtml = `
                    <div style="border:1px solid #fecaca; background:#fff1f2; color:#7f1d1d; border-radius:10px; padding:12px; margin:10px 0;">
                        <div style="font-weight:700; margin-bottom:6px;">Fit request rejected (invalid composition)</div>
                        <div style="font-size:13px; line-height:1.45;">
                            Please enter numeric finite values for Yb% and Tm% and retry.
                        </div>
                    </div>
                `;
            } else if (err.message.includes('500')) {
                errorMessage = 'Backend server error. Check Flask console for details';
            }

            showStatus('error', `✗ ${errorMessage}`);
            appendFitLiveLog(`Fit error: ${errorMessage}`);
            setFitResultsHtml(resultsErrorHtml);
            throw err;
        }
    } finally {
        stopFitProgressPolling();
        if (showLoading && loading) loading.style.display = 'none';
        currentFitRequestId = null;
        currentFitAbortController = null;
        if (manageUiBusy) {
            setFitUiBusy(false);
        }
    }
};
// ==================== 20. EXPORT (CSV / Excel) ====================
// --- 20a. Shared CSV helpers ---
const EMISSION_LABELS = {
    '1800': '3F4_3H6_1800nm', '1230': '3H5_3H6_1230nm',
    '775': '3H4_3H6_775nm',  '645': '1G4_3F4_Red_645nm',
    '477': '1G4_3H6_Blue_477nm', '452': '1D2_3F4_452nm',
    '362': '1D2_3F4_UV_362nm',  '345': '1I6_3F4_345nm'
};
const EMISSION_FULL = {
    '1800': '³F₄ → ³H₆ (1800 nm)', '1230': '³H₅ → ³H₆ (1230 nm)',
    '775':  '³H₄ → ³H₆ (775 nm)',  '645':  '¹G₄ → ³F₄ Red (645 nm)',
    '477':  '¹G₄ → ³H₆ Blue (477 nm)', '452': '¹D₂ → ³F₄ (452 nm)',
    '362':  '¹D₂ → ³F₄ UV (362 nm)',   '345': '¹I₆ → ³F₄ (345 nm)'
};

function summarizeTimingAcceptance(diagnostics, r2) {
    const tolAchieved = diagnostics?.tolerance_achieved || {};
    const tolTargets = diagnostics?.tolerance_targets || {};
    const ratioErrors = {
        peak: Number.isFinite(tolAchieved.peak) ? tolAchieved.peak : null,
        rise: Number.isFinite(tolAchieved.rise) ? tolAchieved.rise : null,
        decay: Number.isFinite(tolAchieved.decay) ? tolAchieved.decay : null,
    };
    const targets = {
        peak: Number.isFinite(tolTargets.peak) ? tolTargets.peak : null,
        rise: Number.isFinite(tolTargets.rise) ? tolTargets.rise : null,
        decay: Number.isFinite(tolTargets.decay) ? tolTargets.decay : null,
    };
    const terms = [
        { label: 'Peak', key: 'peak' },
        { label: 'Rise', key: 'rise' },
        { label: 'Decay', key: 'decay' },
    ];
    const checks = terms.filter(t => ratioErrors[t.key] != null && targets[t.key] != null);
    const failedTerms = checks
        .filter(t => ratioErrors[t.key] > targets[t.key])
        .map(t => t.label);
    const timingPass = checks.length > 0 && failedTerms.length === 0;
    const physicallyAccepted = Boolean(timingPass && Number.isFinite(r2) && r2 >= 0.95);
    return {
        timing_pass: timingPass,
        physically_accepted: physicallyAccepted,
        failed_terms: failedTerms,
        ratio_errors: ratioErrors,
        tolerance_targets: targets,
    };
}

function updateTimingPassStreak(contextKey, passed) {
    const key = 'ucfit_timing_pass_tracker_v1';
    const fallback = { context: contextKey, streak: 0 };
    if (!window.localStorage) return passed ? 1 : 0;
    try {
        const raw = window.localStorage.getItem(key);
        const state = raw ? JSON.parse(raw) : fallback;
        const sameContext = state.context === contextKey;
        const nextState = {
            context: contextKey,
            streak: passed ? (sameContext ? (Number(state.streak) || 0) + 1 : 1) : 0,
        };
        window.localStorage.setItem(key, JSON.stringify(nextState));
        return nextState.streak;
    } catch (_err) {
        return passed ? 1 : 0;
    }
}

function getToleranceTighteningSuggestion(targets) {
    if (!targets) return null;
    const tighten = (v, minVal) => (Number.isFinite(v) ? Math.max(minVal, v * 0.9) : null);
    return {
        peak: tighten(targets.peak, 0.01),
        rise: tighten(targets.rise, 0.01),
        decay: tighten(targets.decay, 0.01),
    };
}

function buildRichCsvFilename(fileBaseName, ps, r2, date) {
    // Sanitise: strip extension, replace spaces/slashes with underscores
    const base = (fileBaseName || 'DataFile').replace(/\.[^.]+$/, '').replace(/[\s/\\|:*?"<>]+/g, '_');
    const yb   = Number(ps?.doping_yb  || 0).toFixed(1).replace('.', 'p');
    const tm   = Number(ps?.doping_tm  || 0).toFixed(2).replace('.', 'p');
    const host = (ps?.host || 'Host').replace(/[^A-Za-z0-9]/g, '');
    const anneal = ps?.anneal_temp ? `${Math.round(ps.anneal_temp)}C` : '';
    const em   = EMISSION_LABELS[String(ps?.emission)] || `${ps?.emission || ''}nm`;
    const r2str = typeof r2 === 'number' ? `R2-${r2.toFixed(5)}` : 'R2-NA';
    const dt   = (date || new Date()).toISOString().slice(0, 10);
    const parts = [`UCFit`, `Yb${yb}pct`, `Tm${tm}pct`, host];
    if (anneal) parts.push(anneal);
    parts.push(em, r2str, dt, base);
    return parts.join('_') + '.csv';
}

function buildRichCsvHeader(fileBaseName, ps, diagnostics, odeParams, odeUnits, timingMetrics, physicsOutput, paramRoles, r2, timingAcceptance) {
    const sep = '# ' + '='.repeat(68);
    const fmtN = (v, d=6) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : 'N/A';
    const fmtS = (v, d=4) => (typeof v === 'number' && isFinite(v)) ? Number(v).toExponential(d) : 'N/A';
    const tm  = timingMetrics || {};
    const meas = tm.measured || {};
    const fit  = tm.fitted   || {};
    const optD = diagnostics?.optimization || {};
    const emFull = EMISSION_FULL[String(ps?.emission)] || `${ps?.emission || '?'} nm`;
    const lines = [
        '# TM Lifetime Analyzer - Upconversion Fit Export',
        '# Generated by: PhD Yb/Tm Multilevel ODE Fitting Engine',
        `# Generated at: ${new Date().toISOString()}`,
        sep,
        '# SAMPLE COMPOSITION',
        `#   Yb Doping       : ${fmtN(Number(ps?.doping_yb||0), 2)} mol%`,
        `#   Tm Doping       : ${fmtN(Number(ps?.doping_tm||0), 3)} mol%`,
        `#   Host Material   : ${ps?.host || 'N/A'}`,
        `#   Annealing Temp  : ${ps?.anneal_temp != null ? Math.round(ps.anneal_temp) + ' °C' : 'N/A'}`,
        sep,
        '# DATA FILE',
        `#   Source file     : ${fileBaseName || 'N/A'}`,
        `#   Time Unit       : ${ps?.time_unit || 'N/A'}`,
        `#   Excitation      : ${ps?.excitation_wavelength || 980} nm`,
        `#   Pulse Width     : ${fmtN(Number(ps?.pulse_width_us||0), 1)} μs`,
        sep,
        '# EMISSION CHANNEL',
        `#   Wavelength      : ${ps?.emission || 'N/A'} nm`,
        `#   Transition      : ${emFull}`,
        sep,
        '# FIT QUALITY & DIAGNOSTICS',
        `#   R²              : ${fmtN(r2, 7)}`,
        `#   Fit Mode        : ${diagnostics?.selected_quality || diagnostics?.fit_quality || 'N/A'}`,
        `#   Points (opt/full): ${diagnostics?.n_points_opt || 'N/A'} / ${diagnostics?.n_points_full || 'N/A'}`,
        `#   Fitted Pulse    : ${fmtN(diagnostics?.fitted_pulse_width_us, 3)} μs`,
        `#   Active Params   : ${(diagnostics?.active_params || []).join(', ') || 'N/A'}`,
        `#   Fixed Params    : ${(diagnostics?.fixed_params  || []).join(', ') || 'N/A'}`,
        `#   DE Iterations   : ${optD.de_iterations ?? 'N/A'}`,
        `#   DE Evaluations  : ${optD.de_evaluations ?? 'N/A'}`,
        `#   Local Evals     : ${optD.local_evaluations ?? 'N/A'}`,
        `#   Polish Passes   : ${optD.polish_passes ?? 'N/A'}`,
        `#   Adaptive R² Cyc : ${optD.adaptive_r2_cycles ?? 'N/A'}`,
        `#   Total Evals     : ${optD.total_evaluations ?? 'N/A'}`,
    ];

    // ODE equation from physics output
    if (physicsOutput?.ode) {
        lines.push(sep);
        lines.push('# ODE SYSTEM');
        lines.push(`#   Equation        : ${physicsOutput.ode.equation || 'N/A'}`);
        lines.push(`#   State name      : ${physicsOutput.ode.name || 'N/A'}`);
        if (physicsOutput.ode.physics_note) {
            lines.push(`#   Physics note    : ${physicsOutput.ode.physics_note}`);
        }
    }

    // ODE parameters
    if (odeParams && Object.keys(odeParams).length) {
        lines.push(sep);
        lines.push('# ODE PARAMETERS (fitted or fixed values used)');
        const active = new Set(diagnostics?.active_params || []);
        for (const [k, v] of Object.entries(odeParams)) {
            const unit = odeUnits?.[k] ? ` ${odeUnits[k]}` : ' ms⁻¹';
            const role = active.has(k) ? '[fitted]' : '[fixed]';
            lines.push(`#   ${k.padEnd(8)}: ${fmtS(v, 4)}${unit}  ${role}`);
        }
    }

    // Timing metrics
    lines.push(sep);
    lines.push(`# TIMING METRICS  (time unit: ${ps?.time_unit || 'ms'})`);
    lines.push(`#   Rise 10-90% Measured : ${fmtN(meas.rise_time_10_90, 5)}`);
    lines.push(`#   Rise 10-90% Fitted   : ${fmtN(fit.rise_time_10_90, 5)}`);
    lines.push(`#   Decay τ(1/e) Measured: ${fmtN(meas.decay_tau_1e, 5)}`);
    lines.push(`#   Decay τ(1/e) Fitted  : ${fmtN(fit.decay_tau_1e, 5)}`);
    lines.push(`#   Peak Time Measured   : ${fmtN(meas.peak_time, 5)}`);
    lines.push(`#   Peak Time Fitted     : ${fmtN(fit.peak_time, 5)}`);
    if (timingAcceptance) {
        lines.push(sep);
        lines.push('# FIT ACCEPTANCE SUMMARY');
        lines.push(`#   Timing Pass         : ${timingAcceptance.timing_pass ? 'Yes' : 'No'}`);
        lines.push(`#   Physically Accepted : ${timingAcceptance.physically_accepted ? 'Yes' : 'No'}`);
        lines.push(`#   Failed Terms        : ${(timingAcceptance.failed_terms || []).join(', ') || 'None'}`);
        lines.push(`#   Peak Ratio Error    : ${fmtN(timingAcceptance.ratio_errors?.peak, 5)} (target ${fmtN(timingAcceptance.tolerance_targets?.peak, 5)})`);
        lines.push(`#   Rise Ratio Error    : ${fmtN(timingAcceptance.ratio_errors?.rise, 5)} (target ${fmtN(timingAcceptance.tolerance_targets?.rise, 5)})`);
        lines.push(`#   Decay Ratio Error   : ${fmtN(timingAcceptance.ratio_errors?.decay, 5)} (target ${fmtN(timingAcceptance.tolerance_targets?.decay, 5)})`);
    }

    // Parameter roles
    if (paramRoles && Object.keys(paramRoles).length) {
        lines.push(sep);
        lines.push('# PARAMETER ROLES');
        lines.push(`#   Direct   : ${(paramRoles.direct || []).join(', ')}`);
        lines.push(`#   Indirect : ${(paramRoles.indirect || []).join(', ')}`);
        lines.push(`#   Weakly   : ${(paramRoles.weakly_identifiable || []).join(', ')}`);
    }

    lines.push(sep);
    lines.push('# DATA COLUMNS: Time_ms, Measured_Intensity (normalised), Fitted_Intensity (normalised)');
    lines.push(sep);
    return lines.join('\n') + '\n';
}

function triggerCsvDownload(filename, csvContent) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

async function saveBlobWithPicker(blob, suggestedName, options = {}) {
    const {
        description = 'File',
        accept = { 'application/octet-stream': ['.*'] },
        fallbackDownloadName = suggestedName,
    } = options;

    if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
            suggestedName,
            types: [{ description, accept }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { method: 'picker', filename: handle.name || suggestedName };
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fallbackDownloadName;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return { method: 'download', filename: fallbackDownloadName };
}

function buildResultsJsonFilename(sourceName, sample, timestamp = new Date()) {
    const rawSource = String(sourceName || 'fit_results').replace(/\.[^.]+$/, '');
    const safeSource = rawSource.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'fit_results';
    const yb = String(sample?.yb || 'Yb').replace(/[^0-9a-z_.-]+/gi, '');
    const tm = String(sample?.tm || 'Tm').replace(/[^0-9a-z_.-]+/gi, '');
    const emission = String(sample?.emission || 'emission').replace(/[^0-9a-z_.-]+/gi, '');
    const stamp = timestamp.toISOString().replace(/[:.]/g, '-');
    return `${safeSource}_Yb${yb}_Tm${tm}_${emission}_${stamp}.json`;
}
// --- 20b. CSV download actions ---

window.downloadCSV = async function() {
    if (!lastFitDataForExport || !lastFitDataForExport.time.length) {
        showStatus('error', '✗ No fit data available to export');
        return;
    }

    try {
        const ps = {
            doping_yb: safeGetElement('dopingYbInput')?.value,
            doping_tm: safeGetElement('dopingTmInput')?.value,
            host: safeGetElement('hostSelect')?.value,
            anneal_temp: safeGetElement('annealSelect')?.value,
            emission: safeGetElement('emissionSelect')?.value,
            time_unit: safeGetElement('timeUnit')?.value,
            pulse_width_us: safeGetElement('pulseWidthUs')?.value,
            excitation_wavelength: safeGetElement('excitationWavelength')?.value,
        };
        const diag   = fittingResults?.diagnostics || {};
        const odeP   = fittingResults?.ode_parameters || {};
        const odeU   = fittingResults?.ode_parameter_units || {};
        const tm     = fittingResults?.timing_metrics || {};
        const phys   = fittingResults?.physics_output || null;
        const roles  = fittingResults?.parameter_roles || {};
        const r2     = fittingResults?.r2;
        const acceptance = summarizeTimingAcceptance(diag, r2);
        const srcName = safeGetElement('analyzerCurrentFile')?.textContent || 'DataFile';

        const filename = buildRichCsvFilename(srcName, ps, r2, new Date());
        let csvContent = buildRichCsvHeader(srcName, ps, diag, odeP, odeU, tm, phys, roles, r2, acceptance);
        csvContent += 'Time_ms,Measured_Intensity,Fitted_Intensity\n';
        const data = lastFitDataForExport;
        for (let i = 0; i < data.time.length; i++) {
            csvContent += `${data.time[i]},${data.measured[i]},${data.fitted[i]}\n`;
        }
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const saved = await saveBlobWithPicker(blob, filename, {
            description: 'CSV files',
            accept: { 'text/csv': ['.csv'] },
            fallbackDownloadName: filename,
        });
        showStatus('success', saved.method === 'picker'
            ? `✓ CSV saved: ${saved.filename}`
            : `✓ CSV downloaded: ${saved.filename}`);
    } catch (err) {
        if (err && err.name === 'AbortError') {
            showStatus('warning', 'Save cancelled.');
            return;
        }
        console.error('Export error:', err);
        showStatus('error', '✗ Export failed');
    }
};

window.downloadDepositedCSV = async function() {
    if (activeDepositIndex < 0 || activeDepositIndex >= plotDeposits.length) {
        showStatus('warning', 'Select a deposited run first, then click Download CSV.');
        return;
    }
    try {
        const item = plotDeposits[activeDepositIndex];
        const ps   = item.payloadSummary || {};
        const diag = item.diagnostics || {};
        const odeP = item.ode_parameters || {};
        const odeU = item.ode_parameter_units || {};
        const tm   = item.timing_metrics || {};
        const phys = item.physics_output || null;
        const roles= item.parameter_roles || {};
        const r2   = item.r2;
        const acceptance = summarizeTimingAcceptance(diag, r2);
        const srcName = item.fileName || 'DataFile';
        const date = item.createdAt ? new Date(item.createdAt) : new Date();

        const filename = buildRichCsvFilename(srcName, ps, r2, date);
        let csvContent = buildRichCsvHeader(srcName, ps, diag, odeP, odeU, tm, phys, roles, r2, acceptance);
        csvContent += 'Time_ms,Measured_Intensity,Fitted_Intensity\n';
        const t = item.time    || [];
        const m = item.measured || [];
        const f = item.fitted   || [];
        for (let i = 0; i < t.length; i++) {
            csvContent += `${t[i]},${m[i]},${f[i]}\n`;
        }
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const saved = await saveBlobWithPicker(blob, filename, {
            description: 'CSV files',
            accept: { 'text/csv': ['.csv'] },
            fallbackDownloadName: filename,
        });
        showStatus('success', saved.method === 'picker'
            ? `✓ CSV saved: ${saved.filename}`
            : `✓ CSV downloaded: ${saved.filename}`);
    } catch (err) {
        if (err && err.name === 'AbortError') {
            showStatus('warning', 'Save cancelled.');
            return;
        }
        console.error('Depository CSV export error:', err);
        showStatus('error', '✗ Download failed');
    }
};

// --- 20c. Excel export (all deposited runs) ---
window.downloadAllResultsExcel = async function() {
    if (!plotDeposits || plotDeposits.length === 0) {
        showStatus('warning', 'No deposited runs to export. Run fits and deposit results first.');
        return;
    }
    if (typeof XLSX === 'undefined') {
        showStatus('error', '✗ Excel library (SheetJS) not loaded. Check your internet connection and reload the page.');
        return;
    }

    try {
        const wb = XLSX.utils.book_new();

        // ---- Sheet 1: Summary — one row per deposited run ----
        const summaryHeader = [
            'Run#', 'File', 'Deposited At',
            'Emission (nm)', 'Host', 'Yb (mol%)', 'Tm (mol%)', 'Anneal (°C)',
            'R²', 'Timing Pass', 'Physically Accepted', 'Failed Terms',
            'Peak Ratio Error', 'Peak Target', 'Rise Ratio Error', 'Rise Target', 'Decay Ratio Error', 'Decay Target',
            'Rise 10-90% Measured', 'Rise 10-90% Fitted',
            'Decay τ(1/e) Measured', 'Decay τ(1/e) Fitted',
            'Peak Time Measured', 'Peak Time Fitted',
            'Fit Quality', 'Active Parameters', 'Fixed Parameters',
            'DE Iterations', 'DE Evaluations', 'Total Evaluations',
            'Pulse Width (µs)', 'Excitation (nm)', 'Time Unit'
        ];

        const summaryRows = [summaryHeader];
        plotDeposits.forEach((dep, idx) => {
            const ps   = dep.payloadSummary || {};
            const diag = dep.diagnostics    || {};
            const tm   = dep.timing_metrics || {};
            const meas = tm.measured || {};
            const fit  = tm.fitted   || {};
            const optD = diag.optimization  || {};
            const acceptance = summarizeTimingAcceptance(diag, dep.r2);
            const fmtN = v => (typeof v === 'number' && isFinite(v)) ? v : '';

            summaryRows.push([
                idx + 1,
                dep.fileName || '',
                dep.createdAtLabel || dep.createdAt || '',
                ps.emission  || '',
                ps.host      || '',
                fmtN(Number(ps.doping_yb)),
                fmtN(Number(ps.doping_tm)),
                ps.anneal_temp != null ? Number(ps.anneal_temp) : '',
                fmtN(dep.r2),
                acceptance.timing_pass ? 'Yes' : 'No',
                acceptance.physically_accepted ? 'Yes' : 'No',
                (acceptance.failed_terms || []).join(', ') || 'None',
                fmtN(acceptance.ratio_errors?.peak),
                fmtN(acceptance.tolerance_targets?.peak),
                fmtN(acceptance.ratio_errors?.rise),
                fmtN(acceptance.tolerance_targets?.rise),
                fmtN(acceptance.ratio_errors?.decay),
                fmtN(acceptance.tolerance_targets?.decay),
                fmtN(meas.rise_time_10_90),
                fmtN(fit.rise_time_10_90),
                fmtN(meas.decay_tau_1e),
                fmtN(fit.decay_tau_1e),
                fmtN(meas.peak_time),
                fmtN(fit.peak_time),
                diag.selected_quality || diag.fit_quality || '',
                (diag.active_params || []).join(', '),
                (diag.fixed_params  || []).join(', '),
                optD.de_iterations    != null ? optD.de_iterations    : '',
                optD.de_evaluations   != null ? optD.de_evaluations   : '',
                optD.total_evaluations != null ? optD.total_evaluations : '',
                ps.pulse_width_us != null ? Number(ps.pulse_width_us) : '',
                ps.excitation_wavelength || '',
                ps.time_unit || '',
            ]);
        });

        const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
        // Bold header row
        const summaryRange = XLSX.utils.decode_range(wsSummary['!ref']);
        for (let C = summaryRange.s.c; C <= summaryRange.e.c; C++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: C });
            if (wsSummary[cellRef]) {
                wsSummary[cellRef].s = { font: { bold: true } };
            }
        }
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

        // ---- Sheet 2: ODE Parameters — one row per run, one column per param ----
        const allParamKeys = new Set();
        plotDeposits.forEach(dep => {
            Object.keys(dep.ode_parameters || {}).forEach(k => allParamKeys.add(k));
        });
        const paramKeys = Array.from(allParamKeys).sort();

        const paramsHeader = ['Run#', 'File', 'Emission (nm)', 'R²', ...paramKeys];
        const paramsRows   = [paramsHeader];
        plotDeposits.forEach((dep, idx) => {
            const ps   = dep.payloadSummary  || {};
            const odeP = dep.ode_parameters  || {};
            const row  = [
                idx + 1,
                dep.fileName || '',
                ps.emission  || '',
                (typeof dep.r2 === 'number' && isFinite(dep.r2)) ? dep.r2 : '',
            ];
            paramKeys.forEach(k => {
                const v = odeP[k];
                row.push((typeof v === 'number' && isFinite(v)) ? v : '');
            });
            paramsRows.push(row);
        });

        const wsParams = XLSX.utils.aoa_to_sheet(paramsRows);
        for (let C = 0; C <= paramsHeader.length - 1; C++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: C });
            if (wsParams[cellRef]) wsParams[cellRef].s = { font: { bold: true } };
        }
        XLSX.utils.book_append_sheet(wb, wsParams, 'ODE Parameters');

        // ---- Sheets 3…N: one sheet per deposited run (time, measured, fitted) ----
        plotDeposits.forEach((dep, idx) => {
            const ps = dep.payloadSummary || {};
            const t  = dep.time     || [];
            const m  = dep.measured  || [];
            const f  = dep.fitted    || [];

            // Sheet name: max 31 chars, filesystem-safe
            const rawName = `Run${idx + 1}_${ps.emission || ''}nm_${(dep.fileName || '').replace(/\.[^.]+$/, '')}`;
            const sheetName = rawName.replace(/[\\/:*?[\]]/g, '_').substring(0, 31);

            const dataRows = [['Time', 'Measured_Intensity', 'Fitted_Intensity']];
            for (let i = 0; i < t.length; i++) {
                dataRows.push([t[i], m[i], f[i]]);
            }

            const wsData = XLSX.utils.aoa_to_sheet(dataRows);
            ['A1','B1','C1'].forEach(ref => {
                if (wsData[ref]) wsData[ref].s = { font: { bold: true } };
            });
            XLSX.utils.book_append_sheet(wb, wsData, sheetName);
        });

        // Build filename
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
        const filename = `UCFit_AllResults_${stamp}.xlsx`;

        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob  = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

        const saved = await saveBlobWithPicker(blob, filename, {
            description: 'Excel Workbook',
            accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
            fallbackDownloadName: filename,
        });
        showStatus('success', saved.method === 'picker'
            ? `✓ Excel saved: ${saved.filename} (${plotDeposits.length} run${plotDeposits.length > 1 ? 's' : ''})`
            : `✓ Excel downloaded: ${saved.filename} (${plotDeposits.length} run${plotDeposits.length > 1 ? 's' : ''})`);
    } catch (err) {
        if (err && err.name === 'AbortError') {
            showStatus('warning', 'Save cancelled.');
            return;
        }
        console.error('Excel export error:', err);
        showStatus('error', '✗ Excel export failed: ' + (err.message || err));
    }
};

// ==================== 21. UTILITY FUNCTIONS ====================
window.resetControls = function() {
    if (currentFitRequestId) {
        window.cancelFitting();
    }
    // Reset input fields — helper avoids double safeGetElement calls
    const setVal = (id, val) => { const el = safeGetElement(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = safeGetElement(id); if (el) el.checked = val; };
    const setTxt = (id, val) => { const el = safeGetElement(id); if (el) el.textContent = val; };

    setVal('dopingYbInput', '10');
    setVal('dopingTmInput', '0.5');
    setVal('smoothingWindow', '5');
    setTxt('smoothingWindowValue', '5');
    setVal('fitModeSelect', 'fast');
    setChk('autoTransfer775', true);
    setChk('singlePeakEnhanceToggle', false);
    setChk('singleEarlyEnhanceToggle', false);
    setChk('baselineCorrection', true);
    setChk('smoothing', true);
    setChk('normalization', true);
    
    const summary = safeGetElement('parameterSummary');
    if (summary) summary.style.display = 'none';
    
    const fitBtn = safeGetElement('fitDataButton');
    if (fitBtn) {
        fitBtn.disabled = true;
        fitBtn.style.opacity = '0.5';
    }
    currentFitRequestId = null;
    currentFitAbortController = null;
    setFitUiBusy(false);
    lastFitDataForExport = null;
    rawData = uploadMode === 'single' ? singleRawData : null;
    if (rawData) plotRawData();
    window.fitTransferState = { seeded775: false };
    setFitResultsHtml('<p style="color: #999; text-align: center;">Load data and click "FIT MY DATA" to see results</p>');
    const legacyDownloadBtn = document.getElementById('downloadBtn');
    if (legacyDownloadBtn) legacyDownloadBtn.style.display = 'none';
    
    const physicsBox = safeGetElement('physicsInsight');
    if (physicsBox) physicsBox.style.display = 'none';
};

window.deleteUploadedData = function() {
    if (!confirm('Delete uploaded data? This cannot be undone.')) return;

    if (currentFitRequestId) {
        window.cancelFitting();
    }
    
    rawData = null;
    processedData = null;
    fittingResults = null;
    if (uploadMode === 'single') {
        multipleDatasets = [];
        singleRawData = null;
        singleActiveFileName = 'No file loaded';
    } else {
        initialiseMultiChannelState();
        activeMultiChannelSlotId = null;
        pendingMultiChannelSlotId = null;
        pendingMultiChannelFolderId = null;
        renderMultiChannelFolderQueue();
        renderMultiChannelRows();
    }
    
    const fileInput = safeGetElement('fileInput');
    const folderInput = safeGetElement('folderInput');
    const multiChannelFileInput = safeGetElement('multiChannelFileInput');
    if (fileInput) fileInput.value = '';
    if (folderInput) folderInput.value = '';
    if (multiChannelFileInput) multiChannelFileInput.value = '';
    
    safeSetText('fileName', 'No file selected');
    safeSetText('folderName', 'No folder selected');
    safeSetText('analyzerCurrentFile', 'No file loaded');
    safeSetText('analyzerFileInfo', 'Upload data to begin');
    refreshSidebarFileCount();
    
    const deleteBtn = safeGetElement('deleteDataBtn');
    if (deleteBtn) deleteBtn.style.display = 'none';
    
    Plotly.purge('fitChart');
    setFitResultsHtml('<p style="color: #999; text-align: center;">Load data and click "FIT MY DATA" to see results</p>');
    const legacyDownloadBtn = document.getElementById('downloadBtn');
    if (legacyDownloadBtn) legacyDownloadBtn.style.display = 'none';
    
    showStatus('success', '✓ Data deleted');
};

window.downloadResults = function() {
    const data = {
        timestamp: new Date().toISOString(),
        sample: {
            yb: safeGetElement('dopingYbInput')?.value,
            tm: safeGetElement('dopingTmInput')?.value,
            host: safeGetElement('hostSelect')?.value,
            emission: safeGetElement('emissionSelect')?.value
        },
        fitting_results: fittingResults || null
    };

    try {
        const key = `tm_save_${Date.now()}`;
        localStorage.setItem(key, JSON.stringify(data, null, 2));

        const saves = JSON.parse(localStorage.getItem('tm_saves') || '[]');
        saves.push({ key, timestamp: data.timestamp });
        localStorage.setItem('tm_saves', JSON.stringify(saves));

        showStatus('success', `✓ Saved to browser (${saves.length} total saves)`);
    } catch (err) {
        console.error('Save results error:', err);
        showStatus('error', '✗ Save failed');
    }
};

// ==================== 22. LIFETIME GENERATOR ====================

// Carry-forward handler for "Use for Next Fit" button
window.setCarryForwardFromSelectedRun = function() {
    if (activeDepositIndex < 0 || activeDepositIndex >= plotDeposits.length) {
        showStatus('warning', 'Select a deposited run first, then click Use for Next Fit.');
        return;
    }
    const dep = plotDeposits[activeDepositIndex];
    // Set carry-forward marker for next fit
    lastCarryForwardMarker = {
        folderId: dep.folderId || null,
        slotId: dep.slotId || null,
        emission: dep.payloadSummary?.emission || '',
        sourceEmission: dep.payloadSummary?.emission || '',
        manualOverride: true
    };
    showStatus('success', `Carry-forward source set to run: ${dep.fileName || 'Unknown file'} (emission ${dep.payloadSummary?.emission || ''} nm)`);
    renderMultiChannelRows && renderMultiChannelRows();
};

const SIM_EMISSION_COLORS = {
    '775': '#e74c3c', '477': '#2980b9', '645': '#e67e22',
    '362': '#8e44ad', '452': '#1abc9c', '345': '#c0392b'
};

window.lastSimForwardBundle = window.lastSimForwardBundle || null;
window.lastCompositionEstimateBundle = window.lastCompositionEstimateBundle || null;

window.switchSimTab = function(tab) {
    const isForward = tab === 'forward';
    safeGetElement('simForwardPanel').style.display  = isForward ? '' : 'none';
    safeGetElement('simEstimatePanel').style.display = isForward ? 'none' : '';
    const fBtn = safeGetElement('simTabForwardBtn');
    const eBtn = safeGetElement('simTabEstimateBtn');
    if (fBtn) { fBtn.style.background = isForward ? '#667eea' : 'white'; fBtn.style.color = isForward ? 'white' : '#667eea'; }
    if (eBtn) { eBtn.style.background = isForward ? 'white' : '#667eea'; eBtn.style.color = isForward ? '#667eea' : 'white'; }
};

window.loadLastFitParams = function() {
    // Copy last good fit's Yb/Tm into the forward generator inputs
    const last = window.lastFitResult;
    if (!last) { safeSetText('simForwardStatus', 'No fit result available yet.'); return; }
    const yb = last.yb_pct ?? last.doping_yb;
    const tm = last.tm_pct ?? last.doping_tm;
    if (yb != null) { const el = safeGetElement('simYb'); if (el) el.value = parseFloat(yb).toFixed(2); }
    if (tm != null) { const el = safeGetElement('simTm'); if (el) el.value = parseFloat(tm).toFixed(3); }
    safeSetText('simForwardStatus', '\u2705 Loaded Yb/Tm from last fit result.');
};

function parseCommaNumberList(text) {
    const raw = String(text || '').split(',').map(s => s.trim()).filter(Boolean);
    const vals = raw.map(v => parseFloat(v)).filter(v => Number.isFinite(v));
    return vals;
}

function buildSweepColor(seriesIdx, emissionKey) {
    const palette = ['#ef4444', '#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
    const base = SIM_EMISSION_COLORS[emissionKey] || '#334155';
    if (seriesIdx === 0) return base;
    return palette[seriesIdx % palette.length];
}

function renderSimEquationPanel(data, emissions, spacing) {
    const panel = safeGetElement('simEquationPanel');
    if (!panel) return;
    const inf = data?.influence_model || {};
    const ems = (emissions || []).join(', ');
    panel.style.display = '';
    panel.innerHTML = `
        <div style="font-weight:700; color:#0f172a; margin-bottom:6px;">Equations used in this simulation (ODE model)</div>
        <div style="font-family:'Courier New',monospace; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">
            dYb_e/dt = R_p·Yb_g - A_y·Yb_e - Yb_e·(W1·Tm0 + W2·Tm1 + W3·Tm5 + W4·Tm6 + W5·Tm7) + W_b·Tm5·Yb_g<br>
            dTm5/dt = W2·Yb_e·Tm1 - A50·Tm5 - Wcr·Tm5·Tm0 - W3·Yb_e·Tm5 - W_b·Tm5·Yb_g<br>
            dTm6/dt = W3·Yb_e·Tm5 - (A60 + A61)·Tm6 - W4·Yb_e·Tm6<br>
            dTm7/dt = W4·Yb_e·Tm6 - (A70 + A71)·Tm7 - W5·Yb_e·Tm7<br>
            dTm8/dt = W5·Yb_e·Tm7 - A81·Tm8
        </div>
        <div style="font-size:11px; color:#334155; line-height:1.5;">
            <strong>Observables:</strong> I775∝Tm5, I477∝A60·Tm6, I645∝A61·Tm6, I362/I452∝Tm7, I345∝Tm8.<br>
            <strong>Influence inputs used:</strong> host=${inf.host_material ?? 'N/A'}, anneal=${inf.annealing_c ?? 'N/A'}°C, phonon=${inf.phonon_cm ?? 'N/A'} cm⁻¹, host mole factor=${inf.host_mole_factor ?? 'N/A'} (ref=5).<br>
            <strong>Combined scale factors:</strong> ET=${(inf.combined_et_factor ?? 1).toFixed ? inf.combined_et_factor.toFixed(3) : inf.combined_et_factor}, NR=${(inf.combined_nr_factor ?? 1).toFixed ? inf.combined_nr_factor.toFixed(3) : inf.combined_nr_factor}, RAD=${(inf.combined_rad_factor ?? 1).toFixed ? inf.combined_rad_factor.toFixed(3) : inf.combined_rad_factor}.<br>
            <strong>Selected emissions:</strong> ${ems || 'N/A'} | <strong>Trace spacing:</strong> ${Number.isFinite(spacing) ? spacing.toFixed(3) : '0.000'}
        </div>
    `;
}

window.runForwardSim = function() {
    const yb  = parseFloat(safeGetElement('simYb')?.value || '10');
    const tm  = parseFloat(safeGetElement('simTm')?.value || '0.1');
    const hostMaterial = safeGetElement('simHost')?.value || 'NaYF4';
    const annealingC = parseFloat(safeGetElement('simAnneal')?.value || '500');
    const phononEnergy = parseFloat(safeGetElement('simPhononEnergy')?.value || '350');
    const hostMoleFactor = parseFloat(safeGetElement('simHostMoleFactor')?.value || '5');
    const pulse   = parseFloat(safeGetElement('simPulse')?.value || '100');
    const tmax    = parseFloat(safeGetElement('simTimeMax')?.value || '15');
    const pts     = parseInt(safeGetElement('simPoints')?.value || '500', 10);
    const ybList = parseCommaNumberList(safeGetElement('simYbList')?.value || '');
    const tmList = parseCommaNumberList(safeGetElement('simTmList')?.value || '');
    const sweepMode = safeGetElement('simSweepMode')?.value || 'paired';
    let traceSpacing = parseFloat(safeGetElement('simTraceSpacing')?.value || '0');
    const emissions = ['775','477','645','362','452','345'].filter(e => safeGetElement('simEm' + e)?.checked);
    if (emissions.length === 0) { safeSetText('simForwardStatus', 'Select at least one emission channel.'); return; }
    if (!Number.isFinite(yb) || yb <= 0) { safeSetText('simForwardStatus', 'Enter a valid Yb%.'); return; }
    if (!Number.isFinite(tm) || tm <= 0) { safeSetText('simForwardStatus', 'Enter a valid Tm%.'); return; }
    if (!Number.isFinite(annealingC)) { safeSetText('simForwardStatus', 'Enter a valid annealing temperature.'); return; }
    if (!Number.isFinite(phononEnergy) || phononEnergy <= 0) { safeSetText('simForwardStatus', 'Enter a valid phonon/lattice energy.'); return; }
    if (!Number.isFinite(hostMoleFactor) || hostMoleFactor <= 0) { safeSetText('simForwardStatus', 'Enter a valid host mole factor.'); return; }
    if (!Number.isFinite(traceSpacing) || traceSpacing < 0) traceSpacing = 0;
    traceSpacing = Math.min(traceSpacing, 0.5);

    safeSetText('simForwardStatus', '\u23f3 Simulating\u2026');

    // Optionally carry over lit_params from last fit
    const litParams = (window.lastFitResult && window.lastFitResult.lit_params) ? window.lastFitResult.lit_params : {};

    apiPost('/simulate_lifetime', {
            yb_pct: yb,
            tm_pct: tm,
            yb_values: ybList,
            tm_values: tmList,
            sweep_mode: sweepMode,
            host_material: hostMaterial,
            annealing_c: annealingC,
            phonon_energy_cm: phononEnergy,
            host_mole_factor: hostMoleFactor,
            emissions,
            pulse_us: pulse,
            time_max_ms: tmax,
            num_points: pts,
            lit_params: litParams,
        })
    .then(data => {
        if (data.error) { safeSetText('simForwardStatus', '\u274c ' + data.error); return; }
        const t = data.time;
        const traces = [];
        const metricsRows = [];
        const fmt = v => (v != null && Number.isFinite(v)) ? v.toFixed(4) : '\u2013';

        if (Array.isArray(data.sweeps) && data.sweeps.length > 0) {
            data.sweeps.forEach((sw, idx) => {
                const compLabel = `Yb ${parseFloat(sw.yb_pct).toFixed(3)}% / Tm ${parseFloat(sw.tm_pct).toFixed(3)}%`;
                emissions.forEach(em => {
                    const ch = (sw.channels || {})[em];
                    if (!ch) return;
                    const seriesIdx = idx * emissions.length + emissions.indexOf(em);
                    const yWithOffset = (ch.intensity || []).map(v => Number(v) + (traceSpacing * seriesIdx));
                    traces.push({
                        x: t,
                        y: yWithOffset,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${em} nm | ${compLabel}`,
                        line: {
                            color: buildSweepColor(seriesIdx, em),
                            width: 1.8,
                            dash: ['solid', 'dot', 'dash', 'longdash'][seriesIdx % 4],
                        },
                        opacity: 0.92,
                    });
                    const m = ch.metrics || {};
                    metricsRows.push(`<tr><td style="padding:6px 12px;">${compLabel}</td><td style="padding:6px 12px;font-weight:600;">${em} nm</td><td style="padding:6px 12px;text-align:right;">${fmt(m.peak_time)}</td><td style="padding:6px 12px;text-align:right;">${fmt(m.rise_time_10_90)}</td><td style="padding:6px 12px;text-align:right;">${fmt(m.decay_tau_1e)}</td></tr>`);
                });
            });
        } else {
            for (const em of emissions) {
                const ch = data.channels[em];
                if (!ch) continue;
                const yWithOffset = (ch.intensity || []).map(v => Number(v));
                traces.push({
                    x: t, y: yWithOffset,
                    type: 'scatter', mode: 'lines',
                    name: em + ' nm',
                    line: { color: buildSweepColor(emissions.indexOf(em), em), width: 2 }
                });
                const m = ch.metrics || {};
                metricsRows.push(`<tr><td style="padding:6px 12px;">Yb ${yb.toFixed(3)}% / Tm ${tm.toFixed(3)}%</td><td style="padding:6px 12px;font-weight:600;">${em} nm</td><td style="padding:6px 12px;text-align:right;">${fmt(m.peak_time)}</td><td style="padding:6px 12px;text-align:right;">${fmt(m.rise_time_10_90)}</td><td style="padding:6px 12px;text-align:right;">${fmt(m.decay_tau_1e)}</td></tr>`);
            }
        }
        if (typeof Plotly !== 'undefined') {
            const nSeries = traces.length;
            const yMax = 1.05 + (Math.max(nSeries - 1, 0) * Math.max(traceSpacing, 0));
            Plotly.newPlot('simChart', traces, {
                title: { text: `Simulated Lifetimes — Host ${hostMaterial}, Anneal ${annealingC}°C, Phonon ${phononEnergy} cm⁻¹`, font: { size: 14 } },
                xaxis: { title: 'Time (ms)', showgrid: true, gridcolor: '#eee' },
                yaxis: { title: 'Normalized Intensity (offset when spacing > 0)', range: [0, yMax], showgrid: true, gridcolor: '#eee' },
                paper_bgcolor: 'white', plot_bgcolor: 'white',
                legend: { x: 1, xanchor: 'right', y: 1 },
                margin: { l: 60, r: 30, t: 50, b: 60 }
            }, { responsive: true });
        }
        renderSimEquationPanel(data, emissions, traceSpacing);
        const tbody = safeGetElement('simMetricsRows');
        if (tbody) tbody.innerHTML = metricsRows.join('');
        const tbl = safeGetElement('simMetricsTable');
        if (tbl) tbl.style.display = '';
        const runLabel = (Array.isArray(data.sweeps) && data.sweeps.length > 0)
            ? `${data.sweeps.length} sweep combinations`
            : `Yb ${yb}%, Tm ${tm}%`;
        safeSetText('simForwardStatus', '\u2705 Done — ' + runLabel + ` | Host ${hostMaterial}, Anneal ${annealingC}°C`);

        window.lastSimForwardBundle = {
            timestamp: new Date().toISOString(),
            request: {
                yb_pct: yb,
                tm_pct: tm,
                yb_values: ybList,
                tm_values: tmList,
                sweep_mode: sweepMode,
                host_material: hostMaterial,
                annealing_c: annealingC,
                phonon_energy_cm: phononEnergy,
                host_mole_factor: hostMoleFactor,
                emissions,
                pulse_us: pulse,
                time_max_ms: tmax,
                num_points: pts,
            },
            response: data,
        };
    })
    .catch(err => { safeSetText('simForwardStatus', '\u274c Network error: ' + err.message); });
};

window.fillEstimateFromLastFit = function() {
    const last = window.lastFitResult;
    if (!last) { safeSetText('simEstStatus', 'No fit result available.'); return; }
    const tm = last.timing_metrics || {};
    const fitted = tm.fitted || {};
    const measured = tm.measured || {};
    // Try to fill from explicitly stored per-emission result if available
    const stored = window.multiChannelResults || {};
    let fillCount = 0;
    ['775','477','645','362','452','345'].forEach(em => {
        const r = stored[em];
        if (!r) return;
        const rTm = (r.timing_metrics || {}).fitted || {};
        const peakEl  = safeGetElement('estPeak'  + em);
        const decayEl = safeGetElement('estDecay' + em);
        const useEl   = safeGetElement('estUse'   + em);
        if (rTm.peak_time != null && peakEl)  { peakEl.value  = parseFloat(rTm.peak_time).toFixed(4);  if (useEl) useEl.checked = true; fillCount += 1; }
        if (rTm.decay_tau_1e != null && decayEl) { decayEl.value = parseFloat(rTm.decay_tau_1e).toFixed(4); if (useEl) useEl.checked = true; fillCount += 1; }
    });

    // Fallback for single-channel flow: use last fit metrics for currently selected emission
    if (fillCount === 0) {
        const activeEmission = String(safeGetElement('emissionSelect')?.value || '775');
        const peakVal = (fitted.peak_time != null) ? fitted.peak_time : measured.peak_time;
        const decayVal = (fitted.decay_tau_1e != null) ? fitted.decay_tau_1e : measured.decay_tau_1e;
        const peakEl = safeGetElement('estPeak' + activeEmission);
        const decayEl = safeGetElement('estDecay' + activeEmission);
        const useEl = safeGetElement('estUse' + activeEmission);

        if (peakEl && peakVal != null && Number.isFinite(parseFloat(peakVal))) {
            peakEl.value = parseFloat(peakVal).toFixed(4);
            fillCount += 1;
        }
        if (decayEl && decayVal != null && Number.isFinite(parseFloat(decayVal))) {
            decayEl.value = parseFloat(decayVal).toFixed(4);
            fillCount += 1;
        }
        if (useEl && fillCount > 0) {
            useEl.checked = true;
        }

        if (fillCount > 0) {
            const pTxt = (peakVal != null && Number.isFinite(parseFloat(peakVal))) ? parseFloat(peakVal).toFixed(4) : 'N/A';
            const dTxt = (decayVal != null && Number.isFinite(parseFloat(decayVal))) ? parseFloat(decayVal).toFixed(4) : 'N/A';
            safeSetText('simEstStatus', `✅ Auto-filled ${activeEmission} nm from last fit: peak=${pTxt} ms, decay=${dTxt} ms`);
            return;
        }
    }

    if (fillCount > 0) {
        safeSetText('simEstStatus', `✅ Auto-filled ${fillCount} timing field(s) from saved fit results.`);
    } else {
        safeSetText('simEstStatus', '⚠️ No timing metrics found to auto-fill. Run a fit first and ensure timing metrics are available.');
    }
};

window.runCompositionEstimate = function() {
    const channels = {};
    ['775','477','645','362','452','345'].forEach(em => {
        if (!safeGetElement('estUse' + em)?.checked) return;
        const pt = parseFloat(safeGetElement('estPeak'  + em)?.value || '');
        const dt = parseFloat(safeGetElement('estDecay' + em)?.value || '');
        if (Number.isFinite(pt) && pt > 0 && Number.isFinite(dt) && dt > 0) {
            channels[em] = { peak_time_ms: pt, decay_tau_ms: dt };
        }
    });
    if (Object.keys(channels).length < 1) {
        safeSetText('simEstStatus', 'Enter at least 1 channel timing target.');
        return;
    }
    const optimizeKinetics = !!safeGetElement('estOptimizeKinetics')?.checked;
    const hostMaterial = safeGetElement('estHost')?.value || 'NaYF4';
    const annealingC = parseFloat(safeGetElement('estAnneal')?.value || '500');
    const phononEnergy = parseFloat(safeGetElement('estPhononEnergy')?.value || '350');
    const hostMoleFactor = parseFloat(safeGetElement('estHostMoleFactor')?.value || '5');
    const payload = {
        channels,
        yb_range: [parseFloat(safeGetElement('estYbMin')?.value || '1'), parseFloat(safeGetElement('estYbMax')?.value || '30')],
        tm_range: [parseFloat(safeGetElement('estTmMin')?.value || '0.01'), parseFloat(safeGetElement('estTmMax')?.value || '5')],
        pulse_us: parseFloat(safeGetElement('estPulse')?.value || '100'),
        host_material: hostMaterial,
        annealing_c: annealingC,
        phonon_energy_cm: phononEnergy,
        host_mole_factor: hostMoleFactor,
        optimize_kinetics: optimizeKinetics,
        iterative_rounds: parseInt(safeGetElement('estIterRounds')?.value || '2', 10),
        de_maxiter: parseInt(safeGetElement('estDEMaxIter')?.value || '40', 10),
        kinetics_to_optimize: ['W1', 'W2', 'W3', 'k21', 'k35', 'Wcr', 'Wb', 'A50', 'A60', 'A61'],
        lit_params: (window.lastFitResult && window.lastFitResult.lit_params) ? window.lastFitResult.lit_params : {},
    };
    safeSetText('simEstStatus', optimizeKinetics
        ? '\u23f3 Estimating with kinetic iteration… (may take 20–90 s)'
        : '\u23f3 Estimating… (may take 10–30 s)');
    const resPanel = safeGetElement('simEstResults');
    if (resPanel) resPanel.style.display = 'none';

    apiPost('/estimate_composition', payload)
    .then(data => {
        if (data.error) { safeSetText('simEstStatus', '\u274c ' + data.error); return; }
        const estimatorStatus = data.converged
            ? (data.optimizer_converged === false
                ? '\u2705 Usable estimate (iteration cap reached)'
                : '\u2705 Converged')
            : '\u26a0\ufe0f Did not fully converge';
        safeSetText('simEstStatus', estimatorStatus);
        safeSetText('estResYb', data.best_yb_pct.toFixed(2) + ' %');
        safeSetText('estResTm', data.best_tm_pct.toFixed(3) + ' %');
        safeSetText('estResScore', data.score.toExponential(3));
        safeSetText('estResConverged', data.convergence_note || (data.converged ? 'converged' : 'not converged'));
        const conf = data.confidence || {};
        if (conf.yb_range) safeSetText('estResYbConf', conf.yb_range[0] + '\u2013' + conf.yb_range[1] + ' %');
        if (conf.tm_range) safeSetText('estResTmConf', conf.tm_range[0] + '\u2013' + conf.tm_range[1] + ' %');
        const kineticNoteEl = safeGetElement('estResKineticNote');
        if (kineticNoteEl) {
            if (data.kinetics_optimized) {
                kineticNoteEl.textContent = `Kinetics were co-optimized (${(data.kinetics_names || []).join(', ')}) over ${data.iterative_rounds || 1} rounds at host ${data.host_material || hostMaterial}, anneal ${data.annealing_c ?? annealingC}°C.`;
            } else {
                kineticNoteEl.textContent = `Kinetic rates were held fixed. Host ${data.host_material || hostMaterial} and annealing ${data.annealing_c ?? annealingC}°C were still applied as influence factors.`;
            }
        }
        const cq = data.channel_quality || {};
        const rows = Object.entries(cq).map(([em, q]) => {
            const fmt = v => (v != null && Number.isFinite(v)) ? v.toFixed(4) : '\u2013';
            if ('r2' in q) {
                return `<tr><td style="padding:6px 12px;font-weight:600;">${em} nm</td><td colspan="4" style="padding:6px 12px;text-align:center;">R\u00b2 = ${q.r2.toFixed(5)}</td></tr>`;
            }
            return `<tr><td style="padding:6px 12px;font-weight:600;">${em} nm</td><td style="padding:6px 12px;text-align:right;">${fmt(q.simulated_peak_time_ms)}</td><td style="padding:6px 12px;text-align:right;">${fmt(q.target_peak_time_ms)}</td><td style="padding:6px 12px;text-align:right;">${fmt(q.simulated_decay_tau_ms)}</td><td style="padding:6px 12px;text-align:right;">${fmt(q.target_decay_tau_ms)}</td></tr>`;
        }).join('');
        const tbody = safeGetElement('estResChannelRows');
        if (tbody) tbody.innerHTML = rows;
        if (resPanel) resPanel.style.display = '';

        window.lastCompositionEstimateBundle = {
            timestamp: new Date().toISOString(),
            request: payload,
            response: data,
        };
    })
    .catch(err => { safeSetText('simEstStatus', '\u274c Network error: ' + err.message); });
};

window.saveLifetimeGeneratorData = function() {
    const forward = window.lastSimForwardBundle;
    const estimate = window.lastCompositionEstimateBundle;
    if (!forward && !estimate) {
        showStatus('warning', 'No lifetime generator output available yet. Run forward simulation or composition estimation first.');
        return;
    }

    const bundle = {
        exported_at: new Date().toISOString(),
        source: 'Lifetime Generator',
        forward,
        composition_estimate: estimate,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `lifetime_generator_data_${stamp}.json`;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showStatus('success', `Saved lifetime generator data: ${fileName}`);
};

// Storage for multi-channel results used by auto-fill
window.multiChannelResults = window.multiChannelResults || {};

// ==================== 23. INITIALIZATION ====================
window.addEventListener('load', function() {
    console.log('🚀 TM Lifetime Analyzer initialized');
    initialiseMultiChannelState();
    renderMultiChannelFolderQueue();
    renderMultiChannelRows();
    showView('home');
    renderDevelopmentFitting('775');
    initializeFileUploadHandlers();
    loadPlotDeposits();
    renderDepositList();
    if (plotDeposits.length > 0) {
        activeDepositIndex = plotDeposits.length - 1;
        window.openDepositedPlot(activeDepositIndex);
    }
    setFitUiBusy(false);
    switchUploadMode('single');
    updateLuminescenceFlowUi();
    refreshSidebarFileCount();
    
    // Connect phonon energy inputs
    const phononInput = safeGetElement('phononEnergyInput');
    const phononNR = safeGetElement('phononEnergy_NR');
    if (phononInput && phononNR) {
        phononInput.addEventListener('input', (e) => {
            phononNR.value = e.target.value;
        });
    }

    updateNrModeUi();
    
    // Add Wnr calculation listeners
    ['tauFeeding3F4', 'tauRad3H4'].forEach(id => {
        const el = safeGetElement(id);
        if (el) el.addEventListener('input', updateWnrCalculation);
    });
    
    // Set up smoothing window display
    const smoothWindow = safeGetElement('smoothingWindow');
    const smoothValue = safeGetElement('smoothingWindowValue');
    if (smoothWindow && smoothValue) {
        smoothWindow.addEventListener('input', (e) => {
            smoothValue.textContent = e.target.value;
        });
    }
    
    // Update excitation energy on load
    updateExcitationEnergy();
});
