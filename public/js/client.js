// ==================== 1. GLOBAL SELF-CONTAINED GAME STATE ====================
const socket = io();
let myFaction = null;

// Setup Canvas Viewport Context Layers
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const logOverlay = document.getElementById('combat-log-overlay');

// Asset Storage Cache
const Assets = {};

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

const LOCAL_HERO_TEMPLATES = {
    'Peasant':   { hp: 30,  melee: 10, range: 0 },
    'Barbarian': { hp: 100, melee: 40, range: 0 },
    'Elf':       { hp: 50,  melee: 15, range: 25 },
    'Mage':      { hp: 40,  melee: 10, range: 35 },
    'Knight':    { hp: 120, melee: 25, range: 0 }
};

// State Properties
let uiButtons = {}; 
let isWaitingForOpponentDeployment = false;
let currentScene = 'TITLE'; 
let matchActive = true;
let currentRound = 1;
let playerGold = 100;
let isWaitingForCombatResolution = false;

// UNIFIED MASTER GRID METRICS
const ARENA_GRID = {
    offsetX: 290,
    offsetY: 80,
    cellSize: 65
};

let p1Party = [ {role:'Peasant', hp:30, baseHp:30, melee:10, range:0}, {role:'Peasant', hp:30, baseHp:30, melee:10, range:0}, {role:'Peasant', hp:30, baseHp:30, melee:10, range:0}, {role:'Peasant', hp:30, baseHp:30, melee:10, range:0} ];
let p2Party = [ {role:'Peasant', hp:30, baseHp:30, melee:10, range:0}, {role:'Peasant', hp:30, baseHp:30, melee:10, range:0}, {role:'Peasant', hp:30, baseHp:30, melee:10, range:0}, {role:'Peasant', hp:30, baseHp:30, melee:10, range:0} ];
let currentTavernOffer = [];
let currentTavernCost = 0;

let p1X = 0, p1Y = 2;
let p2X = 5, p2Y = 3;
let selectedPath = [];
let p1SelectedOrder = 'Advance';
let p2SelectedOrder = 'Advance';

let lobbyStatusText = { p1: 'DISCONNECTED', p2: 'DISCONNECTED', readyP1: false, readyP2: false };

// ==================== 2. CORE TRANSACTIONAL TRANSMISSION LOGIC ====================
function generateNewTavernOffer() {
    const pool = ['Barbarian', 'Elf', 'Mage', 'Knight', 'Peasant'];
    currentTavernOffer = [];
    let basePartyCost = 0;

    for (let i = 0; i < 4; i++) {
        let randomClass = pool[Math.floor(Math.random() * pool.length)];
        let fixedBaseCost = 10; 

        currentTavernOffer.push({ role: randomClass, cost: fixedBaseCost });
        basePartyCost += fixedBaseCost;
    }

    let macroVariance = Math.floor(Math.random() * 21) - 10; 
    currentTavernCost = Math.max(0, basePartyCost + macroVariance); 
}

function rerollTavernOffer() {
    if (playerGold < 5) return;
    playerGold -= 5;
    generateNewTavernOffer();
}

function hireTavernParty() {
    if (playerGold < currentTavernCost) return;
    playerGold -= currentTavernCost;

    let purchasedSquad = currentTavernOffer.map(h => ({
        role: h.role,
        hp: LOCAL_HERO_TEMPLATES[h.role].hp,
        baseHp: LOCAL_HERO_TEMPLATES[h.role].hp,
        melee: LOCAL_HERO_TEMPLATES[h.role].melee,
        range: LOCAL_HERO_TEMPLATES[h.role].range
    }));

    if (myFaction === 'p1') p1Party = purchasedSquad;
    if (myFaction === 'p2') p2Party = purchasedSquad;

    generateNewTavernOffer(); 
}

function lockAndDeploySquad() {
    let finalSquad = (myFaction === 'p1') ? p1Party : p2Party;
    socket.emit('deploy-squad', { faction: myFaction, party: finalSquad });
    isWaitingForOpponentDeployment = true;
}

function submitLobbyReady() {
    if (myFaction === 'spectator') return;
    socket.emit('player-ready', { faction: myFaction });
}

