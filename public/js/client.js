const socket = io();
let myFaction = null;

function switchView(viewId) {
    document.querySelectorAll('.game-view').forEach(view => view.classList.remove('view-active'));
    document.getElementById(viewId).classList.add('view-active');
}

socket.on('assign-player', (data) => {
    myFaction = data.faction;
    const banner = document.getElementById('identity-banner');
    const lobbyBtn = document.getElementById('lobby-ready-btn');
    
    if (data.gameStarted && myFaction === 'spectator') {
        lobbyBtn.disabled = true;
        lobbyBtn.innerText = "GAME IN PROGRESS...";
        switchView('view-title');
        return;
    }

    if(myFaction === 'p1') {
        banner.innerHTML = `<span style="color: #00ffff;">YOU ARE PLAYER 1 (CYAN)</span>`;
        document.getElementById('p1-card').classList.add('active-faction');
        disableInputs('.p2-input', true);
        lobbyBtn.disabled = false;
        lobbyBtn.innerText = "READY UP FOR BATTLE";
    } else if(myFaction === 'p2') {
        banner.innerHTML = `<span style="color: #ff9800;">YOU ARE PLAYER 2 (ORANGE)</span>`;
        document.getElementById('p2-card').classList.add('active-faction');
        disableInputs('.p1-input', true);
        lobbyBtn.disabled = false;
        lobbyBtn.innerText = "READY UP FOR BATTLE";
    } else {
        banner.innerHTML = `<span style="color: #888;">SPECTATOR MODE</span>`;
        document.getElementById('lock-btn').disabled = true;
        lobbyBtn.disabled = true;
        lobbyBtn.innerText = "LOBBY FULL - SPECTATING";
        disableInputs('.p1-input', true); disableInputs('.p2-input', true);
    }
    initializeMatchUI();
});

socket.on('lobby-status', (data) => {
    const p1Row = document.getElementById('lobby-p1-row');
    const p2Row = document.getElementById('lobby-p2-row');

    if (!data.players.p1) p1Row.innerHTML = `Player 1 Connection: <span class="status-waiting">DISCONNECTED</span>`;
    else p1Row.innerHTML = `Player 1 Connection: ` + (data.readyStatus.p1 ? `<span class="status-ready">READY!</span>` : `<span style="color: #ffff00;">CHOOSING...</span>`);

    if (!data.players.p2) p2Row.innerHTML = `Player 2 Connection: <span class="status-waiting">DISCONNECTED</span>`;
    else p2Row.innerHTML = `Player 2 Connection: ` + (data.readyStatus.p2 ? `<span class="status-ready">READY!</span>` : `<span style="color: #ffff00;">CHOOSING...</span>`);
});

function submitLobbyReady() {
    if (myFaction === 'spectator') return;
    socket.emit('player-ready', { faction: myFaction });
    const btn = document.getElementById('lobby-ready-btn');
    btn.disabled = true;
    btn.innerText = "WAITING FOR OTHER PLAYER...";
}

// STAGE TRANSITION: Fired when players pass the ready check
socket.on('transition-stage', (data) => {
    if (data.stage === 'merchant-guild') {
        generateNewTavernOffer(); // Roll the first private contract offer
        updateTavernUIState();
        switchView('view-merchant-guild');
    }
    if (data.stage === 'combat-arena') {
        // Unpack final synced armies sent from the server data models
        p1Party = data.p1Party;
        p2Party = data.p2Party;
        
        initializeMatchUI();
        switchView('view-combat-arena');
    }
});

// ==================== UPDATED TAVERN GENERATOR ENGINE MAPPING ====================
function generateNewTavernOffer() {
    // Included 'Peasant' to the core random class pool list
    const pool = ['Barbarian', 'Elf', 'Mage', 'Knight', 'Peasant'];
    currentTavernOffer = [];
    
    let basePartyCost = 0;

    for (let i = 0; i < 4; i++) {
        let randomClass = pool[Math.floor(Math.random() * pool.length)];
        let fixedBaseCost = 10; // All classes cost a locked baseline of 10 gold

        currentTavernOffer.push({ role: randomClass, cost: fixedBaseCost });
        basePartyCost += fixedBaseCost;
    }

    // Apply the +/- 10 gold modifier to the TOTAL party cost, not individual members
    let macroVariance = Math.floor(Math.random() * 21) - 10; // Generates integer between -10 and +10
    currentTavernCost = Math.max(0, basePartyCost + macroVariance); // Enforce lower bounds floor limit
}

