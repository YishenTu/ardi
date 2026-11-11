// Messages between the extension's background and the bridge, over Chrome
// native messaging.
import type { TabMention } from "../mention";
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
  // exists; otherwise pi starts a new session. `epoch` (also on `open`)
  // labels the events about the session it puts pi on (`SessionEvent`), so
  // the extension can tell them from those about a session it left.
  | { type: "start"; sessionFile?: string; piPath?: string; epoch: number }
  // Runs `pi --version` without starting pi. Answered with `pi_check`.
  | { type: "check_pi"; piPath?: string }
  // The tabs the user may @ mention. Answered with `tabs`.
  | { type: "list_tabs" }
  // Moves the running pi to `sessionFile` if it exists, otherwise to a new session. Answered with `ready`.
  | { type: "open"; sessionFile?: string; epoch: number }
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

// Bridge -> extension: what pi reports about the session it's on. Sent as a
// SessionEvent, labelled with the epoch of the `start` or `open` that put
// pi on that session.
export type SessionUpdate =
  // A saved session's history, read from its file as soon as `start` or
  // `open` asks for it, so the chat shows while pi starts or switches.
  | { type: "history"; sessionFile: string; history: ChatMessage[] }
  // pi is up, or switched session: the session file pi is on, and its history so far.
  | { type: "ready"; sessionFile?: string; history: ChatMessage[]; model: ModelState; commands: PiCommand[] }
  // The model or thinking level changed.
  | { type: "model"; model: ModelState }
  | { type: "chunk"; chunk: ChatChunk }
  // The messages waiting for pi, steering first.
  | { type: "queue"; queue: QueuedMessage[] };
export type SessionEvent = SessionUpdate & { epoch: number };

// Bridge -> extension.
export type BridgeEvent =
  | SessionEvent
  | { type: "prompt_result"; promptId: string; started: boolean }
  | BrowserRelayEvent
  // Messages taken back (a stop, an edit, or rejected by pi), for the message box.
  | { type: "restore"; text: string; images?: ImageAttachment[] }
  | ({ type: "pi_check" } & PiCheck)
  // null: the target doesn't narrow them, so any open tab will do.
  | { type: "tabs"; tabs: TabMention[] | null }
  // pi failed to start or exited; the bridge exits after sending this.
  | { type: "fatal"; message: string };
