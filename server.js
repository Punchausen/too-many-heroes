// =============================================================================
// TOO MANY HEROES — SERVER (the "brain" of the game)
// =============================================================================
// Plain English: this file decides what is TRUE in the game.
// - Combat damage, movement, gold, parties, and which screen you're on all live HERE.
// - The browser (client.js) only DRAWS what we send it — it does not invent results.
//
// Multi-party edition: each player can own many named parties in the hub, field up
// to four for a mission, and fight with each party as its own token on the arena grid.
// =============================================================================

const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const PORT = 3000;
// Listen on all interfaces so other PCs on your home LAN can connect.
// Your Windows Firewall "Private network" allow is what keeps this off the public internet.
const HOST = '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname + '/public'));
app.get('/', (req, res) => { res.sendFile(__dirname + '/public/index.html'); });

// List this PC's LAN IPv4 addresses (e.g. 192.168.x.x) so family can open the right URL.
function getLanIpv4Addresses() {
    const nets = os.networkInterfaces();
    const results = [];
    Object.keys(nets).forEach(name => {
        nets[name].forEach(net => {
            // Skip internal (127.0.0.1) and non-IPv4
            const family = net.family === 'IPv4' || net.family === 4;
            if (family && !net.internal) results.push(net.address);
        });
    });
    return results;
}

// Landing page uses this to show "tell Player 2 to open …"
app.get('/api/host-info', (req, res) => {
    const addresses = getLanIpv4Addresses();
    res.json({
        port: PORT,
        localhostUrl: `http://localhost:${PORT}`,
        lanUrls: addresses.map(ip => `http://${ip}:${PORT}`)
    });
});

// --- SESSION STATE ---
let players = {};                       // socket ids for p1 / p2
let readyStatus = { p1: false, p2: false };
let gameStarted = false;
let currentRound = 1;
let roomState = 'LANDING';              // LANDING | HUB | TACTICAL_ARENA | GAME_OVER

// --- ARENA STATE (multi-party) ---
// Each entry is one fielded party on the grid with its own position and order.
// carryingBook: null | 'p1' | 'p2' — which tower the carried spell book belongs to.
let arenaParties = [];
let arenaPhase = 'IDLE';                // IDLE | DEPLOYMENT | COMBAT
let deployReady = { p1: false, p2: false };
// Locked orders for the current round — one entry per faction once they submit-turn.
let pendingMoves = { p1: null, p2: null };
// Spell books sitting on the ground after a carrier was knocked out.
// ownerFaction = which wizard tower the book originally came from.
let groundBooks = [];
// After GAME_OVER, each player returns to HQ on their own time.
let postMatchReturned = { p1: false, p2: false };

const NAVIGABLE_ROOMS = ['TOWN_HQ', 'TAVERN', 'CASTLE'];
const INITIATIVE_ORDER = { Seek: 1, Advance: 2, March: 3 };
const INITIATIVE_BANDS = ['Seek', 'Advance', 'March'];
const ORDER_CAPACITIES = { Seek: 1, Advance: 2, March: 3 };
const GRID_MAX_X = 10;
const GRID_MAX_Y = 9;
const MAX_FIELDED_PARTIES = 4;
const MAX_ROUNDS = 10;              // "10 days" — then check held enemy books / draw
const VICTORY_GOLD = 100;           // Full win (deliver book or wipe enemies)
const MINOR_VICTORY_GOLD = 50;      // After day 10: holding more enemy books than opponent

// --- TERRAIN MAP (must stay in sync with public/js/client.js ARENA_TILE_MAP) ---
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
const BLOCKED_TILES = { RED: true, LGY: true };

const HERO_TEMPLATES = {
    Peasant:   { hp: 30,  melee: 10, range: 0 },
    Barbarian: { hp: 100, melee: 40, range: 0 },
    Elf:       { hp: 50,  melee: 15, range: 25 },
    Mage:      { hp: 40,  melee: 10, range: 35 },
    Knight:    { hp: 120, melee: 25, range: 0 }
};

const TAVERN_POOL = ['Barbarian', 'Elf', 'Mage', 'Knight', 'Peasant'];

// All 100 party names from product — pick randomly, avoid reuse until pool is exhausted.
const PARTY_NAME_POOL = [
    'Alpha Squad', 'The Golden Griffins', 'Dungeon Crawlers', 'The Iron Vanguard',
    'Spellbound Syndicate', 'The Misfit Mercenaries', 'Shadow Stalkers', 'The Tavern Brawlers',
    'Arcane Enforcers', 'The Sunken Blade', 'Dragonbane Brigade', 'The Forgotten Legends',
    'Crimson Champions', 'The Obsidian Order', 'Wyrmslayers', 'The Roving Rangers',
    'Stormbringers', 'The Silent Band', 'Gilded Gauntlets', 'The Rust Vanguard',
    'Ember Alliance', 'The Silver Lances', 'Doomhammer Legion', 'The Nightstalkers',
    'Frostfire Guard', 'The Dread Cohort', 'Astral Voyagers', 'The Muddy Boots',
    'Steel & Sorcery', 'The Copper Coins', 'Phoenix Battalion', 'The Wild Hunt',
    'Bloodmoon Brigade', 'The Wandering Blades', 'Ashen Guard', 'The Gilded Arrow',
    'Twilight Sentinel', 'The Broken Helmets', 'Crypt Keepers', 'The Last Laugh',
    'Ironclad Oath', 'The Runeweavers', "Serpent's Fang", 'The Daily Grind',
    'Vanguard of Light', 'The Shadowed Path', 'Mythic Marauders', 'The Rusty Daggers',
    'Chaos Collective', 'The Shieldbreakers', 'Bonecrusher Squad', 'The High Rollers',
    'Starfall Order', 'The Saltwater Swashbucklers', 'Valor & Vengeance', 'The Silent Arrows',
    'Dawnbreakers', 'The Fortune Seekers', 'Ironhide Company', 'The Spellslings',
    'Grim Battalion', 'The Wayward Souls', 'Oathsworn Company', 'The Half-Pint Heroes',
    'Thunderstrike Brigade', 'The Lost Expedition', 'Eldritch Enforcers', 'The Crownless Kings',
    'Steel Tempest', 'The Velvet Blades', 'Netherbound', 'The Wandering Minstrels',
    'Dreadnought Legion', 'The Rusty Shields', 'Celestial Circle', 'The Tavern Regulars',
    'Wildheart Vanguard', 'The Unbroken Line', 'Phantom Regiment', 'The Gold Standard',
    'Shadowfell Stalkers', 'The Manticore Mob', 'Sunfire Alliance', 'The Drunken Owls',
    'Tempest Order', 'The Scrappy Scoundrels', 'Bloodhound Battalion', 'The Lost Legion',
    'Runehammer Company', 'The Outcast Oath', 'Stormcrow Syndicate', 'The Gilded Ravens',
    'Obsidian Watch', 'The Iron Sprouts', 'Void Walkers', 'The Last Resort',
    "Dragon's Hoard", 'The Wandering Shields', 'Spellblade Cadre', 'The Victorious Vipers'
];

