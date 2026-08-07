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
const logOverlay = document.getElementById('combat-log-overlay');

// Team colours used on the arena canvas and in roster text.
const TEAM_COLORS = { p1: '#00ffff', p2: '#ff9800' };

// Display-only hero stat fallbacks for cards when the server only sends a role name.
const LOCAL_HERO_TEMPLATES = {
    'Peasant':   { hp: 30,  melee: 10, range: 0 },
    'Barbarian': { hp: 100, melee: 40, range: 0 },
    'Elf':       { hp: 50,  melee: 15, range: 25 },
    'Mage':      { hp: 40,  melee: 10, range: 35 },
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

// Which party token you clicked on the canvas (matches server uid, e.g. "p1-2").
let selectedPartyUid = null;
// Clickable party-list boxes drawn on the left of the arena canvas
let partyListHitBoxes = [];

// Combat planning: one entry per party number you control this round.
// { order: 'Advance', path: [{x,y}, ...] }
let localPlans = {};

let isWaitingForCombatResolution = false;
let matchActive = true;

// Party detail screen remembers where "Back" should return (TAVERN or CASTLE).
let partyDetailReturnTo = 'TAVERN';
let viewingPartyNumber = null;

let lobbyStatusText = { p1: 'DISCONNECTED', p2: 'DISCONNECTED', readyP1: false, readyP2: false };

// --- Arena grid layout (must match server.js ARENA_TILE_MAP) ---
// Wider canvas (1400): left party list | map | right selected-party details
const ARENA_GRID = { offsetX: 420, offsetY: 90, cellSize: 50, width: 11, height: 10 };
const PARTY_LIST_PANEL = { x: 16, y: 78, width: 380, rowH: 48, gap: 8 };
const DETAIL_PANEL = { x: 1000, y: 78, width: 380 };
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
    currentRoomState = newState;
    document.querySelectorAll('.game-screen').forEach(el => el.classList.remove('active'));
    const screenId = SCREEN_MAP[newState];
    if (screenId) document.getElementById(screenId).classList.add('active');
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

function renderHeroCards(container, heroes) {
    if (!container) return;
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
        card.innerHTML = `<h4>${h.role.toUpperCase()}</h4><p>❤ ${hpText} | ${heroAttackLabel(stats)}</p>`;
        container.appendChild(card);
    });
}

// Left column in the Tavern: clickable party rows open the detail screen.
function renderTavernRoster() {
    const container = document.getElementById('tavern-roster');
    if (!container) return;
    container.innerHTML = '';
    if (myParties.length === 0) {
        container.innerHTML = '<p style="color:#888;">No heroes recruited yet.</p>';
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
        container.innerHTML = '<p style="color:#888;">No parties yet — visit the Tavern.</p>';
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

    const heading = document.getElementById('party-detail-heading');
    const sub = document.getElementById('party-detail-sub');
    if (heading) heading.textContent = `Party ${party.number}`;
    if (sub) sub.textContent = party.name;
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
            // stay on briefing while still in castle hub flow; Town HQ means they navigated away
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
        if (data.arena.currentRound) currentRound = data.arena.currentRound;
        if (data.arena.phase) arenaPhase = data.arena.phase;
        if (data.arena.parties) {
            arenaParties = data.arena.parties;
            // Regular sync: keep paths the player is still drawing unless phase just changed.
            syncLocalPlansFromArena(false);
        }
        if (data.arena.groundBooks) groundBooks = data.arena.groundBooks;
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
    const goldIds = ['hq-gold', 'tavern-gold', 'castle-gold', 'mission-gold'];
    goldIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = playerGold;
    });

    const nameEl = document.getElementById('hq-player-name');
    if (nameEl) nameEl.textContent = playerName || 'Hero';

    renderTavernRoster();

    const offerTitle = document.getElementById('tavern-offer-title');
    if (offerTitle) offerTitle.textContent = currentOffer.name || 'Available Contract';
    renderHeroCards(document.getElementById('tavern-offer'), currentOffer.members || []);

    renderMissionPartyList();

    const hireBtn = document.getElementById('btn-hire-party');
    if (hireBtn) {
        hireBtn.textContent = `HIRE PARTY (${currentOffer.cost || 0}g)`;
        hireBtn.disabled = playerGold < (currentOffer.cost || 0) || !(currentOffer.members || []).length;
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
            ? 'DEPLOYMENT: select a party, click a red-bordered square, then READY'
            : `DAY: ${currentRound} / ${maxRounds}`;
    }

    updateOrderButtons();
    updateOrderButtonsEnabled();
    updateLockTurnButton();
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
    const base = { Seek: 1, Advance: 2, March: 3 };
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