// ==================== 3. GRAPHICS PAINT VISUALIZATIONS ====================
function drawTitleScreen() {
    if (Assets['bg_title']) ctx.drawImage(Assets['bg_title'], 0, 0);

    ctx.fillStyle = '#ff9800';
    ctx.font = 'bold 54px monospace';
    ctx.textAlign = 'center';
    ctx.fillText("TOO MANY HEROES", canvas.width / 2, 180);
    
    ctx.fillStyle = '#888888';
    ctx.font = '16px monospace';
    ctx.fillText("HTML5 CANVAS PROTOTYPE", canvas.width / 2, 220);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.fillRect(280, 260, 400, 140);
    ctx.strokeRect(280, 260, 400, 140);

    ctx.textAlign = 'left';
    ctx.font = '16px monospace';
    
    ctx.fillStyle = '#fff';
    ctx.fillText("PLAYER 1: ", 310, 310);
    if (lobbyStatusText.p1 === 'DISCONNECTED') { ctx.fillStyle = '#ff3333'; ctx.fillText("DISCONNECTED", 420, 310); }
    else { ctx.fillStyle = lobbyStatusText.readyP1 ? '#00ff00' : '#ffff00'; ctx.fillText(lobbyStatusText.readyP1 ? "READY!" : "CHOOSING...", 420, 310); }

    ctx.fillStyle = '#fff';
    ctx.fillText("PLAYER 2: ", 310, 350);
    if (lobbyStatusText.p2 === 'DISCONNECTED') { ctx.fillStyle = '#ff3333'; ctx.fillText("DISCONNECTED", 420, 350); }
    else { ctx.fillStyle = lobbyStatusText.readyP2 ? '#00ff00' : '#ffff00'; ctx.fillText(lobbyStatusText.readyP2 ? "READY!" : "CHOOSING...", 420, 350); }

    let btnX = canvas.width / 2 - 120;
    let btnY = 460;
    let btnW = 240;
    let btnH = 50;
    
    let isReadyButtonDisabled = (myFaction === 'spectator' || (myFaction === 'p1' && lobbyStatusText.readyP1) || (myFaction === 'p2' && lobbyStatusText.readyP2));
    ctx.drawImage(isReadyButtonDisabled ? Assets['btn_disabled'] : Assets['btn_normal'], btnX, btnY, btnW, btnH);
    
    ctx.fillStyle = '#000';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    
    let label = "READY UP FOR BATTLE";
    if (myFaction === 'spectator') label = "SPECTATOR MODE";
    else if (myFaction === 'p1' && lobbyStatusText.readyP1) label = "WAITING FOR P2...";
    else if (myFaction === 'p2' && lobbyStatusText.readyP2) label = "WAITING FOR P1...";
    ctx.fillText(label, canvas.width / 2, btnY + 30);

    if (!isReadyButtonDisabled) {
        uiButtons['READY_BTN'] = { x: btnX, y: btnY, w: btnW, h: btnH, action: submitLobbyReady };
    }
}