// Track which names each faction has already used so we rotate through the pool fairly.
const usedPartyNames = { p1: new Set(), p2: new Set() };

let playerState = {
    p1: null,
    p2: null
};

// ==================== HELPERS: PLAYERS & ROOMS ====================

function getPlayerRoomState(faction) {
    if (roomState === 'LANDING') return 'LANDING';
    if (roomState === 'TACTICAL_ARENA') return 'TACTICAL_ARENA';
    // GAME_OVER is per-player: once they click Return, they see Town HQ again.
    if (roomState === 'GAME_OVER') {
        if (faction && postMatchReturned[faction]) {
            return playerState[faction].currentRoom || 'TOWN_HQ';
        }
        return 'GAME_OVER';
    }
    if (faction && playerState[faction]) return playerState[faction].currentRoom || 'TOWN_HQ';
    return 'TOWN_HQ';
}

function getFactionForSocket(socket) {
    if (players.p1 === socket.id) return 'p1';
    if (players.p2 === socket.id) return 'p2';
    return null;
}

function ownsFaction(socket, faction) {
    return (faction === 'p1' || faction === 'p2') && players[faction] === socket.id;
}

function bothPlayersJoinedSameRoom() {
    return players.p1 && players.p2
        && playerState.p1.playerName
        && playerState.p2.playerName
        && playerState.p1.roomCode === playerState.p2.roomCode;
}

function pickPartyName(faction) {
    const used = usedPartyNames[faction];
    let available = PARTY_NAME_POOL.filter(n => !used.has(n));
    if (available.length === 0) {
        used.clear();
        available = PARTY_NAME_POOL.slice();
    }
    const name = available[Math.floor(Math.random() * available.length)];
    used.add(name);
    return name;
}

function unitFromTemplate(role) {
    const t = HERO_TEMPLATES[role];
    if (!t) return null;
    return { role, hp: t.hp, baseHp: t.hp, melee: t.melee, range: t.range };
}

function defaultPeasantSquad() {
    return Array.from({ length: 4 }, () => unitFromTemplate('Peasant'));
}

function generateTavernOffer(faction) {
    const members = [];
    let basePartyCost = 0;
    for (let i = 0; i < 4; i++) {
        const role = TAVERN_POOL[Math.floor(Math.random() * TAVERN_POOL.length)];
        members.push({ role });
        basePartyCost += 10;
    }
    const macroVariance = Math.floor(Math.random() * 21) - 10;
    return {
        name: pickPartyName(faction),
        members,
        cost: Math.max(0, basePartyCost + macroVariance)
    };
}

function createFreshPlayerState(faction, preserved) {
    return {
        gold: 100,
        playerName: preserved.playerName || '',
        roomCode: preserved.roomCode || '',
        currentRoom: preserved.currentRoom || 'TOWN_HQ',
        parties: [{
            number: 1,
            name: pickPartyName(faction),
            members: defaultPeasantSquad()
        }],
        nextPartyNumber: 2,
        offer: generateTavernOffer(faction),
        fieldedNumbers: [1],
        launchPending: false
    };
}

function initPlayerState() {
    const p1Keep = playerState.p1 || {};
    const p2Keep = playerState.p2 || {};
    usedPartyNames.p1.clear();
    usedPartyNames.p2.clear();
    playerState.p1 = createFreshPlayerState('p1', p1Keep);
    playerState.p2 = createFreshPlayerState('p2', p2Keep);
}

// ==================== HELPERS: STATE SYNC ====================

function publicArenaParties() {
    return arenaParties.map(ap => ({
        uid: ap.uid,
        faction: ap.faction,
        number: ap.number,
        name: ap.name,
        members: ap.members,
        x: ap.x,
        y: ap.y,
        order: ap.order,
        carryingBook: ap.carryingBook || null
    }));
}

function factionDeploymentPlaced(faction) {
    const mine = arenaParties.filter(ap => ap.faction === faction);
    if (!mine.length) return false;
    return mine.every(ap => typeof ap.x === 'number' && typeof ap.y === 'number');
}

function buildStateSync(faction) {
    const ps = faction ? playerState[faction] : null;
    return {
        roomState: getPlayerRoomState(faction),
        player: ps ? {
            faction,
            playerName: ps.playerName,
            gold: ps.gold,
            parties: ps.parties,
            offer: ps.offer,
            fieldedNumbers: ps.fieldedNumbers,
            currentRoom: ps.currentRoom,
            launchPending: ps.launchPending
        } : null,
        arena: {
            phase: arenaPhase,
            currentRound,
            maxRounds: MAX_ROUNDS,
            parties: publicArenaParties(),
            groundBooks: groundBooks.map(b => ({ x: b.x, y: b.y, ownerFaction: b.ownerFaction })),
            deployment: {
                p1: { placed: factionDeploymentPlaced('p1'), ready: deployReady.p1 },
                p2: { placed: factionDeploymentPlaced('p2'), ready: deployReady.p2 }
            },
            playerNames: {
                p1: playerState.p1 ? playerState.p1.playerName : '',
                p2: playerState.p2 ? playerState.p2.playerName : ''
            }
        },
        lobby: { readyStatus, players }
    };
}

function emitStateSyncTo(socket) {
    const faction = getFactionForSocket(socket);
    socket.emit('STATE_SYNC', buildStateSync(faction));
}