// Thick red outline around the outer edge of the local player's deploy zone.
function drawDeploymentBoundary(faction) {
    const cells = getClientDeployCells(faction);
    if (!cells.length) return;
    const set = new Set(cells.map(c => `${c.x},${c.y}`));
    const size = ARENA_GRID.cellSize;

    ctx.save();
    ctx.strokeStyle = '#d62828';
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

// ==================== 6. ARENA CANVAS ====================

// Left column: clickable boxes for each of YOUR parties (selection UI).
function drawPartyListPanel(selected) {
    partyListHitBoxes = [];
    const mine = getMyArenaParties().slice().sort((a, b) => a.number - b.number);
    const team = getTeamColor(myFaction);

    ctx.textAlign = 'left';
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#aaa';
    ctx.fillText('YOUR PARTIES (click to select)', PARTY_LIST_PANEL.x, PARTY_LIST_PANEL.y - 8);

    mine.forEach((ap, idx) => {
        const x = PARTY_LIST_PANEL.x;
        const y = PARTY_LIST_PANEL.y + idx * (PARTY_LIST_PANEL.rowH + PARTY_LIST_PANEL.gap);
        const w = PARTY_LIST_PANEL.width;
        const h = PARTY_LIST_PANEL.rowH;
        const isSelected = selected && selected.uid === ap.uid;
        const alive = partyIsAlive(ap);

        ctx.fillStyle = isSelected ? 'rgba(255, 152, 0, 0.25)' : '#1a1a1a';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = isSelected ? team : '#444';
        ctx.lineWidth = isSelected ? 3 : 1;
        ctx.strokeRect(x, y, w, h);

        ctx.fillStyle = alive ? team : '#666';
        ctx.font = 'bold 14px monospace';
        ctx.fillText(`${ap.number}. ${ap.name}`, x + 10, y + 20);
        ctx.fillStyle = '#888';
        ctx.font = '12px monospace';
        const living = ap.members.filter(m => m.hp > 0).length;
        const planOrder = (localPlans[ap.number] && localPlans[ap.number].order) || ap.order || 'Advance';
        ctx.fillText(`${living}/${ap.members.length} standing  |  ${planOrder}`, x + 10, y + 38);

        partyListHitBoxes.push({ uid: ap.uid, x, y, w, h });
    });
}

// Right column: full name + member stats for the selected party.
function drawSelectedPartyDetail(selected) {
    const x = DETAIL_PANEL.x;
    const y = DETAIL_PANEL.y;
    const w = DETAIL_PANEL.width;

    ctx.fillStyle = '#141414';
    ctx.fillRect(x, y, w, 500);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, 500);

    ctx.textAlign = 'left';
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#aaa';
    ctx.fillText('SELECTED PARTY', x + 12, y + 22);

    if (!selected || selected.faction !== myFaction) {
        ctx.fillStyle = '#666';
        ctx.font = '13px monospace';
        ctx.fillText('Select a party from the list', x + 12, y + 56);
        ctx.fillText('on the left to view details', x + 12, y + 76);
        return;
    }

    ctx.fillStyle = getTeamColor(myFaction);
    ctx.font = 'bold 16px monospace';
    const title = `${selected.number}. ${selected.name}`;
    ctx.fillText(title.length > 34 ? title.slice(0, 33) + '…' : title, x + 12, y + 52);

    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    const plan = localPlans[selected.number];
    const shownOrder = (plan && plan.order) || selected.order || 'Advance';
    ctx.fillText(`Order: ${shownOrder}`, x + 12, y + 74);

    selected.members.forEach((h, idx) => {
        const rowY = y + 110 + (idx * 72);
        ctx.fillStyle = '#222';
        ctx.fillRect(x + 10, rowY - 22, w - 20, 64);
        ctx.strokeStyle = '#444';
        ctx.strokeRect(x + 10, rowY - 22, w - 20, 64);

        ctx.fillStyle = h.hp > 0 ? '#ff9800' : '#ff5555';
        ctx.font = 'bold 14px monospace';
        ctx.fillText(h.role.toUpperCase(), x + 20, rowY);

        ctx.fillStyle = h.hp > 0 ? '#fff' : '#ff5555';
        ctx.font = '13px monospace';
        const hpLine = h.hp > 0 ? `❤ ${h.hp}/${h.baseHp} HP` : 'UNCONSCIOUS';
        ctx.fillText(hpLine, x + 20, rowY + 22);

        const melee = h.melee != null ? h.melee : (LOCAL_HERO_TEMPLATES[h.role] || {}).melee;
        const range = h.range != null ? h.range : (LOCAL_HERO_TEMPLATES[h.role] || {}).range;
        ctx.fillStyle = '#aaa';
        ctx.fillText(`⚔ ${melee} Melee   🏹 ${range} Range`, x + 20, rowY + 40);
    });
}

