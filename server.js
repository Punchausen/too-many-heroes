// =============================================================================
// TOO MANY HEROES — SERVER (the "brain" of the game)
// =============================================================================
// Plain English: this file decides what is TRUE in the game.
// - Combat damage, movement, gold, and which screen you're on all live HERE.
// - The browser (client.js) only DRAWS what we send it — it does not invent results.
//
// Surgical patch protocol: when changing this file, edit the smallest function
// that needs fixing. Do not rewrite the whole file unless explicitly asked.
// =============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Socket.io = live two-way messaging between this server and each browser tab
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname + '/public'));
app.get('/', (req, res) => { res.sendFile(__dirname + '/public/index.html'); });

// --- SYSTEM STATE BOUNDARIES ---
// These variables are the shared "save game" for the current match.
// Both players' browsers get copies of pieces of this via STATE_SYNC events.
let players = {};                       // socket ids for p1 / p2
let readyStatus = { p1: false, p2: false };
let currentRoundMoves = {};             // holds each player's locked orders for this round
let gameStarted = false;
let currentRound = 1;
let roomState = 'LANDING'; // Session phase: LANDING | HUB | TACTICAL_ARENA | GAME_OVER

// Warband positions on the arena grid (server is the authority)
let p1Pos = { x: 1, y: 2 };
let p2Pos = { x: 9, y: 7 };
let p1Party = [];
let p2Party = [];

// Hub rooms players can walk between (Castle / Tavern / Town HQ)
const NAVIGABLE_ROOMS = ['TOWN_HQ', 'TAVERN', 'CASTLE'];
// Lower number = acts FIRST. Seek is fastest; March is slowest.
const INITIATIVE_ORDER = { 'Seek': 1, 'Advance': 2, 'March': 3 };
// How many grid cells that order may move in one round
const ORDER_CAPACITIES = { 'Seek': 1, 'Advance': 2, 'March': 3 };
const GRID_MAX_X = 10; // grid is 0..10 in X (11 columns)
const GRID_MAX_Y = 9;  // grid is 0..9 in Y (10 rows)

const HERO_TEMPLATES = {
    'Peasant':   { hp: 30,  melee: 10, range: 0 },
    'Barbarian': { hp: 100, melee: 40, range: 0 },
    'Elf':       { hp: 50,  melee: 15, range: 25 },
    'Mage':      { hp: 40,  melee: 10, range: 35 },
    'Knight':    { hp: 120, melee: 25, range: 0 }
};

const TAVERN_POOL = ['Barbarian', 'Elf', 'Mage', 'Knight', 'Peasant'];

let playerState = {
    p1: { gold: 100, offer: [], cost: 0, draftParty: [], playerName: '', roomCode: '', currentRoom: 'TOWN_HQ' },
    p2: { gold: 100, offer: [], cost: 0, draftParty: [], playerName: '', roomCode: '', currentRoom: 'TOWN_HQ' }
};

