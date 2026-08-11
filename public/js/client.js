// =============================================================================
// TOO MANY HEROES — CLIENT (the "eyes and hands")
// =============================================================================
// Plain English: this file DRAWS the game and SENDS your clicks to the server.
// It does NOT decide combat results, gold changes, or who won.
// When the server says "your gold is 80", we show 80 — we don't invent a new number.
//
// Multi-party edition: you can own many named parties in the hub, field up to four
// for a mission, and control each party token separately in the arena.
// =============================================================================

// ==================== 1. GLOBAL STATE (RENDER CACHE FROM SERVER) ====================
// These variables are a LOCAL COPY of server truth for drawing the UI.
// Prefer updating them from STATE_SYNC / resolve-round — not from local guesses.
const socket = io();
let myFaction = null;              // 'p1', 'p2', or 'spectator' (assigned by server)
let currentRoomState = 'LANDING';  // which HTML screen is visible right now

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Team colours: leftmost player (p1) = Blue, rightmost (p2) = Red.
// Orange is reserved for neutral UI chrome (order buttons), not team identity.
const TEAM_COLORS = { p1: '#1e88e5', p2: '#d62828' };

// Display-only hero stat fallbacks for cards when the server only sends a role name.
const LOCAL_HERO_TEMPLATES = {
    'Peasant':   { hp: 50,  melee: 10, range: 0 },
    'Barbarian': { hp: 100, melee: 40, range: 0 },
    'Elf':       { hp: 40,  melee: 15, range: 25 },
    'Wizard':    { hp: 30,  melee: 10, range: 35 },
    'Knight':    { hp: 120, melee: 25, range: 0 }
};

// Maps server room-state names -> HTML element ids (only one screen is .active).
// PARTY_DETAIL is client-only — the server never sends it.
const SCREEN_MAP = {
    'LANDING': 'screen-landing',
    'TOWN_HQ': 'screen-town-hq',
    'TAVERN': 'screen-tavern',
    'CASTLE': 'screen-castle',
    'MISSION_BRIEFING': 'screen-mission-briefing',
    'PARTY_DETAIL': 'screen-party-detail',
    'TACTICAL_ARENA': 'screen-tactical-arena',
    'GAME_OVER': 'screen-game-over'
};

// --- Hub player data (from STATE_SYNC player block) ---
let playerGold = 100;
let playerName = '';
let myParties = [];                // [{ number, name, members }]
let currentOffer = { name: '', members: [], cost: 0 };
let fieldedNumbers = [];           // party numbers ticked for the mission (max 4)
let groundBooks = [];              // [{ x, y, ownerFaction }] books on the floor
let maxRounds = 10;
let isWaitingForOpponentLaunch = false;

// --- Arena data (from STATE_SYNC arena block) ---
let arenaParties = [];             // all fielded parties on the grid
let arenaPhase = 'IDLE';           // IDLE | DEPLOYMENT | COMBAT
let currentRound = 1;
let deploymentStatus = {
    p1: { placed: false, ready: false },
    p2: { placed: false, ready: false }
};
let arenaPlayerNames = { p1: '', p2: '' };

// Which party token you selected (matches server uid, e.g. "p1-2").
let selectedPartyUid = null;

// Stable 2×2 corner assignment per party: layout[memberIndex] = corner 0..3 (TL,TR,BL,BR).
let partyCornerLayout = {};
// Last move direction per party uid: 'up'|'down'|'left'|'right' (controls sprite facing).
let partyLastMoveDir = {};
// Last known tile per party uid — used to detect moves for facing updates.
let partyLastPos = {};

// Combat planning: one entry per party number you control this round.
// { order: 'Advance', path: [{x,y}, ...] }
let localPlans = {};

let isWaitingForCombatResolution = false;
let matchActive = true;

// Round resolution playback (server still owns outcomes; we only animate them).
const ROUND_MOVE_MS = 500;        // slide duration for one square
const ROUND_STEP_GAP_MS = 1000;   // pause between movement steps (no combat)
const COMBAT_PAUSE_MS = 1000;     // wait before opening the fight window
const COMBAT_OPEN_MS = 500;       // window expands from centre
const COMBAT_CLOSE_MS = 500;      // window collapses to centre
const COMBAT_FLOAT_MS = 1000;     // per-hero damage float duration
let isPlayingRoundAnimation = false;
// While animating: fractional tile positions { [uid]: { x, y } }. Null = use server ints.
let animPosByUid = null;
// If GAME_OVER arrives mid-animation, show it after the slides finish.
let pendingGameOverSummary = null;

// Party detail screen remembers where "Back" should return (TAVERN or CASTLE).
let partyDetailReturnTo = 'TAVERN';
let viewingPartyNumber = null;

let lobbyStatusText = { p1: 'DISCONNECTED', p2: 'DISCONNECTED', readyP1: false, readyP2: false };

// --- Arena grid layout (must match server.js ARENA_TILE_MAP) ---
// Canvas is MAP ONLY; party list / details are HTML beside a scrollable map frame.
// Native tile size in CSS/canvas pixels (map bitmap = 11×100 by 10×100 = 1100×1000).
// Kept at 1:1 in the scroll frame — does not scale-to-fit the window.
const ARENA_GRID = { offsetX: 0, offsetY: 0, cellSize: 100, width: 11, height: 10 };
// Fog of War: each living friendly party reveals tiles within this Manhattan distance
// (plain travel steps — Road/Forest move bonuses do NOT extend vision).
const FOG_VISION_RANGE = 2;

const ARENA_TILE_COLORS = {
    LG:  '#b5c96e',
    DG:  '#2e6b3e',
    DGY: '#4a4a4a',
    RED: '#d62828',
    LGY: '#9a9a9a'
};

const ARENA_TILE_MAP = [
    ['LG','LG','LG','LG','DG','DG','LG','LG','LG','DG','DG'],
    ['LG','LG','LG','LG','DG','DG','LG','LG','LGY','DG','DG'],
    ['LG','RED','DGY','LG','LG','LG','LG','LGY','LGY','LG','LG'],
    ['DG','LG','DGY','DG','DG','LG','LG','LG','LGY','LG','LG'],
    ['DG','LG','DGY','LG','LG','LG','DG','DG','DG','LG','LG'],
    ['LG','LG','DGY','DGY','DGY','DGY','DGY','DGY','DGY','LG','DG'],
    ['LG','LG','LG','LG','LG','DG','DG','DG','DGY','LG','DG'],
    ['LG','LG','LGY','LGY','LG','LG','LG','LG','DGY','RED','LG'],
    ['DG','DG','LGY','DG','LG','DG','DG','LG','LG','LG','LG'],
    ['DG','DG','LG','LG','LG','DG','DG','LG','LG','LG','LG']
];
// Mountains and Buildings cannot be walked on (preview only — server enforces for real).
const BLOCKED_TILES = { RED: true, LGY: true };

const MAX_FIELDED_PARTIES = 4;

// ==================== 2. SCREEN SWITCHER & UI RENDER ====================

function switchScreen(newState) {
    // Avoid toggling .active on every STATE_SYNC — that flashes the whole arena on mobile.
    if (currentRoomState === newState) return;

    currentRoomState = newState;
    document.querySelectorAll('.game-screen').forEach(el => el.classList.remove('active'));
    const screenId = SCREEN_MAP[newState];
    if (screenId) document.getElementById(screenId).classList.add('active');
    if (newState === 'TACTICAL_ARENA') {
        requestAnimationFrame(fitMapCanvasInFrame);
    }
    if (newState === 'TOWN_HQ') {
        requestAnimationFrame(fitTownStage);
    }
    if (newState === 'TAVERN') {
        requestAnimationFrame(fitTavernStage);
    }
    if (newState === 'CASTLE') {
        requestAnimationFrame(fitAgencyStage);
    }
    if (newState === 'MISSION_BRIEFING') {
        requestAnimationFrame(fitMissionBriefingStage);
    }
    if (newState === 'PARTY_DETAIL') {
        requestAnimationFrame(fitPartyDetailStage);
    }
}

// Letterbox a stage box inside its wrap (same contain behaviour as splash / town).
function fitLetterboxStage(wrapId, stageId, artW, artH, expectedRoom) {
    const wrap = document.getElementById(wrapId);
    const stage = document.getElementById(stageId);
    if (!wrap || !stage || currentRoomState !== expectedRoom) return;

    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    let w = availW;
    let h = w * (artH / artW);
    if (h > availH) {
        h = availH;
        w = h * (artW / artH);
    }
    stage.style.width = `${Math.round(w)}px`;
    stage.style.height = `${Math.round(h)}px`;
}

const TOWN_ART_W = 1024;
const TOWN_ART_H = 534; // town.jpeg height after TOWN DESTINATIONS strip removed
function fitTownStage() {
    fitLetterboxStage('town-stage-wrap', 'town-stage', TOWN_ART_W, TOWN_ART_H, 'TOWN_HQ');
}

