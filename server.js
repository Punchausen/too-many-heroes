const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

let players = {};
let currentRoundMoves = {};

io.on('connection', (socket) => {
    if (!players['p1']) {
        players['p1'] = socket.id;
        socket.emit('assign-player', { faction: 'p1' });
    } else if (!players['p2']) {
        players['p2'] = socket.id;
        socket.emit('assign-player', { faction: 'p2' });
    } else {
        socket.emit('assign-player', { faction: 'spectator' });
    }

    socket.on('submit-turn', (data) => {
        // Logging structural path metrics across local logs
        currentRoundMoves[data.faction] = { order: data.order, path: data.path };
        
        if (currentRoundMoves['p1'] && currentRoundMoves['p2']) {
            io.emit('resolve-round', {
                p1: currentRoundMoves['p1'],
                p2: currentRoundMoves['p2']
            });
            currentRoundMoves = {};
        }
    });

    socket.on('disconnect', () => {
        if (players['p1'] === socket.id) delete players['p1'];
        if (players['p2'] === socket.id) delete players['p2'];
    });
});

server.listen(3000, () => { console.log('Game engine active at http://localhost:3000'); });