// =============================================================================
// TOO MANY HEROES — CLIENT (the "eyes and hands")
// =============================================================================
// Plain English: this file DRAWS the game and SENDS your clicks to the server.
// It does NOT decide combat results, gold changes, or who won.
// When the server says "your gold is 80", we show 80 — we don't invent a new number.
//
// Surgical patch protocol: change only the screen / button / listener you need.
// Keep socket event names matching server.js.
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

const Assets = {};

// Display-only hero labels for cards. Real HP in combat comes from the server party arrays.
const LOCAL_HERO_TEMPLATES = {
    'Peasant':   { hp: 30,  melee: 10, range: 0 },
    'Barbarian': { hp: 100, melee: 40, range: 0 },
    'Elf':       { hp: 50,  melee: 15, range: 25 },
    'Mage':      { hp: 40,  melee: 10, range: 35 },
    'Knight':    { hp: 120, melee: 25, range: 0 }
};

// Maps server room-state names -> HTML element ids (only one screen is .active)
const SCREEN_MAP = {
    'LANDING': 'screen-landing',
    'TOWN_HQ': 'screen-town-hq',
    'TAVERN': 'screen-tavern',
    'CASTLE': 'screen-castle',
    'TACTICAL_ARENA': 'screen-tactical-arena',
    'GAME_OVER': 'screen-game-over'
};

let uiButtons = {};
let isWaitingForOpponentLaunch = false; // true after you launch a quest and wait for the other player
let matchActive = true;
let currentRound = 1;
let playerGold = 100;
let playerName = '';
let isWaitingForCombatResolution = false; // true after LOCK IN until resolve-round arrives

const ARENA_GRID = { offsetX: 205, offsetY: 90, cellSize: 50, width: 11, height: 10 };

// Colour legend (must match server.js ARENA_TILE_MAP):
// Light Green (LG) = Grass | Dark Green (DG) = Forest | Light Grey (LGY) = Mountain
// Dark Grey (DGY) = Road | Red (RED) = Building
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
// Mountains and Buildings cannot be walked on (preview only — server enforces for real)
const BLOCKED_TILES = { RED: true, LGY: true };

let p1Party = [];
let p2Party = [];
let currentTavernOffer = [];
let currentTavernCost = 0;
let myDraftParty = [];

// Defaults match server starts: P1 north of west building, P2 south of east building
let p1X = 1, p1Y = 1;
let p2X = 9, p2Y = 8;
let selectedPath = [];
let p1SelectedOrder = 'Advance';
let p2SelectedOrder = 'Advance';

let lobbyStatusText = { p1: 'DISCONNECTED', p2: 'DISCONNECTED', readyP1: false, readyP2: false };

// ==================== 2. SCREEN SWITCHER & STATE SYNC RENDER ====================
function switchScreen(newState) {
    currentRoomState = newState;
    document.querySelectorAll('.game-screen').forEach(el => el.classList.remove('active'));
    const screenId = SCREEN_MAP[newState];
    if (screenId) document.getElementById(screenId).classList.add('active');
}

function heroAttackLabel(stats) {
    return stats.range > 0 ? `🏹${stats.range} Ranged` : `⚔${stats.melee} Melee`;
}

function renderHeroCards(container, heroes, mode) {
    if (!container) return;
    container.innerHTML = '';
    heroes.forEach(h => {
        const card = document.createElement('div');
        card.className = 'hero-card';
        const stats = LOCAL_HERO_TEMPLATES[h.role] || h;
        const hpText = h.hp !== undefined ? (h.hp > 0 ? `${h.hp}/${h.baseHp} HP` : 'UNCONSCIOUS') : `${stats.hp} HP`;
        card.innerHTML = `<h4>${h.role.toUpperCase()}</h4><p>❤ ${hpText} | ${heroAttackLabel(stats)}</p>`;
        container.appendChild(card);
    });
    if (heroes.length === 0 && mode === 'roster') {
        container.innerHTML = '<p style="color:#888;">No heroes recruited yet.</p>';
    }
}

