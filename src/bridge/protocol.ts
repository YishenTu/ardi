// Messages between the extension's background and the bridge, over Chrome
// native messaging.
import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, ThinkingLevel } from "../chat";

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
  // exists; otherwise pi starts a new session.
  | { type: "start"; sessionFile?: string; piPath?: string }
  // Runs `pi --version` without starting pi. Answered with `pi_check`.
  | { type: "check_pi"; piPath?: string }
  // Moves the running pi to `sessionFile` if it exists, otherwise to a new session. Answered with `ready`.
  | { type: "open"; sessionFile?: string }
  | { type: "prompt"; text: string; images?: ImageAttachment[]; promptId?: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel };

// Which pi a path leads to: the command run and its version, or why it failed.
export type PiCheck = { command: string; version?: string; error?: string };

// Bridge -> extension.
export type BridgeEvent =
  | { type: "prompt_result"; promptId: string; started: boolean }
  | BrowserRelayEvent
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