function drawTavernScreen() {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, 60);
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 60); ctx.lineTo(canvas.width, 60); ctx.stroke();

    ctx.fillStyle = '#ff9800';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'left';
    ctx.fillText("THE TAVERN RECRUITMENT MARKET", 20, 38);

    ctx.fillStyle = '#ffff00';
    ctx.textAlign = 'right';
    ctx.fillText(`Gold: ${playerGold}g`, canvas.width - 20, 38);

    let panelY = 80, panelH = 425, leftPanelX = 30, panelW = 430, rightPanelX = 500;

    // Left Box
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(leftPanelX, panelY, panelW, panelH);
    ctx.strokeStyle = '#333'; ctx.strokeRect(leftPanelX, panelY, panelW, panelH);
    ctx.fillStyle = '#00ffff'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'left';
    ctx.fillText("Your Active Warband Roster", leftPanelX + 15, panelY + 25);

    let myCurrentParty = (myFaction === 'p1') ? p1Party : p2Party;
    myCurrentParty.forEach((h, idx) => {
        let cardY = panelY + 40 + (idx * 72);
        ctx.fillStyle = '#222'; ctx.fillRect(leftPanelX + 15, cardY, panelW - 30, 60);
        ctx.strokeStyle = '#444'; ctx.strokeRect(leftPanelX + 15, cardY, panelW - 30, 60);
        
        let hpText = h.hp > 0 ? `${h.hp}/${h.baseHp} HP` : `UNCONSCIOUS`;
        ctx.fillStyle = h.hp > 0 ? '#fff' : '#ff5555';
        ctx.font = 'bold 14px monospace'; ctx.fillText(h.role.toUpperCase(), leftPanelX + 30, cardY + 25);
        ctx.font = '12px monospace'; ctx.fillStyle = '#aaa';
        let attackLabel = h.range > 0 ? `🏹${h.range} Ranged` : `⚔${h.melee} Melee`;
        ctx.fillText(`❤ ${hpText}  |  ${attackLabel}`, leftPanelX + 30, cardY + 45);
    });

    // Right Box
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(rightPanelX, panelY, panelW, panelH);
    ctx.strokeStyle = '#ff9800'; ctx.strokeRect(rightPanelX, panelY, panelW, panelH);
    ctx.fillStyle = '#ff9800'; ctx.font = 'bold 16px monospace'; ctx.fillText("Available Mercenary Contract", rightPanelX + 15, panelY + 25);

    currentTavernOffer.forEach((h, idx) => {
        let cardY = panelY + 40 + (idx * 72);
        ctx.fillStyle = '#222'; ctx.fillRect(rightPanelX + 15, cardY, panelW - 30, 60);
        ctx.strokeStyle = '#333'; ctx.strokeRect(rightPanelX + 15, cardY, panelW - 30, 60);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 14px monospace'; ctx.fillText(h.role.toUpperCase(), rightPanelX + 30, cardY + 25);
        let stats = LOCAL_HERO_TEMPLATES[h.role];
        let attackLabel = stats.range > 0 ? `🏹${stats.range} Ranged` : `⚔${stats.melee} Melee`;
        ctx.font = '12px monospace'; ctx.fillStyle = '#aaa'; ctx.fillText(`❤ ${stats.hp} HP  |  ${attackLabel}`, rightPanelX + 30, cardY + 45);
    });

    let btnY = panelY + panelH - 55, btnW = 185, btnH = 40;

    let canAffordHire = (playerGold >= currentTavernCost && currentTavernOffer.length > 0);
    ctx.fillStyle = canAffordHire ? '#ff9800' : '#444'; ctx.fillRect(rightPanelX + 15, btnY, btnW, btnH);
    ctx.fillStyle = '#000'; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`HIRE PARTY (${currentTavernCost}g)`, rightPanelX + 15 + btnW / 2, btnY + 24);
    uiButtons['HIRE_BTN'] = { x: rightPanelX + 15, y: btnY, w: btnW, h: btnH, action: () => { if (canAffordHire) hireTavernParty(); } };

    let canAffordReroll = (playerGold >= 5);
    let rerollX = rightPanelX + panelW - 15 - btnW;
    ctx.fillStyle = canAffordReroll ? '#555' : '#222'; ctx.fillRect(rerollX, btnY, btnW, btnH);
    ctx.fillStyle = canAffordReroll ? '#fff' : '#555'; ctx.fillText("REROLL (5g)", rerollX + btnW / 2, btnY + 24);
    uiButtons['REROLL_BTN'] = { x: rerollX, y: btnY, w: btnW, h: btnH, action: () => { if (canAffordReroll) rerollTavernOffer(); } };

    let battleBtnX = 30, battleBtnY = 530, battleBtnW = 900, battleBtnH = 55;
    ctx.fillStyle = '#ff9800'; ctx.fillRect(battleBtnX, battleBtnY, battleBtnW, battleBtnH);
    ctx.fillStyle = '#000'; ctx.font = 'bold 20px monospace'; ctx.fillText("TO BATTLE!", battleBtnX + battleBtnW / 2, battleBtnY + 34);
    uiButtons['DEPLOY_BTN'] = { x: battleBtnX, y: battleBtnY, w: battleBtnW, h: battleBtnH, action: lockAndDeploySquad };

    if (isWaitingForOpponentDeployment) {
        ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ff9800'; ctx.font = 'bold 24px monospace'; ctx.fillText("Waiting for opponent to finish drafting...", canvas.width / 2, canvas.height / 2);
    }
}

