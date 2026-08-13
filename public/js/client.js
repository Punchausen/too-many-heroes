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
// Place Parties / Day N title card — blocks arena input while playing.
let arenaTitleCardBlocking = false;
let arenaTitleCardQueue = Promise.resolve();
let lastArenaTitleDayShown = 0; // 0 = none yet this match; 1–10 = last day card shown
let prevArenaPhaseForTitle = null;
let matchActive = true;

// Round resolution playback (server still owns outcomes; we only animate them).
const ROUND_MOVE_MS = 500;        // slide duration for one square
const COMBAT_PAUSE_MS = 500;      // brief pause before pre-fight telegraph
const COMBAT_TELEGRAPH_JUMP_MS = 300;  // unison jump before the fight window
const COMBAT_TELEGRAPH_ICON_HOLD_MS = 500; // ! / ? stay up this long after landing
const COMBAT_OPEN_MS = 500;       // window expands from centre
const COMBAT_CLOSE_MS = 500;      // window collapses to centre
const COMBAT_FLOAT_MS = 1000;     // per-hero damage float duration
const COMBAT_RANGED_POSE_MS = 1000;   // hold _attack frame while shooting
const COMBAT_RANGED_FLIGHT_MS = 420;  // projectile travel time (impact then)
const COMBAT_MELEE_LEAP_MS = 500;     // leap out / leap back each
const CASUALTY_THEATRE_ARC_MS = 1000; // knockback arch in the fight window
const CASUALTY_MAP_TIP_MS = 500;      // tip-to-fall on arena / info panel after the fight
const SLEEP_ZZZ_FRAME_MS = 1500;      // sleep_1 ↔ sleep_2 over unconscious heroes
// Must match server.js INITIATIVE_ORDER (lower number strikes first).
const ORDER_INITIATIVE = { Guard: 1, Advance: 2, March: 3 };
let isPlayingRoundAnimation = false;
// While animating: fractional tile positions { [uid]: { x, y } }. Null = use server ints.
let animPosByUid = null;
// If GAME_OVER arrives mid-animation, show it after the slides finish.
let pendingGameOverSummary = null;
// Unconscious heroes left on the map where they fell (do not move with their party).
// { id, role, faction, x, y, faceLeft, ox, oy, phase: 'tipping'|'sleep', tipStart }
let groundCasualties = [];
// KOs finished in the fight window; tip on the map when that window closes.
let pendingMapFalls = [];
// Info-panel tip anims: key `${uid}:${memberIndex}` → tipStart ms
let panelCasualtyTips = {};
// Pre-fight jump + !/? icons: { start, parties: [{ uid, icon: 'exclamation'|'question' }] }
let combatTelegraph = null;

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
    ['DG','LG','DGY','DG','DG','LG','LG','LG','LG','LG','LG'],
    ['DG','LG','DGY','LG','LG','LG','DG','DG','DG','LG','LG'],
    ['LG','LG','DGY','DGY','DGY','DGY','DGY','DGY','DGY','LG','DG'],
    ['LG','LG','LG','LG','LG','DG','DG','DG','DGY','LG','DG'],
    ['LG','LG','LGY','LGY','LG','LG','LG','LG','DGY','RED','LG'],
    ['DG','DG','LGY','DG','LG','DG','DG','LG','LG','LG','LG'],
    ['DG','DG','LG','LG','LG','DG','DG','LG','LG','LG','LG']
];
// Fixed grass art for LG, DG, and mountain (LGY) floors (1–7 → grass_N.png). 0 = no grass.
// Same layout for both players — like ARENA_TILE_MAP, not rolled per session.
// No two matching variants share an up/down/left/right edge.
const GRASS_VARIANT_MAP = [
    [6, 1, 3, 5, 6, 4, 5, 4, 2, 4, 3],
    [1, 2, 7, 1, 5, 1, 3, 6, 1, 6, 2],
    [2, 0, 0, 3, 4, 2, 7, 1, 4, 7, 4],
    [3, 7, 0, 5, 7, 4, 5, 6, 3, 1, 2],
    [4, 5, 0, 1, 2, 7, 3, 2, 6, 5, 7],
    [5, 1, 0, 0, 0, 0, 0, 0, 0, 6, 4],
    [3, 7, 3, 4, 1, 5, 1, 3, 0, 3, 5],
    [7, 2, 7, 1, 6, 1, 6, 7, 0, 0, 3],
    [2, 7, 4, 7, 2, 5, 4, 2, 3, 6, 2],
    [5, 6, 1, 5, 7, 4, 3, 4, 1, 3, 5]
];
// Fixed tree art on forest (DG) tiles (1–3 → tree_N.png). 0 = not forest.
// No matching trees on orthogonal forest neighbours; lower trees draw on top of upper ones.
const TREE_VARIANT_MAP = [
    [0, 0, 0, 0, 1, 3, 0, 0, 0, 1, 3],
    [0, 0, 0, 0, 2, 1, 0, 0, 0, 2, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [2, 0, 0, 2, 3, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 1, 3, 2, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 1, 2, 3, 0, 0, 2],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [2, 1, 0, 1, 0, 3, 2, 0, 0, 0, 0],
    [3, 2, 0, 0, 0, 1, 3, 0, 0, 0, 0]
];
// Fixed upward nudge per forest tree (fraction of tile height, 15%–25%).
// Same for both players — keeps trunks from sitting flush on the tile edge.
const TREE_LIFT_MAP = [
    [0, 0, 0, 0, 0.23, 0.19, 0, 0, 0, 0.19, 0.19],
    [0, 0, 0, 0, 0.24, 0.16, 0, 0, 0, 0.16, 0.19],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0.25, 0, 0, 0.19, 0.25, 0, 0, 0, 0, 0, 0],
    [0.18, 0, 0, 0, 0, 0, 0.33, 0.38, 0.31, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.15],
    [0, 0, 0, 0, 0, 0.19, 0.18, 0.18, 0, 0, 0.19],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0.20, 0.19, 0, 0.18, 0, 0.18, 0.17, 0, 0, 0, 0],
    [0.20, 0.21, 0, 0, 0, 0.21, 0.17, 0, 0, 0, 0]
];
// Fixed rock art on mountain (LGY) tiles (1–3 → rock_N.png). 0 = not mountain.
// Each mountain cluster of 3 uses one of each rock type (fixed shuffle per cluster).
const ROCK_VARIANT_MAP = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
];
// Fixed upward nudge per mountain rock (fraction of tile height, 10%–20%).
const ROCK_LIFT_MAP = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0.19, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0.10, 0.12, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.13, 0.19, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.11, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
];
// Fixed road art on DGY + wizard-tower (RED) cells (1–3 → road_N.png). 0 = neither.
// No matching variants on orthogonal road/tower neighbours.
const ROAD_VARIANT_MAP = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 3, 2, 1, 2, 3, 2, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
];
// Wizard towers sit this fraction of a tile up from the bottom (width = one tile).
const TOWER_LIFT_FRAC = 0.20;
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
        // One-shot home camera when first entering the arena (not on every resize).
        pendingArenaScrollHome = true;
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
// Set once on arena entry: Blue (p1) top-left, Red (p2) bottom-right when the map overflows.
let pendingArenaScrollHome = false;

function applyInitialArenaViewIfNeeded() {
    if (!pendingArenaScrollHome) return;
    const frame = document.getElementById('arena-map-scroll');
    if (!frame || currentRoomState !== 'TACTICAL_ARENA') return;
    if (frame.clientWidth <= 0 || frame.clientHeight <= 0) return; // layout not ready — retry on next fit

    pendingArenaScrollHome = false;
    if (myFaction === 'p2') {
        frame.scrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
        frame.scrollTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
    } else {
        // Blue (p1) and spectators: top-left.
        frame.scrollLeft = 0;
        frame.scrollTop = 0;
    }
}

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

    applyInitialArenaViewIfNeeded();
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
// Frame 1 = idle stand; frame 2 = short fidget (_2.png).
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

// Idle fidget: every 20s show frame 2 for 0.5s. Each unit has its own random phase.
const IDLE_ANIM_PERIOD_MS = 20000;
const IDLE_ANIM_FLASH_MS = 500;
// key = `${partyUid}:${memberIndex}` → phase offset in [0, PERIOD)
const heroIdlePhaseByKey = {};

// South-Park-style walk: lean ±10°, bob 5% of sprite height, loop while sliding.
const WALK_CYCLE_MS = 160;
const WALK_LEAN_DEG = 10;
const WALK_BOB_FRAC = 0.05;
// Per-hero walk phase (0–1) and starting lean direction (±1).
const heroWalkPhaseByKey = {};
// Party uids currently mid-slide (walk cycle on; idle fidget off).
const walkAnimActiveUids = {};

function teamPortraitSrc(role, faction, frame) {
    const base = HERO_PORTRAITS_TEAM[role] && HERO_PORTRAITS_TEAM[role][faction];
    if (!base) return null;
    if (frame === 2) return base.replace(/_1\.png$/i, '_2.png');
    return base;
}

// White hit/select flash (role-only art — not team-tinted).
function teamFlashPortraitSrc(role) {
    if (!role) return null;
    return `/assets/characters/${String(role).toLowerCase()}_flash.png`;
}

// Fight-window attack pose: prefer _attack.png, fall back to _fight.png if missing.
function teamAttackPortraitSrc(role, faction, variant) {
    if (!role) return null;
    const color = faction === 'p2' ? 'red' : 'blue';
    const suffix = variant === 'fight' ? 'fight' : 'attack';
    return `/assets/characters/${String(role).toLowerCase()}_${color}_${suffix}.png`;
}

function resolveAttackPortraitSrc(role, faction) {
    const attackSrc = teamAttackPortraitSrc(role, faction, 'attack');
    const fightSrc = teamAttackPortraitSrc(role, faction, 'fight');
    const attackImg = getCachedPortrait(attackSrc);
    // naturalWidth > 0 means the file actually loaded (404s complete with width 0).
    if (attackImg && attackImg.complete && attackImg.naturalWidth > 0) return attackSrc;
    const fightImg = getCachedPortrait(fightSrc);
    if (fightImg && fightImg.complete && fightImg.naturalWidth > 0) return fightSrc;
    // Not ready yet — prefer _attack; onerror below can swap to _fight.
    return attackSrc || fightSrc;
}

// Combat damage flash: white → normal → white → normal over 0.5s.
const HERO_FLASH_TOTAL_MS = 500;
const HERO_FLASH_BEAT_MS = 125;
// Map select: one white beat then normal (0.25s total, same beat speed).
const SELECT_FLASH_TOTAL_MS = 250;
// Map-token select pulse: { uid, start }
let partySelectFlash = null;