function emitStateSyncAll() {
    if (players.p1) io.to(players.p1).emit('STATE_SYNC', buildStateSync('p1'));
    if (players.p2) io.to(players.p2).emit('STATE_SYNC', buildStateSync('p2'));
}

function transitionSession(newState) {
    roomState = newState;
    io.emit('ROOM_TRANSITION', { newState });
    emitStateSyncAll();
}

function navigatePlayer(faction, targetRoom) {
    playerState[faction].currentRoom = targetRoom;
    if (players[faction]) {
        io.to(players[faction]).emit('ROOM_TRANSITION', { newState: targetRoom });
        io.to(players[faction]).emit('STATE_SYNC', buildStateSync(faction));
    }
}

function enterHubPhase() {
    roomState = 'HUB';
    playerState.p1.currentRoom = 'TOWN_HQ';
    playerState.p2.currentRoom = 'TOWN_HQ';
    playerState.p1.launchPending = false;
    playerState.p2.launchPending = false;
    if (players.p1) io.to(players.p1).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
    if (players.p2) io.to(players.p2).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
    emitStateSyncAll();
}

function resetArenaState() {
    currentRound = 1;
    arenaParties = [];
    pendingMoves = { p1: null, p2: null };
    arenaPhase = 'IDLE';
    deployReady = { p1: false, p2: false };
    groundBooks = [];
    postMatchReturned = { p1: false, p2: false };
}

function emitTavernSync(faction) {
    if (!players[faction]) return;
    const ps = playerState[faction];
    io.to(players[faction]).emit('tavern-sync', {
        gold: ps.gold,
        offer: ps.offer,
        parties: ps.parties
    });
    io.to(players[faction]).emit('STATE_SYNC', buildStateSync(faction));
}

// ==================== TERRAIN & MOVEMENT ====================

function getTileAt(x, y) {
    if (y < 0 || y >= ARENA_TILE_MAP.length) return null;
    if (x < 0 || x >= ARENA_TILE_MAP[y].length) return null;
    return ARENA_TILE_MAP[y][x];
}

function isBlockedTile(x, y) {
    const tile = getTileAt(x, y);
    return !tile || BLOCKED_TILES[tile] === true;
}

function getMovementCapacity(order, startPos) {
    let capacity = ORDER_CAPACITIES[order] || 2;
    const tile = getTileAt(startPos.x, startPos.y);
    if (tile === 'DGY') capacity += 1;
    else if (tile === 'DG') capacity = Math.max(1, capacity - 1);
    return capacity;
}

function applyRangedDefenceModifier(rawDamage, defenderPos) {
    const tile = getTileAt(defenderPos.x, defenderPos.y);
    if (tile === 'DGY') return Math.floor(rawDamage * 1.1);
    if (tile === 'LG') return Math.floor(rawDamage * 0.9);
    if (tile === 'DG') return Math.floor(rawDamage * 0.75);
    return rawDamage;
}

function rangedDefenceLabel(defenderPos) {
    const tile = getTileAt(defenderPos.x, defenderPos.y);
    if (tile === 'DGY') return 'Road (+10% ranged taken)';
    if (tile === 'LG') return 'Grass (-10% ranged taken)';
    if (tile === 'DG') return 'Forest (-25% ranged taken)';
    return null;
}

function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function partyIsAlive(ap) {
    return ap.members.some(u => u.hp > 0);
}

function findBuildingAnchors() {
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

function isValidDeployCell(faction, x, y) {
    const anchors = findBuildingAnchors();
    const anchor = faction === 'p1' ? anchors.left : anchors.right;
    if (!anchor) return false;
    if (isBlockedTile(x, y)) return false;
    const chebyshev = Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y));
    return chebyshev === 1;
}