function drawArenaScreen() {
    // --- Title bar ---
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, 60);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TOO MANY HEROES - COMBAT ARENA - ', 20, 38);
    const titleWidth = ctx.measureText('TOO MANY HEROES - COMBAT ARENA - ').width;
    ctx.fillStyle = getTeamColor(myFaction);
    ctx.fillText(playerName || 'Hero', 20 + titleWidth, 38);

    ctx.fillStyle = '#ff9800';
    ctx.textAlign = 'right';
    ctx.fillText(
        arenaPhase === 'DEPLOYMENT' ? 'DEPLOYMENT PHASE' : `DAY: ${currentRound} / ${maxRounds}`,
        canvas.width - 20,
        38
    );

    const selected = getSelectedArenaParty();

    // Left: party list | Centre: map | Right: selected party details
    drawPartyListPanel(selected);
    drawSelectedPartyDetail(selected);

    // Path highlight for the selected party (combat only).
    const selectedPlan = getSelectedPlan();
    const pathHighlight = (arenaPhase === 'COMBAT' && selectedPlan) ? selectedPlan.path : [];

    // Fog of War: tiles within 2 travel steps of any living friendly party.
    const visibleTiles = buildVisibleTileSet();

    // --- Grid tiles ---
    for (let y = 0; y < ARENA_GRID.height; y++) {
        for (let x = 0; x < ARENA_GRID.width; x++) {
            const cx = ARENA_GRID.offsetX + (x * ARENA_GRID.cellSize);
            const cy = ARENA_GRID.offsetY + (y * ARENA_GRID.cellSize);
            const tile = ARENA_TILE_MAP[y][x];
            const fogged = !isTileVisible(visibleTiles, x, y);

            ctx.fillStyle = ARENA_TILE_COLORS[tile] || ARENA_TILE_COLORS.LG;
            ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);

            // Darken tiles outside your vision so fog is obvious
            if (fogged) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
            }

            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.strokeRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);

            if (pathHighlight.some(c => c.x === x && c.y === y)) {
                ctx.fillStyle = myFaction === 'p1' ? 'rgba(0, 255, 255, 0.35)' : 'rgba(255, 152, 0, 0.35)';
                ctx.fillRect(cx + 2, cy + 2, ARENA_GRID.cellSize - 4, ARENA_GRID.cellSize - 4);
            }
        }
    }

    // Draw a small book shape in the OWNER tower's colour (emoji ignore fillStyle).
    // So an Orange spell book stays orange whether Cyan or Orange is holding it.
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

    // --- Party tokens (living only; enemies hidden in fog) ---
    arenaParties.forEach(ap => {
        if (typeof ap.x !== 'number' || typeof ap.y !== 'number') return;
        // Defeated parties leave the board entirely
        if (!partyIsAlive(ap)) return;

        const isFriendly = ap.faction === myFaction;
        // Enemies only appear on tiles inside your fog vision
        if (!isFriendly && !isTileVisible(visibleTiles, ap.x, ap.y)) return;

        const cx = ARENA_GRID.offsetX + (ap.x * ARENA_GRID.cellSize);
        const cy = ARENA_GRID.offsetY + (ap.y * ARENA_GRID.cellSize);
        const color = getTeamColor(ap.faction);

        ctx.fillStyle = color;
        ctx.fillRect(cx + 6, cy + 14, ARENA_GRID.cellSize - 12, ARENA_GRID.cellSize - 22);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(ap.number), cx + ARENA_GRID.cellSize / 2, cy + ARENA_GRID.cellSize - 8);

        // Carried book above token — ALWAYS the book owner's colour (not the carrier's)
        if (ap.carryingBook) {
            drawSpellBookIcon(
                cx + ARENA_GRID.cellSize / 2,
                cy + 8,
                ap.carryingBook
            );
        }
    });

    // Thick outline on the selected living party's tile (deployment AND combat).
    if (selected && partyIsAlive(selected) && typeof selected.x === 'number' && typeof selected.y === 'number') {
        const cx = ARENA_GRID.offsetX + (selected.x * ARENA_GRID.cellSize);
        const cy = ARENA_GRID.offsetY + (selected.y * ARENA_GRID.cellSize);
        ctx.save();
        ctx.strokeStyle = getTeamColor(selected.faction);
        ctx.lineWidth = 4;
        ctx.strokeRect(cx + 2, cy + 2, ARENA_GRID.cellSize - 4, ARENA_GRID.cellSize - 4);
        ctx.restore();
    }

    // Red deploy boundary for your faction during deployment.
    if (arenaPhase === 'DEPLOYMENT' && (myFaction === 'p1' || myFaction === 'p2')) {
        drawDeploymentBoundary(myFaction);
    }
}

