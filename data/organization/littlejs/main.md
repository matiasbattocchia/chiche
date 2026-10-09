---
kind: instruction
load: always
---

# Games

A game is a web project made with LittleJS, a small engine for 2D and 3D games in the browser. When
the user asks for a game and names no other engine or framework, make it with LittleJS.

Core goals

- Turn a game idea into a working LittleJS game quickly.
- Keep scope right-sized: get a fun playable core loop first, then expand.
- Work in small steps: the first turn ends with something to play, and each later turn adds one
  small thing to it.

Everything for it is in `littlejs/`, in the organization folder. It is read-only: copy out of it,
never write into it.

- `littlejs/new-littlejs-game`: the skill for a new game, with which example to copy, which template
  to read patterns from, and the steps.
- `littlejs/littlejs-conventions`: read it before writing or changing LittleJS code. It has the
  imports and setters, the engine's built-ins, and the pitfalls that fail silently.
- `littlejs/littlejs-api`: look an engine name up in `littlejs/reference.md` instead of guessing its
  arguments.
- `littlejs/atlas-shape-art`: shapes and many round things, drawn as tinted tiles.
- `littlejs/examples/`: the starter projects. `littlejs/templates/`: pages to read patterns from,
  and the helper modules.

## Small steps

A five-year-old is waiting, and what keeps them waiting is something to play with. Put it in front
of them in the first turn, then give them something new in it every minute or two.

- The first turn ends with the game playable, however rough: the starter copied, and in its
  `game.js` the player, a plain shape or icon, moving with the keys over a plain world (a grid of
  colored squares, a road, a floor), with a particle effect when it does something. A few dozen
  lines.
- Each later turn is one step on top of that: one thing the user sees or tries, tens of lines, not
  hundreds. Each engine feature is a step of its own (tiles, physics, a rule and its score,
  particles, sound, the camera), and so is each of the game's own things, and each detail of one: a
  rider on the motorcycle is a step, its mirrors another.
- A change to a value (faster, slower, bigger, another color) is that value: change it, look, end
  the turn. Nothing rides along with it.
- Change `game.js` with edits. Writing it whole again means the step is too big.
- A request that names many things is a plan, not a turn: make its first step, and end the turn with
  the plan, a line a step. A message that comes in while you work either corrects the step under
  way, and goes into it, or is another step: put it in the plan, and end the turn with the step
  under way.
- A bug that keeps the user from trying the step is part of it, and so is what they can't see of it:
  a key hint off-screen, an edge cut off. The window is narrow, beside the terminal (636 px wide in
  prueba3), so fit the game to `mainCanvasSize`. Any other bug goes in the plan.

End each turn saying what to try, the next step of the plan, and one choice about that step or an
idea for it, in the user's terms: two ways it could go ("the Pokémon walk around the kitchen, or
peek out from behind the plates?"), or something the game could have that nobody asked for ("eggs
left too long could burn"). What you can't decide alone (which key cracks the eggs) is that choice:
take a default, and ask. The answer comes with a later message; until then the plan stands. For "a
super fast car with a gun on top that shoots dynamite with space, a boost on B, and slow cars to
race", the first turn makes step 1 and ends with this plan:

1. 🏎️ A red car drives on green grass with the arrows, dust behind it. (done: try it)
2. 🛣️ A gray road loop to drive on.
3. 🎥 The camera follows the car.
4. 🧨 Space throws a dynamite forward; it blows up after a second.
5. 🚗 Two slow cars drive along the road.
6. 💥 A dynamite that hits a car sends it spinning, with smoke.
7. 🔥 B: a boost, with fire behind.
8. 🔊 The engine's and the dynamite's sounds.
9. 🏁 Laps, and a star for finishing first.

Next is step 2, the road: straight, or a loop that comes back to the start? And an idea: a puddle
that makes the car slide.

Then the user says "a motorcycle!" while you make step 2: the road goes on, the motorcycle is a step
in the plan, and the turn ends with the road.

## What costs minutes and gives the user nothing

- Looking around before a new game: other projects, past conversations (`search`), git. A new game
  starts from the starter and these files.
- Probing the engine with scripts (`node -e`, python over the typings) for how angles, the camera or
  screen coordinates go: `littlejs/littlejs-conventions` has them.
- `deno task build`: the dev server shows the game.
- Detail nobody asked for: kerbs, tire stacks and grid slots on a track, mirrors and a plate on a
  motorcycle. Plain shapes first; detail is a step the user picks.
- A shell lost in another folder: a `cd` stays, so run a project's commands as
  `(cd projects/<name> && …)` and stay in the organization folder, where the `.playwright-cli/`
  paths resolve.

## How a game differs from other web projects

- It starts as a copy of a starter in `littlejs/examples/`, not from create-vite, and is served and
  shown like any web project.
- It is JavaScript ES modules: `game.js` at the project's root imports the engine from
  `'littlejsengine'` and the rest of the game's modules. Split it into modules (`player.js`,
  `ui.js`, `constants.js`) as it grows.
- Feedback: type check with `deno check game.js`, against the engine's typings (the starter's
  `deno.json` turns it on for JavaScript), and lint with `deno lint game.js` and the game's other
  modules. Not `deno task build`: nothing serves its `dist/`, which leaves out the Box2D loader and
  the images `engineInit` loads. The helper modules in `templates/` are third-party: don't lint,
  check or review them.
- Looking up an engine name: `littlejs/reference.md` first, then the engine's typings,
  `node_modules/littlejsengine/dist/littlejs.d.ts`. Never read the engine's source
  (`littlejs.esm.js`, `littlejs.js`): it costs minutes and the typings say what a call takes.
