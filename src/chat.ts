// Ardi's chat model, shared by the bridge (which produces it from pi) and the
// extension (which renders it). Modeled on Claudian's ChatMessage/StreamChunk,
// trimmed to what Ardi shows.

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  // Structured result data from pi, by tool: an edit's `patch`, a tab's
  // `{ id, title, url }`, the `list_tabs` array.
  details?: unknown;
};

export type AssistantBlock =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; toolId: string };

export type NoticeLevel = "info" | "warning" | "error";

// An image sent with a message, as pi takes it: base64 `data` and its type.
export type ImageAttachment = { data: string; mimeType: string };

// A message rebuilt from pi's session file.
export type ChatMessage =
  | { role: "user"; id: string; content: string; images?: ImageAttachment[]; timestamp: number }
  // A run: `durationMs` from the user's message to its last entry, which was
  // written at `completedAt`; `outputTokens` summed over the run's replies.
  | {
      role: "assistant";
      id: string;
      blocks: AssistantBlock[];
      toolCalls: ToolCall[];
      timestamp: number;
      completedAt?: number;
      durationMs?: number;
      outputTokens?: number;
      // The user stopped this run.
      interrupted?: boolean;
    }
  | { role: "notice"; id: string; content: string; level: NoticeLevel; timestamp: number };

// A live update while pi runs. A run (run_start .. run_end) renders as one
// assistant message, matching how history merges a run's assistant entries.
export type ChatChunk =
  // A user message pi started: one that starts a run, or a queued one it
  // took mid-run. As pi has it (skill commands expanded).
  | { type: "user"; text: string; images?: ImageAttachment[]; at: number }
  // `at`: when pi started or settled the run (ms since epoch), for the work timer.
  | { type: "run_start"; at: number }
  // `interrupted`: the user stopped the run.
  | { type: "run_end"; at: number; interrupted?: boolean }
  // Output tokens of one model reply within the run.
  | { type: "usage"; outputTokens: number }
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_output"; id: string; content: string }
  | { type: "tool_result"; id: string; content: string; isError: boolean; details?: unknown }
  | { type: "notice"; content: string; level: NoticeLevel };

// A message waiting for pi while it works. `steer`: pi takes it after the
// current step; otherwise once the run would stop.
export type QueuedMessage = { text: string; steer: boolean };

// What the user does to a queued message, named by its place and text in
// the queue they saw (pi may have taken or moved messages since; the text
// decides): steer it, take it back to the message box to edit, or remove it.
export type QueueAction = { action: "steer" | "edit" | "remove"; index: number; text: string };

// pi's reasoning effort levels.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// A model pi can use, and the thinking levels it supports.
export type ModelInfo = { provider: string; id: string; name: string; thinkingLevels: ThinkingLevel[] };

// pi's models and which one the session is on. pi records model changes in
// the session file, so a resumed chat comes back on its model.
export type ModelState = {
  models: ModelInfo[];
  current?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
};

// A pi slash command, such as a skill (`skill:name`). Sent as a prompt
// starting with `/name`.
export type PiCommand = { name: string; description?: string };