function drawArenaScreen() {
    ctx.fillStyle = '#1e1e1e'; ctx.fillRect(0, 0, canvas.width, 60);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'left'; ctx.fillText("TOO MANY HEROES - COMBAT ARENA", 20, 38);
    ctx.fillStyle = '#ff9800'; ctx.textAlign = 'right'; ctx.fillText(`ROUND: ${currentRound} / 4`, canvas.width - 20, 38);

    ctx.textAlign = 'left'; ctx.font = 'bold 14px monospace';
    ctx.fillStyle = '#00ffff'; ctx.fillText("PLAYER 1 (CYAN)", 30, 95);
    p1Party.forEach((h, idx) => { 
        ctx.fillStyle = h.hp > 0 ? '#fff' : '#ff5555'; 
        ctx.fillText(`• ${h.role} (${h.hp}/${h.baseHp} HP)`, 30, 120 + (idx * 22)); 
    });

    ctx.fillStyle = '#ff9800'; ctx.fillText("PLAYER 2 (ORANGE)", canvas.width - 220, 95);
    p2Party.forEach((h, idx) => { 
        ctx.fillStyle = h.hp > 0 ? '#fff' : '#ff5555'; 
        ctx.fillText(`• ${h.role} (${h.hp}/${h.baseHp} HP)`, canvas.width - 220, 120 + (idx * 22)); 
    });

    // Render Matrix Utilizing the Shared Global Properties
    for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 6; x++) {
            let cx = ARENA_GRID.offsetX + (x * ARENA_GRID.cellSize);
            let cy = ARENA_GRID.offsetY + (y * ARENA_GRID.cellSize);
            
            ctx.fillStyle = '#111'; ctx.fillRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
            ctx.strokeStyle = '#222'; ctx.strokeRect(cx, cy, ARENA_GRID.cellSize, ARENA_GRID.cellSize);
            ctx.fillStyle = '#444'; ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.fillText(`(${x},${y})`, cx + ARENA_GRID.cellSize / 2, cy + 20);

            if (selectedPath.some(c => c.x === x && c.y === y)) {
                ctx.fillStyle = (myFaction === 'p1') ? 'rgba(0, 255, 255, 0.25)' : 'rgba(255, 152, 0, 0.25)';
                ctx.fillRect(cx + 2, cy + 2, ARENA_GRID.cellSize - 4, ARENA_GRID.cellSize - 4);
            }
            if (x === p1X && y === p1Y) {
                ctx.fillStyle = '#00ffff'; ctx.fillRect(cx + 10, cy + 25, ARENA_GRID.cellSize - 20, 35);
                ctx.fillStyle = '#000'; ctx.font = 'bold 16px monospace'; ctx.fillText("P1", cx + ARENA_GRID.cellSize / 2, cy + 48);
            } else if (x === p2X && y === p2Y) {
                ctx.fillStyle = '#ff9800'; ctx.fillRect(cx + 10, cy + 25, ARENA_GRID.cellSize - 20, 35);
                ctx.fillStyle = '#000'; ctx.font = 'bold 16px monospace'; ctx.fillText("P2", cx + ARENA_GRID.cellSize / 2, cy + 48);
            }
        }
    }

    if (myFaction !== 'spectator') {
        let currentOrder = (myFaction === 'p1') ? p1SelectedOrder : p2SelectedOrder;
        
        ctx.fillStyle = '#fff';
        ctx.font = '14px monospace';
        ctx.textAlign = 'left';
        ctx.fillText("CHOOSE DIRECTIVE ORDER ACTION:", 30, 495);

        const orders = ['Seek', 'Advance', 'March'];
        orders.forEach((o, idx) => {
            let bx = 30 + (idx * 125);
            let by = 515;
            let bw = 110;
            let bh = 40;

            ctx.fillStyle = (currentOrder === o) ? '#ff9800' : '#222';
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeStyle = '#444';
            ctx.strokeRect(bx, by, bw, bh);

            ctx.fillStyle = (currentOrder === o) ? '#000' : '#fff';
            ctx.font = 'bold 12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(o.toUpperCase(), bx + bw / 2, by + 24);

            uiButtons[`ORDER_${o.toUpperCase()}`] = {
                x: bx, y: by, w: bw, h: bh,
                action: () => {
                    if (myFaction === 'p1') p1SelectedOrder = o;
                    else p2SelectedOrder = o;
                    selectedPath = [];
                }
            };
        });

        let submitBtnX = 420;
        let submitBtnY = 515;
        let submitBtnW = 510;
        let submitBtnH = 40;

        ctx.fillStyle = isWaitingForCombatResolution ? '#444' : '#00ff00';
        ctx.fillRect(submitBtnX, submitBtnY, submitBtnW, submitBtnH);

        ctx.fillStyle = isWaitingForCombatResolution ? '#aaa' : '#000';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        
        let submitLabel = isWaitingForCombatResolution ? "WAITING FOR OPPONENT'S STRATEGY..." : "LOCK IN ORDERS FOR THIS ROUND";
        ctx.fillText(submitLabel, submitBtnX + submitBtnW / 2, submitBtnY + 25);

        if (!isWaitingForCombatResolution) {
            uiButtons['LOCK_TURN_BTN'] = {
                x: submitBtnX, y: submitBtnY, w: submitBtnW, h: submitBtnH,
                action: () => {
                    let order = (myFaction === 'p1') ? p1SelectedOrder : p2SelectedOrder;
                    socket.emit('submit-turn', { faction: myFaction, order: order, path: selectedPath });
                    isWaitingForCombatResolution = true; 
                }
            };
        }
    }
}

