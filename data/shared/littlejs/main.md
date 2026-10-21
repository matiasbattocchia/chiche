---
kind: instruction
load: always
---

# Games

A game is a web project made with LittleJS, a small engine for 2D and 3D games in the browser. When
the user asks for a game and names no other engine or framework, make it with LittleJS.

Core goals

- Turn a game idea into a working LittleJS game quickly.
- A game is of one genre, with a goal: something to reach, something that can go wrong on the way.
- Keep scope right-sized: get a fun playable core loop first, then expand.
- Work in small steps: the first turn ends with something to play, and each later turn adds one
  small thing to it.

Everything for it is in `littlejs/`, in the shared folder. It is read-only: copy out of it, never
write into it.

- `littlejs/new-littlejs-game`: the skill for a new game, with which example to copy, which template
  to read patterns from, and the steps.
- `littlejs/littlejs-conventions`: read it before writing or changing LittleJS code. It has the
  imports and setters, the engine's built-ins, and the pitfalls that fail silently.
- `littlejs/littlejs-api`: look an engine name up in `littlejs/reference.md` instead of guessing its
  arguments.
- `littlejs/atlas-shape-art`: shapes and many round things, drawn as tinted tiles.
- `littlejs/sprites`: the sheets a game's sprites come from, in `littlejs/sprites/`, and what each
  tile shows.
- `littlejs/examples/`: the starter projects. `littlejs/templates/`: pages to read patterns from,
  and the helper modules.

## The game: a genre and a goal

A game is of one genre, picked from the user's first idea. They don't know genres by name: the voice
has said it to them in their words ("the ants want your soda, and you keep it safe until night?"),
and the first message names it. The genre is what keeps it a game: a goal to reach, a way to fail on
the way, and the tries the difficulty counts. It also gives the actions and how the phone plays it.

| Genre    | Goal                                                           | A try                        | Harder with                  | Actions                         | Phone            |
| -------- | -------------------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------- | ---------------- |
| Defend   | Keep something safe until a time, or for some waves            | A wave held                  | More, faster attackers       | Space, or a tap: build or shoot | `point`, upright |
| Collect  | Gather the things in a field or a maze before time or a chaser | A thing reached, or a round  | Faster chasers, less time    | None, or Space: a dash          | `point`, upright |
| Platform | Reach the flag at the end, over gaps and baddies               | A gap or a baddie passed     | Wider gaps, faster baddies   | Space: jump. X: throw           | `pad`, sideways  |
| Race     | Finish the laps first                                          | A lap, ahead of the others   | Faster rivals                | Space: boost. X: throw          | `pad`, sideways  |
| Runner   | Reach the end of a run that comes at you                       | An obstacle passed           | More speed, closer obstacles | Space: jump. X: duck            | `tap`, upright   |
| Puzzle   | Solve the board                                                | A board solved               | More pieces, more colors     | None: tap the pieces            | `point`, upright |
| Shooter  | Clear the waves of ships, dodging their shots                  | A wave cleared without a hit | More ships, faster shots     | Space: shoot, or while dragging | `point`, upright |

