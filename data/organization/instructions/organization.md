---
kind: instruction
load: always
---
# Web projects

Each project is a folder in `projects/<name>/`, served by Vite through Deno, and shown in one
browser window that the user watches with you. `projects/` is not tracked by git: no git in it.

1. A new project: `deno run -A --no-lock npm:create-vite@latest projects/<name>
   --template <template> --no-interactive`, then `deno install` in it.
2. Serve it, unless it is already running: `(cd projects/<name> && deno task dev > vite.log
   2>&1 &)`. Its URL is in `vite.log`. Every change you save shows up in the page by itself.
3. Show it: `playwright-cli goto <url>`. When `playwright-cli list` has no browser open,
   `playwright-cli open --headed <url>` first. The user sees this same window: never close it.
   If it won't open headed, tell the user and stop there: a browser without `--headed` is one
   nobody sees.
4. Show what you are doing: `playwright-cli video-show-actions` marks each action on the page,
   and `playwright-cli highlight <target>` points at something.
5. Look at the feedback.

`playwright-cli --help [command]` tells the rest. It writes its files (console logs, snapshots,
screenshots) in `.playwright-cli/` in the organization folder, where your shell starts, whatever
folder it is in now: the paths it prints are relative to the organization folder.

## Feedback

Nothing tells you when something goes wrong: you find out by looking. Look after each change
you make, and each time a message comes in, before you answer. Vite doesn't type-check, and a
page that breaks breaks in front of the user, so catch it before they do.

| Source | Catches | How |
|---|---|---|
| Type check | type errors, wrong APIs | `deno run -A npm:typescript/tsc --noEmit` in the project |
| Lint | likely bugs, unused code | `deno lint src` in the project |
| Build | imports and bundling the dev server never reached | `deno task build` in the project |
| Dev server | files that won't transform, missing imports, reloads | `vite.log` in the project |
| Browser console | exceptions, errors, warnings | `.playwright-cli/console-*.log` |
| Network | 404s, failed API calls | `playwright-cli requests` |
| The page | how it looks and behaves | `playwright-cli snapshot`, `playwright-cli screenshot` |
| The user's actions | what they tried, where they got stuck | the `[user]` lines in `.playwright-cli/console-*.log` |
| Backend | server errors, when the project has one | its own log, kept like `vite.log` |

The console log starts a new file with each `goto`.
