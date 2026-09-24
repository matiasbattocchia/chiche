/**
 * Terminal key input, with key-release events where the terminal supports them.
 *
 * A plain TTY only ever reports key *presses*, which is why hold-to-talk is not
 * normally possible in a terminal app. The kitty keyboard protocol adds release
 * events; kitty, ghostty, foot and WezTerm implement it, and terminals that
 * don't simply ignore the query. So we ask, and fall back to press-only.
 *
 * Everything runs through a single reader on stdin — two concurrent readers on
 * the same fd would interleave and corrupt each other.
 */

export interface KeyEvent {
  /** Unicode code point of the key ('q' is 113, space is 32). */
  code: number;
  ctrl: boolean;
  type: "press" | "repeat" | "release";
}

/** Disambiguate escape codes | report event types | report all keys as escape codes. */
const KITTY_FLAGS = 1 | 2 | 8;

/** How long to wait for the terminal to answer the capability query. */
const HANDSHAKE_TIMEOUT_MS = 250;

const decoder = new TextDecoder();
const write = (s: string) => { process.stdout.write(s); };

/** Matches one complete CSI sequence: ESC [ params final. */
// deno-lint-ignore no-control-regex
const CSI = /^\x1b\[([0-9;:?]*)([@-~])/;

let holdEnabled = false;

/** Restores the terminal's keyboard mode. Safe to call when nothing was set. */
export function restoreKeyboard() {
  if (holdEnabled) {
    write("\x1b[<u"); // pop our kitty flags
    holdEnabled = false;
  }
}

/**
 * Reads keys until the callback returns `true` (meaning: quit).
 *
 * Resolves to whether release events are actually available, so the caller can
 * tell the user whether they got hold-to-talk or the toggle fallback.
 */
export async function readKeys(
  onKey: (event: KeyEvent) => boolean | void,
  { wantHold }: { wantHold: boolean },
): Promise<void> {
  // Piped stdin (CI, smoke tests) has no raw mode; just park forever.
  if (!process.stdin.isTTY) {
    await new Promise<void>(() => {});
    return;
  }

  process.stdin.setRawMode(true);
  const reader = Bun.stdin.stream().getReader();
  try {
    // Ask for the current kitty flags, then for the primary device attributes.
    // Essentially every terminal answers DA, so it acts as a sentinel: once the
    // DA reply arrives we know the kitty reply either came or never will.
    if (wantHold) write("\x1b[?u\x1b[c");

    let pending = "";
    let handshaking = wantHold;
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;

    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });

      if (handshaking && Date.now() > deadline) handshaking = false;

      while (pending.length > 0) {
        const match = CSI.exec(pending);

        if (!match) {
          // Partial sequence — the read may have split it anywhere, including
          // right after the ESC byte. Wait for the rest.
          if (pending.startsWith("\x1b[") || pending === "\x1b") break;
          const char = pending.codePointAt(0)!;
          pending = pending.slice(String.fromCodePoint(char).length);
          // Ctrl+letter arrives as a control byte in the fallback path.
          const event: KeyEvent = char < 0x20
            ? { code: char + 0x60, ctrl: true, type: "press" }
            : { code: char, ctrl: false, type: "press" };
          if (onKey(event) === true) return;
          continue;
        }

        const [raw, params, final] = match;
        pending = pending.slice(raw.length);

        if (final === "u" && params.startsWith("?")) {
          // Kitty capability reply: the protocol is supported.
          if (handshaking) {
            write(`\x1b[>${KITTY_FLAGS}u`);
            holdEnabled = true;
          }
          continue;
        }
        if (final === "c") {
          handshaking = false; // DA reply closes the handshake
          continue;
        }
        if (final !== "u") continue; // some other escape sequence; not ours

        const [codeField, modField = "1"] = params.split(";");
        const [modifiers, eventType = "1"] = modField.split(":");
        const mods = Number(modifiers) - 1;
        if (onKey({
          code: Number(codeField),
          ctrl: (mods & 4) !== 0,
          type: eventType === "3" ? "release" : eventType === "2" ? "repeat" : "press",
        }) === true) return;
      }
    }
  } finally {
    restoreKeyboard();
    reader.releaseLock();
    process.stdin.setRawMode(false);
  }
}

/** Whether key-release events are being delivered. Valid after the handshake. */
export function holdSupported(): boolean {
  return holdEnabled;
}
