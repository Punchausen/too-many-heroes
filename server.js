const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// GLOBAL MULTIPLAYER STATE
let players = {};             // Maps 'p1' and 'p2' to socket IDs
let readyStatus = { p1: false, p2: false }; // Tracks lobby readiness
let currentRoundMoves = {};   // Tracks turn submissions
let gameStarted = false;      // Locks out late joiners

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // ROLE ASSIGNMENT ENGINE WITH GAME-IN-PROGRESS LOCKOUT
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

    // Broadcast current lobby status to everyone immediately upon connection
    io.emit('lobby-status', { readyStatus, players });

    // LISTENER: Player clicks the "READY" button on the Title Screen
    socket.on('player-ready', (data) => {
        if (data.faction === 'p1' || data.faction === 'p2') {
            readyStatus[data.faction] = true;
            console.log(`Lobby Update: ${data.faction} is READY`);
            
            // Broadcast the updated readiness states
            io.emit('lobby-status', { readyStatus, players });

            // CRITICAL TRANSITION: Trigger stage advance when both slots lock in
            if (readyStatus.p1 && readyStatus.p2) {
                gameStarted = true;
                console.log("Lobby fully locked! Transitioning to Merchant Guild.");
                io.emit('transition-stage', { stage: 'merchant-guild' });
            }
        }
    });

    socket.on('submit-turn', (data) => {
        currentRoundMoves[data.faction] = { order: data.order, path: data.path };
        if (currentRoundMoves['p1'] && currentRoundMoves['p2']) {
            io.emit('resolve-round', { p1: currentRoundMoves['p1'], p2: currentRoundMoves['p2'] });
            currentRoundMoves = {};
        }
    });

    socket.on('disconnect', () => {
        if (players['p1'] === socket.id) { players['p1'] = null; readyStatus.p1 = false; }
        if (players['p2'] === socket.id) { players['p2'] = null; readyStatus.p2 = false; }
        
        // If both players leave, reset the system flag so a new game can form
        if (!players['p1'] && !players['p2']) {
            gameStarted = false;
        }

        io.emit('lobby-status', { readyStatus, players });
        console.log(`User disconnected: ${socket.id}`);
    });
});

server.listen(3000, () => { console.log('Game engine active at http://localhost:3000'); });