function triggerPartySelectFlash(uid) {
    if (!uid) return;
    partySelectFlash = { uid, start: performance.now() };
}

function isPartySelectFlashWhite(uid) {
    if (!partySelectFlash || partySelectFlash.uid !== uid) return false;
    const elapsed = performance.now() - partySelectFlash.start;
    if (elapsed < 0 || elapsed >= SELECT_FLASH_TOTAL_MS) return false;
    // Only the first beat is white.
    return elapsed < HERO_FLASH_BEAT_MS;
}

function getHeroIdlePhaseOffset(key) {
    if (heroIdlePhaseByKey[key] === undefined) {
        heroIdlePhaseByKey[key] = Math.random() * IDLE_ANIM_PERIOD_MS;
    }
    return heroIdlePhaseByKey[key];
}

// True during that hero's 0.5s fidget window (desynced per unit).
function isHeroIdleFlashing(key) {
    const phase = getHeroIdlePhaseOffset(key);
    const t = (performance.now() + phase) % IDLE_ANIM_PERIOD_MS;
    return t < IDLE_ANIM_FLASH_MS;
}

function getHeroWalkState(key) {
    if (!heroWalkPhaseByKey[key]) {
        heroWalkPhaseByKey[key] = {
            phase: Math.random(),
            dir: Math.random() < 0.5 ? -1 : 1
        };
    }
    return heroWalkPhaseByKey[key];
}

// Lean + bob for the current frame (desynced start direction / phase per hero).
function getWalkPose(memberKey) {
    const state = getHeroWalkState(memberKey);
    const cycle = ((performance.now() / WALK_CYCLE_MS) + state.phase) * Math.PI * 2;
    const lean = Math.sin(cycle) * state.dir;
    return {
        rotRad: lean * (WALK_LEAN_DEG * Math.PI / 180),
        bobFrac: Math.abs(Math.sin(cycle)) * WALK_BOB_FRAC
    };
}

// --- Unconscious / sleep casualties (arena map, fight window, info panel) ---

function teamSleepPortraitSrc(role, faction) {
    if (!role) return null;
    const color = faction === 'p2' ? 'red' : 'blue';
    return `/assets/characters/${String(role).toLowerCase()}_${color}_sleep.png`;
}

// Peasant sleep art includes a long rake, so they read tiny unless boosted.
function sleepPortraitScale(role) {
    return role === 'Peasant' ? 1.2 : 1;
}

function sleepZzzSrc() {
    const frame = (Math.floor(performance.now() / SLEEP_ZZZ_FRAME_MS) % 2) + 1;
    return `/assets/characters/sleep_${frame}.png`;
}

function preloadSleepAssets() {
    Object.keys(HERO_PORTRAITS_TEAM).forEach(role => {
        getCachedPortrait(teamSleepPortraitSrc(role, 'p1'));
        getCachedPortrait(teamSleepPortraitSrc(role, 'p2'));
    });
    getCachedPortrait('/assets/characters/sleep_1.png');
    getCachedPortrait('/assets/characters/sleep_2.png');
}

function preloadCombatIcons() {
    getCachedPortrait('/assets/icons/exclamation.png');
    getCachedPortrait('/assets/icons/question.png');
    getCachedPortrait('/assets/icons/spellbook_blue.png');
    getCachedPortrait('/assets/icons/spellbook_red.png');
    getCachedPortrait('/assets/icons/place_parties.png');
    [
        'day_one', 'day_two', 'day_three', 'day_four', 'day_five',
        'day_six', 'day_seven', 'day_eight', 'day_nine', 'day_ten'
    ].forEach(name => getCachedPortrait(`/assets/icons/${name}.png`));
}

// Spell books: owner-coloured art (50% bigger than the old 14×16 drawn rect).
const SPELLBOOK_DRAW_W = 21;
const SPELLBOOK_DRAW_H = 24;
// Trail fades over one tile of travel (~one move step).
const SPELLBOOK_TRAIL_MS = ROUND_MOVE_MS;
let spellbookTrail = [];

function spellbookIconSrc(ownerFaction) {
    return ownerFaction === 'p2'
        ? '/assets/icons/spellbook_red.png'
        : '/assets/icons/spellbook_blue.png';
}

function emitSpellbookTrail(cx, cy, ownerFaction) {
    // A couple of faint sparkles per frame while sliding.
    for (let i = 0; i < 2; i++) {
        spellbookTrail.push({
            x: cx + (Math.random() - 0.5) * 12,
            y: cy + (Math.random() - 0.5) * 10,
            start: performance.now(),
            ownerFaction,
            size: 1.2 + Math.random() * 2.2,
            twinkle: Math.random() * Math.PI * 2
        });
    }
    if (spellbookTrail.length > 100) {
        spellbookTrail.splice(0, spellbookTrail.length - 100);
    }
}

function drawSpellbookTrail(drawCtx) {
    const now = performance.now();
    spellbookTrail = spellbookTrail.filter(p => now - p.start < SPELLBOOK_TRAIL_MS);
    if (!spellbookTrail.length) return;

    drawCtx.save();
    spellbookTrail.forEach(p => {
        const t = (now - p.start) / SPELLBOOK_TRAIL_MS;
        const alpha = (1 - t) * (1 - t) * 0.65;
        if (alpha <= 0.02) return;
        const rgb = p.ownerFaction === 'p2' ? '255,170,170' : '170,210,255';
        const sparkle = 0.7 + 0.3 * Math.sin(now / 80 + p.twinkle);
        drawCtx.fillStyle = `rgba(${rgb},${alpha * sparkle})`;
        drawCtx.beginPath();
        drawCtx.arc(p.x, p.y, p.size * (1 - t * 0.35), 0, Math.PI * 2);
        drawCtx.fill();
        // Tiny bright core
        drawCtx.fillStyle = `rgba(255,248,231,${alpha * 0.85})`;
        drawCtx.beginPath();
        drawCtx.arc(p.x, p.y, Math.max(0.6, p.size * 0.35), 0, Math.PI * 2);
        drawCtx.fill();
    });
    drawCtx.restore();
}

function preloadFlashAssets() {
    Object.keys(HERO_PORTRAITS_TEAM).forEach(role => {
        getCachedPortrait(teamFlashPortraitSrc(role));
    });
}

function preloadAttackAssets() {
    Object.keys(HERO_PORTRAITS_TEAM).forEach(role => {
        ['p1', 'p2'].forEach(faction => {
            getCachedPortrait(teamAttackPortraitSrc(role, faction, 'attack'));
            getCachedPortrait(teamAttackPortraitSrc(role, faction, 'fight'));
        });
    });
}

// Jump height in px while the pre-fight telegraph is running (0 after landing).
function getCombatTelegraphJumpPx(uid, heroHeightPx) {
    if (!combatTelegraph) return 0;
    if (!combatTelegraph.parties.some(p => p.uid === uid)) return 0;
    const elapsed = performance.now() - combatTelegraph.start;
    if (elapsed < 0 || elapsed >= COMBAT_TELEGRAPH_JUMP_MS) return 0;
    const t = elapsed / COMBAT_TELEGRAPH_JUMP_MS;
    const peak = heroHeightPx / 3;
    return 4 * peak * t * (1 - t);
}

function drawCombatTelegraphIcons() {
    if (!combatTelegraph) return;
    const elapsed = performance.now() - combatTelegraph.start;
    const totalMs = COMBAT_TELEGRAPH_JUMP_MS + COMBAT_TELEGRAPH_ICON_HOLD_MS;
    if (elapsed < 0 || elapsed >= totalMs) return;

    // Spring in over the jump; hold at full size afterward.
    const appearT = Math.min(1, elapsed / COMBAT_TELEGRAPH_JUMP_MS);
    const spring = Math.sin(appearT * Math.PI / 2);
        const size = ARENA_GRID.cellSize;
    const iconSize = size * 0.21; // half of previous 0.42 — ! / ? telegraph markers

    combatTelegraph.parties.forEach(entry => {
        const ap = arenaParties.find(p => p.uid === entry.uid);
        if (!ap || typeof ap.x !== 'number') return;
        const drawTile = getPartyDrawTile(ap);
        const cx = ARENA_GRID.offsetX + (drawTile.x * size) + size / 2;
        // Sit about one sprite tall above the party token.
        const cy = ARENA_GRID.offsetY + (drawTile.y * size) - iconSize * 0.15;
        const img = getCachedPortrait(`/assets/icons/${entry.icon}.png`);
        if (!img || !img.complete || !img.naturalWidth) return;

        // Same height for ! and ?; squash ! horizontally so it isn't too fat.
        const h = iconSize * (0.85 + 0.15 * spring) * spring;
        const w = entry.icon === 'exclamation' ? h * 0.5 : h;
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, cx - w / 2, cy - h, w, h);
        ctx.restore();
    });
}

// Unison jump + !/? above the two parties about to fight (initiative-based).
function playCombatTelegraph(combat) {
    const a = arenaParties.find(p => p.uid === combat.leftUid);
    const b = arenaParties.find(p => p.uid === combat.rightUid);
    if (!a || !b) return Promise.resolve();

    const initA = ORDER_INITIATIVE[a.order] || 2;
    const initB = ORDER_INITIATIVE[b.order] || 2;
    let iconA = 'exclamation';
    let iconB = 'exclamation';
    if (initA < initB) {
        iconA = 'exclamation';
        iconB = 'question';
    } else if (initB < initA) {
        iconA = 'question';
        iconB = 'exclamation';
    }

    combatTelegraph = {
        start: performance.now(),
        parties: [
            { uid: a.uid, icon: iconA },
            { uid: b.uid, icon: iconB }
        ]
    };

    return sleepMs(COMBAT_TELEGRAPH_JUMP_MS + COMBAT_TELEGRAPH_ICON_HOLD_MS).then(() => {
        combatTelegraph = null;
    });
}

function scatterOffsetForCasualtyTile(x, y) {
    const n = groundCasualties.filter(c => c.x === x && c.y === y).length
        + pendingMapFalls.filter(c => c.x === x && c.y === y).length;
    if (n === 0) return { ox: 0, oy: 0 };
    const angle = n * 2.3;
    const r = Math.min(22, 5 + n * 6);
    return { ox: Math.cos(angle) * r, oy: Math.sin(angle) * r };
}