const TAVERN_ART_W = 1024;
const TAVERN_ART_H = 557;
function fitTavernStage() {
    fitLetterboxStage('tavern-stage-wrap', 'tavern-stage', TAVERN_ART_W, TAVERN_ART_H, 'TAVERN');
}

const AGENCY_ART_W = 1024;
const AGENCY_ART_H = 557;
function fitAgencyStage() {
    fitLetterboxStage('agency-stage-wrap', 'agency-stage', AGENCY_ART_W, AGENCY_ART_H, 'CASTLE');
}

function fitMissionBriefingStage() {
    fitLetterboxStage(
        'mission-briefing-stage-wrap',
        'mission-briefing-stage',
        AGENCY_ART_W,
        AGENCY_ART_H,
        'MISSION_BRIEFING'
    );
}

function fitPartyDetailStage() {
    // Tavern and Agency arts are both 1024×557 — letterbox the same either way.
    fitLetterboxStage(
        'party-detail-stage-wrap',
        'party-detail-stage',
        TAVERN_ART_W,
        TAVERN_ART_H,
        'PARTY_DETAIL'
    );
}

// Keep the map at native tile size (100px cells → 1100×1000). Never scale-to-fit.
// Centre on each axis that still fits; scroll only on axes that overflow.
function fitMapCanvasInFrame() {
    const frame = document.getElementById('arena-map-scroll');
    const center = document.getElementById('arena-map-center');
    if (!frame || !center || !canvas || currentRoomState !== 'TACTICAL_ARENA') return;

    syncArenaCanvasSize();
    const mapW = canvas.width;
    const mapH = canvas.height;
    canvas.style.width = `${mapW}px`;
    canvas.style.height = `${mapH}px`;

    const frameW = frame.clientWidth;
    const frameH = frame.clientHeight;
    if (frameW <= 0 || frameH <= 0) return;

    // Wrapper is at least the viewport size so flex can centre the canvas when
    // the map is narrower and/or shorter than the scroll frame.
    center.style.width = `${Math.max(mapW, frameW)}px`;
    center.style.height = `${Math.max(mapH, frameH)}px`;
}

// Phones/tablets: try OS landscape lock (often needs fullscreen); else show rotate overlay.
function isMobileLikeDevice() {
    return /Mobi|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches);
}

function updateRotateOverlay() {
    const overlay = document.getElementById('rotate-lock-overlay');
    if (!overlay) return;
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    overlay.classList.toggle('active', isMobileLikeDevice() && portrait);
}

async function tryLockLandscape() {
    if (!isMobileLikeDevice()) return;
    try {
        const root = document.documentElement;
        if (!document.fullscreenElement && root.requestFullscreen) {
            await root.requestFullscreen();
        }
    } catch (err) { /* fullscreen may be blocked */ }
    try {
        if (screen.orientation && screen.orientation.lock) {
            await screen.orientation.lock('landscape');
        }
    } catch (err) { /* iOS / unsigned sites often reject lock */ }
    updateRotateOverlay();
}

function getTeamColor(faction) {
    return TEAM_COLORS[faction] || '#ffffff';
}

function heroAttackLabel(stats) {
    return stats.range > 0 ? `🏹${stats.range} Ranged` : `⚔${stats.melee} Melee`;
}

function partyIsAlive(membersOrParty) {
    const members = membersOrParty.members || membersOrParty;
    return members.some(m => m.hp > 0);
}

// Build the set of tiles YOUR living parties can see (union of each party's vision).
// Distance = |dx| + |dy| (orthogonal travel steps), max FOG_VISION_RANGE.
function buildVisibleTileSet() {
    const visible = new Set();
    // Spectators see the whole board (no fog).
    if (myFaction === 'spectator') {
        for (let y = 0; y < ARENA_GRID.height; y++) {
            for (let x = 0; x < ARENA_GRID.width; x++) visible.add(`${x},${y}`);
        }
        return visible;
    }

    getMyLivingArenaParties().forEach(ap => {
        if (typeof ap.x !== 'number' || typeof ap.y !== 'number') return;
        for (let dy = -FOG_VISION_RANGE; dy <= FOG_VISION_RANGE; dy++) {
            for (let dx = -FOG_VISION_RANGE; dx <= FOG_VISION_RANGE; dx++) {
                if (Math.abs(dx) + Math.abs(dy) > FOG_VISION_RANGE) continue;
                const x = ap.x + dx;
                const y = ap.y + dy;
                if (x < 0 || x >= ARENA_GRID.width || y < 0 || y >= ARENA_GRID.height) continue;
                visible.add(`${x},${y}`);
            }
        }
    });
    return visible;
}

function isTileVisible(visibleSet, x, y) {
    return visibleSet.has(`${x},${y}`);
}

function findHubParty(number) {
    return myParties.find(p => p.number === number) || null;
}

// Neutral portraits for Tavern / Agency / party detail.
const HERO_PORTRAITS = {
    Peasant: '/assets/characters/peasant_1.png',
    Elf: '/assets/characters/elf_1.png',
    Wizard: '/assets/characters/wizard_1.png',
    Barbarian: '/assets/characters/barbarian_1.png',
    Knight: '/assets/characters/knight_1.png'
};

// Arena-only team-tinted portraits (p1 = Blue / left, p2 = Red / right).
const HERO_PORTRAITS_TEAM = {
    Peasant: {
        p1: '/assets/characters/peasant_blue_1.png',
        p2: '/assets/characters/peasant_red_1.png'
    },
    Wizard: {
        p1: '/assets/characters/wizard_blue_1.png',
        p2: '/assets/characters/wizard_red_1.png'
    },
    Barbarian: {
        p1: '/assets/characters/barbarian_blue_1.png',
        p2: '/assets/characters/barbarian_red_1.png'
    },
    Elf: {
        p1: '/assets/characters/elf_blue_1.png',
        p2: '/assets/characters/elf_red_1.png'
    },
    Knight: {
        p1: '/assets/characters/knight_blue_1.png',
        p2: '/assets/characters/knight_red_1.png'
    }
};

// --- Arena map party sprites (2×2 portraits on a tile) ---

const portraitImgCache = {};

function getCachedPortrait(src) {
    if (!src) return null;
    if (portraitImgCache[src]) return portraitImgCache[src];
    const img = new Image();
    img.src = src;
    portraitImgCache[src] = img;
    return img;
}

function preloadArenaPortraits() {
    Object.keys(HERO_PORTRAITS_TEAM).forEach(role => {
        getCachedPortrait(HERO_PORTRAITS_TEAM[role].p1);
        getCachedPortrait(HERO_PORTRAITS_TEAM[role].p2);
    });
}

function resetPartyVisualState() {
    partyCornerLayout = {};
    partyLastMoveDir = {};
    partyLastPos = {};
}

function shuffleCornerSlots() {
    const corners = [0, 1, 2, 3];
    for (let i = corners.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = corners[i];
        corners[i] = corners[j];
        corners[j] = tmp;
    }
    return corners;
}

function ensurePartyCornerLayout(uid) {
    if (!partyCornerLayout[uid]) {
        // memberIndex i always draws in layout[i]; KO leaves that corner empty.
        partyCornerLayout[uid] = shuffleCornerSlots();
    }
    return partyCornerLayout[uid];
}

function ensurePartyFacing(ap) {
    if (!partyLastMoveDir[ap.uid]) {
        // Deploy default: Blue (p1) faces right, Red (p2) faces left.
        partyLastMoveDir[ap.uid] = ap.faction === 'p2' ? 'left' : 'right';
    }
    return partyLastMoveDir[ap.uid];
}

// Up/Left → face left (mirror). Down/Right → face right (as drawn).
function partyFacesLeft(dir) {
    return dir === 'left' || dir === 'up';
}

function updatePartyFacingFromPositions(parties) {
    (parties || []).forEach(ap => {
        if (!ap || !ap.uid) return;
        ensurePartyCornerLayout(ap.uid);

        // During deployment, always Blue→right / Red→left (moving within the zone must not flip them).
        if (arenaPhase === 'DEPLOYMENT') {
            partyLastMoveDir[ap.uid] = ap.faction === 'p2' ? 'left' : 'right';
            if (typeof ap.x === 'number' && typeof ap.y === 'number') {
                partyLastPos[ap.uid] = { x: ap.x, y: ap.y };
            }
            return;
        }

        ensurePartyFacing(ap);
        if (typeof ap.x !== 'number' || typeof ap.y !== 'number') return;
        const prev = partyLastPos[ap.uid];
        if (prev && (prev.x !== ap.x || prev.y !== ap.y)) {
            const dx = ap.x - prev.x;
            const dy = ap.y - prev.y;
            if (Math.abs(dx) >= Math.abs(dy)) {
                if (dx > 0) partyLastMoveDir[ap.uid] = 'right';
                else if (dx < 0) partyLastMoveDir[ap.uid] = 'left';
            } else {
                if (dy > 0) partyLastMoveDir[ap.uid] = 'down';
                else if (dy < 0) partyLastMoveDir[ap.uid] = 'up';
            }
        }
        partyLastPos[ap.uid] = { x: ap.x, y: ap.y };
    });
}

