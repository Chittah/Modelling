'use strict';

const ENERGY_MAX = 40000;
const ENERGY_TOP = 80;
const ENERGY_BOTTOM = 440;
const REFERENCE_LEVEL_ENERGIES = {
    H6: 0,
    F4: 5900,
    H5: 8500,
    H4: 12800,
    F23: 14550,
    G4: 21400,
    D2: 27900,
    I6: 35000,
    P2: 38000
};
const energyToY = energy => ENERGY_BOTTOM - (energy / ENERGY_MAX) * (ENERGY_BOTTOM - ENERGY_TOP);
const energyLabel = energy => `${energy.toLocaleString('en-US')} cm⁻¹`;
const ENERGY_AXIS_MARKUP = Array.from({ length: 5 }, (_, index) => {
    const energy = index * 10000;
    const y = energyToY(energy);
    return `<line x1="64" y1="${y}" x2="680" y2="${y}" stroke="#e2e8f0" stroke-width="1"></line>
        <line x1="58" y1="${y}" x2="64" y2="${y}" stroke="#64748b"></line>
        <text class="energy-axis-label" x="52" y="${y + 4}" text-anchor="end">${energy.toLocaleString('en-US')}</text>`;
}).join('');
const LEVELS = [
    { id: 'Tm0', label: `Tm₀ · ³H₆ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.H6)}`, energy: REFERENCE_LEVEL_ENERGIES.H6 },
    { id: 'Tm1', label: `Tm₁ · ³F₄ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.F4)}`, energy: REFERENCE_LEVEL_ENERGIES.F4 },
    { id: 'Tm2', label: `Tm₂ · ³H₅ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.H5)}`, energy: REFERENCE_LEVEL_ENERGIES.H5 },
    { id: 'Tm3', label: `Tm₃ · ³F₂,₃ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.F23)}`, energy: REFERENCE_LEVEL_ENERGIES.F23 },
    { id: 'Tm5', label: `Tm₅ · ³H₄ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.H4)}`, energy: REFERENCE_LEVEL_ENERGIES.H4 },
    { id: 'Tm6', label: `Tm₆ · ¹G₄ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.G4)}`, energy: REFERENCE_LEVEL_ENERGIES.G4 },
    { id: 'Tm7', label: `Tm₇ · ¹D₂ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.D2)}`, energy: REFERENCE_LEVEL_ENERGIES.D2 },
    { id: 'Tm8', label: `Tm₈ · ¹I₆ · ${energyLabel(REFERENCE_LEVEL_ENERGIES.I6)}`, energy: REFERENCE_LEVEL_ENERGIES.I6 }
].map(level => ({ ...level, y: energyToY(level.energy) }));
const LEVEL_BY_ID = Object.fromEntries(LEVELS.map(level => [level.id, level]));
const TRANSFER_PAIRS = [['Tm0', 'Tm2'], ['Tm1', 'Tm3'], ['Tm5', 'Tm6'], ['Tm6', 'Tm7'], ['Tm7', 'Tm8']];
const CHANNELS = {
    '1800': { transferIndices: [1], startLevel: 'Tm0', emitter: 'Tm1', target: 'Tm0', rate: 'A₁₀' },
    '775': { transferIndices: [1, 2], startLevel: 'Tm0', emitter: 'Tm5', target: 'Tm0', rate: 'A₅₀' },
    '477': { transferIndices: [3], startLevel: 'Tm5', emitter: 'Tm6', target: 'Tm0', rate: 'A₆₀' },
    '645': { transferIndices: [3], startLevel: 'Tm5', emitter: 'Tm6', target: 'Tm1', rate: 'A₆₁' },
    '362': { transferIndices: [4], startLevel: 'Tm6', emitter: 'Tm7', target: 'Tm0', rate: 'A₇₀' },
    '452': { transferIndices: [4], startLevel: 'Tm6', emitter: 'Tm7', target: 'Tm1', rate: 'A₇₁' },
    '345': { transferIndices: [5], startLevel: 'Tm7', emitter: 'Tm8', target: 'Tm1', rate: 'A₈₁' }
};
const SINGLE_TM_LEVELS = [
    { id: 'H6', label: '³H₆ · ground', energy: REFERENCE_LEVEL_ENERGIES.H6 },
    { id: 'F4', label: '³F₄', energy: REFERENCE_LEVEL_ENERGIES.F4 },
    { id: 'H4', label: '³H₄', energy: REFERENCE_LEVEL_ENERGIES.H4 },
    { id: 'G4', label: '¹G₄', energy: REFERENCE_LEVEL_ENERGIES.G4 },
    { id: 'D2', label: '¹D₂', energy: REFERENCE_LEVEL_ENERGIES.D2 },
    { id: 'I6', label: '¹I₆', energy: REFERENCE_LEVEL_ENERGIES.I6 },
    { id: 'P2', label: '³P₂', energy: REFERENCE_LEVEL_ENERGIES.P2 }
].map(level => ({ ...level, y: energyToY(level.energy), label: `${level.label} · ${energyLabel(level.energy)}` }));
const SINGLE_TM_LEVEL_BY_ID = Object.fromEntries(SINGLE_TM_LEVELS.map(level => [level.id, level]));
const SINGLE_TM_CASCADE = ['P2', 'I6', 'D2', 'G4', 'H4', 'F4', 'H6'];
const YB_GROUND_Y = energyToY(0);
const YB_EXCITED_Y = energyToY(10200);
const SINGLE_TM_LEVEL_NAMES = {
    P2: '³P₂', I6: '¹I₆', D2: '¹D₂', G4: '¹G₄', H4: '³H₄', F4: '³F₄', H6: '³H₆'
};
const SINGLE_TM_EXCITATIONS = {
    '260': { entry: 'P2' },
    '356': { entry: 'D2' },
    '466': { entry: 'G4' },
    '690': { entry: 'H4', esa: 'D2' },
    '785': { entry: 'H4', esa: 'G4' },
    '1210': { entry: 'H4', esa: 'G4' }
};
const SINGLE_TM_CHANNELS = {
    '1800': { emitter: 'F4', target: 'H6', rate: 'A₁₀', label: '1800 nm · ³F₄ → ³H₆' },
    '775': { emitter: 'H4', target: 'H6', rate: 'A₃₀', label: '775 nm · ³H₄ → ³H₆' },
    '477': { emitter: 'G4', target: 'H6', rate: 'A₅₀', label: '477 nm · ¹G₄ → ³H₆' },
    '645': { emitter: 'G4', target: 'F4', rate: 'A₅₁', label: '645 nm · ¹G₄ → ³F₄' },
    '362': { emitter: 'D2', target: 'H6', rate: 'A₆₀', label: '362 nm · ¹D₂ → ³H₆' },
    '454': { emitter: 'D2', target: 'F4', rate: 'A₆₁', label: '454 nm · ¹D₂ → ³F₄' },
    '452': { emitter: 'D2', target: 'F4', rate: 'A₆₁', label: '452 nm · ¹D₂ → ³F₄' },
    '345': { emitter: 'I6', target: 'F4', rate: 'A₇₁', label: '345 nm · ¹I₆ → ³F₄' },
    '346': { emitter: 'I6', target: 'F4', rate: 'A₇₁', label: '346 nm · ¹I₆ → ³F₄' }
};
const EMISSION_COLORS = {
    '345': '#7c3aed',
    '346': '#7c3aed',
    '362': '#8b5cf6',
    '452': '#4f46e5',
    '454': '#4f46e5',
    '477': '#2563eb',
    '645': '#dc2626',
    '775': '#7f1d1d',
    '1230': '#9333ea',
    '1800': '#6d28d9'
};
const SINGLE_TM_ALLOWED_EMISSIONS = {
    '260': ['346'],
    '356': ['454', '775'],
    '466': ['645']
};
const MOTION_STEP_DURATION_MS = 3000;
const BRANCH_TRANSITION_DELAY_MS = 700;
const HOST_LABELS = {
    NaYF4: 'β-NaYF₄',
    YF3: 'YF₃',
    GdF3: 'GdF₃',
    Y2O3: 'Y₂O₃',
    YLF: 'YLF',
    YAG: 'YAG'
};
const byId = id => document.getElementById(id);
const diagram = byId('energyDiagram');
let steps = [];
let currentStep = 0;
let timer = null;
let running = false;
let displayedYbCount = 1;
let ybRadius = 16;