function updateTavernUIState() {
    document.getElementById('gold-display').innerText = `Gold: ${playerGold}g`;
    
    let myCurrentParty = (myFaction === 'p1') ? p1Party : p2Party;
    const activeBox = document.getElementById('tavern-active-roster-box');
    activeBox.innerHTML = myCurrentParty.map(h => {
        let attackLabel = h.range > 0 ? `🏹${h.range} Ranged` : `⚔${h.melee} Melee`;
        return `<div class="hero-chip" style="display:block; margin: 4px 0;"><b>${h.role}</b> (❤${h.hp} HP | ${attackLabel})</div>`;
    }).join('');

    // Render contract options displaying comprehensive offensive capabilities
    const offerBox = document.getElementById('tavern-offer-box');
    offerBox.innerHTML = currentTavernOffer.map(h => {
        let stats = HERO_TEMPLATES[h.role];
        let attackLabel = stats.range > 0 ? `🏹${stats.range} Ranged` : `⚔${stats.melee} Melee`;
        return `<div class="hero-chip" style="display:block; margin:4px 0; border: 1px dashed #ff9800;">
            <b>${h.role}</b> (❤${stats.hp} HP | ${attackLabel})
        </div>`;
    }).join('');

    document.getElementById('tavern-cost-label').innerText = `Total Contract Cost: ${currentTavernCost}g`;

    document.getElementById('hire-party-btn').disabled = (playerGold < currentTavernCost);
    document.getElementById('reroll-party-btn').disabled = (playerGold < 5);
}

function updateTavernUIState() {
    document.getElementById('gold-display').innerText = `Gold: ${playerGold}g`;
    
    // Render current active layout (P1 vs P2 routing check)
    let myCurrentParty = (myFaction === 'p1') ? p1Party : p2Party;
    const activeBox = document.getElementById('tavern-active-roster-box');
    activeBox.innerHTML = myCurrentParty.map(h => 
        `<div class="hero-chip" style="display:block; margin: 4px 0;"><b>${h.role}</b> (❤${h.hp} HP | ⚔${h.melee} Melee | 🏹${h.range} Range)</div>`
    ).join('');

    // Render incoming tavern market offer card packages
    const offerBox = document.getElementById('tavern-offer-box');
    offerBox.innerHTML = currentTavernOffer.map(h => {
        let stats = HERO_TEMPLATES[h.role];
        return `<div class="hero-chip" style="display:block; margin:4px 0; border: 1px dashed #ff9800;">
            <b>${h.role}</b> (❤${stats.hp} HP) <span style="float:right; color:#ffff00;">Cost: ${h.cost}g</span>
        </div>`;
    }).join('');

    document.getElementById('tavern-cost-label').innerText = `Total Contract Cost: ${currentTavernCost}g`;

    // Handle button locking states based on remaining cash reserves
    document.getElementById('hire-party-btn').disabled = (playerGold < currentTavernCost);
    document.getElementById('reroll-party-btn').disabled = (playerGold < 5);
}

function rerollTavernOffer() {
    if (playerGold < 5) return;
    playerGold -= 5;
    generateNewTavernOffer();
    updateTavernUIState();
}

function hireTavernParty() {
    if (playerGold < currentTavernCost) return;
    playerGold -= currentTavernCost;

    // Convert raw tavern package names into full template attribute objects
    let purchasedSquad = currentTavernOffer.map(h => ({
        role: h.role,
        hp: HERO_TEMPLATES[h.role].hp,
        baseHp: HERO_TEMPLATES[h.role].hp,
        melee: HERO_TEMPLATES[h.role].melee,
        range: HERO_TEMPLATES[h.role].range
    }));

    // Override active local squad instances instantly
    if (myFaction === 'p1') p1Party = purchasedSquad;
    if (myFaction === 'p2') p2Party = purchasedSquad;

    generateNewTavernOffer(); // Instantly roll a new offer for potential subsequent chains
    updateTavernUIState();
}

function lockAndDeploySquad() {
    let finalSquad = (myFaction === 'p1') ? p1Party : p2Party;
    
    // Emit selection to server referee architecture
    socket.emit('deploy-squad', { faction: myFaction, party: finalSquad });

    // Lock down user buttons and update text to waiting state
    document.getElementById('to-battle-btn').disabled = true;
    document.getElementById('to-battle-btn').innerText = "Waiting for opponent to finish drafting...";
    document.getElementById('hire-party-btn').disabled = true;
    document.getElementById('reroll-party-btn').disabled = true;
}