- The plan starts with the loop: the player moving (the first turn), then the goal and how it shows
  (a star, a flag, the soda's level), the way to fail, and the difficulty, before anything else. A
  step that adds nothing to the loop (a moon, a glow) comes after, when the user picks it: the
  default next step goes toward the goal.
- An idea goes into the game through its genre: a new thing to collect, a new baddie, a place, a
  look, a prize. An idea that is another game becomes something of this one (a car in the platformer
  is a platform to ride) or waits for a game of its own. The actions stay few: a new one takes the
  place of one, or shares its key.
- Nothing wins without playing: no endless lives, ammo or soda, no taking away what makes it hard,
  no blast that clears the screen, no player that plays by itself (walks to the targets, aims for
  you). A request for one comes earned and short ("three stars give five seconds of endless soda");
  one for less challenge ("no ants") is the difficulty's, which eases off by itself when tries fail.
  Say so in the result, in the user's terms.
- The difficulty is `templates/difficulty.ts`: `new Difficulty('gameName')`, `record(ok)` after each
  try the genre counts, and what makes the game hard read through `at(easiest, hardest)`
  (`antSpeed = difficulty.at(1, 4)`). It keeps about 85% of the tries going well, and it is felt,
  not shown.

## Small steps

A five-year-old is waiting, and what keeps them waiting is something to play with. Put it in front
of them in the first turn, then give them something new in it every minute or two.

- The first turn ends with the game playable, however rough: the starter copied, and in its
  `game.ts` the player, a sprite or a plain shape, moving over a plain world (a grid of colored
  squares, a road, a floor) through `templates/controls.ts` with the genre's scheme, with a particle
  effect when it does something. A few dozen lines.
- Each later turn is one step on top of that: one thing the user sees or tries, tens of lines, not
  hundreds. Each engine feature is a step of its own (tiles, physics, a rule and its score,
  particles, sound, the camera), and so is each of the game's own things, and each detail of one: a
  rider on the motorcycle is a step, its mirrors another.
- A change to a value (faster, slower, bigger, another color) is that value: change it, look, end
  the turn. Nothing rides along with it.
- Change `game.ts` with edits. Writing it whole again means the step is too big.
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
take a default, and ask. The choice is about the game, never about its keys or the phone's buttons:
the genre settles those. The answer comes with a later message; until then the plan stands. For "a
super fast car with a gun on top that shoots dynamite, a boost, and slow cars to race", a race, the
first turn makes step 1 and ends with this plan:

1. 🏎️ A red car drives on green grass with the arrows or the cross, dust behind it. (done: try it)
2. 🛣️ A gray road loop with a 🏁 line: three laps and it ends.
3. 🚗 Two cars race you, and finishing first gives a ⭐.
4. 🎚️ The other cars go faster after you win, slower after you lose.
5. 🧨 X throws a dynamite forward; a car it hits spins out, with smoke.
6. 🔥 Space: a boost, with fire behind, that fills up again slowly.
7. 🔊 The engine's and the dynamite's sounds.

Next is step 2, the road: round like an oval, or with sharp turns? And an idea: a puddle that makes
the car slide.

Then the user says "a motorcycle!" while you make step 2: the road goes on, the motorcycle is a step
in the plan, and the turn ends with the road.

## What costs minutes and gives the user nothing

- Looking around before a new game: other projects, past conversations (`search`), git. A new game
  starts from the starter and these files.
- Probing the engine with scripts (`node -e`, python over the typings) for how angles, the camera or
  screen coordinates go: `littlejs/littlejs-conventions` has them.
- `deno task build`: the dev server shows the game.
- Detail nobody asked for: kerbs, tire stacks and grid slots on a track, mirrors and a plate on a
  motorcycle. A sprite or a plain shape first; detail is a step the user picks.
- A shell lost in another folder: a `cd` stays, so run a project's commands as
  `(cd projects/<name> && …)` and stay in the shared folder, where the `.playwright-cli/` paths
  resolve.

## How a game differs from other web projects

- It starts as a copy of a starter in `littlejs/examples/`, not from create-vite, and is served and
  shown like any web project.
- It is TypeScript ES modules: `game.ts` at the project's root imports the engine from
  `'littlejsengine'` and the rest of the game's modules. Split it into modules (`player.ts`,
  `ui.ts`, `constants.ts`) as it grows.
- Feedback: type check with `deno check game.ts`, against the engine's typings, strictly (the
  starter's `deno.json`), and lint with `deno lint game.ts` and the game's other modules,
  `templates/controls.ts`, `templates/difficulty.ts` and `templates/perspective.ts` among them. Not
  `deno task build`: nothing serves its `dist/`. The other helper modules in `templates/` are
  third-party: don't lint, check or review them.
- An image the game loads goes in the project's `public/`, named in `engineInit`'s list by its file
  alone (`"city.png"`): Vite serves `public/` at the page's root, and copies it into the build
  `deno task publish` puts online. An image anywhere else is left out of that build.
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
- No other libraries unless the user asks for one.
- Images are the sprites in `littlejs/sprites/` (the `littlejs/sprites` skill) and the shapes the
  engine draws; sounds are ZzFX (`Sound`, or `SoundGenerator` from `gameFx.ts`). No image or sound
  file from anywhere else: none from the web, none downloaded, none generated.
