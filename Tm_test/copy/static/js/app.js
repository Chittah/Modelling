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
const EMISSION_TRACE_COLORS = {
    '345': '#7c3aed',
    '346': '#7c3aed',
    '362': '#8b5cf6',
    '452': '#4f46e5',
    '454': '#4f46e5',
    '477': '#2563eb',
    '645': '#dc2626',
    '775': '#7f1d1d',
    '1230': '#9333ea',
    '1800': '#6d28d9',
};
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
    { id: 'slot775', defaultEmission: '775' },
    { id: 'slot477', defaultEmission: '477' },
    { id: 'slot645', defaultEmission: '645' },
    { id: 'slot362', defaultEmission: '362' },
    { id: 'slot452', defaultEmission: '452' },
    { id: 'slot345', defaultEmission: '345' },
    { id: 'slot1800', defaultEmission: '1800' },
    { id: 'slot1230', defaultEmission: '1230' },
];

const MULTI_CHANNEL_ORDER = ['775', '1800', '477', '645', '362', '452', '345'];
const MULTI_CHANNEL_MIN_R2 = {
    '775': 0.99,
    '477': 0.99,
    '645': 0.99,
    '362': 0.99,
    '452': 0.99,
    '345': 0.99,
};

const RETRY_COUNTDOWN_SECONDS = 10; 
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
        latex: "\\frac{dTm_5}{dt} = k_{35} \\cdot Tm_3 - A_{50} \\cdot Tm_5 - W_3 \\cdot Yb_e \\cdot Tm_5",
        population: ["k₃₅ · Tm₃ (non-radiative relaxation from ³F₂,₃)"],
        depopulation: ["A₅₀ · Tm₅ (radiative 775 nm)", "W₃ · Ybₑ · Tm₅ (ET → ¹G₄)"]
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
// Direct single-photon excitation: 260 nm (³H₆→³P₂), 356 nm (³H₆→¹D₂), 466 nm (³H₆→¹G₄)
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
    },
    // ---- Direct (single-photon) excitation of Tm3+ levels. Levels: Tm0=3H6, Tm1=3F4, Tm3=3H4,
    // ---- Tm5=1G4, Tm6=1D2, Tm7=1I6, Tm8=3P2. G(t)=sigma_exc*Phi(t) is the pump rate per ground-state ion.
    // ---- 3H5 and 3F2,3 are omitted: they neither feed nor are fed by any observed channel here.
    // ---- Cross-relaxation (W_CR) is omitted because Tm <= 0.05 mol%; add it for Tm >= ~0.5 mol%.
    "260": {
        excitation_label: "260 nm (³H₆ → ³P₂) UV GSA",
        description: "Single-photon UV excitation into ³P₂. ³P₂ relaxes very fast (W_NR,87 is the largest rate) into ¹I₆, which emits at 346 nm (¹I₆ → ³F₄). ¹D₂, ¹G₄ and ³H₄ are reached only through the slow ¹I₆ → ¹D₂ multiphonon step, so 454/645/775 nm are delayed and weak. No ESA/ETU; Tm cross-relaxation and optional effective Tm→Yb loss are represented separately.",
        states: {
            "Tm8": {
                latex: "\\frac{dTm_8}{dt} = G(t) \\cdot Tm_0 - W_{NR,87} \\cdot Tm_8",
                label: "³P₂",
                population: ["G(t) · Tm₀ (260 nm absorption, pulse width t_p)"],
                depopulation: ["W_NR,87 · Tm₈ (fast multiphonon to ¹I₆)"]
            },
            "Tm7": {
                latex: "\\frac{dTm_7}{dt} = W_{NR,87} \\cdot Tm_8 - (A_{70} + A_{71} + W_{NR,76}) \\cdot Tm_7",
                label: "¹I₆",
                observable: "346 nm: I₃₄₆ ∝ A₇₁ · Tm₇ (¹I₆ → ³F₄)",
                population: ["W_NR,87 · Tm₈"],
                depopulation: ["A₇₀ · Tm₇ (→ ³H₆)", "A₇₁ · Tm₇ (346 nm → ³F₄)", "W_NR,76 · Tm₇ (→ ¹D₂)"]
            },
            "Tm6": {
                latex: "\\frac{dTm_6}{dt} = W_{NR,76} \\cdot Tm_7 - (A_{60} + A_{61} + A_{63} + W_{NR,65}) \\cdot Tm_6",
                label: "¹D₂",
                observable: "454 nm: I₄₅₄ ∝ A₆₁ · Tm₆ (¹D₂ → ³F₄) | 362 nm: I₃₆₂ ∝ A₆₀ · Tm₆",
                population: ["W_NR,76 · Tm₇"],
                depopulation: ["A₆₀ · Tm₆", "A₆₁ · Tm₆", "A₆₃ · Tm₆ (→ ³H₄)", "W_NR,65 · Tm₆ (→ ¹G₄)"]
            },
            "Tm5": {
                latex: "\\frac{dTm_5}{dt} = W_{NR,65} \\cdot Tm_6 - (A_{50} + A_{51} + A_{53}) \\cdot Tm_5",
                label: "¹G₄",
                observable: "477 nm: I₄₇₇ ∝ A₅₀ · Tm₅ | 645 nm: I₆₄₅ ∝ A₅₁ · Tm₅",
                population: ["W_NR,65 · Tm₆"],
                depopulation: ["A₅₀ · Tm₅", "A₅₁ · Tm₅", "A₅₃ · Tm₅ (→ ³H₄)"]
            },
            "Tm3": {
                latex: "\\frac{dTm_3}{dt} = A_{53} \\cdot Tm_5 + A_{63} \\cdot Tm_6 - (A_{30} + A_{31}) \\cdot Tm_3",
                label: "³H₄",
                observable: "775 nm: I₇₇₅ ∝ A₃₀ · Tm₃",
                population: ["A₅₃ · Tm₅", "A₆₃ · Tm₆"],
                depopulation: ["A₃₀ · Tm₃ (775 nm)", "A₃₁ · Tm₃ (→ ³F₄)"]
            },
            "Tm1": {
                latex: "\\frac{dTm_1}{dt} = A_{31} \\cdot Tm_3 + A_{51} \\cdot Tm_5 + A_{61} \\cdot Tm_6 + A_{71} \\cdot Tm_7 - A_{10} \\cdot Tm_1",
                label: "³F₄",
                observable: "1800 nm: I₁₈₀₀ ∝ A₁₀ · Tm₁",
                population: ["A₃₁ · Tm₃", "A₅₁ · Tm₅", "A₆₁ · Tm₆", "A₇₁ · Tm₇"],
                depopulation: ["A₁₀ · Tm₁"]
            },
            "Tm0": {
                latex: "\\frac{dTm_0}{dt} = -G(t) \\cdot Tm_0 + A_{10} Tm_1 + A_{30} Tm_3 + A_{50} Tm_5 + A_{60} Tm_6 + A_{70} Tm_7",
                label: "³H₆ (ground)",
                population: ["A₁₀·Tm₁ + A₃₀·Tm₃ + A₅₀·Tm₅ + A₆₀·Tm₆ + A₇₀·Tm₇ (radiative returns)"],
                depopulation: ["G(t) · Tm₀ (260 nm absorption)"]
            }
        },
        parameters: {
            "G(t)": "σ_exc·Φ(t) for 0 ≤ t ≤ t_p (pulse width), 0 afterwards (s⁻¹ per ground-state ion)",
            "W_NR,87": "Multiphonon ³P₂ → ¹I₆ (s⁻¹), much larger than every other rate",
            "W_NR,76": "Multiphonon ¹I₆ → ¹D₂ (s⁻¹), slow in fluorides (large gap)",
            "W_NR,65": "Multiphonon ¹D₂ → ¹G₄ (s⁻¹), slow in fluorides (large gap)",
            "A_ij": "Radiative rate from level i to level j (s⁻¹)"
        }
    },
    "356": {
        excitation_label: "356 nm (³H₆ → ¹D₂) direct GSA",
        description: "Direct single-photon excitation into ¹D₂. 454 nm (¹D₂ → ³F₄) follows ¹D₂ directly: a rise limited by pulse/IRF, then decay at (A₆₀+A₆₁+A₆₃+W_NR,65)⁻¹. 775 nm (³H₄ → ³H₆) is fed only through ¹D₂ → ³H₄ branching and the ¹G₄ relay, so it shows a delayed rise and decays with the slower of the feeder and ³H₄ lifetimes.",
        states: {
            "Tm6": {
                latex: "\\frac{dTm_6}{dt} = G(t) \\cdot Tm_0 - (A_{60} + A_{61} + A_{63} + W_{NR,65}) \\cdot Tm_6",
                label: "¹D₂",
                observable: "454 nm: I₄₅₄ ∝ A₆₁ · Tm₆ (¹D₂ → ³F₄) | 362 nm: I₃₆₂ ∝ A₆₀ · Tm₆",
                population: ["G(t) · Tm₀ (356 nm absorption, pulse width t_p)"],
                depopulation: ["A₆₀ · Tm₆", "A₆₁ · Tm₆ (454 nm)", "A₆₃ · Tm₆ (→ ³H₄)", "W_NR,65 · Tm₆ (→ ¹G₄)"]
            },
            "Tm5": {
                latex: "\\frac{dTm_5}{dt} = W_{NR,65} \\cdot Tm_6 - (A_{50} + A_{51} + A_{53}) \\cdot Tm_5",
                label: "¹G₄",
                observable: "477 nm: I₄₇₇ ∝ A₅₀ · Tm₅ | 645 nm: I₆₄₅ ∝ A₅₁ · Tm₅",
                population: ["W_NR,65 · Tm₆"],
                depopulation: ["A₅₀ · Tm₅", "A₅₁ · Tm₅", "A₅₃ · Tm₅ (→ ³H₄)"]
            },
            "Tm3": {
                latex: "\\frac{dTm_3}{dt} = A_{53} \\cdot Tm_5 + A_{63} \\cdot Tm_6 - (A_{30} + A_{31}) \\cdot Tm_3",
                label: "³H₄",
                observable: "775 nm: I₇₇₅ ∝ A₃₀ · Tm₃",
                population: ["A₅₃ · Tm₅", "A₆₃ · Tm₆"],
                depopulation: ["A₃₀ · Tm₃ (775 nm)", "A₃₁ · Tm₃ (→ ³F₄)"]
            },
            "Tm1": {
                latex: "\\frac{dTm_1}{dt} = A_{31} \\cdot Tm_3 + A_{51} \\cdot Tm_5 + A_{61} \\cdot Tm_6 - A_{10} \\cdot Tm_1",
                label: "³F₄",
                observable: "1800 nm: I₁₈₀₀ ∝ A₁₀ · Tm₁",
                population: ["A₃₁ · Tm₃", "A₅₁ · Tm₅", "A₆₁ · Tm₆"],
                depopulation: ["A₁₀ · Tm₁"]
            },
            "Tm0": {
                latex: "\\frac{dTm_0}{dt} = -G(t) \\cdot Tm_0 + A_{10} Tm_1 + A_{30} Tm_3 + A_{50} Tm_5 + A_{60} Tm_6",
                label: "³H₆ (ground)",
                population: ["A₁₀·Tm₁ + A₃₀·Tm₃ + A₅₀·Tm₅ + A₆₀·Tm₆ (radiative returns)"],
                depopulation: ["G(t) · Tm₀ (356 nm absorption)"]
            }
        },
        parameters: {
            "G(t)": "σ_exc·Φ(t) for 0 ≤ t ≤ t_p (pulse width), 0 afterwards (s⁻¹ per ground-state ion)",
            "W_NR,65": "Multiphonon ¹D₂ → ¹G₄ (s⁻¹), slow in fluorides (large gap)",
            "A_ij": "Radiative rate from level i to level j (s⁻¹)"
        }
    },
    "466": {
        excitation_label: "466 nm (³H₆ → ¹G₄) direct GSA",
        description: "Direct single-photon excitation into ¹G₄. 645 nm (¹G₄ → ³F₄) and 477 nm (¹G₄ → ³H₆) follow ¹G₄ directly, so the 645 nm trace is a pulse-limited rise followed by a single-exponential decay at (A₅₀+A₅₁+A₅₃)⁻¹. ³H₄ (775 nm) is fed only by the weak ¹G₄ → ³H₄ branch. When Yb³⁺ is present, the displayed and fitted equations include effective Tm → Yb loss on ³H₄ and ¹G₄.",
        states: {
            "Tm5": {
                latex: "\\frac{dTm_5}{dt} = G(t) \\cdot Tm_0 - (A_{50} + A_{51} + A_{53}) \\cdot Tm_5",
                label: "¹G₄",
                observable: "645 nm: I₆₄₅ ∝ A₅₁ · Tm₅ (¹G₄ → ³F₄) | 477 nm: I₄₇₇ ∝ A₅₀ · Tm₅",
                population: ["G(t) · Tm₀ (466 nm absorption, pulse width t_p)"],
                depopulation: ["A₅₀ · Tm₅ (477 nm)", "A₅₁ · Tm₅ (645 nm)", "A₅₃ · Tm₅ (→ ³H₄)"]
            },
            "Tm3": {
                latex: "\\frac{dTm_3}{dt} = A_{53} \\cdot Tm_5 - (A_{30} + A_{31}) \\cdot Tm_3",
                label: "³H₄",
                observable: "775 nm: I₇₇₅ ∝ A₃₀ · Tm₃",
                population: ["A₅₃ · Tm₅"],
                depopulation: ["A₃₀ · Tm₃ (775 nm)", "A₃₁ · Tm₃ (→ ³F₄)"]
            },
            "Tm1": {
                latex: "\\frac{dTm_1}{dt} = A_{31} \\cdot Tm_3 + A_{51} \\cdot Tm_5 - A_{10} \\cdot Tm_1",
                label: "³F₄",
                observable: "1800 nm: I₁₈₀₀ ∝ A₁₀ · Tm₁",
                population: ["A₃₁ · Tm₃", "A₅₁ · Tm₅"],
                depopulation: ["A₁₀ · Tm₁"]
            },
            "Tm0": {
                latex: "\\frac{dTm_0}{dt} = -G(t) \\cdot Tm_0 + A_{10} Tm_1 + A_{30} Tm_3 + A_{50} Tm_5",
                label: "³H₆ (ground)",
                population: ["A₁₀·Tm₁ + A₃₀·Tm₃ + A₅₀·Tm₅ (radiative returns)"],
                depopulation: ["G(t) · Tm₀ (466 nm absorption)"]
            }
        },
        parameters: {
            "G(t)": "σ_exc·Φ(t) for 0 ≤ t ≤ t_p (pulse width), 0 afterwards (s⁻¹ per ground-state ion)",
            "A_ij": "Radiative rate from level i to level j (s⁻¹)"
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
            'At high Tm (>=1.0%), allow feeder-chain terms W2, A50, WcrH4, WcrG4, and Wb to remain active.',
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
            'At high Tm, unlock feeder terms W2, A50, WcrH4, WcrG4 and, when needed, Wb/k35.',
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
let continueFitVisible = false;

function setFitStoppedState(isStopped) {
    const continueBtn = document.getElementById('continueFitButton');
    continueFitVisible = isStopped;
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
        const fitDisabled = fitBtn.disabled;
        const cancelDisabled = cancelBtn.disabled;
        const shouldShow = continueFitVisible || (fitDisabled && cancelDisabled);
        continueBtn.style.display = shouldShow ? 'inline-block' : 'none';
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
            displayName: '',
            data: null,
            metadata: null,
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
        pulseWidthUs: safeGetElement('pulseWidthUs')?.value || '400',
        timeUnit: safeGetElement('timeUnit')?.value || 'ns',
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
    setValue('pulseWidthUs', config.pulseWidthUs || '400');
    setValue('timeUnit', config.timeUnit || 'ns');
    setValue('excitationWavelength', config.excitationWavelength);
    updateExcitationEnergy();
    if (!isSingleTmMode()) updateActivePhysics();
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
        const emissionOptions = getEmissionOptionsForMode().map(opt => `
            <option value="${opt.value}" ${state.emission === opt.value ? 'selected' : ''}>${opt.label}</option>
        `).join('');
        const statusColor = isCarryForwardSource ? '#166534' : (fileLoaded ? '#166534' : '#64748b');
        const statusTextBase = fileLoaded ? (state.displayName || state.fileName) : 'No file loaded';
        const statusText = isCarryForwardSource
            ? `${statusTextBase} · Carry-forward source`
            : statusTextBase;
        const rowBorderColor = isCarryForwardSource ? '#22c55e' : '#fed7aa';
        const rowBackground = isCarryForwardSource ? '#f0fdf4' : '#fff';
        return `
            <div style="display:grid; grid-template-columns:minmax(140px, 1fr) minmax(120px, 0.9fr) auto auto; gap:8px; align-items:center; border:2px solid ${rowBorderColor}; background:${rowBackground}; border-radius:6px; padding:8px;">
                <div>
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
        setActiveDatasetView(state.data, `${labelPrefix}${state.displayName || state.fileName || `${state.emission} nm`}`, state.emission);
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
    state.displayName = '';
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
        // Quota hit: keep metadata (incl. isBestFit) for every deposit, but only keep curves for the newest ones.
        for (const keep of [10, 4, 0]) {
            try {
                const slim = plotDeposits.map((d, i) => i >= plotDeposits.length - keep ? d
                    : { ...d, time: [], measured: [], fitted: [], resultsHtml: d.isBestFit ? d.resultsHtml : '' });
                localStorage.setItem('tm_plot_deposits', JSON.stringify(slim));
                return;
            } catch (e2) { /* try a smaller footprint */ }
        }
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
    ['homeView', 'analyzerView', 'developmentView', 'simulatorView', 'motionView', 'helpView'].forEach(view => {
        const panel = safeGetElement(view);
        if (panel) panel.style.display = 'none';
    });
    
    // Show selected view
    const selectedView = safeGetElement(viewName + 'View');
    if (selectedView) selectedView.style.display = 'block';
    if (viewName === 'motion') {
        const frame = safeGetElement('motionFrame');
        if (frame) {
            const host = safeGetElement('hostSelect')?.value || 'YF3';
            const motionUrl = new URL('motion/index.html', window.location.href);
            motionUrl.searchParams.set('host', host);
            if (frame.src !== motionUrl.href) frame.src = motionUrl.href;
        }
    }
    
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
    const statusMap = { home: 'Welcome', analyzer: 'Analyzer Active', development: 'Development Fitting', simulator: 'Lifetime Generator', motion: 'Energy-Transfer Motion', help: 'Help Center' };
    const colorMap = { home: '#3498db', analyzer: '#27ae60', development: '#f59e0b', simulator: '#8e44ad', motion: '#0e7490', help: '#f39c12' };
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
function parseCsvRecord(line, delimiter = ',') {
    const fields = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (quoted && line[i + 1] === '"') {
                value += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (char === delimiter && !quoted) {
            fields.push(value.trim());
            value = '';
        } else {
            value += char;
        }
    }
    fields.push(value.trim());
    return fields;
}

function parseCSVContent(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    const metadata = {};
    let dataStartIdx = 0;
    const delimiter = (lines[0]?.match(/\t/g) || []).length > (lines[0]?.match(/,/g) || []).length
        ? '\t'
        : ',';
    
    // Try to detect metadata
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const line = lines[i].trim();
        if (line.includes(delimiter)) {
            const parts = parseCsvRecord(line, delimiter);
            if (parts.length >= 2) {
                const first = parseFloat(parts[0]);
                const second = parseFloat(parts[1]);
                if (isNaN(first) || isNaN(second)) {
                    const key = parts[0].replace(/^\uFEFF/, '').trim();
                    const values = parts.slice(1);
                    while (values.length && values[values.length - 1] === '') values.pop();
                    metadata[key] = values.join(delimiter);
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
        
        const parts = line.includes(delimiter)
            ? parseCsvRecord(line, delimiter)
            : line.split(/\s+/);
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

function getSampleNameFromMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return '';
    const valuesByKey = new Map(
        Object.entries(metadata).map(([key, value]) => [
            String(key).toLowerCase().replace(/[^a-z0-9]/g, ''),
            String(value ?? '').trim(),
        ])
    );
    const preferredKeys = [
        'labels', 'fullsamplename', 'samplename', 'specimenname', 'datasetname',
        'fullname', 'filename', 'filefullname', 'name', 'sample',
        'specimen', 'dataset', 'file',
    ];
    for (const key of preferredKeys) {
        const value = valuesByKey.get(key);
        if (value) return value;
    }
    return '';
}

function isShortDosFilename(fileName) {
    const basename = String(fileName || '').split(/[\\/]/).pop();
    return /^[A-Z0-9]{1,6}~\d(?:\.[A-Z0-9]{1,3})?$/i.test(basename);
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
                    const fileName = file.webkitRelativePath || file.name;
                    const sampleName = getSampleNameFromMetadata(data.metadata);
                    let displayName = sampleName || fileName;
                    if (data.metadata && Object.keys(data.metadata).length > 0) {
                        const metaParts = Object.entries(data.metadata)
                            .map(([k, v]) => `${k}: ${v}`);
                        displayName = sampleName || metaParts.join(' | ');
                    }
                    
                    multipleDatasets.push({
                        name: fileName,
                        displayName: displayName,
                        data: data
                    });
                    
                    // Load first file automatically
                    if (multipleDatasets.length === 1) {
                        rawData = data;
                        singleRawData = data;
                        currentFitIndex = 0;
                        singleActiveFileName = displayName;
                        
                        // Update UI
                        safeSetText('fileName', '✓ ' + displayName);
                        safeSetText('analyzerCurrentFile', displayName);
                        safeSetText('active-filename-display', displayName);
                        safeSetText('analyzerFileInfo', `${data.time.length} data points`);
                        
                        const deleteBtn = safeGetElement('deleteDataBtn');
                        if (deleteBtn) deleteBtn.style.display = 'block';
                        
                        plotRawData();
                    }
                    
                    // Update file count
                    refreshSidebarFileCount();
                    if (!sampleName && isShortDosFilename(fileName)) {
                        showStatus('warning', `Loaded file alias ${fileName}, but no full sample name was found in its metadata. Add a "Sample Name,<full name>" metadata row to the CSV.`);
                    } else {
                        showStatus('success', `✓ Loaded ${displayName}`);
                    }
                }
            } catch (err) {
                console.error('Error processing file:', err);
                showStatus('error', `✗ Error loading ${file.webkitRelativePath || file.name}: ${err.message}`);
            }
        };
        
        reader.onerror = () => {
            showStatus('error', `✗ Error reading ${file.webkitRelativePath || file.name}`);
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
                    `✓ ${files[0].webkitRelativePath || files[0].name}` : `✓ ${files.length} files selected`;
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
                    const sourceFileName = targetFile.webkitRelativePath || targetFile.name;
                    const sampleName = getSampleNameFromMetadata(parsed.metadata);
                    const displayName = sampleName || sourceFileName;
                    const folder = multiChannelFolders.find(item => item.id === folderId) || getActiveMultiChannelFolder();
                    const state = folder?.slotState?.[slotId];
                    if (!state) return;
                    state.fileName = sourceFileName;
                    state.displayName = displayName;
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
                    if (!sampleName && isShortDosFilename(sourceFileName)) {
                        showStatus('warning', `Loaded file alias ${sourceFileName}, but no full sample name was found in its metadata. Add a "Sample Name,<full name>" metadata row to the CSV.`);
                    } else {
                        showStatus('success', `✓ Loaded ${displayName} for ${state.emission} nm in ${folder?.name || 'active folder'}.`);
                    }
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
const POWER_LAW_PHOTON_ORDER = {
    '0.01': { '775': 0.995, '477': 2.085, '645': 1.884 },
    '0.02': { '775': 1.078, '477': 2.086, '645': 1.919 },
    '0.05': { '775': 1.178, '477': 2.050, '645': 1.996, '362': 2.661, '345': 2.955 },
    '0.1': { '775': 1.243, '477': 2.079, '645': 2.076, '362': 2.708, '345': 3.225 },
    '0.2': { '775': 1.370, '477': 2.153, '645': 2.118, '362': 2.935, '345': 2.992 },
    '0.5': { '775': 1.422, '477': 2.093, '645': 2.078, '362': 2.989, '345': 3.373 },
    '1.0': { '775': 1.633, '477': 2.263, '645': 2.242 },
    '2.0': { '775': 1.702, '477': 2.737, '645': 2.034 }
};
const ETUC_CHANNEL_ROUTES = {
    '1800': { startLevel: 'Tm0', states: ['Tm0', 'Tm1', 'Tm2'], transfers: [1], relaxations: ['k21'], radiative: ['A10'] },
    '775': { startLevel: 'Tm0', states: ['Tm0', 'Tm1', 'Tm2', 'Tm3', 'Tm5'], transfers: [1, 2], relaxations: ['k21', 'k35'], radiative: ['A50'] },
    '477': { startLevel: 'Tm5', states: ['Tm5', 'Tm6'], transfers: [3], relaxations: [], radiative: ['A60'] },
    '645': { startLevel: 'Tm5', states: ['Tm5', 'Tm6', 'Tm1'], transfers: [3], relaxations: [], radiative: ['A61'] },
    '362': { startLevel: 'Tm6', states: ['Tm6', 'Tm7'], transfers: [4], relaxations: [], radiative: ['A70'] },
    '452': { startLevel: 'Tm6', states: ['Tm6', 'Tm7', 'Tm1'], transfers: [4], relaxations: [], radiative: ['A71'] },
    '345': { startLevel: 'Tm7', states: ['Tm7', 'Tm8', 'Tm1'], transfers: [5], relaxations: [], radiative: ['A81'] }
};
const ETUC_TRANSFER_PAIRS = [
    ['Tm0', 'Tm2'], ['Tm1', 'Tm3'], ['Tm5', 'Tm6'], ['Tm6', 'Tm7'], ['Tm7', 'Tm8']
];
const ENERGY_LEVEL_NAMES = {
    Tm0: '³H₆', Tm1: '³F₄', Tm2: '³H₅', Tm3: '³F₂,₃',
    Tm5: '³H₄', Tm6: '¹G₄', Tm7: '¹D₂', Tm8: '¹I₆'
};
const Tm_REFERENCE_ENERGIES = {
    H6: 0, F4: 5900, H5: 8500, H4: 12800, F23: 14550,
    G4: 21400, D2: 27900, I6: 35000, P2: 38000
};
const ENERGY_AXIS_MAX = 40000;
const ENERGY_AXIS_TOP = 72;
const ENERGY_AXIS_BOTTOM = 340;
const energyAxisY = energy => ENERGY_AXIS_BOTTOM - energy / ENERGY_AXIS_MAX * (ENERGY_AXIS_BOTTOM - ENERGY_AXIS_TOP);
let energySimulationTimer = null;

function updateEnergyDiagram(tmPct, ybPct, emission, singleTmMode, visible) {
    const diagram = safeGetElement('odeEnergyDiagram');
    if (!diagram) return;
    clearInterval(energySimulationTimer);
    energySimulationTimer = null;
    diagram.classList.remove('is-playing');
    diagram.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const colors = { pump: '#7c3aed', transfer: '#2563eb', relaxation: '#64748b', radiative: '#059669', feed: '#0891b2', cross: '#d97706', quench: '#db2777' };
    const markerDefs = Object.entries(colors).map(([name, color]) =>
        `<marker id="energyArrow${name}" markerWidth="2.6" markerHeight="2.6" refX="2.3" refY="1.3" orient="auto"><path d="M0,0 L2.6,1.3 L0,2.6 Z" fill="${color}"/></marker>`
    ).join('');
    const ybLevels = [
        { id: 'Ybg', label: 'Ybᵍ · ²F₇/₂', energy: 0, y: energyAxisY(0) },
        { id: 'Ybe', label: 'Ybᵉ · ²F₅/₂', energy: 10200, y: energyAxisY(10200) }
    ];
    const displayedYbCount = singleTmMode && ybPct <= 0
        ? 0
        : Math.max(1, Math.min(5, Math.ceil(Math.max(0, ybPct) / 10)));
    const ybMarkerRadius = 4.5 + Math.min(Math.max(0, ybPct), 50) / 50 * 2.5;
    const backTransferVisualScale = Math.max(0.65, 1 - Math.min(Math.max(0, ybPct), 50) * 0.007);
    const ybDonorX = index => displayedYbCount === 1
        ? 145
        : 90 + index * 110 / (displayedYbCount - 1);
    const ucLevels = [
        { id: 'Tm0', label: 'Tm₀ · ³H₆', energy: Tm_REFERENCE_ENERGIES.H6 },
        { id: 'Tm1', label: 'Tm₁ · ³F₄', energy: Tm_REFERENCE_ENERGIES.F4 },
        { id: 'Tm2', label: 'Tm₂ · ³H₅', energy: Tm_REFERENCE_ENERGIES.H5 },
        { id: 'Tm3', label: 'Tm₃ · ³F₂,₃', energy: Tm_REFERENCE_ENERGIES.F23 },
        { id: 'Tm5', label: 'Tm₅ · ³H₄', energy: Tm_REFERENCE_ENERGIES.H4 },
        { id: 'Tm6', label: 'Tm₆ · ¹G₄', energy: Tm_REFERENCE_ENERGIES.G4 },
        { id: 'Tm7', label: 'Tm₇ · ¹D₂', energy: Tm_REFERENCE_ENERGIES.D2 },
        { id: 'Tm8', label: 'Tm₈ · ¹I₆', energy: Tm_REFERENCE_ENERGIES.I6 }
    ].map(level => ({ ...level, y: energyAxisY(level.energy) }));
    const stLevels = [
        { id: 'H6', label: '³H₆ · ground', energy: Tm_REFERENCE_ENERGIES.H6 },
        { id: 'F4', label: '³F₄', energy: Tm_REFERENCE_ENERGIES.F4 },
        { id: 'H4', label: '³H₄', energy: Tm_REFERENCE_ENERGIES.H4 },
        { id: 'G4', label: '¹G₄', energy: Tm_REFERENCE_ENERGIES.G4 },
        { id: 'D2', label: '¹D₂', energy: Tm_REFERENCE_ENERGIES.D2 },
        { id: 'I6', label: '¹I₆', energy: Tm_REFERENCE_ENERGIES.I6 },
        { id: 'P2', label: '³P₂', energy: Tm_REFERENCE_ENERGIES.P2 }
    ].map(level => ({ ...level, y: energyAxisY(level.energy) }));
    const radiativeMap = {
        '1800': ['Tm1', 'A₁₀'], '775': ['Tm5', 'A₅₀'], '477': ['Tm6', 'A₆₀'],
        '645': ['Tm6', 'A₆₁'], '362': ['Tm7', 'A₇₀'], '452': ['Tm7', 'A₇₁'],
        '345': ['Tm8', 'A₈₁']
    };
    const singleEmissionMap = {
        '1800': ['F4', 'A₁₀'], '775': ['H4', 'A₃₀'], '477': ['G4', 'A₅₀'],
        '645': ['G4', 'A₅₁'], '362': ['D2', 'A₆₀'], '452': ['D2', 'A₆₁'],
        '454': ['D2', 'A₆₁'], '345': ['I6', 'A₇₁'], '346': ['I6', 'A₇₁']
    };
    const selected = singleTmMode ? singleEmissionMap[String(emission)] : radiativeMap[String(emission)];
    const concentrationKey = Object.keys(POWER_LAW_PHOTON_ORDER).reduce((closest, value) =>
        Math.abs(Number(value) - tmPct) < Math.abs(Number(closest) - tmPct) ? value : closest
    );
    const measuredPhotonOrder = POWER_LAW_PHOTON_ORDER[concentrationKey]?.[String(emission)];
    const unsupportedReferenceChannel = !singleTmMode && String(emission) === '1230';
    const unsupportedSelectedEmission = singleTmMode && !selected;
    const singleExcitation = singleTmMode ? resolveSingleTmExcitation() : null;
    const singleCascadeAvailable = singleTmMode && Boolean(selected)
        && singleTmCascadeReachable(singleExcitation, String(emission));
    const fitPairUnsupported = singleCascadeAvailable
        && !singleTmReachable(singleExcitation, String(emission));
    const unreachableSingleEmission = singleTmMode && Boolean(selected) && !singleCascadeAvailable;
    const activeState = selected?.[0] || (!singleTmMode && unsupportedReferenceChannel ? 'Tm2' : null);
    const savedEmissionFit = window.multiChannelResults?.[String(emission)];
    const lastEmissionFit = window.lastFitResult?.emission === String(emission) ? window.lastFitResult : null;
    const emissionFit = savedEmissionFit || lastEmissionFit;
    const fitDiagnostics = emissionFit?.diagnostics || {};
    const fitTiming = emissionFit?.timing_metrics?.fitted || {};
    const fitUnits = emissionFit?.timing_metrics?.time_unit || safeGetElement('timeUnit')?.value || 'ms';
    const fittedPulseUs = fitDiagnostics.fitted_pulse_width_us;
    const enteredPulseUs = Number(safeGetElement('pulseWidthUs')?.value);
    const excitationNm = singleTmMode
        ? resolveSingleTmExcitation()?.key
        : (Number(safeGetElement('excitationWavelength')?.value) || 980);
    const timingSummary = `<section class="energy-timing-summary">
        <strong>Excitation and decay timing</strong>
        <span>Excitation: ${Number.isFinite(Number(excitationNm)) ? `${excitationNm} nm` : 'select wavelength'}${Number.isFinite(enteredPulseUs) && enteredPulseUs > 0 ? ` · pulse ${enteredPulseUs} µs` : ''}${Number.isFinite(fittedPulseUs) ? ` · fitted pulse ${Number(fittedPulseUs).toFixed(2)} µs` : ''}</span>
        <span>Decay lifetime (1/e): ${fitTiming.decay_tau_1e != null && Number.isFinite(Number(fitTiming.decay_tau_1e)) ? `${Number(fitTiming.decay_tau_1e).toFixed(4)} ${fitUnits}` : 'run this emission fit to calculate'}</span>
        <span>Rise time (10–90%): ${fitTiming.rise_time_10_90 != null && Number.isFinite(Number(fitTiming.rise_time_10_90)) ? `${Number(fitTiming.rise_time_10_90).toFixed(4)} ${fitUnits}` : 'run this emission fit to calculate'}</span>
    </section>`;
    const metadataText = [
        ...Object.entries(rawData?.metadata || {}).map(([key, value]) => `${key} ${value}`),
        safeGetElement('active-filename-display')?.textContent || ''
    ].join(' ');
    const measuredChannel = metadataText.match(/(?:lifetime|emission|channel)[\s_-]*(\d{3,4})\s*nm/i)?.[1];
    const channelMismatch = measuredChannel && measuredChannel !== String(emission)
        ? `Uploaded data metadata identifies ${measuredChannel} nm, but ${emission} nm is selected. The fit will run against the selected model; verify the channel before interpreting its parameters.`
        : '';
    const energyAxisMarkup = Array.from({ length: 5 }, (_, index) => {
        const energy = index * 10000;
        const y = energyAxisY(energy);
        return `<line x1="50" y1="${y}" x2="425" y2="${y}" stroke="#e2e8f0" stroke-width="0.8"/>
            <line x1="45" y1="${y}" x2="50" y2="${y}" stroke="#64748b" stroke-width="0.8"/>
            <text x="40" y="${y + 3}" text-anchor="end" font-size="7" fill="#64748b">${energy.toLocaleString('en-US')}</text>`;
    }).join('');
    const levelLines = (levels, x1, x2, labelX, visibleIds = null) => levels
        .filter(level => !visibleIds || visibleIds.has(level.id))
        .map(level =>
        `<line x1="${x1}" y1="${level.y}" x2="${x2}" y2="${level.y}" stroke="${level.id === activeState ? colors.radiative : '#475569'}" stroke-width="${level.id === activeState ? 3.5 : 2}"/>
         <text x="${labelX}" y="${level.y + 4}" font-size="10" font-weight="${level.id === activeState ? 700 : 500}" fill="${level.id === activeState ? colors.radiative : '#334155'}">${level.label}<tspan font-size="8"> · ${level.energy.toLocaleString('en-US')}</tspan></text>`
    ).join('');
    let transitionId = 0;
    const transition = (from, to, x, kind, selected = false, fade = false, label = '') => {
        const source = from.y;
        const target = to.y;
        const head = target < source ? 'up' : 'down';
        const x0 = x;
        const y0 = source + (head === 'up' ? -7 : 7);
        const y1 = target + (head === 'up' ? 7 : -7);
        const mid = (y0 + y1) / 2;
        const pathId = `energyTransition${transitionId++}`;
        const path = kind === 'relaxation'
            ? `M${x0} ${y0} C${x0 + 12} ${y0 + (mid - y0) * 0.55} ${x0 - 8} ${y1 - (y1 - mid) * 0.55} ${x0} ${y1}`
            : kind === 'cross'
                ? `M${x0} ${y0} C${x0 - 24} ${y0} ${x0 - 24} ${y1} ${x0} ${y1}`
            : kind === 'quench'
                ? `M${x0} ${y0} C${x0 - 24} ${y0} ${x0 - 24} ${y1} ${x0} ${y1}`
                : `M${x0} ${y0} L${x0} ${y1}`;
        const classes = [
            'energy-transition',
            `energy-transition--${kind}`,
            selected ? 'is-selected' : '',
            fade ? 'is-unselected' : ''
        ].filter(Boolean).join(' ');
        const labelText = label
            ? `<text class="energy-rate-label" x="${x0 + 5}" y="${mid - 2}" font-size="8" font-weight="700" fill="${colors[kind]}" stroke="#fff" stroke-width="2.5" paint-order="stroke">${label}</text>`
            : '';
        return `<path id="${pathId}" class="${classes}" data-rate-label="${label}" d="${path}" fill="none" stroke="${colors[kind]}" marker-end="url(#energyArrow${kind})"/>
            ${labelText}
            <circle class="energy-particle" r="3" aria-hidden="true"><animateMotion dur="${kind === 'radiative' ? '1.8s' : '2.4s'}" repeatCount="indefinite"><mpath href="#${pathId}"/></animateMotion></circle>`;
    };
    const levelsById = Object.fromEntries(ucLevels.map(level => [level.id, level]));
    const singleById = Object.fromEntries(stLevels.map(level => [level.id, level]));
    let svg = '';
    let groups = [];
    let reactionRows = [];
    if (singleTmMode) {
        const exc = resolveSingleTmExcitation();
        const entryId = exc ? ({ P2: 'P2', D2: 'D2', G4: 'G4', H4: 'H4' })[exc.entry] : null;
        const esaId = exc?.esa || null;
        const singleBranches = {
            '1800': { from: 'F4', to: 'H6', rate: 'A₁₀' },
            '775': { from: 'H4', to: 'H6', rate: 'A₃₀' },
            '477': { from: 'G4', to: 'H6', rate: 'A₅₀' },
            '645': { from: 'G4', to: 'F4', rate: 'A₅₁' },
            '362': { from: 'D2', to: 'H6', rate: 'A₆₀' },
            '454': { from: 'D2', to: 'F4', rate: 'A₆₁' },
            '452': { from: 'D2', to: 'F4', rate: 'A₆₁' },
            '345': { from: 'I6', to: 'F4', rate: 'A₇₁' },
            '346': { from: 'I6', to: 'F4', rate: 'A₇₁' }
        };
        const selectedBranch = singleBranches[String(emission)];
        const order = ['P2', 'I6', 'D2', 'G4', 'H4', 'F4', 'H6'];
        const emissionIndex = selectedBranch ? order.indexOf(selectedBranch.from) : -1;
        const sourceIndexes = [entryId, esaId].filter(Boolean).map(id => order.indexOf(id));
        const firstSourceIndex = sourceIndexes.length ? Math.min(...sourceIndexes) : 0;
        const relevantStateIds = new Set(['H6', ...(selectedBranch ? [selectedBranch.from, selectedBranch.to] : [])]);
        order.slice(firstSourceIndex, emissionIndex + 1).forEach(id => relevantStateIds.add(id));
        const showCrH4 = tmPct > 0 && relevantStateIds.has('H4')
            && (relevantStateIds.has('F4') || relevantStateIds.has('H6'));
        const showCrD2 = tmPct > 0 && relevantStateIds.has('D2')
            && (relevantStateIds.has('G4') || relevantStateIds.has('F4'));
        if (showCrH4) relevantStateIds.add('F4');
        if (showCrD2) {
            relevantStateIds.add('G4');
            relevantStateIds.add('F4');
        }
        const singleEdges = [
            { from: 'P2', to: 'I6', rate: 'W₈₇', kind: 'relaxation', x: 176 },
            { from: 'I6', to: 'D2', rate: 'W₇₆', kind: 'relaxation', x: 196 },
            { from: 'D2', to: 'G4', rate: 'W₆₅', kind: 'relaxation', x: 216 },
            { from: 'D2', to: 'H4', rate: 'A₆₃ · feed', kind: 'feed', x: 232 },
            { from: 'G4', to: 'H4', rate: 'A₅₃ · feed', kind: 'feed', x: 248 },
            { from: 'H4', to: 'H6', rate: 'A₃₀', kind: 'radiative', x: 276 },
            { from: 'H4', to: 'F4', rate: 'A₃₁', kind: 'radiative', x: 294 },
            { from: 'G4', to: 'H6', rate: 'A₅₀', kind: 'radiative', x: 312 },
            { from: 'G4', to: 'F4', rate: 'A₅₁', kind: 'radiative', x: 330 },
            { from: 'D2', to: 'H6', rate: 'A₆₀', kind: 'radiative', x: 348 },
            { from: 'D2', to: 'F4', rate: 'A₆₁', kind: 'radiative', x: 366 },
            { from: 'I6', to: 'F4', rate: 'A₇₁', kind: 'radiative', x: 384 },
            { from: 'F4', to: 'H6', rate: 'A₁₀', kind: 'radiative', x: 402 }
        ];
        const singleEdgeRelevant = edge => {
            if (edge.kind === 'radiative') {
                return Boolean(selectedBranch && edge.from === selectedBranch.from && edge.to === selectedBranch.to);
            }
            const fromIndex = order.indexOf(edge.from);
            const toIndex = order.indexOf(edge.to);
            return fromIndex >= firstSourceIndex && toIndex <= emissionIndex && toIndex > fromIndex
                && relevantStateIds.has(edge.from) && relevantStateIds.has(edge.to);
        };
        const singleTransitions = singleEdges.filter(singleEdgeRelevant).map(edge =>
            transition(singleById[edge.from], singleById[edge.to], edge.x, edge.kind, true, false, edge.rate)
        ).join('');
        const crossEdges = [];
        if (showCrH4) {
            crossEdges.push(transition(singleById.H4, singleById.F4, 205, 'cross', true, false, `Kcr·${tmPct}%`));
        }
        if (showCrD2) {
            crossEdges.push(transition(singleById.D2, singleById.G4, 225, 'cross', true, false, `Kcr·${tmPct}%`));
        }
        if (ybPct > 0 && relevantStateIds.has('H4')) {
            crossEdges.push(transition(singleById.H4, singleById.H6, 64, 'quench', true, false, `Kyb·${ybPct}%`));
        }
        if (ybPct > 0 && relevantStateIds.has('G4')) {
            crossEdges.push(transition(singleById.G4, singleById.H6, 74, 'quench', true, false, `Kyb·${ybPct}%`));
        }
        const ybLevelsMarkup = ybPct > 0 ? `
            <text x="155" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="#334155">Yb³⁺ acceptor</text>
            ${ybLevels.map(level => `<line x1="75" y1="${level.y}" x2="190" y2="${level.y}" stroke="${level.id === 'Ybg' ? '#334155' : '#475569'}" stroke-width="2.5"/><text x="68" y="${level.y + 4}" text-anchor="end" font-size="9" fill="#334155">${level.label}</text><text x="201" y="${level.y + 3}" font-size="7" fill="#64748b">${level.energy.toLocaleString('en-US')}</text>`).join('')}` : '';
        svg = `<text x="340" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="#334155">Direct Tm³⁺ excitation${ybPct > 0 ? ' · Yb loss' : ''}</text>
            <text x="7" y="52" font-size="8" fill="#64748b">Energy (cm⁻¹)</text>
            <path d="M45 348 L45 65" stroke="#94a3b8" stroke-width="1" marker-end="url(#energyArrowrelaxation)"/>
            ${energyAxisMarkup}
            ${ybLevelsMarkup}
            ${levelLines(stLevels, 245, 350, 430)}
            ${entryId ? transition(singleById.H6, singleById[entryId], 270, 'pump', true, false, `G · ${exc.key} nm`) : ''}
            ${esaId ? transition(singleById[entryId], singleById[esaId], 292, 'transfer', true, false, 'G₂ · ESA') : ''}
            ${singleTransitions}
            ${crossEdges.join('')}`;
        const excitationText = exc
            ? `${exc.key} nm excitation: ³H₆ → ${SINGLE_TM_LEVEL_LABEL[exc.entry]}${exc.esa ? `; G₂ ESA → ${SINGLE_TM_LEVEL_LABEL[exc.esa]}` : ''}`
            : 'Select a supported excitation wavelength to show the pump entry.';
        groups = [
            { title: 'Selected ODE path', color: colors.pump, items: [excitationText, selectedBranch ? `${emission} nm emission: ${selectedBranch.from} → ${selectedBranch.to} (${selectedBranch.rate})` : 'No matching emission transition in the ODE.'] },
            { title: 'Concentration-dependent terms', color: colors.cross, items: [
                `Kcr · Tm ${tmPct} mol%${tmPct >= 0.3 ? ' · fitted' : ' · held at prior'}`,
                ...(ybPct > 0 ? [`Kyb · Yb ${ybPct} mol%`] : [])
            ] }
        ];
        reactionRows = [
            ...(tmPct > 0 ? [`<div class="energy-reaction" style="border-color:${colors.cross}"><b>Kcr · Tm-Tm cross-relaxation</b><span>³H₄ + ³H₆ → 2 ³F₄; ¹D₂ + ³H₆ → ¹G₄ + ³F₄</span><small>ODE coefficient is multiplied by Tm concentration (${tmPct} mol%). Fitter only frees Kcr at Tm ≥ 0.3 mol%.</small></div>`] : []),
            ...(ybPct > 0 ? [`<div class="energy-reaction" style="border-color:${colors.quench}"><b>Kyb · optional Tm→Yb quenching</b><span>ODE loss from ³H₄ and ¹G₄, scaled by Yb concentration (${ybPct} mol%).</span></div>`] : [])
        ];
    } else {
        const ybById = Object.fromEntries(ybLevels.map(level => [level.id, level]));
        const route = ETUC_CHANNEL_ROUTES[String(emission)];
        const visibleProcesses = new Set([
            ...(route?.transfers.map(index => `W${index}`) || []),
            ...(route?.relaxations || []),
            ...(route?.radiative || [])
        ]);
        const visibleStates = new Set(['Tm0', route?.startLevel, ...(route?.states || [])].filter(Boolean));
        if (tmPct > 0.1 && route && (route.transfers.includes(3) || route.startLevel === 'Tm6')) {
            visibleProcesses.add('WcrG4');
            visibleStates.add('Tm6');
            visibleStates.add('Tm5');
        }
        const reachesH4 = route && (route.startLevel === 'Tm5' || route.startLevel === 'Tm6'
            || route.transfers.includes(2) || route.transfers.includes(3));
        if (tmPct > 1.0 && reachesH4) {
            visibleProcesses.add('WcrH4');
            visibleStates.add('Tm5');
            visibleStates.add('Tm1');
        }
        if (ybPct > 10.0 && reachesH4) {
            visibleProcesses.add('Wb');
            visibleStates.add('Tm5');
        }
        const odeParameters = emissionFit?.ode_parameters || {};
        const displayRate = (name, symbol) => {
            const value = Number(odeParameters[name]);
            return Number.isFinite(value) ? `${symbol} (${value.toPrecision(3)} ms⁻¹)` : symbol;
        };
        const rateNames = ['W₁·Ybₑ', 'W₂·Ybₑ', 'W₃·Ybₑ', 'W₄·Ybₑ', 'W₅·Ybₑ'];
        const transferPairs = [
            ['Tm0', 'Tm2'], ['Tm1', 'Tm3'], ['Tm5', 'Tm6'], ['Tm6', 'Tm7'], ['Tm7', 'Tm8']
        ];
        const ybTransferMarkup = [1, 2, 3, 4, 5].map(index => {
            const x = 96 + (index - 1) * 16;
            const y1 = ybById.Ybe.y + 7;
            const y2 = ybById.Ybg.y - 7;
            return `<path d="M${x} ${y1} L${x} ${y2}" fill="none" stroke="${colors.transfer}" stroke-width="1.1" marker-end="url(#energyArrowtransfer)"/>
                <text x="${x + 2}" y="${(y1 + y2) / 2}" font-size="7" font-weight="700" fill="${colors.transfer}" stroke="#fff" stroke-width="2" paint-order="stroke">W${index}</text>`;
        }).join('');
        const transferMarkup = transferPairs.map(([from, to], i) => {
            const process = `W${i + 1}`;
            if (!visibleProcesses.has(process)) return '';
            const tmX = 265 + i * 14;
            return transition(levelsById[from], levelsById[to], tmX, 'transfer', true, false, rateNames[i]);
        }).join('');
        const k21Path = visibleProcesses.has('k21')
            ? transition(levelsById.Tm2, levelsById.Tm1, 282, 'relaxation', true, false, 'k₂₁')
            : '';
        const k35Path = visibleProcesses.has('k35')
            ? transition(levelsById.Tm3, levelsById.Tm5, 300, 'relaxation', true, false, 'k₃₅')
            : '';
        const emissionEdges = [
            { key: 'A10', from: 'Tm1', to: 'Tm0', x: 320, nm: '1800' },
            { key: 'A50', from: 'Tm5', to: 'Tm0', x: 336, nm: '775' },
            { key: 'A60', from: 'Tm6', to: 'Tm0', x: 352, nm: '477' },
            { key: 'A61', from: 'Tm6', to: 'Tm1', x: 368, nm: '645' },
            { key: 'A70', from: 'Tm7', to: 'Tm0', x: 384, nm: '362' },
            { key: 'A71', from: 'Tm7', to: 'Tm1', x: 400, nm: '452' },
            { key: 'A81', from: 'Tm8', to: 'Tm1', x: 416, nm: '345' }
        ];
        const emissionMarkup = emissionEdges
            .filter(edge => visibleProcesses.has(edge.key))
            .map(edge => transition(levelsById[edge.from], levelsById[edge.to], edge.x, 'radiative', true, false, `${edge.key} · ${edge.nm} nm`))
            .join('');
        const crossMarkup = [
            ...(visibleProcesses.has('WcrG4') ? [transition(levelsById.Tm6, levelsById.Tm5, 230, 'cross', true, false, `Wcr,G4·${tmPct}%`)] : []),
            ...(visibleProcesses.has('WcrH4') ? [transition(levelsById.Tm5, levelsById.Tm1, 242, 'cross', true, false, `Wcr,H4·${tmPct}%`)] : []),
            ...(visibleProcesses.has('Wb') ? [transition(levelsById.Tm5, levelsById.Tm0, 216, 'quench', true, false, `Wb·Yb ${ybPct}%`)] : [])
        ].join('');
        const processItems = [
            { title: 'Yb excitation and decay', color: colors.pump, items: [
                `${displayRate('Rp', 'Rₚ')}: Ybᵍ → Ybₑ`,
                `${displayRate('Ay', 'Aᵧ')}: Ybₑ → Ybᵍ`
            ] },
            { title: 'Selected ODE transfer path', color: colors.transfer, items: [
                ...[1, 2, 3, 4, 5].filter(i => visibleProcesses.has(`W${i}`)).map(i => `${displayRate(`W${i}`, `W${i}·Ybₑ`)}: Ybₑ + ${transferPairs[i - 1][0]} → Ybᵍ + ${transferPairs[i - 1][1]}`),
                ...(visibleProcesses.has('k21') ? [`${displayRate('k21', 'k₂₁')}: Tm₂ → Tm₁`] : []),
                ...(visibleProcesses.has('k35') ? [`${displayRate('k35', 'k₃₅')}: Tm₃ → Tm₅`] : [])
            ] },
            { title: 'Selected emission branch', color: colors.radiative, items: emissionEdges.filter(edge => visibleProcesses.has(edge.key)).map(edge => `${displayRate(edge.key, edge.key)}: ${edge.from} → ${edge.to} (${edge.nm} nm)`) },
            { title: 'Active concentration pathways', color: colors.cross, items: [
                `${displayRate('WcrG4', 'Wcr,G4')}·Tm₆·Tm₀ → Tm₅ + Tm₁ · Tm=${tmPct}% · ${tmPct > 0.1 ? 'ON' : 'OFF'} (>0.1 mol%)`,
                `${displayRate('WcrH4', 'Wcr,H4')}·Tm₅·Tm₀ → 2 Tm₁ · Tm=${tmPct}% · ${tmPct > 1.0 ? 'ON' : 'OFF'} (>1.0 mol%)`,
                `${displayRate('Wb', 'Wb')}·Tm₅·Ybᵍ → Tm₀ + Ybₑ · Yb=${ybPct}% · ${ybPct > 10.0 ? 'ON' : 'OFF'} (>10 mol%)`
            ] }
        ];
        groups = processItems.filter(group => group.items.length);
        const gate = (id, title, formula, active) =>
            `<div id="${id}" class="energy-reaction${active ? ' is-active' : ''}" style="border-color:${active ? colors.cross : '#cbd5e1'};opacity:${active ? 1 : 0.6}"><b>${title} · ${active ? 'ON' : 'OFF'}</b><span>${formula}</span></div>`;
        reactionRows = [
            gate('diagramGateCrG4', 'Wcr,G4', 'Tm₆ (¹G₄) + Tm₀ (³H₆) → Tm₅ (³H₄) + Tm₁ (³F₄) · Tm > 0.1 mol%', tmPct > 0.1),
            gate('diagramGateCrH4', 'Wcr,H4', 'Tm₅ (³H₄) + Tm₀ (³H₆) → 2 Tm₁ (³F₄) · Tm > 1.0 mol%', tmPct > 1.0),
            gate('diagramGateBackTransfer', 'Wb', 'Tm₅ (³H₄) + Ybᵍ → Tm₀ (³H₆) + Ybₑ · Yb > 10 mol%', ybPct > 10.0)
        ];
        svg = `<text x="135" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="#334155">Yb³⁺ sensitizer</text>
            <text x="340" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="#334155">Tm³⁺ activator</text>
            <text x="7" y="52" font-size="8" fill="#64748b">Energy (cm⁻¹)</text>
            <path d="M45 348 L45 65" stroke="#94a3b8" stroke-width="1" marker-end="url(#energyArrowrelaxation)"/>
            ${energyAxisMarkup}
            ${ybLevels.map(level => `<line x1="75" y1="${level.y}" x2="190" y2="${level.y}" stroke="#475569" stroke-width="2.5"/><text x="68" y="${level.y + 4}" text-anchor="end" font-size="9" fill="#334155">${level.label}</text><text x="201" y="${level.y + 3}" font-size="7" fill="#64748b">${level.energy.toLocaleString('en-US')}</text>`).join('')}
            ${ybTransferMarkup}
            ${levelLines(ucLevels, 245, 350, 430)}
            ${transition(ybById.Ybg, ybById.Ybe, 78, 'pump', true, false, 'Rₚ')}
            ${transition(ybById.Ybe, ybById.Ybg, 174, 'relaxation', true, false, 'Aᵧ')}
            ${transferMarkup}
            ${k21Path}${k35Path}${emissionMarkup}${crossMarkup}`;
    }

    const groupHtml = groups.map(group =>
        `<section class="energy-process-group"><h4 style="border-left-color:${group.color}">${group.title}</h4>${group.items.map(item => `<div>${item}</div>`).join('')}</section>`
    ).join('');
    const title = `${emission} nm · ${singleTmMode ? 'direct Tm³⁺ excitation' : 'Yb³⁺/Tm³⁺'} ODE energy-level diagram`;
    const lineLegend = `<div class="energy-line-legend" aria-label="Transition line legend">
        <span><i class="energy-line-swatch is-pump"></i>Excitation</span>
        <span><i class="energy-line-swatch is-transfer"></i>Energy transfer</span>
        <span><i class="energy-line-swatch is-relaxation"></i>Non-radiative relaxation</span>
        <span><i class="energy-line-swatch is-feed"></i>Radiative feeding</span>
        <span><i class="energy-line-swatch is-radiative"></i>Emission</span>
        <span><i class="energy-line-swatch is-cross"></i>Cross-relaxation</span>
        <span><i class="energy-line-swatch is-quench"></i>Back-transfer / quenching</span>
    </div>`;
    const routeExcitation = singleTmMode ? resolveSingleTmExcitation() : null;
    const selectedRoute = singleTmMode
        ? (routeExcitation?.key
            ? `${routeExcitation.key} nm excitation → ${SINGLE_TM_LEVEL_LABEL[routeExcitation.entry]}${routeExcitation.esa ? ` → ESA ${SINGLE_TM_LEVEL_LABEL[routeExcitation.esa]}` : ''} → ${emission} nm emission`
            : `Selected Tm excitation → ${emission} nm emission`)
        : (() => {
            const route = ETUC_CHANNEL_ROUTES[String(emission)];
            const start = route?.startLevel === 'Tm0'
                ? 'Tm starts at ³H₆'
                : `Residual Tm starts at ${ENERGY_LEVEL_NAMES[route?.startLevel] || 'the selected level'}`;
            const transfers = route?.transfers.map(index => `W${index}`).join(' → ') || 'no transfer';
            return `${start} · Yb 980 nm → ${transfers} → ${emission} nm emission`;
        })();
    const applicationExamples = {
        '1800': 'NIR: optical sensing and short-range optical communications (material-dependent).',
        '775': 'NIR: fluorescence bioimaging and optical sensing research.',
        '477': 'Blue: display phosphors, optical tagging, and fluorescence excitation.',
        '645': 'Red: display phosphors, optical tagging, and fluorescence imaging research.',
        '362': 'UV: UV fluorescence spectroscopy and photonic-material characterization.',
        '452': 'Blue-violet: fluorescence analysis and display-phosphor research.',
        '345': 'UV-A: fluorescence spectroscopy and UV photonic-material studies.'
    };
    const applicationText = applicationExamples[String(emission)];
    const simulationSteps = [];
    if (singleTmMode) {
        const excitation = resolveSingleTmExcitation();
        const emittingLevel = SINGLE_TM_EMISSION_LEVEL[String(emission)];
        const emissionTargets = {
            '1800': 'H6', '775': 'H6', '477': 'H6', '645': 'F4',
            '362': 'H6', '454': 'F4', '452': 'F4', '345': 'F4', '346': 'F4'
        };
        const singleEmissionRates = {
            '1800': 'A₁₀', '775': 'A₃₀', '477': 'A₅₀', '645': 'A₅₁',
            '362': 'A₆₀', '454': 'A₆₁', '452': 'A₆₁', '345': 'A₇₁', '346': 'A₇₁'
        };
        if (excitation && emittingLevel && SINGLE_TM_LEVEL_LABEL[emittingLevel] && singleTmCascadeReachable(excitation, emission)) {
            simulationSteps.push({
                kind: 'pump',
                title: `Excite Tm³⁺: ³H₆ → ${SINGLE_TM_LEVEL_LABEL[excitation.entry]}`,
                detail: `${excitation.key} nm pump`,
                ion: 'tm', fromLevel: 'H6', toLevel: excitation.entry
            });
            if (excitation.esa) {
                simulationSteps.push({
                    kind: 'transfer',
                    title: `Excited-state absorption: ${SINGLE_TM_LEVEL_LABEL[excitation.entry]} → ${SINGLE_TM_LEVEL_LABEL[excitation.esa]}`,
                    detail: 'A second pump photon promotes the same Tm ion',
                    ion: 'tm', fromLevel: excitation.entry, toLevel: excitation.esa
                });
            }
            const startLevel = excitation.esa && SINGLE_TM_CASCADE.indexOf(excitation.esa) < SINGLE_TM_CASCADE.indexOf(excitation.entry)
                ? excitation.esa
                : excitation.entry;
            const startIndex = SINGLE_TM_CASCADE.indexOf(startLevel);
            const endIndex = SINGLE_TM_CASCADE.indexOf(emittingLevel);
            if (startIndex >= 0 && endIndex >= startIndex) {
                let ybBranchIndex = 0;
                const addYbTransfer = level => {
                    if (ybPct <= 0 || !['H4', 'G4'].includes(level)) return;
                    simulationSteps.push({
                        kind: 'back-transfer',
                        title: `Competing Tm→Yb transfer · Kyb from ${SINGLE_TM_LEVEL_LABEL[level]}`,
                        detail: `Yb = ${ybPct} mol%; the ODE models this as an effective Tm loss from ${SINGLE_TM_LEVEL_LABEL[level]} to ³H₆, without explicit Yb kinetics.`,
                        ion: 'tm', donorIndex: ybBranchIndex++ % displayedYbCount,
                        fromLevel: level, toLevel: 'H6',
                        donorFromLevel: 'Ybg', donorToLevel: 'Ybe'
                    });
                };
                addYbTransfer(startLevel);
                for (let i = startIndex; i < endIndex; i += 1) {
                    const from = SINGLE_TM_CASCADE[i];
                    const to = SINGLE_TM_CASCADE[i + 1];
                    simulationSteps.push({
                        kind: 'relax',
                        title: `Relax: ${SINGLE_TM_LEVEL_LABEL[from]} → ${SINGLE_TM_LEVEL_LABEL[to]}`,
                        detail: 'Cascade feeding toward the selected emission level',
                        ion: 'tm', fromLevel: from, toLevel: to
                    });
                    addYbTransfer(to);
                }
                simulationSteps.push({
                    kind: 'emit',
                    title: `Emit ${emission} nm: ${SINGLE_TM_LEVEL_LABEL[emittingLevel]} → ${emissionTargets[String(emission)] === 'H6' ? '³H₆' : SINGLE_TM_LEVEL_LABEL[emissionTargets[String(emission)]]}`,
                    detail: 'Radiative transition; photon shown as a burst',
                    ion: 'tm', fromLevel: emittingLevel, toLevel: emissionTargets[String(emission)],
                    emissionRate: singleEmissionRates[String(emission)]
                });
            }
        }
    } else {
        const route = ETUC_CHANNEL_ROUTES[String(emission)];
        const emissionEdges = {
            '1800': ['Tm1', 'Tm0'], '775': ['Tm5', 'Tm0'], '477': ['Tm6', 'Tm0'],
            '645': ['Tm6', 'Tm1'], '362': ['Tm7', 'Tm0'], '452': ['Tm7', 'Tm1'],
            '345': ['Tm8', 'Tm1']
        };
        if (route && emissionEdges[String(emission)]) {
            const addH4Branches = () => {
                if (tmPct > 1) {
                    simulationSteps.push({
                        kind: 'cross-relax',
                        title: 'Tm cross-relaxation Wcr,H4: Tm ³H₄* + Tm ³H₆ → 2 Tm ³F₄',
                        detail: `Tm = ${tmPct} mol%; the excited and ground-state ions form a competing branch`,
                        ion: 'tm', fromLevel: 'Tm5', toLevel: 'Tm1',
                        partnerFromLevel: 'Tm0', partnerToLevel: 'Tm1'
                    });
                }
                if (ybPct > 10) {
                    const donorIndex = route.transfers.length % displayedYbCount;
                    simulationSteps.push({
                        kind: 'back-transfer',
                        title: 'Competing Wb branch at Tm ³H₄: Tm + Ybᵍ → Tm ³H₆ + Ybᵉ',
                        detail: `Yb = ${ybPct} mol%; the smaller Tm marker indicates qualitative depletion, not a fitted population fraction`,
                        ion: 'tm', donorIndex, fromLevel: 'Tm5', toLevel: 'Tm0',
                        donorFromLevel: 'Ybg', donorToLevel: 'Ybe'
                    });
                    simulationSteps.push({
                        kind: 'yb-relax',
                        title: 'Yb relaxes: ²F₅/₂ → ²F₇/₂ (Aᵧ)',
                        detail: 'The back-transferred Yb excitation decays; the surviving Tm ³H₄ population continues',
                        ion: 'yb', donorIndex, fromLevel: 'Ybe', toLevel: 'Ybg'
                    });
                }
            };
            const addG4Branch = () => {
                if (tmPct > 0.1) {
                    simulationSteps.push({
                        kind: 'cross-relax',
                        title: 'Tm cross-relaxation Wcr,G4: Tm ¹G₄* + Tm ³H₆ → Tm ³H₄ + Tm ³F₄',
                        detail: `Tm = ${tmPct} mol%; the excited and ground-state ions form a competing branch`,
                        ion: 'tm', fromLevel: 'Tm6', toLevel: 'Tm5',
                        partnerFromLevel: 'Tm0', partnerToLevel: 'Tm1'
                    });
                }
            };
            if (route.startLevel === 'Tm5') addH4Branches();
            if (route.startLevel === 'Tm6') addG4Branch();
            route.transfers.forEach(index => {
                const [from, to] = ETUC_TRANSFER_PAIRS[index - 1];
                const donorIndex = (index - 1) % displayedYbCount;
                simulationSteps.push({
                    kind: 'pump',
                    title: `Excite Yb³⁺ before ETU step ${index}: ²F₇/₂ → ²F₅/₂`,
                    detail: 'A pump photon excites this Yb donor before energy transfer',
                    ion: 'yb', donorIndex, fromLevel: 'Ybg', toLevel: 'Ybe'
                });
                simulationSteps.push({
                    kind: 'transfer',
                    title: `Energy transfer W${index}: Yb* + Tm ${ENERGY_LEVEL_NAMES[from]} → Yb + Tm ${ENERGY_LEVEL_NAMES[to]}`,
                    detail: 'Dipole–dipole interaction transfers energy to the indicated Tm state; Yb returns to ²F₇/₂',
                    ion: 'tm', fromLevel: from, toLevel: to,
                    donorIndex, donorFromLevel: 'Ybe', donorToLevel: 'Ybg'
                });
                if (index === 1) {
                    simulationSteps.push({
                        kind: 'relax',
                        title: 'Relax: Tm ³H₅ → ³F₄ (k₂₁)',
                        detail: 'The first transferred excitation cascades to ³F₄',
                        ion: 'tm', fromLevel: 'Tm2', toLevel: 'Tm1'
                    });
                } else if (index === 2) {
                    simulationSteps.push({
                        kind: 'relax',
                        title: 'Relax: Tm ³F₂,₃ → ³H₄ (k₃₅)',
                        detail: 'The next transferred excitation cascades to ³H₄',
                        ion: 'tm', fromLevel: 'Tm3', toLevel: 'Tm5'
                    });
                }
                if (index === 2 || to === 'Tm5') addH4Branches();
                if (to === 'Tm6') addG4Branch();
            });
            const [from, to] = emissionEdges[String(emission)];
            const emissionRates = {
                '1800': 'A10', '775': 'A50', '477': 'A60', '645': 'A61',
                '362': 'A70', '452': 'A71', '345': 'A81'
            };
            simulationSteps.push({
                kind: 'emit',
                title: `Emit ${emission} nm: Tm ${ENERGY_LEVEL_NAMES[from]} → ${ENERGY_LEVEL_NAMES[to]}`,
                detail: 'Radiative transition; photon shown as a burst',
                ion: 'tm', fromLevel: from, toLevel: to, emissionRate: emissionRates[String(emission)]
            });
        }
    }
    const simulationLevelY = singleTmMode
        ? Object.fromEntries([...stLevels, ...ybLevels].map(level => [level.id, level.y]))
        : Object.fromEntries([...ucLevels, ...ybLevels].map(level => [level.id, level.y]));
    const tmIonX = singleTmMode ? 215 : 285;
    const initialTmState = singleTmMode
        ? 'H6'
        : ETUC_CHANNEL_ROUTES[String(emission)]?.startLevel || 'Tm0';
    const initialTmY = simulationLevelY[initialTmState] ?? ENERGY_AXIS_BOTTOM;
    const initialTmClass = !singleTmMode && initialTmState !== 'Tm0' ? 'is-excited' : 'is-ground';
    simulationSteps.forEach(step => {
        step.fromY = simulationLevelY[step.fromLevel] ?? 340;
        step.toY = simulationLevelY[step.toLevel] ?? step.fromY;
        step.donorFromY = simulationLevelY[step.donorFromLevel] ?? null;
        step.donorToY = simulationLevelY[step.donorToLevel] ?? null;
        step.partnerFromY = simulationLevelY[step.partnerFromLevel] ?? null;
        step.partnerToY = simulationLevelY[step.partnerToLevel] ?? null;
    });
    const simulationOverlay = simulationSteps.length ? `
        <g id="energySimulationOverlay" class="energy-simulation-overlay" aria-hidden="true">
            <path id="energySimTransferInteraction" class="energy-sim-interaction" marker-end="url(#energyArrowtransfer)" visibility="hidden"/>
            <text id="energySimInteractionLabel" class="energy-sim-interaction-label" visibility="hidden">dipole–dipole transfer</text>
            ${Array.from({ length: displayedYbCount }, (_, index) => {
                const x = ybDonorX(index);
                const id = index === 0 ? 'energySimYb' : `energySimYb${index}`;
                return `<g id="${id}" class="energy-sim-particle energy-sim-particle--yb" data-ground-x="${x}" data-radius="${ybMarkerRadius}" transform="translate(${x} 340)" visibility="${singleTmMode && ybPct <= 0 ? 'hidden' : 'visible'}">
                    <circle r="${ybMarkerRadius}"/>
                    <path class="energy-sim-yb-excited-sector" d="M0 0 L0 ${-ybMarkerRadius} A${ybMarkerRadius} ${ybMarkerRadius} 0 0 1 0 ${ybMarkerRadius} Z"/>
                    <text text-anchor="middle" y="2">Yb</text>
                </g>`;
            }).join('')}
            <text class="energy-sim-yb-label" x="145" y="365" text-anchor="middle" visibility="${singleTmMode && ybPct <= 0 ? 'hidden' : 'visible'}">Yb · ${ybPct}%</text>
            <g id="energySimTm" class="energy-sim-particle energy-sim-particle--tm ${initialTmClass}" transform="translate(${tmIonX} ${initialTmY})">
                <circle r="9"/><text text-anchor="middle" y="3">Tm</text>
            </g>
            <g id="energySimTmBackTransfer" class="energy-sim-particle energy-sim-particle--tm energy-sim-particle--branch" transform="translate(${tmIonX + 24} 340)" visibility="hidden">
                <circle r="7"/><text text-anchor="middle" y="2">Tm</text>
            </g>
            <g id="energySimTmPartner" class="energy-sim-particle energy-sim-particle--tm" transform="translate(${tmIonX + 25} 340)" visibility="hidden">
                <circle r="8"/><text text-anchor="middle" y="3">Tm</text>
            </g>
            <text class="energy-sim-branch-label" x="${tmIonX + 28}" y="360" text-anchor="middle" visibility="hidden">competing branch</text>
            <text id="energySimPhoton" class="energy-sim-photon" x="${tmIonX + 20}" y="200" visibility="hidden">✦</text>
        </g>` : '';
    const runEmissionOptions = (singleTmMode ? Object.keys(singleEmissionMap) : Object.keys(ETUC_CHANNEL_ROUTES))
        .map(wavelength => `<option value="${wavelength}"${String(emission) === wavelength ? ' selected' : ''}>${wavelength} nm</option>`)
        .join('');
    const suggestedPhotonCount = Number.isFinite(measuredPhotonOrder)
        ? Math.max(1, Math.round(measuredPhotonOrder))
        : Math.max(1, singleTmMode
            ? simulationSteps.filter(step => step.kind === 'pump' || step.kind === 'transfer').length
            : (ETUC_CHANNEL_ROUTES[String(emission)]?.transfers.length || 0));
    const etucTransferCount = singleTmMode ? null : (ETUC_CHANNEL_ROUTES[String(emission)]?.transfers.length || 0);
    const photonEstimateSummary = singleTmMode
        ? `Approximate pump photon count: ${suggestedPhotonCount}`
        : `Power-law estimate: approximately ${suggestedPhotonCount} absorbed photon${suggestedPhotonCount === 1 ? '' : 's'} · ETUC pathway: ${etucTransferCount} donor transfer${etucTransferCount === 1 ? '' : 's'}`;
    diagram.innerHTML = `<div class="energy-diagram-heading"><div class="energy-diagram-title">${title}</div>
            <div class="energy-run-controls">
                <label>Emission <select class="energy-run-emission" aria-label="Emission wavelength for transfer simulation">${runEmissionOptions}</select></label>
                <button type="button" class="energy-play-button" aria-pressed="false"${simulationSteps.length ? '' : ' disabled'}>▶ Run transfer · ${emission} nm</button>
            </div>
        </div>
        ${unsupportedReferenceChannel ? '<div class="energy-model-warning">1230 nm appears in the selector and reference ODE, but it is not a radiative channel in the active Yb/Tm fitting ODE. This view marks ³H₅ only; it does not imply the fitter models 1230 nm emission.</div>' : ''}
        ${unsupportedSelectedEmission ? '<div class="energy-model-warning">The selected emission has no matching observation branch in the fitted single-Tm ODE.</div>' : ''}
        ${unreachableSingleEmission ? '<div class="energy-model-warning">The selected single-Tm excitation cannot populate this emission level. Choose a supported excitation/emission pair to simulate the route.</div>' : ''}
        ${fitPairUnsupported ? '<div class="energy-model-warning">This energy-level path is shown for illustration, but this excitation/emission pairing is not in the fitter’s allowed combinations.</div>' : ''}
        ${channelMismatch ? `<div class="energy-model-warning">${channelMismatch}</div>` : ''}
        <div class="energy-diagram-layout">
            <div class="energy-svg-wrap">
                <svg class="energy-level-svg" viewBox="0 0 580 390" role="img" aria-label="${title}" style="display:block;width:100%;height:auto;font-family:Arial,sans-serif">
                <defs>${markerDefs}</defs>${svg}${simulationOverlay}
                <text x="255" y="380" text-anchor="middle" font-size="8" fill="#64748b">Representative YF₃:Tm³⁺ energies (cm⁻¹); higher terms are approximate.</text>
                </svg>
                <div class="energy-state-legend" aria-label="Ion state color legend">
                    <span><i class="energy-state-swatch is-tm-ground"></i>Tm ground</span><span><i class="energy-state-swatch is-tm-excited"></i>Tm excited</span>
                    ${singleTmMode && ybPct <= 0 ? '' : '<span><i class="energy-state-swatch is-yb-ground"></i>Yb ground</span><span><i class="energy-state-swatch is-yb-excited"></i>Yb excited</span>'}
                </div>
                <output class="energy-run-status" aria-live="polite">Ready to run ${emission} nm · ${photonEstimateSummary}</output>
            </div>
            <aside class="energy-process-key"><h3>Selected emission route</h3><p class="energy-selected-route">${selectedRoute}</p>
                <h3>Processes and transitions</h3>${lineLegend}${groupHtml}${applicationText ? `<section class="energy-application"><strong>Example application</strong><span>${applicationText}</span></section>` : ''}</aside>
        </div>
        ${timingSummary}
        <div class="energy-reaction-list"><h3>${singleTmMode ? 'Concentration-dependent terms in the direct-Tm ODE' : 'Cross-relaxation and concentration gates'}</h3>${reactionRows.join('')}</div>`;
    const playButton = diagram.querySelector('.energy-play-button');
    playButton?.addEventListener('click', () => {
        if (energySimulationTimer) {
            clearInterval(energySimulationTimer);
            energySimulationTimer = null;
            diagram.classList.remove('is-playing');
            playButton.setAttribute('aria-pressed', 'false');
            playButton.textContent = `▶ Run transfer · ${emission} nm`;
            return;
        }
        if (!simulationSteps.length) return;
        diagram.classList.add('is-playing');
        playButton.setAttribute('aria-pressed', 'true');
        playButton.textContent = 'Ⅱ Pause transfer';
        const overlay = diagram.querySelector('#energySimulationOverlay');
        const ybParticles = [...diagram.querySelectorAll('.energy-sim-particle--yb')];
        const tmParticle = diagram.querySelector('#energySimTm');
        const backTransferTmParticle = diagram.querySelector('#energySimTmBackTransfer');
        const partnerParticle = diagram.querySelector('#energySimTmPartner');
        const interaction = diagram.querySelector('#energySimTransferInteraction');
        const interactionLabel = diagram.querySelector('#energySimInteractionLabel');
        const photon = diagram.querySelector('#energySimPhoton');
        const branchLabel = diagram.querySelector('.energy-sim-branch-label');
        const radiativeTransitions = [...diagram.querySelectorAll('.energy-transition--radiative')];
        const status = diagram.querySelector('.energy-run-status');
        let survivingTmScale = 1;
        const setIonPosition = (particle, x, y, scale = 1) => {
            if (particle && Number.isFinite(y)) particle.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
        };
        const setTmState = (particle, excited) => {
            particle?.classList.toggle('is-excited', excited);
            particle?.classList.toggle('is-ground', !excited);
        };
        const setYbState = (particle, excited) => {
            particle?.classList.toggle('is-excited', excited);
            particle?.classList.toggle('is-ground', !excited);
        };
        const donorForStep = step => ybParticles[step.donorIndex || 0] || ybParticles[0];
        const setInteraction = (step, donor, reverse = false) => {
            if (!interaction || !interactionLabel || !donor) return;
            interaction.classList.toggle('is-back-transfer', reverse);
            const donorX = Number(donor.dataset.groundX);
            const donorRadius = Number(donor.dataset.radius);
            const sourceX = reverse ? tmIonX - 9 : donorX + donorRadius;
            const targetX = reverse ? donorX + donorRadius : tmIonX - 9;
            const sourceY = reverse ? step.fromY : step.donorFromY;
            const targetY = reverse ? step.donorFromY : step.toY;
            const bendY = (sourceY + targetY) / 2 - (reverse ? -18 : 18);
            interaction.setAttribute('d', `M${sourceX} ${sourceY} Q${(sourceX + targetX) / 2} ${bendY} ${targetX} ${targetY}`);
            interaction.setAttribute('visibility', 'visible');
            interaction.classList.add('is-active');
            interactionLabel.setAttribute('x', String((sourceX + targetX) / 2));
            interactionLabel.setAttribute('y', String(bendY - 4));
            interactionLabel.textContent = reverse
                ? (singleTmMode ? 'Tm→Yb transfer Kyb' : 'back-transfer Wb')
                : 'dipole–dipole transfer';
            interactionLabel.setAttribute('visibility', 'visible');
        };
        const runStep = index => {
            const step = simulationSteps[index];
            if (!step) {
                clearInterval(energySimulationTimer);
                energySimulationTimer = null;
                diagram.classList.remove('is-playing');
                playButton.setAttribute('aria-pressed', 'false');
                playButton.textContent = `↻ Run transfer · ${emission} nm`;
                status.classList.add('is-complete');
                status.textContent = `${emission} nm emission reached · ${photonEstimateSummary}.`;
                return;
            }
            status.classList.remove('is-complete');
            overlay?.classList.add('is-active');
            const donor = donorForStep(step);
            if (donor && (step.ion === 'yb' || step.donorFromY != null)) donor.setAttribute('visibility', 'visible');
            ybParticles.forEach(particle => {
                particle.classList.remove('is-energy-transfer');
                if (!(step.kind === 'transfer' && particle === donor)) setYbState(particle, false);
            });
            partnerParticle?.setAttribute('visibility', step.partnerFromY != null ? 'visible' : 'hidden');
            branchLabel?.setAttribute('visibility', step.kind === 'cross-relax' ? 'visible' : 'hidden');
            photon?.setAttribute('visibility', step.kind === 'emit' ? 'visible' : 'hidden');
            radiativeTransitions.forEach(path => path.classList.remove('is-emitting'));
            interaction?.setAttribute('visibility', 'hidden');
            interaction?.classList.remove('is-active');
            interactionLabel?.setAttribute('visibility', 'hidden');
            const tmScale = step.kind === 'back-transfer' ? backTransferVisualScale : survivingTmScale;
            if (step.kind === 'cross-relax') {
                backTransferTmParticle?.setAttribute('visibility', 'visible');
                setIonPosition(backTransferTmParticle, tmIonX + 24, step.fromY);
                setTmState(backTransferTmParticle, true);
                setTmState(partnerParticle, false);
                setIonPosition(partnerParticle, tmIonX + 38, step.partnerFromY);
                backTransferTmParticle?.getBoundingClientRect();
                setTmState(partnerParticle, true);
                setIonPosition(backTransferTmParticle, tmIonX + 24, step.toY);
                setIonPosition(partnerParticle, tmIonX + 38, step.partnerToY);
            } else if (step.kind === 'back-transfer') {
                survivingTmScale = backTransferVisualScale;
                if (tmParticle) setIonPosition(tmParticle, tmIonX, step.fromY, survivingTmScale);
                backTransferTmParticle?.setAttribute('visibility', 'visible');
                setIonPosition(backTransferTmParticle, tmIonX + 24, step.fromY);
                backTransferTmParticle?.getBoundingClientRect();
                setTmState(backTransferTmParticle, false);
                setIonPosition(backTransferTmParticle, tmIonX + 24, step.toY, backTransferVisualScale);
                donor?.classList.add('is-energy-transfer', 'is-excited');
                setYbState(donor, true);
                setIonPosition(donor, Number(donor?.dataset.groundX), step.donorToY);
                setInteraction(step, donor, true);
            } else if (step.kind === 'yb-relax') {
                setIonPosition(donor, Number(donor?.dataset.groundX), step.toY);
                setYbState(donor, false);
            } else if (step.kind === 'pump' && step.ion === 'yb') {
                setIonPosition(donor, Number(donor?.dataset.groundX), step.toY);
                setYbState(donor, true);
            } else if (step.kind === 'transfer') {
                if (step.ion !== 'yb') setIonPosition(tmParticle, tmIonX, step.toY, survivingTmScale);
                if (step.ion !== 'yb') setTmState(tmParticle, step.toY < 340);
                if (donor && step.donorToY != null) {
                    donor.classList.add('is-energy-transfer', 'is-excited');
                    if (!singleTmMode && step.donorFromY != null) setInteraction(step, donor);
                    setIonPosition(donor, Number(donor.dataset.groundX), step.donorToY);
                    setYbState(donor, false);
                }
            } else if (step.ion !== 'yb') {
                setIonPosition(tmParticle, tmIonX, step.toY, tmScale);
                setTmState(tmParticle, step.toY < 340);
            } else {
                setIonPosition(donor, Number(donor?.dataset.groundX), step.toY);
                setYbState(donor, step.toY < 340);
            }
            if (step.partnerToY != null) setIonPosition(partnerParticle, tmIonX + 25, step.partnerToY);
            if (step.kind === 'emit') {
                if (photon) photon.setAttribute('y', String(step.toY - 8));
                if (step.emissionRate) {
                    radiativeTransitions.find(path => path.dataset.rateLabel.startsWith(step.emissionRate))?.classList.add('is-emitting');
                }
            }
            status.textContent = `${step.title} · step ${index + 1} of ${simulationSteps.length}`;
        };
        let activeIndex = 0;
        overlay?.classList.add('is-active');
        ybParticles.forEach(particle => {
            setIonPosition(particle, Number(particle.dataset.groundX), 340);
            setYbState(particle, false);
        });
        setIonPosition(tmParticle, tmIonX, initialTmY);
        setTmState(tmParticle, initialTmClass === 'is-excited');
        setIonPosition(backTransferTmParticle, tmIonX + 24, 340);
        setTmState(backTransferTmParticle, false);
        backTransferTmParticle?.setAttribute('visibility', 'hidden');
        setTmState(partnerParticle, false);
        partnerParticle?.classList.remove('is-excited');
        partnerParticle?.classList.add('is-ground');
        survivingTmScale = 1;
        partnerParticle?.setAttribute('visibility', 'hidden');
        photon?.setAttribute('visibility', 'hidden');
        runStep(activeIndex++);
        energySimulationTimer = setInterval(() => {
            if (activeIndex >= simulationSteps.length) {
                runStep(activeIndex);
                return;
            }
            runStep(activeIndex++);
        }, 3000);
    });
    diagram.querySelector('.energy-run-emission')?.addEventListener('change', event => {
        const emissionSelect = safeGetElement('emissionSelect');
        if (!emissionSelect) return;
        emissionSelect.value = event.target.value;
        window.updateActivePhysics();
    });
}

window.updateActivePhysics = function() {
    const emission = safeGetElement('emissionSelect')?.value;
    if (!emission) return;
    const singleTmMode = isSingleTmMode();
    const tmPct = parseFloat(safeGetElement('dopingTmInput')?.value || '0') || 0;
    const ybPct = parseFloat(safeGetElement('dopingYbInput')?.value || '0') || 0;
    updateEnergyDiagram(
        tmPct,
        ybPct,
        String(emission),
        singleTmMode,
        Boolean(emission)
    );
    const odeElement = safeGetElement('math-ode');
    if (typeof MathJax !== 'undefined' && odeElement && MathJax.typesetClear) {
        MathJax.typesetClear([odeElement]);
    }
    if (singleTmMode) {
        updateSingleTmContext();
        const excSel = resolveSingleTmExcitation();
        const lvlSel = SINGLE_TM_EMISSION_LEVEL[emission];
        const stSel = (excSel && lvlSel) ? odeDatabaseSingleTm[String(excSel.key)]?.states[SINGLE_TM_TMKEY[lvlSel]] : null;
        safeSetText('math-ode', stSel ? '$$' + stSel.latex + '$$' : '$$\\text{Emission not populated by this excitation}$$');
        safeSetHtml('pop-logic', stSel ? stSel.population.map(t => '• ' + t).join('<br>') : '');
        safeSetHtml('depop-logic', stSel ? stSel.depopulation.map(t => '• ' + t).join('<br>') : '');
        typesetActiveOde();
        return;
    }
    const odeData = odeDatabase[emission];
    if (!odeData) return;

    let activeOdeData = odeData;
    if (String(emission) === '775') {
        const population = [...odeData.population];
        const depopulation = [...odeData.depopulation];
        const positiveTerms = ["k_{35} \\cdot Tm_3"];
        const negativeTerms = ["A_{50} \\cdot Tm_5", "W_3 \\cdot Yb_e \\cdot Tm_5"];
        let tm3Equation = "\\frac{dTm_3}{dt} &= W_2 \\cdot Yb_e \\cdot Tm_1 - k_{35} \\cdot Tm_3";
        population.unshift("W₂ · Ybₑ · Tm₁ feeds Tm₃ (³F₂,₃); k₃₅ transfers Tm₃ into Tm₅ (³H₄)");
        if (tmPct > 0.1) {
            positiveTerms.push("W_{cr,G4} \\cdot Tm_6 \\cdot Tm_0");
            population.push("Wcr,G4 · Tm₆ · Tm₀ (¹G₄ cross-relaxation; Tm > 0.1 mol%)");
        }
        if (tmPct > 1.0) {
            negativeTerms.push("W_{cr,H4} \\cdot Tm_5 \\cdot Tm_0");
            depopulation.push("Wcr,H4 · Tm₅ · Tm₀ (³H₄ cross-relaxation; Tm > 1.0 mol%)");
        }
        if (ybPct > 10.0) {
            negativeTerms.push("W_b \\cdot Tm_5 \\cdot Yb_g");
            depopulation.push("Wb · Tm₅ · Yb_g (back transfer; Yb > 10 mol%)");
        }
        const latex = "\\begin{aligned}" + tm3Equation +
            " \\\\ \\frac{dTm_5}{dt} &= " + positiveTerms.join(" + ") +
            " \\\\ &\\quad" + negativeTerms.map(term => " - " + term).join("") +
            "\\end{aligned}";
        activeOdeData = { latex, population, depopulation };
    }

    safeSetText('math-ode', '$$' + activeOdeData.latex + '$$');
    safeSetHtml('pop-logic', activeOdeData.population.map(t => '• ' + t).join('<br>'));
    safeSetHtml('depop-logic', activeOdeData.depopulation.map(t => '• ' + t).join('<br>'));

    typesetActiveOde();
};

function typesetActiveOde() {
    const equation = safeGetElement('math-ode');
    if (typeof MathJax === 'undefined' || !equation) return;
    MathJax.typesetPromise([equation])
        .catch(err => console.log('MathJax error:', err));
}

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
    if (isSingleTmMode()) updateSingleTmOdeDisplay();
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
    if (isSingleTmMode()) {
        const excSel = resolveSingleTmExcitation();
        const seq = [];
        Object.entries(slotState || {}).forEach(([slotId, item]) => {
            if (!item?.data || !item.emission || !singleTmReachable(excSel, item.emission)) return;
            if (seq.some(s => s.emission === item.emission)) return;
            seq.push({ emission: item.emission, slotId, fileName: item.fileName, data: item.data,
                       sourceEmission: item.emission });
        });
        seq.sort((a, b) => SINGLE_TM_CASCADE.indexOf(SINGLE_TM_EMISSION_LEVEL[a.emission])
                         - SINGLE_TM_CASCADE.indexOf(SINGLE_TM_EMISSION_LEVEL[b.emission]));
        if (!seq.length) throw new Error('Load at least one emission that this excitation can populate.');
        return seq;
    }
    const emissionToSlot = {};
    Object.entries(slotState || {}).forEach(([slotId, item]) => {
        if (item && item.data && item.emission && !emissionToSlot[item.emission]) {
            emissionToSlot[item.emission] = { slotId, ...item };
        }
    });

    const supportedEmissions = new Set(MULTI_CHANNEL_ORDER);
    const unsupportedEmissions = Object.keys(emissionToSlot).filter(emission => !supportedEmissions.has(emission));
    if (unsupportedEmissions.length) {
        showStatus('warning', `No co-doped ODE fit is available for ${unsupportedEmissions.join(', ')} nm; those traces will be skipped.`);
    }

    const sequence = [];
    for (const emission of MULTI_CHANNEL_ORDER) {
        const entry = emissionToSlot[emission];
        if (entry) {
            sequence.push({
                emission,
                slotId: entry.slotId,
                fileName: entry.fileName,
                displayName: entry.displayName || entry.fileName,
                data: entry.data,
                sourceEmission: emission,
            });
        }
    }

    if (!sequence.length) {
        const detail = unsupportedEmissions.length
            ? ` No co-doped ODE fit is available for ${unsupportedEmissions.join(', ')} nm.`
            : '';
        throw new Error(`Upload at least one supported emission file before fitting.${detail}`);
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
    // kept for backward compatibility with older payload code; the single-Tm fit reads the Data/Sample tabs
    return { excitation_nm: parseInt(document.getElementById('excitationWavelength')?.value || '0', 10) };
}

// ===== SINGLE-DOPED Tm HELPERS (only used when Material Model = Single-doped Tm) =====
const SINGLE_TM_EXCITATIONS = {
  260: {entry:'P2'}, 356: {entry:'D2'}, 466: {entry:'G4'},
  785: {entry:'H4', esa:'G4'}, 690: {entry:'H4', esa:'D2'}, 1210: {entry:'H4', esa:'G4'},
};
const SINGLE_TM_EMISSION_LEVEL = {'346':'I6','345':'I6','362':'D2','454':'D2','452':'D2','477':'G4','645':'G4','775':'H4','1800':'F4'};
const SINGLE_TM_CASCADE = ['P2','I6','D2','G4','H4','F4'];
const SINGLE_TM_LEVEL_LABEL = {P2:'³P₂', I6:'¹I₆', D2:'¹D₂', G4:'¹G₄', H4:'³H₄', F4:'³F₄'};
const SINGLE_TM_TMKEY = {P2:'Tm8', I6:'Tm7', D2:'Tm6', G4:'Tm5', H4:'Tm3', F4:'Tm1'};
const SINGLE_TM_STATE_LABEL = {Tm0:'Tm₀', Tm1:'Tm₁', Tm3:'Tm₃', Tm5:'Tm₅', Tm6:'Tm₆', Tm7:'Tm₇', Tm8:'Tm₈'};
const SINGLE_TM_EXTRA_EMISSIONS = [
  { value: '454', label: '454 nm - ¹D₂ → ³F₄' },
  { value: '346', label: '346 nm - ¹I₆ → ³F₄' },
];
const SINGLE_TM_PRIORS = {
  A10:0.12, A30:0.35, A31:0.25, A50:0.6, A51:0.5, A53:0.05, A60:1.0, A61:3.0, A63:0.3,
  A70:3.0, A71:4.0, W87:500, W76:1.0, W65:0.5, Kcr:2.0, Kyb:0.5,
};

function isSingleTmMode() {
  return (document.getElementById('materialModelSelect')?.value || '').toLowerCase() === 'single_doped_tm';
}

// True for any downshifting run (single-doped Tm or co-doped Yb/Tm); both use the Tm ODE engine.
function isDownshiftFlow() {
  return isSingleTmMode() ||
    (document.getElementById('luminescenceTypeSelect')?.value || '').toLowerCase() === 'downshifting';
}

// Emissions offered per excitation. Other excitations fall back to level reachability.
const SINGLE_TM_ALLOWED_EMISSIONS = { 260: ['346'], 356: ['454', '775'], 466: ['645'] };

// ETUC / other modes see exactly the original emission list; single-doped mode gets 454 and 346 added.
function getEmissionOptionsForMode() {
  return isSingleTmMode() ? EMISSION_OPTIONS.concat(SINGLE_TM_EXTRA_EMISSIONS) : EMISSION_OPTIONS;
}

function syncSingleTmEmissionOptions(on) {
  const sel = document.getElementById('emissionSelect');
  if (!sel) return;
  SINGLE_TM_EXTRA_EMISSIONS.forEach(opt => {
    const existing = Array.from(sel.options).find(o => o.value === opt.value && o.dataset.singleTm === '1');
    if (on && !existing && !Array.from(sel.options).some(o => o.value === opt.value)) {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label; o.dataset.singleTm = '1';
      sel.appendChild(o);
    }
    if (!on && existing) {
      if (sel.value === opt.value) sel.value = '';
      existing.remove();
    }
  });
}

function resolveSingleTmExcitation() {
  const nm = parseFloat(document.getElementById('excitationWavelength')?.value);
  if (!Number.isFinite(nm)) return null;
  let best = null;
  Object.keys(SINGLE_TM_EXCITATIONS).forEach(k => {
    if (Math.abs(k - nm) <= 10 && (best === null || Math.abs(k - nm) < Math.abs(best - nm))) best = Number(k);
  });
  return best === null ? null : { key: best, ...SINGLE_TM_EXCITATIONS[best] };
}

function singleTmReachable(exc, emission) {
  if (!singleTmCascadeReachable(exc, emission)) return false;
  const allowed = SINGLE_TM_ALLOWED_EMISSIONS[exc.key];
  return !allowed || allowed.includes(String(emission));
}

function singleTmCascadeReachable(exc, emission) {
  const lvl = SINGLE_TM_EMISSION_LEVEL[String(emission)];
  if (!exc || !lvl) return false;
  const top = Math.min(SINGLE_TM_CASCADE.indexOf(exc.entry),
                       exc.esa ? SINGLE_TM_CASCADE.indexOf(exc.esa) : 99);
  return SINGLE_TM_CASCADE.indexOf(lvl) >= top;
}

function collectSingleTmPriors() {
  const out = {};
  Object.keys(SINGLE_TM_PRIORS).forEach(k => {
    const v = parseFloat(document.getElementById('stp_' + k)?.value);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  });
  return out;
}

function singleTmImplementedEquation(stateKey, excitation, ybPct) {
  const pumpEntry = SINGLE_TM_TMKEY[excitation.entry];
  const esaEntry = excitation.esa ? SINGLE_TM_TMKEY[excitation.esa] : null;
  const pump = stateKey === pumpEntry ? ' + G(t) \\cdot Tm_0' : '';
  const esaIn = stateKey === esaEntry ? ' + G_2 \\cdot Tm_3' : '';
  const esaOut = esaEntry && stateKey === 'Tm3' ? ' - G_2 \\cdot Tm_3' : '';
  const ybLoss = ybPct > 0 ? ' + K_{yb} [Yb]' : '';
  const ybGroundReturn = ybPct > 0 ? ' + K_{yb} [Yb](Tm_3 + Tm_5)' : '';
  const equations = {
    Tm0: `\\frac{dTm_0}{dt} = A_{10}Tm_1 + A_{30}Tm_3 + A_{50}Tm_5 + A_{60}Tm_6 + A_{70}Tm_7${ybGroundReturn} - r_1 - r_2 - G(t)Tm_0`,
    Tm1: '\\frac{dTm_1}{dt} = A_{31}Tm_3 + A_{51}Tm_5 + A_{61}Tm_6 + A_{71}Tm_7 - A_{10}Tm_1 + 2r_1 + r_2',
    Tm3: `\\frac{dTm_3}{dt} = A_{53}Tm_5 + A_{63}Tm_6 - (A_{30} + A_{31}${ybLoss})Tm_3 - r_1${pump}${esaOut}`,
    Tm5: `\\frac{dTm_5}{dt} = W_{65}Tm_6 - (A_{50} + A_{51} + A_{53}${ybLoss})Tm_5 + r_2${pump}${esaIn}`,
    Tm6: `\\frac{dTm_6}{dt} = W_{76}Tm_7 - (A_{60} + A_{61} + A_{63} + W_{65})Tm_6 - r_2${pump}${esaIn}`,
    Tm7: '\\frac{dTm_7}{dt} = W_{87}Tm_8 - (A_{70} + A_{71} + W_{76})Tm_7',
    Tm8: `\\frac{dTm_8}{dt} = -W_{87}Tm_8${pump}`
  };
  return equations[stateKey] || null;
}

// Extra fields merged into the /fit payload. Returns {} outside single-doped mode (ETUC payload unchanged).
function singleTmPayloadExtras(transferEnabled) {
  if (!isDownshiftFlow()) return {};
  return {
    doping_yb: parseFloat(document.getElementById('dopingYbInput')?.value) || 0,
    single_tm_prior: collectSingleTmPriors(),
    single_tm_lock_G: transferEnabled ? (window.singleTmCarry?.G ?? null) : null,
  };
}

function renderSingleTmPriorGrid() {
  const host = document.getElementById('singleTmPriorGrid');
  if (!host || host.dataset.ready) return;
  host.dataset.ready = '1';
  host.innerHTML = Object.entries(SINGLE_TM_PRIORS).map(([k, v]) => `
    <div><label style="font-size:9px;color:#6b7280;">${k}</label>
    <input type="number" id="stp_${k}" value="${v}" step="any" min="0"
      style="width:100%;padding:5px;border-radius:4px;border:1px solid #d1d5db;font-size:11px;"></div>`).join('');
}

window.updateSingleTmContext = function() {
  const el = document.getElementById('singleTmContext');
  const exc = resolveSingleTmExcitation();
  const tm = document.getElementById('dopingTmInput')?.value || '–';
  const yb = parseFloat(document.getElementById('dopingYbInput')?.value) || 0;
  const emSel = document.getElementById('emissionSelect');
  if (emSel) Array.from(emSel.options).forEach(o => {
    if (o.value) o.disabled = isSingleTmMode() && exc ? !singleTmReachable(exc, o.value) : false;
  });
  if (!el) return;
  if (!exc) {
    el.innerHTML = '<span style="color:#b91c1c;">Excitation not supported (±10 nm of 260, 356, 466, 690, 785 or 1210 nm). For 980 nm Yb-sensitised data switch Material Model to Co-doped Yb/Tm.</span>';
    return;
  }
  const entryKey = SINGLE_TM_TMKEY[exc.entry];
  const emission = emSel?.value;
  const bad = emission && !singleTmReachable(exc, emission);
  el.innerHTML = `Excitation <b>${exc.key} nm</b> enters <b>${SINGLE_TM_STATE_LABEL[entryKey]} (${SINGLE_TM_LEVEL_LABEL[exc.entry]})</b>`
    + (exc.esa ? ` (ESA → ${SINGLE_TM_LEVEL_LABEL[exc.esa]})` : '')
    + ` | Tm <b>${tm}</b> mol%`
    + ` | Yb <b>${yb > 0 ? yb + ' mol% (effective Tm→Yb loss)' : '0 (none)'}</b>`
    + (bad ? '<br><span style="color:#b91c1c;">Selected emission is not populated by this excitation.</span>' : '');
};

// Called by the existing applyMechanismSubPanel() for single-doped mode, so it also fills the rest of the panel.
window.updateSingleTmOdeDisplay = function() {
  renderSingleTmPriorGrid();
  updateSingleTmContext();
  const exc = resolveSingleTmExcitation();
  const eqDiv = document.getElementById('singleTmOdeEquations');
  const emDiv = document.getElementById('singleTmEmissions');
  if (!eqDiv) return;
  const db = exc ? odeDatabaseSingleTm[String(exc.key)] : null;
  if (!db) {
    eqDiv.innerHTML = exc || (!isDownshiftFlow() && document.getElementById('excitationWavelength')?.value)
      ? '<span style="color:#b91c1c;font-size:10px;">No ODE set for this excitation wavelength.</span>'
      : '<span style="color:#475569;font-size:10px;">Select an excitation for a file to show its ODE set.</span>';
    return;
  }
  let html = `<div style="position:sticky;top:0;z-index:1;padding:4px 0 6px;background:#fff;font-size:10px;font-weight:700;color:#4338ca;margin-bottom:4px;">Direct-Tm ODE · Tm₃ = ³H₄ · direct-model state labels</div>`
    + `<div style="font-size:10px;font-weight:700;color:#4338ca;margin-bottom:4px;">${db.excitation_label}</div>`
    + `<div style="font-size:9px;color:#475569;margin-bottom:6px;line-height:1.3;">${db.description}</div>`;
  // Only levels from the excitation entry down to the emitting level shape the measured trace; the rest are collapsed.
  const emNm = String(window.singleTmActiveEmission || document.getElementById('emissionSelect')?.value || '');
  const emLvl = SINGLE_TM_EMISSION_LEVEL[emNm];
  const casc = SINGLE_TM_CASCADE;
  const top = Math.min(casc.indexOf(exc.entry), exc.esa ? casc.indexOf(exc.esa) : 99);
  const relKeys = new Set();
  if (emLvl) casc.forEach((l, i) => { if (i >= top && i <= casc.indexOf(emLvl)) relKeys.add(SINGLE_TM_TMKEY[l]); });
  const ybPct = parseFloat(document.getElementById('dopingYbInput')?.value || '0') || 0;
  const tmPct = parseFloat(document.getElementById('dopingTmInput')?.value || '0') || 0;
  const stateForDisplay = (key, st) => ({
    ...st,
    latex: singleTmImplementedEquation(key, exc, ybPct) || st.latex
  });
  const card = (key, st) => `<div style="margin-bottom:5px;padding:5px 7px;background:#f8fafc;border-radius:3px;">
      <div style="font-size:10px;font-weight:700;color:#1e293b;line-height:1.5;padding-top:2px;">${SINGLE_TM_STATE_LABEL[key] || key} — ${st.label}</div>
      <div style="font-size:12px;line-height:1.8;padding:2px 0;">\\(${st.latex}\\)</div>
      ${st.observable ? `<div style="font-size:9px;color:#059669;">📍 ${st.observable}</div>` : ''}</div>`;
  const entries = Object.entries(db.states);
  if (relKeys.size) {
    html += `<div style="font-size:9px;color:#059669;margin-bottom:4px;">Pathways that shape the ${emNm} nm trace:</div>`
      + entries.filter(([k]) => relKeys.has(k)).map(([k, s]) => card(k, stateForDisplay(k, s))).join('');
    const rest = entries.filter(([k]) => !relKeys.has(k));
    if (rest.length) html += `<details style="margin-top:4px;"><summary style="font-size:9px;color:#6b7280;cursor:pointer;">Other solved levels (not on the measured emission branch)</summary>`
      + rest.map(([k, s]) => card(k, stateForDisplay(k, s))).join('') + '</details>';
  } else {
    html += entries.map(([k, s]) => card(k, stateForDisplay(k, s))).join('');
  }
  html += `<div style="margin-top:6px;padding-top:5px;border-top:1px solid #e2e8f0;font-size:9px;color:#475569;line-height:1.5;">
    Direct-Tm ODE numbering: Tm₀=³H₆, Tm₁=³F₄, Tm₃=³H₄, Tm₅=¹G₄, Tm₆=¹D₂, Tm₇=¹I₆, Tm₈=³P₂.
    These direct-model indices differ from ETUC indices for some levels; the diagram identifies levels by spectroscopic term and energy.
    r₁=Kcr·[Tm]·Tm₃·Tm₀; r₂=Kcr·[Tm]·Tm₆·Tm₀.${tmPct === 0 ? ' Both cross-relaxation terms are zero at 0% Tm.' : ''}
    ${ybPct > 0 ? `Kyb·[Yb] is the effective Tm→Yb loss on Tm₃ and Tm₅.` : ''}
  </div>`;
  eqDiv.innerHTML = html;
  eqDiv.scrollTop = 0;
  if (emDiv) emDiv.innerHTML = '<strong>Observable emissions:</strong><br>' +
    Object.values(db.states).filter(s => s.observable).map(s => '• ' + s.observable).join('<br>');
  if (window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise([eqDiv]).then(() => { eqDiv.scrollTop = 0; });
  }
};

// Single-doped UI. Called from the top of updateLuminescenceFlowUi(); that function's own code is untouched.
function applySingleTmUi() {
  // remember the Luminescence Family so it can be restored when leaving single-doped mode
  const lumType = document.getElementById('luminescenceTypeSelect');
  if (lumType && !document.body.classList.contains('single-tm-mode')) lumType.dataset.prev = lumType.value;

  document.body.classList.add('single-tm-mode');
  const show = (id, on, shown = '') => { const el = document.getElementById(id); if (el) el.style.display = on ? shown : 'none'; };
  if (lumType) lumType.value = 'downshifting';
  show('upconversionMechanismWrap', false);
  show('ribbonTabPhysics', false);        // phonon / NR / Yb anchors are co-doped concepts
  show('ribbonTabAdvanced', true);        // fit settings are shared with ETUC
  show('ribbonTabMechanism', true);
  show('ribbonTabRunsettings', false);    // simulate / time range / points: not used, this is a fit
  const mechTab = document.getElementById('ribbonTabMechanism');
  if (mechTab) mechTab.textContent = '🔬 Single-Tm Model';
  show('genericDecayTiming', false, 'flex');

  const ybIn = document.getElementById('dopingYbInput');
  if (ybIn) {
    if (ybIn.dataset.originalMin === undefined) ybIn.dataset.originalMin = ybIn.min;
    ybIn.min = '0';
    ybIn.placeholder = '0 (optional)';
    if (ybIn.parentElement) ybIn.parentElement.style.display = '';
  }
  const ybRequired = document.getElementById('ybDopingRequiredMark');
  if (ybRequired) ybRequired.style.display = 'none';
  const tmHelp = document.getElementById('directTmConcentrationHelp');
  if (tmHelp) tmHelp.style.display = 'block';
  const exIn = document.getElementById('excitationWavelength');
  if (exIn) { exIn.dataset.origMin = exIn.dataset.origMin || exIn.min; exIn.dataset.origMax = exIn.dataset.origMax || exIn.max; exIn.min = '200'; exIn.max = '1600'; }

  const active = Array.from(document.querySelectorAll('.ribbon-content')).find(e => e.style.display === 'block');
  if (active && (active.id === 'ribbonContentPhysics' || active.id === 'ribbonContentRunsettings')) showRibbonTab('mechanism');

  const hint = document.getElementById('etucFlowHint');
  if (hint) {
    hint.style.display = 'block';
    hint.style.borderLeftColor = '#10b981'; hint.style.background = '#ecfdf5'; hint.style.color = '#065f46';
    hint.textContent = 'Direct Tm excitation: ODE fit of rise and decay. Yb co-doping is optional; when present, the model includes its effective Tm→Yb loss from ³H₄ and ¹G₄.';
  }
  const fitBtn = document.getElementById('fitDataButton');
  if (fitBtn) fitBtn.textContent = (typeof getActiveUploadMode === 'function' && getActiveUploadMode() === 'multi') ? '⚡ FIT LOADED CHANNELS' : '⚡ FIT DATA';

  syncSingleTmEmissionOptions(true);
  if (typeof renderMultiChannelRows === 'function') renderMultiChannelRows();
  applyMechanismSubPanel(getLuminescenceFlowSelection());
}

// Undo only what applySingleTmUi changed. Returns true if it actually left single-doped mode.
function leaveSingleTmUi() {
  if (!document.body.classList.contains('single-tm-mode')) return false;
  document.body.classList.remove('single-tm-mode');
  const lt = document.getElementById('luminescenceTypeSelect');
  if (lt) lt.value = lt.dataset.prev || 'upconversion';
  const mechTab = document.getElementById('ribbonTabMechanism');
  if (mechTab) mechTab.textContent = '🔧 Mechanism Parameters';
  const g = document.getElementById('genericDecayTiming');
  if (g) g.style.display = 'flex';
  const ybIn = document.getElementById('dopingYbInput');
  if (ybIn?.parentElement) ybIn.parentElement.style.display = '';
  if (ybIn) {
    if (ybIn.dataset.originalMin !== undefined) {
      ybIn.min = ybIn.dataset.originalMin;
      delete ybIn.dataset.originalMin;
    }
    ybIn.placeholder = '10';
  }
  const ybRequired = document.getElementById('ybDopingRequiredMark');
  if (ybRequired) ybRequired.style.display = '';
  const tmHelp = document.getElementById('directTmConcentrationHelp');
  if (tmHelp) tmHelp.style.display = 'none';
  const exIn = document.getElementById('excitationWavelength');
  if (exIn) { if (exIn.dataset.origMin) exIn.min = exIn.dataset.origMin; if (exIn.dataset.origMax) exIn.max = exIn.dataset.origMax; }
  const sel = document.getElementById('emissionSelect');
  if (sel) Array.from(sel.options).forEach(o => { o.disabled = false; });
  syncSingleTmEmissionOptions(false);
  if (typeof renderMultiChannelRows === 'function') renderMultiChannelRows();
  return true;
}

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
    if (isSingleTmMode()) { applySingleTmUi(); return; }
    if (leaveSingleTmUi()) { return window.updateLuminescenceFlowUi(); } const lumTypeSelect = safeGetElement('luminescenceTypeSelect');
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
        time_unit: safeGetElement('timeUnit')?.value || 'ns',
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
            { x: t, y: result.measured_intensity, type: 'scatter', mode: 'lines', name: 'Experimental', line: { color: '#64748b', width: 2 } },
            { x: t, y: result.fitted_intensity, type: 'scatter', mode: 'lines', name: 'Flow Fit', line: { color: EMISSION_TRACE_COLORS[String(selectedEmission)] || '#2563eb', width: 2 } },
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
            line: { color: EMISSION_TRACE_COLORS[String(em)] || '#334155', width: 2 },
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
    if (materialModel === 'single_doped_tm' && dopingYb !== '' && !(parseFloat(dopingYb) >= 0)) missingFields.push('Yb Doping must be zero or greater');
    
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
    
    if (materialModel === 'single_doped_tm') {
        const excSel = resolveSingleTmExcitation();
        if (!excSel) missingFields.push('Supported excitation (260/356/466/690/785/1210 nm)');
        else if (emission && !singleTmReachable(excSel, emission)) missingFields.push(`Emission ${emission} nm is not populated by ${excSel.key} nm`);
    }
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
        doping_yb: (materialModel === 'single_doped_tm') ? (parseFloat(dopingYb) || 0) : parseFloat(dopingYb),        doping_tm: parseFloat(dopingTm),
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
        const activePathways = [
            data.w_cr_g4_active && 'Wcr,G4',
            data.w_cr_h4_active && 'Wcr,H4',
            data.w_b_active && 'Wb',
        ].filter(Boolean);
        statusDiv.textContent = `✓ Configuration complete | Model: ${data.model_selected || 'multilevel_ode'} | Active concentration pathways: ${activePathways.join(', ') || 'none'}`;
        statusDiv.style.color = '#4ade80';
        
        // Show model info in console
        console.log(`📊 Model selected: ${data.model_selected}`);
        console.log(`📊 Regime: ${data.regime}`);
        console.log(`📊 W_ET upper bound: ${data.w_et_upper} ms⁻¹`);
        console.log(`📊 Concentration pathways: ${activePathways.join(', ') || 'none'}`);
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
    continueFitVisible = false;
    const internalRun = Boolean(options.internalRun);
    const fitBtn = safeGetElement('fitDataButton');
    if (!internalRun && (!fitBtn || fitBtn.disabled)) {
        showStatus('error', '✗ Please configure settings first');
        return;
    }

    const flowSelection = getLuminescenceFlowSelection();
    if (!internalRun && !flowSelection.isEtuc && !isSingleTmMode()) {
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
            showStatus('error', '✗ No supported multi-channel emission files are loaded.');
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
        window.fitTransferState = { seeded775: false };
        window.singleTmCarry = null;
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
                if (result.single_tm_params_all) {
                    window.singleTmCarry = { G: result.single_tm_params_all.G };
                    Object.entries(result.single_tm_params_all).forEach(([k, v]) => {
                        const el = document.getElementById('stp_' + k);
                        if (el && Number.isFinite(v)) el.value = Number(v).toPrecision(5);
                    });
                    return;
                }
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
                appendFitLiveLog(`Sequence ${index + 1}/${sequence.length}: ${item.folderName} -> fitting ${item.emission} nm from ${item.displayName}.`);
                const runResult = await window.fitData({
                    internalRun: true,
                    sourceData: item.data,
                    emission: item.emission,
                    fileName: `${item.folderName} | ${item.emission} nm: ${item.displayName}`,
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
                            skipQualitySweep: true,
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
                        const countdownSeconds = needsReview ? 60 : RETRY_COUNTDOWN_SECONDS;
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

                if (!isSingleTmMode() && isFirst775 && finalResult && typeof finalResult.r2 === 'number' && finalResult.r2 < 0.8) {
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

        // `time` is still in the file's unit (ns/us/ms) here, but the time offset, rise window and
        // pulse width it is compared with are all in ms. Convert first.
        const TIME_UNIT_TO_MS = { ns: 1e-6, us: 1e-3, ms: 1.0 };
        const timeToMs = TIME_UNIT_TO_MS[safeGetElement('timeUnit')?.value || 'ns'] ?? 1e-6;
        const timeMs = time.map(t => t * timeToMs);
        const earlyMetrics = estimateEarlyTimeMetrics(timeMs, intensity);

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
            try_best_match: isLongMode && options.skipQualitySweep !== true,
            fit_time_budget_s: Math.max(0, parseFloat(safeGetElement('fitTimeBudgetInput')?.value || '0') || 0),
            optimize_all_points: isLongMode,
            target_r2: targetR2,
            adaptive_max_cycles: adaptiveMaxCycles,
        };
        window.fitTransferState = window.fitTransferState || { seeded775: false };
        const autoTransfer = safeGetElement('autoTransfer775')?.checked !== false;
        const transferEnabled = options.forceNoTransfer === true ? false : autoTransfer;
        const use775Calibration = isDownshiftFlow() ? false : options.force775Calibration === true
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
            ...singleTmPayloadExtras(transferEnabled),
            doping_tm: parseFloat(safeGetElement('dopingTmInput')?.value || '0.5'),
            host: safeGetElement('hostSelect')?.value || 'NaYF4',
            anneal_temp: parseFloat(safeGetElement('annealSelect')?.value || '500'),
            emission: selectedEmission,
            use_775_calibration: use775Calibration,
            peak_window_boost: peakWindowBoost,
            early_rise_boost: earlyRiseBoost,
            ...(options.fitSeedOverride != null ? { fit_seed: Number(options.fitSeedOverride) } : {}),
            ...(options.fitPulseWidthOverride != null ? { fit_pulse_width: Boolean(options.fitPulseWidthOverride) } : {}),
            // Use per-emission tolerances: for the emission being fitted,
            // look up stored values; fall back to DOM inputs for single-channel.
            peak_tolerance: (emissionDefaults[selectedEmission]?.tolerances?.peak)
                ?? (parseFloat(document.getElementById('errPeak')?.value) || 0.01),
            rise_tolerance: (emissionDefaults[selectedEmission]?.tolerances?.rise)
                ?? (parseFloat(document.getElementById('errRise')?.value) || 0.10),
            decay_tolerance: (emissionDefaults[selectedEmission]?.tolerances?.decay)
                ?? (parseFloat(document.getElementById('errDecay')?.value) || 0.10),
            time_unit: safeGetElement('timeUnit')?.value || 'ns',
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
                WcrH4: parseFloat(safeGetElement('lit_WcrH4')?.value || '96.923'),
                WcrG4: parseFloat(safeGetElement('lit_WcrG4')?.value || '5.0'),
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
        const diagramFitResult = { ...fittingResults, emission: String(selectedEmission) };
        window.lastFitResult = diagramFitResult;
        window.multiChannelResults = window.multiChannelResults || {};
        window.multiChannelResults[String(selectedEmission)] = diagramFitResult;
        updateActivePhysics();

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
        const trace1 = { x: time, y: intensity, mode: 'lines', name: 'Experimental', line: { color: '#64748b' } };
        const trace2 = { x: time, y: fittingResults.fitted_intensity, mode: 'lines', name: 'Fit', line: { color: EMISSION_TRACE_COLORS[String(selectedEmission)] || '#2563eb' } };
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
        const timeUnit = tm.time_unit || (safeGetElement('timeUnit')?.value || 'ns');

        if (selectedEmission === '775' && diagnostics.use_775_calibration) {
            window.fitTransferState.seeded775 = true;
        }

        Object.entries(isDownshiftFlow() ? {} : { ...guideParams, ...odeParams }).forEach(([name, value]) => {
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
            <div class="result-item"><span class="result-label">Pulse-Width Mode:</span> <span class="result-value">${typeof diagnostics.pulse_width_optimized === 'boolean' ? (diagnostics.pulse_width_optimized ? 'Optimized' : 'Fixed at input') : 'N/A'}</span></div>
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
                errorMessage = 'Cannot connect to backend. Make sure Flask server is running on port 5050. Then click CONTINUE FIT to retry.';
                continueFitVisible = true;
                setFitStoppedState(true);
                resultsErrorHtml = `
                    <div style="border:1px solid #fee2e2; background:#fff1f2; color:#991b1b; border-radius:10px; padding:12px; margin:10px 0; text-align:center;">
                        <strong>Connection failed:</strong> Flask backend is unreachable.
                        <div style="margin-top:8px; font-size:13px; opacity:0.9;">Start the server on port 5050 and click CONTINUE FIT to retry.</div>
                    </div>
                `;
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
    lines.push(`# TIMING METRICS  (time unit: ${ps?.time_unit || 'ns'})`);
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
            'Run#', 'File', 'Deposited At', 'Best Fit',
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
                dep.isBestFit ? 'Yes' : 'No',
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

        const paramsHeader = ['Run#', 'File', 'Emission (nm)', 'Best Fit', 'R²', ...paramKeys];
        const paramsRows   = [paramsHeader];
        plotDeposits.forEach((dep, idx) => {
            const ps   = dep.payloadSummary  || {};
            const odeP = dep.ode_parameters  || {};
            const row  = [
                idx + 1,
                dep.fileName || '',
                ps.emission  || '',
                dep.isBestFit ? 'Yes' : 'No',
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
    setVal('timeUnit', 'ns');
    setVal('pulseWidthUs', '400');
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
    window.singleTmCarry = null;
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

const SIM_EMISSION_COLORS = EMISSION_TRACE_COLORS;

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

function renderSimEquationPanel(data, emissions, spacing, ybPct, tmPct) {
    const panel = safeGetElement('simEquationPanel');
    if (!panel) return;
    const inf = data?.influence_model || {};
    const ems = (emissions || []).join(', ');
    const pathways = [];
    if (tmPct > 0.1) pathways.push('Wcr,G4');
    if (tmPct > 1.0) pathways.push('Wcr,H4');
    if (ybPct > 10.0) pathways.push('Wb');
    const crG4Feed = tmPct > 0.1 ? ' + Wcr,G4·Tm6·Tm0' : '';
    const crH4 = tmPct > 1.0 ? ' - Wcr,H4·Tm5·Tm0' : '';
    const backTransfer = ybPct > 10.0;
    const btYb = backTransfer ? ' + Wb·Tm5·Yb_g' : '';
    const btH4 = backTransfer ? ' - Wb·Tm5·Yb_g' : '';
    const crG4Ground = tmPct > 0.1 ? ' - Wcr,G4·Tm6·Tm0' : '';
    const crH4Ground = tmPct > 1.0 ? ' - Wcr,H4·Tm5·Tm0' : '';
    const crProduct = `${tmPct > 1.0 ? ' + 2·Wcr,H4·Tm5·Tm0' : ''}${tmPct > 0.1 ? ' + Wcr,G4·Tm6·Tm0' : ''}`;
    const crG4Depop = tmPct > 0.1 ? ' - Wcr,G4·Tm6·Tm0' : '';
    panel.style.display = '';
    panel.innerHTML = `
        <div style="font-weight:700; color:#0f172a; margin-bottom:6px;">Equations used in this simulation (ODE model)</div>
        <div style="font-family:'Courier New',monospace; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">
            dYb_e/dt = R_p·Yb_g - A_y·Yb_e - Yb_e·(W1·Tm0 + W2·Tm1 + W3·Tm5 + W4·Tm6 + W5·Tm7)${btYb}<br>
            dTm0/dt = A10·Tm1 + A50·Tm5 + A60·Tm6 + A70·Tm7 - W1·Yb_e·Tm0${crH4Ground}${crG4Ground}${backTransfer ? ' + Wb·Tm5·Yb_g' : ''}<br>
            dTm1/dt = k21·Tm2 + A61·Tm6 + A71·Tm7 + A81·Tm8 - A10·Tm1 - W2·Yb_e·Tm1${crProduct}<br>
            dTm3/dt = W2·Yb_e·Tm1 - k35·Tm3<br>
            dTm5/dt = k35·Tm3${crG4Feed} - A50·Tm5 - W3·Yb_e·Tm5${crH4}${btH4}<br>
            dTm6/dt = W3·Yb_e·Tm5 - (A60 + A61)·Tm6 - W4·Yb_e·Tm6${crG4Depop}<br>
            dTm7/dt = W4·Yb_e·Tm6 - (A70 + A71)·Tm7 - W5·Yb_e·Tm7<br>
            dTm8/dt = W5·Yb_e·Tm7 - A81·Tm8
        </div>
        <div style="font-size:11px; color:#334155; line-height:1.5;">
            <strong>Active concentration-gated pathways:</strong> ${pathways.join(', ') || 'none'} (Tm=${Number(tmPct || 0).toFixed(3)} mol%, Yb=${Number(ybPct || 0).toFixed(3)} mol%).<br>
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
    const pulse   = parseFloat(safeGetElement('simPulse')?.value || '400');
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
        renderSimEquationPanel(data, emissions, traceSpacing, yb, tm);
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
        pulse_us: parseFloat(safeGetElement('estPulse')?.value || '400'),
        host_material: hostMaterial,
        annealing_c: annealingC,
        phonon_energy_cm: phononEnergy,
        host_mole_factor: hostMoleFactor,
        optimize_kinetics: optimizeKinetics,
        iterative_rounds: parseInt(safeGetElement('estIterRounds')?.value || '2', 10),
        de_maxiter: parseInt(safeGetElement('estDEMaxIter')?.value || '40', 10),
        kinetics_to_optimize: ['W1', 'W2', 'W3', 'k21', 'k35', 'WcrH4', 'WcrG4', 'Wb', 'A50', 'A60', 'A61'],
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
    ['dopingTmInput', 'dopingYbInput'].forEach(id =>
        document.getElementById(id)?.addEventListener('input', updateActivePhysics));
    updateActivePhysics();
});

// ===== Downshifting batch queue (merged from downshift_batch.js) =====
// Downshifting batch queue (single-doped Tm and co-doped Yb/Tm).
// Each uploaded file carries its own Data File inputs (time unit, emission, excitation, pulse width)
// and Sample Composition (Yb, Tm, host, annealing). Files are fitted one after another through the
// existing fitData() pipeline. Nothing here is active for the upconversion / downconversion flows.
(function () {
  'use strict';

  const EXC_CHOICES = [260, 356, 466, 690, 785, 1210];
  const EXC_TOL_NM = 10;
  const HOSTS = [['NaYF4', 'β-NaYF₄'], ['YF3', 'YF₃'], ['GdF3', 'GdF₃'], ['Y2O3', 'Y₂O₃'], ['YLF', 'YLF'], ['YAG', 'YAG']];
  const EM_LABEL = {
    '346': '346 nm (¹I₆→³F₄)', '362': '362 nm (¹D₂→³H₆)', '454': '454 nm (¹D₂→³F₄)',
    '477': '477 nm (¹G₄→³H₆)', '645': '645 nm (¹G₄→³F₄)', '775': '775 nm (³H₄→³H₆)', '1800': '1800 nm (³F₄→³H₆)',
  };
  const HIDDEN_FIELD_IDS = ['timeUnit', 'emissionSelect', 'excitationWavelength', 'pulseWidthUs'];

  let rows = [];
  let nextId = 1;
  let running = false;
  let cancelled = false;
  let active = false;

  const $ = (id) => document.getElementById(id);
  const isCoDoped = () => !isSingleTmMode();

  // ---------- helpers ----------
  function snapExcitation(nm) {
    nm = parseFloat(nm);
    if (!Number.isFinite(nm)) return null;
    let best = null;
    EXC_CHOICES.forEach(k => { if (Math.abs(k - nm) <= EXC_TOL_NM && (best === null || Math.abs(k - nm) < Math.abs(best - nm))) best = k; });
    return best;
  }

  function rowExcitation(r) {
    const raw = r.excSel === 'other' ? r.excOther : r.excSel;
    const key = snapExcitation(raw);
    return { raw: parseFloat(raw), key };
  }

  function emissionChoices(excKey) {
    if (!excKey) return [];
    if (SINGLE_TM_ALLOWED_EMISSIONS[excKey]) return SINGLE_TM_ALLOWED_EMISSIONS[excKey].slice();
    const exc = { key: excKey, ...SINGLE_TM_EXCITATIONS[excKey] };
    return ['346', '362', '454', '477', '645', '775', '1800'].filter(em => singleTmReachable(exc, em));
  }

  function guessFromName(name) {
    const out = {};
    let m = name.match(/Ex[_ ]?(\d{3,4})/i); if (m) out.exc = m[1];
    m = name.match(/Em[_ ]?(\d{3,4})/i); if (m) out.em = m[1];
    m = name.match(/Tm(\d+)(?:[_.](\d+))?/i); if (m) out.tm = m[2] ? `${m[1]}.${m[2]}` : m[1];
    m = name.match(/Yb(\d+)(?:[_.](\d+))?/i); if (m) out.yb = m[2] ? `${m[1]}.${m[2]}` : m[1];
    else if ((m = name.match(/(\d+(?:[_.]\d+)?)\s*Yb/i))) out.yb = m[1].replace('_', '.');
    m = name.match(/(\d{3,4})\s*C(?![a-z])/i); if (m) out.anneal = m[1];
    m = name.match(/NaYF4|YF3|GdF3|Y2O3|YLF|YAG/i);
    if (m) out.host = HOSTS.map(h => h[0]).find(h => h.toLowerCase() === m[0].toLowerCase());
    return out;
  }

  function newRow(file, data) {
    const g = guessFromName(file.name);
    const snapped = g.exc ? snapExcitation(g.exc) : null;
    const r = {
      id: nextId++, name: file.name, data,
      timeUnit: 'ns', pulse: '400', pulseAuto: true, fitPulseWidth: false, tm: g.tm || '', yb: g.yb || '', host: g.host || '', anneal: g.anneal || '',
      excSel: snapped ? String(snapped) : (g.exc ? 'other' : ''), excOther: snapped ? '' : (g.exc || ''),
      emission: '', status: 'Ready', r2: null,
    };
    const choices = emissionChoices(rowExcitation(r).key);
    if (g.em && choices.includes(g.em)) r.emission = g.em;
    else if (choices.length === 1) r.emission = choices[0];
    return r;
  }

  function validate(r) {
    const errs = [];
    const { raw, key } = rowExcitation(r);
    if (!r.timeUnit) errs.push('time unit');
    if (!key) errs.push(Number.isFinite(raw) ? `excitation ${raw} nm is not within ±${EXC_TOL_NM} nm of ${EXC_CHOICES.join('/')} nm` : 'excitation');
    if (!r.emission || (key && !emissionChoices(key).includes(r.emission))) errs.push('emission');
    if (!(parseFloat(r.pulse) > 0)) errs.push('pulse width');
    if (!(parseFloat(r.tm) > 0)) errs.push('Tm %');
    if (isCoDoped() && !(parseFloat(r.yb) >= 0 && r.yb !== '')) errs.push('Yb %');
    if (!isCoDoped() && r.yb !== '' && !(parseFloat(r.yb) >= 0)) errs.push('Yb % must be zero or greater');
    if (!r.host) errs.push('host');
    if (!(parseFloat(r.anneal) >= 0 && r.anneal !== '')) errs.push('annealing');
    return errs;
  }

  // ---------- UI ----------
  function hideEl(el) {
    if (!el) return;
    if (el.dataset.dsPrev === undefined) el.dataset.dsPrev = el.style.display || '';
    el.style.display = 'none';
  }
  function restoreEl(el) {
    if (!el || el.dataset.dsPrev === undefined) return;
    el.style.display = el.dataset.dsPrev;
    delete el.dataset.dsPrev;
  }

  // The Tm ODE / starting-rate panel lives in Advanced Settings while Downshifting is active.
  let tmPanelHome = null;
  function moveTmPanel(toAdvanced) {
    const panel = $('singleDopedTmPanel'), adv = $('ribbonContentAdvanced');
    if (!panel || !adv) return;
    if (toAdvanced) {
      if (!tmPanelHome) tmPanelHome = { parent: panel.parentElement, next: panel.nextSibling };
      if (panel.parentElement !== adv) adv.appendChild(panel);
    } else if (tmPanelHome && panel.parentElement === adv) {
      tmPanelHome.parent.insertBefore(panel, tmPanelHome.next && tmPanelHome.next.parentElement === tmPanelHome.parent ? tmPanelHome.next : null);
    }
  }

  function setBatchLayout(on) {
    const owned = [
      $('uploadModeSingle')?.closest('div'), $('singleUploadControls'), $('multiUploadControls'),
      ...HIDDEN_FIELD_IDS.map(id => $(id)?.parentElement),
      $('applySettingsBtn'), $('fitDataButton'),
    ];
    owned.forEach(on ? hideEl : restoreEl);
    // Tab visibility is otherwise managed by updateLuminescenceFlowUi, which runs before this.
    if (!on) restoreEl($('ribbonTabSample'));
    if (on) {
      hideEl($('ribbonTabSample'));
      ['ribbonTabPhysics', 'ribbonTabRunsettings'].forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
      const adv = $('ribbonTabAdvanced'); if (adv) adv.style.display = '';
      const mech = $('ribbonTabMechanism'); if (mech) mech.style.display = 'none';
      moveTmPanel(true);
      const cur = Array.from(document.querySelectorAll('.ribbon-content')).find(e => e.style.display === 'block');
      if (cur && ['ribbonContentSample', 'ribbonContentPhysics', 'ribbonContentRunsettings'].includes(cur.id)) showRibbonTab('upload');
      else if (cur && cur.id === 'ribbonContentMechanism') showRibbonTab('advanced');
      const hint = $('etucFlowHint');
      if (hint) {
        hint.style.display = 'block';
        hint.style.borderLeftColor = '#10b981'; hint.style.background = '#ecfdf5'; hint.style.color = '#065f46';
        hint.textContent = (isCoDoped() ? 'Co-doped Yb/Tm downshifting' : 'Direct Tm excitation with optional Yb co-doping')
          + ': Tm ODE fit. Upload any number of files; each file has its own data-file inputs and sample composition.';
      }
    }
    if (!on) moveTmPanel(false);
    const panel = $('dsBatchPanel');
    if (panel) panel.style.display = on ? 'block' : 'none';
    const runBtn = $('dsBatchRun');
    if (runBtn) runBtn.style.display = on ? '' : 'none';
    const cfgBtn = $('dsBatchConfig');
    if (cfgBtn) cfgBtn.style.display = on ? '' : 'none';
  }

  function applyMode() {
    const want = isDownshiftFlow();
    if (!want && !active) return;
    if (want && typeof getActiveUploadMode === 'function' && getActiveUploadMode() === 'multi') window.switchUploadMode('single');
    setBatchLayout(want);
    active = want;
    if (want) render();
  }

  function opt(v, label, sel) { return `<option value="${v}"${String(sel) === String(v) ? ' selected' : ''}>${label}</option>`; }

  function render() {
    const host = $('dsBatchRows');
    if (!host) return;
    const co = isCoDoped();
    const inp = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;box-sizing:border-box;min-width:70px;';
    const head = ['File', 'Time unit', 'Excitation (nm)', 'Emission', 'Pulse (µs)', 'Optimize pulse width', co ? 'Yb %' : 'Yb % (optional)', 'Tm %', 'Host', 'Anneal (°C)', 'Status'];
    let html = '<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:12px;width:100%;min-width:1150px;"><thead><tr>'
      + head.map(h => `<th style="text-align:left;padding:4px 6px;border-bottom:2px solid #cbd5e1;color:#374151;white-space:nowrap;">${h}</th>`).join('')
      + '<th></th></tr></thead><tbody>';
    rows.forEach(r => {
      const { raw, key } = rowExcitation(r);
      const ems = emissionChoices(key);
      const errs = validate(r);
      const snapNote = key && Number.isFinite(raw) && raw !== key ? `<div style="font-size:9px;color:#b45309;">→ using ${key} nm</div>` : '';
      const statusColor = r.status.startsWith('✓') ? '#15803d' : (r.status.startsWith('✗') ? '#b91c1c' : '#475569');
      html += `<tr data-id="${r.id}" style="border-bottom:1px solid #e5e7eb;vertical-align:top;">
        <td style="padding:4px 6px;min-width:160px;max-width:220px;word-break:break-all;font-size:11px;">${r.name}</td>
        <td style="padding:4px 6px;"><select data-f="timeUnit" style="${inp}min-width:80px;">${opt('', 'select', r.timeUnit)}${opt('ns', 'ns', r.timeUnit)}${opt('us', 'μs', r.timeUnit)}${opt('ms', 'ms', r.timeUnit)}</select></td>
        <td style="padding:4px 6px;white-space:nowrap;">
          <select data-f="excSel" style="${inp}min-width:90px;">${opt('', 'select', r.excSel)}${EXC_CHOICES.map(e => opt(e, e, r.excSel)).join('')}${opt('other', 'Other…', r.excSel)}</select>
          ${r.excSel === 'other' ? `<input data-f="excOther" type="number" step="any" value="${r.excOther}" placeholder="nm" style="${inp}width:90px;">` : ''}${snapNote}</td>
        <td style="padding:4px 6px;"><select data-f="emission" style="${inp}min-width:170px;">${opt('', ems.length ? 'select' : 'pick excitation', r.emission)}${ems.map(e => opt(e, EM_LABEL[e] || e + ' nm', r.emission)).join('')}</select></td>
        <td style="padding:4px 6px;"><input data-f="pulse" type="number" min="0" step="any" value="${r.pulse}" placeholder="400" style="${inp}width:90px;"></td>
        <td style="padding:4px 6px;text-align:center;"><input data-f="fitPulseWidth" type="checkbox" ${r.fitPulseWidth ? 'checked' : ''} title="Check to let the fitter adjust this pulse width"></td>
        <td style="padding:4px 6px;"><input data-f="yb" type="number" min="0" step="any" value="${r.yb}" placeholder="${co ? '10' : '0'}" style="${inp}width:80px;"></td>
        <td style="padding:4px 6px;"><input data-f="tm" type="number" min="0" step="any" value="${r.tm}" placeholder="0.5" style="${inp}width:80px;"></td>
        <td style="padding:4px 6px;"><select data-f="host" style="${inp}min-width:100px;">${opt('', 'select', r.host)}${HOSTS.map(h => opt(h[0], h[1], r.host)).join('')}</select></td>
        <td style="padding:4px 6px;"><input data-f="anneal" type="number" min="0" step="any" value="${r.anneal}" placeholder="500" style="${inp}width:90px;"></td>
        <td style="padding:4px 6px;color:${statusColor};font-size:10px;">${r.status}${r.r2 != null ? ` (R²=${r.r2.toFixed(5)})` : ''}${errs.length && r.status === 'Ready' ? `<div style="color:#b45309;">needs: ${errs.join(', ')}</div>` : ''}</td>
        <td style="padding:4px 6px;white-space:nowrap;"><button type="button" data-act="preview" style="font-size:10px;">👁</button> <button type="button" data-act="remove" title="Delete this file" style="font-size:10px;color:#b91c1c;">🗑 Delete</button></td></tr>`;
    });
    html += '</tbody></table></div>';
    host.innerHTML = rows.length ? html : '<div style="font-size:11px;color:#6b7280;">No files yet. Click “Add files”.</div>';
    const count = $('dsBatchCount'); if (count) count.textContent = `${rows.length} file(s)`;
    const yb = $('dsBatchModeLabel'); if (yb) yb.textContent = co ? 'Co-doped Yb/Tm' : 'Direct Tm excitation';
    syncOdeView();
  }

  // The Mechanism tab reads #excitationWavelength; in batch mode that field is hidden, so mirror the active row.
  function syncOdeView() {
    if (running || !rows.length) return;
    const r = rows.find(x => x.id === activeId) || rows[0];
    const { key } = rowExcitation(r);
    const el = $('excitationWavelength');
    if (!el || !key) return;
    el.value = String(key);
    window.singleTmActiveEmission = r.emission || '';
    if (r.emission) {
      const sel = $('emissionSelect');
      if (sel) {
        if (!Array.from(sel.options).some(o => o.value === r.emission)) {
          const o = document.createElement('option'); o.value = r.emission; o.textContent = EM_LABEL[r.emission] || r.emission; o.dataset.ds = '1';
          sel.appendChild(o);
        }
        sel.value = r.emission;
      }
    }
    if (typeof updateExcitationEnergy === 'function') updateExcitationEnergy();
    if (typeof updateSingleTmOdeDisplay === 'function') updateSingleTmOdeDisplay();
    if (typeof updateActivePhysics === 'function') updateActivePhysics();
  }

  let activeId = null;

  function onRowChange(e) {
    const el = e.target; const tr = el.closest('tr[data-id]');
    if (!tr || !el.dataset.f) return;
    const r = rows.find(x => x.id === Number(tr.dataset.id)); if (!r) return;
    r[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.f === 'pulse') r.pulseAuto = false;
    activeId = r.id;
    if (el.dataset.f === 'excSel' || el.dataset.f === 'excOther') {
      const ems = emissionChoices(rowExcitation(r).key);
      if (!ems.includes(r.emission)) r.emission = ems.length === 1 ? ems[0] : '';
    }
    r.status = 'Ready'; r.r2 = null;
    setTimeout(render, 0);
  }

  function onRowClick(e) {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const r = rows.find(x => x.id === Number(btn.closest('tr').dataset.id)); if (!r) return;
    if (btn.dataset.act === 'remove') { if (!running) { rows = rows.filter(x => x !== r); render(); } return; }
    activeId = r.id; syncOdeView();
    rawData = r.data;
    safeSetText('analyzerCurrentFile', r.name);
    safeSetText('analyzerFileInfo', `${r.data.time.length} data points`);
    plotRawData();
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        try { resolve(/\.json$/i.test(file.name) ? parseJSONContent(fr.result) : parseCSVContent(fr.result)); }
        catch (err) { reject(err); }
      };
      fr.onerror = () => reject(new Error('read error'));
      fr.readAsText(file);
    });
  }

  async function addFiles(fileList) {
    for (const f of Array.from(fileList)) {
      try {
        const data = await readFile(f);
        if (!data || !data.time || !data.time.length) throw new Error('no data');
        const nr = newRow(f, data);
        rows.push(nr);
        if (!rows.some(x => x.id === activeId)) { activeId = nr.id; setActiveDatasetView(data, f.name, ''); }
      } catch (err) {
        showStatus('error', `✗ ${f.name}: ${err.message}`);
      }
    }
    render();
  }

  // ---------- run ----------
  function writeInputsToDom(r, excKey) {
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('timeUnit', r.timeUnit);
    set('pulseWidthUs', r.pulse);
    set('dopingTmInput', r.tm);
    set('dopingYbInput', r.yb || '0');
    set('hostSelect', r.host);
    set('annealSelect', r.anneal);
    set('excitationWavelength', String(excKey));
    const sel = $('emissionSelect');
    if (sel) {
      if (!Array.from(sel.options).some(o => o.value === r.emission)) {
        const o = document.createElement('option'); o.value = r.emission; o.textContent = EM_LABEL[r.emission] || r.emission; o.dataset.ds = '1';
        sel.appendChild(o);
      }
      sel.value = r.emission;
    }
    if (typeof updateExcitationEnergy === 'function') updateExcitationEnergy();
    if (typeof updateSingleTmOdeDisplay === 'function') updateSingleTmOdeDisplay();
    if (typeof updateActivePhysics === 'function') updateActivePhysics();
  }

  // Run quality = R² minus a penalty for peak/rise-window error, so a run with a better rise can beat a slightly higher R².
  const RISE_PENALTY_WEIGHT = 0.5;
  function runScore(r2, diagnostics) {
    if (!Number.isFinite(r2)) return -Infinity;
    const ta = diagnostics?.tolerance_achieved || {};
    const pen = (Number.isFinite(ta.peak) ? Math.min(1, Math.abs(ta.peak)) : 0) + (Number.isFinite(ta.rise) ? Math.min(1, Math.abs(ta.rise)) : 0);
    return r2 - RISE_PENALTY_WEIGHT * pen;
  }

  // Excitation pulse ≈ onset→peak time of the measured trace (the fitter keeps the pulse fixed, so a wrong default
  // such as 400 µs blunts the rise). Only used while the user has not typed a pulse width for the row.
  function estimatePulseUs(r) {
    const t = r.data?.time, y = r.data?.intensity;
    const f = { ns: 1e-6, us: 1e-3, ms: 1.0 }[r.timeUnit];
    if (!f || !Array.isArray(t) || !Array.isArray(y) || t.length < 8 || y.length !== t.length) return null;
    let pk = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[pk]) pk = i;
    if (!(y[pk] > 0)) return null;
    let on = y.findIndex(v => Number.isFinite(v) && v >= 0.03 * y[pk]);
    if (on < 0 || on > pk) on = 0;
    const us = (t[pk] - t[on]) * f * 1000;
    return Number.isFinite(us) && us > 0 ? Math.max(20, Math.round(us)) : null;
  }

  async function runAll() {
    if (running) return;
    if (!rows.length) { showStatus('error', '✗ Add at least one file'); return; }
    const bad = rows.map(r => ({ r, e: validate(r) })).filter(x => x.e.length);
    if (bad.length) {
      bad.forEach(x => { x.r.status = '✗ missing: ' + x.e.join(', '); });
      render();
      showStatus('error', `✗ ${bad.length} file(s) have missing or unsupported inputs`);
      return;
    }
    running = true; cancelled = false;
    const runButton = $('dsBatchRun');
    runButton.disabled = true;
    runButton.classList.add('is-running');
    setFitUiBusy(true);
    const loader = $('loadingIndicator'); if (loader) loader.style.display = 'block';
    resetFitLiveLog();
    appendFitLiveLog(`Downshifting batch started: ${rows.length} file(s).`);
    try {
      for (let i = 0; i < rows.length; i++) {
        if (cancelled) break;
        const r = rows[i];
        const { key } = rowExcitation(r);
        if (r.pulseAuto) { const pu = estimatePulseUs(r); if (pu) { r.pulse = String(pu); appendFitLiveLog('Pulse width set from measured onset→peak: ' + pu + ' µs.'); } }
        r.status = 'running…'; r.r2 = null; render();
        writeInputsToDom(r, key);
        activeId = r.id;
        setActiveDatasetView(r.data, r.name, r.emission);
        window.singleTmCarry = null;
        appendFitLiveLog(`File ${i + 1}/${rows.length}: ${r.name} | exc ${key} nm | em ${r.emission} nm.`);
        try {
          const baseOpts = { internalRun: true, sourceData: r.data, emission: r.emission, fileName: r.name,
            forceNoTransfer: true, manageUiBusy: false, showLoading: false, resetLiveLog: false,
            fitPulseWidthOverride: r.fitPulseWidth };
          const depStart = plotDeposits.length;
          let res = await window.fitData(baseOpts);
          // Auto-retry (same idea as the ETUC multi-channel sequence, without the countdown): re-fit with
          // jittered peak/early weights and more adaptive cycles, keep the best, stop when solved or stalled.
          const SOLVED_R2 = Math.min(0.998, parseFloat($('targetR2Input')?.value) || 0.998);
          const userMax = parseInt($('maxRetriesInput')?.value, 10);
          const maxRetries = Math.max(1, Math.min(25, Number.isFinite(userMax) ? userMax : 12));
          if (res && typeof res.r2 === 'number' && res.r2 < SOLVED_R2 && !cancelled) {
            let best = res, bestOpts = {}, lastRun = res, stall = 0;
            appendFitLiveLog(`Auto-retry triggered (R²=${res.r2.toFixed(5)} < ${SOLVED_R2}).`);
            for (let a = 1; a <= maxRetries && !cancelled; a++) {
              const bw = { peak: best?.diagnostics?.peak_window_boost || 1.0, early: best?.diagnostics?.early_rise_boost || 1.0 };
              const jit = (v) => Math.min(10, Math.max(1, v * (1 + (Math.random() * 2 - 1) * (0.1 + 0.03 * stall))));
              const opts = { fitModeOverride: 'long', skipQualitySweep: true,
                targetR2Override: SOLVED_R2, adaptiveMaxCyclesOverride: Math.min(50, 8 + a),
                peakWindowBoostOverride: jit(Math.max(1.27, bw.peak)), earlyRiseBoostOverride: jit(Math.max(1.3, bw.early)),
                fitSeedOverride: 42 + 101 * a };
              r.status = `retry ${a}/${maxRetries}…`; render();
              appendFitLiveLog(`─── Retry ${a}/${maxRetries} for ${r.name} (peak w=${opts.peakWindowBoostOverride.toFixed(2)}, early w=${opts.earlyRiseBoostOverride.toFixed(2)}) ───`);
              const rr = await window.fitData({ ...baseOpts, ...opts });
              if (!rr || !Number.isFinite(rr.r2)) { stall++; if (stall >= 3) break; continue; }
              lastRun = rr;
              if (runScore(rr.r2, rr.diagnostics) > runScore(best.r2, best.diagnostics) + 1e-4) { best = rr; bestOpts = opts; stall = 0; appendFitLiveLog(`Retry ${a}: improved to R²=${rr.r2.toFixed(5)} (score ${runScore(rr.r2, rr.diagnostics).toFixed(5)}).`); }
              else { stall++; appendFitLiveLog(`Retry ${a}: R²=${rr.r2.toFixed(5)} (no improvement, best ${best.r2.toFixed(5)}).`); }
              if (best.r2 >= SOLVED_R2) { appendFitLiveLog('Solved criteria reached; stopping retries.'); break; }
              if (stall >= 3) { appendFitLiveLog('No improvement for 3 retries; stopping.'); break; }
            }
            // The plot shows the last run; re-run the best settings if the last run was not the best.
            if (best !== lastRun && !cancelled) {
              try {
                const displayRun = await window.fitData({ ...baseOpts, ...bestOpts });
                if (displayRun && Number.isFinite(displayRun.r2) && runScore(displayRun.r2, displayRun.diagnostics) >= runScore(best.r2, best.diagnostics) - 1e-9) {
                  best = displayRun;
                } else {
                  appendFitLiveLog(`Best-fit display rerun did not match the retained best R²=${best.r2.toFixed(6)}; keeping the original best fit.`);
                }
              } catch (err) {
                appendFitLiveLog(`Best-fit display rerun failed (${err?.message || 'unknown error'}); keeping the original best fit.`);
              }
            }
            res = best;
          }

          // Highlight the best run for this file (green border, like ETUC); ties go to the latest run.
          try {
            let bi = -1, bs = -Infinity;
            for (let di = depStart; di < plotDeposits.length; di++) {
              const dep = plotDeposits[di];
              dep.isBestFit = false;
              const s = runScore(dep.r2, dep.diagnostics);
              if (s >= bs) { bs = s; bi = di; }
            }
            if (bi >= 0) {
              const dep = plotDeposits[bi];
              dep.isBestFit = true;
              const badge = '<div style="margin:8px 0; padding:8px 12px; background:#dcfce7; border:2px solid #16a34a; border-radius:6px; text-align:center; font-size:14px; font-weight:800; color:#166534;">★ BEST FIT ★</div>';
              if (dep.resultsHtml && !dep.resultsHtml.includes('BEST FIT')) dep.resultsHtml = badge + dep.resultsHtml;
              savePlotDeposits();
              activeDepositIndex = bi;
              appendFitLiveLog(`Best fit for ${r.name}: deposit #${bi + 1} (R²=${plotDeposits[bi].r2.toFixed(6)}, peak err=${(plotDeposits[bi].diagnostics?.tolerance_achieved?.peak ?? NaN).toFixed(3)}, rise err=${(plotDeposits[bi].diagnostics?.tolerance_achieved?.rise ?? NaN).toFixed(3)}).`);
              renderDepositList();
              window.openDepositedPlot(bi);
            } else appendFitLiveLog(`Best-fit marking: no deposits found for ${r.name}.`);
          } catch (e) { console.warn('best-fit marking failed', e); appendFitLiveLog(`Best-fit marking failed: ${e?.message || e}`); }
          if (res && typeof res.r2 === 'number') { r.r2 = res.r2; r.status = '✓ done'; }
          else r.status = cancelled ? 'cancelled' : '✗ failed';
        } catch (err) {
          if (err && err.name === 'AbortError') { r.status = 'cancelled'; cancelled = true; }
          else r.status = '✗ ' + (err?.message || 'failed');
        }
        render();
      }
    } finally {
      running = false;
      const loaderEnd = $('loadingIndicator'); if (loaderEnd) loaderEnd.style.display = 'none';
      runButton.disabled = false;
      runButton.classList.remove('is-running');
      setFitUiBusy(false);
      appendFitLiveLog(cancelled ? 'Downshifting batch cancelled.' : 'Downshifting batch finished.');
    }
  }

  // ---------- wiring ----------
  function flashBatchButton(button) {
    button.classList.remove('is-clicked');
    void button.offsetWidth;
    button.classList.add('is-clicked');
    button.addEventListener('animationend', () => button.classList.remove('is-clicked'), { once: true });
  }

  function init() {
    const fileInput = $('dsBatchFileInput');
    $('dsBatchAdd')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => { await addFiles(e.target.files); fileInput.value = ''; });
    $('dsBatchRun')?.addEventListener('click', () => {
      flashBatchButton($('dsBatchRun'));
      runAll();
    });
    $('dsBatchConfig')?.addEventListener('click', () => {
      flashBatchButton($('dsBatchConfig'));
      showRibbonTab('advanced');
    });
    const host = $('dsBatchRows');
    host?.addEventListener('change', onRowChange);
    host?.addEventListener('click', onRowClick);

    const origCancel = window.cancelFitting;
    window.cancelFitting = async function () {
      if (running) cancelled = true;
      return origCancel.apply(this, arguments);
    };

    const origFlow = window.updateLuminescenceFlowUi;
    window.updateLuminescenceFlowUi = function () {
      const out = origFlow.apply(this, arguments);
      applyMode();
      return out;
    };
    applyMode();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