// Apply a full server snapshot. This is the main "paint from truth" entry point.
function applyStateSync(data) {
    // During hub play, each player can be in a different room (Tavern vs Castle).
    if (data.roomState) switchScreen(data.roomState);

    if (data.lobby) {
        lobbyStatusText.p1 = data.lobby.players.p1 ? 'CONNECTED' : 'DISCONNECTED';
        lobbyStatusText.p2 = data.lobby.players.p2 ? 'CONNECTED' : 'DISCONNECTED';
        lobbyStatusText.readyP1 = data.lobby.readyStatus.p1;
        lobbyStatusText.readyP2 = data.lobby.readyStatus.p2;
        const p1El = document.getElementById('landing-p1-status');
        const p2El = document.getElementById('landing-p2-status');
        if (p1El) p1El.textContent = lobbyStatusText.p1 === 'DISCONNECTED' ? 'DISCONNECTED' : (lobbyStatusText.readyP1 ? 'READY!' : 'CONNECTED');
        if (p2El) p2El.textContent = lobbyStatusText.p2 === 'DISCONNECTED' ? 'DISCONNECTED' : (lobbyStatusText.readyP2 ? 'READY!' : 'CONNECTED');
    }

    if (data.player && data.player.faction === myFaction) {
        playerGold = data.player.gold;
        currentTavernOffer = data.player.offer || [];
        currentTavernCost = data.player.cost || 0;
        myDraftParty = data.player.draftParty || [];
        playerName = data.player.playerName || playerName;
        if (myFaction === 'p1') p1Party = myDraftParty.length ? myDraftParty : p1Party;
        if (myFaction === 'p2') p2Party = myDraftParty.length ? myDraftParty : p2Party;
    }

    if (data.arena) {
        if (data.arena.currentRound) currentRound = data.arena.currentRound;
        if (data.arena.p1Party && data.arena.p1Party.length) p1Party = data.arena.p1Party;
        if (data.arena.p2Party && data.arena.p2Party.length) p2Party = data.arena.p2Party;
        if (data.arena.p1Pos) { p1X = data.arena.p1Pos.x; p1Y = data.arena.p1Pos.y; }
        if (data.arena.p2Pos) { p2X = data.arena.p2Pos.x; p2Y = data.arena.p2Pos.y; }
    }

    renderSyncedUI();
}

function renderSyncedUI() {
    const goldIds = ['hq-gold', 'tavern-gold', 'castle-gold'];
    goldIds.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = playerGold; });

    const nameEl = document.getElementById('hq-player-name');
    if (nameEl) nameEl.textContent = playerName || 'Hero';

    const myParty = myFaction === 'p1' ? p1Party : p2Party;
    renderHeroCards(document.getElementById('tavern-roster'), myParty, 'roster');
    renderHeroCards(document.getElementById('tavern-offer'), currentTavernOffer, 'offer');
    renderHeroCards(document.getElementById('castle-party-slots'), myParty, 'roster');

    const hireBtn = document.getElementById('btn-hire-party');
    if (hireBtn) {
        hireBtn.textContent = `HIRE PARTY (${currentTavernCost}g)`;
        hireBtn.disabled = playerGold < currentTavernCost || currentTavernOffer.length === 0;
    }
    const rerollBtn = document.getElementById('btn-reroll-offer');
    if (rerollBtn) rerollBtn.disabled = playerGold < 5;

    const roundLabel = document.getElementById('arena-round-label');
    if (roundLabel) roundLabel.textContent = `ROUND: ${currentRound} / 4`;

    const waitEl = document.getElementById('castle-quest-wait');
    if (waitEl) waitEl.style.display = isWaitingForOpponentLaunch ? 'block' : 'none';

    const launchBtn = document.getElementById('btn-launch-quest');
    if (launchBtn) launchBtn.disabled = isWaitingForOpponentLaunch;

    updateOrderButtons();
    updateLockTurnButton();
}

