// CANVAS ROUTING ENGINE STATES
let currentScene = 'TITLE'; // Options: 'TITLE', 'TAVERN', 'ARENA'
let lobbyStatusText = { p1: 'DISCONNECTED', p2: 'DISCONNECTED', readyP1: false, readyP2: false };

// Visual UI layout bounds for mouse boundary collision detection
let uiButtons = {};

/* COMBAT BLUEPRINTS & MUTABLE STATE MANIFEST */
const HERO_TEMPLATES = {
    'Peasant':   { hp: 50,  melee: 10, range: 0 },  // Baseline starting class
    'Barbarian': { hp: 100, melee: 40, range: 0 },
    'Elf':       { hp: 40,  melee: 15, range: 25 },
    'Wizard':    { hp: 30,  melee: 10, range: 35 },
    'Knight':    { hp: 120, melee: 25, range: 0 }
};

let p1Party = [];
let p2Party = [];
let p1X = 0, p1Y = 2;
let p2X = 5, p2Y = 3;
let currentRound = 1;
let matchActive = true;
let selectedPath = [];

// TAVERN ENGINE STATE PROPERTIES (Local Client Tracking)
let playerGold = 100;
let currentTavernOffer = [];
let currentTavernCost = 0;

function generateFixedParty(rolesArray) {
    return rolesArray.map(r => ({
        role: r, hp: HERO_TEMPLATES[r].hp, baseHp: HERO_TEMPLATES[r].hp, melee: HERO_TEMPLATES[r].melee, range: HERO_TEMPLATES[r].range
    }));
}

// CRITICAL ADJUSTMENT: Initialize both commanders with default starting Peasants
p1Party = generateFixedParty(['Peasant', 'Peasant', 'Peasant', 'Peasant']);
p2Party = generateFixedParty(['Peasant', 'Peasant', 'Peasant', 'Peasant']);

/* PURE PRE-CALCULATED SPILLOVER DAMAGE APPLIER */
function applySpilloverDamage(party, totalDamage, logBox, label) {
    let remainingDmg = totalDamage;
    let tempParty = JSON.parse(JSON.stringify(party));

    while(remainingDmg > 0 && tempParty.length > 0) {
        tempParty.sort((a, b) => b.baseHp - a.baseHp);
        let tank = tempParty[0];

        if(tank.hp > remainingDmg) {
            tank.hp -= remainingDmg;
            logBox.innerHTML += `<span class="hit-text"> -> [${label}] ${tank.role} absorbs ${remainingDmg} damage (${tank.hp}/${tank.baseHp} HP left).</span><br>`;
            remainingDmg = 0;
        } else {
            remainingDmg -= tank.hp;
            logBox.innerHTML += `<span class="hit-text" style="color:#ff5555;"> -> [${label}] ${tank.role} absorbs ${tank.hp} damage and falls unconscious!</span><br>`;
            tempParty.shift();
        }
    }
    return tempParty;
}

function getPartyMeleeOutput(party) { return party.reduce((sum, hero) => sum + hero.melee, 0); }
function getPartyRangedOutput(party) { return party.reduce((sum, hero) => sum + hero.range, 0); }