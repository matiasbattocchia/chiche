---
kind: skill
description: Sprites for a LittleJS game — Kenney's CC0 sheets in littlejs/sprites/ (Tiny City, a town seen from above; Pixel Platformer, a side view), with catalogs that say what every tile is and how pieces go together (roads, buildings, ground, trees). TRIGGER when a game's thing gets a look (the player, a baddie, a car, a coin, the ground, a house), when the user asks for sprites, pictures, characters or "make it look like…", or when the code calls tile()/drawTile with an image. The only images a game uses are these; none from the web, none downloaded or generated.
---

# sprites

A game's things are sprites from `littlejs/sprites/`, or shapes drawn with the engine when no sprite
fits. They are Kenney's packs, CC0 (the `License.txt` beside each): free to publish, nothing to
credit. No other image goes in a game: none from the web, none downloaded, none generated.

| Sheet                                               | Tile  | What it has                                                                                                                                        |
| --------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `littlejs/sprites/tiny-city/tiles.png`              | 16 px | a town seen from above: roads with crosswalks and turns, sidewalks, houses and shops, a car and a van, three people, trees, lamps, signs, fences   |
| `littlejs/sprites/pixel-platformer/tiles.png`       | 18 px | a side view: ground (grass, sand, snow, dirt), blocks, platforms, trees, water, pipes, ladders, springs, levers, doors, flags, coins, hearts, gems |
| `littlejs/sprites/pixel-platformer/characters.png`  | 24 px | five players in space helmets, two frames each to walk, and baddies: a spiked ball, a falling block, a crawler, a slime, a robot, a bat            |
| `littlejs/sprites/pixel-platformer/backgrounds.png` | 24 px | sky, horizon and ground behind the game, in three looks: pale, desert and forest                                                                   |

A game takes the pack of its view, so it has one look:

- seen from the side, Pixel Platformer: a platformer, a runner
- seen from above, Tiny City: a race through the streets, collecting around town, defending a street
- neither (a shooter in space, a puzzle board): shapes drawn with the engine, with the packs' coins,
  gems, hearts and digits where they fit

What every tile is, and how the pieces go together: `littlejs/sprites/tiny-city.md` and
`littlejs/sprites/pixel-platformer.md`. Read the pack's catalog whole before the first sprite of a
game: it is short, and it is all there is to know about the sheet, so never open the image to look.
When the pack has no such thing, take the nearest one, or draw it with the engine, and say which in
the result, in the user's terms ("there's no bus, so it's the van").

## In a game

1. Copy the sheet into the project's `public/`, under a name of its own when there are more:
   `mkdir -p projects/<name>/public && cp littlejs/sprites/tiny-city/tiles.png projects/<name>/public/city.png`.
   Vite serves `public/` at the page's root and copies it into the build `deno task publish` puts
   online; an image anywhere else is left out of it, and the published game loads without it.
2. Name it in `engineInit`'s image list, by its file alone: `engineInit(…, ["city.png"])`. Its place
   in the list is its texture, the third argument of `tile()`: 0 for the first.
3. `setTileDefaultBleed(.5)` with the other settings, before `engineInit`. Without it thin lines
   show between tiles at most sizes.
4. A tile is `tile(index, size, texture)`, with the sheet's tile size from its catalog:
   `tile(108, 16)` Tiny City's girl, `tile(0, 24, 1)` the green alien when `characters.png` is
   second in the list. An object takes it as its `tileInfo` (`super(pos, vec2(1), tile(108, 16))`),
   and `drawTile(pos, size, tile(88, 16))` draws one. The size is in world units and the tile
   stretches to it: keep it square, as the tiles are.
5. A thing of several tiles (a car, a house, a road) is drawn tile by tile, one world unit apart, as
   its catalog's recipe lays them out. `drawTile`'s angle turns a tile, `PI / 2` a quarter turn
   clockwise, and `mirror` flips it.
6. Frames are tiles side by side: `new SpriteAnimation(tile(0, 24, 1), 2, .2)` walks the green
   alien, and `this.tileInfo = walk.tileInfo` in `update()` shows it. `this.mirror = true` turns an
   object to face the other way.

The engine keeps the pixels crisp (`tilesPixelated`, on by default): leave it on.

## A new pack

`littlejs/` is read-only to you: a new pack comes from whoever keeps chiche, and a user who asks for
one hears that in the result. It is added this way:

1. A CC0 pack (Kenney's are), its zip from the pack's page, its `License.txt` read to be sure.
2. Its packed sheets (`*_packed.png`, no space between tiles; the tile size is in its
   `Tilesheet.txt`) and its `License.txt` copied into `littlejs/sprites/<pack>/`.
3. `littlejs/sprites/<pack>.md`, its catalog: each sheet's size, tile size and tiles a row, every
   tile said, and a recipe for each thing of several tiles, put together and looked at before it is
   written down, its turns drawn in LittleJS.
4. A row in the table above, and the view or genres it is for.