- Use what LittleJS has before writing your own: `keyDirection()` for arrows and WASD, `keyIsDown()`
  for other keys, `gamepadStick()`, `isOverlapping`, `screenToWorld` / `worldToScreen`,
  `isOnScreen`, `Timer`, the math shortcuts and `Vector2` methods, `TileCollisionLayer` with
  `collideWithTile(tileData, pos)` for tile collision.
- Persisted settings and stats go through `readSaveData` / `writeSaveData`.

## Depth

A view with depth that stays put (a table seen from where you sit, a road ahead, a room from its
door) is 2D, drawn through `templates/perspective.ts`. A view that turns or moves through the world
(driving, walking around, a camera behind the player) is LittleJS 3D.

- Each thing has a place across (`x`), a distance (`z`: 0 the near edge, 1 the far edge) and a
  height (`h`), and is drawn at `toScreen(x, z, h)`, `scaleAt(z)` times its size, the farthest first
  (`things.sort(farFirst)`). When a 2D game turns into such a view, all its things get a distance in
  that one step.
- Evenly spaced things (tiles, chairs, a tablecloth's squares) go at evenly spaced distances, and
  the perspective shrinks the far ones. Nothing gets a shrinking of its own: a surface that looks
  wrong is at a wrong distance, or drawn without `toScreen`.
- What the player moves over the ground (an aim, a marker) moves up the screen evenly, as fast near
  as far: keep it, and the tolerances it is compared with, in `onScreen(z)` terms, and turn it into
  a distance with `depthAt`.

## Checking a step

A screenshot shows what is there, not whether it is right. Whether the far tiles are smaller, a
glass can be filled, or the shadow is where the soda lands, are numbers: read them from the game,
and say them in the result ("the tiles are 1.2, .8 and .5 tall, front to back").

- A hook on `globalThis` gives them (`littlejs/littlejs-conventions`), read with
  `playwright-cli eval "() => game.tileSizes()"`.
- What the player has to reach (a glass to fill, a gap to jump, a target to hit) is checked by
  sweeping: a hook runs the game's own step for each input the player can give (every aim, every
  power, a few frames each), and counts what each reaches. Each target is reached by some inputs and
  missed by others: one that no input reaches, or that every input does, is a bug of the step.
- Something that shows where a thing will land or go (a shadow, a dotted line) is computed with the
  same function that moves the thing, never a formula of its own.

## Controls and devices

The game is played on a phone or a tablet first, and on the laptop's keyboard and with a gamepad as
well: one game, three ways in. `templates/controls.ts` makes them one: every game copies it in the
first turn, and reads moving and its actions only through it.

- `controlsInit(scheme, icons)` at the top of `gameInit`: the genre's scheme, and an icon for each
  action, the main one first. `moveInput()` is moving (the arrows and WASD, a gamepad, the touch
  cross); `actionPressed(i)` and `actionDown(i)` are an action (its key, its gamepad button, its
  button on the phone). With `point`, `pointerPressed()` is where a tap landed and `pointerHeld()`
  where the finger is, in world space; on the laptop they are the mouse.
- The schemes. `pad`: a cross under the left thumb and the buttons under the right, the phone held
  sideways. `point`: one finger on the upright phone; a tap is where to go or what to act on, a
  finger held down drags, and the action buttons are tapped. `tap`: the whole upright screen is the
  main action, and with a second, its left half is that one. `tilt`, when the user asks to tilt or
  shake the phone: tilting the upright phone moves, a tap anywhere is the main action, and a shake
  is the second, whose button at the bottom left can be tapped too.