function drawPartySpritesOnTile(ap, tileX, tileY) {
    const size = ARENA_GRID.cellSize;
    const half = size / 2;
    const pad = 1;
    const spriteSize = half - pad * 2;
    const layout = ensurePartyCornerLayout(ap.uid);
    const faceLeft = partyFacesLeft(ensurePartyFacing(ap));

    // Corners: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
    const cornerOffset = [
        { ox: 0, oy: 0 },
        { ox: half, oy: 0 },
        { ox: 0, oy: half },
        { ox: half, oy: half }
    ];

    ap.members.forEach((member, memberIndex) => {
        if (!member || member.hp <= 0) return; // KO → leave that corner empty
        const corner = layout[memberIndex];
        if (corner === undefined) return;
        const teamArt = HERO_PORTRAITS_TEAM[member.role];
        const src = teamArt ? teamArt[ap.faction] : null;
        const img = getCachedPortrait(src);
        if (!img || !img.complete || !img.naturalWidth) return;

        const off = cornerOffset[corner];
        const dx = tileX + off.ox + pad;
        const dy = tileY + off.oy + pad;

        ctx.save();
        // Smooth (bilinear) scale for character sprites only — tiles stay crisp elsewhere.
        ctx.imageSmoothingEnabled = true;
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
        if (faceLeft) {
            ctx.translate(dx + spriteSize, dy);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, 0, spriteSize, spriteSize);
        } else {
            ctx.drawImage(img, dx, dy, spriteSize, spriteSize);
        }
        ctx.restore();
    });
}

function syncArenaCanvasSize() {
    const w = ARENA_GRID.width * ARENA_GRID.cellSize;
    const h = ARENA_GRID.height * ARENA_GRID.cellSize;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
}

// options.faction: if 'p1' or 'p2', use arena team portraits; otherwise neutral art.
function renderHeroCards(container, heroes, options) {
    if (!container) return;
    const faction = options && options.faction;
    container.innerHTML = '';
    heroes.forEach(h => {
        const card = document.createElement('div');
        card.className = 'hero-card';
        const stats = LOCAL_HERO_TEMPLATES[h.role] || h;
        const baseHp = h.baseHp !== undefined ? h.baseHp : stats.hp;
        let hpText;
        if (h.hp !== undefined) {
            hpText = h.hp > 0 ? `${h.hp}/${baseHp} HP` : 'UNCONSCIOUS';
        } else {
            hpText = `${stats.hp} HP`;
        }

        let portraitSrc = null;
        if ((faction === 'p1' || faction === 'p2') && HERO_PORTRAITS_TEAM[h.role]) {
            portraitSrc = HERO_PORTRAITS_TEAM[h.role][faction];
        } else {
            portraitSrc = HERO_PORTRAITS[h.role] || null;
        }
        const portraitHtml = portraitSrc
            ? `<img src="${portraitSrc}" alt="${h.role}">`
            : '';

        card.innerHTML =
            `<div class="hero-portrait">${portraitHtml}</div>`
            + `<div class="hero-card-body">`
            + `<h4>${h.role.toUpperCase()}</h4>`
            + `<p>❤ ${hpText} | ${heroAttackLabel(stats)}</p>`
            + `</div>`;
        container.appendChild(card);
    });
}

// Left column in the Tavern: clickable party rows open the detail screen.
function renderTavernRoster() {
    const container = document.getElementById('tavern-roster');
    if (!container) return;
    container.innerHTML = '';
    if (myParties.length === 0) {
        container.innerHTML = '<p style="color:rgba(255,248,231,0.9);">No heroes recruited yet.</p>';
        return;
    }
    myParties.forEach(party => {
        const row = document.createElement('div');
        row.className = 'party-list-row';
        row.innerHTML = `<span class="party-name-link">${party.number}. ${party.name}</span>`;
        row.addEventListener('click', () => openPartyDetail(party.number, 'TAVERN'));
        container.appendChild(row);
    });
}

// Mission briefing: checkbox + clickable name for each party (field 1–4).
function renderMissionPartyList() {
    const container = document.getElementById('mission-party-slots');
    if (!container) return;
    container.innerHTML = '';
    if (myParties.length === 0) {
        container.innerHTML = '<p style="color:rgba(255,248,231,0.9);">No parties yet — visit the Tavern.</p>';
        return;
    }
    myParties.forEach(party => {
        const row = document.createElement('div');
        row.className = 'party-list-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = fieldedNumbers.includes(party.number);
        checkbox.addEventListener('click', (e) => e.stopPropagation());
        checkbox.addEventListener('change', (e) => {
            const num = party.number;
            if (e.target.checked) {
                if (fieldedNumbers.length >= MAX_FIELDED_PARTIES && !fieldedNumbers.includes(num)) {
                    e.target.checked = false;
                    return;
                }
                socket.emit('SET_FIELD_PARTY', { partyNumber: num, selected: true });
            } else {
                socket.emit('SET_FIELD_PARTY', { partyNumber: num, selected: false });
            }
        });

        const nameSpan = document.createElement('span');
        nameSpan.className = 'party-name-link';
        nameSpan.textContent = `${party.number}. ${party.name}`;
        // Return from party detail back to the mission briefing screen
        nameSpan.addEventListener('click', () => openPartyDetail(party.number, 'MISSION_BRIEFING'));

        row.appendChild(checkbox);
        row.appendChild(nameSpan);
        container.appendChild(row);
    });
}

function openMissionBriefing() {
    switchScreen('MISSION_BRIEFING');
    renderSyncedUI();
}

function openPartyDetail(partyNumber, returnTo) {
    const party = findHubParty(partyNumber);
    if (!party) return;
    partyDetailReturnTo = returnTo;
    viewingPartyNumber = partyNumber;

    const fromTavern = returnTo === 'TAVERN';
    // Mission briefing (and Agency) use the Heroes 4 Hire agency look.
    const fromAgency = returnTo === 'MISSION_BRIEFING' || returnTo === 'CASTLE';
    const detailScreen = document.getElementById('screen-party-detail');
    if (detailScreen) {
        detailScreen.classList.toggle('from-tavern', fromTavern);
        detailScreen.classList.toggle('from-agency', fromAgency);
    }

    // Top bar stays as the hub location you came from.
    const locationEl = document.getElementById('party-detail-location');
    if (locationEl) {
        if (fromTavern) locationEl.textContent = 'The Rusty Scabbard';
        else if (fromAgency) locationEl.textContent = 'Heroes 4 Hire';
        else locationEl.textContent = 'Party Details';
    }
    const goldWrap = document.getElementById('party-detail-gold-wrap');
    const goldEl = document.getElementById('party-detail-gold');
    if (goldWrap) goldWrap.style.display = (fromTavern || fromAgency) ? '' : 'none';
    if (goldEl) goldEl.textContent = playerGold;

    // Inside the frame: large party name, then smaller "Party N".
    const heading = document.getElementById('party-detail-heading');
    const sub = document.getElementById('party-detail-sub');
    if (heading) heading.textContent = party.name;
    if (sub) sub.textContent = `Party ${party.number}`;

    renderHeroCards(document.getElementById('party-detail-members'), party.members);
    switchScreen('PARTY_DETAIL');
}

// ==================== 3. STATE SYNC ====================

function getMyArenaParties() {
    return arenaParties.filter(ap => ap.faction === myFaction);
}

function getMyLivingArenaParties() {
    return getMyArenaParties().filter(ap => partyIsAlive(ap));
}

// Create or refresh localPlans when arena data arrives. Only wipe paths when told to.
function syncLocalPlansFromArena(resetPaths) {
    if (resetPaths) localPlans = {};

    getMyLivingArenaParties().forEach(ap => {
        if (!localPlans[ap.number]) {
            localPlans[ap.number] = { order: ap.order || 'Advance', path: [] };
        } else if (resetPaths) {
            localPlans[ap.number].order = ap.order || localPlans[ap.number].order || 'Advance';
            localPlans[ap.number].path = [];
        }
    });

    // Drop plans for parties that no longer exist or are dead.
    Object.keys(localPlans).forEach(key => {
        const num = Number(key);
        const ap = arenaParties.find(p => p.faction === myFaction && p.number === num);
        if (!ap || !partyIsAlive(ap)) delete localPlans[num];
    });

    // If the selected party was wiped, clear selection (token is gone from the map).
    if (selectedPartyUid) {
        const sel = arenaParties.find(p => p.uid === selectedPartyUid);
        if (!sel || !partyIsAlive(sel)) selectedPartyUid = null;
    }
}

