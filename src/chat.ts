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

// A message rebuilt from pi's session file.
export type ChatMessage =
  | { role: "user"; id: string; content: string; timestamp: number }
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
