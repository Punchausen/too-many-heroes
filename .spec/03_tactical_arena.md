# 03. TACTICAL ARENA & COMBAT SPECIFICATION

## 3.1 Grid Architecture
- Board Dimensions: 8x8 Tile Matrix.
- Position Schema: `{ x: integer [0-7], y: integer [0-7] }`.

## 3.2 Turn Lifecycle & Initiative Engine
Each round resolves in 3 strict phases:
1. PLANNING PHASE: Players select squad stances (Seek / Advance / March).
2. INITIATIVE ORDER: Speed calculations determine squad turn execution.
3. RESOLUTION PHASE: Actions executed, range checks performed, damage calculated.

## 3.3 Combat & Damage Math
- Ranged Engagement: Executed if Grid Distance > 1. Checks Line of Sight.
- Melee Engagement: Executed if Grid Distance == 1.
- Highest Base HP Spillover Rule:
  - When a squad takes damage, damage is subtracted from the unit with the HIGHEST current Base HP first.
  - Excess damage carries over to the next highest unit until squad total damage is allocated.

## 3.4 Victory & Defeat Conditions
- VICTORY: All enemy squad unit HPs reach 0.
- DEFEAT: All player squad unit HPs reach 0.
- Trigger State transition to GAME_OVER immediately upon condition check.
📄 File 4: .spec/04_socket_protocol.md
Markdown
# 04. SOCKET PROTOCOL SPECIFICATION

## 4.1 Client -> Server Events
- `JOIN_GAME`: `{ playerName: string, roomCode: string }`
- `BUILD_STRUCTURE`: `{ buildingType: "tavern" | "castle" }`
- `UPGRADE_STRUCTURE`: `{ buildingType: "tavern" | "castle" }`
- `RECRUIT_HERO`: `{ heroTemplateId: string, partyId: string }`
- `LAUNCH_QUEST`: `{ questId: string, partyId: string }`
- `SUBMIT_STANCE`: `{ stance: "seek" | "advance" | "march" }`

## 4.2 Server -> Client Events
- `STATE_SYNC`: Emits full updated player state and current room state.
- `ROOM_TRANSITION`: `{ newState: "TOWN_HQ" | "TACTICAL_ARENA" | "GAME_OVER" }`
- `COMBAT_ROUND_RESULT`: `{ log: array, updatedSquads: array }`
- `GAME_OVER_SUMMARY`: `{ result: "VICTORY" | "DEFEAT", goldEarned: number }`

## 4.3 Protocol Constraints
- The client must treat server state as read-only. UI elements render exclusively from `STATE_SYNC` payloads.