function updateOrderButtons() {
    const currentOrder = myFaction === 'p1' ? p1SelectedOrder : p2SelectedOrder;
    document.querySelectorAll('.order-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.order === currentOrder);
    });
}

function updateLockTurnButton() {
    const btn = document.getElementById('btn-lock-turn');
    if (!btn) return;
    btn.disabled = isWaitingForCombatResolution || myFaction === 'spectator';
    btn.textContent = isWaitingForCombatResolution
        ? "WAITING FOR OPPONENT'S STRATEGY..."
        : 'LOCK IN ORDERS FOR THIS ROUND';
}

// --- Terrain helpers for PATH PREVIEW (keep identical to server.js helpers) ---
function getClientTileAt(x, y) {
    if (y < 0 || y >= ARENA_TILE_MAP.length) return null;
    if (x < 0 || x >= ARENA_TILE_MAP[y].length) return null;
    return ARENA_TILE_MAP[y][x];
}

function isClientBlockedTile(x, y) {
    const tile = getClientTileAt(x, y);
    return !tile || BLOCKED_TILES[tile] === true;
}

// How far you can path this turn, based on the tile you START on.
// Road +1, Forest -1 (min 1). Same math as server getMovementCapacity.
function getClientMovementCapacity(order, startX, startY) {
    const base = { Seek: 1, Advance: 2, March: 3 };
    let capacity = base[order] || 2;
    const tile = getClientTileAt(startX, startY);
    if (tile === 'DGY') capacity += 1;
    else if (tile === 'DG') capacity = Math.max(1, capacity - 1);
    return capacity;
}

function applyTavernSync(data) {
    playerGold = data.gold;
    currentTavernOffer = data.offer;
    currentTavernCost = data.cost;
    if (myFaction === 'p1') p1Party = data.party;
    if (myFaction === 'p2') p2Party = data.party;
    myDraftParty = data.party;
    renderSyncedUI();
}

// ==================== 3. SOCKET ACTIONS ====================
// Pattern for all of these: emit an INTENT to the server, then wait for STATE_SYNC
// (or a specialized event) before trusting the new numbers on screen.

function rerollTavernOffer() {
    socket.emit('tavern-reroll', { faction: myFaction });
}

function hireTavernParty() {
    socket.emit('tavern-hire', { faction: myFaction });
}

function launchQuest() {
    // We mark "waiting" locally for UX only; combat still starts only when the server says so.
    socket.emit('LAUNCH_QUEST', { questId: 'skirmish_patrol', partyId: 'party_1' });
    isWaitingForOpponentLaunch = true;
    renderSyncedUI();
}

function submitLobbyReady() {
    if (myFaction === 'spectator') return;
    socket.emit('player-ready', { faction: myFaction });
}

function submitTurn() {
    // Path preview was built by clicks below; server re-validates path length & adjacency.
    const order = myFaction === 'p1' ? p1SelectedOrder : p2SelectedOrder;
    socket.emit('submit-turn', { faction: myFaction, order, path: selectedPath });
    isWaitingForCombatResolution = true;
    updateLockTurnButton();
}

// ==================== 4. ARENA CANVAS (TACTICAL ARENA ONLY) ====================
function generateColorPlaceholder(color, width, height) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.fillStyle = color;
    tempCtx.fillRect(0, 0, width, height);
    const img = new Image();
    img.src = tempCanvas.toDataURL();
    return img;
}

