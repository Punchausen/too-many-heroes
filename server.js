// DEPENDENCIES: Load network capabilities
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Unlocks connection visibility for external browsers
});

// ROUTING: Serve our game client file automatically when a user visits the link
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// MULTIPLAYER STATE DATABASE
let players = {}; // Tracks connection tokens mapped to Factions (Player 1 / Player 2)
let currentRoundMoves = {}; // Holds incoming JSON submissions: { p1: {order, dir}, p2: {order, dir} }

// SOCKET CONNECTION HANDLER: Triggers when a web browser loads the page
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Assign a clear role slot or re-route them to an audience spectator seat
    if (!players['p1']) {
        players['p1'] = socket.id;
        socket.emit('assign-player', { faction: 'p1' });
        console.log(`Assigned Player 1: ${socket.id}`);
    } else if (!players['p2']) {
        players['p2'] = socket.id;
        socket.emit('assign-player', { faction: 'p2' });
        console.log(`Assigned Player 2: ${socket.id}`);
    } else {
        socket.emit('assign-player', { faction: 'spectator' });
    }

    // LISTENER: Fires when a commander locks in their turn parameters
    socket.on('submit-turn', (data) => {
        // data looks like: { faction: 'p1', order: 'March', dir: 'EAST' }
        currentRoundMoves[data.faction] = { order: data.order, dir: data.dir };
        console.log(`Orders logged from ${data.faction}`);

        // REF RECONCILIATION: Check if BOTH players have committed an executive layout decision
        if (currentRoundMoves['p1'] && currentRoundMoves['p2']) {
            console.log("Both sets of orders received! Broadcasting resolution pipeline...");
            
            // Broadcast the combined master package to both screens to run identical timelines simultaneously
            io.emit('resolve-round', {
                p1: currentRoundMoves['p1'],
                p2: currentRoundMoves['p2']
            });

            // Wipe database state arrays for the upcoming match loop index rotation
            currentRoundMoves = {};
        }
    });

    // CONNECTION TERMINATION WATCHER: Cleanup slots when tab closes
    socket.on('disconnect', () => {
        if (players['p1'] === socket.id) delete players['p1'];
        if (players['p2'] === socket.id) delete players['p2'];
        console.log(`User disconnected: ${socket.id}`);
    });
});

// START LISTENING: Spin up the referee environment on Port 3000
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Game engine actively broadcasting at http://localhost:${PORT}`);
});