function getPlayerRoomState(faction) {
    if (roomState === 'LANDING') return 'LANDING';
    if (roomState === 'TACTICAL_ARENA') return 'TACTICAL_ARENA';
    if (roomState === 'GAME_OVER') return 'GAME_OVER';
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

// Pack a snapshot of "what the client should show right now".
// The client must treat this as read-only truth — it should not invent new values.
function buildStateSync(faction) {
    const ps = faction ? playerState[faction] : null;
    return {
        roomState: getPlayerRoomState(faction),
        player: ps ? {
            faction,
            playerName: ps.playerName,
            gold: ps.gold,
            offer: ps.offer,
            cost: ps.cost,
            draftParty: ps.draftParty,
            currentRoom: ps.currentRoom
        } : null,
        arena: {
            currentRound,
            p1Party,
            p2Party,
            p1Pos,
            p2Pos
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
    if (players.p1) io.to(players.p1).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
    if (players.p2) io.to(players.p2).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
    emitStateSyncAll();
}

function resetArenaState() {
    currentRound = 1;
    p1Pos = { x: 1, y: 2 };
    p2Pos = { x: 9, y: 7 };
    p1Party = [];
    p2Party = [];
    currentRoundMoves = {};
}

function bothPlayersJoinedSameRoom() {
    return players.p1 && players.p2
        && playerState.p1.playerName
        && playerState.p2.playerName
        && playerState.p1.roomCode === playerState.p2.roomCode;
}

function defaultPeasantSquad() {
    return Array.from({ length: 4 }, () => unitFromTemplate('Peasant'));
}

function unitFromTemplate(role) {
    const t = HERO_TEMPLATES[role];
    return { role, hp: t.hp, baseHp: t.hp, melee: t.melee, range: t.range };
}

function generateTavernOffer() {
    const offer = [];
    let basePartyCost = 0;
    for (let i = 0; i < 4; i++) {
        const role = TAVERN_POOL[Math.floor(Math.random() * TAVERN_POOL.length)];
        offer.push({ role, cost: 10 });
        basePartyCost += 10;
    }
    const macroVariance = Math.floor(Math.random() * 21) - 10;
    return { offer, cost: Math.max(0, basePartyCost + macroVariance) };
}

function initPlayerState() {
    const p1Name = playerState.p1.playerName;
    const p2Name = playerState.p2.playerName;
    const p1Code = playerState.p1.roomCode;
    const p2Code = playerState.p2.roomCode;
    const p1Room = playerState.p1.currentRoom || 'TOWN_HQ';
    const p2Room = playerState.p2.currentRoom || 'TOWN_HQ';
    playerState.p1 = { gold: 100, ...generateTavernOffer(), draftParty: defaultPeasantSquad(), playerName: p1Name, roomCode: p1Code, currentRoom: p1Room };
    playerState.p2 = { gold: 100, ...generateTavernOffer(), draftParty: defaultPeasantSquad(), playerName: p2Name, roomCode: p2Code, currentRoom: p2Room };
}

function emitTavernSync(faction) {
    if (!players[faction]) return;
    const ps = playerState[faction];
    io.to(players[faction]).emit('tavern-sync', {
        gold: ps.gold,
        offer: ps.offer,
        cost: ps.cost,
        party: ps.draftParty
    });
    io.to(players[faction]).emit('STATE_SYNC', buildStateSync(faction));
}

function normalizeSquad(party) {
    if (!Array.isArray(party)) return [];
    return party
        .slice(0, 4)
        .filter(u => u && HERO_TEMPLATES[u.role])
        .map(u => unitFromTemplate(u.role));
}

// Clients may DRAW a path, but the server RECHECKS it so cheats / bugs cannot move too far.
// Rules: stay on the grid, move one cell at a time (no diagonals), and respect order capacity.
function validateMovementPath(startPos, path, order) {
    if (!Array.isArray(path)) return [];
    const maxCapacity = ORDER_CAPACITIES[order] || 2;
    const valid = [];
    let ax = startPos.x, ay = startPos.y;
    for (let i = 0; i < path.length && valid.length < maxCapacity; i++) {
        const cell = path[i];
        if (typeof cell.x !== 'number' || typeof cell.y !== 'number') break;
        if (cell.x < 0 || cell.x > GRID_MAX_X || cell.y < 0 || cell.y > GRID_MAX_Y) break;
        // Manhattan distance of 1 = orthogonally adjacent (up/down/left/right only)
        if (Math.abs(cell.x - ax) + Math.abs(cell.y - ay) !== 1) break;
        valid.push({ x: cell.x, y: cell.y });
        ax = cell.x;
        ay = cell.y;
    }
    return valid;
}

initPlayerState();

io.on('connection', (socket) => {
    if (gameStarted) {
        socket.emit('assign-player', { faction: 'spectator', gameStarted: true });
    } else if (!players['p1']) {
        players['p1'] = socket.id;
        socket.emit('assign-player', { faction: 'p1', gameStarted: false });
    } else if (!players['p2']) {
        players['p2'] = socket.id;
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
        if (roomState === 'TACTICAL_ARENA' || roomState === 'LANDING' || roomState === 'GAME_OVER') return;
        if (!NAVIGABLE_ROOMS.includes(data.targetRoom)) return;
        navigatePlayer(faction, data.targetRoom);
    });

    socket.on('RETURN_TO_HQ', () => {
        if (!getFactionForSocket(socket)) return;
        if (roomState !== 'GAME_OVER') return;
        resetArenaState();
        readyStatus = { p1: false, p2: false };
        gameStarted = true;
        initPlayerState();
        playerState.p1.currentRoom = 'TOWN_HQ';
        playerState.p2.currentRoom = 'TOWN_HQ';
        roomState = 'HUB';
        if (players.p1) io.to(players.p1).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
        if (players.p2) io.to(players.p2).emit('ROOM_TRANSITION', { newState: 'TOWN_HQ' });
        emitStateSyncAll();
    });

    socket.on('LAUNCH_QUEST', (data) => {
        const faction = getFactionForSocket(socket);
        if (!faction || roomState !== 'HUB' || playerState[faction].currentRoom !== 'CASTLE') return;
        const squad = normalizeSquad(playerState[faction].draftParty);
        if (!squad.length) return;

        if (faction === 'p1') p1Party = squad;
        if (faction === 'p2') p2Party = squad;

        if (p1Party.length && p2Party.length) {
            roomState = 'TACTICAL_ARENA';
            io.emit('ROOM_TRANSITION', { newState: 'TACTICAL_ARENA' });
            io.emit('transition-stage', {
                stage: 'combat-arena',
                p1Party: p1Party,
                p2Party: p2Party
            });
            emitStateSyncAll();
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
        const fresh = generateTavernOffer();
        ps.offer = fresh.offer;
        ps.cost = fresh.cost;
        emitTavernSync(data.faction);
    });

    socket.on('tavern-hire', (data) => {
        if (!gameStarted || !ownsFaction(socket, data.faction)) return;
        const ps = playerState[data.faction];
        if (ps.gold < ps.cost || ps.offer.length === 0) return;
        ps.gold -= ps.cost;
        ps.draftParty = ps.offer.map(h => unitFromTemplate(h.role));
        const fresh = generateTavernOffer();
        ps.offer = fresh.offer;
        ps.cost = fresh.cost;
        emitTavernSync(data.faction);
    });

    socket.on('submit-turn', (data) => {
        if (!gameStarted || !ownsFaction(socket, data.faction)) return;
        if (currentRoundMoves[data.faction]) return;

        const order = INITIATIVE_ORDER[data.order] ? data.order : 'Advance';
        const startPos = data.faction === 'p1' ? p1Pos : p2Pos;
        const path = validateMovementPath(startPos, data.path, order);
        currentRoundMoves[data.faction] = { order, path };

        if (currentRoundMoves['p1'] && currentRoundMoves['p2']) {
            resolveRoundSimulation();
        }
    });

    socket.on('disconnect', () => {
        if (players['p1'] === socket.id) { players['p1'] = null; readyStatus.p1 = false; }
        if (players['p2'] === socket.id) { players['p2'] = null; readyStatus.p2 = false; }
        if (!players['p1'] && !players['p2']) {
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

// ==================== TACTICAL COMBAT RESOLVER ENGINE ====================
// Called only after BOTH players have locked in their orders for the round.
// Order of operations (do not rearrange without updating the spec):
//   1) Move both warbands to the end of their validated paths
//   2) Measure distance (Manhattan: |dx| + |dy|)
//   3) Decide who acts first (initiative), or both at once if same order
//   4) Fight at range (distance 2) or melee (distance 1), or just maneuver
function resolveRoundSimulation() {
    let p1Move = currentRoundMoves['p1'];
    let p2Move = currentRoundMoves['p2'];

    // 1. Resolve Movement Positions (Rule 3.2)
    // Final cell of the path becomes the new official position.
    if (p1Move.path && p1Move.path.length > 0) p1Pos = p1Move.path[p1Move.path.length - 1];
    if (p2Move.path && p2Move.path.length > 0) p2Pos = p2Move.path[p2Move.path.length - 1];

    let gridDistance = Math.abs(p1Pos.x - p2Pos.x) + Math.abs(p1Pos.y - p2Pos.y);
    let roundLog = `[ROUND ${currentRound} RESOLUTION] <br> P1 chose ${p1Move.order} -> End Pos: (${p1Pos.x},${p1Pos.y})<br> P2 chose ${p2Move.order} -> End Pos: (${p2Pos.x},${p2Pos.y})<br>`;

    // 2. Initiative Calculations (Rule 3.3)
    // Smaller initiative number wins (Seek=1 beats Advance=2 beats March=3).
    let p1Init = INITIATIVE_ORDER[p1Move.order] || 2;
    let p2Init = INITIATIVE_ORDER[p2Move.order] || 2;

    let simultaneous = (p1Init === p2Init);
    let p1HasInitiative = (!simultaneous && p1Init < p2Init);
    let p2HasInitiative = (!simultaneous && p2Init < p1Init);

    let getAlive = (party) => party.filter(u => u.hp > 0);

    // Power helpers ALWAYS filter to living units first.
    // That matters for counter-attacks: after the first strike, dead heroes
    // must not still contribute damage (no "zombie shooting").
    let getRangedPower = (party, order) => {
        // March = sprinting; you cannot shoot while Marching.
        if (order === 'March') return 0;
        let sum = 0;
        getAlive(party).forEach(u => sum += (u.range || 0));
        return sum;
    };

    let getMeleePower = (party) => {
        // In melee, every living hero joins in (melee + range stats combined).
        let sum = 0;
        getAlive(party).forEach(u => sum += ((u.melee || 0) + (u.range || 0)));
        return sum;
    };

    // 3. Combat Matrix Fork (Rule 3.1)
    if (gridDistance === 2) {
        // --- RANGED COMBAT PHASE (Rule 3.4) ---
        roundLog += `🏹 Ranged Skirmish Engaged at distance 2! <br>`;
        
        if (simultaneous) {
            let p1Power = getRangedPower(p1Party, p1Move.order);
            let p2Power = getRangedPower(p2Party, p2Move.order);
            applySpilloverDamage(p2Party, p1Power, (str) => roundLog += str, "P1 Barrage");
            applySpilloverDamage(p1Party, p2Power, (str) => roundLog += str, "P2 Barrage");
        } else if (p1HasInitiative) {
            let p1Power = getRangedPower(p1Party, p1Move.order);
            applySpilloverDamage(p2Party, p1Power, (str) => roundLog += str, "P1 Initiative Shot");
            
            // Recalculate P2 power based ONLY on surviving units
            let p2SurvivingPower = getRangedPower(p2Party, p2Move.order);
            if (p2SurvivingPower > 0) {
                applySpilloverDamage(p1Party, p2SurvivingPower, (str) => roundLog += str, "P2 Retaliation Shot");
            } else {
                roundLog += " -> P2 backline completely broken! No survivors left to return fire.<br>";
            }
        } else {
            let p2Power = getRangedPower(p2Party, p2Move.order);
            applySpilloverDamage(p1Party, p2Power, (str) => roundLog += str, "P2 Initiative Shot");
            
            // Recalculate P1 power based ONLY on surviving units
            let p1SurvivingPower = getRangedPower(p1Party, p1Move.order);
            if (p1SurvivingPower > 0) {
                applySpilloverDamage(p2Party, p1SurvivingPower, (str) => roundLog += str, "P1 Retaliation Shot");
            } else {
                roundLog += " -> P1 backline completely broken! No survivors left to return fire.<br>";
            }
        }
    } else if (gridDistance === 1) {
        // --- MELEE COMBAT PHASE (Rule 3.5) ---
        roundLog += `⚔️ Melee Clash Engaged at distance 1! <br>`;

        if (simultaneous) {
            let p1Power = getMeleePower(p1Party);
            let p2Power = getMeleePower(p2Party);
            applySpilloverDamage(p2Party, p1Power, (str) => roundLog += str, "P1 Strike");
            applySpilloverDamage(p1Party, p2Power, (str) => roundLog += str, "P2 Strike");
        } else if (p1HasInitiative) {
            let p1Power = getMeleePower(p1Party);
            let buffedDmg = Math.floor(p1Power * 1.2); // +20% Surprise Buff
            applySpilloverDamage(p2Party, buffedDmg, (str) => roundLog += str, "P1 Buffed Surprise Strike");
            
            // Recalculate P2 power based ONLY on surviving units
            let p2SurvivingPower = getMeleePower(p2Party);
            if (p2SurvivingPower > 0) {
                applySpilloverDamage(p1Party, p2SurvivingPower, (str) => roundLog += str, "P2 Counter Strike");
            } else {
                roundLog += " -> P2 warband completely broken! No survivors left to counter-strike.<br>";
            }
        } else {
            let p2Power = getMeleePower(p2Party);
            let buffedDmg = Math.floor(p2Power * 1.2); // +20% Surprise Buff
            applySpilloverDamage(p1Party, buffedDmg, (str) => roundLog += str, "P2 Buffed Surprise Strike");
            
            // Recalculate P1 power based ONLY on surviving units
            let p1SurvivingPower = getMeleePower(p1Party);
            if (p1SurvivingPower > 0) {
                applySpilloverDamage(p2Party, p1SurvivingPower, (str) => roundLog += str, "P1 Counter Strike");
            } else {
                roundLog += " -> P1 warband completely broken! No survivors left to counter-strike.<br>";
            }
        }
    } else {
        roundLog += `🎯 Maneuver Phase: Warbands moving through open columns. No engagement made.`;
    }

    currentRound++;
    currentRoundMoves = {};

    // Broadcast state updates directly to visual clients
    io.emit('resolve-round', {
        p1: { x: p1Pos.x, y: p1Pos.y },
        p2: { x: p2Pos.x, y: p2Pos.y },
        p1Party: p1Party,
        p2Party: p2Party,
        nextRound: currentRound,
        log: roundLog
    });
}

// ==================== SPILLOVER DAMAGE LOOPS (Rule 3.6) ====================
// Plain English "tanking" rule:
// Damage always hits the living hero with the HIGHEST baseHp first (the big tank).
// If that hero dies and damage is left over, leftovers "spill" onto the next tank.
// Repeat until damage is spent or the whole party is unconscious.
function applySpilloverDamage(party, totalDamage, appendLog, attackerLabel) {
    let remainingDmg = totalDamage;
    if (remainingDmg <= 0) return;

    while (remainingDmg > 0) {
        let aliveUnits = party.filter(u => u.hp > 0);
        if (aliveUnits.length === 0) break;

        // Sort toughest baseline first (baseHp, not current hp)
        aliveUnits.sort((a, b) => b.baseHp - a.baseHp);
        let currentTank = aliveUnits[0];

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

server.listen(3000, () => { console.log('Game engine active at http://localhost:3000'); });