// ==================== MATRIX CORE COMBAT MECHANICS INTERFACE MAPS ====================
function disableInputs(selector, state) {
    document.querySelectorAll(selector).forEach(el => el.disabled = state);
}

function initializeMatchUI() {
    renderRoster(p1Party, 'p1-roster');
    renderRoster(p2Party, 'p2-roster');
    createGridBoard();
    document.getElementById('log').innerHTML = "Grid online. Select your destination targets matching current directives.";
}

function handleCellClick(x, y) {
    if (!matchActive || myFaction === 'spectator') return;
    let homeX = (myFaction === 'p1') ? p1X : p2X;
    let homeY = (myFaction === 'p1') ? p1Y : p2Y;

    let orderType = document.getElementById(`${myFaction}-order`).value;
    const distances = { 'Seek': 1, 'Advance': 2, 'March': 3 };
    let maxCapacity = distances[orderType];

    let existingIndex = selectedPath.findIndex(cell => cell.x === x && cell.y === y);
    if (existingIndex !== -1) {
        selectedPath = selectedPath.slice(0, existingIndex);
        createGridBoard();
        return;
    }

    if (selectedPath.length >= maxCapacity) return;

    let anchorX = (selectedPath.length === 0) ? homeX : selectedPath[selectedPath.length - 1].x;
    let anchorY = (selectedPath.length === 0) ? homeY : selectedPath[selectedPath.length - 1].y;

    let distance = Math.abs(x - anchorX) + Math.abs(y - anchorY);
    if (distance !== 1) return;

    selectedPath.push({ x: x, y: y });
    createGridBoard();
}

function clearSelectedPaths() {
    selectedPath = [];
    createGridBoard();
}

function createGridBoard() {
    const board = document.getElementById('map-board');
    board.innerHTML = '';
    for(let y=0; y<6; y++) {
        for(let x=0; x<6; x++) {
            let cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.setAttribute('onclick', `handleCellClick(${x},${y})`);
            cell.innerText = `(${x},${y})`;

            let isPathTile = selectedPath.some(c => c.x === x && c.y === y);
            if (isPathTile) cell.classList.add(`${myFaction}-path-select`);

            if(x === p1X && y === p1Y && p1Party.length) cell.innerHTML = '<div class="p1-unit">P1</div>';
            else if(x === p2X && y === p2Y && p2Party.length) cell.innerHTML = '<div class="p2-unit">P2</div>';
            board.appendChild(cell);
        }
    }
}

function renderRoster(party, id) {
    const el = document.getElementById(id);
    if (!party.length) { el.innerHTML = "<span style='color:#ff3333;'>WIPED OUT</span>"; return; return; }
    el.innerHTML = party.map(h => `<div class="hero-chip"><b>${h.role}</b> (❤${h.hp}/${h.baseHp})</div>`).join('');
}

function lockAndSubmitOrders() {
    if(myFaction === 'spectator') return;
    let order = document.getElementById(`${myFaction}-order`).value;
    socket.emit('submit-turn', { faction: myFaction, order: order, path: selectedPath });
    document.getElementById('lock-btn').disabled = true;
    document.getElementById('lock-btn').innerText = "AWAITING OPPONENT MOVE LOCK...";
}

