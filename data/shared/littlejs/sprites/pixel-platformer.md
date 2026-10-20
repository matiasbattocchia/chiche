# Pixel Platformer

Kenney's Pixel Platformer, CC0: a side view, for platformers and runners. Three sheets, each with
its indexes left to right and top to bottom.

Every tile is listed. Many are pieces: the recipes put them together, a grid of tiles one world unit
each. In a recipe, rows go from the top down, and `_` is no tile. Tiles with see-through parts
(characters, coins, plants, signs) go over the background, drawn after it.

## tiles.png: 18 × 18, 20 a row, 0 to 179, `tile(index, 18, texture)`

### Ground

Each ground comes in two rows of four: a platform one tile tall, and the top of ground that goes on
down. In each row, one tile wide, then the left end, the middle (repeated) and the right end.

- grass: 0 1 2 3 a platform; 20 21 22 23 the top of ground
- sand: 40 41 42 43 a platform; 60 61 62 63 the top
- snow: 80 81 82 83 a platform; 100 101 102 103 the top
- dirt under any top: 120 121 122 123 the rows in between (repeated), 140 141 142 143 the bottom
  row; 4, 5, 24, 25 and 104 dirt with no edges

```
a hill of grass, four wide        a floating platform
  21 22 22 23                       1 2 2 3
 121 122 122 123
 141 142 142 143
```

### Blocks and platforms

- 6 brick; 26 a crate; 47 a wooden block; 48 49 50 wooden blocks in a row (left, middle, right)
- yellow blocks to hit from below: 9 plain, 10 "!", 11 with a coin; once hit, brown: 29 plain, 30
  "!", 31 coin
- 28 a yellow block with a keyhole, 27 its key
- 146, 147: a wooden platform, thin
- a cloud to stand on: 153 154 155 (left, middle repeated, right); 156 a small one alone
- a mushroom to stand on: the cap 14 left end, 13 middle (repeated), 12 the middle over the stem, 15
  right end; the stem under 12: 32, 52 (repeated), 72 its foot
- leaves, a block of them (a bush, a treetop): 17 18 19 / 37 38 39 / 57 58 59, its corners and edges
  around 38, repeated as wide and tall as the block; one tile wide: 36 / 56 / 76 (top, middle
  repeated, bottom); one tile tall: 77 78 79 (left, middle repeated, right); 16 one tile alone

```
a mushroom              a treetop on a trunk
 14 13 12 13 15          17 18 19
  _  _ 32  _  _          57 58 59
  _  _ 52  _  _           _ 97  _
  _  _ 72  _  _           _ 117 _
                          _ 137 _
```

### Trees

- a trunk: 97 its top (under a treetop of leaves), 117 (repeated), 137 its foot; with a stub to the
  left: 116; with leaves to the left: 96; with a root to the left: 136
- branches to stand on, two tiles each, pointing right: 118 119 bare, 98 99 leafy at the tip, 138
  139 rising; each starts halfway into its first tile, so it goes beside a trunk tile
- small: 124, 125 sprouts; 126 a pine; 127 a cactus; 128 a red mushroom; 129 a brown mushroom; 145 a
  snowman

### Water and pipes

- water: 33 the surface, 53 and 73 below it (repeated)
- a waterfall: 34 its top, 54 (repeated), 74 its foot in foam; another: 35, 55, 75
- a pipe up and down: 95 its top end, 115 a joint (repeated), 135 its bottom end
- a pipe across: 132 its left end, 133 a joint (repeated), 134 its right end
- a round pipe loop, two by two: 93 94 / 113 114

### Things to climb, push and use

- a ladder: 51 and 71, either, repeated up
- a pole: 69 its top, 89 (repeated), 109 its foot; 131 a thin gray pole; 70 a hook
- a bar across: 90 its left end, 91 (repeated), 92 its right end
- a fence: 105 a high one, 106 a low one
- a spring: 107 pressed, 108 sprung
- a lever: 64 left, 65 middle, 66 right
- a button on the floor: 148 up, 149 pressed; 110 a low wooden step
- a door: 130 its top over 150 its bottom
- a flag on a pole, two frames to wave: 111, 112
- signs on a post: 84 an arrow left, 85 an arrow right, 86 blank; arrow signs: 87 left, 88 right

### Things to collect and HUD

- a coin: 151, and 152 edge on (the two frames of it spinning)
- hearts: 44 full, 45 half, 46 empty
- 67 a blue gem; 27 a key; 144 wings; 7, 8 wooden planks
- 68 spikes, to hurt
- digits 0-9: 160-169, and the same again 170-179; 157 "."; 158 "×"; 159 "%"

## characters.png: 24 × 24, 9 a row, 0 to 26, `tile(index, 24, texture)`

All face the front or the right; `mirror` turns an object the other way. A character's frames are
side by side, so `new SpriteAnimation(tile(first, 24, texture), count, .2)` plays them.

- players, in space helmets, two frames each to walk: green alien 0, 1; blue alien 2, 3; pink alien
  4, 5; yellow alien 6, 7; a person 9, 10
- a spiked ball, grinning: 8
- a yellow block that falls on you: 11 calm, 12 angry
- a little yellow critter: 13, 14
- a red crawler with a spike on top: 15, 16 to walk, 17 squashed
- a blue slime: 18, 19 to hop, 20 squashed
- a big blue robot: 21, 22 to walk, 23 squashed
- a bat: 24 wings up, 25 wings out, 26 wings folded

## backgrounds.png: 24 × 24, 8 a row, 0 to 23, `tile(index, 24, texture)`

Three looks, each a column three tiles tall: the sky on top, the horizon in the middle, the ground
below. Repeat the three across the screen, behind everything, or as a `ParallaxLayer`.

- pale: 0-3 sky, 8-11 horizon (8 and 10 clouds, 9 round trees, 11 pines), 16-19 ground
- desert: 4, 5 sky, 12, 13 horizon (12 dunes, 13 dunes with palms), 20, 21 ground
- forest: 6, 7 sky, 14, 15 horizon (14 woods, 15 woods with tall trees), 22, 23 ground
