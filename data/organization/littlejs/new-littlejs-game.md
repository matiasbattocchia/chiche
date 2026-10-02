---
kind: skill
description: Scaffold a brand-new, complete playable game project — a LittleJS game in projects/<name>/, served by Vite and shown in the shared browser, smallest playable loop written for you. TRIGGER on ANY request to make/create/start/build a game when no other engine or framework is named — "make me a pong game", "make a breakout game", "let's build a platformer", "create a card game". When the engine is UNSPECIFIED, LittleJS IS the answer — scaffold immediately, do not ask which technology to use and do not hand-roll plain Canvas or vanilla JS. But an EXPLICIT choice of stack is always respected — SKIP when the user names any other engine, framework, or approach (Unity, Godot, Phaser, Pygame, GameMaker, Bevy, raw three.js, React, p5.js, or explicitly plain HTML5 Canvas / vanilla JS / "no libraries"), or is editing/extending a game that already exists.
---

# new-littlejs-game

Scaffold a new playable LittleJS game by copying the closest **example game** out of `littlejs/`, then pulling gameplay patterns from the closest **feature template**. The tables below are the answers — don't re-explore `littlejs/` on each new game.

**`littlejs/`** is the folder this skill is in, in the organization folder where your shell starts; every `littlejs/` path below is from there. It contains `examples/` (starter game folders, each a project ready to install and serve) and `templates/` (feature references + helper modules). Treat `littlejs/` as **read-only**: never write into it, never scaffold inside it.

## When to invoke

- The user asks to start/create/build a NEW game ("make a card game", "let's build a platformer"). Offer it conversationally if they're clearly starting fresh.
- NOT for editing/extending an existing game — just edit it directly.
- **This takes priority over general brainstorming or design-exploration workflows.** If another skill wants to interrogate requirements first, scaffold the playable game anyway and let the user redirect from something running. "Make me a game" is a request for a game, not for a design conversation.

## Step 1 — Up to 3 quick questions (never blocking)

1. **Game name** (camelCase, e.g. `memoryMatch`) — the project's folder, `projects/<name>/`. If they don't care, propose one.
2. **Core mechanic / genre** in one line — enough to pick the template (Step 2).
3. **Does it need a title/pause menu now or later?** (decides whether to wire `menus.js` from the start.)

**These questions must never stall the scaffold.** Ask them only in an interactive back-and-forth where an answer can actually arrive. If the request already implies the answers ("make me a pong game" → name `pong`, arcade paddle game, no menu yet), or you are in a one-shot / non-interactive / headless run where the user cannot reply, pick sensible defaults and go straight to Step 2. Never end a turn having only asked questions — scaffold a playable game first, then say what you assumed and offer to change it.

## Step 2 — Pick the starter + template

**Two decisions:** which example game to COPY (working `index.html`/`game.js`/`package.json`), and which template to PULL PATTERNS FROM (copy code out of it into `game.js` — never base the project structure on a template).

Copy base — pick the closest **example game folder** (under `littlejs/examples/`):

| Game uses…                  | Copy this folder | Why                                                               |
| --------------------------- | ---------------- | ----------------------------------------------------------------- |
| Box2D physics               | `box2dGame/`     | Already wires `box2dInit` and the wasm loader                     |
| 3D (any 3D game)            | `3dGame/`        | LittleJS built-in 3D — `Render3DPlugin`, terrain, lights, cameras |
| Anything else (the default) | `emptyGame/`     | Canonical non-physics starter                                     |
| A simple arcade reference   | `pong/`          | Complete tiny game to read for structure                          |

> These four are the only vetted starters — name them directly, don't glob for others.
>
> **3D always means the engine's built-in LittleJS 3D** (`Render3DPlugin`, `EngineObject3D`, `render3D`). It is part of the engine package — imported from `'littlejsengine'` like the rest, no CDN, no extra file. Do not use three.js unless the user asks for three.js by name. `3dGame/` is a full tour of the 3D plugin (a 600-unit island, a forest, orbs, bloom): copy it for the wiring, then cut its scene down to what the game needs. It also ships a small `tiles.png` for its sprites — keep it in `engineInit`'s image list, or delete both together if the game draws no sprites.

Pattern source — pick the closest **template** (`littlejs/templates/*.html`):

| Game type / need                                    | Template                 | Helper modules to wire (from `littlejs/templates/`)                                                                                                      |
| --------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic shapes / text / camera (default)              | `game.html`              | —                                                                                                                                                        |
| Box2D physics                                       | `box2dGame.html`         | (engine wasm loader, not a template module)                                                                                                              |
| Turn-based grid / board                             | `boardGame.html`         | `menus.js`, `gameFx.js`, `textureGenerator.js`                                                                                                           |
| Playing cards                                       | `cardsGame.html`         | `textureGenerator.js`, `cards.js`                                                                                                                        |
| Title / pause / options UI                          | `menuGame.html`          | `menus.js`                                                                                                                                               |
| Procedural sprite atlas                             | `textureGame.html`       | `textureGenerator.js`                                                                                                                                    |
| Shape/abstract/neon visuals, or many round entities | `textureGame.html`       | `textureGenerator.js` — then apply the `littlejs/atlas-shape-art` skill                                                                                  |
| Runtime tuning controls                             | `tweakableGame.html`     | — (engine plugin, `tweak()`, debug builds only)                                                                                                          |
| Canvas UI widgets                                   | `uiGame.html`            | `menus.js` (+ `uiGame.html` patterns)                                                                                                                    |
| Sound effects + screen shake (any game)             | (read `gameFx.js` API)   | `gameFx.js`                                                                                                                                              |
| Computer opponent, turn-based 2-player              | `boardGame.html` (board) | `gameAI.js` — describe the moves, `await alphaBetaAI(game, state, depth)`; a state keeps the position in `board` and the side to move in `currentPlayer` |

