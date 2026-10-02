// liquen.ts — the door client. Speaks liquen's door protocol directly (../liquen/src/door.ts):
// newline-separated JSON over data/agents/<user>/door.sock, requests answered in order, and
// after a `tail` the same connection pushes {event}, {delta} and {status} lines. A line with
// `ok` is a reply; anything else is a push. Every request names the session (`mind` unless
// chiche runs with --session), so `liquen repl --session <name>` shows the same room.

import { TextLineStream } from "@std/streams";

/** The shape of a door event we care about (a subset of liquen's Event). */
export interface DoorEvent {
  id: string;
  ts: string;
  type: string;
  envelope?: { conversation?: { address?: string }; sender?: { name?: string } };
  /** `stop_reason` is stamped on the last event of a model step: `end_turn` ends the turn. */
  payload?: { turn_id?: string; ref_id?: string; stop_reason?: string };
  /** `consumed`: the last event the step that wrote this message had read (UUIDv7 order). */
  extra?: { silence?: boolean; consumed?: string };
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
  readonly session: string;
  #conn: Deno.UnixConn;
  #on: DoorEvents;
  #awaiting: ((r: Reply) => void)[] = [];
  #writes: Promise<void> = Promise.resolve();
  #closing = false;

  private constructor(user: string, session: string, conn: Deno.UnixConn, on: DoorEvents) {
    this.user = user;
    this.session = session;
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

  /** Connect and `tail` `session` (naming it is what births it); throws when nothing answers.
   *  The session thinks with the model config.jsonc gives the agent, and its shell starts in
   *  `shell` (liquen's shell keeps its directory between commands). */
  static async connect(
    dir: string,
    user: string,
    session: string,
    shell: string,
    on: DoorEvents,
  ): Promise<Door> {
    const conn = await Deno.connect({ transport: "unix", path: Door.socket(dir, user) });
    const door = new Door(user, session, conn, on);
    const t = await door.request({ op: "tail", session, cwd: shell });
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

  /** The coding agent's conversation: `<session>@<user>`. */
  get address() {
    return `${this.session}@${this.user}`;
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

  /** A message from the principal to the coding agent's session → `{ok, id}`. */
  message(text: string): Promise<Reply> {
    return this.request({
      op: "message",
      text,
      session: this.session,
      sender: { address: this.user, name: this.user },
    });
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

/** The coding agent's own words in its mind's room: not a silence, with text. */
function spoken(e: DoorEvent, address: string): boolean {
  return e.type === "message" && e.payload?.turn_id !== undefined &&
    e.envelope?.conversation?.address === address && e.extra?.silence !== true && textOf(e) !== "";
}

/** The coding agent's reply: what it says as its turn ends. */
export function isReply(e: DoorEvent, address: string): boolean {
  return spoken(e, address) && e.payload?.stop_reason === "end_turn";
}

/**
 * What the coding agent says between two steps of a turn ("Let me build contact sheets to
 * actually see them"): a note on its way, not a reply. liquen sends it as a message like any
 * other; the missing `end_turn` tells them apart.
 */
export function isSaying(e: DoorEvent, address: string): boolean {
  return spoken(e, address) && e.payload?.stop_reason !== "end_turn";
}

/**
 * The summary of the coding agent's thinking in its mind's room, one per step that thought:
 * both of liquen's transports ask the model for a summary, never the full reasoning.
 */
export function thoughtOf(e: DoorEvent, address: string): string | undefined {
  if (e.type !== "thinking" || e.envelope?.conversation?.address !== address) return undefined;
  const data = e.parts?.[0]?.data as { thinking?: string } | undefined;
  return data?.thinking?.trim() || undefined;
}

/** The last event the coding agent had read when it wrote this: the requests it answers. */
export function consumedOf(e: DoorEvent): string | undefined {
  return e.extra?.consumed;
}

/** A tool call the coding agent made: its name and a clipped rendering of the input. */
export function toolUseOf(e: DoorEvent): { name: string; input: string } | undefined {
  if (e.type !== "tool_use") return undefined;
  const data = e.parts?.[0]?.data as { name?: string; input?: unknown } | undefined;
  if (!data?.name) return undefined;
  return { name: data.name, input: clip(inputLine(data.input).replace(/\s+/g, " "), 200) };
}

/** A tool's input in one line: bash's command, a path, a URL, else its first string, else JSON. */
function inputLine(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const first = [o.command, o.path, o.url, ...Object.values(o)].find((v) =>
      typeof v === "string"
    );
    if (typeof first === "string") return first;
  }
  return JSON.stringify(input ?? {});
}

export function errorOf(e: DoorEvent): string | undefined {
  if (e.type !== "error") return undefined;
  const data = e.parts?.[0]?.data as { error?: string } | undefined;
  return data?.error ?? "unknown error";
}

export function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