// ==================== 4. CORE PIPELINE CONTROLLER ====================
function renderActiveScene() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    uiButtons = {}; 

    switch(currentScene) {
        case 'TITLE': drawTitleScreen(); break;
        case 'TAVERN': drawTavernScreen(); break;
        case 'ARENA': drawArenaScreen(); break;
    }
}

function startGameLoop() {
    function tick() { renderActiveScene(); requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
}

function loadGameAssets() {
    Assets['bg_title'] = generateColorPlaceholder('#1a0f00', 960, 640);
    Assets['btn_normal'] = generateColorPlaceholder('#ff9800', 240, 50);
    Assets['btn_disabled'] = generateColorPlaceholder('#444444', 240, 50);
    
    generateNewTavernOffer();
    startGameLoop();
}

// ==================== 5. EVENT LISTENERS ====================
canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    let clickedButton = false;
    for (let key in uiButtons) {
        let btn = uiButtons[key];
        if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
            btn.action(); 
            clickedButton = true; 
            break; 
        }
    }

    if (!clickedButton && myFaction !== 'spectator' && currentScene === 'ARENA' && matchActive) {
        let cellX = Math.floor((mouseX - ARENA_GRID.offsetX) / ARENA_GRID.cellSize);
        let cellY = Math.floor((mouseY - ARENA_GRID.offsetY) / ARENA_GRID.cellSize);

        if (cellX >= 0 && cellX < 6 && cellY >= 0 && cellY < 6) {
            let homeX = (myFaction === 'p1') ? p1X : p2X;
            let homeY = (myFaction === 'p1') ? p1Y : p2Y;
            let currentOrder = (myFaction === 'p1') ? p1SelectedOrder : p2SelectedOrder;
            const distances = { 'Seek': 1, 'Advance': 2, 'March': 3 };
            let maxCapacity = distances[currentOrder];

            let existingIndex = selectedPath.findIndex(c => c.x === cellX && c.y === cellY);
            if (existingIndex !== -1) { selectedPath = selectedPath.slice(0, existingIndex); return; }
            if (selectedPath.length >= maxCapacity) return;

            let anchorX = (selectedPath.length === 0) ? homeX : selectedPath[selectedPath.length - 1].x;
            let anchorY = (selectedPath.length === 0) ? homeY : selectedPath[selectedPath.length - 1].y;

            if (Math.abs(cellX - anchorX) + Math.abs(cellY - anchorY) === 1) {
                selectedPath.push({ x: cellX, y: cellY });
            }
        }
    }
});

socket.on('assign-player', (data) => { myFaction = data.faction; });

socket.on('lobby-status', (data) => {
    lobbyStatusText.p1 = data.players.p1 ? 'CONNECTED' : 'DISCONNECTED';
    lobbyStatusText.p2 = data.players.p2 ? 'CONNECTED' : 'DISCONNECTED';
    lobbyStatusText.readyP1 = data.readyStatus.p1;
    lobbyStatusText.readyP2 = data.readyStatus.p2;
});

socket.on('transition-stage', (data) => {
    if (data.stage === 'merchant-guild') { currentScene = 'TAVERN'; generateNewTavernOffer(); }
    if (data.stage === 'combat-arena') { 
        p1Party = data.p1Party || p1Party; 
        p2Party = data.p2Party || p2Party; 
        isWaitingForOpponentDeployment = false; 
        currentScene = 'ARENA'; 
        if (logOverlay) logOverlay.style.display = 'block'; 
    }
});

socket.on('resolve-round', (data) => {
    console.log("CRITICAL: Received official server combat execution packet:", data);

    if (data.p1) { p1X = data.p1.x; p1Y = data.p1.y; }
    if (data.p2) { p2X = data.p2.x; p2Y = data.p2.y; }

    if (data.p1Party && Array.isArray(data.p1Party)) p1Party = data.p1Party;
    if (data.p2Party && Array.isArray(data.p2Party)) p2Party = data.p2Party;

    if (data.nextRound) currentRound = data.nextRound;
    
    isWaitingForCombatResolution = false; 
    selectedPath = []; 

    if (logOverlay && data.log) {
        logOverlay.innerHTML += `<div style="margin-bottom: 6px; border-left: 2px solid #00ff00; padding-left: 6px; color: #00ff00; font-family: monospace;">${data.log}</div>`;
        logOverlay.scrollTop = logOverlay.scrollHeight; 
    }
});

loadGameAssets();