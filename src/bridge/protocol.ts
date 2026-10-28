// Messages between the extension's background and the bridge, over Chrome
// native messaging.
import type { ChatChunk, ChatMessage, ModelState, PiCommand, ThinkingLevel } from "../chat";

// Extension -> bridge.
export type BridgeRequest =
  // Starts pi (`piPath`, or the installed pi). Resumes `sessionFile` if it
  // exists; otherwise pi starts a new session.
  | { type: "start"; sessionFile?: string; piPath?: string }
  // Runs `pi --version` without starting pi. Answered with `pi_check`.
  | { type: "check_pi"; piPath?: string }
  // Moves the running pi to `sessionFile` if it exists, otherwise to a new session. Answered with `ready`.
  | { type: "open"; sessionFile?: string }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel };

// Which pi a path leads to: the command run and its version, or why it failed.
export type PiCheck = { command: string; version?: string; error?: string };

// Bridge -> extension.
export type BridgeEvent =
  // A saved session's history, read from its file as soon as `start` or
  // `open` asks for it, so the chat shows while pi starts or switches.
  | { type: "history"; sessionFile: string; history: ChatMessage[] }
  // pi is up, or switched session: the session file pi is on, and its history so far.
  | { type: "ready"; sessionFile?: string; history: ChatMessage[]; model: ModelState; commands: PiCommand[] }
  // The model or thinking level changed.
  | { type: "model"; model: ModelState }
  | { type: "chunk"; chunk: ChatChunk }
  | ({ type: "pi_check" } & PiCheck)
  // pi failed to start or exited; the bridge exits after sending this.
  | { type: "fatal"; message: string };

// Chrome caps a message from the bridge at 1 MB, and a long chat's history is
// bigger. So the bridge sends a large event as consecutive `part`s of its
// JSON, and `joinParts` puts them back together. Parts never interleave:
// the bridge writes each event's parts in one go.
export type BridgePart = { type: "part"; data: string; last: boolean };

// Wraps a bridge event listener to accept parts.
export function joinParts(listener: (event: BridgeEvent) => void): (message: BridgeEvent | BridgePart) => void {
  let pending = "";
  return (message) => {
    if (message.type !== "part") return listener(message);
    pending += message.data;
    if (!message.last) return;
    const json = pending;
    pending = "";
    listener(JSON.parse(json) as BridgeEvent);
  };
}