function applyStateSync(data) {
    const serverRoom = data.roomState;

    // Client-only overlays (party detail / mission briefing) stay put while server is still in Castle/Tavern.
    if (currentRoomState === 'PARTY_DETAIL') {
        const okReturn = partyDetailReturnTo === 'MISSION_BRIEFING'
            ? (serverRoom === 'CASTLE')
            : (serverRoom === partyDetailReturnTo);
        if (serverRoom === 'TACTICAL_ARENA' || serverRoom === 'GAME_OVER' || serverRoom === 'LANDING') {
            switchScreen(serverRoom);
        } else if (!okReturn && serverRoom) {
            switchScreen(serverRoom);
        }
    } else if (currentRoomState === 'MISSION_BRIEFING') {
        if (serverRoom === 'TACTICAL_ARENA' || serverRoom === 'GAME_OVER' || serverRoom === 'LANDING') {
            switchScreen(serverRoom);
        } else if (serverRoom && serverRoom !== 'CASTLE' && serverRoom !== 'TOWN_HQ') {
            // stay on briefing while still in castle hub flow; Town means they navigated away
            if (serverRoom === 'TAVERN') switchScreen(serverRoom);
        } else if (serverRoom === 'TOWN_HQ') {
            switchScreen(serverRoom);
        }
        // CASTLE → keep briefing open
    } else if (serverRoom) {
        switchScreen(serverRoom);
    }

    if (data.lobby) {
        lobbyStatusText.p1 = data.lobby.players.p1 ? 'CONNECTED' : 'DISCONNECTED';
        lobbyStatusText.p2 = data.lobby.players.p2 ? 'CONNECTED' : 'DISCONNECTED';
        lobbyStatusText.readyP1 = data.lobby.readyStatus.p1;
        lobbyStatusText.readyP2 = data.lobby.readyStatus.p2;
        const p1El = document.getElementById('landing-p1-status');
        const p2El = document.getElementById('landing-p2-status');
        if (p1El) {
            p1El.textContent = lobbyStatusText.p1 === 'DISCONNECTED'
                ? 'DISCONNECTED'
                : (lobbyStatusText.readyP1 ? 'READY!' : 'CONNECTED');
        }
        if (p2El) {
            p2El.textContent = lobbyStatusText.p2 === 'DISCONNECTED'
                ? 'DISCONNECTED'
                : (lobbyStatusText.readyP2 ? 'READY!' : 'CONNECTED');
        }
    }

    if (data.player && data.player.faction === myFaction) {
        playerGold = data.player.gold;
        playerName = data.player.playerName || playerName;
        myParties = data.player.parties || [];
        currentOffer = data.player.offer || { name: '', members: [], cost: 0 };
        fieldedNumbers = data.player.fieldedNumbers || [];
        isWaitingForOpponentLaunch = !!data.player.launchPending;
    }

    if (data.arena) {
        // During move playback, ignore position snaps from STATE_SYNC (final state is applied after).
        if (!isPlayingRoundAnimation) {
            if (data.arena.currentRound) currentRound = data.arena.currentRound;
            if (data.arena.phase) arenaPhase = data.arena.phase;
            if (data.arena.parties) {
                updatePartyFacingFromPositions(data.arena.parties);
                arenaParties = data.arena.parties;
                // Regular sync: keep paths the player is still drawing unless phase just changed.
                syncLocalPlansFromArena(false);
            }
            if (data.arena.groundBooks) groundBooks = data.arena.groundBooks;
        } else if (data.arena.phase) {
            arenaPhase = data.arena.phase;
        }
        if (data.arena.maxRounds) maxRounds = data.arena.maxRounds;
        if (data.arena.deployment) {
            deploymentStatus.p1 = data.arena.deployment.p1 || deploymentStatus.p1;
            deploymentStatus.p2 = data.arena.deployment.p2 || deploymentStatus.p2;
        }
        if (data.arena.playerNames) {
            arenaPlayerNames = data.arena.playerNames;
        }
    }

    // Once we leave the landing screen, re-enable the join form.
    if (serverRoom && serverRoom !== 'LANDING') {
        setJoinWaitingState(false);
    }

    renderSyncedUI();
}

function renderSyncedUI() {
    const goldIds = ['hq-gold', 'tavern-gold', 'castle-gold', 'mission-gold', 'party-detail-gold'];
    goldIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = playerGold;
    });

    renderTavernRoster();

    const offerTitle = document.getElementById('tavern-offer-title');
    if (offerTitle) offerTitle.textContent = currentOffer.name || 'Available Contract';
    renderHeroCards(document.getElementById('tavern-offer'), currentOffer.members || []);

    renderMissionPartyList();

    // Icon buttons keep baked-in labels; only the gold cost span is updated.
    const hireBtn = document.getElementById('btn-hire-party');
    const hireCostEl = document.getElementById('hire-party-cost');
    if (hireBtn) {
        const hireCost = currentOffer.cost || 0;
        if (hireCostEl) hireCostEl.textContent = `- ${hireCost}g`;
        hireBtn.disabled = playerGold < hireCost || !(currentOffer.members || []).length;
    }
    const rerollBtn = document.getElementById('btn-reroll-offer');
    if (rerollBtn) rerollBtn.disabled = playerGold < 5;

    const waitEl = document.getElementById('castle-quest-wait');
    if (waitEl) waitEl.style.display = isWaitingForOpponentLaunch ? 'block' : 'none';

    const launchBtn = document.getElementById('btn-launch-quest');
    if (launchBtn) {
        launchBtn.disabled = isWaitingForOpponentLaunch || fieldedNumbers.length < 1;
    }

    const roundLabel = document.getElementById('arena-round-label');
    if (roundLabel) {
        roundLabel.textContent = arenaPhase === 'DEPLOYMENT'
            ? 'DEPLOYMENT: select a party, tap a bordered square in your zone, then READY'
            : `DAY: ${currentRound} / ${maxRounds}`;
    }

    renderArenaChrome();
    updateOrderButtons();
    updateOrderButtonsEnabled();
    updateLockTurnButton();
}

// HTML side panels + header (map itself stays on the canvas).
function renderArenaChrome() {
    const playerEl = document.getElementById('arena-header-player');
    if (playerEl) {
        playerEl.textContent = playerName || 'Hero';
        playerEl.style.color = getTeamColor(myFaction);
    }
    const phaseEl = document.getElementById('arena-header-phase');
    if (phaseEl) {
        phaseEl.textContent = arenaPhase === 'DEPLOYMENT'
            ? 'DEPLOYMENT PHASE'
            : `DAY: ${currentRound} / ${maxRounds}`;
    }

    const listHost = document.getElementById('arena-party-list-items');
    if (listHost) {
        listHost.innerHTML = '';
        const mine = getMyArenaParties().slice().sort((a, b) => a.number - b.number);
        const team = getTeamColor(myFaction);
        mine.forEach(ap => {
            const alive = partyIsAlive(ap);
            const living = ap.members.filter(m => m.hp > 0).length;
            const planOrder = (localPlans[ap.number] && localPlans[ap.number].order) || ap.order || 'Advance';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'arena-party-btn' + (selectedPartyUid === ap.uid ? ' selected' : '');
            btn.style.borderColor = selectedPartyUid === ap.uid ? team : '#444';
            btn.innerHTML = `<div style="color:${alive ? team : '#666'};font-weight:bold;">${ap.number}. ${ap.name}</div>`
                + `<div class="sub">${living}/${ap.members.length} standing  |  ${planOrder}</div>`;
            btn.addEventListener('click', () => {
                selectedPartyUid = ap.uid;
                updateOrderButtons();
                updateOrderButtonsEnabled();
                renderArenaChrome();
            });
            listHost.appendChild(btn);
        });
        if (!mine.length) {
            listHost.innerHTML = '<p style="color:rgba(255,248,231,0.75);">No parties fielded.</p>';
        }
    }

    const detailHost = document.getElementById('arena-party-detail-body');
    if (!detailHost) return;
    const selected = getSelectedArenaParty();
    if (!selected || selected.faction !== myFaction) {
        detailHost.innerHTML = '<p style="color:rgba(255,248,231,0.7);">Select a party from the list to view details.</p>';
        return;
    }
    const plan = localPlans[selected.number];
    const shownOrder = (plan && plan.order) || selected.order || 'Advance';
    // Header stays custom; member rows match Tavern / party-detail via renderHeroCards.
    detailHost.innerHTML =
        `<div style="color:${getTeamColor(myFaction)};font-weight:bold;font-size:14px;margin-bottom:6px;text-shadow:0 1px 2px rgba(0,0,0,0.75);">`
        + `${selected.number}. ${selected.name}</div>`
        + `<div style="color:rgba(255,248,231,0.8);margin-bottom:10px;">Order: ${shownOrder}</div>`
        + `<div id="arena-party-detail-members"></div>`;
    renderHeroCards(
        document.getElementById('arena-party-detail-members'),
        selected.members,
        { faction: selected.faction } // Blue/Red tinted portraits in the arena only
    );
}

function getSelectedArenaParty() {
    if (!selectedPartyUid) return null;
    return arenaParties.find(ap => ap.uid === selectedPartyUid) || null;
}

function getSelectedPlan() {
    const ap = getSelectedArenaParty();
    if (!ap) return null;
    if (!localPlans[ap.number]) {
        localPlans[ap.number] = { order: ap.order || 'Advance', path: [] };
    }
    return localPlans[ap.number];
}

