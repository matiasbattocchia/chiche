// keys.ts — chiche's own keys, read from its terminal: push to talk (held) and a toggle.
//
// A terminal reports no key releases by default. With the kitty keyboard protocol (foot, kitty,
// ghostty, wezterm, …) it does: chiche pushes flags 1|2|8 (disambiguate, event types, every key
// as an escape code) and reads `CSI code;mods:event u`, event 1 press, 2 repeat, 3 release.
// The terminal's answer to `CSI ? u` says whether it took them. Elsewhere a held key shows
// through its auto-repeat, and the release is the repeat stopping. Focus reporting
// (`CSI ? 1004 h`) releases every held key when the terminal loses focus, since the release
// would go to another window.
//
// The terminal is raw while chiche runs: Ctrl-C arrives as a key, not as SIGINT.

export interface KeyEvents {
  /** The push-to-talk key went down (true) or up (false). */
  push(down: boolean): void;
  toggle(): void;
  quit(): void;
}

export interface KeyOptions {
  /** Code points; undefined turns the key off. */
  push?: number;
  toggle?: number;
}

const FLAGS = 1 | 2 | 8;
/** Without releases: the first auto-repeat comes after the repeat delay (600 ms is sway's
 * default), the next ones every 1/rate (40 ms at 25/s). */
const FIRST_REPEAT_MS = 700;
const NEXT_REPEAT_MS = 150;

/** "space", a single character, or "none" / "" for no key. */
export function keyCode(name: string): number | undefined {
  const n = name.trim().toLowerCase();
  if (n === "" || n === "none") return undefined;
  if (n === "space") return 32;
  if ([...n].length === 1) return n.codePointAt(0);
  throw new Error(`unknown key "${name}": use a single character, "space" or "none"`);
}

export function keyName(code: number) {
  return code === 32 ? "space" : String.fromCodePoint(code);
}

export class Keys {
  #o: KeyOptions;
  #on: KeyEvents;
  #buf = "";
  /** The terminal reports releases (kitty protocol). */
  #exact = false;
  /** Keys down, with the timer that infers their release when the terminal can't report it. */
  #down = new Map<number, { timer?: ReturnType<typeof setTimeout>; repeats: boolean }>();
  #stopped = false;

  private constructor(o: KeyOptions, on: KeyEvents) {
    this.#o = o;
    this.#on = on;
  }

  /** undefined when stdin is not a terminal. */
  static start(o: KeyOptions, on: KeyEvents): Keys | undefined {
    if (!Deno.stdin.isTerminal()) return undefined;
    const k = new Keys(o, on);
    Deno.stdin.setRaw(true);
    // push the flags, turn on focus reports, then ask which flags took
    k.#write(`\x1b[>${FLAGS}u\x1b[?1004h\x1b[?u`);
    globalThis.addEventListener("unload", () => k.stop());
    k.#read().catch(() => {});
    return k;
  }

  /** Whether releases are reported, rather than inferred from the auto-repeat. */
  get exact() {
    return this.#exact;
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const d of this.#down.values()) clearTimeout(d.timer);
    this.#write("\x1b[<u\x1b[?1004l");
    try {
      Deno.stdin.setRaw(false);
    } catch { /* not a terminal any more */ }
  }

  #write(s: string) {
    Deno.stdout.writeSync(new TextEncoder().encode(s));
  }

  async #read() {
    const decoder = new TextDecoder();
    for await (const bytes of Deno.stdin.readable) {
      if (this.#stopped) return;
      this.#buf += decoder.decode(bytes, { stream: true });
      this.#parse();
    }
  }

  #parse() {
    while (this.#buf) {
      if (this.#buf[0] !== "\x1b") {
        const ch = String.fromCodePoint(this.#buf.codePointAt(0)!);
        this.#buf = this.#buf.slice(ch.length);
        if (ch === "\x03") this.#on.quit();
        else this.#guess(ch.toLowerCase().codePointAt(0)!);
        continue;
      }
      // after the Esc
      const m = /^\[([?>]?)([\d:;]*)([A-Za-z~])/.exec(this.#buf.slice(1));
      if (!m) {
        if (/^(\[[?>]?[\d:;]*)?$/.test(this.#buf.slice(1))) return; // the rest is on its way
        this.#buf = this.#buf.slice(1); // a lone Esc, or something not ours
        continue;
      }
      this.#buf = this.#buf.slice(1 + m[0].length);
      const [, prefix, params, final] = m;
      if (prefix === "?" && final === "u") {
        const flags = Number(params);
        this.#exact = (flags & 2) !== 0 && (flags & 8) !== 0;
      } else if (prefix === "" && final === "O" && params === "") {
        for (const code of [...this.#down.keys()]) this.#key(code, 3); // focus lost
      } else if (prefix === "" && final === "u") {
        const [key, mods] = params.split(";");
        const code = Number(key.split(":")[0]);
        const [modifiers, event] = (mods ?? "1").split(":").map(Number);
        const ctrl = ((modifiers || 1) - 1 & 4) !== 0;
        if (ctrl && code === 99) {
          if (event !== 3) this.#on.quit();
        } else if (!ctrl) this.#key(code, event || 1);
      }
    }
  }

  /** A plain character: no release will be reported, so infer it from the auto-repeat. */
  #guess(code: number) {
    const d = this.#down.get(code);
    if (d) {
      clearTimeout(d.timer);
      d.repeats = true;
    } else this.#key(code, 1);
    const held = this.#down.get(code);
    if (!held) return; // not one of ours
    held.timer = setTimeout(
      () => this.#key(code, 3),
      held.repeats ? NEXT_REPEAT_MS : FIRST_REPEAT_MS,
    );
  }

  /** event: 1 press, 2 repeat, 3 release. */
  #key(code: number, event: number) {
    if (code !== this.#o.push && code !== this.#o.toggle) return;
    const d = this.#down.get(code);
    if (event === 1 && !d) {
      this.#down.set(code, { repeats: false });
      if (code === this.#o.push) this.#on.push(true);
      else this.#on.toggle();
    } else if (event === 3 && d) {
      clearTimeout(d.timer);
      this.#down.delete(code);
      if (code === this.#o.push) this.#on.push(false);
    }
  }
}
