// liquen.ts — the door client. Speaks liquen's door protocol directly (../liquen/src/door.ts):
// newline-separated JSON over data/agents/<user>/door.sock, requests answered in order, and
// after a `tail` the same connection pushes {event}, {delta} and {status} lines. A line with
// `ok` is a reply; anything else is a push. The session is `mind`, the default, shared with
// the REPL.

import { TextLineStream } from "@std/streams";

/** The builder's model. */
const MODEL = "claude-opus-5-5";

/** The shape of a door event we care about (a subset of liquen's Event). */
export interface DoorEvent {
  id: string;
  ts: string;
  type: string;
  envelope?: { conversation?: { address?: string }; sender?: { name?: string } };
  payload?: { turn_id?: string; ref_id?: string };
  extra?: { silence?: boolean };
  parts?: { type: string; kind?: string; text?: string; data?: unknown }[];
}

export interface Delta {
  kind: "text" | "thinking" | "checkpoint" | "error";
  text?: string;
}

export interface Status {
  status: "idle" | "busy";
  after?: string;
}

export interface Reply {
  ok: boolean;
  error?: string;
  id?: string;
  [k: string]: unknown;
}

export interface DoorEvents {
  event(e: DoorEvent): void;
  delta(d: Delta): void;
  status(s: Status): void;
  /** The connection ended: liquen went away, or we closed it (`expected`). */
  hangup(expected: boolean): void;
  /** Every line on the wire, for the timeline. */
  trace?(direction: "send" | "recv", line: unknown): void;
}

export class Door {
  readonly user: string;
  #conn: Deno.UnixConn;
  #on: DoorEvents;
  #awaiting: ((r: Reply) => void)[] = [];
  #writes: Promise<void> = Promise.resolve();
  #closing = false;

  private constructor(user: string, conn: Deno.UnixConn, on: DoorEvents) {
    this.user = user;
    this.#conn = conn;
    this.#on = on;
    this.#pump().catch(() => {}).finally(() => {
      for (const settle of this.#awaiting.splice(0)) {
        settle({ ok: false, error: "the door hung up" });
      }
      this.#on.hangup(this.#closing);
    });
  }

  /** The socket of `<user>`'s agent under `dir` (liquen's data folder). */
  static socket(dir: string, user: string) {
    return `${dir}/agents/${user}/door.sock`;
  }

  /** Connect and `tail`; throws when nothing answers. While the connection lives, the
   *  session thinks with `MODEL` at the roster's effort, and its shell starts in `shell`
   *  (liquen's shell keeps its directory between commands). */
  static async connect(dir: string, user: string, shell: string, on: DoorEvents): Promise<Door> {
    const conn = await Deno.connect({ transport: "unix", path: Door.socket(dir, user) });
    const door = new Door(user, conn, on);
    const t = await door.request({ op: "tail", cwd: shell, model: MODEL });
    if (!t.ok) {
      door.close();
      throw new Error(`tail refused: ${t.error}`);
    }
    return door;
  }

  /** Whether a door answers on the socket right now. */
  static async answers(dir: string, user: string): Promise<boolean> {
    try {
      const conn = await Deno.connect({ transport: "unix", path: Door.socket(dir, user) });
      conn.close();
      return true;
    } catch {
      return false;
    }
  }

  /** The builder's conversation: `mind@<user>`. */
  get address() {
    return `mind@${this.user}`;
  }

  request(req: Record<string, unknown>): Promise<Reply> {
    const reply = new Promise<Reply>((resolve) => this.#awaiting.push(resolve));
    this.#on.trace?.("send", req);
    this.#writes = this.#writes.then(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(req) + "\n");
      for (let at = 0; at < bytes.length;) at += await this.#conn.write(bytes.subarray(at));
    }).catch(() => {/* the pump reports the hang-up */});
    return reply;
  }

  /** A message from the principal to the builder's mind → `{ok, id}`. */
  message(text: string): Promise<Reply> {
    return this.request({ op: "message", text, sender: { address: this.user, name: this.user } });
  }

  close() {
    this.#closing = true;
    try {
      this.#conn.close();
    } catch { /* already closed */ }
  }

  async #pump() {
    const lines = this.#conn.readable.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TextLineStream(),
    );
    for await (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      this.#on.trace?.("recv", msg);
      if (msg.event) this.#on.event(msg.event as DoorEvent);
      else if (msg.delta) this.#on.delta(msg.delta as Delta);
      else if (msg.ok !== undefined) this.#awaiting.shift()?.(msg as Reply);
      else if (msg.status !== undefined) this.#on.status(msg as Status);
    }
  }
}

/** The text parts of an event, joined. */
export function textOf(e: DoorEvent): string {
  return (e.parts ?? []).filter((p) => p.type !== "data")
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join(" ");
}

/** The builder's reply: its own message in its mind's room, not a silence, with text. */
export function isReply(e: DoorEvent, address: string): boolean {
  return e.type === "message" && e.payload?.turn_id !== undefined &&
    e.envelope?.conversation?.address === address && e.extra?.silence !== true && textOf(e) !== "";
}

/** A tool call the builder made: its name and a clipped rendering of the input. */
export function toolUseOf(e: DoorEvent): { name: string; input: string } | undefined {
  if (e.type !== "tool_use") return undefined;
  const data = e.parts?.[0]?.data as { name?: string; input?: unknown } | undefined;
  if (!data?.name) return undefined;
  return { name: data.name, input: clip(JSON.stringify(data.input ?? {}), 200) };
}

/** The builder's thinking before a step, its last paragraph: what it is about to do, in words. */
export function thinkingOf(e: DoorEvent): string | undefined {
  if (e.type !== "thinking") return undefined;
  const data = e.parts?.[0]?.data as { thinking?: unknown } | undefined;
  if (typeof data?.thinking !== "string") return undefined;
  const last = data.thinking.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).at(-1);
  return last ? clip(last, 300) : undefined;
}

export function errorOf(e: DoorEvent): string | undefined {
  if (e.type !== "error") return undefined;
  const data = e.parts?.[0]?.data as { error?: string } | undefined;
  return data?.error ?? "unknown error";
}

export function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