- The page loads the engine's debug build: its watermark in the corner and the console warning
  "LittleJS DEBUG build loaded" are expected. While its overlay is open (Esc) it takes some keys:
  1-8 debug views, 9 the tweakables panel, 0 the level editor, C the 3D free camera, +/- the time
  scale.
- Format with `deno fmt` in the project after each change. Everything in `littlejs/` except
  `reference.md` is already formatted the same way, so code copied from it stays as it is. Put a
  comment for each argument on its own line: the formatter splits long argument lists one per line.

## Building a game

- Ask only what blocks the work; otherwise start building.
- No other libraries unless the user asks for one. No external assets (images, sprite sheets, sound
  files) unless asked: draw with the engine and make sounds with ZzFX (`Sound`, or `SoundGenerator`
  from `gameFx.js`).
- Use what LittleJS has before writing your own: `keyDirection()` for arrows and WASD, `keyIsDown()`
  for other keys, `gamepadStick()`, `isOverlapping`, `screenToWorld` / `worldToScreen`,
  `isOnScreen`, `Timer`, the math shortcuts and `Vector2` methods, `TileCollisionLayer` with
  `collideWithTile(tileData, pos)` for tile collision.
- Persisted settings and stats go through `readSaveData` / `writeSaveData`.

## Helper modules

They are not part of the engine. To use one, copy it from `littlejs/templates/` into the project's
`templates/` folder and import from it. Grep the engine's `littlejs.d.ts` before taking a name for
engine API.

- `menus.js`: title, pause and options menus, dialogs, toolbars, toasts and medals; don't build DOM
  menus by hand. `createTitleMenu`, `createPauseMenu`, `createOptionsMenu`, `createMenu`,
  `createToolbar`, `showConfirmDialog`, `showAlertDialog`, `showGameOverDialog`, `MenuMedal`. Pause
  while a menu shows with `installAutoPause(() => isPlaying)` or
  `setMenuVisibilityCallback(v => setPaused(v))`, and call `bindPauseKey` in `gameUpdate` for Esc
  and Start. Its save data: `saveDataInit('GameName')` at the top of `gameInit`, before menus and
  medals, then `saveData` and the best-score helpers (`submitBestScore`, `getBestScore`). Options
  persist through a menu item's `persist:` key. `templates/menuGame.html` shows it all.
- `gameFx.js`: `SoundGenerator` for sound effects, and screen shake (`addScreenShake`).
- `textureGenerator.js`: sprites drawn into a texture atlas (`initDrawToTexture`, `drawToTexture`,
  `drawTextToTexture`), and `initDefaultAtlas` for 16 white shapes to tint.
- `cards.js`: a deck of playing cards, piles, dealing and undo. It imports `textureGenerator.js`.
- `gameAI.js`: a computer opponent for a turn-based two-player game. The game describes its moves
  and positions, and `await alphaBetaAI(game, state, depth)` picks a move. A state must keep the
  position in `board` and the side to move in `currentPlayer`: the search tells positions apart by
  those two fields only.

## Available features

What the engine has ready, to suggest as next steps: add one when the user picks it, and when they
do, use the engine's, never one of your own.

- 3D is built into the engine: `new Render3DPlugin;` at the top of `gameInit`, then
  `EngineObject3D`, meshes from builders, lights, shadows, fog and sky, terrain, 3D text, particles,
  cameras that orbit, follow or fly, and 3D sound. A request for 3D means LittleJS 3D, never
  three.js unless the user names it. Grep `littlejs/reference.md` for a 3D feature before building
  it.
- Tuning while it runs: `tweak('name', {object: settings, min, max})` at the end of `gameInit` puts
  `settings.name` in the engine's tweakables panel (debug build only).
- Full-screen effects: `postProcessBloom(threshold, strength, size)` for glow, or
  `new PostProcessPlugin(postProcessEffects(postProcessGlow(), postProcessScanlines(),
  postProcessVignette()))`;
  `postProcessTV({...})` is an old TV in one piece. One post-process is active at a time, so combine
  effects with `postProcessEffects`.
- Ready-made particles: `particleEffect(name, pos, {scale, hue})`, or `particleEffect3D` in 3D.
  One-shots end by themselves: explosion, hit, dust, debris, muzzle, blood, confetti and splash. The
  rest go on until destroyed: fire, torch, smoke, steam, sparks, sparkle, magic, heal, poison,
  portal, rain, snow, leaves, bubbles, fireflies and trail. For a burst of one of those, pass
  `{emitTime: .3}`; one that lasts goes with what it belongs to: keep the emitter `particleEffect`
  returns and `destroy()` it then. A `ParticleEmitter` only when none of these fits.
- Also in the engine: `ParallaxLayer`, lights, tweens, scenes, pathfinding and texture sheets. Check
  `littlejs/reference.md` before writing any of these.

## Pitfalls

- An engine setting is an import, and an import can't be assigned: `setCameraScale(32)`,
  `setGravity(...)`, `setPaused(true)`, never `cameraScale = 32`.
- `drawCircle` and `drawEllipse` take a diameter, not a radius.
- Angles are clockwise-positive in LittleJS and counterclockwise-positive in Box2D.
- Y is up in world space: falling gravity is negative Y. In 3D, -Z is forward, builders take
  diameters, lights take a radius, and `rotation3D` and `camera.fov` are radians.
- `drawText` is world space and `drawTextScreen` is screen pixels.
- Box2D: `await box2dInit()` at the top of `gameInit`, before any body. 3D: `new
  Render3DPlugin`
  at the top of `gameInit`, before any `EngineObject3D`, and never `setGLEnable(false)`.
- `ParticleEmitter` speeds are units per frame, not per second.
- Keep `\n` as an escape in text literals, not a real line break.
