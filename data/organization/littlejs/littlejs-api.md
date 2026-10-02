---
kind: skill
description: Use when you need the exact signature, parameter order, defaults, or existence of a LittleJS engine symbol — e.g. drawTile arguments, the ParticleEmitter constructor, Timer or Sound methods, EngineObject properties, tile/TileInfo helpers. Look the symbol up instead of guessing from memory; LittleJS argument orders are easy to get subtly wrong.
---

# littlejs-api

The curated LittleJS API reference is beside this skill, in the organization folder where your shell starts:

`littlejs/reference.md`

It is ~2300 lines / 180KB — do **NOT** read the whole file into context. Grep it for the symbol you need and read only the surrounding lines:

- Look up one symbol: grep for the symbol name (e.g. `ParticleEmitter`, `drawTile`, `tileCollisionTest`) and read ~20 lines around the first hit — entries are one-line signatures with a trailing `//` comment, grouped in sections.
- Broader area (e.g. "what sound functions exist?"): grep for the section heading (`## LittleJS` lists them all — `Drawing System`, `Audio System`, `Input System`, `Object System`, `Tile Layer System`, `Particle System`, `3D Math`, `3D Rendering`, `3D Levels`, `Tweakables`, `Level Editor`, `Post Processing`, `Box2D Physics`, ...) and skim that section only. The 3D Rendering section alone is ~600 lines, so inside it grep for the symbol rather than reading it through.
- Renamed or removed symbols: check the `## Deprecated` section at the end.
- If a symbol is NOT in the reference, verify against the engine build itself before concluding it exists: grep the project's `node_modules/littlejsengine/dist/littlejs.js` for it, or its typings, `littlejs.d.ts`, in the same folder. Trust the engine source over memory.

For engine *conventions and pitfalls* (argument-order traps, per-frame vs per-second units, naming rules), use the `littlejs/littlejs-conventions` skill instead — this skill is only for exact API lookup.
