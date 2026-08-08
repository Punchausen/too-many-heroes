# 02. TOWN & ECONOMY SPECIFICATION

## 2.1 Player State Schema (Server Ground Truth)
The server tracks player session state using the following template:

<pre>
{
  "playerId": "string",
  "playerName": "string",
  "gold": 100,
  "town": {
    "castleTier": 1,
    "tavernTier": 0
  },
  "parties": [
    { "id": "party_1", "name": "Alpha Squad", "heroIds": ["peasant_1", "elf_1"] }
  ],
  "activeQuest": null
}
</pre>

## 2.2 Economy & Building Logic

### Castle (Management & Quests)
- Initial State: Unlocked at Tier 1.
- Max Party Slots Formula: Max Slots = Castle Tier + 1 (Tier 1 = 2 Parties).
- Upgrade Costs:
  - Tier 2 Upgrade: 150 Gold (Unlocks Slot 3 + Medium Quests).
  - Tier 3 Upgrade: 300 Gold (Unlocks Slot 4 + Boss Quests).

### Tavern (Hero Recruitment)
- Initial State: Locked (Tier 0).
- Construction Cost: 50 Gold (Unlocks Tier 1 Tavern).
- Recruitment Pools by Tier:
  - Tier 1: Peasants (20 Gold), Elves (35 Gold).
  - Tier 2: Knights (60 Gold), Wizards (80 Gold).
  - Tier 3: Elite Champions (150 Gold).

## 2.3 Quest Selection Rules
- Quests are presented on the Castle Mission Board.
- Quests require selecting an available Party before launching into TACTICAL_ARENA.
- Rewards: Yield defined Gold payouts and XP upon Victory.