function selectedHostLabel() {
    const hostId = byId('hostSelect').value;
    return HOST_LABELS[hostId] || HOST_LABELS.YF3;
}

function ybIonX(index) {
    return displayedYbCount === 1 ? 270 : 185 + index * 42;
}

function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[character]);
}

function ionMarkup(id, kind, label, x, y, radius = 15) {
    return `<g id="${id}" class="motion-ion motion-ion--${kind} is-ground" transform="translate(${x} ${y})">
        <circle r="${radius}"></circle><text y="1">${label}</text>
    </g>`;
}

function transitionMarkup(from, to, x, kind, label = '', levels = LEVEL_BY_ID, extraClass = '') {
    const y1 = levels[from].y;
    const y2 = levels[to].y;
    const yStart = y1 + (y2 < y1 ? -9 : 9);
    const yEnd = y2 + (y2 < y1 ? 9 : -9);
    const curve = kind === 'relax'
        ? `M${x} ${yStart} C${x + 15} ${(yStart + yEnd) / 2} ${x - 10} ${(yStart + yEnd) / 2} ${x} ${yEnd}`
        : `M${x} ${yStart} L${x} ${yEnd}`;
    return `<path class="static-transition is-${kind} ${extraClass}" d="${curve}" marker-end="url(#arrow-${kind})"></path>
        ${label ? `<text class="active-label" x="${x + 7}" y="${(yStart + yEnd) / 2}">${escapeXml(label)}</text>` : ''}`;
}

function singleTmStartLevel(excitation) {
    const entryIndex = SINGLE_TM_CASCADE.indexOf(excitation.entry);
    const esaIndex = excitation.esa ? SINGLE_TM_CASCADE.indexOf(excitation.esa) : entryIndex;
    return SINGLE_TM_CASCADE[Math.min(entryIndex, esaIndex)];
}

function isSingleTmChannelReachable(channel, excitation) {
    return SINGLE_TM_CASCADE.indexOf(channel.emitter) >= SINGLE_TM_CASCADE.indexOf(singleTmStartLevel(excitation));
}

function updateEmissionOptions() {
    const select = byId('emissionSelect');
    const model = byId('modelSelect').value;
    const previousValue = select.value;
    let options;
    if (model === 'single-tm') {
        const excitationNm = byId('excitationSelect').value;
        const excitation = SINGLE_TM_EXCITATIONS[excitationNm];
        const allowed = SINGLE_TM_ALLOWED_EMISSIONS[excitationNm];
        options = Object.entries(SINGLE_TM_CHANNELS)
            .filter(([value, channel]) => isSingleTmChannelReachable(channel, excitation)
                && (!allowed || allowed.includes(value)))
            .map(([value, channel]) => [value, channel.label]);
    } else {
        options = Object.entries(CHANNELS).map(([value, channel]) => [
            value,
            `${value} nm · ${LEVEL_BY_ID[channel.emitter].label.split('· ')[1]} → ${LEVEL_BY_ID[channel.target].label.split('· ')[1]}`
        ]);
    }
    select.replaceChildren(...options.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
    }));
    select.value = options.some(([value]) => value === previousValue)
        ? previousValue
        : options[0][0];
}

