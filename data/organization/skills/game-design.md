---
kind: skill
description: Designing a game with the child before and while building it — directions to
  choose from, the design card, the first rough playable, one change per round.
---
# Designing with the child

The child designs the game; you build it. What the game is about is theirs: the hero, what
you do, what makes it hard, what you play for, every name. How it is built is yours. A
five-year-old designs by reacting to something concrete, not by writing a spec, so your part
in design is to give them concrete things to react to, fast.

Professional game design works the same way: decide the experience the player should have,
make the roughest thing that delivers it, play it, change it, again (Fullerton's playcentric
process: set player experience goals, prototype early, playtest, iterate).

## A new idea: directions, not code

When a request is a new game or a big new part of one and says little more than a theme ("a
record shop like an RPG", "something with dinosaurs"), don't build yet. Answer with **two
directions**, each one sentence built on what the player *does*:

- "Caminás por la disquería y buscás el disco que pide cada cliente."
- "Los discos caen de los estantes y los atrapás antes de que se rompan."

Two, not more: a five-year-old holds about two things in mind at once (Cowan 2016), and
these are heard, not read. When neither fits, the child will say so, and you offer two more.

Draw them from what games are made of: chase, race, catch, find, escape, build, rescue,
explore. Each one must be buildable today with the kit and the template, and different from
the others in the verb, not just the look. Keep the child's own words and names in them. The
voice reads them out loud: short, plain, no technical words.

When the idea already says what you do, skip this: confirm it in one sentence instead.

## The design card

Once the child has chosen, write `games/<slug>/DESIGN.md`, a few lines, in the child's language:

- **Hero:** who you play, with the name the child gave.
- **You:** the verb, the thing you do again and again (the core loop).
- **Hard:** what gets in the way.
- **For:** what you play for (the prizes in `game.json`).
- **Feels:** the one feeling it should give (funny, fast, cozy, brave).
- **Their words:** names, colors, jokes the child invented, verbatim.

It is the shared reference. Every later change keeps it true, or updates it when the child
changes their mind. Commit it with the game.

## The first try: rough and fast

The first build is a sketch that plays the verb and nothing else: shapes or drawn-in-code
figures, one screen, the hero with the child's name, one sound, the difficulty and prize
wiring from the kit. No menus, no second level, no polish. Get it on the child's screen
(`game build`) quickly, then answer with how to play (each control and what it does, and
what you're trying to do), one sentence of what it does, and one question ("¿qué le
cambiamos?").

A rough version they can play teaches you more than anything you could ask them first:
what is fun can't be predicted, only tried.

## Then: one change per round

Each round is one change the child asked for or chose, built, shown, and played together.
Report it as one sentence they can check on screen ("ahora los discos caen más rápido cuando
atrapás tres seguidos"), plus the next question when there is one. Keep everything they
invented visible in every version. When a request would need several changes, pick the first
one, build it, and say what comes next.

When a decision is needed (which hero, which of two ways), ask it as a choice of two, never
an open technical question.
