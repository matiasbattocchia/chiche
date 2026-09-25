# chiche — how the voice agent and the coding agent talk

Two agents, one conversation with a child who designs video games.

- **The voice**: a Gemini Live session (`gemini-3.8-live`), audio in and out, in the language
  `LANG` names. Its system prompt is `INSTRUCTIONS.md`.
- **The builder**: a liquen agent (`matias` in `config.jsonc`), reached through its door,
  `data/agents/<agent>/door.sock`. liquen is the harness in `../liquen`.

They never hear each other verbatim. The voice turns what the child says into work for
the builder, and turns the builder's results into something a five-year-old wants to hear.