function renderDiagram(channel, ybPct, tmPct, singleTmMode, excitation) {
    if (singleTmMode) {
        renderSingleTmDiagram(channel, tmPct, excitation);
        return;
    }
    displayedYbCount = Math.max(1, Math.min(5, Math.ceil(ybPct / 10)));
    ybRadius = 13 + Math.min(ybPct, 50) / 50 * 5;
    const levelLines = LEVELS.map(level => `
        <line class="level-line${level.id === 'Tm0' ? ' is-ground-level' : ''}" x1="500" y1="${level.y}" x2="650" y2="${level.y}"></line>
        <text class="level-label${level.id === 'Tm0' ? ' is-ground-level' : ''}" x="662" y="${level.y + 4}">${level.label}</text>`).join('');
    const transferArrows = channel.transferIndices.map((index, arrowIndex) => {
        const [from, to] = TRANSFER_PAIRS[index - 1];
        return transitionMarkup(from, to, 525 + arrowIndex * 22, 'transfer', `W${index}`);
    }).join('');
    const relaxArrows = [
        channel.transferIndices.includes(1) ? transitionMarkup('Tm2', 'Tm1', 545, 'relax', 'k₂₁') : '',
        channel.transferIndices.includes(2) ? transitionMarkup('Tm3', 'Tm5', 565, 'relax', 'k₃₅') : ''
    ].join('');
    const emissionStart = LEVEL_BY_ID[channel.emitter].y;
    const emissionEnd = LEVEL_BY_ID[channel.target].y;
    const emissionColor = EMISSION_COLORS[byId('emissionSelect').value] || '#059669';
    const emissionPath = `M640 ${emissionStart} C690 ${emissionStart} 700 ${emissionEnd} 640 ${emissionEnd}`;
    const ybIons = Array.from({ length: displayedYbCount }, (_, index) =>
        ionMarkup(`ybIon${index}`, 'yb', 'Yb', ybIonX(index), YB_GROUND_Y, ybRadius)
    ).join('');
    const ybTransferGroups = new Map();
    channel.transferIndices.forEach(transferIndex => {
        const donorIndex = (transferIndex - 1) % displayedYbCount;
        const transferGroup = ybTransferGroups.get(donorIndex) || [];
        transferGroup.push(transferIndex);
        ybTransferGroups.set(donorIndex, transferGroup);
    });
    const ybTransferArrows = [...ybTransferGroups.entries()].map(([donorIndex, transferIndices]) =>
        transitionMarkup('Ybe', 'Ybg', ybIonX(donorIndex), 'transfer',
            transferIndices.map(index => `W${index}`).join(' / '), {
                Ybe: { y: YB_EXCITED_Y }, Ybg: { y: YB_GROUND_Y }
            }, `yb-transfer-path ${transferIndices.map(index => `yb-transfer-w${index}`).join(' ')}`)
    ).join('');
    const ybPumpArrows = [...ybTransferGroups.keys()].map((donorIndex, index) => {
        const x = ybIonX(donorIndex);
        return `<path class="static-transition is-pump yb-pump-path" d="M${x} ${YB_GROUND_Y - 10} L${x} ${YB_EXCITED_Y + 10}" marker-end="url(#arrow-pump)"></path>
            ${index === 0 ? `<text class="active-label" x="${x + 7}" y="${(YB_GROUND_Y + YB_EXCITED_Y) / 2}">Yb pump</text>` : ''}`;
    }).join('');

    diagram.innerHTML = `
        <defs>
            <marker id="arrow-pump" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#7c3aed"></path></marker>
            <marker id="arrow-transfer" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#2563eb"></path></marker>
            <marker id="arrow-relax" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#64748b"></path></marker>
            <marker id="arrow-radiative" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="${emissionColor}"></path></marker>
            <marker id="arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#0e7490"></path></marker>
            <marker id="arrow-cross" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#d97706"></path></marker>
            <marker id="arrow-back" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#d97706"></path></marker>
        </defs>
        <text class="column-label" x="250" y="34" text-anchor="middle">Yb³⁺ sensitizer</text>
        <text class="column-label" x="570" y="34" text-anchor="middle">Tm³⁺ activator</text>
        <text class="energy-axis-label" x="20" y="64">Energy (cm⁻¹)</text>
        <path d="M58 450 L58 68" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow-relax)"></path>
        ${ENERGY_AXIS_MARKUP}
        <line class="level-line is-ground-level" x1="145" y1="${YB_GROUND_Y}" x2="355" y2="${YB_GROUND_Y}"></line>
        <text class="level-label is-ground-level" x="136" y="444" text-anchor="end">Ybᵍ · ²F₇/₂</text>
        <text class="energy-axis-label" x="365" y="444">0</text>
        <line class="level-line" x1="145" y1="${YB_EXCITED_Y}" x2="355" y2="${YB_EXCITED_Y}"></line>
        <text class="level-label" x="136" y="${YB_EXCITED_Y + 4}" text-anchor="end">Ybᵉ · ²F₅/₂</text>
        <text class="energy-axis-label" x="365" y="${YB_EXCITED_Y + 4}">10,200</text>
        ${ybPumpArrows}
        <path d="M345 ${YB_EXCITED_Y + 10} L345 ${YB_GROUND_Y - 10}" fill="none" stroke="#64748b" stroke-width="1.7" marker-end="url(#arrow-relax)"></path>
        <text class="active-label" x="351" y="${(YB_GROUND_Y + YB_EXCITED_Y) / 2 + 14}">Aᵧ</text>
        ${ybTransferArrows}
        ${levelLines}
        ${transferArrows}${relaxArrows}
        <path class="static-transition is-radiative emission-line" style="--emission-color:${emissionColor};stroke:${emissionColor}" d="${emissionPath}" fill="none" marker-end="url(#arrow-radiative)"></path>
        <text class="active-label emission-label" style="--emission-color:${emissionColor}" x="700" y="${(emissionStart + emissionEnd) / 2}" text-anchor="middle">${channel.rate} · emission</text>
        <path id="interactionPath" class="active-motion" d="" visibility="hidden" marker-end="url(#arrow-active)"></path>
        <text id="interactionText" class="active-label" x="410" y="100" text-anchor="middle" visibility="hidden"></text>
        ${ybIons}
        <text class="energy-axis-label" x="270" y="477" text-anchor="middle">Representative Yb ions · ${ybPct}% · schematic count/size</text>
        ${ionMarkup('tmIon', 'tm', 'Tm', 575, YB_GROUND_Y, 17)}
        ${ionMarkup('tmBranchIon', 'tm', 'Tm', 545, YB_GROUND_Y, 14)}
        ${ionMarkup('tmPartnerIon', 'tm', 'Tm', 610, YB_GROUND_Y, 14)}
        <text id="photon" class="photon" style="fill:${emissionColor};--emission-color:${emissionColor}" x="713" y="${emissionStart - 12}">✦</text>
        <text x="410" y="508" text-anchor="middle" fill="#64748b" font-size="10">Selected host: ${escapeXml(selectedHostLabel())} · level values shown use YF₃:Tm³⁺ references (upper levels approximate).</text>`;
}