function getAllValidDeployCells(faction) {
    const cells = [];
    for (let y = 0; y <= GRID_MAX_Y; y++) {
        for (let x = 0; x <= GRID_MAX_X; x++) {
            if (isValidDeployCell(faction, x, y)) cells.push({ x, y });
        }
    }
    return cells;
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Who occupies tile (x,y)? Returns living arena party or null. skipUid ignores self.
function partyAtTile(x, y, snapshot, skipUid) {
    return snapshot.find(ap =>
        ap.uid !== skipUid
        && ap.x === x
        && ap.y === y
        && partyIsAlive(ap)
    ) || null;
}

function isEnemyOccupied(x, y, faction, snapshot, skipUid) {
    const occ = partyAtTile(x, y, snapshot, skipUid);
    return occ !== null && occ.faction !== faction;
}

function isFriendlyOccupied(x, y, faction, snapshot, skipUid) {
    const occ = partyAtTile(x, y, snapshot, skipUid);
    return occ !== null && occ.faction === faction;
}

function isAnyOccupied(x, y, snapshot, skipUid) {
    return partyAtTile(x, y, snapshot, skipUid) !== null;
}

function isAdjacentToLivingEnemy(x, y, faction, snapshot) {
    return snapshot.some(ap =>
        ap.faction !== faction
        && partyIsAlive(ap)
        && manhattan({ x, y }, ap) === 1
    );
}

// Validate one party's path for multi-party rules (see spec in user requirements).
function validateMultiPartyPath(party, rawPath, order, snapshot) {
    if (!Array.isArray(rawPath)) rawPath = [];
    const startPos = { x: party.x, y: party.y };
    const maxCapacity = getMovementCapacity(order, startPos);
    const valid = [];
    let ax = startPos.x;
    let ay = startPos.y;

    for (let i = 0; i < rawPath.length && valid.length < maxCapacity; i++) {
        const cell = rawPath[i];
        if (typeof cell.x !== 'number' || typeof cell.y !== 'number') break;
        if (cell.x < 0 || cell.x > GRID_MAX_X || cell.y < 0 || cell.y > GRID_MAX_Y) break;
        if (Math.abs(cell.x - ax) + Math.abs(cell.y - ay) !== 1) break;
        if (isBlockedTile(cell.x, cell.y)) break;

        // Cannot step onto a tile held by a living enemy.
        if (isEnemyOccupied(cell.x, cell.y, party.faction, snapshot, party.uid)) break;

        const hasMoreSubmittedSteps = i < rawPath.length - 1;

        // Friendly tiles: OK to pass through mid-path, but cannot END on them.
        if (isFriendlyOccupied(cell.x, cell.y, party.faction, snapshot, party.uid)) {
            if (!hasMoreSubmittedSteps) break;
        }

        valid.push({ x: cell.x, y: cell.y });
        ax = cell.x;
        ay = cell.y;

        // Engagement: adjacent to enemy → stop here (unless that tile is friendly-held).
        if (isAdjacentToLivingEnemy(ax, ay, party.faction, snapshot)) {
            if (isFriendlyOccupied(ax, ay, party.faction, snapshot, party.uid)) {
                valid.pop();
            }
            break;
        }
    }

    // Final cell must not be occupied by anyone (friend or foe).
    while (valid.length > 0) {
        const end = valid[valid.length - 1];
        if (isAnyOccupied(end.x, end.y, snapshot, party.uid)) valid.pop();
        else break;
    }

    return valid;
}

// ==================== ARENA SETUP ====================

function cloneMembersForArena(members) {
    return members.map(m => ({
        role: m.role,
        hp: m.baseHp,
        baseHp: m.baseHp,
        melee: m.melee,
        range: m.range
    }));
}

function buildArenaFromFielded(faction) {
    const ps = playerState[faction];
    const result = [];
    ps.fieldedNumbers.forEach(num => {
        const hubParty = ps.parties.find(p => p.number === num);
        if (!hubParty) return;
        result.push({
            uid: `${faction}-${num}`,
            faction,
            number: num,
            name: hubParty.name,
            members: cloneMembersForArena(hubParty.members),
            x: null,
            y: null,
            order: 'Advance',
            carryingBook: null
        });
    });
    return result;
}

function autoDeployFaction(faction) {
    const mine = arenaParties.filter(ap => ap.faction === faction);
    const cells = shuffleArray(getAllValidDeployCells(faction));
    const occupied = new Set(
        arenaParties
            .filter(ap => typeof ap.x === 'number' && typeof ap.y === 'number')
            .map(ap => `${ap.x},${ap.y}`)
    );

    mine.forEach(ap => {
        for (let i = 0; i < cells.length; i++) {
            const key = `${cells[i].x},${cells[i].y}`;
            if (occupied.has(key)) continue;
            ap.x = cells[i].x;
            ap.y = cells[i].y;
            occupied.add(key);
            break;
        }
    });
}

function startArenaMatch() {
    playerState.p1.launchPending = false;
    playerState.p2.launchPending = false;
    postMatchReturned = { p1: false, p2: false };

    arenaParties = [
        ...buildArenaFromFielded('p1'),
        ...buildArenaFromFielded('p2')
    ];

    autoDeployFaction('p1');
    autoDeployFaction('p2');

    roomState = 'TACTICAL_ARENA';
    arenaPhase = 'DEPLOYMENT';
    deployReady = { p1: false, p2: false };
    currentRound = 1;
    pendingMoves = { p1: null, p2: null };
    groundBooks = [];

    io.emit('ROOM_TRANSITION', { newState: 'TACTICAL_ARENA' });
    io.emit('transition-stage', {
        stage: 'combat-arena',
        arenaParties: publicArenaParties()
    });
    emitStateSyncAll();
}

function tryBeginCombatFromDeployment() {
    if (factionDeploymentPlaced('p1')
        && factionDeploymentPlaced('p2')
        && deployReady.p1
        && deployReady.p2) {
        arenaPhase = 'COMBAT';
        currentRound = 1;
        pendingMoves = { p1: null, p2: null };
        emitStateSyncAll();
    }
}

function tryStartArenaIfBothPending() {
    if (playerState.p1.launchPending && playerState.p2.launchPending) {
        startArenaMatch();
    } else {
        emitStateSyncAll();
    }
}

// ==================== COMBAT RESOLVER ====================

function getAliveMembers(party) {
    return party.filter(u => u.hp > 0);
}

function getRangedPower(members, order) {
    if (order === 'March') return 0;
    let sum = 0;
    getAliveMembers(members).forEach(u => { sum += (u.range || 0); });
    return sum;
}

function getMeleePower(members) {
    let sum = 0;
    getAliveMembers(members).forEach(u => { sum += (u.melee || 0) + (u.range || 0); });
    return sum;
}

// Split an integer damage pool across N targets as evenly as possible.
function splitDamageEvenly(total, n) {
    if (n <= 0) return [];
    const base = Math.floor(total / n);
    const shares = Array(n).fill(base);
    let rem = total - base * n;
    for (let i = 0; i < rem; i++) shares[i] += 1;
    return shares;
}

function applyOrdersFromPending() {
    ['p1', 'p2'].forEach(faction => {
        const submission = pendingMoves[faction];
        if (!submission || !submission.byNumber) return;
        Object.entries(submission.byNumber).forEach(([numStr, mv]) => {
            const num = Number(numStr);
            const ap = arenaParties.find(p => p.faction === faction && p.number === num);
            if (!ap) return;
            if (INITIATIVE_ORDER[mv.order]) ap.order = mv.order;
        });
    });
}

function getPartyMoveSubmission(ap) {
    const submission = pendingMoves[ap.faction];
    const mv = submission && submission.byNumber ? submission.byNumber[ap.number] : null;
    return {
        order: (mv && INITIATIVE_ORDER[mv.order]) ? mv.order : ap.order,
        path: (mv && Array.isArray(mv.path)) ? mv.path : []
    };
}

// Destination-tile priority for contested ends: March > Advance > Seek
// (the "faster travel" order wins the square — opposite of combat initiative rank).
function movementPriority(order) {
    return INITIATIVE_ORDER[order] || 0;
}

function planEndTile(plan) {
    if (plan.path.length > 0) return plan.path[plan.path.length - 1];
    return plan.start;
}

// Resolve ALL movement for the round at once (from start-of-round positions).
// If two parties aim for the same tile, March beats Advance beats Seek.
// The loser shortens its path by one tile at a time (stops on the previous step),
// instead of cancelling the whole move.
function resolveAllMovement(roundLog) {
    const snapshot = arenaParties.map(ap => ({
        uid: ap.uid,
        faction: ap.faction,
        x: ap.x,
        y: ap.y,
        members: ap.members
    }));

    const plans = arenaParties.filter(ap => partyIsAlive(ap)).map(ap => {
        const sub = getPartyMoveSubmission(ap);
        const path = validateMultiPartyPath(ap, sub.path, sub.order, snapshot);
        return {
            ap,
            order: sub.order,
            path: path.slice(),
            start: { x: ap.x, y: ap.y }
        };
    });

    roundLog += `<br>🚶 Movement resolution<br>`;

    // Keep truncating losers until every end tile is unique.
    let safety = 0;
    let changed = true;
    while (changed && safety < 64) {
        changed = false;
        safety += 1;

        const byEnd = new Map();
        plans.forEach(plan => {
            const end = planEndTile(plan);
            const key = `${end.x},${end.y}`;
            if (!byEnd.has(key)) byEnd.set(key, []);
            byEnd.get(key).push(plan);
        });

        byEnd.forEach((group) => {
            if (group.length <= 1) return;

            // Highest movementPriority wins the tile (March=3 > Advance=2 > Seek=1).
            group.sort((a, b) => {
                const diff = movementPriority(b.order) - movementPriority(a.order);
                if (diff !== 0) return diff;
                return String(a.ap.uid).localeCompare(String(b.ap.uid));
            });

            for (let i = 1; i < group.length; i++) {
                const loser = group[i];
                if (loser.path.length === 0) {
                    // Stationary party already on this tile — the "winner" must give way instead.
                    const winner = group[0];
                    if (winner.path.length > 0) {
                        const stolen = winner.path[winner.path.length - 1];
                        winner.path = winner.path.slice(0, -1);
                        changed = true;
                        roundLog += ` -> ${winner.ap.name} yields (${stolen.x},${stolen.y}) — occupied by holding ${loser.ap.name}; steps back.<br>`;
                    }
                    continue;
                }
                const stolen = loser.path[loser.path.length - 1];
                loser.path = loser.path.slice(0, -1);
                changed = true;
                const next = planEndTile(loser);
                roundLog += ` -> ${loser.ap.name} loses tile (${stolen.x},${stolen.y}) to faster order; stops at (${next.x},${next.y}).<br>`;
            }
        });
    }

    plans.forEach(plan => {
        if (plan.path.length === 0) {
            roundLog += ` -> ${plan.ap.name} holds at (${plan.ap.x},${plan.ap.y}).<br>`;
            return;
        }
        // Walk each step so books can be picked up while passing through a tile.
        plan.path.forEach(cell => {
            plan.ap.x = cell.x;
            plan.ap.y = cell.y;
            roundLog = tryPickupGroundBook(plan.ap, roundLog);
        });
        const end = planEndTile(plan);
        roundLog += ` -> ${plan.ap.name} [${plan.order}] moves to (${end.x},${end.y}).<br>`;
    });

    return roundLog;
}

// Orthogonal adjacency only (up/down/left/right — no diagonals).
function isOrthAdjacent(pos, tile) {
    if (!pos || !tile) return false;
    return Math.abs(pos.x - tile.x) + Math.abs(pos.y - tile.y) === 1;
}

function homeBuildingFor(faction) {
    const anchors = findBuildingAnchors();
    return faction === 'p1' ? anchors.left : anchors.right;
}

function enemyBuildingFor(faction) {
    return homeBuildingFor(faction === 'p1' ? 'p2' : 'p1');
}

function tryPickupGroundBook(ap, roundLog) {
    if (!partyIsAlive(ap) || ap.carryingBook) return roundLog;
    const idx = groundBooks.findIndex(b => b.x === ap.x && b.y === ap.y);
    if (idx < 0) return roundLog;
    const book = groundBooks[idx];
    groundBooks.splice(idx, 1);
    ap.carryingBook = book.ownerFaction;
    roundLog += ` -> 📖 ${ap.name} picks up a spell book (${book.ownerFaction === ap.faction ? 'home' : 'enemy'} tower).<br>`;
    return roundLog;
}

// After movement: steal from enemy tower / return books to home tower.
// Returns { bookWins: Set<'p1'|'p2'> } for deliveries of an ENEMY book.
function resolveBuildingInteractions(roundLog) {
    const bookWins = new Set();

    arenaParties.filter(ap => partyIsAlive(ap)).forEach(ap => {
        const home = homeBuildingFor(ap.faction);
        const enemy = enemyBuildingFor(ap.faction);
        const enemyFaction = ap.faction === 'p1' ? 'p2' : 'p1';

        // Steal: stand next to the opposing tower while not already carrying a book.
        if (!ap.carryingBook && isOrthAdjacent(ap, enemy)) {
            ap.carryingBook = enemyFaction;
            roundLog += ` -> 📖 ${ap.name} steals a spell book from the opposing Wizard tower!<br>`;
        }

        // Next to home tower while carrying...
        if (ap.carryingBook && isOrthAdjacent(ap, home)) {
            if (ap.carryingBook !== ap.faction) {
                // Enemy book delivered → scoring win for this faction
                bookWins.add(ap.faction);
                roundLog += ` -> 🏆 ${ap.name} delivers an enemy spell book to their Wizard!<br>`;
                ap.carryingBook = null;
            } else {
                // Own book returned to the shelf (no score)
                roundLog += ` -> 📖 ${ap.name} returns a home spell book to their Wizard tower.<br>`;
                ap.carryingBook = null;
            }
        }
    });

    return { bookWins, roundLog };
}

// Knocked-out carriers drop their book on their tile.
function dropBooksFromKnockouts(roundLog) {
    arenaParties.forEach(ap => {
        if (partyIsAlive(ap) || !ap.carryingBook) return;
        groundBooks.push({ x: ap.x, y: ap.y, ownerFaction: ap.carryingBook });
        roundLog += ` -> 📖 ${ap.name} drops a spell book at (${ap.x},${ap.y})!<br>`;
        ap.carryingBook = null;
    });
    return roundLog;
}

function resolveCombatBand(bandName, roundLog) {
    const bandInit = INITIATIVE_ORDER[bandName];
    const attackers = arenaParties.filter(ap => ap.order === bandName && partyIsAlive(ap));
    if (!attackers.length) return roundLog;

    roundLog += `<br>⚔ ${bandName} combat<br>`;

    const damageQueue = [];

    attackers.forEach(attacker => {
        const enemies = arenaParties.filter(e => e.faction !== attacker.faction && partyIsAlive(e));
        const rangedTargets = enemies.filter(e => manhattan(attacker, e) === 2);
        const meleeTargets = enemies.filter(e => manhattan(attacker, e) === 1);

        const rangedPower = getRangedPower(attacker.members, attacker.order);
        const meleePower = getMeleePower(attacker.members);

        if (rangedPower > 0 && rangedTargets.length > 0) {
            // Split evenly (integers). Remainder goes to the first targets in the list.
            const shares = splitDamageEvenly(rangedPower, rangedTargets.length);
            rangedTargets.forEach((target, idx) => {
                const share = shares[idx];
                const modified = applyRangedDefenceModifier(share, target);
                const coverNote = rangedDefenceLabel(target);
                let note = '';
                if (coverNote && share > 0) note = ` (${share} -> ${modified} after ${coverNote})`;
                damageQueue.push({
                    target,
                    damage: modified,
                    label: `${attacker.name} ranged vs ${target.name}${note}`
                });
            });
        }

        if (meleePower > 0 && meleeTargets.length > 0) {
            const shares = splitDamageEvenly(meleePower, meleeTargets.length);
            meleeTargets.forEach((target, idx) => {
                const defenderInit = INITIATIVE_ORDER[target.order] || 2;
                let dmg = shares[idx];
                let surprise = '';
                // Surprise buff only when THIS attacker out-inits THAT defender's order.
                if (bandInit < defenderInit) {
                    dmg = Math.floor(dmg * 1.2);
                    surprise = ' (+20% surprise)';
                }
                damageQueue.push({
                    target,
                    damage: dmg,
                    label: `${attacker.name} melee vs ${target.name}${surprise}`
                });
            });
        }
    });

    if (!damageQueue.length) {
        roundLog += ' -> No engagements this band.<br>';
        return roundLog;
    }

    // Simultaneous within band: spillover applied after all damage amounts are known.
    damageQueue.forEach(ev => {
        roundLog += `[${ev.label}] ${ev.damage} dmg<br>`;
        applySpilloverDamage(ev.target.members, ev.damage, (str) => { roundLog += str; }, ev.label);
    });

    return roundLog;
}

function factionHasLivingParties(faction) {
    return arenaParties.some(ap => ap.faction === faction && partyIsAlive(ap));
}

// Count enemy spell books currently carried by living parties of a faction.
function countEnemyBooksHeld(faction) {
    const enemy = faction === 'p1' ? 'p2' : 'p1';
    return arenaParties.filter(ap =>
        ap.faction === faction
        && partyIsAlive(ap)
        && ap.carryingBook === enemy
    ).length;
}

// outcome: { type: 'VICTORY'|'DRAW', winnerFaction?, gold?, impressive?, reason, minor? }
function handleGameOver(outcome) {
    roomState = 'GAME_OVER';
    arenaPhase = 'IDLE';
    postMatchReturned = { p1: false, p2: false };

    const p1Name = playerState.p1.playerName || 'Player 1';
    const p2Name = playerState.p2.playerName || 'Player 2';

    if (outcome.type === 'DRAW') {
        const detail = outcome.impressive
            ? 'Both sides scored at the same time — truly impressive! It\'s a draw. (0g each)'
            : (outcome.reason || 'The mission ends in a draw. (0g each)');
        ['p1', 'p2'].forEach(f => {
            if (players[f]) {
                io.to(players[f]).emit('GAME_OVER_SUMMARY', {
                    result: 'DRAW',
                    goldEarned: 0,
                    detail,
                    winnerName: null
                });
            }
        });
    } else {
        const winner = outcome.winnerFaction;
        const loser = winner === 'p1' ? 'p2' : 'p1';
        const winnerName = winner === 'p1' ? p1Name : p2Name;
        const gold = typeof outcome.gold === 'number' ? outcome.gold : VICTORY_GOLD;
        playerState[winner].gold += gold;

        const winLabel = outcome.minor ? 'MINOR VICTORY' : 'VICTORY';
        const winDetail = outcome.reason
            || (outcome.minor
                ? `${winnerName} wins a minor victory — more enemy spell books held after day 10! Reward: ${gold}g`
                : `${winnerName} wins Tale of Two Wizards! Reward: ${gold}g`);

        if (players[winner]) {
            io.to(players[winner]).emit('GAME_OVER_SUMMARY', {
                result: winLabel,
                goldEarned: gold,
                detail: winDetail,
                winnerName
            });
        }
        if (players[loser]) {
            io.to(players[loser]).emit('GAME_OVER_SUMMARY', {
                result: 'DEFEAT',
                goldEarned: 0,
                detail: outcome.minor
                    ? `${winnerName} takes a minor victory (more enemy books held). You earn 0g.`
                    : `${winnerName} wins Tale of Two Wizards. You earn 0g.`,
                winnerName
            });
        }
    }

    // Do NOT force both clients via ROOM_TRANSITION — each summary already switches them.
    // STATE_SYNC still reports GAME_OVER until that player returns.
    emitStateSyncAll();
}

function resolveRoundSimulation() {
    const resolvedDay = currentRound;
    let roundLog = `[DAY ${resolvedDay} RESOLUTION]<br>`;

    applyOrdersFromPending();

    // 1) Movement (+ book pickups while passing through)
    roundLog = resolveAllMovement(roundLog);

    // 2) Steal / return interactions at towers
    const buildingResult = resolveBuildingInteractions(roundLog);
    roundLog = buildingResult.roundLog;
    const bookWins = buildingResult.bookWins;

    // 3) Combat
    INITIATIVE_BANDS.forEach(band => {
        roundLog = resolveCombatBand(band, roundLog);
    });

    // 4) Drop books from parties knocked out this round
    roundLog = dropBooksFromKnockouts(roundLog);

    currentRound++;
    pendingMoves = { p1: null, p2: null };

    const p1Alive = factionHasLivingParties('p1');
    const p2Alive = factionHasLivingParties('p2');

    io.emit('resolve-round', {
        arenaParties: publicArenaParties(),
        groundBooks: groundBooks.map(b => ({ x: b.x, y: b.y, ownerFaction: b.ownerFaction })),
        nextRound: currentRound,
        log: roundLog
    });

    // --- End-of-day win / draw checks (after full resolution) ---
    const koWins = new Set();
    if (!p1Alive && p2Alive) koWins.add('p2');
    if (!p2Alive && p1Alive) koWins.add('p1');

    const allWins = new Set([...bookWins, ...koWins]);
    const mutualWipe = !p1Alive && !p2Alive;

    if (mutualWipe || allWins.size >= 2) {
        handleGameOver({
            type: 'DRAW',
            impressive: true,
            reason: 'Both sides achieved victory conditions together — impressive draw!'
        });
        return;
    }
    if (allWins.size === 1) {
        handleGameOver({ type: 'VICTORY', winnerFaction: [...allWins][0] });
        return;
    }
    // Day 10 fully resolved with no full win → minor victory if one side holds more enemy books.
    if (resolvedDay >= MAX_ROUNDS) {
        const p1Held = countEnemyBooksHeld('p1');
        const p2Held = countEnemyBooksHeld('p2');
        if (p1Held > p2Held) {
            handleGameOver({
                type: 'VICTORY',
                winnerFaction: 'p1',
                gold: MINOR_VICTORY_GOLD,
                minor: true,
                reason: `Day 10 ends — Cyan holds more enemy spell books (${p1Held} vs ${p2Held}). Minor victory: ${MINOR_VICTORY_GOLD}g`
            });
            return;
        }
        if (p2Held > p1Held) {
            handleGameOver({
                type: 'VICTORY',
                winnerFaction: 'p2',
                gold: MINOR_VICTORY_GOLD,
                minor: true,
                reason: `Day 10 ends — Orange holds more enemy spell books (${p2Held} vs ${p1Held}). Minor victory: ${MINOR_VICTORY_GOLD}g`
            });
            return;
        }
        handleGameOver({
            type: 'DRAW',
            impressive: false,
            reason: `The 10th day ends even on held books (${p1Held}-${p2Held}) — the Wizards remain petty. Draw! (0g)`
        });
        return;
    }

    emitStateSyncAll();
}

// Spillover: damage hits highest baseHp living hero first; leftovers spill to next tank.
function applySpilloverDamage(party, totalDamage, appendLog, attackerLabel) {
    let remainingDmg = totalDamage;
    if (remainingDmg <= 0) return;

    while (remainingDmg > 0) {
        const aliveUnits = party.filter(u => u.hp > 0);
        if (aliveUnits.length === 0) break;

        aliveUnits.sort((a, b) => b.baseHp - a.baseHp);
        const currentTank = aliveUnits[0];

        if (currentTank.hp > remainingDmg) {
            currentTank.hp -= remainingDmg;
            appendLog(` -> [${attackerLabel}] ${currentTank.role} absorbs ${remainingDmg} damage (${currentTank.hp}/${currentTank.baseHp} HP left).<br>`);
            remainingDmg = 0;
        } else {
            remainingDmg -= currentTank.hp;
            currentTank.hp = 0;
            appendLog(` -> [${attackerLabel}] ${currentTank.role} takes critical damage and falls unconscious!<br>`);
        }
    }
}

// ==================== SOCKET HANDLERS ====================

initPlayerState();

io.on('connection', (socket) => {
    if (gameStarted) {
        socket.emit('assign-player', { faction: 'spectator', gameStarted: true });
    } else if (!players.p1) {
        players.p1 = socket.id;
        socket.emit('assign-player', { faction: 'p1', gameStarted: false });
    } else if (!players.p2) {
        players.p2 = socket.id;
        socket.emit('assign-player', { faction: 'p2', gameStarted: false });
    } else {
        socket.emit('assign-player', { faction: 'spectator', gameStarted: false });
    }

    io.emit('lobby-status', { readyStatus, players });
    emitStateSyncTo(socket);

    socket.on('JOIN_GAME', (data) => {
        const faction = getFactionForSocket(socket);
        if (!faction || roomState !== 'LANDING') return;
        if (!data.playerName || !data.roomCode) return;

        playerState[faction].playerName = String(data.playerName).trim();
        playerState[faction].roomCode = String(data.roomCode).trim();

        if (bothPlayersJoinedSameRoom()) {
            gameStarted = true;
            initPlayerState();
            resetArenaState();
            enterHubPhase();
        } else {
            emitStateSyncTo(socket);
        }
    });

    socket.on('NAVIGATE_TO', (data) => {
        const faction = getFactionForSocket(socket);
        if (!faction) return;
        if (roomState === 'TACTICAL_ARENA' || roomState === 'LANDING') return;
        // After GAME_OVER, only players who already clicked Return can wander the hub.
        if (roomState === 'GAME_OVER' && !postMatchReturned[faction]) return;
        if (!NAVIGABLE_ROOMS.includes(data.targetRoom)) return;
        navigatePlayer(faction, data.targetRoom);
    });

    socket.on('RETURN_TO_HQ', () => {
        const faction = getFactionForSocket(socket);
        if (!faction) return;
        if (roomState !== 'GAME_OVER') return;

        // Each player returns on their own time — keep gold & hired parties.
        postMatchReturned[faction] = true;
        playerState[faction].currentRoom = 'TOWN_HQ';
        playerState[faction].launchPending = false;

        io.to(socket.id).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
        emitStateSyncTo(socket);

        // When both have left the results screen, clear arena leftovers for the next mission.
        if (postMatchReturned.p1 && postMatchReturned.p2) {
            resetArenaState();
            roomState = 'HUB';
            emitStateSyncAll();
        }
    });

    function isHubPlayable(faction) {
        if (roomState === 'HUB') return true;
        // One player may already be back in town while the other still reads GAME_OVER.
        if (roomState === 'GAME_OVER' && postMatchReturned[faction]) return true;
        return false;
    }

    socket.on('SET_FIELD_PARTY', (data) => {
        const faction = getFactionForSocket(socket);
        if (!faction || !isHubPlayable(faction)) return;
        const partyNumber = Number(data.partyNumber);
        const selected = !!data.selected;
        const ps = playerState[faction];

        const exists = ps.parties.some(p => p.number === partyNumber);
        if (!exists) return;

        if (selected) {
            if (ps.fieldedNumbers.includes(partyNumber)) return;
            if (ps.fieldedNumbers.length >= MAX_FIELDED_PARTIES) return;
            ps.fieldedNumbers.push(partyNumber);
        } else {
            ps.fieldedNumbers = ps.fieldedNumbers.filter(n => n !== partyNumber);
        }

        emitStateSyncTo(socket);
    });

    socket.on('LAUNCH_QUEST', () => {
        const faction = getFactionForSocket(socket);
        if (!faction || !isHubPlayable(faction)) return;
        const ps = playerState[faction];
        if (ps.currentRoom !== 'CASTLE') return;

        const fielded = ps.fieldedNumbers.filter(n => ps.parties.some(p => p.number === n));
        ps.fieldedNumbers = fielded;
        if (fielded.length < 1 || fielded.length > MAX_FIELDED_PARTIES) return;

        ps.launchPending = true;
        tryStartArenaIfBothPending();
    });

    socket.on('DEPLOY_PLACE', (data) => {
        const faction = getFactionForSocket(socket);
        if (!faction || roomState !== 'TACTICAL_ARENA' || arenaPhase !== 'DEPLOYMENT') return;
        if (deployReady[faction]) return;

        const partyNumber = Number(data.partyNumber);
        const x = data && typeof data.x === 'number' ? data.x : NaN;
        const y = data && typeof data.y === 'number' ? data.y : NaN;
        if (!isValidDeployCell(faction, x, y)) return;

        const ap = arenaParties.find(p => p.faction === faction && p.number === partyNumber);
        if (!ap) return;

        const occupant = arenaParties.find(p =>
            p.uid !== ap.uid
            && p.x === x
            && p.y === y
            && partyIsAlive(p)
        );
        if (occupant) return;

        ap.x = x;
        ap.y = y;
        emitStateSyncAll();
    });

    socket.on('DEPLOY_READY', () => {
        const faction = getFactionForSocket(socket);
        if (!faction || roomState !== 'TACTICAL_ARENA' || arenaPhase !== 'DEPLOYMENT') return;
        if (!factionDeploymentPlaced(faction)) return;

        deployReady[faction] = true;
        if (!(factionDeploymentPlaced('p1') && factionDeploymentPlaced('p2') && deployReady.p1 && deployReady.p2)) {
            emitStateSyncAll();
        } else {
            tryBeginCombatFromDeployment();
        }
    });

    socket.on('player-ready', (data) => {
        if (!ownsFaction(socket, data.faction)) return;
        readyStatus[data.faction] = true;
        io.emit('lobby-status', { readyStatus, players });
        emitStateSyncAll();
    });

    socket.on('tavern-reroll', (data) => {
        if (!gameStarted || !ownsFaction(socket, data.faction)) return;
        const ps = playerState[data.faction];
        if (ps.gold < 5) return;
        ps.gold -= 5;
        ps.offer = generateTavernOffer(data.faction);
        emitTavernSync(data.faction);
    });

    socket.on('tavern-hire', (data) => {
        if (!gameStarted || !ownsFaction(socket, data.faction)) return;
        const ps = playerState[data.faction];
        if (ps.gold < ps.offer.cost || !ps.offer.members.length) return;

        ps.gold -= ps.offer.cost;
        ps.parties.push({
            number: ps.nextPartyNumber,
            name: ps.offer.name,
            members: ps.offer.members.map(m => unitFromTemplate(m.role)).filter(Boolean)
        });
        ps.nextPartyNumber += 1;
        ps.offer = generateTavernOffer(data.faction);
        emitTavernSync(data.faction);
    });

    socket.on('submit-turn', (data) => {
        if (!gameStarted || !ownsFaction(socket, data.faction)) return;
        if (arenaPhase !== 'COMBAT') return;
        if (pendingMoves[data.faction]) return;

        const byNumber = {};
        (data.orders || []).forEach(ord => {
            const partyNumber = Number(ord.partyNumber);
            if (!partyNumber) return;
            const ap = arenaParties.find(p => p.faction === data.faction && p.number === partyNumber);
            if (!ap || !partyIsAlive(ap)) return;
            const order = INITIATIVE_ORDER[ord.order] ? ord.order : ap.order;
            byNumber[partyNumber] = {
                order,
                path: Array.isArray(ord.path) ? ord.path : []
            };
        });

        pendingMoves[data.faction] = { byNumber };

        if (pendingMoves.p1 && pendingMoves.p2) {
            resolveRoundSimulation();
        } else {
            emitStateSyncAll();
        }
    });

    socket.on('disconnect', () => {
        if (players.p1 === socket.id) { players.p1 = null; readyStatus.p1 = false; }
        if (players.p2 === socket.id) { players.p2 = null; readyStatus.p2 = false; }
        if (!players.p1 && !players.p2) {
            gameStarted = false;
            roomState = 'LANDING';
            resetArenaState();
            initPlayerState();
            playerState.p1.playerName = '';
            playerState.p2.playerName = '';
            playerState.p1.roomCode = '';
            playerState.p2.roomCode = '';
            playerState.p1.currentRoom = 'TOWN_HQ';
            playerState.p2.currentRoom = 'TOWN_HQ';
        }
        io.emit('lobby-status', { readyStatus, players });
        emitStateSyncAll();
    });
});

server.listen(PORT, HOST, () => {
    const lan = getLanIpv4Addresses();
    console.log('');
    console.log('=== TOO MANY HEROES — LAN HOST ===');
    console.log(`On this PC:     http://localhost:${PORT}`);
    if (lan.length === 0) {
        console.log('LAN address:    (none found — check Wi-Fi/Ethernet is connected)');
    } else {
        lan.forEach(ip => {
            console.log(`Other PC/phone: http://${ip}:${PORT}`);
        });
    }
    console.log('');
    console.log('Tip: Only one PC runs this server. Everyone else opens a LAN URL above');
    console.log('in their browser and joins with the SAME Room Code.');
    console.log('If Windows Firewall asks, allow Node on Private networks only.');
    console.log('=================================');
    console.log('');
});