- `tilt`: the phone at rest is held as a game is, leaning back 45°, and tilts fully at 30° and 60°,
  and 10° to either side. `tiltInput()` is where its back points, as a bottle's spout held in both
  hands, for an aim that comes back to the middle with the phone; `moveInput()` is downhill, where a
  ball on it rolls. A request for less sensitive is a wider `TILT_RANGE` in the game's copy. Tried
  headless with the phone's own events:
  `playwright-cli -s=phone eval "() => dispatchEvent(Object.assign(new Event('deviceorientation'), {beta: 60, gamma: -10}))"`,
  and a shake, `devicemotion` with `{acceleration: {x: 20, y: 0, z: 0}}`.
- A game never edits its copy of `controls.ts`, `difficulty.ts` or `perspective.ts`. What the game
  needs of them otherwise goes in its own code; what every game would want (a smaller button) goes
  in the result, as an idea for the template.
- A game that reads its input around `controls.ts` (its own `deviceorientation`, a key read by
  hand), or whose copy lacks what `littlejs/templates/controls.ts` has now, moves onto it in the
  step that touches its controls: copy it again over the old one, and the game's own reading goes.
- Two actions: Space and X. A third (C) and a fourth (Z) only when the genre can't go without them
  and no key can take them on by what fits: say why in the result. Keys are few: a thing and its
  undoing share one (in and out of the tank), one key does what fits where the player is (Space
  builds on free ground and goes in at a door), and never two keys together. A request that brings a
  third action, or a key of its own, gets the fix you propose in the result: the user can't see the
  clash.
- `drawControls()` in `gameRenderPost` draws each action's icon on its button, at the bottom right,
  with its key beside it while the keyboard plays. The HUD goes at the top, and nothing the player
  must see sits in the bottom corners, under the thumbs and the buttons.
- Lay the game out for its phone: upright for `point` and `tap`, like the laptop window beside the
  terminal. The canvas takes the window's size, so keep the playfield whole with
  `setCameraScale(min(mainCanvasSize.x / viewW, mainCanvasSize.y / viewH))` each frame. A `pad` game
  is played sideways: say so in the result, so the user turns the phone.
- A step about touch or layout is tried as a phone too, by you alone: a browser of its own session,
  with no window, `playwright-cli -s=phone open --mobile <url>`, looked at with
  `playwright-cli -s=phone screenshot`, and closed when done with `playwright-cli -s=phone close`;
  the user's window stays. The phone is a check of yours, not a step of the plan nor a question for
  the user.

## Helper modules

They are not part of the engine. To use one, copy it from `littlejs/templates/` into the project's
`templates/` folder and import from it. Grep the engine's `littlejs.d.ts` before taking a name for
engine API.

- `controls.ts` and `difficulty.ts`: the controls and the difficulty, above. Every game has both.
  They are the games' own, typed and checked with the game, and so is `perspective.ts`, a view with
  depth (Depth, above).
- `menus.ts`: title, pause and options menus, dialogs, toolbars, toasts and medals; don't build DOM
  menus by hand. `createTitleMenu`, `createPauseMenu`, `createOptionsMenu`, `createMenu`,
  `createToolbar`, `showConfirmDialog`, `showAlertDialog`, `showGameOverDialog`, `MenuMedal`. Pause
  while a menu shows with `installAutoPause(() => isPlaying)` or
  `setMenuVisibilityCallback(v => setPaused(v))`, and call `bindPauseKey` in `gameUpdate` for Esc
  and Start. Its save data: `saveDataInit('GameName')` at the top of `gameInit`, before menus and
  medals, then `saveData` and the best-score helpers (`submitBestScore`, `getBestScore`). Options
  persist through a menu item's `persist:` key. `templates/menuGame.html` shows it all.
- `gameFx.ts`: `SoundGenerator` for sound effects, and screen shake (`addScreenShake`).
- `textureGenerator.ts`: sprites drawn into a texture atlas (`initDrawToTexture`, `drawToTexture`,
  `drawTextToTexture`), and `initDefaultAtlas` for 16 white shapes to tint.
- `cards.ts`: a deck of playing cards, piles, dealing and undo. It imports `textureGenerator.ts`.
- `gameAI.ts`: a computer opponent for a turn-based two-player game. The game describes its moves
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