function renderSingleTmDiagram(channel, tmPct, excitation) {
    const ybPct = Math.max(0, Number(byId('ybConcentration').value) || 0);
    displayedYbCount = ybPct > 0 ? Math.max(1, Math.min(5, Math.ceil(ybPct / 10))) : 0;
    ybRadius = 13 + Math.min(ybPct, 50) / 50 * 5;
    const startLevel = singleTmStartLevel(excitation);
    const startIndex = SINGLE_TM_CASCADE.indexOf(startLevel);
    const emissionIndex = SINGLE_TM_CASCADE.indexOf(channel.emitter);
    const relevantLevels = new Set(SINGLE_TM_CASCADE.slice(startIndex, emissionIndex + 1));
    if (tmPct > 0 && relevantLevels.has('H4')) relevantLevels.add('F4');
    if (tmPct > 0 && relevantLevels.has('D2')) {
        relevantLevels.add('G4');
        relevantLevels.add('F4');
    }
    const levelLines = SINGLE_TM_LEVELS
        .filter(level => relevantLevels.has(level.id) || level.id === channel.target)
        .map(level => `
            <line class="level-line${level.id === 'H6' ? ' is-ground-level' : ''}" x1="500" y1="${level.y}" x2="650" y2="${level.y}"></line>
            <text class="level-label${level.id === 'H6' ? ' is-ground-level' : ''}" x="662" y="${level.y + 4}">${level.label}</text>`).join('');
    const cascadeArrows = SINGLE_TM_CASCADE.slice(startIndex, emissionIndex)
        .map((from, index) => transitionMarkup(from, SINGLE_TM_CASCADE[startIndex + index + 1], 525 + index * 20, 'relax', '', SINGLE_TM_LEVEL_BY_ID))
        .join('');
    const crossArrows = [
        tmPct > 0 && SINGLE_TM_CASCADE.slice(startIndex, emissionIndex + 1).includes('H4')
            ? transitionMarkup('H4', 'F4', 470, 'cross', 'Kcr · Tm–Tm', SINGLE_TM_LEVEL_BY_ID)
            : '',
        tmPct > 0 && SINGLE_TM_CASCADE.slice(startIndex, emissionIndex + 1).includes('D2')
            ? transitionMarkup('D2', 'G4', 450, 'cross', 'Kcr · Tm–Tm', SINGLE_TM_LEVEL_BY_ID)
            : ''
    ].join('');
    const emissionStart = SINGLE_TM_LEVEL_BY_ID[channel.emitter].y;
    const emissionEnd = SINGLE_TM_LEVEL_BY_ID[channel.target].y;
    const emissionColor = EMISSION_COLORS[byId('emissionSelect').value] || '#059669';
    const emissionPath = `M640 ${emissionStart} C690 ${emissionStart} 700 ${emissionEnd} 640 ${emissionEnd}`;
    const ybIons = Array.from({ length: displayedYbCount }, (_, index) =>
        ionMarkup(`ybIon${index}`, 'yb', 'Yb', ybIonX(index), YB_GROUND_Y, ybRadius)
    ).join('');
    const ybLevels = ybPct > 0 ? `
        <text class="column-label" x="250" y="34" text-anchor="middle">Yb³⁺ acceptor</text>
        <line class="level-line is-ground-level" x1="145" y1="${YB_GROUND_Y}" x2="355" y2="${YB_GROUND_Y}"></line>
        <text class="level-label is-ground-level" x="136" y="444" text-anchor="end">Ybᵍ · ²F₇/₂</text>
        <text class="energy-axis-label" x="365" y="444">0</text>
        <line class="level-line" x1="145" y1="${YB_EXCITED_Y}" x2="355" y2="${YB_EXCITED_Y}"></line>
        <text class="level-label" x="136" y="${YB_EXCITED_Y + 4}" text-anchor="end">Ybᵉ · ²F₅/₂</text>
        <text class="energy-axis-label" x="365" y="${YB_EXCITED_Y + 4}">10,200</text>` : '';
    diagram.innerHTML = `
        <defs>
            <marker id="arrow-pump" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#7c3aed"></path></marker>
            <marker id="arrow-transfer" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#2563eb"></path></marker>
            <marker id="arrow-relax" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#64748b"></path></marker>
            <marker id="arrow-radiative" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="${emissionColor}"></path></marker>
            <marker id="arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#0e7490"></path></marker>
            <marker id="arrow-cross" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#d97706"></path></marker>
            <marker id="arrow-back" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#d97706"></path></marker>
        </defs>
        <text class="column-label" x="570" y="34" text-anchor="middle">Direct Tm³⁺ excitation</text>
        <text class="energy-axis-label" x="20" y="64">Energy (cm⁻¹)</text>
        <path d="M58 450 L58 68" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow-relax)"></path>
        ${ENERGY_AXIS_MARKUP}
        ${ybLevels}
        ${levelLines}
        ${transitionMarkup('H6', excitation.entry, 505, 'pump', `G · ${byId('excitationSelect').value} nm`, SINGLE_TM_LEVEL_BY_ID)}
        ${excitation.esa ? transitionMarkup(excitation.entry, excitation.esa, 485, 'transfer', 'G₂ · ESA', SINGLE_TM_LEVEL_BY_ID) : ''}
        ${cascadeArrows}${crossArrows}
        <path class="static-transition is-radiative emission-line" style="--emission-color:${emissionColor};stroke:${emissionColor}" d="${emissionPath}" fill="none" marker-end="url(#arrow-radiative)"></path>
        <text class="active-label emission-label" style="--emission-color:${emissionColor}" x="700" y="${(emissionStart + emissionEnd) / 2}" text-anchor="middle">${channel.rate} · emission</text>
        <path id="interactionPath" class="active-motion" d="" visibility="hidden" marker-end="url(#arrow-active)"></path>
        <text id="interactionText" class="active-label" x="410" y="100" text-anchor="middle" visibility="hidden"></text>
        ${ybPct > 0 ? `${ybIons}
        <text class="energy-axis-label" x="250" y="477" text-anchor="middle">Yb concentration · ${ybPct}%</text>` : ''}
        <text class="energy-axis-label" x="575" y="477" text-anchor="middle">Tm concentration · ${tmPct}%</text>
        ${ionMarkup('tmIon', 'tm', 'Tm', 575, YB_GROUND_Y, 17)}
        ${ionMarkup('tmBranchIon', 'tm', 'Tm', 545, YB_GROUND_Y, 14)}
        ${ionMarkup('tmPartnerIon', 'tm', 'Tm', 610, YB_GROUND_Y, 14)}
        <text id="photon" class="photon" style="fill:${emissionColor};--emission-color:${emissionColor}" x="713" y="${emissionStart - 12}">✦</text>
        <text x="410" y="508" text-anchor="middle" fill="#64748b" font-size="10">Selected host: ${escapeXml(selectedHostLabel())} · level values shown use YF₃:Tm³⁺ references (upper levels approximate).</text>`;
}

