# 01. GAME LOOP & STATE MACHINE SPECIFICATION

## 1.1 Overview
This document defines the overarching state machine for "Too Many Heroes" Milestone 1. The application must transition strictly between 6 operational states.

## 1.2 State Machine Graph
[1. LANDING] -> [2. TOWN_HQ] -> [3. TAVERN] / [4. CASTLE] -> [5. TACTICAL_ARENA] -> [6. GAME_OVER]

## 1.3 State Definitions & Entry Criteria
1. LANDING: Default state upon client connection. User inputs Player Name and creates/joins a Room Code.
2. TOWN_HQ: The main hub. Displays player Gold balance and clickable structures (Castle, Tavern, Mission Board).
3. TAVERN: Sub-state of HQ. Renders draftable hero candidates.
4. CASTLE: Sub-state of HQ. Renders unlocked party slots and available Quest missions.
5. TACTICAL_ARENA: Triggered when a Quest is launched from the Castle. Executes turn-based combat on the grid.
6. GAME_OVER: Triggered when combat concludes (Squad HP hits 0 or Victory condition met). Calculates Gold payouts and routes back to TOWN_HQ.

## 1.4 State Guardrails
- State transitions MUST originate from the server.
- The client cannot jump directly from LANDING to TACTICAL_ARENA without active player state validation.

## 1.5 Sub-State Navigation Rules
- Room navigation between sub-states (`TOWN_HQ`, `TAVERN`, `CASTLE`) is bi-directional using the `NAVIGATE_TO` socket event[cite: 1, 3].
- `TAVERN` and `CASTLE` screens MUST provide explicit UI controls returning directly to `TOWN_HQ`[cite: 3].
- `TACTICAL_ARENA` can ONLY be entered from `CASTLE` via `LAUNCH_QUEST`[cite: 1, 3].
- While in `TACTICAL_ARENA`, room navigation is locked until combat completes (`COMBAT_END`)[cite: 3, 5].
- `GAME_OVER` displays match outcomes and provides a `RETURN_TO_HQ` action back to `TOWN_HQ`[cite: 1, 3].

## 1.6 DOM Container Screen Map
The client interface consists of 6 primary container elements. Only the element corresponding to the active server room state shall be displayed:
- `#screen-landing` -> [1. LANDING][cite: 3]
- `#screen-town-hq` -> [2. TOWN_HQ][cite: 3]
- `#screen-tavern` -> [3. TAVERN][cite: 3]
- `#screen-castle` -> [4. CASTLE][cite: 3]
- `#screen-tactical-arena` -> [5. TACTICAL_ARENA][cite: 3]
- `#screen-game-over` -> [6. GAME_OVER][cite: 3]