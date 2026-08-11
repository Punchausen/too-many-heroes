# TOO MANY HEROES - GAME SYSTEM SPECIFICATION
*Version 1.0 - Core Engine Architecture & Tactical Rules*

---

## 1. System Architecture Principles

1. **Single Source of Truth:** 
   - `server.js` executes all combat math, state changes, initiative checks, and movement processing.
   - `client.js` is a visual display layer that simply renders what the server sends via Socket.io.

2. **Refactoring & Patch Protocol:**
   - No code refactoring unless explicitly requested.
   - Code updates must be delivered as targeted diffs or surgical function replacements.
   - All state changes must preserve preexisting networking parameters and global state variables.
   - **Enforcement:** Cursor agents must follow `.cursor/rules/surgical-patch-protocol.mdc` and `AGENTS.md` (plain-English guide for novice developers).

---

## 2. Unit Roster & Stat Matrices

### Class Templates
- **Peasant:** 30 Base HP | 10 Melee | 0 Range
- **Barbarian:** 100 Base HP | 40 Melee | 0 Range
- **Elf:** 50 Base HP | 15 Melee | 25 Range
- **Wizard:** 40 Base HP | 10 Melee | 35 Range
- **Knight:** 120 Base HP | 25 Melee | 0 Range

### Roster Rules
- Squads consist of up to 4 units selected during the Tavern/Draft phase.
- Unit health pools track `hp` (current) and `baseHp` (maximum baseline).

---

## 3. Movement & Initiative Rules

1. **Directive Orders & Movement Capacity:**
   - **Seek:** Maximum 1 cell path movement. Initiative Rank = 1 (Highest).
   - **Advance:** Maximum 3 cells path movement. Initiative Rank = 2.
   - **March:** Maximum 5 cells path movement. Initiative Rank = 3 (Lowest).

2. **Initiative Resolution Hierarchy:**
   - Actions occur sequentially based on order initiative (`Seek` > `Advance` > `March`).
   - If both players select the **same** Directive Order, actions and damage resolve **simultaneously**.

---

## 4. Combat Engagement Rules

### 4.1. Timing & Proximity
- Combat is evaluated **AFTER** all movement paths have completely finished resolving.
- Distance is computed via Manhattan/Taxicab grid metric: `|x1 - x2| + |y1 - y2|`.

### 4.2. Ranged Combat Phase (Grid Distance = 2)
1. **Activation:** Initiated only when warbands end movement exactly 2 squares apart.
2. **Eligibility:** Only units with a `range > 0` attribute contribute damage.
3. **March Penalty:** Any warband using a `March` order **cannot** deal ranged damage (too focused on fast movement).
4. **Initiative Execution:**
   - The team with higher initiative fires first.
   - Damage is applied instantly to the target party.
   - **Dynamic Recalculation:** The team fighting second recalculates its ranged power using **ONLY surviving units** before returning fire.

### 4.3. Melee Combat Phase (Grid Distance = 1)
1. **Activation:** Initiated when warbands end movement exactly 1 square apart (adjacent).
2. **Damage Pool:** **ALL** active units in the warband contribute to melee output (`melee + range`).
3. **Surprise Advantage Buff:** The warband winning initiative receives a **+20% damage multiplier** (`Math.floor(power * 1.2)`).
4. **Initiative Execution:**
   - The team with initiative strikes first with the +20% buff.
   - **Dynamic Recalculation:** The team fighting second recalculates its melee power using **ONLY surviving units** before counter-striking.
   - Counter-strikes do **NOT** receive the 20% surprise buff.

---

## 5. Spillover Damage & Tanking Allocation

1. **Highest Base Health Allocation:**
   - Incoming damage is dealt to the surviving unit with the **highest `baseHp`** in the party array, regardless of current row position or class.
2. **Spillover Loop:**
   - If incoming damage exceeds the target unit's remaining `hp`, the unit falls unconscious (`hp = 0`).
   - Any leftover/overflow damage "spills over" into the surviving unit with the *next highest base HP*.
   - Loop continues until incoming damage pool drops to 0 or all units in the party are knocked out.