// ==================== DISTRIBUTED SIMULTANEOUS RESOLUTION LOOPS ====================
socket.on('resolve-round', (moves) => {
    const logBox = document.getElementById('log');
    if (!matchActive) return;

    logBox.innerHTML += `<br><b>=== PHASE-BASED ENGINE RESOLUTION (ROUND ${currentRound}) ===</b><br>`;

    let p1PathArr = moves.p1.path || [];
    let p2PathArr = moves.p2.path || [];

    const movePriorityMap = { 'Seek': 1, 'Advance': 2, 'March': 3 };
    let p1MovePriority = movePriorityMap[moves.p1.order];
    let p2MovePriority = movePriorityMap[moves.p2.order];

    function processPlayerMovementSolo(playerLabel, pathArr, myCurrentPos, opponentPos) {
        let currentPos = { ...myCurrentPos };
        for (let step = 0; step < pathArr.length; step++) {
            let target = pathArr[step];
            if (target.x === opponentPos.x && target.y === opponentPos.y) {
                logBox.innerHTML += `<span class="clash-text"> -> [Collision] ${playerLabel} blocked at (${currentPos.x},${currentPos.y}) by opponent!</span><br>`;
                break;
            }
            currentPos = { x: target.x, y: target.y };
            logBox.innerHTML += ` -> ${playerLabel} Step ${step + 1}: Moved to (${currentPos.x},${currentPos.y})<br>`;
        }
        return currentPos;
    }

    if (p1MovePriority < p2MovePriority) {
        logBox.innerHTML += `<i>Movement Priority: P1 (${moves.p1.order}) moves before P2 (${moves.p2.order})</i><br>`;
        let p1Final = processPlayerMovementSolo('P1', p1PathArr, {x: p1X, y: p1Y}, {x: p2X, y: p2Y});
        p1X = p1Final.x; p1Y = p1Final.y;
        let p2Final = processPlayerMovementSolo('P2', p2PathArr, {x: p2X, y: p2Y}, {x: p1X, y: p1Y});
        p2X = p2Final.x; p2Y = p2Final.y;
    } 
    else if (p2MovePriority < p1MovePriority) {
        logBox.innerHTML += `<i>Movement Priority: P2 (${moves.p2.order}) moves before P1 (${moves.p1.order})</i><br>`;
        let p2Final = processPlayerMovementSolo('P2', p2PathArr, {x: p2X, y: p2Y}, {x: p1X, y: p1Y});
        p2X = p2Final.x; p2Y = p2Final.y;
        let p1Final = processPlayerMovementSolo('P1', p1PathArr, {x: p1X, y: p1Y}, {x: p2X, y: p2Y});
        p1X = p1Final.x; p1Y = p1Final.y;
    } 
    else {
        logBox.innerHTML += `<i>Simultaneous Movement: Both factions executing ${moves.p1.order} step-by-step</i><br>`;
        for (let step = 0; step < 3; step++) {
            let moved = false;
            let p1Target = p1PathArr[step] || { x: p1X, y: p1Y };
            let p2Target = p2PathArr[step] || { x: p2X, y: p2Y };

            if (step < p1PathArr.length) {
                if (p1Target.x === p2X && p1Target.y === p2Y) {
                    logBox.innerHTML += `<span class="clash-text"> -> [Collision] P1 blocked at (${p1X},${p1Y})!</span><br>`;
                    p1PathArr = [];
                } else { p1X = p1Target.x; p1Y = p1Target.y; moved = true; }
            }

            if (step < p2PathArr.length) {
                if (p2Target.x === p1X && p2Target.y === p1Y) {
                    logBox.innerHTML += `<span class="clash-text"> -> [Collision] P2 blocked at (${p2X},${p2Y})!</span><br>`;
                    p2PathArr = [];
                } else { p2X = p2Target.x; p2Y = p2Target.y; moved = true; }
            }

            if (moved) logBox.innerHTML += ` -> Step ${step + 1}: P1 at (${p1X},${p1Y}) | P2 at (${p2X},${p2Y})<br>`;
        }
    }

    let finalDist = Math.abs(p1X - p2X) + Math.abs(p1Y - p2Y);
    logBox.innerHTML += `<i>Movement Complete. Final Distance: ${finalDist} tiles.</i><br>`;

    if (finalDist === 2 && p1Party.length > 0 && p2Party.length > 0) {
        logBox.innerHTML += `<br><b>[RANGED COMBAT PHASE]</b><br>`;
        let p1CanShoot = (moves.p1.order !== 'March');
        let p2CanShoot = (moves.p2.order !== 'March');
        let p1Dmg = p1CanShoot ? getPartyRangedOutput(p1Party) : 0;
        let p2Dmg = p2CanShoot ? getPartyRangedOutput(p2Party) : 0;

        if (moves.p1.order === moves.p2.order) {
            logBox.innerHTML += `<i>Simultaneous Volleys (No initiative bonus)</i><br>`;
            if (p1Dmg > 0) p2Party = applySpilloverDamage(p2Party, p1Dmg, logBox, 'P2');
            if (p2Dmg > 0) p1Party = applySpilloverDamage(p1Party, p2Dmg, logBox, 'P1');
        } 
        else if (moves.p1.order === 'Seek' || (moves.p1.order === 'Advance' && moves.p2.order === 'March')) {
            let boostedP1Dmg = Math.round(p1Dmg * 1.2);
            logBox.innerHTML += `<i>Ranged Initiative: P1 fires first with a +20% Ambush Buff!</i><br>`;
            if (boostedP1Dmg > 0) p2Party = applySpilloverDamage(p2Party, boostedP1Dmg, logBox, 'P2');
            if (p2Dmg > 0 && p2Party.length > 0) p1Party = applySpilloverDamage(p1Party, p2Dmg, logBox, 'P1');
        } 
        else {
            let boostedP2Dmg = Math.round(p2Dmg * 1.2);
            logBox.innerHTML += `<i>Ranged Initiative: P2 fires first with a +20% Ambush Buff!</i><br>`;
            if (boostedP2Dmg > 0) p1Party = applySpilloverDamage(p1Party, boostedP2Dmg, logBox, 'P1');
            if (p1Dmg > 0 && p1Party.length > 0) p2Party = applySpilloverDamage(p2Party, p1Dmg, logBox, 'P2');
        }
    }

    if (finalDist === 1 && p1Party.length > 0 && p2Party.length > 0) {
        logBox.innerHTML += `<br><span class="clash-text"><b>[MELEE COMBAT PHASE]</b></span><br>`;
        const meleeRules = { 'Seek': 1, 'Advance': 2, 'March': 3 };
        let p1MeleeInit = meleeRules[moves.p1.order];
        let p2MeleeInit = meleeRules[moves.p2.order];
        let p1Dmg = getPartyMeleeOutput(p1Party);
        let p2Dmg = getPartyMeleeOutput(p2Party);

        if (p1MeleeInit === p2MeleeInit) {
            logBox.innerHTML += `<i>Simultaneous Melee Clashes (No initiative bonus)</i><br>`;
            let p2Survivors = applySpilloverDamage(p2Party, p1Dmg, logBox, 'P2');
            let p1Survivors = applySpilloverDamage(p1Party, p2Dmg, logBox, 'P1');
            p1Party = p1Survivors; p2Party = p2Survivors;
        } 
        else if (p1MeleeInit < p2MeleeInit) {
            let boostedP1Dmg = Math.round(p1Dmg * 1.2);
            logBox.innerHTML += `<i>Melee Initiative: P1 strikes first with a +20% Momentum Buff!</i><br>`;
            p2Party = applySpilloverDamage(p2Party, boostedP1Dmg, logBox, 'P2');
            if (p2Party.length > 0) {
                let currentP2Dmg = getPartyMeleeOutput(p2Party);
                p1Party = applySpilloverDamage(p1Party, currentP2Dmg, logBox, 'P1');
            }
        } 
        else {
            let boostedP2Dmg = Math.round(p2Dmg * 1.2);
            logBox.innerHTML += `<i>Melee Initiative: P2 strikes first with a +20% Momentum Buff!</i><br>`;
            p1Party = applySpilloverDamage(p1Party, boostedP2Dmg, logBox, 'P1');
            if (p1Party.length > 0) {
                let currentP1Dmg = getPartyMeleeOutput(p1Party);
                p2Party = applySpilloverDamage(p2Party, currentP1Dmg, logBox, 'P2');
            }
        }
    }

    clearSelectedPaths();
    
    if (!p1Party.length && !p2Party.length) { logBox.innerHTML += "<br>=== MUTUAL TOTAL ANNIHILATION ==="; matchActive = false; }
    else if (!p1Party.length) { logBox.innerHTML += "<br>=== PLAYER 2 WINS THE MATCH! ==="; matchActive = false; }
    else if (!p2Party.length) { logBox.innerHTML += "<br>=== PLAYER 1 WINS THE MATCH! ==="; matchActive = false; }

    if (!matchActive) {
        document.getElementById('lock-btn').disabled = true;
        document.getElementById('lock-btn').innerText = "MATCH CONCLUDED";
    } else {
        currentRound++;
        if (currentRound > 4) {
            logBox.innerHTML += "<br><b>=== REACHED MATCH LIMIT ROUND 4 ===</b>";
            matchActive = false;
            document.getElementById('lock-btn').disabled = true;
            document.getElementById('lock-btn').innerText = "MATCH OVER";
        } else {
            document.getElementById('round-indicator').innerText = `Round: ${currentRound} / 4`;
            if (myFaction !== 'spectator') {
                document.getElementById('lock-btn').disabled = false;
                document.getElementById('lock-btn').innerText = "LOCK IN ORDERS FOR THIS ROUND";
            }
        }
    }
    renderRoster(p1Party, 'p1-roster'); renderRoster(p2Party, 'p2-roster');
    createGridBoard();
    logBox.scrollTop = logBox.scrollHeight;
});