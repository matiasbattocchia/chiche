/**
 * mu.ts — agent 2, the builder, reached through its door.
 *
 * An ordinary mu attach client (the same path `mu repl` and `mu cli` take): connect to
 * `data/agents/<name>/door.sock`, raising an ephemeral daemon if nothing answers, publish
 * the principal's lines, and read what the tail pushes back. What differs is the consumer
 * — no human is watching this transcript, so it is not painted. It is flattened into
 * three kinds of update, because that is all the voice agent can act on:
 *
 *   activity — mu is working: a tool call, a thought, a failed step. Context, not news.
 *   final    — mu answered. This is what gets said out loud.
 *   error    — the harness broke, which the user is owed either way.
 *
 * Thinking arrives as a delta storm; it is accumulated and released as one activity line
 * at the next event boundary, so a minute of reasoning costs one line instead of hundreds.
 *
 * mu's life is its attachments: `attach` raises an ephemeral daemon when nothing answers
 * the door, and that daemon reaps itself a linger (30s) after the last client detaches. So
 * quitting the REPL takes agent 2 down with it, without this file owning a process.
 */

import { attach, resolveAgent, wire } from "@mu/attach.ts";
import { describeCall } from "@mu/describe.ts";
import { outcomeLine, ownVoice, silent } from "@mu/render.ts";
import { MIND } from "@mu/session.ts";
import type { Delta, Event, Part, SessionRef } from "@mu/types.ts";

export type MuUpdate =
  | { kind: "activity"; text: string }
  | { kind: "final"; text: string }
  | { kind: "error"; text: string };

export interface Mu {
  /** The agent this client fronts — mu's roster name, not ours. */
  readonly agent: string;
  /** Resolves only on an unasked-for hangup; a close() of ours never fires it. */
  readonly hangup: Promise<void>;
  /** Publishes one line. Resolves as soon as the door acks: mu's work comes back later. */
  send(text: string): Promise<{ ok: boolean; error?: string }>;
  close(): void;
}

/** One thought, as much of it as is worth carrying. */
const THINKING_MAX = 240;

const clip = (s: string, max: number) => s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const textOf = (parts: Part[]) =>
  parts.filter((p) => p.type === "text").map((p) => p.text).join(" ");

export async function connectMu(onUpdate: (u: MuUpdate) => void): Promise<Mu> {
  const a = await resolveAgent();

  const conn = await attach(a);
  const me: SessionRef = { id: MIND, agentId: a.target };
  // Where a reply to *us* lands, as against a send to a peer — which is work, and reads as
  // activity. mu writes the pair as `mind@agent`; its own REPL still spells it `mind:agent`,
  // so both are accepted rather than betting on which one this build emits.
  const home = new Set([`${MIND}@${a.target}`, `${MIND}:${a.target}`]);

  let thinking = "";
  const flushThinking = () => {
    const text = thinking.trim();
    thinking = "";
    if (text) onUpdate({ kind: "activity", text: `pensando: ${clip(text, THINKING_MAX)}` });
  };

  const event = (e: Event): void => {
    switch (e.type) {
      case "message": {
        // Our own line echoing back off the log is not news.
        if (!ownVoice(e, me)) return;
        flushThinking();
        if (silent(e)) return; // the turn chose to say nothing
        const text = textOf(e.parts);
        if (!text) return;
        const to = e.envelope.conversation.address;
        if (home.has(to)) onUpdate({ kind: "final", text });
        else onUpdate({ kind: "activity", text: `mensaje a ${to}: ${clip(text, THINKING_MAX)}` });
        return;
      }
      case "tool_use": {
        flushThinking();
        const data = e.parts[0]?.data;
        onUpdate({ kind: "activity", text: data ? describeCall(data) : "usó una herramienta" });
        return;
      }
      case "tool_result": {
        // A deferred outcome is the harness reporting on a call that outlived its turn.
        if (e.payload?.deferred) {
          onUpdate({ kind: "activity", text: outcomeLine(e, THINKING_MAX) });
        } else if (e.parts[0]?.data?.is_error) {
          onUpdate({ kind: "activity", text: "esa herramienta falló" });
        }
        return;
      }
      case "permission_request": {
        // Nothing here answers cards: this org runs allow-by-default. If one ever fires,
        // mu stalls — so it is surfaced, and the voice agent can at least say why.
        flushThinking();
        const detail = e.parts[0]?.data?.detail ?? "(sin detalle)";
        onUpdate({
          kind: "activity",
          text: `mu espera una aprobación que nadie puede dar: ${detail}`,
        });
        return;
      }
      case "error": {
        flushThinking();
        onUpdate({ kind: "error", text: JSON.stringify(e.parts[0]?.data ?? {}) });
        return;
      }
    }
  };

  const delta = (d: Delta): void => {
    if (d.kind === "thinking") thinking += d.text ?? "";
    else if (d.kind === "error") onUpdate({ kind: "error", text: d.text ?? "" });
  };

  const w = wire(conn, { event, delta });
  // Closing the socket ends the pump too, so only an *unasked-for* hangup is news; a
  // clean leave resolves nothing, and the promise dies with the process.
  let leaving = false;
  const hangup = new Promise<void>((resolve) => {
    w.hangup.then(() => {
      if (leaving) return;
      onUpdate({ kind: "error", text: "mu colgó la conexión" });
      resolve();
    });
  });
  await w.request({ op: "tail" }); // live: we want the present, not the log's past

  return {
    agent: a.target,
    hangup,
    async send(text: string) {
      const r = await w.request({
        op: "message",
        text,
        sender: { address: a.username, name: a.username },
      });
      return { ok: r.ok === true, error: r.error };
    },
    close() {
      leaving = true;
      try {
        conn.close();
      } catch { /* already gone */ }
    },
  };
}
