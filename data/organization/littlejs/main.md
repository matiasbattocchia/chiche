---
kind: instruction
load: always
---

# Games

A game is a web project made with LittleJS, a small engine for 2D and 3D games in the browser.
When the user asks for a game and names no other engine or framework, make it with LittleJS.

Core goals

- Turn a game idea into a working LittleJS game quickly.
- Keep scope right-sized: get a fun playable core loop first, then expand.
- Work in short iterations. After each step, suggest the next small step.

A step is one change the user can see in the page: the starter running, a paddle that moves, a
ball that bounces, a score. Make it, check it, then end your turn: say what changed and suggest
the next step. Never stack steps in one turn, even when the next one is obvious: the user
watches the game grow and picks where it goes.

Everything for it is in `littlejs/`, in the organization folder. It is read-only: copy out of it,
never write into it.

- `littlejs/new-littlejs-game`: the skill for a new game, with which example to copy, which
  template to read patterns from, and the steps.
- `littlejs/littlejs-conventions`: read it before writing or changing LittleJS code. It has the
  imports and setters, the engine's built-ins, and the pitfalls that fail silently.
- `littlejs/littlejs-api`: look an engine name up in `littlejs/reference.md` instead of guessing
  its arguments.
- `littlejs/atlas-shape-art`: shapes and many round things, drawn as tinted tiles.
- `littlejs/examples/`: the starter projects. `littlejs/templates/`: pages to read patterns
  from, and the helper modules.

## How a game differs from other web projects

- It starts as a copy of a starter in `littlejs/examples/`, not from create-vite, and is served
  and shown like any web project.
- It is JavaScript ES modules: `game.js` at the project's root imports the engine from
  `'littlejsengine'` and the rest of the game's modules. Split it into modules (`player.js`,
  `ui.js`, `constants.js`) as it grows.
- Feedback: type check with `deno check game.js`, against the engine's typings (the starter's
  `deno.json` turns it on for JavaScript), and lint with `deno lint game.js` and the game's
  other modules. `deno task build` checks that it bundles; nothing serves its `dist/`, which
  leaves out the Box2D loader and the images `engineInit` loads. The helper modules in
  `templates/` are third-party: don't lint, check or review them.
- The page loads the engine's debug build: its watermark in the corner and the console warning
  "LittleJS DEBUG build loaded" are expected. While its overlay is open (Esc) it takes some
  keys: 1-8 debug views, 9 the tweakables panel, 0 the level editor, C the 3D free camera, +/-
  the time scale.
- Format with `deno fmt` in the project after each change. Everything in `littlejs/` except
  `reference.md` is already formatted the same way, so code copied from it stays as it is. Put
  a comment for each argument on its own line: the formatter splits long argument lists one per
  line.

## Building a game

- Ask only what blocks the work; otherwise start building.
- No other libraries unless the user asks for one. No external assets (images, sprite sheets,
  sound files) unless asked: draw with the engine and make sounds with ZzFX (`Sound`, or
  `SoundGenerator` from `gameFx.js`).
- Use what LittleJS has before writing your own: `keyDirection()` for arrows and WASD,
  `keyIsDown()` for other keys, `gamepadStick()`, `isOverlapping`, `screenToWorld` /
  `worldToScreen`, `isOnScreen`, `Timer`, the math shortcuts and `Vector2` methods,
  `TileCollisionLayer` with `collideWithTile(tileData, pos)` for tile collision.
- Persisted settings and stats go through `readSaveData` / `writeSaveData`.

## Helper modules

They are not part of the engine. To use one, copy it from `littlejs/templates/` into the
project's `templates/` folder and import from it. Grep the engine's `littlejs.d.ts` before
taking a name for engine API.