function queueCasualtyFromKnockout(party, memberIndex, tileX, tileY, faceLeft) {
    if (!party || !party.members || !party.members[memberIndex]) return null;
    const member = party.members[memberIndex];
    const id = `${party.uid}:${memberIndex}:${tileX},${tileY}`;
    if (groundCasualties.some(c => c.id === id) || pendingMapFalls.some(c => c.id === id)) {
        return null;
    }
    const scatter = scatterOffsetForCasualtyTile(tileX, tileY);
    const entry = {
        id,
        uid: party.uid,
        memberIndex,
        role: member.role,
        faction: party.faction,
        x: tileX,
        y: tileY,
        faceLeft: !!faceLeft,
        ox: scatter.ox,
        oy: scatter.oy,
        phase: 'pending',
        tipStart: 0
    };
    pendingMapFalls.push(entry);
    return entry;
}

// After the fight window closes: tip on the map (and info panel if that party is selected).
function beginPendingMapCasualtyFalls() {
    const now = performance.now();
    pendingMapFalls.forEach(c => {
        c.phase = 'tipping';
        c.tipStart = now;
        groundCasualties.push(c);
        if (selectedPartyUid === c.uid) {
            panelCasualtyTips[`${c.uid}:${c.memberIndex}`] = now;
        }
    });
    pendingMapFalls = [];
    if (Object.keys(panelCasualtyTips).length) {
        renderArenaChrome();
        // Swap panel portraits to sleep after the tip finishes.
        setTimeout(() => {
            renderArenaChrome();
        }, CASUALTY_MAP_TIP_MS + 30);
    }
}

function drawSleepZzzAbove(centerX, centerY, spriteSize) {
    const zzz = getCachedPortrait(sleepZzzSrc());
    if (!zzz || !zzz.complete || !zzz.naturalWidth) return;
    const zw = spriteSize * 0.45;
    const zh = zw * (zzz.naturalHeight / zzz.naturalWidth);
    ctx.drawImage(zzz, centerX - zw / 2, centerY - spriteSize * 0.55 - zh, zw, zh);
}

function drawGroundCasualties(visibleTiles) {
    const size = ARENA_GRID.cellSize;
    const spriteSize = size * 0.45;
    const now = performance.now();

    groundCasualties.forEach(c => {
        if (visibleTiles && !isTileVisible(visibleTiles, c.x, c.y)) return;
        if (c.phase === 'tipping' && now - c.tipStart >= CASUALTY_MAP_TIP_MS) {
            c.phase = 'sleep';
        }

        const tilePx = ARENA_GRID.offsetX + (c.x * size) + size / 2 + c.ox;
        const tilePy = ARENA_GRID.offsetY + (c.y * size) + size / 2 + c.oy;

        if (c.phase === 'tipping') {
            const t = Math.min(1, (now - c.tipStart) / CASUALTY_MAP_TIP_MS);
            const img = getCachedPortrait(teamPortraitSrc(c.role, c.faction, 1));
            if (!img || !img.complete || !img.naturalWidth) return;
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
            ctx.translate(tilePx, tilePy + spriteSize * 0.35);
            // Match theatre: face first, then tip in local space so lean is always "backwards".
            if (c.faceLeft) ctx.scale(-1, 1);
            ctx.rotate(-t * (45 * Math.PI / 180));
            ctx.drawImage(img, -spriteSize / 2, -spriteSize, spriteSize, spriteSize);
            ctx.restore();
            return;
        }

        // Sleeping body (art is already horizontal).
        const sleepImg = getCachedPortrait(teamSleepPortraitSrc(c.role, c.faction));
        if (!sleepImg || !sleepImg.complete || !sleepImg.naturalWidth) return;
        const drawW = spriteSize * 1.15 * sleepPortraitScale(c.role);
        const drawH = drawW * (sleepImg.naturalHeight / sleepImg.naturalWidth);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
        ctx.translate(tilePx, tilePy);
        if (c.faceLeft) ctx.scale(-1, 1);
        ctx.drawImage(sleepImg, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
        drawSleepZzzAbove(tilePx, tilePy, spriteSize);
    });
}

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
        ['p1', 'p2'].forEach(faction => {
            getCachedPortrait(teamPortraitSrc(role, faction, 1));
            getCachedPortrait(teamPortraitSrc(role, faction, 2));
        });
    });
}

// Grass tile images (visual only — server still treats LG/DG by terrain code).
const grassTileImgCache = {};

function getCachedGrassTile(variant) {
    if (!variant || variant < 1 || variant > 7) return null;
    if (grassTileImgCache[variant]) return grassTileImgCache[variant];
    const img = new Image();
    img.src = `assets/tiles/grass_${variant}.png`;
    grassTileImgCache[variant] = img;
    return img;
}

function preloadGrassTiles() {
    for (let v = 1; v <= 7; v++) getCachedGrassTile(v);
}

// Forest tree images (visual only). Width = one tile; taller than a tile so canopy overlaps upward.
const treeTileImgCache = {};
// Fogged copies (same black overlay as tiles, but only on opaque tree pixels).
const treeTileFogCache = {};

function getCachedTreeTile(variant) {
    if (!variant || variant < 1 || variant > 3) return null;
    if (treeTileImgCache[variant]) return treeTileImgCache[variant];
    const img = new Image();
    img.src = `assets/tiles/tree_${variant}.png`;
    treeTileImgCache[variant] = img;
    return img;
}

function preloadTreeTiles() {
    for (let v = 1; v <= 3; v++) getCachedTreeTile(v);
}

// Build (and cache) a tree sprite with the same fog darken as arena tiles.
function getFoggedTreeCanvas(variant, drawW, drawH) {
    const key = `${variant}_${drawW}x${drawH}`;
    if (treeTileFogCache[key]) return treeTileFogCache[key];

    const img = getCachedTreeTile(variant);
    if (!img || !img.complete || img.naturalWidth <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(drawW));
    canvas.height = Math.max(1, Math.ceil(drawH));
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0, drawW, drawH);
    // source-atop = paint fog only where the tree already has pixels (no dark box)
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    tctx.fillRect(0, 0, canvas.width, canvas.height);
    tctx.globalCompositeOperation = 'source-over';

    treeTileFogCache[key] = canvas;
    return canvas;
}

// Draw a forest tree bottom-aligned on its tile (canopy sticks into the tile above).
// fogged: whole tree uses the forest tile's fog, including the overhang into the tile above.
function drawForestTreeAt(tileX, tileY, fogged) {
    const variant = TREE_VARIANT_MAP[tileY] && TREE_VARIANT_MAP[tileY][tileX];
    const img = getCachedTreeTile(variant);
    if (!img || !img.complete || img.naturalWidth <= 0) return;

    const size = ARENA_GRID.cellSize;
    const cx = ARENA_GRID.offsetX + (tileX * size);
    const cy = ARENA_GRID.offsetY + (tileY * size);
    const drawW = size;
    const drawH = size * (img.naturalHeight / img.naturalWidth);
    // Lift trunk off the bottom edge (fixed 15%–25% of tile height per tree).
    const liftFrac = (TREE_LIFT_MAP[tileY] && TREE_LIFT_MAP[tileY][tileX]) || 0.15;
    const dx = cx;
    const dy = cy + size - drawH - (liftFrac * size);

    if (fogged) {
        const foggedTree = getFoggedTreeCanvas(variant, drawW, drawH);
        if (foggedTree) {
            ctx.drawImage(foggedTree, dx, dy);
            return;
        }
    }
    ctx.drawImage(img, dx, dy, drawW, drawH);
}

// Wizard tower sprites (visual only). Same scale/overlap/fog rules as trees.
const towerImgCache = {};
const towerFogCache = {};

function getCachedTowerImage(team) {
    // team: 'blue' (p1 / left) or 'red' (p2 / right)
    if (team !== 'blue' && team !== 'red') return null;
    if (towerImgCache[team]) return towerImgCache[team];
    const img = new Image();
    img.src = `assets/tiles/wizard_tower_${team}.png`;
    towerImgCache[team] = img;
    return img;
}

function preloadTowerTiles() {
    getCachedTowerImage('blue');
    getCachedTowerImage('red');
}

function getFoggedTowerCanvas(team, drawW, drawH) {
    const key = `${team}_${drawW}x${drawH}`;
    if (towerFogCache[key]) return towerFogCache[key];

    const img = getCachedTowerImage(team);
    if (!img || !img.complete || img.naturalWidth <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(drawW));
    canvas.height = Math.max(1, Math.ceil(drawH));
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0, drawW, drawH);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    tctx.fillRect(0, 0, canvas.width, canvas.height);
    tctx.globalCompositeOperation = 'source-over';

    towerFogCache[key] = canvas;
    return canvas;
}

// Draw wizard tower: width = tile, base 20% up from tile bottom (overlaps tile above).
function drawWizardTowerAt(tileX, tileY, team, fogged) {
    const img = getCachedTowerImage(team);
    if (!img || !img.complete || img.naturalWidth <= 0) return;

    const size = ARENA_GRID.cellSize;
    const cx = ARENA_GRID.offsetX + (tileX * size);
    const cy = ARENA_GRID.offsetY + (tileY * size);
    const drawW = size;
    const drawH = size * (img.naturalHeight / img.naturalWidth);
    const dx = cx;
    const dy = cy + size - drawH - (TOWER_LIFT_FRAC * size);

    if (fogged) {
        const foggedTower = getFoggedTowerCanvas(team, drawW, drawH);
        if (foggedTower) {
            ctx.drawImage(foggedTower, dx, dy);
            return;
        }
    }
    ctx.drawImage(img, dx, dy, drawW, drawH);
}

// Tall props (trees / rocks / towers) split party draw into behind vs in-front bands.
function tileHasTallProp(tileCode) {
    return tileCode === 'DG' || tileCode === 'RED' || tileCode === 'LGY';
}

// Mountain rock sprites (visual only). Same scale/overlap/fog rules as trees.
const rockTileImgCache = {};
const rockTileFogCache = {};

function getCachedRockTile(variant) {
    if (!variant || variant < 1 || variant > 3) return null;
    if (rockTileImgCache[variant]) return rockTileImgCache[variant];
    const img = new Image();
    img.src = `assets/tiles/rock_${variant}.png`;
    rockTileImgCache[variant] = img;
    return img;
}

function preloadRockTiles() {
    for (let v = 1; v <= 3; v++) getCachedRockTile(v);
}

function getFoggedRockCanvas(variant, drawW, drawH) {
    const key = `${variant}_${drawW}x${drawH}`;
    if (rockTileFogCache[key]) return rockTileFogCache[key];

    const img = getCachedRockTile(variant);
    if (!img || !img.complete || img.naturalWidth <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(drawW));
    canvas.height = Math.max(1, Math.ceil(drawH));
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0, drawW, drawH);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    tctx.fillRect(0, 0, canvas.width, canvas.height);
    tctx.globalCompositeOperation = 'source-over';

    rockTileFogCache[key] = canvas;
    return canvas;
}