function buildSteps(channel, tmPct, ybPct) {
    const result = [];
    const add = (kind, title, description, data = {}) => result.push({ kind, title, description, ...data });
    const addH4Branches = () => {
        if (tmPct > 1) {
            add('cross-H4', 'Competing cross-relaxation · Wcr,H4', 'An excited ³H₄ Tm³⁺ ion interacts with a ground-state ³H₆ ion; both products populate ³F₄. The selected path continues schematically.', { from: 'Tm5', partner: 'Tm0', to: 'Tm1', partnerTo: 'Tm1' });
        }
        if (ybPct > 10) {
            const donorIndex = channel.transferIndices.length % displayedYbCount;
            add('back-transfer', 'Back-transfer · Wb', 'The excited ³H₄ Tm³⁺ ion transfers energy to ground-state Yb³⁺, producing Tm³⁺ in ³H₆ and excited Yb³⁺. The surviving Tm path continues.', { from: 'Tm5', to: 'Tm0', donorFrom: YB_GROUND_Y, donorTo: YB_EXCITED_Y, donorIndex });
            add('yb-relax', 'Yb relaxation · Aᵧ', 'The back-transferred Yb³⁺ excitation relaxes from ²F₅/₂ to ²F₇/₂.', { donorFrom: YB_EXCITED_Y, donorTo: YB_GROUND_Y, donorIndex });
        }
    };
    const addG4Branch = () => {
        if (tmPct > 0.1) {
            add('cross-G4', 'Competing cross-relaxation · Wcr,G4', 'An excited ¹G₄ Tm³⁺ ion interacts with a ground-state ³H₆ ion, producing Tm³⁺ ions in ³H₄ and ³F₄. The selected path continues schematically.', { from: 'Tm6', partner: 'Tm0', to: 'Tm5', partnerTo: 'Tm1' });
        }
    };
    if (channel.startLevel === 'Tm5') addH4Branches();
    if (channel.startLevel === 'Tm6') addG4Branch();
    for (const index of channel.transferIndices) {
        const [from, to] = TRANSFER_PAIRS[index - 1];
        const donorIndex = (index - 1) % displayedYbCount;
        add('pump', `Excite Yb³⁺ · W${index}`, 'A pump photon promotes Yb³⁺ from ²F₇/₂ to ²F₅/₂ along the donor path for this transfer.', { donorTo: YB_EXCITED_Y, donorIndex, transferIndex: index });
        add('transfer', `Energy transfer W${index}`, `Dipole–dipole transfer promotes Tm³⁺ from ${LEVEL_BY_ID[from].label.split('· ')[1]} to ${LEVEL_BY_ID[to].label.split('· ')[1]}; the same Yb donor follows its W${index} path back to ²F₇/₂.`, { from, to, donorFrom: YB_EXCITED_Y, donorTo: YB_GROUND_Y, donorIndex, transferIndex: index });

        if (index === 1) {
            add('relax', 'Tm relaxation · k₂₁', 'Tm³⁺ relaxes from ³H₅ to ³F₄ while Yb³⁺ remains in its ground state.', { from: 'Tm2', to: 'Tm1' });
        }
        if (index === 2) {
            add('relax', 'Tm relaxation · k₃₅', 'Tm³⁺ relaxes from ³F₂,₃ to ³H₄ while Yb³⁺ remains in its ground state.', { from: 'Tm3', to: 'Tm5' });
        }
        if (index === 2 || to === 'Tm5') addH4Branches();
        if (to === 'Tm6') addG4Branch();
    }
    add('emit', `${byId('emissionSelect').value} nm emission`, `The populated ${LEVEL_BY_ID[channel.emitter].label.split('· ')[1]} level emits to ${LEVEL_BY_ID[channel.target].label.split('· ')[1]} (${channel.rate}).`, { from: channel.emitter, to: channel.target });
    return result;
}

