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