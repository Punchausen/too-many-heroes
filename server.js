const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Decoupling Route: Serve all frontend assets dynamically from the 'public' directory
app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

let players = {};
let readyStatus = { p1: false, p2: false };
let currentRoundMoves = {};
let gameStarted = false;

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
        if (!players['p1'] && !players['p2']) gameStarted = false;
        io.emit('lobby-status', { readyStatus, players });
    });
});

server.listen(3000, () => { console.log('Game engine active at http://localhost:3000'); });