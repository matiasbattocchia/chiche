---
kind: skill
description: Writing Phaser 4 game code for the org's games — the v3 habits that break,
  where Phaser's own guides are, and the patterns the kit expects.
---
# Phaser 4

The org pins Phaser 4.2.1 (`organization/deno.json`). Phaser ships guides written for agents,
one per topic, and they match the pinned version exactly. They are the reference, above
anything you remember:

```sh
game docs                                   # the 28 topics, one line each
game docs physics-arcade                    # a topic's guide; its reference files at the end
game docs physics-arcade <reference-file>   # one reference
game docs v3-to-v4-migration                # read once: what changed from v3
```

## What trips a v3 memory

`game check` catches these; this is what the error means:

- `Property 'Point' does not exist on type 'typeof Geom'`: `Geom.Point` is gone. Use
  `Phaser.Math.Vector2` (or plain `{ x, y }` where the signature allows it).
- `This member must have an 'override' modifier`: Deno's TypeScript is strict. Write
  `override update()` and `override init()` wherever the base `Scene` declares the method.
- Anything else that doesn't exist: look it up in `game docs <topic>` first.
  Don't reach for `any` to silence the checker.

## Patterns

- Import from the kit, not from `"phaser"`: `import { Phaser, kit, next, sfx, prize,
  startGame } from "kit"`, and `import meta from "./game.json" with { type:
  "json" }`.
- Draw placeholder art in code (`this.add.graphics()` … `generateTexture(key, w, h)` in
  the boot scene) until real art is worth it. The template does this.
- Arcade physics is on in every game (`startGame(…, { gravity })` for platformers).
  Overlaps and colliders: `game docs physics-arcade`.
- Input for all three devices: `createCursorKeys()`, `this.input.gamepad.pad1`,
  `pointerdown` and `pointermove`. See the template's `Play`.
- Text for a child: `fontSize` 40px and up, bold, a stroke for contrast. The template's
  `big()`.
- The game is 960×540 and scales to fit. Keep what matters away from the edges.
