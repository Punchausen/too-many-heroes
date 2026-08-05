# Too Many Heroes — Agent Guide (Plain English)

This file tells AI coding assistants (and humans) **how we change this project**.

## What this game is

A two-player tactical game. Players meet in a town hub, recruit heroes, then fight on a grid. The browser shows the game; the Node server decides what is true.

## The golden rule: surgical patches

Think of the codebase like a working car engine.

- **Surgical patch** = replace one worn part (one function, one handler).
- **Full rewrite** = rebuild the whole engine “because it would be nicer.” We do **not** do that unless Michael asks.

### Checklist before every edit

1. Will this break initiative, the +20% surprise buff, or the March ranged penalty?
2. Will counter-attacks still use **only units that are still alive**?
3. Am I changing only what I need, and leaving Socket.io events alone?

If all three are yes → proceed with a small, targeted change.

## Who owns what

| File | Job |
|------|-----|
| `server.js` | Brain. Combat, movement, gold, room transitions. |
| `public/js/client.js` | Eyes and hands. Draws the screen; sends player clicks to the server. |
| `.spec/*.md` | Written rules of the game (source of truth for design). |
| `.cursor/rules/*.mdc` | Rules the AI must follow while coding. |

## How to talk to the novice developer

- Explain changes in plain English first, then show the small code patch.
- Prefer comments that say **what this block does** and **why it matters**.
- Do not dump jargon without a short translation.

## Spec map (where to look)

- `.spec/00_game_specification.md` — architecture + combat core
- `.spec/01_game_loop_and_state.md` — screens / state machine
- `.spec/02_town_hq_and_economy.md` — gold, buildings, parties
- `.spec/03_tactical_arena.md` — arena / combat lifecycle
- `.spec/04_socket_protocol.md` — event names between client and server

## Root `game_specification.md`

That file is a compact copy of the architecture + code-output protocol. Prefer `.spec/00` and `.cursor/rules/` when they disagree; keep them aligned when you update rules.