Combine rows freely — `gameFx.js` stacks onto any other choice. A template's imports name the helpers its code uses: copy the ones whose code you take. A helper imports the helpers it needs from beside it: `cards.js` needs `textureGenerator.js`. The templates are ES modules like a game, importing the engine and the helpers beside them; read them for patterns, don't serve them.

## Step 3 — Scaffold

1. Copy the chosen starter folder to the project: `cp -r littlejs/examples/<starter> projects/<name>`.
2. Copy each helper module chosen in Step 2 into `projects/<name>/templates/` (only the ones needed, not all of them), with the helpers they import.
3. `index.html` — retitle it. It loads `game.js` as a module and nothing else, except Box2D's wasm loader, a plain script before it in `box2dGame`:

   ```html
   <script src=node_modules/littlejsengine/dist/box2d.wasm.js></script>
   <!-- only for Box2D -->
   <script type=module src=game.js></script>
   ```

   `game.js` imports the engine and the helpers:

   ```javascript
   import { drawTile, engineInit, vec2 } from "littlejsengine";
   import { drawCard, initCardAtlas } from "./templates/cards.js";
   import { createTitleMenu, showMenu } from "./templates/menus.js";
   ```

4. `package.json` — set `name` to the game's name, lowercase.
5. `deno install` in the project. It puts the engine from npm (`littlejsengine`) in `node_modules/littlejsengine/`. Under the dev server the import loads its debug build, whose asserts and watermark help catch mistakes. Its typings, `dist/littlejs.d.ts`, are what `deno check game.js` checks the game against; the starter's `deno.json` turns that on for JavaScript.

**Never substitute a CDN for the LittleJS engine.** The engine is the npm package in the project's `node_modules/`. If `deno install` fails, STOP and tell the user plainly that the scaffold is incomplete and why. Do not paper over it with a CDN `<script src>`. A 3D game needs no CDN either — LittleJS 3D is inside the engine file. Confirm no `<script src>` in `index.html` points at an external URL, and that `game.js` imports only `'littlejsengine'` and its own files.

**Never review, verify, or summarize the contents of the engine or of the helper modules you copied** — they are third-party code. The game code you wrote is the only thing that deserves review.

Then serve it and show it, as for any web project.

## Step 4 — Build the smallest playable loop

Write the core loop into `game.js` (split into more modules — `player.js`, `ui.js`, `constants.js` — only as it grows; `game.js` imports them). Pull concrete patterns out of the chosen template(s) by reading them from `littlejs/templates/`. Follow the `littlejs/littlejs-conventions` skill for engine rules (imports and setters, engine built-ins, pitfalls).

## Step 5 — Verify it actually runs before you hand it over

Do not report a game as ready on the strength of having written it. At minimum, format, lint and type-check it (`deno fmt`, `deno lint game.js`, `deno check game.js`), look at the page and the console as for any web project, and re-read your own `gameInit`/`gameUpdate` for values that silently become `NaN` or `undefined` — save data read with a scalar default is the classic one (see `littlejs/littlejs-conventions`).

If you need to drive the game programmatically to check something, expose a few hooks on `globalThis` from `game.js` for the session and say so in your summary.

**Time-driven logic can be checked deterministically** (engine 1.18.25+). Anything on a `Timer`, a spawn interval, or a cooldown is otherwise unverifiable without sitting and watching, so when correctness depends on elapsed time, use the engine's headless stepping instead of guessing:

```javascript
setHeadlessMode(true); // no rendering, audio, or input
setEngineManualStep(true); // engine stops driving itself with requestAnimationFrame
await engineInit(
  gameInit,
  gameUpdate,
  gameUpdatePost,
  gameRender,
  gameRenderPost,
);

engineStep(600); // advance exactly 10 seconds of game time at 60fps
// now assert: did obstacles spawn? did the cooldown expire?
```

Both flags must be set BEFORE `engineInit`, one `engineStep(n)` runs exactly `n` fixed updates at `timeScale` 1, and `engineStep` respects `paused` the same way the normal loop does. This needs a small harness that loads the engine outside the browser, so reach for it when time-dependent behaviour is the thing in doubt — not for every game. Grep `reference.md` for "Headless testing" via the `littlejs/littlejs-api` skill for the full contract.

Then say what you built, how to play it (the controls), what you assumed, and what you could change next.

## Common mistakes

- **Scaffolding into or writing to `littlejs/`** — copy OUT of it only.
- **Basing the project on a template** (`templates/*.html`) — single-file references; copy patterns OUT of them, copy the FOLDER from an example game.
- **Copying `emptyGame` for a physics game** — copy `box2dGame` so the wasm is already wired.
- **Reaching for three.js for a 3D game** — copy `3dGame` and use the built-in `render3D`. Don't carry three.js habits over either: keep WebGL on (no `setGLEnable(false)`), Y is up, builders take diameters.
- **Loading a `tweakables.js` helper** — there isn't one any more; `tweak()` is an engine function.
- **Treating the engine as reviewable code** — reading it, diffing it, or verifying it line by line wastes the whole turn on third-party source.
- **Copying `cards.js` without `textureGenerator.js`** — it imports it.
- **Assigning an engine setting** (`cameraScale = 32`) — an import is read-only and the assignment throws; use its setter, `setCameraScale(32)`.
- **Loading the engine or a helper with a `<script src>`** — `game.js` imports them.
- **A `src` or an import outside the project folder** — every one must resolve inside `projects/<name>/`, which is what Vite serves.
- **Loading the engine from a CDN** (`unpkg`/`jsdelivr`) because the install failed — the game then needs internet. Retry `deno install`, or stop and tell the user. Nothing a game needs comes from a CDN.