function buildSingleTmSteps(channel, tmPct, excitation, ybPct) {
    const result = [];
    const startLevel = singleTmStartLevel(excitation);
    const startIndex = SINGLE_TM_CASCADE.indexOf(startLevel);
    const emissionIndex = SINGLE_TM_CASCADE.indexOf(channel.emitter);
    const add = (kind, title, description, data = {}) => result.push({ kind, title, description, singleTm: true, ...data });
    add('single-pump', `Pump Tm³⁺ · ${byId('excitationSelect').value} nm`, `A photon promotes Tm³⁺ from ³H₆ to ${SINGLE_TM_LEVEL_NAMES[excitation.entry]}.`, {
        toY: SINGLE_TM_LEVEL_BY_ID[excitation.entry].y
    });
    if (excitation.esa) {
        add('single-esa', `Excited-state absorption · ${SINGLE_TM_LEVEL_NAMES[excitation.entry]} → ${SINGLE_TM_LEVEL_NAMES[excitation.esa]}`, 'A second pump photon promotes the same Tm³⁺ ion.', {
            toY: SINGLE_TM_LEVEL_BY_ID[excitation.esa].y
        });
    }
    for (let index = startIndex; index <= emissionIndex; index += 1) {
        const level = SINGLE_TM_CASCADE[index];
        if (index > startIndex) {
            add('single-relax', `Tm³⁺ relaxation · ${SINGLE_TM_LEVEL_NAMES[SINGLE_TM_CASCADE[index - 1]]} → ${SINGLE_TM_LEVEL_NAMES[level]}`, 'Non-radiative cascade feeding toward the selected emission level.', {
                toY: SINGLE_TM_LEVEL_BY_ID[level].y
            });
        }
        if (tmPct > 0 && level === 'H4') {
            add('single-cross', 'Competing cross-relaxation · ³H₄ + ³H₆ → 2 ³F₄', `Tm–Tm cross-relaxation is included at ${tmPct} mol% Tm. The selected emission path continues schematically.`, {
                fromY: SINGLE_TM_LEVEL_BY_ID.H4.y,
                partnerY: SINGLE_TM_LEVEL_BY_ID.H6.y,
                toY: SINGLE_TM_LEVEL_BY_ID.F4.y,
                partnerToY: SINGLE_TM_LEVEL_BY_ID.F4.y
            });
        }
        if (tmPct > 0 && level === 'D2') {
            add('single-cross', 'Competing cross-relaxation · ¹D₂ + ³H₆ → ¹G₄ + ³F₄', `Tm–Tm cross-relaxation is included at ${tmPct} mol% Tm. The selected emission path continues schematically.`, {
                fromY: SINGLE_TM_LEVEL_BY_ID.D2.y,
                partnerY: SINGLE_TM_LEVEL_BY_ID.H6.y,
                toY: SINGLE_TM_LEVEL_BY_ID.G4.y,
                partnerToY: SINGLE_TM_LEVEL_BY_ID.F4.y
            });
        }
        if (ybPct > 0 && ['H4', 'G4'].includes(level)) {
            add('single-yb-transfer', `Competing Tm→Yb transfer · Kyb at ${SINGLE_TM_LEVEL_NAMES[level]}`, `Yb = ${ybPct} mol%; the ODE models this as an effective loss from ${SINGLE_TM_LEVEL_NAMES[level]} to the Tm ground state, with no explicit Yb kinetics.`, {
                fromY: SINGLE_TM_LEVEL_BY_ID[level].y,
                toY: SINGLE_TM_LEVEL_BY_ID.H6.y,
                donorIndex: (index - startIndex) % displayedYbCount
            });
        }
    }
    add('emit', `${byId('emissionSelect').value} nm emission`, `${SINGLE_TM_LEVEL_NAMES[channel.emitter]} emits to ${SINGLE_TM_LEVEL_NAMES[channel.target]} (${channel.rate}).`, {
        fromY: SINGLE_TM_LEVEL_BY_ID[channel.emitter].y,
        toY: SINGLE_TM_LEVEL_BY_ID[channel.target].y
    });
    return result;
}

function updateRouteSummary(channel) {
    const emissions = {
        '1800': '1800 nm · ³F₄ → ³H₆',
        '775': '775 nm · ³H₄ → ³H₆',
        '477': '477 nm · ¹G₄ → ³H₆',
        '645': '645 nm · ¹G₄ → ³F₄',
        '362': '362 nm · ¹D₂ → ³H₆',
        '452': '452 nm · ¹D₂ → ³F₄',
        '345': '345 nm · ¹I₆ → ³F₄'
    };
    const value = byId('emissionSelect').value;
    const startingLevel = channel.startLevel === 'Tm0'
        ? 'Tm ground'
        : `Tm ${LEVEL_BY_ID[channel.startLevel].label.split('· ')[1]} residual`;
    const progression = [startingLevel, 'Yb 980 nm', ...channel.transferIndices.map(index => `W${index}`), emissions[value]].join(' → ');
    byId('routeTitle').textContent = emissions[value];
    byId('routeSummary').textContent = progression;
}

function drawSteps() {
    const list = byId('stepList');
    list.replaceChildren(...steps.map((step, index) => {
        const item = document.createElement('li');
        item.textContent = step.title;
        if (index < currentStep) item.classList.add('is-done');
        if (index === currentStep && running) item.classList.add('is-current');
        return item;
    }));
}

function positionIon(id, x, y, excited) {
    const ion = byId(id);
    if (!ion || !Number.isFinite(Number(y))) return;
    ion.setAttribute('transform', `translate(${x} ${y})`);
    ion.classList.toggle('is-excited', excited);
    ion.classList.toggle('is-ground', !excited);
}

function donorForStep(step) {
    return byId(`ybIon${step.donorIndex || 0}`);
}

function resetYbDonors(exceptId = '') {
    for (let index = 0; index < displayedYbCount; index += 1) {
        const donor = byId(`ybIon${index}`);
        if (!donor || donor.id === exceptId) continue;
        positionIon(donor.id, ybIonX(index), YB_GROUND_Y, false);
    }
}

function showInteraction(fromY, toY, reverse = false, donorX = ybIonX(0), interactionLabel = '') {
    const path = byId('interactionPath');
    const label = byId('interactionText');
    const donorEdge = donorX + ybRadius - 1;
    const xStart = reverse ? 560 : donorEdge;
    const xEnd = reverse ? donorEdge : 557;
    const bend = (fromY + toY) / 2 + (reverse ? 24 : -24);
    path.setAttribute('d', `M${xStart} ${fromY} Q${(xStart + xEnd) / 2} ${bend} ${xEnd} ${toY}`);
    path.setAttribute('marker-end', `url(#arrow-${reverse ? 'back' : 'active'})`);
    path.classList.toggle('is-back-transfer', reverse);
    path.classList.remove('is-cross-relaxation');
    path.setAttribute('visibility', 'visible');
    label.textContent = interactionLabel || (reverse ? 'back-transfer · Wb' : 'dipole–dipole interaction');
    label.setAttribute('y', String(bend - 8));
    label.classList.toggle('is-back-transfer', reverse);
    label.classList.remove('is-cross-relaxation');
    label.setAttribute('visibility', 'visible');
}

function hideInteraction() {
    byId('interactionPath').setAttribute('visibility', 'hidden');
    byId('interactionText').setAttribute('visibility', 'hidden');
}

function showCrossInteraction(fromY, partnerY) {
    const path = byId('interactionPath');
    const label = byId('interactionText');
    const xStart = 559;
    const xEnd = 596;
    const bend = (fromY + partnerY) / 2 - 20;
    path.setAttribute('d', `M${xStart} ${fromY} Q${(xStart + xEnd) / 2} ${bend} ${xEnd} ${partnerY}`);
    path.setAttribute('marker-end', 'url(#arrow-cross)');
    path.classList.remove('is-back-transfer');
    path.classList.add('is-cross-relaxation');
    path.setAttribute('visibility', 'visible');
    label.textContent = 'Tm–Tm interaction · Wcr';
    label.setAttribute('x', String((xStart + xEnd) / 2));
    label.setAttribute('y', String(bend - 7));
    label.classList.remove('is-back-transfer');
    label.classList.add('is-cross-relaxation');
    label.setAttribute('visibility', 'visible');
}