function drawArenaScreen() {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, 60);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TOO MANY HEROES - COMBAT ARENA', 20, 38);
    ctx.fillStyle = '#ff9800';
    ctx.textAlign = 'right';
    ctx.fillText(`ROUND: ${currentRound} / 4`, canvas.width - 20, 38);

    ctx.textAlign = 'left';
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = '#00ffff';
    ctx.fillText('PLAYER 1 (CYAN)', 30, 95);
    p1Party.forEach((h, idx) => {
        ctx.fillStyle = h.hp > 0 ? '#fff' : '#ff5555';
        ctx.fillText(`• ${h.role} (${h.hp}/${h.baseHp} HP)`, 30, 120 + (idx * 22));
    });

    ctx.fillStyle = '#ff9800';
    ctx.fillText('PLAYER 2 (ORANGE)', canvas.width - 220, 95);
    p2Party.forEach((h, idx) => {
        ctx.fillStyle = h.hp > 0 ? '#fff' : '#ff5555';
        ctx.fillText(`• ${h.role} (${h.hp}/${h.baseHp} HP)`, canvas.width - 220, 120 + (idx * 22));
    });

    for (let y = 0; y < ARENA_GRID.height; y++) {
        for (let x = 0; x < ARENA_GRID.width; x++) {
            const cx = ARENA_GRID.offsetX + (x * ARENA_GRID.cellSize);
            const cy = ARENA_GRID.offsetY + (y * ARENA_GRID.cellSize);
            const tile = ARENA_TILE_MAP[y][x];

            ctx.fillStyle = ARENA_TILE_COLORS[tile] || ARENA_TILE_COLORS.LG;
            ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.strokeRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);

            if (selectedPath.some(c => c.x === x && c.y === y)) {
                ctx.fillStyle = myFaction === 'p1' ? 'rgba(0, 255, 255, 0.35)' : 'rgba(255, 152, 0, 0.35)';
                ctx.fillRect(cx + 2, cy + 2, ARENA_GRID.cellSize - 4, ARENA_GRID.cellSize - 4);
            }
            if (x === p1X && y === p1Y) {
                ctx.fillStyle = '#00ffff';
                ctx.fillRect(cx + 6, cy + 14, ARENA_GRID.cellSize - 12, ARENA_GRID.cellSize - 22);
                ctx.fillStyle = '#000';
                ctx.font = 'bold 14px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('P1', cx + ARENA_GRID.cellSize / 2, cy + ARENA_GRID.cellSize - 8);
            } else if (x === p2X && y === p2Y) {
                ctx.fillStyle = '#ff9800';
                ctx.fillRect(cx + 6, cy + 14, ARENA_GRID.cellSize - 12, ARENA_GRID.cellSize - 22);
                ctx.fillStyle = '#000';
                ctx.font = 'bold 14px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('P2', cx + ARENA_GRID.cellSize / 2, cy + ARENA_GRID.cellSize - 8);
            }
        }
    }
}

function renderActiveScene() {
    if (currentRoomState !== 'TACTICAL_ARENA') return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    uiButtons = {};
    drawArenaScreen();
}

function startGameLoop() {
    function tick() { renderActiveScene(); requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
}

function loadGameAssets() {
    Assets['bg_title'] = generateColorPlaceholder('#1a0f00', 960, 640);
    startGameLoop();
    switchScreen('LANDING');
}

// ==================== 5. DOM EVENT WIRING ====================
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

    document.getElementById('btn-hire-party').addEventListener('click', hireTavernParty);
    document.getElementById('btn-reroll-offer').addEventListener('click', rerollTavernOffer);
    document.getElementById('btn-launch-quest').addEventListener('click', launchQuest);

    document.querySelectorAll('.order-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const order = btn.dataset.order;
            if (myFaction === 'p1') p1SelectedOrder = order;
            else if (myFaction === 'p2') p2SelectedOrder = order;
            selectedPath = [];
            updateOrderButtons();
        });
    });
    document.getElementById('btn-lock-turn').addEventListener('click', submitTurn);
}

