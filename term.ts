// term.ts — the terminal. Lines scroll. On a real terminal the bottom rows are pinned (a scroll
// region): the transcript being spoken, then the meters, which main.ts redraws a few times a
// second. A transcript joins the scrolling lines once it ends, so they only ever get whole
// lines: a redraw never lands mid-line, where saving and restoring the cursor can lose a
// pending wrap. Into a pipe, only the lines, a transcript growing on its own.

export const DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
export const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m";

const encoder = new TextEncoder();

export class Terminal {
  /** The transcript under way: who speaks, and what so far. */
  #live: { who: string; text: string } | undefined;
  /** The pinned rows (the transcript's and the status'), when pinned. */
  #pinned = 0;
  #rows = 0;
  #cols = 0;
  #status: string[] = [];
  #resize = () => {
    this.#size();
    this.#region();
    this.#draw();
  };

  /** The width a status line gets. */
  get cols() {
    return this.#cols;
  }

  #raw(s: string) {
    Deno.stdout.writeSync(encoder.encode(s));
  }
  #write(s: string) {
    // "\r\n": the terminal is raw once the keys are read, and a raw "\n" doesn't return
    this.#raw(s.replaceAll("\n", "\r\n"));
  }
  /** The transcript under way ends: it joins the lines. */
  end() {
    const live = this.#live;
    if (!live) return;
    this.#live = undefined;
    this.#write(this.#pinned ? `${live.who} ${live.text.trim()}\n` : "\n");
    this.#draw();
  }
  line(text: string) {
    if (!this.#pinned) this.end();
    this.#write(text + "\n");
  }
  dim(text: string) {
    this.line(`${DIM}${text}${RESET}`);
  }
  error(text: string) {
    this.line(`${RED}${text}${RESET}`);
  }
  /** A live transcript fragment from `who`. */
  say(who: string, fragment: string, finished: boolean) {
    if (this.#live?.who !== who) {
      this.end();
      this.#live = { who, text: "" };
      if (!this.#pinned) this.#write(`${who} `);
    }
    this.#live.text += fragment;
    if (!this.#pinned) this.#write(fragment);
    if (finished) this.end();
    else this.#draw();
  }

  /** Keep the bottom rows for the transcript under way and `rows` of status. Nothing on a pipe. */
  pin(rows: number) {
    if (!Deno.stdout.isTerminal() || this.#pinned) return;
    this.end();
    this.#pinned = rows + 1;
    this.#size();
    // make room below the cursor, then scroll only above it
    this.#write("\n".repeat(this.#pinned) + `\x1b[${this.#pinned}A`);
    this.#region();
    Deno.addSignalListener("SIGWINCH", this.#resize);
  }

  /** Give the rows back, leaving the last status on screen above the prompt. */
  unpin() {
    if (!this.#pinned) return;
    this.end();
    Deno.removeSignalListener("SIGWINCH", this.#resize);
    this.#raw(`\x1b[r\x1b[${this.#rows};1H\r\n`);
    this.#pinned = 0;
  }

  /** The status rows' content, one string per row; redrawn only when it changed. */
  status(lines: string[]) {
    if (!this.#pinned || lines.join("\n") === this.#status.join("\n")) return;
    this.#status = lines;
    this.#draw();
  }

  #size() {
    const s = Deno.consoleSize();
    this.#rows = s.rows;
    this.#cols = s.columns;
  }
  #region() {
    this.#raw(`\x1b7\x1b[1;${this.#rows - this.#pinned}r\x1b8`);
  }
  #draw() {
    if (!this.#pinned) return;
    const live = this.#live ? `${this.#live.who} ${tail(this.#live.text, this.#cols - 4)}` : "";
    const rows = [live, ...this.#status];
    let s = "\x1b7";
    for (let i = 0; i < this.#pinned; i++) {
      const row = this.#rows - this.#pinned + 1 + i;
      s += `\x1b[${row};1H\x1b[2K${fit(rows[i] ?? "", this.#cols)}`;
    }
    this.#raw(s + "\x1b8");
  }
}

const ESCAPE = new RegExp(`^${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`);

/** Columns a character takes: emoji and the like two, a variation selector none. */
function width(ch: string) {
  const cp = ch.codePointAt(0)!;
  if (cp === 0xfe0f || cp === 0x200d) return 0;
  return cp > 0xffff ? 2 : 1;
}

/** `s` cut to `cols` columns (escape sequences take none). */
function fit(s: string, cols: number) {
  let out = "", seen = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(ESCAPE);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    i += ch.length;
    seen += width(ch);
    if (seen <= cols) out += ch;
  }
  return out + RESET;
}

/** The end of plain `text` that fits in `cols` columns, "…" first when cut. */
function tail(text: string, cols: number) {
  const chars = [...text.trim().replaceAll(/[\r\n]+/g, " ")];
  let used = 0, i = chars.length;
  while (i > 0 && used + width(chars[i - 1]) <= cols) used += width(chars[--i]);
  return i ? `…${chars.slice(i + 1).join("")}` : text;
}

// ── meters ──────────────────────────────────────────────────────────────────

/** The meters' scale starts here: a quiet room reads around -75 dBFS on a headset (measured). */
const FLOOR_DB = -80;
const FALL_DB_PER_S = 30;
const PEAK_HOLD_MS = 1500;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A level meter: jumps up at once, falls at 30 dB/s, and holds its peak for 1.5 s. */
export class Meter {
  #shown = -100;
  #peak = -100;
  #peakAt = 0;
  #t = performance.now();

  /** Feed a reading (dBFS) and draw `width` cells: green, yellow from -20 dB, red from -6. */
  draw(db: number, width: number): string {
    const now = performance.now();
    const fall = FALL_DB_PER_S * (now - this.#t) / 1000;
    this.#t = now;
    this.#shown = Math.max(db, this.#shown - fall);
    if (db >= this.#peak) {
      this.#peak = db;
      this.#peakAt = now;
    } else if (now - this.#peakAt > PEAK_HOLD_MS) {
      this.#peak = Math.max(this.#shown, this.#peak - fall);
    }
    const cells = (x: number) => Math.max(0, Math.min(1, (x - FLOOR_DB) / -FLOOR_DB)) * width;
    const fill = cells(this.#shown);
    const peak = Math.min(width - 1, Math.floor(cells(this.#peak)));
    let out = "";
    for (let i = 0; i < width; i++) {
      const db = FLOOR_DB + (i + 1) / width * -FLOOR_DB;
      const color = db > -6 ? RED : db > -20 ? YELLOW : GREEN;
      const part = fill - i;
      if (part >= 1) out += `${color}█`;
      else if (part > 0) out += `${color}${EIGHTHS[Math.floor(part * 8)] || " "}`;
      else if (i === peak && this.#peak > FLOOR_DB) out += `${color}▏`;
      else out += `${DIM}·`;
    }
    return `${out}${RESET}`;
  }

  /** The level as text, fixed width. */
  static db(db: number) {
    return db <= -100 ? "  -∞ dB" : `${db.toFixed(0).padStart(4)} dB`;
  }
}