function showStep(index) {
    const step = steps[index];
    if (!step) return;
    hideInteraction();
    resetYbDonors(step.kind === 'transfer' || step.kind === 'pump' || step.kind === 'back-transfer' || step.kind === 'yb-relax'
        ? donorForStep(step)?.id
        : '');
    byId('photon').classList.remove('is-visible');
    diagram.querySelector('.emission-line').classList.remove('is-emitting');
    diagram.querySelectorAll('.yb-transfer-path').forEach(path => path.classList.remove('is-active'));

    if (step.kind === 'pump') {
        const donor = donorForStep(step);
        positionIon(donor.id, ybIonX(step.donorIndex), YB_EXCITED_Y, true);
        byId('liveStatus').textContent = `Yb excited · W${step.transferIndex}`;
    } else if (step.kind === 'transfer') {
        const donor = donorForStep(step);
        positionIon('tmIon', 575, LEVEL_BY_ID[step.to].y, true);
        positionIon(donor.id, ybIonX(step.donorIndex), YB_GROUND_Y, false);
        diagram.querySelector(`.yb-transfer-w${step.transferIndex}`)?.classList.add('is-active');
        showInteraction(step.donorFrom, LEVEL_BY_ID[step.to].y, false, ybIonX(step.donorIndex));
        byId('liveStatus').textContent = `Energy transferred · W${step.transferIndex}`;
    } else if (step.kind === 'relax') {
        positionIon('tmIon', 575, LEVEL_BY_ID[step.to].y, true);
        byId('liveStatus').textContent = 'Tm relaxation';
    } else if (step.kind === 'single-pump' || step.kind === 'single-esa' || step.kind === 'single-relax') {
        positionIon('tmIon', 575, step.toY, true);
        byId('liveStatus').textContent = step.kind === 'single-pump'
            ? 'Tm directly excited'
            : step.kind === 'single-esa' ? 'Excited-state absorption' : 'Tm relaxation';
    } else if (step.kind === 'single-cross') {
        positionIon('tmBranchIon', 545, step.fromY, true);
        positionIon('tmPartnerIon', 610, step.partnerY, false);
        byId('tmBranchIon').classList.remove('is-hidden');
        byId('tmPartnerIon').classList.remove('is-hidden');
        showCrossInteraction(step.fromY, step.partnerY);
        window.setTimeout(() => {
            if (currentStep !== index + 1) return;
            positionIon('tmBranchIon', 545, step.toY, true);
            positionIon('tmPartnerIon', 610, step.partnerToY, true);
        }, BRANCH_TRANSITION_DELAY_MS);
        byId('liveStatus').textContent = 'Tm–Tm cross-relaxation';
    } else if (step.kind === 'single-yb-transfer') {
        const donor = donorForStep(step);
        positionIon('tmBranchIon', 545, step.fromY, true);
        byId('tmBranchIon').classList.remove('is-hidden');
        positionIon(donor.id, ybIonX(step.donorIndex), YB_EXCITED_Y, true);
        showInteraction(step.fromY, YB_EXCITED_Y, true, ybIonX(step.donorIndex), 'Tm→Yb transfer · Kyb');
        window.setTimeout(() => {
            if (currentStep !== index + 1) return;
            positionIon('tmBranchIon', 545, step.toY, false);
        }, BRANCH_TRANSITION_DELAY_MS);
        byId('liveStatus').textContent = 'Tm → Yb transfer · Kyb';
    } else if (step.kind === 'cross-H4' || step.kind === 'cross-G4') {
        const fromY = LEVEL_BY_ID[step.from].y;
        const groundY = LEVEL_BY_ID[step.partner].y;
        const productY = LEVEL_BY_ID[step.to].y;
        const secondProductY = LEVEL_BY_ID[step.partnerTo].y;
        positionIon('tmBranchIon', 545, fromY, true);
        positionIon('tmPartnerIon', 610, groundY, false);
        byId('tmBranchIon').classList.remove('is-hidden');
        byId('tmPartnerIon').classList.remove('is-hidden');
        showCrossInteraction(fromY, groundY);
        window.setTimeout(() => {
            if (currentStep !== index + 1) return;
            positionIon('tmBranchIon', 545, productY, true);
            positionIon('tmPartnerIon', 610, secondProductY, true);
        }, BRANCH_TRANSITION_DELAY_MS);
        byId('liveStatus').textContent = 'Tm–Tm cross-relaxation';
    } else if (step.kind === 'back-transfer') {
        const donor = donorForStep(step);
        const sourceY = LEVEL_BY_ID[step.from].y;
        positionIon('tmBranchIon', 545, sourceY, true);
        byId('tmBranchIon').classList.remove('is-hidden');
        positionIon(donor.id, ybIonX(step.donorIndex), YB_EXCITED_Y, true);
        showInteraction(sourceY, YB_EXCITED_Y, true, ybIonX(step.donorIndex));
        window.setTimeout(() => {
            if (currentStep !== index + 1) return;
            positionIon('tmBranchIon', 545, LEVEL_BY_ID[step.to].y, false);
        }, BRANCH_TRANSITION_DELAY_MS);
        byId('liveStatus').textContent = 'Tm → Yb back-transfer';
    } else if (step.kind === 'yb-relax') {
        const donor = donorForStep(step);
        positionIon(donor.id, ybIonX(step.donorIndex), YB_GROUND_Y, false);
        byId('liveStatus').textContent = 'Yb returned to ground';
    } else if (step.kind === 'emit') {
        const levelY = step.singleTm ? SINGLE_TM_LEVEL_BY_ID : LEVEL_BY_ID;
        positionIon('tmIon', 575, step.singleTm ? step.toY : levelY[step.to].y, false);
        byId('photon').setAttribute('y', String(step.singleTm ? step.fromY - 12 : levelY[step.from].y - 12));
        byId('photon').classList.add('is-visible');
        diagram.querySelector('.emission-line').classList.add('is-emitting');
        byId('liveStatus').textContent = 'Radiative emission';
    }

    byId('stepCount').textContent = `Step ${index + 1} of ${steps.length}`;
    byId('stepTitle').textContent = step.title;
    byId('stepDescription').textContent = step.description;
    byId('progressBar').style.width = `${((index + 1) / steps.length) * 100}%`;
    drawSteps();
}