// Draw a mountain rock bottom-aligned on its tile (overlaps the tile above).
function drawMountainRockAt(tileX, tileY, fogged) {
    const variant = ROCK_VARIANT_MAP[tileY] && ROCK_VARIANT_MAP[tileY][tileX];
    const img = getCachedRockTile(variant);
    if (!img || !img.complete || img.naturalWidth <= 0) return;

    const size = ARENA_GRID.cellSize;
    const cx = ARENA_GRID.offsetX + (tileX * size);
    const cy = ARENA_GRID.offsetY + (tileY * size);
    const drawW = size;
    const drawH = size * (img.naturalHeight / img.naturalWidth);
    const liftFrac = (ROCK_LIFT_MAP[tileY] && ROCK_LIFT_MAP[tileY][tileX]) || 0.10;
    const dx = cx;
    const dy = cy + size - drawH - (liftFrac * size);

    if (fogged) {
        const foggedRock = getFoggedRockCanvas(variant, drawW, drawH);
        if (foggedRock) {
            ctx.drawImage(foggedRock, dx, dy);
            return;
        }
    }
    ctx.drawImage(img, dx, dy, drawW, drawH);
}

// --- Roads + grass verges (visual only) ---
const roadTileImgCache = {};
const vergeTileImgCache = {};

function getCachedRoadTile(variant) {
    if (!variant || variant < 1 || variant > 3) return null;
    if (roadTileImgCache[variant]) return roadTileImgCache[variant];
    const img = new Image();
    img.src = `assets/tiles/road_${variant}.png`;
    roadTileImgCache[variant] = img;
    return img;
}

function getCachedVergeTile(variant) {
    if (!variant || variant < 1 || variant > 6) return null;
    if (vergeTileImgCache[variant]) return vergeTileImgCache[variant];
    const img = new Image();
    img.src = `assets/tiles/verge_${variant}.png`;
    vergeTileImgCache[variant] = img;
    return img;
}

function preloadRoadAndVergeTiles() {
    for (let v = 1; v <= 3; v++) getCachedRoadTile(v);
    for (let v = 1; v <= 6; v++) getCachedVergeTile(v);
}

// Roads + wizard towers both count as "road" for verge neighbours.
function isClientRoadLike(x, y) {
    const t = getClientTileAt(x, y);
    return t === 'DGY' || t === 'RED';
}

// Stable pick between two straight verge art variants for this cell.
function vergeStraightPick(x, y, a, b) {
    return ((x * 7 + y * 13) & 1) === 0 ? a : b;
}

// Build verge overlays for a grass cell from road neighbours.
// verge_1 = outer corner (dirt in one corner); verge_2/3 = N/S straights; verge_4/5 = E/W straights;
// verge_6 = inner corner (mostly dirt, one transparent corner). Rotations fill the other directions.
function getVergeLayersForGrass(x, y) {
    const N = isClientRoadLike(x, y - 1);
    const E = isClientRoadLike(x + 1, y);
    const S = isClientRoadLike(x, y + 1);
    const W = isClientRoadLike(x - 1, y);
    const NE = isClientRoadLike(x + 1, y - 1);
    const NW = isClientRoadLike(x - 1, y - 1);
    const SE = isClientRoadLike(x + 1, y + 1);
    const SW = isClientRoadLike(x - 1, y + 1);

    if (!(N || E || S || W || NE || NW || SE || SW)) return [];

    const layers = [];

    // One corner of this grass tile (e.g. SE): outer vs inner vs diagonal-only.
    function addCorner(cardA, cardB, diag, outerRot, innerRot) {
        if (cardA && cardB) {
            layers.push(diag
                ? { variant: 6, rot: innerRot }
                : { variant: 1, rot: outerRot });
        } else if (diag && !cardA && !cardB) {
            layers.push({ variant: 1, rot: outerRot });
        }
    }

    // Outer verge_1 dirt corner at 0°=SE, 90°=SW, 180°=NW, 270°=NE.
    // Inner verge_6 transparent corner at 0°=NE, 90°=SE, 180°=SW, 270°=NW.
    addCorner(S, E, SE, 0, 270);
    addCorner(S, W, SW, 90, 0);
    addCorner(N, W, NW, 180, 90);
    addCorner(N, E, NE, 270, 180);

    // Straights only when that side is road and not already a two-cardinal corner on both ends.
    if (S && !E && !W) {
        layers.push({ variant: vergeStraightPick(x, y, 2, 3), rot: 0 });
    }
    if (N && !E && !W) {
        layers.push({ variant: vergeStraightPick(x, y, 2, 3), rot: 180 });
    }
    if (E && !N && !S) {
        layers.push({ variant: vergeStraightPick(x, y, 4, 5), rot: 0 });
    }
    if (W && !N && !S) {
        layers.push({ variant: vergeStraightPick(x, y, 4, 5), rot: 180 });
    }

    return layers;
}

function drawVergeLayer(cx, cy, size, layer) {
    const img = getCachedVergeTile(layer.variant);
    if (!img || !img.complete || img.naturalWidth <= 0) return;
    const rot = layer.rot || 0;
    ctx.save();
    ctx.translate(cx + size / 2, cy + size / 2);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
}

function resetPartyVisualState() {
    partyCornerLayout = {};
    partyLastMoveDir = {};
    partyLastPos = {};
    // New parties get fresh random fidget / walk phases next time they're drawn.
    for (const key of Object.keys(heroIdlePhaseByKey)) delete heroIdlePhaseByKey[key];
    for (const key of Object.keys(heroWalkPhaseByKey)) delete heroWalkPhaseByKey[key];
    for (const uid of Object.keys(walkAnimActiveUids)) delete walkAnimActiveUids[uid];
    groundCasualties = [];
    pendingMapFalls = [];
    panelCasualtyTips = {};
    combatTelegraph = null;
    partySelectFlash = null;
    spellbookTrail = [];
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

function drawPartySpritesOnTile(ap, tileX, tileY, cornerBand) {
    // cornerBand: 'all' | 'top' | 'bottom' — used so trees can sit between top and bottom heroes.
    const band = cornerBand || 'all';
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
        if (band === 'top' && corner > 1) return;
        if (band === 'bottom' && corner < 2) return;

        const memberKey = `${ap.uid}:${memberIndex}`;
        const isWalking = !!walkAnimActiveUids[ap.uid];
        // Idle fidget whenever standing still on the arena map; walk / telegraph jump win.
        const jumpPx = getCombatTelegraphJumpPx(ap.uid, spriteSize);
        const allowIdleAnim = !isWalking && jumpPx <= 0;
        const frame = (allowIdleAnim && isHeroIdleFlashing(memberKey)) ? 2 : 1;
        // Select pulse overrides idle fidget with the white mask art.
        const src = isPartySelectFlashWhite(ap.uid)
            ? teamFlashPortraitSrc(member.role)
            : teamPortraitSrc(member.role, ap.faction, frame);
        const walkPose = isWalking ? getWalkPose(memberKey) : null;
        const img = getCachedPortrait(src);
        const drawY = tileY - jumpPx;
        if (!img || !img.complete || !img.naturalWidth) {
            // Fallback to frame 1 if frame 2 hasn't loaded yet
            const fallback = getCachedPortrait(teamPortraitSrc(member.role, ap.faction, 1));
            if (!fallback || !fallback.complete || !fallback.naturalWidth) return;
            drawOnePortrait(fallback, tileX, drawY, cornerOffset[corner], spriteSize, pad, faceLeft, walkPose);
            return;
        }

        const off = cornerOffset[corner];
        drawOnePortrait(img, tileX, drawY, off, spriteSize, pad, faceLeft, walkPose);
    });
}

function drawOnePortrait(img, tileX, tileY, off, spriteSize, pad, faceLeft, walkPose) {
    const dx = tileX + off.ox + pad;
    const dy = tileY + off.oy + pad;
    // Pivot at the feet so lean/bob reads like a little walk cycle.
    const pivotX = dx + spriteSize / 2;
    const pivotY = dy + spriteSize;

    ctx.save();
    // Smooth (bilinear) scale for character sprites only — tiles stay crisp elsewhere.
    ctx.imageSmoothingEnabled = true;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';

    ctx.translate(pivotX, pivotY);
    if (walkPose) {
        ctx.translate(0, -walkPose.bobFrac * spriteSize);
        ctx.rotate(walkPose.rotRad);
    }
    if (faceLeft) ctx.scale(-1, 1);
    ctx.drawImage(img, -spriteSize / 2, -spriteSize, spriteSize, spriteSize);
    ctx.restore();
}

function syncArenaCanvasSize() {
    const w = ARENA_GRID.width * ARENA_GRID.cellSize;
    const h = ARENA_GRID.height * ARENA_GRID.cellSize;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
}

