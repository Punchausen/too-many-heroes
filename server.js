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

const PORT = Number(process.env.PORT) || 3000;
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
let singlePlayerMode = false;           // human p1 vs computer p2
const AI_SOCKET_ID = '__AI_P2__';        // placeholder so p2 slot is "filled"
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
// Who clicked Lock first this round — tie-break when two parties contest a tile with the same order.
let firstLockFaction = null;
// Spell books sitting on the ground after a carrier was knocked out.
// ownerFaction = which wizard tower the book originally came from.
let groundBooks = [];
// After GAME_OVER, each player returns to HQ on their own time.
let postMatchReturned = { p1: false, p2: false };

const NAVIGABLE_ROOMS = ['TOWN_HQ', 'TAVERN', 'CASTLE'];
const INITIATIVE_ORDER = { Guard: 1, Advance: 2, March: 3 };
const INITIATIVE_BANDS = ['Guard', 'Advance', 'March'];
const ORDER_CAPACITIES = { Guard: 1, Advance: 3, March: 5 };
const GRID_MAX_X = 10;
const GRID_MAX_Y = 9;
// Must match public/js/client.js FOG_VISION_RANGE — Manhattan steps from living friendly parties.
const FOG_VISION_RANGE = 2;
const MAX_FIELDED_PARTIES = 4;
const MAX_ROUNDS = 10;              // "10 days" — then check held enemy books / draw
const VICTORY_GOLD = 100;           // Full win (deliver book or wipe enemies)
const MINOR_VICTORY_GOLD = 50;      // After day 10: holding more enemy books than opponent

// --- TERRAIN MAP (must stay in sync with public/js/client.js ARENA_TILE_MAP) ---
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
const BLOCKED_TILES = { RED: true, LGY: true };

const HERO_TEMPLATES = {
    Peasant:   { hp: 50,  melee: 10, range: 0 },
    Barbarian: { hp: 100, melee: 40, range: 0 },
    Elf:       { hp: 40,  melee: 15, range: 25 },
    Wizard:    { hp: 30,  melee: 10, range: 35 },
    Knight:    { hp: 120, melee: 25, range: 0 }
};

const TAVERN_POOL = ['Barbarian', 'Elf', 'Wizard', 'Knight', 'Peasant'];

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
    // GAME_OVER is per-player: once they click Return, they see Town again.
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

function isSinglePlayer() {
    return !!singlePlayerMode;
}