function updateOrderButtons() {
    const plan = getSelectedPlan();
    const currentOrder = plan ? plan.order : 'Advance';
    document.querySelectorAll('.order-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.order === currentOrder);
    });
}

function updateLockTurnButton() {
    const btn = document.getElementById('btn-lock-turn');
    if (!btn) return;

    if (arenaPhase === 'DEPLOYMENT') {
        if (myFaction === 'spectator') {
            btn.disabled = true;
            btn.textContent = 'SPECTATING DEPLOYMENT...';
            return;
        }
        const mine = deploymentStatus[myFaction] || { placed: false, ready: false };
        if (!mine.placed) {
            btn.disabled = true;
            btn.textContent = 'Awaiting deployment..';
        } else if (!mine.ready) {
            btn.disabled = false;
            btn.textContent = 'READY';
        } else {
            btn.disabled = true;
            btn.textContent = 'Waiting for other player...';
        }
        return;
    }

    btn.disabled = isWaitingForCombatResolution || myFaction === 'spectator';
    btn.textContent = isWaitingForCombatResolution
        ? "WAITING FOR OPPONENT'S STRATEGY..."
        : 'LOCK IN ORDERS FOR THIS ROUND';
}

function updateOrderButtonsEnabled() {
    const enabled = arenaPhase === 'COMBAT' && myFaction !== 'spectator' && !!getSelectedArenaParty();
    document.querySelectorAll('.order-btn').forEach(btn => {
        btn.disabled = !enabled;
    });
}

function applyTavernSync(data) {
    playerGold = data.gold;
    currentOffer = data.offer || currentOffer;
    myParties = data.parties || myParties;
    renderSyncedUI();
}

// ==================== 4. TERRAIN & MOVEMENT HELPERS (PREVIEW ONLY) ====================

function getClientTileAt(x, y) {
    if (y < 0 || y >= ARENA_TILE_MAP.length) return null;
    if (x < 0 || x >= ARENA_TILE_MAP[y].length) return null;
    return ARENA_TILE_MAP[y][x];
}

function isClientBlockedTile(x, y) {
    const tile = getClientTileAt(x, y);
    return !tile || BLOCKED_TILES[tile] === true;
}

function getClientMovementCapacity(order, startX, startY) {
    const base = { Seek: 1, Advance: 3, March: 5 };
    let capacity = base[order] || 2;
    const tile = getClientTileAt(startX, startY);
    if (tile === 'DGY') capacity += 1;
    else if (tile === 'DG') capacity = Math.max(1, capacity - 1);
    return capacity;
}

function findClientBuildingAnchors() {
    const buildings = [];
    for (let y = 0; y < ARENA_TILE_MAP.length; y++) {
        for (let x = 0; x < ARENA_TILE_MAP[y].length; x++) {
            if (ARENA_TILE_MAP[y][x] === 'RED') buildings.push({ x, y });
        }
    }
    if (!buildings.length) return { left: null, right: null };
    let left = buildings[0];
    let right = buildings[0];
    buildings.forEach(b => {
        if (b.x < left.x || (b.x === left.x && b.y < left.y)) left = b;
        if (b.x > right.x || (b.x === right.x && b.y > right.y)) right = b;
    });
    return { left, right };
}

// Walkable cells in the 8-neighbour ring around your building (diagonals allowed).
function getClientDeployCells(faction) {
    const anchors = findClientBuildingAnchors();
    const anchor = faction === 'p1' ? anchors.left : anchors.right;
    if (!anchor) return [];
    const cells = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const x = anchor.x + dx;
            const y = anchor.y + dy;
            if (!isClientBlockedTile(x, y)) cells.push({ x, y });
        }
    }
    return cells;
}

function isClientValidDeployCell(faction, x, y) {
    return getClientDeployCells(faction).some(c => c.x === x && c.y === y);
}

function getOccupantAt(x, y, skipUid) {
    return arenaParties.find(ap =>
        ap.uid !== skipUid
        && ap.x === x
        && ap.y === y
        && partyIsAlive(ap)
    ) || null;
}

function isTileOccupiedByLiving(x, y, skipUid) {
    return getOccupantAt(x, y, skipUid) !== null;
}

// Thick outline around the outer edge of the local player's deploy zone (team colour).
function drawDeploymentBoundary(faction) {
    const cells = getClientDeployCells(faction);
    if (!cells.length) return;
    const set = new Set(cells.map(c => `${c.x},${c.y}`));
    const size = ARENA_GRID.cellSize;

    ctx.save();
    ctx.strokeStyle = getTeamColor(faction);
    ctx.lineWidth = 4;
    ctx.lineJoin = 'miter';

    cells.forEach(c => {
        const cx = ARENA_GRID.offsetX + (c.x * size);
        const cy = ARENA_GRID.offsetY + (c.y * size);
        if (!set.has(`${c.x},${c.y - 1}`)) {
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + size, cy); ctx.stroke();
        }
        if (!set.has(`${c.x},${c.y + 1}`)) {
            ctx.beginPath(); ctx.moveTo(cx, cy + size); ctx.lineTo(cx + size, cy + size); ctx.stroke();
        }
        if (!set.has(`${c.x - 1},${c.y}`)) {
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + size); ctx.stroke();
        }
        if (!set.has(`${c.x + 1},${c.y}`)) {
            ctx.beginPath(); ctx.moveTo(cx + size, cy); ctx.lineTo(cx + size, cy + size); ctx.stroke();
        }
    });
    ctx.restore();
}

// Trim a path so it does not end on an occupied tile (client preview rule).
function trimPathEndOccupied(path, skipUid) {
    const trimmed = path.slice();
    while (trimmed.length > 0) {
        const end = trimmed[trimmed.length - 1];
        if (isTileOccupiedByLiving(end.x, end.y, skipUid)) trimmed.pop();
        else break;
    }
    return trimmed;
}

// ==================== 5. SOCKET ACTIONS ====================

function rerollTavernOffer() {
    socket.emit('tavern-reroll', { faction: myFaction });
}

function hireTavernParty() {
    socket.emit('tavern-hire', { faction: myFaction });
}

function launchQuest() {
    socket.emit('LAUNCH_QUEST');
    isWaitingForOpponentLaunch = true;
    renderSyncedUI();
}

function submitDeployReady() {
    socket.emit('DEPLOY_READY', {});
}

function submitTurn() {
    if (arenaPhase !== 'COMBAT') return;

    const orders = [];
    getMyLivingArenaParties().forEach(ap => {
        const plan = localPlans[ap.number] || { order: ap.order || 'Advance', path: [] };
        orders.push({
            partyNumber: ap.number,
            order: plan.order || ap.order || 'Advance',
            path: trimPathEndOccupied(plan.path || [], ap.uid)
        });
    });

    socket.emit('submit-turn', { faction: myFaction, orders });
    isWaitingForCombatResolution = true;
    updateLockTurnButton();
}

function onLockOrReadyClick() {
    if (myFaction === 'spectator') return;
    if (arenaPhase === 'DEPLOYMENT') {
        const mine = deploymentStatus[myFaction];
        if (mine && mine.placed && !mine.ready) submitDeployReady();
        return;
    }
    if (arenaPhase === 'COMBAT') submitTurn();
}

// ==================== 6. ARENA CANVAS (map only) ====================

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Tile used for drawing (fractional while sliding between squares).
function getPartyDrawTile(ap) {
    if (animPosByUid && animPosByUid[ap.uid]) return animPosByUid[ap.uid];
    return { x: ap.x, y: ap.y };
}

function setFacingFromStep(uid, from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        if (dx > 0) partyLastMoveDir[uid] = 'right';
        else if (dx < 0) partyLastMoveDir[uid] = 'left';
    } else {
        if (dy > 0) partyLastMoveDir[uid] = 'down';
        else if (dy < 0) partyLastMoveDir[uid] = 'up';
    }
}

// Smooth slide for every party that moves this step (all at once).
function animateTimelineMoves(moves) {
    return new Promise(resolve => {
        if (!moves || !moves.length) {
            resolve();
            return;
        }
        if (!animPosByUid) animPosByUid = {};
        moves.forEach(m => {
            setFacingFromStep(m.uid, m.from, m.to);
            animPosByUid[m.uid] = { x: m.from.x, y: m.from.y };
            partyLastPos[m.uid] = { x: m.to.x, y: m.to.y };
        });
        const start = performance.now();
        function frame(now) {
            const t = Math.min(1, (now - start) / ROUND_MOVE_MS);
            moves.forEach(m => {
                animPosByUid[m.uid] = {
                    x: m.from.x + (m.to.x - m.from.x) * t,
                    y: m.from.y + (m.to.y - m.from.y) * t
                };
            });
            if (t < 1) {
                requestAnimationFrame(frame);
            } else {
                moves.forEach(m => {
                    animPosByUid[m.uid] = { x: m.to.x, y: m.to.y };
                });
                resolve();
            }
        }
        requestAnimationFrame(frame);
    });
}