// options.faction: if 'p1' or 'p2', use arena team portraits; otherwise neutral art.
// options.animateCasualtyTips: when true, play tip→sleep for newly KO'd members in panelCasualtyTips.
function renderHeroCards(container, heroes, options) {
    if (!container) return;
    const faction = options && options.faction;
    const animateTips = !!(options && options.animateCasualtyTips);
    const partyUid = options && options.partyUid;
    container.innerHTML = '';
    heroes.forEach((h, memberIndex) => {
        const card = document.createElement('div');
        card.className = 'hero-card';
        const stats = LOCAL_HERO_TEMPLATES[h.role] || h;
        const baseHp = h.baseHp !== undefined ? h.baseHp : stats.hp;
        const isUnconscious = h.hp !== undefined && h.hp <= 0;
        let hpText;
        if (h.hp !== undefined) {
            hpText = h.hp > 0 ? `${h.hp}/${baseHp} HP` : 'UNCONSCIOUS';
        } else {
            hpText = `${stats.hp} HP`;
        }

        let portraitSrc = null;
        let tipping = false;
        if (isUnconscious && (faction === 'p1' || faction === 'p2')) {
            const tipKey = partyUid != null ? `${partyUid}:${memberIndex}` : null;
            const tipStart = tipKey ? panelCasualtyTips[tipKey] : null;
            if (animateTips && tipStart && performance.now() - tipStart < CASUALTY_MAP_TIP_MS) {
                portraitSrc = teamPortraitSrc(h.role, faction, 1);
                tipping = true;
            } else {
                portraitSrc = teamSleepPortraitSrc(h.role, faction);
                if (tipKey && tipStart) delete panelCasualtyTips[tipKey];
            }
        } else if ((faction === 'p1' || faction === 'p2') && HERO_PORTRAITS_TEAM[h.role]) {
            portraitSrc = HERO_PORTRAITS_TEAM[h.role][faction];
        } else {
            portraitSrc = HERO_PORTRAITS[h.role] || null;
        }

        const tipClass = tipping ? ' tipping' : '';
        const sleepClass = isUnconscious && !tipping ? ' sleeping' : '';
        const peasantSleepClass = (isUnconscious && !tipping && h.role === 'Peasant') ? ' sleep-peasant' : '';
        const portraitHtml = portraitSrc
            ? `<div class="hero-portrait${tipClass}${sleepClass}${peasantSleepClass}">`
                + `<img class="hero-portrait-img" src="${portraitSrc}" alt="${h.role}">`
                + (isUnconscious && !tipping ? `<img class="sleep-zzz" alt="">` : '')
                + `</div>`
            : `<div class="hero-portrait"></div>`;

        card.innerHTML =
            portraitHtml
            + `<div class="hero-card-body">`
            + `<h4>${h.role.toUpperCase()}</h4>`
            + `<p>❤ ${hpText} | ${heroAttackLabel(stats)}</p>`
            + `</div>`;
        container.appendChild(card);

        // Keep Zzz frames cycling while this panel is visible.
        if (isUnconscious && !tipping) {
            const zzz = card.querySelector('.sleep-zzz');
            if (zzz) zzz.src = sleepZzzSrc();
        }
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

// End-of-match STATE_SYNC must not yank us off the arena while resolve-round is still playing.
// GAME_OVER_SUMMARY is queued in pendingGameOverSummary and applied in finishRoundAnimation.
function shouldDeferGameOverScreen() {
    return isPlayingRoundAnimation || !!pendingGameOverSummary;
}

function switchScreenFromSync(serverRoom) {
    if (!serverRoom) return;
    if (serverRoom === 'GAME_OVER' && shouldDeferGameOverScreen()) return;
    switchScreen(serverRoom);
}

function applyStateSync(data) {
    const serverRoom = data.roomState;

    // Client-only overlays (party detail / mission briefing) stay put while server is still in Castle/Tavern.
    if (currentRoomState === 'PARTY_DETAIL') {
        const okReturn = partyDetailReturnTo === 'MISSION_BRIEFING'
            ? (serverRoom === 'CASTLE')
            : (serverRoom === partyDetailReturnTo);
        if (serverRoom === 'TACTICAL_ARENA' || serverRoom === 'GAME_OVER' || serverRoom === 'LANDING') {
            switchScreenFromSync(serverRoom);
        } else if (!okReturn && serverRoom) {
            switchScreenFromSync(serverRoom);
        }
    } else if (currentRoomState === 'MISSION_BRIEFING') {
        if (serverRoom === 'TACTICAL_ARENA' || serverRoom === 'GAME_OVER' || serverRoom === 'LANDING') {
            switchScreenFromSync(serverRoom);
        } else if (serverRoom && serverRoom !== 'CASTLE' && serverRoom !== 'TOWN_HQ') {
            // stay on briefing while still in castle hub flow; Town means they navigated away
            if (serverRoom === 'TAVERN') switchScreenFromSync(serverRoom);
        } else if (serverRoom === 'TOWN_HQ') {
            switchScreenFromSync(serverRoom);
        }
        // CASTLE → keep briefing open
    } else if (serverRoom) {
        switchScreenFromSync(serverRoom);
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
        const phaseBefore = arenaPhase;
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

        // Ready → combat: show Day 1 title before planning.
        if (phaseBefore !== 'COMBAT' && arenaPhase === 'COMBAT') {
            enqueueDayTitleCard(currentRound || 1);
        }
        prevArenaPhaseForTitle = arenaPhase;
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
                if (arenaTitleCardBlocking) return;
                selectedPartyUid = ap.uid;
                triggerPartySelectFlash(ap.uid);
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
        {
            faction: selected.faction,
            partyUid: selected.uid,
            animateCasualtyTips: true
        }
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
            btn.disabled = arenaTitleCardBlocking;
            btn.textContent = 'READY';
        } else {
            btn.disabled = true;
            btn.textContent = 'Waiting for other player...';
        }
        return;
    }

    btn.disabled = isWaitingForCombatResolution || arenaTitleCardBlocking || myFaction === 'spectator';
    btn.textContent = isWaitingForCombatResolution
        ? "WAITING FOR OPPONENT'S STRATEGY..."
        : 'LOCK IN ORDERS FOR THIS ROUND';
}

function updateOrderButtonsEnabled() {
    const enabled = arenaPhase === 'COMBAT'
        && myFaction !== 'spectator'
        && !!getSelectedArenaParty()
        && !arenaTitleCardBlocking;
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
    const base = { Guard: 1, Advance: 3, March: 5 };
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
// Edges that touch the wizard tower itself are skipped so the tower tile isn't outlined.
// band: 'behind' | 'front' — matches hero layering on tall-prop tiles (top behind, bottom in front).
// onlyRow: if set, only draw edges for deploy cells on that row (used inside the prop pass).
function drawDeploymentBoundary(faction, band, onlyRow) {
    const cells = getClientDeployCells(faction);
    if (!cells.length) return;
    const set = new Set(cells.map(c => `${c.x},${c.y}`));
    const anchors = findClientBuildingAnchors();
    const tower = faction === 'p1' ? anchors.left : anchors.right;
    const size = ARENA_GRID.cellSize;
    const mid = size / 2;

    function isTowerAt(x, y) {
        return !!(tower && tower.x === x && tower.y === y);
    }

    ctx.save();
    ctx.strokeStyle = getTeamColor(faction);
    ctx.lineWidth = 4;
    ctx.lineJoin = 'miter';

    cells.forEach(c => {
        if (onlyRow !== undefined && c.y !== onlyRow) return;

        const cx = ARENA_GRID.offsetX + (c.x * size);
        const cy = ARENA_GRID.offsetY + (c.y * size);
        const onProp = tileHasTallProp(getClientTileAt(c.x, c.y));
        const needTop = !set.has(`${c.x},${c.y - 1}`) && !isTowerAt(c.x, c.y - 1);
        const needBottom = !set.has(`${c.x},${c.y + 1}`) && !isTowerAt(c.x, c.y + 1);
        const needLeft = !set.has(`${c.x - 1},${c.y}`) && !isTowerAt(c.x - 1, c.y);
        const needRight = !set.has(`${c.x + 1},${c.y}`) && !isTowerAt(c.x + 1, c.y);

        if (!onProp) {
            // Flat tiles: whole outline draws in the behind pass (props below can cover it).
            if (band !== 'behind') return;
            if (needTop) {
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + size, cy); ctx.stroke();
            }
            if (needBottom) {
                ctx.beginPath(); ctx.moveTo(cx, cy + size); ctx.lineTo(cx + size, cy + size); ctx.stroke();
            }
            if (needLeft) {
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + size); ctx.stroke();
            }
            if (needRight) {
                ctx.beginPath(); ctx.moveTo(cx + size, cy); ctx.lineTo(cx + size, cy + size); ctx.stroke();
            }
            return;
        }

        // Tall-prop tiles: top half behind the prop, bottom half in front (same idea as heroes).
        if (band === 'behind') {
            if (needTop) {
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + size, cy); ctx.stroke();
            }
            if (needLeft) {
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + mid); ctx.stroke();
            }
            if (needRight) {
                ctx.beginPath(); ctx.moveTo(cx + size, cy); ctx.lineTo(cx + size, cy + mid); ctx.stroke();
            }
        } else if (band === 'front') {
            if (needBottom) {
                ctx.beginPath(); ctx.moveTo(cx, cy + size); ctx.lineTo(cx + size, cy + size); ctx.stroke();
            }
            if (needLeft) {
                ctx.beginPath(); ctx.moveTo(cx, cy + mid); ctx.lineTo(cx, cy + size); ctx.stroke();
            }
            if (needRight) {
                ctx.beginPath(); ctx.moveTo(cx + size, cy + mid); ctx.lineTo(cx + size, cy + size); ctx.stroke();
            }
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
    if (myFaction === 'spectator' || arenaTitleCardBlocking) return;
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

const ARENA_TITLE_FADE_MS = 500;
const ARENA_TITLE_HOLD_MS = 1000;
const DAY_TITLE_NAMES = [
    null,
    'day_one', 'day_two', 'day_three', 'day_four', 'day_five',
    'day_six', 'day_seven', 'day_eight', 'day_nine', 'day_ten'
];

function setArenaTitleCardBlocking(blocking) {
    arenaTitleCardBlocking = !!blocking;
    updateLockTurnButton();
    updateOrderButtonsEnabled();
}

// Dim → fade title in → hold → fade out. Blocks arena input while active.
function playArenaTitleCard(baseName) {
    return new Promise(resolve => {
        const card = document.getElementById('arena-title-card');
        const img = document.getElementById('arena-title-card-img');
        if (!card || !img || !baseName) {
            resolve();
            return;
        }

        setArenaTitleCardBlocking(true);
        const mapFrame = document.getElementById('arena-map-frame')
            || document.getElementById('arena-map-scroll');
        const mapW = mapFrame ? mapFrame.clientWidth : 0;
        // Mobile map pane is narrow — double the title so Place Parties / Day X stay readable.
        const frac = isMobileLikeDevice() ? 0.4 : 0.2;
        img.style.width = mapW > 0 ? `${Math.round(mapW * frac)}px` : `${frac * 100}%`;
        img.src = `/assets/icons/${baseName}.png`;
        img.alt = baseName.replace(/_/g, ' ');

        card.classList.add('is-active');
        card.setAttribute('aria-hidden', 'false');
        void card.offsetWidth; // restart CSS transitions from opacity 0
        card.classList.add('is-dim', 'is-show-title');

        setTimeout(() => {
            card.classList.remove('is-dim', 'is-show-title');
            setTimeout(() => {
                card.classList.remove('is-active');
                card.setAttribute('aria-hidden', 'true');
                setArenaTitleCardBlocking(false);
                resolve();
            }, ARENA_TITLE_FADE_MS);
        }, ARENA_TITLE_FADE_MS + ARENA_TITLE_HOLD_MS);
    });
}

function enqueueArenaTitleCard(baseName) {
    arenaTitleCardQueue = arenaTitleCardQueue
        .catch(() => {})
        .then(() => playArenaTitleCard(baseName));
    return arenaTitleCardQueue;
}

function enqueueDayTitleCard(dayNum) {
    const name = DAY_TITLE_NAMES[dayNum];
    if (!name) return arenaTitleCardQueue;
    if (dayNum <= lastArenaTitleDayShown) return arenaTitleCardQueue;
    lastArenaTitleDayShown = dayNum;
    return enqueueArenaTitleCard(name);
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
            walkAnimActiveUids[m.uid] = true;
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
                    delete walkAnimActiveUids[m.uid];
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

function placeCombatTheatreHeroes(halfEl, party, faceLeft) {
    halfEl.innerHTML = '';
    if (!party || !party.members) return;
    const used = [];
    // Right half: faceLeft true (mirror toward opponents). Left half: natural art.
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
        img.dataset.role = member.role;
        img.dataset.faction = party.faction;
        img.dataset.faceLeft = faceLeft ? '1' : '0';
        img.style.left = pos.left + '%';
        img.style.top = pos.top + '%';
        img.style.width = '22%';
        img.dataset.baseWidthPct = '22';
        img.style.transform = combatTheatreHeroTransform(img, 'upright');
        halfEl.appendChild(img);
    });
}

// mode: 'upright' | 'tip' | 'sleep'
function combatTheatreHeroTransform(heroEl, mode) {
    const faceLeft = heroEl && heroEl.dataset.faceLeft === '1';
    const parts = ['translate(-50%, -50%)'];
    // Face first, then tip in local space: -45° is always "lean back" for these portraits.
    if (faceLeft) parts.push('scaleX(-1)');
    if (mode === 'tip') parts.push('rotate(-45deg)');
    return parts.join(' ');
}

function attachTheatreSleepZzz(heroEl) {
    if (!heroEl || !heroEl.parentElement) return;
    let wrap = heroEl.parentElement.querySelector(
        `.combat-theatre-zzz[data-uid="${heroEl.dataset.uid}"][data-member-index="${heroEl.dataset.memberIndex}"]`
    );
    if (!wrap) {
        wrap = document.createElement('img');
        wrap.className = 'combat-theatre-zzz sleep-zzz';
        wrap.dataset.uid = heroEl.dataset.uid;
        wrap.dataset.memberIndex = heroEl.dataset.memberIndex;
        wrap.alt = '';
        heroEl.parentElement.appendChild(wrap);
    }
    wrap.style.left = heroEl.style.left;
    wrap.style.top = heroEl.style.top;
    wrap.src = sleepZzzSrc();
}

// Tip 45°, arc knockback (~hero height) over 1s, then swap to sleep sprite + Zzz.
function animateTheatreKnockout(heroEl) {
    return new Promise(resolve => {
        if (!heroEl || !heroEl.parentElement) {
            resolve();
            return;
        }
        const parent = heroEl.parentElement;
        const faceLeft = heroEl.dataset.faceLeft === '1';
        const knockDir = faceLeft ? 1 : -1; // fall away from the opponent in the centre
        const startLeft = parseFloat(heroEl.style.left) || 50;
        const startTop = parseFloat(heroEl.style.top) || 50;
        const heroH = heroEl.offsetHeight || Math.max(40, parent.clientHeight * 0.22);
        const distPctX = (heroH / Math.max(1, parent.clientWidth)) * 100;
        const peakPctY = (heroH * 0.35 / Math.max(1, parent.clientHeight)) * 100;

        heroEl.classList.add('is-ko');
        heroEl.style.transform = combatTheatreHeroTransform(heroEl, 'tip');

        const start = performance.now();
        function frame(now) {
            const t = Math.min(1, (now - start) / CASUALTY_THEATRE_ARC_MS);
            const arcUp = 4 * peakPctY * t * (1 - t);
            heroEl.style.left = (startLeft + knockDir * distPctX * t) + '%';
            heroEl.style.top = (startTop - arcUp) + '%';
            if (t < 1) {
                requestAnimationFrame(frame);
            } else {
                const sleepSrc = teamSleepPortraitSrc(heroEl.dataset.role, heroEl.dataset.faction);
                if (sleepSrc) heroEl.src = sleepSrc;
                heroEl.dataset.sleeping = '1';
                // Peasant rake makes the sleep sprite look small — bump display size.
                if (heroEl.dataset.role === 'Peasant') {
                    const baseW = parseFloat(heroEl.dataset.baseWidthPct || '') || parseFloat(heroEl.style.width) || 22;
                    if (!heroEl.dataset.baseWidthPct) heroEl.dataset.baseWidthPct = String(baseW);
                    heroEl.style.width = (baseW * sleepPortraitScale('Peasant')) + '%';
                }
                heroEl.style.transform = combatTheatreHeroTransform(heroEl, 'sleep');
                attachTheatreSleepZzz(heroEl);
                resolve();
            }
        }
        requestAnimationFrame(frame);
    });
}

function getCombatTheatreHeroEl(uid, memberIndex) {
    if (uid == null || memberIndex == null || memberIndex === '') return null;
    return document.querySelector(
        `.combat-theatre-hero[data-uid="${uid}"][data-member-index="${memberIndex}"]`
    );
}

// Party-total strikes (different initiative) often omit attackerMemberIndex — pick someone to animate.
function getCombatTheatreAttackerEl(strike) {
    if (!strike) return null;
    if (typeof strike.attackerMemberIndex === 'number') {
        const exact = getCombatTheatreHeroEl(strike.attackerUid, strike.attackerMemberIndex);
        if (exact) return exact;
    }
    const party = arenaParties.find(p => p.uid === strike.attackerUid);
    if (party && Array.isArray(party.members)) {
        for (let i = 0; i < party.members.length; i++) {
            const m = party.members[i];
            if (!m || m.hp <= 0) continue;
            if (strike.kind === 'ranged' && !(m.range > 0)) continue;
            const el = getCombatTheatreHeroEl(party.uid, i);
            if (el && el.dataset.sleeping !== '1') return el;
        }
    }
    return document.querySelector(
        `.combat-theatre-hero[data-uid="${strike.attackerUid}"]:not([data-sleeping="1"])`
    );
}

// When the map pane is small, a 50% fight window is too cramped — fill the whole map slot.
// (Also avoids the old bug where the theatre lived inside scroll content and opened off-screen.)
function shouldCombatTheatreFillMap() {
    const frame = document.getElementById('arena-map-frame')
        || document.getElementById('arena-map-scroll');
    if (!frame) return false;
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    // ~half-size window stops feeling like an overlay once the pane is phone-sized.
    return w < 560 || h < 380;
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
        placeCombatTheatreHeroes(leftHalf, leftParty, false);
        placeCombatTheatreHeroes(rightHalf, rightParty, true);

        theatre.classList.toggle('is-map-fill', shouldCombatTheatreFillMap());
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
            theatre.classList.remove('is-map-fill');
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
    const parent = heroEl.parentElement;
    const floatEl = document.createElement('div');
    floatEl.className = 'combat-theatre-float';
    floatEl.style.color = color;
    // Heroes are centered on left/top %; park the float just above their head.
    const cx = parseFloat(heroEl.style.left) || 50;
    const cy = parseFloat(heroEl.style.top) || 50;
    const heroH = heroEl.offsetHeight || Math.max(40, parent.clientHeight * 0.22);
    const aboveHeadPct = (heroH * 0.65 / Math.max(1, parent.clientHeight)) * 100;
    floatEl.style.left = cx + '%';
    floatEl.style.top = (cy - aboveHeadPct) + '%';
    const icon = kind === 'ranged' ? '➳' : '⚔';
    floatEl.textContent = `${damage} ${icon}`;
    parent.appendChild(floatEl);
    setTimeout(() => floatEl.remove(), COMBAT_FLOAT_MS);
}

function getTheatrePanel(heroEl) {
    return heroEl ? heroEl.closest('.combat-theatre-panel') : null;
}

function ensureTheatreVfxLayer(panel) {
    if (!panel) return null;
    let layer = panel.querySelector('.combat-theatre-vfx');
    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'combat-theatre-vfx';
        panel.appendChild(layer);
    }
    return layer;
}

// Hero centre as % of the full fight panel (so VFX can cross left/right halves).
function heroPointInTheatrePanel(heroEl) {
    const panel = getTheatrePanel(heroEl);
    if (!panel || !heroEl) return null;
    const panelRect = panel.getBoundingClientRect();
    const heroRect = heroEl.getBoundingClientRect();
    if (panelRect.width <= 0 || panelRect.height <= 0) return null;
    return {
        panel,
        x: ((heroRect.left + heroRect.width / 2) - panelRect.left) / panelRect.width * 100,
        y: ((heroRect.top + heroRect.height / 2) - panelRect.top) / panelRect.height * 100
    };
}

function setTheatreHeroAttackPose(heroEl, attacking) {
    if (!heroEl || heroEl.dataset.sleeping === '1') return;
    const role = heroEl.dataset.role;
    const faction = heroEl.dataset.faction;
    if (attacking) {
        if (!heroEl.dataset.idleSrc) {
            // Store the path we placed originally (not a resolved absolute URL if possible).
            heroEl.dataset.idleSrc = (HERO_PORTRAITS_TEAM[role] && HERO_PORTRAITS_TEAM[role][faction])
                || heroEl.getAttribute('src')
                || heroEl.src;
        }
        const attackSrc = resolveAttackPortraitSrc(role, faction);
        const fightSrc = teamAttackPortraitSrc(role, faction, 'fight');
        if (attackSrc) {
            heroEl.onerror = () => {
                if (fightSrc && heroEl.src.indexOf('_fight') === -1) heroEl.src = fightSrc;
                heroEl.onerror = null;
            };
            heroEl.src = attackSrc;
        }
    } else {
        const idle = heroEl.dataset.idleSrc
            || (HERO_PORTRAITS_TEAM[role] && HERO_PORTRAITS_TEAM[role][faction]);
        if (idle) heroEl.src = idle;
        heroEl.onerror = null;
        delete heroEl.dataset.idleSrc;
    }
}

function spawnTheatreImpact(panel, xPct, yPct) {
    const layer = ensureTheatreVfxLayer(panel);
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'combat-theatre-impact';
    el.style.left = xPct + '%';
    el.style.top = yPct + '%';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 360);
}

