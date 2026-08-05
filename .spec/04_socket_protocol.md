# 04. SOCKET PROTOCOL SPECIFICATION

## 4.1 Client -> Server Events
- `JOIN_GAME`: `{ playerName: string, roomCode: string }`
- `BUILD_STRUCTURE`: `{ buildingType: "tavern" | "castle" }`
- `UPGRADE_STRUCTURE`: `{ buildingType: "tavern" | "castle" }`
- `RECRUIT_HERO`: `{ heroTemplateId: string, partyId: string }`
- `LAUNCH_QUEST`: `{ questId: string, partyId: string }`
- `SUBMIT_STANCE`: `{ stance: "seek" | "advance" | "march" }`
- `NAVIGATE_TO`: `{ targetRoom: "TOWN_HQ" | "TAVERN" | "CASTLE" }`[cite: 4]
- `RETURN_TO_HQ`: `{}`[cite: 4]

## 4.2 Server -> Client Events
- `STATE_SYNC`: Emits full updated player state and current room state.
- `ROOM_TRANSITION`: `{ newState: "TOWN_HQ" | "TACTICAL_ARENA" | "GAME_OVER" }`
- `COMBAT_ROUND_RESULT`: `{ log: array, updatedSquads: array }`
- `GAME_OVER_SUMMARY`: `{ result: "VICTORY" | "DEFEAT", goldEarned: number }`
- `NAVIGATE_TO`: `{ targetRoom: "TOWN_HQ" | "TAVERN" | "CASTLE" }`[cite: 4]
- `RETURN_TO_HQ`: `{}`[cite: 4]

## 4.3 Protocol Constraints
- The client must treat server state as read-only. UI elements render exclusively from `STATE_SYNC` payloads.