// Arena click = build a PATH PREVIEW for your warband.
// This is a helpful draft for the player. The server still validates the path on submit-turn.
canvas.addEventListener('click', (event) => {
    if (currentRoomState !== 'TACTICAL_ARENA' || myFaction === 'spectator' || !matchActive) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const cellX = Math.floor((mouseX - ARENA_GRID.offsetX) / ARENA_GRID.cellSize);
    const cellY = Math.floor((mouseY - ARENA_GRID.offsetY) / ARENA_GRID.cellSize);

    if (cellX >= 0 && cellX < ARENA_GRID.width && cellY >= 0 && cellY < ARENA_GRID.height) {
        const homeX = myFaction === 'p1' ? p1X : p2X;
        const homeY = myFaction === 'p1' ? p1Y : p2Y;
        const currentOrder = myFaction === 'p1' ? p1SelectedOrder : p2SelectedOrder;
        // Capacity uses STARTING tile (Road/Forest), matching server getMovementCapacity
        const maxCapacity = getClientMovementCapacity(currentOrder, homeX, homeY);

        // Clicking an already-selected cell trims the path back to that point
        const existingIndex = selectedPath.findIndex(c => c.x === cellX && c.y === cellY);
        if (existingIndex !== -1) { selectedPath = selectedPath.slice(0, existingIndex); return; }
        if (selectedPath.length >= maxCapacity) return;
        // Buildings and Mountains: never add to the preview path
        if (isClientBlockedTile(cellX, cellY)) return;

        const anchorX = selectedPath.length === 0 ? homeX : selectedPath[selectedPath.length - 1].x;
        const anchorY = selectedPath.length === 0 ? homeY : selectedPath[selectedPath.length - 1].y;

        // Only allow one step to an adjacent (non-diagonal) cell
        if (Math.abs(cellX - anchorX) + Math.abs(cellY - anchorY) === 1) {
            selectedPath.push({ x: cellX, y: cellY });
        }
    }
});

// ==================== 6. SOCKET LISTENERS (PRESERVED + NEW) ====================
// Listeners = "the server told us something changed; update the picture."
// Do not compute combat outcomes here — only apply payloads from the server.

socket.on('assign-player', (data) => { myFaction = data.faction; });

socket.on('lobby-status', (data) => {
    lobbyStatusText.p1 = data.players.p1 ? 'CONNECTED' : 'DISCONNECTED';
    lobbyStatusText.p2 = data.players.p2 ? 'CONNECTED' : 'DISCONNECTED';
    lobbyStatusText.readyP1 = data.readyStatus.p1;
    lobbyStatusText.readyP2 = data.readyStatus.p2;
    renderSyncedUI();
});

socket.on('ROOM_TRANSITION', (payload) => {
    switchScreen(payload.newState);
});

socket.on('STATE_SYNC', (data) => { applyStateSync(data); });

socket.on('transition-stage', (data) => {
    if (data.stage === 'merchant-guild') switchScreen('TAVERN');
    if (data.stage === 'combat-arena') {
        if (data.p1Party) p1Party = data.p1Party;
        if (data.p2Party) p2Party = data.p2Party;
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
        banner.className = 'outcome-banner ' + (data.result === 'VICTORY' ? 'outcome-victory' : 'outcome-defeat');
    }
    const goldEl = document.getElementById('game-over-gold');
    if (goldEl) goldEl.textContent = data.goldEarned;
});

socket.on('resolve-round', (data) => {
    if (data.p1) { p1X = data.p1.x; p1Y = data.p1.y; }
    if (data.p2) { p2X = data.p2.x; p2Y = data.p2.y; }
    if (data.p1Party && Array.isArray(data.p1Party)) p1Party = data.p1Party;
    if (data.p2Party && Array.isArray(data.p2Party)) p2Party = data.p2Party;
    if (data.nextRound) currentRound = data.nextRound;

    isWaitingForCombatResolution = false;
    selectedPath = [];
    updateLockTurnButton();
    renderSyncedUI();

    if (logOverlay && data.log) {
        logOverlay.innerHTML += `<div style="margin-bottom: 6px; border-left: 2px solid #00ff00; padding-left: 6px; color: #00ff00; font-family: monospace;">${data.log}</div>`;
        logOverlay.scrollTop = logOverlay.scrollHeight;
    }
});

wireNavigationButtons();
loadGameAssets();
