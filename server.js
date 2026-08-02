const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname + '/public'));
app.get('/', (req, res) => { res.sendFile(__dirname + '/public/index.html'); });

// --- SYSTEM STATE BOUNDARIES ---
let players = {};
let readyStatus = { p1: false, p2: false };
let currentRoundMoves = {};
let gameStarted = false;
let currentRound = 1;

let p1Pos = { x: 0, y: 2 };
let p2Pos = { x: 5, y: 3 };
let p1Party = [];
let p2Party = [];

const INITIATIVE_ORDER = { 'Seek': 1, 'Advance': 2, 'March': 3 };

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

    socket.on('player-ready', (data) => {
        if (data.faction === 'p1' || data.faction === 'p2') {
            readyStatus[data.faction] = true;
            io.emit('lobby-status', { readyStatus, players });

            if (readyStatus.p1 && readyStatus.p2) {
                gameStarted = true;
                currentRound = 1;
                p1Pos = { x: 0, y: 2 };
                p2Pos = { x: 5, y: 3 };
                io.emit('transition-stage', { stage: 'merchant-guild' });
            }
        }
    });

    socket.on('deploy-squad', (data) => {
        if (data.faction === 'p1' || data.faction === 'p2') {
            if (data.faction === 'p1') p1Party = data.party;
            if (data.faction === 'p2') p2Party = data.party;
            console.log(`Squad Synced: ${data.faction} locked in their team composition.`);

            if (p1Party.length && p2Party.length) {
                io.emit('transition-stage', { 
                    stage: 'combat-arena',
                    p1Party: p1Party,
                    p2Party: p2Party
                });
            }
        }
    });

    socket.on('submit-turn', (data) => {
        if (!gameStarted) return;
        currentRoundMoves[data.faction] = { order: data.order, path: data.path };

        if (currentRoundMoves['p1'] && currentRoundMoves['p2']) {
            resolveRoundSimulation();
        }
    });

    socket.on('disconnect', () => {
        if (players['p1'] === socket.id) { players['p1'] = null; readyStatus.p1 = false; }
        if (players['p2'] === socket.id) { players['p2'] = null; readyStatus.p2 = false; }
        if (!players['p1'] && !players['p2']) { gameStarted = false; p1Party = []; p2Party = []; currentRoundMoves = {}; }
        io.emit('lobby-status', { readyStatus, players });
    });
});

// ==================== TACTICAL COMBAT RESOLVER ENGINE ====================
function resolveRoundSimulation() {
    let p1Move = currentRoundMoves['p1'];
    let p2Move = currentRoundMoves['p2'];

    // 1. Resolve Movement Positions (Rule 3.2)
    if (p1Move.path && p1Move.path.length > 0) p1Pos = p1Move.path[p1Move.path.length - 1];
    if (p2Move.path && p2Move.path.length > 0) p2Pos = p2Move.path[p2Move.path.length - 1];

    let gridDistance = Math.abs(p1Pos.x - p2Pos.x) + Math.abs(p1Pos.y - p2Pos.y);
    let roundLog = `[ROUND ${currentRound} RESOLUTION] <br> P1 chose ${p1Move.order} -> End Pos: (${p1Pos.x},${p1Pos.y})<br> P2 chose ${p2Move.order} -> End Pos: (${p2Pos.x},${p2Pos.y})<br>`;

    // 2. Initiative Calculations (Rule 3.3)
    let p1Init = INITIATIVE_ORDER[p1Move.order] || 2;
    let p2Init = INITIATIVE_ORDER[p2Move.order] || 2;

    let simultaneous = (p1Init === p2Init);
    let p1HasInitiative = (!simultaneous && p1Init < p2Init);
    let p2HasInitiative = (!simultaneous && p2Init < p1Init);

    let getAlive = (party) => party.filter(u => u.hp > 0);

    // Helper functions to grab actual current power dynamically mid-step
    let getRangedPower = (party, order) => {
        if (order === 'March') return 0;
        let sum = 0;
        getAlive(party).forEach(u => sum += (u.range || 0));
        return sum;
    };

    let getMeleePower = (party) => {
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
function applySpilloverDamage(party, totalDamage, appendLog, attackerLabel) {
    let remainingDmg = totalDamage;
    if (remainingDmg <= 0) return;

    while (remainingDmg > 0) {
        let aliveUnits = party.filter(u => u.hp > 0);
        if (aliveUnits.length === 0) break;

        // Force tank allocation via highest base health descending order
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