function spawnTheatreSlash(panel, xPct, yPct, towardRight) {
    const layer = ensureTheatreVfxLayer(panel);
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'combat-theatre-slash';
    el.style.left = xPct + '%';
    el.style.top = yPct + '%';
    el.style.setProperty('--slash-rot', towardRight ? '-35deg' : '35deg');
    layer.appendChild(el);
    setTimeout(() => el.remove(), 320);
}

function flyTheatreProjectile(fromEl, toEl, role) {
    return new Promise(resolve => {
        const from = heroPointInTheatrePanel(fromEl);
        const to = heroPointInTheatrePanel(toEl);
        if (!from || !to) {
            resolve();
            return;
        }
        const layer = ensureTheatreVfxLayer(from.panel);
        if (!layer) {
            resolve();
            return;
        }
        const el = document.createElement('div');
        const isOrb = role === 'Wizard';
        el.className = 'combat-theatre-projectile' + (isOrb ? ' is-orb' : '');
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        el.style.left = from.x + '%';
        el.style.top = from.y + '%';
        if (!isOrb) el.style.transform = `rotate(${angle}deg)`;
        layer.appendChild(el);

        const start = performance.now();
        function frame(now) {
            const t = Math.min(1, (now - start) / COMBAT_RANGED_FLIGHT_MS);
            const ease = t * t; // slight accelerate into the target
            el.style.left = (from.x + dx * ease) + '%';
            el.style.top = (from.y + dy * ease) + '%';
            if (t < 1) {
                requestAnimationFrame(frame);
            } else {
                el.remove();
                spawnTheatreImpact(from.panel, to.x, to.y);
                resolve();
            }
        }
        requestAnimationFrame(frame);
    });
}

