# chiche — a voice REPL to a web coding agent

Two agents, one to the user: Chiche, who talks and builds web projects in front of them.

- **The voice**: a Gemini Live session (`gemini-3.8-live`), audio in and out, in the language
  `LANG` names. Its system prompt is `INSTRUCTIONS.md`, with `{{LANG}}` filled in. It reaches
  the coding agent with the `input` tool; the agent's output comes back on the newest open
  call.
- **The coding agent**: a liquen agent (`matias` in `config.jsonc`), reached through its door,
  `data/agents/<agent>/door.sock`. liquen is the harness in `../liquen`. Its shell starts in
  `data/organization`, and its instructions are `data/organization/instructions/organization.md`.

They never pass each other's words verbatim: the voice sends what the user wants as input, and
says what the agent's output means, without code.

**Web projects** live in `data/organization/projects/<name>/`, served by Vite through Deno, and
shown with `playwright-cli` in one browser window the user watches too.
A game is such a project made with LittleJS, from what `data/organization/littlejs/` holds:
its skills, starter examples and templates.

`data/system` links to `../liquen`'s seed, except `skills`, an empty folder so liquen seeds no
skills.

Run it with `deno task chiche`.
