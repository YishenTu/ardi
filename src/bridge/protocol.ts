// Messages between the extension's background and the bridge, over Chrome
// native messaging.
import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueueAction, QueuedMessage, ThinkingLevel } from "../chat";

// A target can let pi's tools reach the extension through the bridge: the
// bridge serves a local relay (URL and bearer token in these variables, for
// pi only) and forwards each call as a `browser_request`. Only the target
// reads the request; the bridge and background route it unread.
export const RELAY_URL_ENV = "ARDI_BROWSER_URL";
export const RELAY_TOKEN_ENV = "ARDI_BROWSER_TOKEN";
export type BrowserReply = { type: "browser_reply"; id: string; result?: unknown; error?: string };
export type BrowserRelayEvent =
  | { type: "browser_request"; id: string; request: unknown }
  | { type: "browser_cancel"; id: string };

// Extension -> bridge.
export type BridgeRequest =
  | BrowserReply
  // Starts pi (`piPath`, or the installed pi). Resumes `sessionFile` if it
  // exists; otherwise pi starts a new session. A bridge's pi stays on that
  // session for life: each chat has its own bridge.
  | { type: "start"; sessionFile?: string; piPath?: string }
  // Runs `pi --version` without starting pi. Answered with `pi_check`.
  | { type: "check_pi"; piPath?: string }
  // pi starts a run with it, or while it works queues it: to take after its
  // current step (`steer`) or once done. The chat shows it as a `user` chunk
  // once pi starts it; if pi rejects it, it comes back as `restore`.
  | { type: "prompt"; text: string; images?: ImageAttachment[]; promptId?: string; steer?: boolean }
  // An `edit` comes back as `restore`.
  | ({ type: "queue_action" } & QueueAction)
  // Stops pi. Queued messages come back as `restore` instead of running.
  | { type: "abort" }
  | { type: "compact" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel };

// Which pi a path leads to: the command run and its version, or why it failed.
export type PiCheck = { command: string; version?: string; error?: string };

// Bridge -> extension: what pi reports about the session it's on.
export type SessionUpdate =
  // A saved session's history, read from its file as soon as `start` asks
  // for it, so the chat shows while pi starts.
  | { type: "history"; sessionFile: string; history: ChatMessage[] }
  // pi is up: the session file it's on, and its history so far.
  | { type: "ready"; sessionFile?: string; history: ChatMessage[]; model: ModelState; commands: PiCommand[] }
  // The model or thinking level changed.
  | { type: "model"; model: ModelState }
  | { type: "chunk"; chunk: ChatChunk }
  // The messages waiting for pi, steering first.
  | { type: "queue"; queue: QueuedMessage[] };

// Bridge -> extension.
export type BridgeEvent =
  | SessionUpdate
  | { type: "prompt_result"; promptId: string; started: boolean }
  // Whether the bridge has work left: a run, a queue, input on its way to pi
  // or a compaction. Sent on change, after the events that work produced
  // (`prompt_result`, `restore`). `requests`: how many requests other than
  // `browser_reply` it had received, so the extension can
  // tell an idle report from before its latest request. The extension stops
  // a chat off screen only once it's idle with every request counted.
  | { type: "busy"; busy: boolean; requests: number }
  | BrowserRelayEvent
  // Messages taken back (a stop, an edit, or rejected by pi), for the message box.
  | { type: "restore"; text: string; images?: ImageAttachment[] }
  | ({ type: "pi_check" } & PiCheck)
  // pi failed to start or exited; the bridge exits after sending this.
  | { type: "fatal"; message: string };