function animateTheatreLeap(heroEl, fromLeft, toLeft, durationMs) {
    return new Promise(resolve => {
        if (!heroEl) {
            resolve();
            return;
        }
        const start = performance.now();
        function frame(now) {
            const t = Math.min(1, (now - start) / durationMs);
            // Ease out toward the apex / ease in on the return feels snappier.
            const ease = 1 - Math.pow(1 - t, 2);
            heroEl.style.left = (fromLeft + (toLeft - fromLeft) * ease) + '%';
            if (t < 1) requestAnimationFrame(frame);
            else resolve();
        }
        requestAnimationFrame(frame);
    });
}

// White flash on a fight-window hero (same 0.5s cadence as map select).
function flashTheatreHero(heroEl) {
    return new Promise(resolve => {
        if (!heroEl || heroEl.dataset.sleeping === '1') {
            resolve();
            return;
        }
        const role = heroEl.dataset.role;
        const faction = heroEl.dataset.faction;
        const flashSrc = teamFlashPortraitSrc(role);
        const normalSrc = (HERO_PORTRAITS_TEAM[role] && HERO_PORTRAITS_TEAM[role][faction]) || null;
        if (!flashSrc || !normalSrc) {
            resolve();
            return;
        }

        const start = performance.now();
        const token = String(start);
        heroEl.dataset.flashToken = token;

        function frame(now) {
            // Abort if another flash started or the hero already went to sleep.
            if (heroEl.dataset.flashToken !== token || heroEl.dataset.sleeping === '1') {
                resolve();
                return;
            }
            const elapsed = now - start;
            if (elapsed >= HERO_FLASH_TOTAL_MS) {
                heroEl.src = normalSrc;
                delete heroEl.dataset.flashToken;
                resolve();
                return;
            }
            const white = Math.floor(elapsed / HERO_FLASH_BEAT_MS) % 2 === 0;
            heroEl.src = white ? flashSrc : normalSrc;
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    });
}

// Damage floats + white flash + KO arcs for everyone hit by this strike.
async function resolveStrikeDefenderHits(strike) {
    const hits = strike.unitHits || [];
    const color = getTeamColor(strike.attackerFaction);
    const defender = arenaParties.find(p => p.uid === strike.defenderUid);

    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const heroEl = getCombatTheatreHeroEl(strike.defenderUid, hit.memberIndex);
        spawnTheatreFloat(heroEl, hit.damage, color, strike.kind);
        const flashPromise = flashTheatreHero(heroEl);
        if (hit.knockedOut && heroEl) {
            await Promise.all([flashPromise, animateTheatreKnockout(heroEl)]);
            if (defender && typeof defender.x === 'number') {
                // Map sleep faces the way they were walking on the arena, not theatre half.
                const faceLeft = partyFacesLeft(ensurePartyFacing(defender));
                queueCasualtyFromKnockout(
                    defender,
                    hit.memberIndex,
                    defender.x,
                    defender.y,
                    faceLeft
                );
            }
        } else {
            await Promise.all([flashPromise, sleepMs(COMBAT_FLOAT_MS)]);
        }
    }
}

async function playStrikeUnitHits(strike) {
    const hits = strike.unitHits || [];
    const attackerEl = getCombatTheatreAttackerEl(strike);
    let primaryTarget = null;
    for (let i = 0; i < hits.length; i++) {
        primaryTarget = getCombatTheatreHeroEl(strike.defenderUid, hits[i].memberIndex);
        if (primaryTarget) break;
    }
    if (!primaryTarget) {
        primaryTarget = document.querySelector(
            `.combat-theatre-hero[data-uid="${strike.defenderUid}"]:not([data-sleeping="1"])`
        );
    }

    // Kick defender hit FX at the contact / projectile-arrival moment; finish with the attack motion.
    let hitsPromise = Promise.resolve();
    const onImpact = () => {
        hitsPromise = resolveStrikeDefenderHits(strike);
    };

    if (strike.kind === 'ranged') {
        // Projectile flight triggers impact; attacker holds _attack for the full second.
        if (attackerEl) {
            setTheatreHeroAttackPose(attackerEl, true);
            const started = performance.now();
            await flyTheatreProjectile(attackerEl, primaryTarget || attackerEl, attackerEl.dataset.role);
            onImpact();
            const remain = COMBAT_RANGED_POSE_MS - (performance.now() - started);
            if (remain > 0) await sleepMs(remain);
            setTheatreHeroAttackPose(attackerEl, false);
        } else {
            onImpact();
        }
    } else {
        // Melee: leap out → slash/impact + damage → leap back.
        if (attackerEl && attackerEl.dataset.sleeping !== '1') {
            const parent = attackerEl.parentElement;
            const baseLeft = parseFloat(attackerEl.style.left) || 50;
            const faceLeft = attackerEl.dataset.faceLeft === '1';
            // Use laid-out width when possible; fall back to the CSS ~22% token width.
            const heroW = attackerEl.offsetWidth
                || (parent ? parent.clientWidth * 0.22 : 0)
                || 40;
            const leapPct = parent
                ? Math.max(8, (heroW * 0.5 / Math.max(1, parent.clientWidth)) * 100)
                : 10;
            const forwardLeft = Math.max(8, Math.min(92, baseLeft + (faceLeft ? -leapPct : leapPct)));

            setTheatreHeroAttackPose(attackerEl, true);
            await animateTheatreLeap(attackerEl, baseLeft, forwardLeft, COMBAT_MELEE_LEAP_MS);

            const tip = heroPointInTheatrePanel(attackerEl);
            if (tip) {
                spawnTheatreSlash(tip.panel, tip.x + (faceLeft ? -2 : 2), tip.y, !faceLeft);
                spawnTheatreImpact(tip.panel, tip.x + (faceLeft ? -3 : 3), tip.y);
            }
            onImpact();

            await animateTheatreLeap(attackerEl, forwardLeft, baseLeft, COMBAT_MELEE_LEAP_MS);
            setTheatreHeroAttackPose(attackerEl, false);
        } else {
            onImpact();
        }
    }

    await hitsPromise;
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
        await playCombatTelegraph(combat);
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
        // Map + info panel: tip upright heroes into sleep sprites where they fell.
        beginPendingMapCasualtyFalls();
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
        return;
    }

    // Next day begins — title card before the player plans again.
    if (arenaPhase === 'COMBAT' && currentRound >= 1 && currentRound <= 10) {
        enqueueDayTitleCard(currentRound);
    }
}