function applyTimelinePartySnapshot(parties, books) {
    if (parties) {
        arenaParties = parties;
        arenaParties.forEach(ap => {
            if (!partyIsAlive(ap)) {
                if (animPosByUid) delete animPosByUid[ap.uid];
                return;
            }
            if (typeof ap.x === 'number' && typeof ap.y === 'number') {
                if (animPosByUid) animPosByUid[ap.uid] = { x: ap.x, y: ap.y };
                partyLastPos[ap.uid] = { x: ap.x, y: ap.y };
            }
        });
    }
    if (books) groundBooks = books;
    renderSyncedUI();
}

function terrainColorForCombatTile(tileInfo) {
    if (!tileInfo) return '#333';
    const terrain = tileInfo.terrain;
    if (terrain === 'RED') {
        const anchors = findClientBuildingAnchors();
        if (anchors.left && anchors.left.x === tileInfo.x && anchors.left.y === tileInfo.y) {
            return TEAM_COLORS.p1;
        }
        if (anchors.right && anchors.right.x === tileInfo.x && anchors.right.y === tileInfo.y) {
            return TEAM_COLORS.p2;
        }
        return ARENA_TILE_COLORS.RED;
    }
    return ARENA_TILE_COLORS[terrain] || '#333';
}

function randomCombatHeroPos() {
    // Min 10% from left/right/bottom; min 40% from top → y in [40%, 90%], x in [10%, 90%]
    return {
        left: 10 + Math.random() * 80,
        top: 40 + Math.random() * 50
    };
}

function placeCombatTheatreHeroes(halfEl, party) {
    halfEl.innerHTML = '';
    if (!party || !party.members) return;
    const used = [];
    party.members.forEach((member, memberIndex) => {
        if (!member || member.hp <= 0) return;
        const teamArt = HERO_PORTRAITS_TEAM[member.role];
        const src = teamArt ? teamArt[party.faction] : null;
        if (!src) return;

        let pos = randomCombatHeroPos();
        for (let attempt = 0; attempt < 8; attempt++) {
            const clash = used.some(u =>
                Math.abs(u.left - pos.left) < 14 && Math.abs(u.top - pos.top) < 16
            );
            if (!clash) break;
            pos = randomCombatHeroPos();
        }
        used.push(pos);

        const img = document.createElement('img');
        img.className = 'combat-theatre-hero';
        img.src = src;
        img.alt = member.role;
        img.dataset.uid = party.uid;
        img.dataset.memberIndex = String(memberIndex);
        img.style.left = pos.left + '%';
        img.style.top = pos.top + '%';
        img.style.transform = 'translate(-50%, -50%)';
        halfEl.appendChild(img);
    });
}

function getCombatTheatreHeroEl(uid, memberIndex) {
    return document.querySelector(
        `.combat-theatre-hero[data-uid="${uid}"][data-member-index="${memberIndex}"]`
    );
}

function openCombatTheatre(combat) {
    return new Promise(resolve => {
        const theatre = document.getElementById('combat-theatre');
        const leftHalf = document.getElementById('combat-half-left');
        const rightHalf = document.getElementById('combat-half-right');
        if (!theatre || !leftHalf || !rightHalf) {
            resolve();
            return;
        }

        const leftParty = arenaParties.find(p => p.uid === combat.leftUid);
        const rightParty = arenaParties.find(p => p.uid === combat.rightUid);

        leftHalf.style.background = terrainColorForCombatTile(combat.leftTile);
        rightHalf.style.background = terrainColorForCombatTile(combat.rightTile);
        placeCombatTheatreHeroes(leftHalf, leftParty);
        placeCombatTheatreHeroes(rightHalf, rightParty);

        theatre.classList.add('is-open');
        theatre.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            theatre.classList.add('is-expanded');
            setTimeout(resolve, COMBAT_OPEN_MS);
        });
    });
}

function closeCombatTheatre() {
    return new Promise(resolve => {
        const theatre = document.getElementById('combat-theatre');
        if (!theatre) {
            resolve();
            return;
        }
        theatre.classList.remove('is-expanded');
        setTimeout(() => {
            theatre.classList.remove('is-open');
            theatre.setAttribute('aria-hidden', 'true');
            const leftHalf = document.getElementById('combat-half-left');
            const rightHalf = document.getElementById('combat-half-right');
            if (leftHalf) leftHalf.innerHTML = '';
            if (rightHalf) rightHalf.innerHTML = '';
            resolve();
        }, COMBAT_CLOSE_MS);
    });
}

function spawnTheatreFloat(heroEl, damage, color, kind) {
    if (!heroEl || !heroEl.parentElement) return;
    const floatEl = document.createElement('div');
    floatEl.className = 'combat-theatre-float';
    floatEl.style.color = color;
    floatEl.style.left = heroEl.style.left;
    floatEl.style.top = heroEl.style.top;
    const icon = kind === 'ranged' ? '➳' : '⚔';
    floatEl.textContent = `${damage} ${icon}`;
    heroEl.parentElement.appendChild(floatEl);
    setTimeout(() => floatEl.remove(), COMBAT_FLOAT_MS);
}

async function playStrikeUnitHits(strike) {
    const hits = strike.unitHits || [];
    const color = getTeamColor(strike.attackerFaction);
    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const heroEl = getCombatTheatreHeroEl(strike.defenderUid, hit.memberIndex);
        spawnTheatreFloat(heroEl, hit.damage, color, strike.kind);
        if (hit.knockedOut && heroEl) {
            heroEl.classList.add('is-ko');
            heroEl.style.transform = 'translate(-50%, -50%) rotate(90deg)';
        }
        await sleepMs(COMBAT_FLOAT_MS);
    }
}

async function playTheatreWave(wave) {
    const strikes = wave.strikes || [];
    if (!strikes.length) return;
    await Promise.all(strikes.map(strike => playStrikeUnitHits(strike)));
}

async function playStepCombats(combats) {
    if (!combats || !combats.length) return;
    for (let c = 0; c < combats.length; c++) {
        const combat = combats[c];
        await sleepMs(COMBAT_PAUSE_MS);
        await openCombatTheatre(combat);

        const waves = combat.waves || [];
        let lastWave = null;
        for (let w = 0; w < waves.length; w++) {
            lastWave = waves[w];
            await playTheatreWave(lastWave);
        }

        if (lastWave) {
            applyTimelinePartySnapshot(lastWave.arenaParties, lastWave.groundBooks);
        }
        await closeCombatTheatre();
    }
}

async function playResolveTimeline(timeline) {
    if (!animPosByUid) animPosByUid = {};
    arenaParties.forEach(ap => {
        if (typeof ap.x === 'number' && typeof ap.y === 'number') {
            animPosByUid[ap.uid] = { x: ap.x, y: ap.y };
        }
    });

    for (let i = 0; i < timeline.length; i++) {
        const step = timeline[i];
        await animateTimelineMoves(step.moves || []);

        (step.moves || []).forEach(m => {
            animPosByUid[m.uid] = { x: m.to.x, y: m.to.y };
            const ap = arenaParties.find(p => p.uid === m.uid);
            if (ap) {
                ap.x = m.to.x;
                ap.y = m.to.y;
            }
            partyLastPos[m.uid] = { x: m.to.x, y: m.to.y };
        });

        await playStepCombats(step.combats || []);
        applyTimelinePartySnapshot(step.arenaParties, step.groundBooks);

        const isLast = i === timeline.length - 1;
        if (!isLast) {
            await sleepMs(ROUND_STEP_GAP_MS);
        }
    }
}

function finishRoundAnimation(data) {
    const nextParties = data.arenaParties || arenaParties;
    updatePartyFacingFromPositions(nextParties);
    arenaParties = nextParties;
    if (data.groundBooks) groundBooks = data.groundBooks;
    if (data.nextRound) currentRound = data.nextRound;

    getMyLivingArenaParties().forEach(ap => {
        localPlans[ap.number] = {
            order: ap.order || 'Advance',
            path: []
        };
    });

    animPosByUid = null;
    isPlayingRoundAnimation = false;
    isWaitingForCombatResolution = false;
    updateLockTurnButton();
    renderSyncedUI();

    if (pendingGameOverSummary) {
        const summary = pendingGameOverSummary;
        pendingGameOverSummary = null;
        applyGameOverSummary(summary);
    }
}

function applyGameOverSummary(data) {
    switchScreen('GAME_OVER');
    const banner = document.getElementById('game-over-banner');
    if (banner) {
        banner.textContent = data.result;
        if (data.result === 'VICTORY' || data.result === 'MINOR VICTORY') {
            banner.className = 'outcome-banner outcome-victory';
        } else if (data.result === 'DRAW') {
            banner.className = 'outcome-banner outcome-draw';
        } else {
            banner.className = 'outcome-banner outcome-defeat';
        }
    }
    const detailEl = document.getElementById('game-over-detail');
    if (detailEl) detailEl.textContent = data.detail || '';
    const goldEl = document.getElementById('game-over-gold');
    if (goldEl) goldEl.textContent = data.goldEarned;
}