function isAiFaction(faction) {
    return isSinglePlayer() && faction === 'p2';
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
    // Deep-clone members so timeline snapshots keep the HP at that moment.
    // (If we reused the same member objects, every wave would show final HP after combat.)
    return arenaParties.map(ap => ({
        uid: ap.uid,
        faction: ap.faction,
        number: ap.number,
        name: ap.name,
        members: (ap.members || []).map(m => ({
            role: m.role,
            hp: m.hp,
            baseHp: m.baseHp,
            melee: m.melee,
            range: m.range
        })),
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
    if (players.p2 && !isAiFaction('p2')) {
        io.to(players.p2).emit('STATE_SYNC', buildStateSync('p2'));
    }
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
    // Don't emit hub transitions to the AI placeholder socket.
    if (players.p2 && !isAiFaction('p2')) {
        io.to(players.p2).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
    }
    emitStateSyncAll();
}

function resetArenaState() {
    currentRound = 1;
    arenaParties = [];
    pendingMoves = { p1: null, p2: null };
    firstLockFaction = null;
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

// Can this faction see tile (x,y)? Same rule as the client's fog of war.
function factionCanSeeTile(faction, x, y) {
    return arenaParties.some(ap =>
        ap.faction === faction
        && partyIsAlive(ap)
        && typeof ap.x === 'number'
        && typeof ap.y === 'number'
        && (Math.abs(ap.x - x) + Math.abs(ap.y - y)) <= FOG_VISION_RANGE
    );
}

// You may only deal combat damage to parties your side can see (no hitting back into fog).
function attackerCanSeeTarget(attacker, target) {
    if (!attacker || !target) return false;
    if (typeof target.x !== 'number' || typeof target.y !== 'number') return false;
    return factionCanSeeTile(attacker.faction, target.x, target.y);
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

        // Melee engagement (1 away): stop here. Range 2 does not cut the path.
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

function buildAIPeasantParties() {
    // Fixed spawn around the red (p2) tower; party 4 sits on the far bottom-right tile.
    // 1 & 3 = tower/book runners; 2 & 4 = hunters. All Advance.
    const spawns = [
        { number: 1, x: 8, y: 6, name: 'Tower Watch' },
        { number: 2, x: 10, y: 6, name: 'Hunt Pack' },
        { number: 3, x: 8, y: 8, name: 'Book Runners' },
        { number: 4, x: 10, y: 9, name: 'Corner Blades' }
    ];
    return spawns.map(s => ({
        uid: `p2-${s.number}`,
        faction: 'p2',
        number: s.number,
        name: s.name,
        members: defaultPeasantSquad(),
        x: s.x,
        y: s.y,
        order: 'Advance',
        carryingBook: null,
        aiRole: (s.number === 1 || s.number === 3) ? 'tower' : 'hunt'
    }));
}

function startArenaMatch() {
    playerState.p1.launchPending = false;
    playerState.p2.launchPending = false;
    postMatchReturned = { p1: false, p2: false };

    if (isSinglePlayer()) {
        arenaParties = [
            ...buildArenaFromFielded('p1'),
            ...buildAIPeasantParties()
        ];
        autoDeployFaction('p1');
        // AI is pre-placed (including the out-of-bounds party 4) and already ready.
        deployReady = { p1: false, p2: true };
    } else {
        arenaParties = [
            ...buildArenaFromFielded('p1'),
            ...buildArenaFromFielded('p2')
        ];
        autoDeployFaction('p1');
        autoDeployFaction('p2');
        deployReady = { p1: false, p2: false };
    }

    roomState = 'TACTICAL_ARENA';
    arenaPhase = 'DEPLOYMENT';
    currentRound = 1;
    pendingMoves = { p1: null, p2: null };
    firstLockFaction = null;
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
        firstLockFaction = null;
        emitStateSyncAll();
    }
}

function tryStartArenaIfBothPending() {
    if (isSinglePlayer()) {
        if (playerState.p1.launchPending) startArenaMatch();
        else emitStateSyncAll();
        return;
    }
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

// Destination-tile priority for contested tiles: March > Advance > Guard
// (the "faster travel" order wins the square — opposite of combat initiative rank).
function movementPriority(order) {
    return INITIATIVE_ORDER[order] || 0;
}

// Sort so the winner is first: higher March priority, then who locked orders first.
function compareStepMovePriority(a, b) {
    const diff = movementPriority(b.order) - movementPriority(a.order);
    if (diff !== 0) return diff;
    if (firstLockFaction) {
        if (a.ap.faction === firstLockFaction && b.ap.faction !== firstLockFaction) return -1;
        if (b.ap.faction === firstLockFaction && a.ap.faction !== firstLockFaction) return 1;
    }
    return String(a.ap.uid).localeCompare(String(b.ap.uid));
}

function meleePairKey(a, b) {
    return a.uid < b.uid ? `${a.uid}|${b.uid}` : `${b.uid}|${a.uid}`;
}

// Animation / sequencing weight (higher resolves first). Opposite of initiative rank numbers.
const ORDER_COMBAT_SCORE = { Guard: 3, Advance: 2, March: 1 };

function combatPairScore(a, b) {
    return (ORDER_COMBAT_SCORE[a.order] || 0) + (ORDER_COMBAT_SCORE[b.order] || 0);
}

// Highest score first; identical scores get a random order (server picks so both clients match).
function sortCombatPairsByScore(pairs) {
    pairs.forEach(p => { p._rand = Math.random(); });
    pairs.sort((a, b) => {
        const diff = b.score - a.score;
        if (diff !== 0) return diff;
        return a._rand - b._rand;
    });
}

// Combat theatre helpers + resolveStepCombat (spliced into server.js)

function livingMembersByTankOrder(members) {
    return members
        .map((m, index) => ({ m, index }))
        .filter(x => x.m && x.m.hp > 0)
        .sort((a, b) => {
            if (b.m.baseHp !== a.m.baseHp) return b.m.baseHp - a.m.baseHp;
            return a.index - b.index;
        });
}

function getUnitMeleeOutput(unit) {
    return (unit.melee || 0) + (unit.range || 0);
}

function getUnitRangedOutput(unit, order) {
    if (order === 'March') return 0;
    return unit.range || 0;
}

function partyMeleeOutput(ap) {
    let sum = 0;
    getAliveMembers(ap.members).forEach(u => { sum += getUnitMeleeOutput(u); });
    return sum;
}

function partyRangedOutput(ap) {
    let sum = 0;
    getAliveMembers(ap.members).forEach(u => { sum += getUnitRangedOutput(u, ap.order); });
    return sum;
}

// Plan spillover without mutating, then caller applies. Highest baseHp tanks first.
function allocateSpilloverHits(members, totalDamage) {
    const hits = [];
    let remaining = totalDamage;
    if (remaining <= 0) return hits;
    const hp = members.map(m => (m && m.hp > 0 ? m.hp : 0));
    while (remaining > 0) {
        let best = -1;
        for (let i = 0; i < members.length; i++) {
            if (hp[i] <= 0) continue;
            if (best < 0 || members[i].baseHp > members[best].baseHp) best = i;
        }
        if (best < 0) break;
        const dealt = Math.min(hp[best], remaining);
        hp[best] -= dealt;
        remaining -= dealt;
        hits.push({
            memberIndex: best,
            damage: dealt,
            remainingHp: hp[best],
            knockedOut: hp[best] <= 0
        });
    }
    return hits;
}

function applyUnitHitsToMembers(members, hits) {
    (hits || []).forEach(h => {
        if (!members[h.memberIndex]) return;
        members[h.memberIndex].hp = h.remainingHp;
    });
}

// Left = leftmost on map; if same column, higher on screen (smaller y).
function combatWindowMeta(a, b) {
    let left;
    let right;
    if (a.x !== b.x) {
        left = a.x < b.x ? a : b;
        right = left === a ? b : a;
    } else {
        left = a.y <= b.y ? a : b;
        right = left === a ? b : a;
    }
    return {
        leftUid: left.uid,
        rightUid: right.uid,
        leftTile: { x: left.x, y: left.y, terrain: getTileAt(left.x, left.y) },
        rightTile: { x: right.x, y: right.y, terrain: getTileAt(right.x, right.y) }
    };
}

function makeStrike(attacker, defender, damage, kind, attackerMemberIndex, roundLog) {
    if (!attackerCanSeeTarget(attacker, defender)) {
        roundLog += ` -> ${attacker.name} cannot ${kind}-attack ${defender.name} (target hidden in fog).<br>`;
        return { strike: null, roundLog };
    }
    const label = `${attacker.name} ${kind} vs ${defender.name}`;
    roundLog += `[${label}] ${damage} dmg<br>`;
    const unitHits = allocateSpilloverHits(defender.members, damage);
    applyUnitHitsToMembers(defender.members, unitHits);
    unitHits.forEach(h => {
        const role = defender.members[h.memberIndex] ? defender.members[h.memberIndex].role : '?';
        if (h.knockedOut) {
            roundLog += ` -> [${label}] ${role} takes ${h.damage} and falls unconscious!<br>`;
        } else {
            roundLog += ` -> [${label}] ${role} takes ${h.damage} (${h.remainingHp} HP left).<br>`;
        }
    });
    roundLog = dropBooksFromKnockouts(roundLog);
    return {
        strike: {
            attackerUid: attacker.uid,
            defenderUid: defender.uid,
            attackerFaction: attacker.faction,
            attackerMemberIndex,
            kind,
            damage,
            unitHits
        },
        roundLog
    };
}

function pushWave(waves, strikes, roundLog) {
    const real = (strikes || []).filter(Boolean);
    if (!real.length) return roundLog;
    waves.push({
        strikes: real,
        arenaParties: publicArenaParties(),
        groundBooks: snapshotGroundBooks()
    });
    return roundLog;
}

// Resolve one enemy pair for melee into theatre waves.
// foeCount* = how many melee foes that party faces this step (for even damage split).
function resolveMeleePairTheatre(pair, roundLog, foeCountA, foeCountB) {
    const waves = [];
    const a = pair.a;
    const b = pair.b;
    const initA = INITIATIVE_ORDER[a.order] || 2;
    const initB = INITIATIVE_ORDER[b.order] || 2;
    const splitA = Math.max(1, foeCountA || 1);
    const splitB = Math.max(1, foeCountB || 1);

    function unitShare(unitDmg, foeCount, foeIndex) {
        const shares = splitDamageEvenly(unitDmg, foeCount);
        return shares[Math.min(foeIndex, shares.length - 1)] || 0;
    }

    if (initA === initB) {
        // Same order: each tank-rank strikes as a sequence; both sides at once.
        const orderA = livingMembersByTankOrder(a.members);
        const orderB = livingMembersByTankOrder(b.members);
        const maxLen = Math.max(orderA.length, orderB.length);
        const idxA = typeof pair.foeIndexA === 'number' ? pair.foeIndexA : 0;
        const idxB = typeof pair.foeIndexB === 'number' ? pair.foeIndexB : 0;
        for (let i = 0; i < maxLen; i++) {
            const planned = [];
            if (orderA[i] && a.members[orderA[i].index].hp > 0 && partyIsAlive(b)
                && attackerCanSeeTarget(a, b)) {
                const dmg = unitShare(getUnitMeleeOutput(orderA[i].m), splitA, idxA);
                planned.push({
                    attacker: a,
                    defender: b,
                    attackerMemberIndex: orderA[i].index,
                    damage: dmg,
                    unitHits: allocateSpilloverHits(b.members, dmg),
                    kind: 'melee'
                });
            }
            if (orderB[i] && b.members[orderB[i].index].hp > 0 && partyIsAlive(a)
                && attackerCanSeeTarget(b, a)) {
                const dmg = unitShare(getUnitMeleeOutput(orderB[i].m), splitB, idxB);
                planned.push({
                    attacker: b,
                    defender: a,
                    attackerMemberIndex: orderB[i].index,
                    damage: dmg,
                    unitHits: allocateSpilloverHits(a.members, dmg),
                    kind: 'melee'
                });
            }
            const strikes = [];
            planned.forEach(p => {
                const label = `${p.attacker.name} ${p.kind} vs ${p.defender.name}`;
                roundLog += `[${label}] ${p.damage} dmg<br>`;
                applyUnitHitsToMembers(p.defender.members, p.unitHits);
                p.unitHits.forEach(h => {
                    const role = p.defender.members[h.memberIndex]
                        ? p.defender.members[h.memberIndex].role : '?';
                    if (h.knockedOut) {
                        roundLog += ` -> [${label}] ${role} takes ${h.damage} and falls unconscious!<br>`;
                    } else {
                        roundLog += ` -> [${label}] ${role} takes ${h.damage} (${h.remainingHp} HP left).<br>`;
                    }
                });
                strikes.push({
                    attackerUid: p.attacker.uid,
                    defenderUid: p.defender.uid,
                    attackerFaction: p.attacker.faction,
                    attackerMemberIndex: p.attackerMemberIndex,
                    kind: p.kind,
                    damage: p.damage,
                    unitHits: p.unitHits
                });
            });
            if (strikes.length) roundLog = dropBooksFromKnockouts(roundLog);
            roundLog = pushWave(waves, strikes, roundLog);
        }
    } else {
        // Initiative winner: all living members damage in ONE sequence, then counter.
        const first = initA < initB ? a : b;
        const second = initA < initB ? b : a;
        const firstSplit = first.uid === a.uid ? splitA : splitB;
        const firstIdx = first.uid === a.uid
            ? (typeof pair.foeIndexA === 'number' ? pair.foeIndexA : 0)
            : (typeof pair.foeIndexB === 'number' ? pair.foeIndexB : 0);
        const secondSplit = second.uid === a.uid ? splitA : splitB;
        const secondIdx = second.uid === a.uid
            ? (typeof pair.foeIndexA === 'number' ? pair.foeIndexA : 0)
            : (typeof pair.foeIndexB === 'number' ? pair.foeIndexB : 0);

        // Pick a living member index so the client can play the attack leap / pose.
        function leadMeleeIndex(party) {
            const order = livingMembersByTankOrder(party.members);
            return order.length ? order[0].index : null;
        }

        if (partyIsAlive(first) && partyIsAlive(second)) {
            let dmg = unitShare(Math.floor(partyMeleeOutput(first) * 1.2), firstSplit, firstIdx);
            roundLog += ` -> (+20% surprise on ${first.name})<br>`;
            const res = makeStrike(first, second, dmg, 'melee', leadMeleeIndex(first), roundLog);
            roundLog = res.roundLog;
            roundLog = pushWave(waves, res.strike ? [res.strike] : [], roundLog);
        }
        if (partyIsAlive(first) && partyIsAlive(second) && manhattan(first, second) === 1) {
            const dmg = unitShare(partyMeleeOutput(second), secondSplit, secondIdx);
            const res = makeStrike(second, first, dmg, 'melee', leadMeleeIndex(second), roundLog);
            roundLog = res.roundLog;
            roundLog = pushWave(waves, res.strike ? [res.strike] : [], roundLog);
        }
    }

    return { waves, roundLog };
}

function resolveRangedPairTheatre(pair, roundLog) {
    const waves = [];
    // Rebuild party refs from uids (live arena objects).
    const parties = [];
    pair.hits.forEach(h => {
        if (!parties.some(p => p.uid === h.attacker.uid)) parties.push(h.attacker);
        if (!parties.some(p => p.uid === h.target.uid)) parties.push(h.target);
    });
    if (parties.length < 2) return { waves, roundLog };
    const a = parties[0];
    const b = parties[1];
    const initA = INITIATIVE_ORDER[a.order] || 2;
    const initB = INITIATIVE_ORDER[b.order] || 2;

    const aCanShoot = partyRangedOutput(a) > 0 && pair.hits.some(h => h.attacker.uid === a.uid);
    const bCanShoot = partyRangedOutput(b) > 0 && pair.hits.some(h => h.attacker.uid === b.uid);

    if (initA === initB && aCanShoot && bCanShoot) {
        const orderA = livingMembersByTankOrder(a.members).filter(x => getUnitRangedOutput(x.m, a.order) > 0);
        const orderB = livingMembersByTankOrder(b.members).filter(x => getUnitRangedOutput(x.m, b.order) > 0);
        const maxLen = Math.max(orderA.length, orderB.length);
        for (let i = 0; i < maxLen; i++) {
            const planned = [];
            if (orderA[i] && a.members[orderA[i].index].hp > 0 && partyIsAlive(b)
                && attackerCanSeeTarget(a, b)) {
                let dmg = getUnitRangedOutput(orderA[i].m, a.order);
                dmg = applyRangedDefenceModifier(dmg, b);
                planned.push({
                    attacker: a, defender: b, attackerMemberIndex: orderA[i].index,
                    damage: dmg, unitHits: allocateSpilloverHits(b.members, dmg), kind: 'ranged'
                });
            }
            if (orderB[i] && b.members[orderB[i].index].hp > 0 && partyIsAlive(a)
                && attackerCanSeeTarget(b, a)) {
                let dmg = getUnitRangedOutput(orderB[i].m, b.order);
                dmg = applyRangedDefenceModifier(dmg, a);
                planned.push({
                    attacker: b, defender: a, attackerMemberIndex: orderB[i].index,
                    damage: dmg, unitHits: allocateSpilloverHits(a.members, dmg), kind: 'ranged'
                });
            }
            const strikes = [];
            planned.forEach(p => {
                const label = `${p.attacker.name} ${p.kind} vs ${p.defender.name}`;
                roundLog += `[${label}] ${p.damage} dmg<br>`;
                applyUnitHitsToMembers(p.defender.members, p.unitHits);
                p.unitHits.forEach(h => {
                    const role = p.defender.members[h.memberIndex]
                        ? p.defender.members[h.memberIndex].role : '?';
                    if (h.knockedOut) {
                        roundLog += ` -> [${label}] ${role} takes ${h.damage} and falls unconscious!<br>`;
                    } else {
                        roundLog += ` -> [${label}] ${role} takes ${h.damage} (${h.remainingHp} HP left).<br>`;
                    }
                });
                strikes.push({
                    attackerUid: p.attacker.uid,
                    defenderUid: p.defender.uid,
                    attackerFaction: p.attacker.faction,
                    attackerMemberIndex: p.attackerMemberIndex,
                    kind: p.kind,
                    damage: p.damage,
                    unitHits: p.unitHits
                });
            });
            if (strikes.length) roundLog = dropBooksFromKnockouts(roundLog);
            roundLog = pushWave(waves, strikes, roundLog);
        }
    } else {
        // Fire in initiative order; each side that can shoot does all members in one sequence.
        const shooters = [];
        if (aCanShoot) shooters.push(a);
        if (bCanShoot) shooters.push(b);
        shooters.sort((p, q) => (INITIATIVE_ORDER[p.order] || 2) - (INITIATIVE_ORDER[q.order] || 2));
        shooters.forEach(attacker => {
            const defender = attacker.uid === a.uid ? b : a;
            if (!partyIsAlive(attacker) || !partyIsAlive(defender)) return;
            let dmg = partyRangedOutput(attacker);
            dmg = applyRangedDefenceModifier(dmg, defender);
            // Lead living ranged unit animates the shot in the fight window.
            const rangedOrder = livingMembersByTankOrder(attacker.members)
                .filter(x => getUnitRangedOutput(x.m, attacker.order) > 0);
            const leadIdx = rangedOrder.length ? rangedOrder[0].index : null;
            const res = makeStrike(attacker, defender, dmg, 'ranged', leadIdx, roundLog);
            roundLog = res.roundLog;
            roundLog = pushWave(waves, res.strike ? [res.strike] : [], roundLog);
        });
    }

    return { waves, roundLog };
}

// After one move step: optional ranged pair-fights, then melee pair-fights (theatre waves).
// allowRanged: only true after EVERY party has finished this turn's walking (last step / hold round).
// That way range-2 never interrupts mid-path: all planned moves resolve, then shoot if still at 2.
function resolveStepCombat(meleePairsDone, rangedDone, roundLog, finishedMoveUids, allowRanged) {
    const combats = [];
    const hasFinishedMove = (uid) => !finishedMoveUids || finishedMoveUids.has(uid);

    // --- Ranged (only once movement for the whole round is done) ---
    const rangedHitsByPair = new Map();
    if (allowRanged) {
        INITIATIVE_BANDS.forEach(bandName => {
            const attackers = arenaParties.filter(ap => ap.order === bandName && partyIsAlive(ap));
            attackers.forEach(attacker => {
                if (rangedDone.has(attacker.uid)) return;
                // Belt-and-braces: shooter must have no path left (move → move → shoot).
                if (!hasFinishedMove(attacker.uid)) return;
                if (partyRangedOutput(attacker) <= 0) return;
                const rangedTargets = arenaParties.filter(e =>
                    e.faction !== attacker.faction
                    && partyIsAlive(e)
                    && manhattan(attacker, e) === 2
                    && attackerCanSeeTarget(attacker, e)
                    && hasFinishedMove(e.uid)
                );
                if (!rangedTargets.length) return;

                rangedDone.add(attacker.uid);
                rangedTargets.forEach((target) => {
                    const key = meleePairKey(attacker, target);
                    if (!rangedHitsByPair.has(key)) {
                        rangedHitsByPair.set(key, {
                            key,
                            score: combatPairScore(attacker, target),
                            hits: []
                        });
                    }
                    rangedHitsByPair.get(key).hits.push({ attacker, target });
                });
            });
        });
    }

    const rangedPairs = Array.from(rangedHitsByPair.values());
    sortCombatPairsByScore(rangedPairs);

    rangedPairs.forEach(pair => {
        const parties = [];
        pair.hits.forEach(h => {
            if (!parties.some(p => p.uid === h.attacker.uid)) parties.push(h.attacker);
            if (!parties.some(p => p.uid === h.target.uid)) parties.push(h.target);
        });
        if (parties.length < 2) return;
        const meta = combatWindowMeta(parties[0], parties[1]);
        const result = resolveRangedPairTheatre(pair, roundLog);
        roundLog = result.roundLog;
        if (result.waves.length) {
            combats.push({
                kind: 'ranged',
                score: pair.score,
                ...meta,
                waves: result.waves
            });
        }
    });

    // --- Melee pairs (still allowed mid-path when adjacent) ---
    const pendingPairs = [];
    const living = arenaParties.filter(ap => partyIsAlive(ap));
    for (let li = 0; li < living.length; li++) {
        for (let lj = li + 1; lj < living.length; lj++) {
            const a = living[li];
            const b = living[lj];
            if (a.faction === b.faction) continue;
            if (manhattan(a, b) !== 1) continue;
            const key = meleePairKey(a, b);
            if (meleePairsDone.has(key)) continue;
            pendingPairs.push({ a, b, key, score: combatPairScore(a, b) });
        }
    }

    sortCombatPairsByScore(pendingPairs);

    // For each party, list melee foes this step (stable uid order) so damage can be split evenly.
    const meleeFoesByUid = new Map();
    pendingPairs.forEach(pair => {
        if (!meleeFoesByUid.has(pair.a.uid)) meleeFoesByUid.set(pair.a.uid, []);
        if (!meleeFoesByUid.has(pair.b.uid)) meleeFoesByUid.set(pair.b.uid, []);
        meleeFoesByUid.get(pair.a.uid).push(pair.b.uid);
        meleeFoesByUid.get(pair.b.uid).push(pair.a.uid);
    });
    meleeFoesByUid.forEach((list) => list.sort());

    pendingPairs.forEach(pair => {
        if (meleePairsDone.has(pair.key)) return;
        if (!partyIsAlive(pair.a) || !partyIsAlive(pair.b)) return;
        if (manhattan(pair.a, pair.b) !== 1) return;
        meleePairsDone.add(pair.key);

        const foesA = meleeFoesByUid.get(pair.a.uid) || [pair.b.uid];
        const foesB = meleeFoesByUid.get(pair.b.uid) || [pair.a.uid];
        pair.foeIndexA = Math.max(0, foesA.indexOf(pair.b.uid));
        pair.foeIndexB = Math.max(0, foesB.indexOf(pair.a.uid));

        const meta = combatWindowMeta(pair.a, pair.b);
        const result = resolveMeleePairTheatre(pair, roundLog, foesA.length, foesB.length);
        roundLog = result.roundLog;
        if (result.waves.length) {
            combats.push({
                kind: 'melee',
                score: pair.score,
                ...meta,
                waves: result.waves
            });
        }
    });

    return { hasCombat: combats.length > 0, roundLog, combats };
}

function snapshotGroundBooks() {
    return groundBooks.map(b => ({ x: b.x, y: b.y, ownerFaction: b.ownerFaction }));
}

// Cancel this step and every later step for a plan (party stops where it is).
function truncatePlanFromStep(plan, stepIndex) {
    plan.path = plan.path.slice(0, stepIndex);
}

// Living enemy in an orthogonally adjacent tile (manhattan 1 only — NOT range 2).
// Same engagement rule as path planning. Range-2 never cancels a path.
function partyIsAdjacentToLivingEnemy(ap) {
    if (!partyIsAlive(ap) || typeof ap.x !== 'number') return false;
    return arenaParties.some(other =>
        other.uid !== ap.uid
        && other.faction !== ap.faction
        && partyIsAlive(other)
        && typeof other.x === 'number'
        && manhattan(ap, other) === 1
    );
}

// Melee contact only: cancel remaining path. Ranged (2 away) must NOT stop movement.
function stopPlansEngagedWithEnemy(plans, fromStepIndex, roundLog) {
    plans.forEach(plan => {
        if (!partyIsAlive(plan.ap)) return;
        if (fromStepIndex >= plan.path.length) return;
        if (!partyIsAdjacentToLivingEnemy(plan.ap)) return;
        roundLog += ` -> ${plan.ap.name} engaged — stops (cannot pass through / leave while adjacent to an enemy).<br>`;
        truncatePlanFromStep(plan, fromStepIndex);
    });
    return roundLog;
}

// Step-by-step movement: everyone advances one square together, then combat checks,
// then the next square. Builds a timeline the client animates (0.5s slides, 1s gaps).
function resolveSteppedMovementAndCombat(roundLog) {
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

    const timeline = [];
    const meleePairsDone = new Set();
    const rangedDone = new Set();
    const maxSteps = plans.reduce((m, p) => Math.max(m, p.path.length), 0);

    roundLog += `<br>🚶 Stepped movement (${maxSteps} step${maxSteps === 1 ? '' : 's'})<br>`;

    // No one moved — still allow a combat check (parties already in range).
    const stepCount = Math.max(maxSteps, 1);
    const movementSteps = maxSteps;

    for (let step = 0; step < stepCount; step++) {
        const moves = [];
        const isMoveStep = step < movementSteps;

        if (isMoveStep) {
            // Already next to an enemy from an earlier step? No more walking this turn.
            roundLog = stopPlansEngagedWithEnemy(plans, step, roundLog);

            // Intended one-tile moves this step (alive parties that still have path left).
            let intended = plans
                .filter(plan => partyIsAlive(plan.ap) && step < plan.path.length)
                .map(plan => ({
                    plan,
                    from: { x: plan.ap.x, y: plan.ap.y },
                    to: { x: plan.path[step].x, y: plan.path[step].y }
                }));

            // Resolve blocked / contested destinations until stable.
            let safety = 0;
            let changed = true;
            while (changed && safety < 64) {
                changed = false;
                safety += 1;

                const leaving = new Set(intended.map(m => m.plan.ap.uid));

                // Occupancy:
                // - Enemy on the tile → always blocked (even if they are also leaving — no swaps /
                //   pass-through with foes).
                // - Friend on the tile → blocked only if they are NOT leaving this step.
                intended = intended.filter(m => {
                    const holder = arenaParties.find(ap =>
                        partyIsAlive(ap)
                        && ap.uid !== m.plan.ap.uid
                        && ap.x === m.to.x
                        && ap.y === m.to.y
                    );
                    if (!holder) return true;
                    const isEnemy = holder.faction !== m.plan.ap.faction;
                    if (isEnemy || !leaving.has(holder.uid)) {
                        roundLog += ` -> ${m.plan.ap.name} blocked by ${holder.name} at (${m.to.x},${m.to.y}); stops.<br>`;
                        truncatePlanFromStep(m.plan, step);
                        changed = true;
                        return false;
                    }
                    return true;
                });

                // Contest: March > Advance > Guard, then firstLockFaction.
                const byEnd = new Map();
                intended.forEach(m => {
                    const key = `${m.to.x},${m.to.y}`;
                    if (!byEnd.has(key)) byEnd.set(key, []);
                    byEnd.get(key).push(m);
                });

                const winners = [];
                byEnd.forEach((group) => {
                    if (group.length === 1) {
                        winners.push(group[0]);
                        return;
                    }
                    group.sort((a, b) => compareStepMovePriority(a.plan, b.plan));
                    winners.push(group[0]);
                    for (let i = 1; i < group.length; i++) {
                        const loser = group[i];
                        roundLog += ` -> ${loser.plan.ap.name} loses tile (${loser.to.x},${loser.to.y}) to ${group[0].plan.ap.name}; stops at (${loser.from.x},${loser.from.y}).<br>`;
                        truncatePlanFromStep(loser.plan, step);
                        changed = true;
                    }
                });
                intended = winners;
            }

            // Apply surviving moves + pick up books while stepping through.
            intended.forEach(m => {
                m.plan.ap.x = m.to.x;
                m.plan.ap.y = m.to.y;
                moves.push({
                    uid: m.plan.ap.uid,
                    from: m.from,
                    to: { x: m.to.x, y: m.to.y }
                });
                roundLog += ` -> ${m.plan.ap.name} steps to (${m.to.x},${m.to.y}).<br>`;
                roundLog = tryPickupGroundBook(m.plan.ap, roundLog);
            });

            // Just walked into contact? Cancel the rest of the path after this step.
            roundLog = stopPlansEngagedWithEnemy(plans, step + 1, roundLog);
        }

        // Combat after each move step; also once when nobody moved (step 0 only).
        let combats = [];
        if (isMoveStep || movementSteps === 0) {
            // Who has no further path left after this step (holds / short orders count as finished).
            const finishedMoveUids = new Set();
            plans.forEach(plan => {
                if (!partyIsAlive(plan.ap)) return;
                // path.length <= step+1 → no cells remain after this step.
                if (plan.path.length <= step + 1) finishedMoveUids.add(plan.ap.uid);
            });
            // Hold-only round: everyone is "finished" (no one is mid-path).
            if (movementSteps === 0) {
                arenaParties.forEach(ap => {
                    if (partyIsAlive(ap)) finishedMoveUids.add(ap.uid);
                });
            }

            // Ranged only after the LAST walk step of the round (or hold-only).
            // Stops "already at range 2 → shoot immediately" while other / longer paths still move.
            const allowRanged = (movementSteps === 0) || (step === movementSteps - 1);

            roundLog += `<br>⚔ After step ${isMoveStep ? step + 1 : 0}${allowRanged ? '' : ' (melee only)'}<br>`;
            const combatResult = resolveStepCombat(
                meleePairsDone, rangedDone, roundLog, finishedMoveUids, allowRanged
            );
            combats = combatResult.combats || [];
            roundLog = combatResult.roundLog;
            if (!combats.length) roundLog += ' -> No engagements.<br>';
        }

        // Hold-only round: one combat timeline frame, no moves.
        if (!isMoveStep && movementSteps === 0) {
            timeline.push({
                moves: [],
                combats,
                hasCombat: combats.length > 0,
                arenaParties: publicArenaParties(),
                groundBooks: snapshotGroundBooks()
            });
            break;
        }

        if (isMoveStep) {
            timeline.push({
                moves,
                combats,
                hasCombat: combats.length > 0,
                arenaParties: publicArenaParties(),
                groundBooks: snapshotGroundBooks()
            });
        }
    }

    plans.forEach(plan => {
        if (plan.path.length === 0) {
            roundLog += ` -> ${plan.ap.name} held at (${plan.start.x},${plan.start.y}).<br>`;
        }
    });

    return { roundLog, timeline };
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

    // Freeze pre-resolution board for the client (so KO'd heroes stay visible until their float).
    const partiesAtStart = publicArenaParties();

    // 1) Stepped movement + per-step combat (builds client animation timeline)
    const stepped = resolveSteppedMovementAndCombat(roundLog);
    roundLog = stepped.roundLog;
    const timeline = stepped.timeline;

    // 2) Steal / return at towers only after all movement has finished
    const buildingResult = resolveBuildingInteractions(roundLog);
    roundLog = buildingResult.roundLog;
    const bookWins = buildingResult.bookWins;

    // Final KO drops (in case tower phase somehow mattered — usually already handled per step)
    roundLog = dropBooksFromKnockouts(roundLog);

    currentRound++;
    pendingMoves = { p1: null, p2: null };
    firstLockFaction = null;

    const p1Alive = factionHasLivingParties('p1');
    const p2Alive = factionHasLivingParties('p2');

    io.emit('resolve-round', {
        partiesAtStart,
        arenaParties: publicArenaParties(),
        groundBooks: groundBooks.map(b => ({ x: b.x, y: b.y, ownerFaction: b.ownerFaction })),
        nextRound: currentRound,
        log: roundLog,
        // Client plays moves as 0.5s slides; combat pauses/floats are 1s each.
        timeline
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

// ==================== SINGLE-PLAYER AI (p2) ====================

function orthNeighbours(x, y) {
    return [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 }
    ];
}

function tilesOrthAdjacentTo(tile) {
    if (!tile) return [];
    return orthNeighbours(tile.x, tile.y).filter(c =>
        c.x >= 0 && c.x <= GRID_MAX_X && c.y >= 0 && c.y <= GRID_MAX_Y && !isBlockedTile(c.x, c.y)
    );
}

function aiCanStepOnto(x, y, faction, snapshot, selfUid, allowFriendlyPass) {
    if (x < 0 || x > GRID_MAX_X || y < 0 || y > GRID_MAX_Y) return false;
    if (isBlockedTile(x, y)) return false;
    if (isEnemyOccupied(x, y, faction, snapshot, selfUid)) return false;
    if (!allowFriendlyPass && isFriendlyOccupied(x, y, faction, snapshot, selfUid)) return false;
    return true;
}

// Shortest orthogonal path (not including start). Goals = array of {x,y}.
// May pass through friendlies mid-path; never ends on occupied tiles in the returned path
// (caller still runs validateMultiPartyPath for capacity / engagement cuts).
function findShortestPathToGoals(start, goals, faction, snapshot, selfUid) {
    if (!start || typeof start.x !== 'number') return [];
    const goalKeys = new Set((goals || []).map(g => `${g.x},${g.y}`));
    if (!goalKeys.size) return [];
    if (goalKeys.has(`${start.x},${start.y}`)) return [];

    const queue = [{ x: start.x, y: start.y }];
    const cameFrom = new Map();
    cameFrom.set(`${start.x},${start.y}`, null);

    while (queue.length) {
        const cur = queue.shift();
        const curKey = `${cur.x},${cur.y}`;
        for (const n of orthNeighbours(cur.x, cur.y)) {
            const key = `${n.x},${n.y}`;
            if (cameFrom.has(key)) continue;
            const isGoal = goalKeys.has(key);
            // Pass through friendlies only if not the goal (cannot end on them).
            if (!aiCanStepOnto(n.x, n.y, faction, snapshot, selfUid, !isGoal)) continue;
            if (isGoal && isAnyOccupied(n.x, n.y, snapshot, selfUid)) continue;
            cameFrom.set(key, cur);
            if (isGoal) {
                const path = [];
                let walk = n;
                while (walk && !(walk.x === start.x && walk.y === start.y)) {
                    path.push({ x: walk.x, y: walk.y });
                    walk = cameFrom.get(`${walk.x},${walk.y}`);
                }
                path.reverse();
                return path;
            }
            queue.push(n);
        }
    }
    return [];
}

function aiBlueBookOnGround() {
    return groundBooks.find(b => b.ownerFaction === 'p1') || null;
}

function aiTowerPartyGoals(ap) {
    const home = homeBuildingFor('p2');
    const enemyTower = enemyBuildingFor('p2'); // blue tower

    // Holding the blue book → deliver next to the red mission tower.
    if (ap.carryingBook === 'p1') {
        return tilesOrthAdjacentTo(home);
    }
    // Blue book on the ground → walk onto that tile to pick it up.
    const dropped = aiBlueBookOnGround();
    if (dropped) {
        return [{ x: dropped.x, y: dropped.y }];
    }
    // If another red party already holds the blue book, ignore it and go steal from blue.
    return tilesOrthAdjacentTo(enemyTower);
}

function aiNearestEnemy(ap) {
    let best = null;
    let bestDist = Infinity;
    arenaParties.forEach(e => {
        if (e.faction === ap.faction || !partyIsAlive(e)) return;
        if (typeof e.x !== 'number' || typeof e.y !== 'number') return;
        const d = manhattan(ap, e);
        if (d < bestDist) {
            bestDist = d;
            best = e;
        }
    });
    return best;
}

function aiHuntPartyGoals(ap) {
    const enemy = aiNearestEnemy(ap);
    if (!enemy) return [];
    // Prefer ending adjacent (melee range). If already adjacent, stay.
    if (manhattan(ap, enemy) === 1) return [];
    return tilesOrthAdjacentTo(enemy);
}

function buildAITurnOrders() {
    const byNumber = {};
    // Working snapshot so later parties path around earlier planned end tiles.
    const snapshot = arenaParties.map(ap => ({
        uid: ap.uid,
        faction: ap.faction,
        x: ap.x,
        y: ap.y,
        members: ap.members,
        carryingBook: ap.carryingBook
    }));

    for (let num = 1; num <= 4; num++) {
        const ap = arenaParties.find(p => p.faction === 'p2' && p.number === num);
        if (!ap || !partyIsAlive(ap) || typeof ap.x !== 'number') continue;

        const role = (num === 1 || num === 3) ? 'tower' : 'hunt';
        const goals = role === 'tower' ? aiTowerPartyGoals(ap) : aiHuntPartyGoals(ap);
        const fullPath = findShortestPathToGoals(ap, goals, 'p2', snapshot, ap.uid);
        const path = validateMultiPartyPath(ap, fullPath, 'Advance', snapshot);
        byNumber[num] = { order: 'Advance', path };

        if (path.length) {
            const end = path[path.length - 1];
            const snap = snapshot.find(p => p.uid === ap.uid);
            if (snap) {
                snap.x = end.x;
                snap.y = end.y;
            }
        }
    }
    return { byNumber };
}

function lockAITurnAfterHuman() {
    if (!isSinglePlayer() || arenaPhase !== 'COMBAT') return false;
    if (!pendingMoves.p1 || pendingMoves.p2) return false;
    pendingMoves.p2 = buildAITurnOrders();
    return true;
}

// ==================== SOCKET HANDLERS ====================

initPlayerState();

io.on('connection', (socket) => {
    if (gameStarted) {
        socket.emit('assign-player', { faction: 'spectator', gameStarted: true });
    } else if (!players.p1) {
        players.p1 = socket.id;
        socket.emit('assign-player', { faction: 'p1', gameStarted: false });
    } else if (!players.p2 && !singlePlayerMode) {
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
        if (!data.playerName) return;

        const mode = data.mode === 'single' ? 'single' : 'multi';
        const roomCode = String(data.roomCode || (mode === 'single' ? 'SOLO' : '')).trim();
        if (!roomCode) return;

        if (mode === 'single') {
            // Human is always blue (p1). Computer fills the red slot.
            // If this browser was seated as p2, move them into the p1 seat.
            if (faction === 'p2') {
                players.p1 = socket.id;
                players.p2 = null;
                socket.emit('assign-player', { faction: 'p1', gameStarted: false });
            } else if (faction !== 'p1') {
                return;
            }
            singlePlayerMode = true;
            players.p2 = AI_SOCKET_ID;
            playerState.p1.playerName = String(data.playerName).trim();
            playerState.p1.roomCode = roomCode;
            playerState.p2.playerName = 'Computer';
            playerState.p2.roomCode = roomCode;
            gameStarted = true;
            initPlayerState();
            playerState.p2.playerName = 'Computer';
            playerState.p2.roomCode = roomCode;
            resetArenaState();
            enterHubPhase();
            return;
        }

        singlePlayerMode = false;
        playerState[faction].playerName = String(data.playerName).trim();
        playerState[faction].roomCode = roomCode;

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

        // Single-player: computer leaves the results screen with you.
        if (isSinglePlayer()) {
            postMatchReturned.p2 = true;
            playerState.p2.currentRoom = 'TOWN_HQ';
            playerState.p2.launchPending = false;
        }

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

        // First Lock click this round wins same-order tile contests.
        if (!pendingMoves.p1 && !pendingMoves.p2) {
            firstLockFaction = data.faction;
        }

        pendingMoves[data.faction] = { byNumber };

        // Single-player: AI paths were "ready from turn start" — lock them the moment you do.
        if (lockAITurnAfterHuman()) {
            resolveRoundSimulation();
            return;
        }

        if (pendingMoves.p1 && pendingMoves.p2) {
            resolveRoundSimulation();
        } else {
            emitStateSyncAll();
        }
    });

    socket.on('disconnect', () => {
        if (players.p1 === socket.id) { players.p1 = null; readyStatus.p1 = false; }
        if (players.p2 === socket.id) { players.p2 = null; readyStatus.p2 = false; }
        if (!players.p1 && (!players.p2 || players.p2 === AI_SOCKET_ID)) {
            players.p2 = null;
            singlePlayerMode = false;
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