function applyGameOverSummary(data) {
    switchScreen('GAME_OVER');

    // Full-screen letterboxed art (same contain treatment as the landing splash).
    const screen = document.getElementById('screen-game-over');
    if (screen) {
        let bg = '/assets/backgrounds/end_loss.jpeg';
        if (data.result === 'VICTORY' || data.result === 'MINOR VICTORY') {
            bg = '/assets/backgrounds/end_win.jpeg';
        } else if (data.result === 'DRAW') {
            bg = '/assets/backgrounds/end_draw.jpeg';
        }
        screen.style.backgroundImage = `url('${bg}')`;
    }

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
            // Light grass (LG) and forest floor (DG) use fixed grass images.
            // Flat fill first so we still see colour while images load.
            ctx.fillStyle = fill;
            ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
            if (tile === 'LG' || tile === 'DG' || tile === 'LGY') {
                const variant = GRASS_VARIANT_MAP[y][x];
                const grassImg = getCachedGrassTile(variant);
                if (grassImg && grassImg.complete && grassImg.naturalWidth > 0) {
                    ctx.drawImage(grassImg, cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
                }
                // Verge sits on grass (and under trees/parties later): soft road edge facing neighbours.
                // Mountains aren't next to roads today, but the helper no-ops when unused.
                if (tile === 'LG' || tile === 'DG') {
                    const vergeLayers = getVergeLayersForGrass(x, y);
                    for (let i = 0; i < vergeLayers.length; i++) {
                        drawVergeLayer(cx, cy, ARENA_GRID.cellSize, vergeLayers[i]);
                    }
                }
            } else if (tile === 'DGY' || tile === 'RED') {
                // Roads and tower footprints share road art (tower sprite is drawn later).
                const roadVariant = ROAD_VARIANT_MAP[y][x];
                const roadImg = getCachedRoadTile(roadVariant);
                if (roadImg && roadImg.complete && roadImg.naturalWidth > 0) {
                    ctx.drawImage(roadImg, cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
                }
            }

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

    // Draw a spell book (owner tower colour). 50% bigger than the old 14×16 rect.
    // Glow on all books; stardust trail only while a carrier is mid-slide.
    function drawSpellBookIcon(centerX, centerY, ownerFaction) {
        const w = SPELLBOOK_DRAW_W;
        const h = SPELLBOOK_DRAW_H;
        const x = centerX - w / 2;
        const y = centerY - h / 2;
        const rgb = ownerFaction === 'p2' ? '214,40,40' : '30,136,229';
        const img = getCachedPortrait(spellbookIconSrc(ownerFaction));

        ctx.save();
        // Soft coloured halo behind the art.
        const glowR = Math.max(w, h) * 0.95;
        const grd = ctx.createRadialGradient(centerX, centerY, 2, centerX, centerY, glowR);
        grd.addColorStop(0, `rgba(${rgb},0.55)`);
        grd.addColorStop(0.55, `rgba(${rgb},0.2)`);
        grd.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(centerX, centerY, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowColor = `rgba(${rgb},0.95)`;
        ctx.shadowBlur = 14;
        ctx.imageSmoothingEnabled = true;
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';

        if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, x, y, w, h);
        } else {
            // Fallback if the PNG hasn't loaded yet.
            ctx.fillStyle = getTeamColor(ownerFaction);
            ctx.fillRect(x, y, w, h);
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#111';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, w, h);
        }
        ctx.restore();
    }

    // Stardust under books (emitted while carriers slide — see drawCarriedBookFor).
    drawSpellbookTrail(ctx);

    // Ground spell books — only on tiles you can see
    groundBooks.forEach(book => {
        if (!isTileVisible(visibleTiles, book.x, book.y)) return;
        const cx = ARENA_GRID.offsetX + (book.x * ARENA_GRID.cellSize) + ARENA_GRID.cellSize / 2;
        const cy = ARENA_GRID.offsetY + (book.y * ARENA_GRID.cellSize) + 14;
        drawSpellBookIcon(cx, cy, book.ownerFaction);
    });

    // Unconscious heroes left where they fell (under living tokens / trees that overlap).
    drawGroundCasualties(visibleTiles);

    // --- Parties + tall props (trees / towers), row by row, top → bottom ---
    // Props are bottom-aligned and overlap the tile above. Draw order per row:
    //   1) top-row heroes on prop tiles (behind their tree/tower)
    //   2) full party on non-prop tiles (so a prop below can cover them)
    //   3) trees + towers on this row (covers tile above; lower props cover upper ones)
    //   4) bottom-row heroes on prop tiles (in front of their own prop)
    const partiesByRow = {};
    arenaParties.forEach(ap => {
        if (typeof ap.x !== 'number' || typeof ap.y !== 'number') return;
        if (!partyIsAlive(ap)) return;

        const drawTile = getPartyDrawTile(ap);
        const fogX = Math.round(drawTile.x);
        const fogY = Math.round(drawTile.y);
        const isFriendly = ap.faction === myFaction;
        if (!isFriendly && !isTileVisible(visibleTiles, fogX, fogY)) return;

        const row = Math.max(0, Math.min(ARENA_GRID.height - 1, Math.round(drawTile.y)));
        if (!partiesByRow[row]) partiesByRow[row] = [];
        partiesByRow[row].push({ ap, drawTile });
    });

    function drawCarriedBookFor(ap, px, py) {
        if (!ap.carryingBook) return;
        const cx = px + ARENA_GRID.cellSize / 2;
        const cy = py + 4;
        // Magical tracer only while this party is sliding between tiles.
        if (walkAnimActiveUids[ap.uid]) {
            emitSpellbookTrail(cx, cy, ap.carryingBook);
        }
        drawSpellBookIcon(cx, cy, ap.carryingBook);
    }

    const drawDeploy = arenaPhase === 'DEPLOYMENT' && (myFaction === 'p1' || myFaction === 'p2');

    for (let y = 0; y < ARENA_GRID.height; y++) {
        const rowParties = partiesByRow[y] || [];

        // 1) Prop tiles: top heroes only (corners 0–1), behind the tree/tower
        rowParties.forEach(({ ap, drawTile }) => {
            const tileCode = getClientTileAt(Math.round(drawTile.x), Math.round(drawTile.y));
            if (!tileHasTallProp(tileCode)) return;
            const px = ARENA_GRID.offsetX + (drawTile.x * ARENA_GRID.cellSize);
            const py = ARENA_GRID.offsetY + (drawTile.y * ARENA_GRID.cellSize);
            drawPartySpritesOnTile(ap, px, py, 'top');
            // Carried book sits near the top of the tile → also behind the prop
            drawCarriedBookFor(ap, px, py);
        });

        // 2) Non-prop parties fully (a tall prop in the row below will cover them)
        rowParties.forEach(({ ap, drawTile }) => {
            const tileCode = getClientTileAt(Math.round(drawTile.x), Math.round(drawTile.y));
            if (tileHasTallProp(tileCode)) return;
            const px = ARENA_GRID.offsetX + (drawTile.x * ARENA_GRID.cellSize);
            const py = ARENA_GRID.offsetY + (drawTile.y * ARENA_GRID.cellSize);
            drawPartySpritesOnTile(ap, px, py, 'all');
            drawCarriedBookFor(ap, px, py);
        });

        // 2b) Deploy outline behind props on this row (and full outline on flat tiles)
        if (drawDeploy) drawDeploymentBoundary(myFaction, 'behind', y);

        // 3) Tall props on this row (fog matches the tile they sit in)
        for (let x = 0; x < ARENA_GRID.width; x++) {
            const tileCode = ARENA_TILE_MAP[y][x];
            const fogged = !isTileVisible(visibleTiles, x, y);
            if (tileCode === 'DG') {
                drawForestTreeAt(x, y, fogged);
            } else if (tileCode === 'LGY') {
                drawMountainRockAt(x, y, fogged);
            } else if (tileCode === 'RED') {
                let team = 'blue';
                if (buildingAnchors.right && buildingAnchors.right.x === x && buildingAnchors.right.y === y) {
                    team = 'red';
                } else if (buildingAnchors.left && buildingAnchors.left.x === x && buildingAnchors.left.y === y) {
                    team = 'blue';
                } else if (x > ARENA_GRID.width / 2) {
                    team = 'red'; // fallback if anchors missing
                }
                drawWizardTowerAt(x, y, team, fogged);
            }
        }

        // 4) Prop tiles: bottom heroes (corners 2–3), in front of their own prop
        rowParties.forEach(({ ap, drawTile }) => {
            const tileCode = getClientTileAt(Math.round(drawTile.x), Math.round(drawTile.y));
            if (!tileHasTallProp(tileCode)) return;
            const px = ARENA_GRID.offsetX + (drawTile.x * ARENA_GRID.cellSize);
            const py = ARENA_GRID.offsetY + (drawTile.y * ARENA_GRID.cellSize);
            drawPartySpritesOnTile(ap, px, py, 'bottom');
        });

        // 4b) Deploy outline in front of props on this row (bottom half only)
        if (drawDeploy) drawDeploymentBoundary(myFaction, 'front', y);
    }

    // Pre-fight ! / ? icons (drawn above parties so they stay readable).
    drawCombatTelegraphIcons();

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

}

function renderActiveScene() {
    if (currentRoomState !== 'TACTICAL_ARENA') return;
    syncArenaCanvasSize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawArenaScreen();
    // Cycle Zzz icons on any unconscious portraits currently in the DOM.
    const zzzSrc = sleepZzzSrc();
    document.querySelectorAll('.sleep-zzz').forEach(el => {
        if (el.getAttribute('src') !== zzzSrc) el.src = zzzSrc;
    });
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
    preloadGrassTiles();
    preloadTreeTiles();
    preloadRockTiles();
    preloadRoadAndVergeTiles();
    preloadTowerTiles();
    preloadSleepAssets();
    preloadCombatIcons();
    preloadFlashAssets();
    preloadAttackAssets();
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
    if (waiting) {
        joinBtn.textContent = 'Waiting for other player';
    } else {
        joinBtn.textContent = getSelectedLandingMode() === 'single' ? 'START GAME' : 'JOIN GAME';
    }
    if (nameInput) nameInput.disabled = waiting;
    if (codeInput) codeInput.disabled = waiting;
}

function getSelectedLandingMode() {
    const single = document.getElementById('landing-mode-single');
    return (single && single.checked) ? 'single' : 'multi';
}

function updateLandingModeUI() {
    const mode = getSelectedLandingMode();
    const codeInput = document.getElementById('input-room-code');
    const lobby = document.getElementById('landing-lobby-status');
    const lan = document.getElementById('lan-host-info');
    if (codeInput) {
        codeInput.style.display = mode === 'single' ? 'none' : '';
        if (mode === 'single') codeInput.value = 'SOLO';
        else if (!codeInput.value || codeInput.value === 'SOLO') codeInput.value = 'LOCAL';
    }
    if (lobby) lobby.style.display = mode === 'single' ? 'none' : '';
    if (lan) lan.style.display = mode === 'single' ? 'none' : '';
    setJoinWaitingState(false);
}

function wireNavigationButtons() {
    const modeSingle = document.getElementById('landing-mode-single');
    const modeMulti = document.getElementById('landing-mode-multi');
    if (modeSingle) modeSingle.addEventListener('change', updateLandingModeUI);
    if (modeMulti) modeMulti.addEventListener('change', updateLandingModeUI);
    updateLandingModeUI();

    document.getElementById('btn-join-game').addEventListener('click', () => {
        // User gesture: best chance for fullscreen + orientation.lock on mobile.
        tryLockLandscape();
        const joinBtn = document.getElementById('btn-join-game');
        if (joinBtn.disabled) return;

        const name = document.getElementById('input-player-name').value.trim();
        const mode = getSelectedLandingMode();
        const code = mode === 'single'
            ? 'SOLO'
            : document.getElementById('input-room-code').value.trim();
        if (!name) return;
        if (mode === 'multi' && !code) return;

        playerName = name;
        if (mode === 'multi') setJoinWaitingState(true);
        socket.emit('JOIN_GAME', { playerName: name, roomCode: code, mode });
    });

    document.getElementById('btn-go-tavern').addEventListener('click', () => {
        socket.emit('NAVIGATE_TO', { targetRoom: 'TAVERN' });
    });
    document.getElementById('btn-go-castle').addEventListener('click', () => {
        socket.emit('NAVIGATE_TO', { targetRoom: 'CASTLE' });
    });
    // Mobile: some browsers swallow the first tap as :hover only — also navigate on a clean tap.
    [['btn-go-tavern', 'TAVERN'], ['btn-go-castle', 'CASTLE']].forEach(([id, room]) => {
        const el = document.getElementById(id);
        if (!el) return;
        let tapStart = null;
        el.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            tapStart = { x: e.clientX, y: e.clientY, type: e.pointerType };
        });
        el.addEventListener('pointerup', (e) => {
            if (!tapStart) return;
            const dx = Math.abs(e.clientX - tapStart.x);
            const dy = Math.abs(e.clientY - tapStart.y);
            const type = tapStart.type;
            tapStart = null;
            if (dx > 14 || dy > 14) return;
            // Mouse still uses click; touch/pen navigate here so the first tap always counts.
            if (type === 'mouse') return;
            socket.emit('NAVIGATE_TO', { targetRoom: room });
        });
        el.addEventListener('pointercancel', () => { tapStart = null; });
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
    if (arenaTitleCardBlocking) return;

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
    // GAME_OVER waits for round playback (same rule as STATE_SYNC).
    if (payload.newState === 'GAME_OVER' && shouldDeferGameOverScreen()) return;
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
        prevArenaPhaseForTitle = 'DEPLOYMENT';
        lastArenaTitleDayShown = 0;
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
        // First beat: Place Parties title before any deployment clicks.
        enqueueArenaTitleCard('place_parties');
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