function finish() {
    window.clearInterval(timer);
    timer = null;
    running = false;
    byId('runButton').textContent = '↻ Run again';
    byId('liveStatus').textContent = 'Emission reached';
    byId('stepCount').textContent = 'Pathway complete';
    drawSteps();
}

function tick() {
    if (currentStep >= steps.length) {
        finish();
        return;
    }
    showStep(currentStep);
    currentStep += 1;
}

function start() {
    if (running) {
        window.clearInterval(timer);
        timer = null;
        running = false;
        byId('runButton').textContent = '▶ Resume motion';
        byId('liveStatus').textContent = 'Paused';
        drawSteps();
        return;
    }
    if (currentStep >= steps.length) reset();
    running = true;
    byId('runButton').textContent = 'Ⅱ Pause motion';
    tick();
    timer = window.setInterval(tick, MOTION_STEP_DURATION_MS);
}

function reset() {
    window.clearInterval(timer);
    timer = null;
    running = false;
    currentStep = 0;
    const singleTmMode = byId('modelSelect').value === 'single-tm';
    const modelNote = byId('modelNote');
    if (modelNote) {
        modelNote.textContent = `Selected host: ${selectedHostLabel()}. The cm⁻¹ axis still uses representative YF₃:Tm³⁺ reference energies, with approximate upper-level positions; this host selection does not change the qualitative animation or its energy values. The motion follows the existing ODE pathways and is not a numerical population simulation. Yb in direct-Tm mode shows the effective Tm→Yb loss from ³H₄ and ¹G₄ without explicit Yb kinetics. Ion counts and sizes are illustrative.`;
    }
    updateEmissionOptions();
    const excitation = SINGLE_TM_EXCITATIONS[byId('excitationSelect').value];
    const channel = (singleTmMode ? SINGLE_TM_CHANNELS : CHANNELS)[byId('emissionSelect').value];
    const tmPct = Math.max(0, Number(byId('tmConcentration').value) || 0);
    const ybPct = Math.max(0, Number(byId('ybConcentration').value) || 0);
    document.body.classList.toggle('single-tm-mode', singleTmMode);
    document.body.classList.toggle('has-yb', !singleTmMode || ybPct > 0);
    byId('excitationControl').hidden = !singleTmMode;
    byId('ybHelp').hidden = !singleTmMode;
    byId('ybControl').hidden = false;
    diagram.setAttribute('aria-label', singleTmMode
        ? 'Animated direct-Tm energy-level diagram with optional Yb co-doping'
        : 'Animated Yb and Tm energy-level diagram');
    renderDiagram(channel, ybPct, tmPct, singleTmMode, excitation);
    steps = singleTmMode ? buildSingleTmSteps(channel, tmPct, excitation, ybPct) : buildSteps(channel, tmPct, ybPct);
    resetYbDonors();
    const initialTmLevel = singleTmMode ? 'H6' : channel.startLevel;
    const initialTmY = singleTmMode
        ? SINGLE_TM_LEVEL_BY_ID[initialTmLevel].y
        : LEVEL_BY_ID[initialTmLevel].y;
    positionIon('tmIon', 575, initialTmY, !singleTmMode && initialTmLevel !== 'Tm0');
    positionIon('tmBranchIon', 545, initialTmY, false);
    positionIon('tmPartnerIon', 610, initialTmY, false);
    byId('tmBranchIon').classList.add('is-hidden');
    byId('tmPartnerIon').classList.add('is-hidden');
    if (singleTmMode) {
        const start = SINGLE_TM_LEVEL_NAMES[singleTmStartLevel(excitation)];
        const startIndex = SINGLE_TM_CASCADE.indexOf(singleTmStartLevel(excitation));
        const emissionIndex = SINGLE_TM_CASCADE.indexOf(channel.emitter);
        const cascade = SINGLE_TM_CASCADE.slice(startIndex, emissionIndex + 1)
            .map(level => SINGLE_TM_LEVEL_NAMES[level]).join(' → ');
        byId('routeTitle').textContent = channel.label;
        byId('routeSummary').textContent = `${byId('excitationSelect').value} nm Tm excitation → ${cascade || start} → ${channel.label}${ybPct > 0 ? ` · Yb ${ybPct} mol% (Kyb)` : ''}`;
    } else {
        updateRouteSummary(channel);
    }
    byId('stepCount').textContent = 'Ready to run';
    byId('stepTitle').textContent = 'Choose a pathway and run the motion';
    byId('stepDescription').textContent = singleTmMode
        ? 'The animation shows direct Tm³⁺ excitation, any excited-state absorption, the cascade to the selected emitting level, and concentration-dependent Tm–Tm cross-relaxation.'
    : channel.startLevel === 'Tm0'
        ? 'The Tm ion begins in ³H₆; Yb donors begin in ²F₇/₂. Each selected W transfer shows Yb excitation, dipole–dipole interaction, Tm relaxation, and the final emission.'
        : `The animation begins with a residual Tm ion in ${LEVEL_BY_ID[channel.startLevel].label.split('· ')[1]}; the earlier pulse-driven transfers are not replayed. Yb donors begin in ²F₇/₂.`;
    byId('progressBar').style.width = '0%';
    byId('liveStatus').textContent = 'Ready';
    byId('runButton').textContent = '▶ Run motion';
    drawSteps();
}

byId('runButton').addEventListener('click', start);
byId('resetButton').addEventListener('click', reset);
const requestedHost = new URLSearchParams(window.location.search).get('host');
if (requestedHost && HOST_LABELS[requestedHost]) byId('hostSelect').value = requestedHost;
['modelSelect', 'excitationSelect', 'emissionSelect', 'tmConcentration', 'ybConcentration', 'hostSelect'].forEach(id => byId(id).addEventListener('change', reset));
reset();