function renderActiveScene() {
    if (currentRoomState !== 'TACTICAL_ARENA') return;
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
        });
    });

    document.getElementById('btn-lock-turn').addEventListener('click', onLockOrReadyClick);
}

// Convert a mouse click on the canvas into grid coordinates.
function canvasCellFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const cellX = Math.floor((mouseX - ARENA_GRID.offsetX) / ARENA_GRID.cellSize);
    const cellY = Math.floor((mouseY - ARENA_GRID.offsetY) / ARENA_GRID.cellSize);
    if (cellX < 0 || cellX >= ARENA_GRID.width || cellY < 0 || cellY >= ARENA_GRID.height) return null;
    return { x: cellX, y: cellY };
}

canvas.addEventListener('click', (event) => {
    if (currentRoomState !== 'TACTICAL_ARENA' || myFaction === 'spectator' || !matchActive) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Party selection is via the LEFT LIST boxes only (not map tokens).
    const hit = partyListHitBoxes.find(b =>
        mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h
    );
    if (hit) {
        selectedPartyUid = hit.uid;
        updateOrderButtons();
        updateOrderButtonsEnabled();
        return;
    }

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
});

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
        arenaParties = data.arenaParties || [];
        groundBooks = [];
        arenaPhase = 'DEPLOYMENT';
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
});

socket.on('resolve-round', (data) => {
    arenaParties = data.arenaParties || arenaParties;
    if (data.groundBooks) groundBooks = data.groundBooks;
    if (data.nextRound) currentRound = data.nextRound;

    // Clear paths but keep orders from the server snapshot.
    getMyLivingArenaParties().forEach(ap => {
        localPlans[ap.number] = {
            order: ap.order || 'Advance',
            path: []
        };
    });

    isWaitingForCombatResolution = false;
    updateLockTurnButton();
    renderSyncedUI();

    if (logOverlay && data.log) {
        logOverlay.innerHTML += `<div style="margin-bottom: 6px; border-left: 2px solid #00ff00; padding-left: 6px; color: #00ff00; font-family: monospace;">${data.log}</div>`;
        logOverlay.scrollTop = logOverlay.scrollHeight;
    }
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