function drawArenaScreen() {
    const selected = getSelectedArenaParty();

    // Path highlight for the selected party (combat only).
    const selectedPlan = getSelectedPlan();
    const pathHighlight = (arenaPhase === 'COMBAT' && selectedPlan) ? selectedPlan.path : [];

    // Fog of War: tiles within 2 travel steps of any living friendly party.
    const visibleTiles = buildVisibleTileSet();

    // Home towers: map data still uses RED tile codes, but we paint left=Blue / right=Red.
    const buildingAnchors = findClientBuildingAnchors();

    // --- Grid tiles ---
    for (let y = 0; y < ARENA_GRID.height; y++) {
        for (let x = 0; x < ARENA_GRID.width; x++) {
            const cx = ARENA_GRID.offsetX + (x * ARENA_GRID.cellSize);
            const cy = ARENA_GRID.offsetY + (y * ARENA_GRID.cellSize);
            const tile = ARENA_TILE_MAP[y][x];
            const fogged = !isTileVisible(visibleTiles, x, y);

            let fill = ARENA_TILE_COLORS[tile] || ARENA_TILE_COLORS.LG;
            if (tile === 'RED') {
                if (buildingAnchors.left && buildingAnchors.left.x === x && buildingAnchors.left.y === y) {
                    fill = TEAM_COLORS.p1; // leftmost home = Blue
                } else if (buildingAnchors.right && buildingAnchors.right.x === x && buildingAnchors.right.y === y) {
                    fill = TEAM_COLORS.p2; // rightmost home = Red
                }
            }
            ctx.fillStyle = fill;
            ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);

            // Darken tiles outside your vision so fog is obvious
            if (fogged) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
            }

            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.strokeRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);

            if (pathHighlight.some(c => c.x === x && c.y === y)) {
                ctx.fillStyle = myFaction === 'p1'
                    ? 'rgba(30, 136, 229, 0.35)'
                    : 'rgba(214, 40, 40, 0.35)';
                ctx.fillRect(cx + 2, cy + 2, ARENA_GRID.cellSize - 4, ARENA_GRID.cellSize - 4);
            }
        }
    }

    // Draw a small book shape in the OWNER tower's colour (emoji ignore fillStyle).
    // So a Red spell book stays red whether Blue or Red is holding it.
    function drawSpellBookIcon(centerX, centerY, ownerFaction) {
        const bookColor = getTeamColor(ownerFaction);
        const w = 14;
        const h = 16;
        const x = centerX - w / 2;
        const y = centerY - h / 2;
        ctx.fillStyle = bookColor;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
        // Spine line
        ctx.beginPath();
        ctx.moveTo(centerX, y + 2);
        ctx.lineTo(centerX, y + h - 2);
        ctx.stroke();
        // Tiny pages hint
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 4);
        ctx.lineTo(x + w - 3, y + 4);
        ctx.stroke();
    }

    // Ground spell books — only on tiles you can see
    groundBooks.forEach(book => {
        if (!isTileVisible(visibleTiles, book.x, book.y)) return;
        const cx = ARENA_GRID.offsetX + (book.x * ARENA_GRID.cellSize) + ARENA_GRID.cellSize / 2;
        const cy = ARENA_GRID.offsetY + (book.y * ARENA_GRID.cellSize) + 14;
        drawSpellBookIcon(cx, cy, book.ownerFaction);
    });

    // --- Party tokens: 2×2 team portraits (living members only; enemies hidden in fog) ---
    arenaParties.forEach(ap => {
        if (typeof ap.x !== 'number' || typeof ap.y !== 'number') return;
        // Defeated parties leave the board entirely
        if (!partyIsAlive(ap)) return;

        const drawTile = getPartyDrawTile(ap);
        const fogX = Math.round(drawTile.x);
        const fogY = Math.round(drawTile.y);

        const isFriendly = ap.faction === myFaction;
        // Enemies only appear on tiles inside your fog vision
        if (!isFriendly && !isTileVisible(visibleTiles, fogX, fogY)) return;

        const cx = ARENA_GRID.offsetX + (drawTile.x * ARENA_GRID.cellSize);
        const cy = ARENA_GRID.offsetY + (drawTile.y * ARENA_GRID.cellSize);
        drawPartySpritesOnTile(ap, cx, cy);

        // Carried book above the tile — ALWAYS the book owner's colour (not the carrier's)
        if (ap.carryingBook) {
            drawSpellBookIcon(
                cx + ARENA_GRID.cellSize / 2,
                cy + 4,
                ap.carryingBook
            );
        }
    });

    // Outline on the selected living party's tile (deployment AND combat).
    if (selected && partyIsAlive(selected) && typeof selected.x === 'number' && typeof selected.y === 'number') {
        const drawTile = getPartyDrawTile(selected);
        const cx = ARENA_GRID.offsetX + (drawTile.x * ARENA_GRID.cellSize);
        const cy = ARENA_GRID.offsetY + (drawTile.y * ARENA_GRID.cellSize);
        ctx.save();
        ctx.strokeStyle = getTeamColor(selected.faction);
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, cy + 1, ARENA_GRID.cellSize - 2, ARENA_GRID.cellSize - 2);
        ctx.restore();
    }

    // Deploy boundary in your team colour during deployment.
    if (arenaPhase === 'DEPLOYMENT' && (myFaction === 'p1' || myFaction === 'p2')) {
        drawDeploymentBoundary(myFaction);
    }

}

function renderActiveScene() {
    if (currentRoomState !== 'TACTICAL_ARENA') return;
    syncArenaCanvasSize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawArenaScreen();
}

function startGameLoop() {
    function tick() {
        renderActiveScene();
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

function loadGameAssets() {
    syncArenaCanvasSize();
    preloadArenaPortraits();
    startGameLoop();
    switchScreen('LANDING');
}

// ==================== 7. DOM EVENT WIRING ====================

function setJoinWaitingState(waiting) {
    const joinBtn = document.getElementById('btn-join-game');
    const nameInput = document.getElementById('input-player-name');
    const codeInput = document.getElementById('input-room-code');
    if (!joinBtn) return;

    joinBtn.disabled = waiting;
    joinBtn.textContent = waiting ? 'Waiting for other player' : 'JOIN GAME';
    if (nameInput) nameInput.disabled = waiting;
    if (codeInput) codeInput.disabled = waiting;
}

function wireNavigationButtons() {
    document.getElementById('btn-join-game').addEventListener('click', () => {
        // User gesture: best chance for fullscreen + orientation.lock on mobile.
        tryLockLandscape();
        const joinBtn = document.getElementById('btn-join-game');
        if (joinBtn.disabled) return;

        const name = document.getElementById('input-player-name').value.trim();
        const code = document.getElementById('input-room-code').value.trim();
        if (!name || !code) return;

        playerName = name;
        setJoinWaitingState(true);
        socket.emit('JOIN_GAME', { playerName: name, roomCode: code });
    });

    document.getElementById('btn-go-tavern').addEventListener('click', () => {
        socket.emit('NAVIGATE_TO', { targetRoom: 'TAVERN' });
    });
    document.getElementById('btn-go-castle').addEventListener('click', () => {
        socket.emit('NAVIGATE_TO', { targetRoom: 'CASTLE' });
    });
    document.getElementById('btn-tavern-return-hq').addEventListener('click', () => {
        socket.emit('NAVIGATE_TO', { targetRoom: 'TOWN_HQ' });
    });
    document.getElementById('btn-castle-return-hq').addEventListener('click', () => {
        socket.emit('NAVIGATE_TO', { targetRoom: 'TOWN_HQ' });
    });
    document.getElementById('btn-return-to-hq').addEventListener('click', () => {
        socket.emit('RETURN_TO_HQ', {});
    });

    document.getElementById('btn-party-detail-back').addEventListener('click', () => {
        // Back is local only — do not tell the server to navigate.
        switchScreen(partyDetailReturnTo || 'CASTLE');
    });

    const missionCard = document.getElementById('mission-card-two-wizards');
    if (missionCard) {
        missionCard.addEventListener('click', () => openMissionBriefing());
    }
    document.getElementById('btn-mission-briefing-back').addEventListener('click', () => {
        switchScreen('CASTLE');
    });

    document.getElementById('btn-hire-party').addEventListener('click', hireTavernParty);
    document.getElementById('btn-reroll-offer').addEventListener('click', rerollTavernOffer);
    document.getElementById('btn-launch-quest').addEventListener('click', launchQuest);

    document.querySelectorAll('.order-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (arenaPhase !== 'COMBAT') return;
            const ap = getSelectedArenaParty();
            if (!ap || ap.faction !== myFaction) return;

            const order = btn.dataset.order;
            if (!localPlans[ap.number]) {
                localPlans[ap.number] = { order: 'Advance', path: [] };
            }
            localPlans[ap.number].order = order;
            localPlans[ap.number].path = [];
            updateOrderButtons();
            renderArenaChrome();
        });
    });

    document.getElementById('btn-lock-turn').addEventListener('click', onLockOrReadyClick);
}