- `menus.js`: title, pause and options menus, dialogs, toolbars, toasts and medals; don't build
  DOM menus by hand. `createTitleMenu`, `createPauseMenu`, `createOptionsMenu`, `createMenu`,
  `createToolbar`, `showConfirmDialog`, `showAlertDialog`, `showGameOverDialog`, `MenuMedal`.
  Pause while a menu shows with `installAutoPause(() => isPlaying)` or
  `setMenuVisibilityCallback(v => setPaused(v))`, and call `bindPauseKey` in `gameUpdate` for
  Esc and Start. Its save data: `saveDataInit('GameName')` at the top of `gameInit`, before menus
  and medals, then `saveData` and the best-score helpers (`submitBestScore`, `getBestScore`).
  Options persist through a menu item's `persist:` key. `templates/menuGame.html` shows it all.
- `gameFx.js`: `SoundGenerator` for sound effects, and screen shake (`addScreenShake`).
- `textureGenerator.js`: sprites drawn into a texture atlas (`initDrawToTexture`,
  `drawToTexture`, `drawTextToTexture`), and `initDefaultAtlas` for 16 white shapes to tint.
- `cards.js`: a deck of playing cards, piles, dealing and undo. It imports
  `textureGenerator.js`.
- `gameAI.js`: a computer opponent for a turn-based two-player game. The game describes its moves
  and positions, and `await alphaBetaAI(game, state, depth)` picks a move. A state must keep the
  position in `board` and the side to move in `currentPlayer`: the search tells positions apart
  by those two fields only.

## Available features

What the engine has ready, to suggest as next steps: add one when the user picks it, and when
they do, use the engine's, never one of your own.

- 3D is built into the engine: `new Render3DPlugin;` at the top of `gameInit`, then
  `EngineObject3D`, meshes from builders, lights, shadows, fog and sky, terrain, 3D text,
  particles, cameras that orbit, follow or fly, and 3D sound. A request for 3D means LittleJS
  3D, never three.js unless the user names it. Grep `littlejs/reference.md` for a 3D feature
  before building it.
- Tuning while it runs: `tweak('name', {object: settings, min, max})` at the end of `gameInit`
  puts `settings.name` in the engine's tweakables panel (debug build only).
- Full-screen effects: `postProcessBloom(threshold, strength, size)` for glow, or
  `new PostProcessPlugin(postProcessEffects(postProcessGlow(), postProcessScanlines(),
  postProcessVignette()))`; `postProcessTV({...})` is an old TV in one piece. One post-process
  is active at a time, so combine effects with `postProcessEffects`.
- Ready-made particles: `particleEffect(name, pos, {scale, hue})`, or `particleEffect3D` in 3D,
  with fire, torch, smoke, steam, explosion, sparks, hit, dust, debris, sparkle, magic, heal,
  poison, portal, rain, snow, leaves, bubbles, fireflies, trail, muzzle, blood, confetti and
  splash. A `ParticleEmitter` only when none of these fits.
- Also in the engine: `ParallaxLayer`, lights, tweens, scenes, pathfinding and texture sheets.
  Check `littlejs/reference.md` before writing any of these.

## Pitfalls

- An engine setting is an import, and an import can't be assigned: `setCameraScale(32)`,
  `setGravity(...)`, `setPaused(true)`, never `cameraScale = 32`.
- `drawCircle` and `drawEllipse` take a diameter, not a radius.
- Angles are clockwise-positive in LittleJS and counterclockwise-positive in Box2D.
- Y is up in world space: falling gravity is negative Y. In 3D, -Z is forward, builders take
  diameters, lights take a radius, and `rotation3D` and `camera.fov` are radians.
- `drawText` is world space and `drawTextScreen` is screen pixels.
- Box2D: `await box2dInit()` at the top of `gameInit`, before any body. 3D: `new
  Render3DPlugin` at the top of `gameInit`, before any `EngineObject3D`, and never
  `setGLEnable(false)`.
- `ParticleEmitter` speeds are units per frame, not per second.
- Keep `\n` as an escape in text literals, not a real line break.
