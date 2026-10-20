# Tiny City

Kenney's Tiny City, CC0: a town seen from above, its people, cars and streets. `tiny-city/tiles.png`
is 192 × 176: 16 × 16 tiles, 12 a row, indexes 0 to 131 left to right and top to bottom,
`tile(index, 16)`.

Every tile is listed. Many are pieces: the recipes put them together, a grid of tiles one world unit
each, with `drawTile(vec2(x, y), vec2(1), tile(i, 16))`. In a recipe, rows go from the top down, and
`_` is no tile of its own (the sidewalk or the ground). People, cars, trees, lamps, signs and fences
are see-through around them: draw them over the ground, after it.

## Ground

There is no grass tile: the ground under the town is a color, `drawRect` or the clear color,
`rgb(.52, .78, .41)` (Kenney's grass, #84c669).

- 88: sidewalk, a light gray paving slab; 100: the same, cracked
- 101: a shadow, a dark tile at half alpha, laid over the ground beside a building

## Roads

A road is two tiles wide, a lane each, with the white curb line along its outer edge and half the
dashed center line along the edge the lanes share. Sidewalk (88) on both sides.

- running up and down: 61 the left lane, 62 the right lane
- running across: 63 the top lane, 75 the bottom lane
- a crosswalk on a road running up and down: 73 left, 74 right; on one running across: 64 top, 76
  bottom
- 65: the outer corner of a turn, the curb curving from the top to the right side
- 77: an inner corner: a curb corner at its top right, the center line along its left and bottom
  edges
- 89: a curb corner at its top right, the center line along its left edge only

The corners come one way round: `drawTile`'s angle turns them, `PI / 2` a quarter turn clockwise. A
tile turned the wrong way shows its lines on the wrong edges.

```
crossing                 turn, from the left and down     T, a road down from one across
   _   _  61  62  _         63  63  65  _                   63  63  63  63
  63  63  77↺ 77  63        75  77↻↻ 62 _                   75  77↻↻ 77↻ 75
  75  75  77↻↻ 77↻ 75       _   61  62  _                   _   61  62  _
   _   _  61  62  _
↻ is a quarter turn clockwise (angle PI / 2), ↻↻ a half turn (PI), ↺ a quarter turn back (-PI / 2).
```

## Buildings

Seen from above and the front: a roof, then the wall facing the street below it, one or two rows.
Any roof goes on any wall.

- brown roof: 0 1 2 / 12 13 14 / 24 25 26, its corners and edges around 13, the middle, repeated as
  wide and tall as the roof; 28 the middle with a dark patch, 29 the middle with flecks
- slate roof: 6 7 8 / 18 19 20 / 30 31 32, the same way; 34 the middle with a dark patch, 35 with
  flecks
- a roof one tile wide: brown 3 / 15 / 27, slate 9 / 21 / 33 (top, middle repeated, bottom)
- a roof one tile tall: brown 4 16 5, slate 10 22 11 (left, middle repeated, right)
- a roof one tile: brown 17, slate 23
- red brick wall, the upper row: 36 left edge, 37 38 39 plain, 40 a window, 41 right edge
- red brick wall, the street row: 48 left corner, 49 plain, 50 51 a wide door (left, right), 52 a
  door, 53 right corner
- brown brick wall, the upper row: 42 left edge, 43 44 45 plain, 46 a window, 47 right edge
- brown brick wall, the street row: 54 left corner, 55 plain, 56 57 a wide shop window (left,
  right), 58 a door, 59 right corner
- a wall one tile wide: red 60 (repeated) over 72 (the street row); brown 66 over 78

```
a red house, three wide      a slate shop, four wide        a tower, one wide
   0  1  2                       6  7  7  8                    3
  12 13 14                      18 34 19 20                   15
  24 25 26                      30 31 31 32                   27
  36 40 41                      42 46 46 47                   60
  48 52 53                      54 56 57 59                   72
```

## People

Each one tile, facing the front: 108 a girl, 120 a boy, 121 a police officer.

## Cars

Two tiles by two, facing right; `mirror` faces them left. None faces up or down.

- a car: 110 111 / 122 123
- a van: 112 113 / 124 125

## Trees and plants

- a tall tree, two tiles: orange 67 over 79, green 68 over 80
- a small tree in a round pot: 70 orange, 71 green; 69 the pot empty
- a planter, three tiles: with bushes 81 82 83, empty 93 94 95 (left, middle repeated, right)
- 118: a gray rock

## On the street

Two tiles tall, the top over the foot:

- a street lamp: 86 over 97
- a curved street light: 85 over 97
- a bus stop sign, blue: 96 over 97
- a small gray post: 102 over 97
- a power pole, wooden: 87 over 99; 90 the wire between two poles, in the tile between them
- a billboard, two wide: 91 92 over 103 104
- 98: a bare pole, a tile more of any of them, between the top and the foot
- 84: a no-parking sign, red, one tile
- 109: a trash can, one tile

## Fences

- wooden, around a yard: 105 top-left corner, 107 top-right corner, 130 a run across (repeated), 117
  the left side, 119 the right side (each repeated), 129 bottom-left corner, 131 bottom-right
  corner; 106 a lone post
- metal mesh: 126 left end, 127 middle (repeated), 128 right end; up and down, 114 the left side,
  115 a post, 116 the right side

```
a yard                 a mesh fence
 105 130 130 107        126 127 127 128
 117   _   _ 119
 129 130 130 131
```