// Map a pointer event to canvas bitmap coordinates (grid × cellSize).
function canvasPointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

// Convert a pointer event on the canvas into grid coordinates.
function canvasCellFromEvent(event) {
    const pt = canvasPointFromEvent(event);
    if (!pt) return null;
    const cellX = Math.floor((pt.x - ARENA_GRID.offsetX) / ARENA_GRID.cellSize);
    const cellY = Math.floor((pt.y - ARENA_GRID.offsetY) / ARENA_GRID.cellSize);
    if (cellX < 0 || cellX >= ARENA_GRID.width || cellY < 0 || cellY >= ARENA_GRID.height) return null;
    return { x: cellX, y: cellY };
}

function handleArenaPointer(event) {
    if (currentRoomState !== 'TACTICAL_ARENA' || myFaction === 'spectator' || !matchActive) return;

    const cell = canvasCellFromEvent(event);
    if (!cell) return;
    const { x: cellX, y: cellY } = cell;

    const selected = getSelectedArenaParty();
    if (!selected || selected.faction !== myFaction) return;

    // --- Deployment: move selected party to a valid empty cell ---
    if (arenaPhase === 'DEPLOYMENT') {
        const mine = deploymentStatus[myFaction];
        if (mine && mine.ready) return;
        if (!isClientValidDeployCell(myFaction, cellX, cellY)) return;
        if (isTileOccupiedByLiving(cellX, cellY, selected.uid)) return;

        selected.x = cellX;
        selected.y = cellY;
        socket.emit('DEPLOY_PLACE', { partyNumber: selected.number, x: cellX, y: cellY });
        updateLockTurnButton();
        renderArenaChrome();
        return;
    }

    // --- Combat: build a movement path preview for the selected party only ---
    if (arenaPhase !== 'COMBAT') return;
    if (typeof selected.x !== 'number' || typeof selected.y !== 'number') return;

    const plan = getSelectedPlan();
    if (!plan) return;

    const path = plan.path;
    const currentOrder = plan.order || 'Advance';
    const maxCapacity = getClientMovementCapacity(currentOrder, selected.x, selected.y);

    // Clicking an already-selected cell trims the path back to that point.
    const existingIndex = path.findIndex(c => c.x === cellX && c.y === cellY);
    if (existingIndex !== -1) {
        plan.path = path.slice(0, existingIndex);
        return;
    }
    if (path.length >= maxCapacity) return;
    if (isClientBlockedTile(cellX, cellY)) return;

    const occupant = getOccupantAt(cellX, cellY, selected.uid);
    // Enemy tiles are never enterable. Friendly tiles are pass-through only (cannot END on them).
    if (occupant && occupant.faction !== myFaction) return;
    if (occupant && occupant.faction === myFaction && path.length + 1 >= maxCapacity) return;

    const anchorX = path.length === 0 ? selected.x : path[path.length - 1].x;
    const anchorY = path.length === 0 ? selected.y : path[path.length - 1].y;

    // Only one orthogonal step at a time (no diagonals).
    if (Math.abs(cellX - anchorX) + Math.abs(cellY - anchorY) === 1) {
        plan.path = path.concat([{ x: cellX, y: cellY }]);
    }
}

// Ignore drags so scrolling the map frame does not also place a party.
let arenaPointerDown = null;
canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    arenaPointerDown = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!arenaPointerDown) return;
    const dx = Math.abs(event.clientX - arenaPointerDown.x);
    const dy = Math.abs(event.clientY - arenaPointerDown.y);
    arenaPointerDown = null;
    if (dx > 10 || dy > 10) return;
    handleArenaPointer(event);
});
canvas.addEventListener('pointercancel', () => { arenaPointerDown = null; });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

// ==================== 8. SOCKET LISTENERS ====================

socket.on('assign-player', (data) => { myFaction = data.faction; });

socket.on('lobby-status', (data) => {
    lobbyStatusText.p1 = data.players.p1 ? 'CONNECTED' : 'DISCONNECTED';
    lobbyStatusText.p2 = data.players.p2 ? 'CONNECTED' : 'DISCONNECTED';
    lobbyStatusText.readyP1 = data.readyStatus.p1;
    lobbyStatusText.readyP2 = data.readyStatus.p2;
    renderSyncedUI();
});

socket.on('ROOM_TRANSITION', (payload) => {
    // Party detail is client-only — not driven by ROOM_TRANSITION.
    if (payload.newState === 'TACTICAL_ARENA' || payload.newState === 'GAME_OVER') {
        switchScreen(payload.newState);
    } else if (currentRoomState !== 'PARTY_DETAIL') {
        switchScreen(payload.newState);
    }
});

socket.on('STATE_SYNC', (data) => { applyStateSync(data); });

socket.on('transition-stage', (data) => {
    if (data.stage === 'combat-arena') {
        resetPartyVisualState();
        groundBooks = [];
        arenaPhase = 'DEPLOYMENT';
        arenaParties = data.arenaParties || [];
        updatePartyFacingFromPositions(arenaParties);
        selectedPartyUid = null;
        localPlans = {};
        syncLocalPlansFromArena(true);
        // Auto-select the lowest party number so the right panel isn't empty.
        const mine = getMyArenaParties().slice().sort((a, b) => a.number - b.number);
        if (mine.length) selectedPartyUid = mine[0].uid;
        deploymentStatus = {
            p1: { placed: false, ready: false },
            p2: { placed: false, ready: false }
        };
        isWaitingForCombatResolution = false;
        isWaitingForOpponentLaunch = false;
        switchScreen('TACTICAL_ARENA');
        renderSyncedUI();
    }
});

socket.on('tavern-sync', (data) => { applyTavernSync(data); });

socket.on('GAME_OVER_SUMMARY', (data) => {
    // Let movement / fight pauses finish before leaving the arena.
    if (isPlayingRoundAnimation) {
        pendingGameOverSummary = data;
        return;
    }
    applyGameOverSummary(data);
});

socket.on('resolve-round', async (data) => {
    // Combat log UI removed — dump to the browser console for debugging.
    if (data.log) {
        const plain = String(data.log)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '');
        console.log('[Combat Arena]\n' + plain);
    }

    // Clear path previews immediately so they don't linger over the slides.
    Object.keys(localPlans).forEach(num => {
        if (localPlans[num]) localPlans[num].path = [];
    });

    const timeline = Array.isArray(data.timeline) ? data.timeline : [];
    isPlayingRoundAnimation = true;
    isWaitingForCombatResolution = true;
    updateLockTurnButton();

    // Restore pre-fight HP/positions so KO'd heroes stay drawn until their damage float.
    if (Array.isArray(data.partiesAtStart) && data.partiesAtStart.length) {
        arenaParties = data.partiesAtStart;
        animPosByUid = {};
        arenaParties.forEach(ap => {
            if (typeof ap.x === 'number' && typeof ap.y === 'number') {
                animPosByUid[ap.uid] = { x: ap.x, y: ap.y };
                partyLastPos[ap.uid] = { x: ap.x, y: ap.y };
            }
        });
        renderSyncedUI();
    }

    try {
        if (timeline.length > 0) {
            await playResolveTimeline(timeline);
        }
    } catch (err) {
        console.error('[Combat Arena] timeline playback failed', err);
    }

    finishRoundAnimation(data);
});

// Show this PC's LAN URLs so a second player on Wi-Fi knows what to open.
function loadLanHostInfo() {
    const el = document.getElementById('lan-host-urls');
    if (!el) return;
    fetch('/api/host-info')
        .then(r => r.json())
        .then(info => {
            const lines = [];
            if (info.lanUrls && info.lanUrls.length) {
                info.lanUrls.forEach(url => lines.push(url));
            } else {
                lines.push('(No LAN IP found — use Wi-Fi/Ethernet, or open localhost on this PC)');
            }
            lines.push(info.localhostUrl + ' (this PC only)');
            el.innerHTML = lines.map(u => `<div style="margin:4px 0;">${u}</div>`).join('');
        })
        .catch(() => {
            el.textContent = 'Could not load host address. Check the server console.';
        });
}

wireNavigationButtons();
loadGameAssets();
loadLanHostInfo();
updateRotateOverlay();
function refitResponsiveLayouts() {
    updateRotateOverlay();
    requestAnimationFrame(() => {
        fitMapCanvasInFrame();
        fitTownStage();
        fitTavernStage();
        fitAgencyStage();
        fitMissionBriefingStage();
        fitPartyDetailStage();
    });
}
window.addEventListener('orientationchange', refitResponsiveLayouts);
window.addEventListener('resize', refitResponsiveLayouts);
if (screen.orientation) {
    screen.orientation.addEventListener('change', refitResponsiveLayouts);
}
document.addEventListener('fullscreenchange', refitResponsiveLayouts);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', refitResponsiveLayouts);
}
