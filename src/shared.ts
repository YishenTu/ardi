import type { PiCheck } from "./bridge/protocol";
// So the panel gets it from here, not from the bridge.
export type { PiCheck };
import type { ChatChunk, ChatMessage, ModelState, PiCommand, ThinkingLevel } from "./chat";

// Port name the side panel uses to connect to the background.
export const PANEL_PORT = "sidepanel";

export type PiStatus = "connecting" | "connected" | "disconnected";

// A chat in Ardi's list. `id` is Ardi's local database key. pi's session file
// is the record of the conversation; `piSessionFile` points at it, and the
// bridge resumes it with --session.
export type SessionMeta = {
  id: number;
  title: string;
  piSessionFile?: string;
  createdAt: number;
  updatedAt: number;
};

// What happened since pi started, on top of the history it reported:
// prompts the user sent and chunks pi streamed back. In memory only.
export type LiveItem = { kind: "prompt"; text: string; at: number } | { kind: "chunk"; chunk: ChatChunk };

// Side panel -> background, over the panel's port.
export type PanelRequest =
  | { kind: "prompt"; text: string }
  | { kind: "abort" }
  | { kind: "compact" }
  | { kind: "restart" } // restart pi, same session
  | { kind: "new_session" }
  | { kind: "switch_session"; id: number }
  | { kind: "delete_session"; id: number }
  | { kind: "set_model"; provider: string; modelId: string }
  | { kind: "set_thinking_level"; level: ThinkingLevel };

// Background -> side panel, over the panel's port.
export type PanelUpdate =
  // `history` is null while a saved chat's history loads.
  | { kind: "replay"; status: PiStatus; session: SessionMeta; history: ChatMessage[] | null; live: LiveItem[]; model: ModelState; commands: PiCommand[] }
  | { kind: "model"; model: ModelState }
  | { kind: "status"; status: PiStatus }
  | { kind: "live"; item: LiveItem }
  | { kind: "sessions"; sessions: SessionMeta[]; currentId: number };

export type Settings = {
  // pi's executable. Empty: the pi found by `bun run host:install`.
  piPath: string;
};

// The settings screen's questions, sent with chrome.runtime.sendMessage, and
// their answers.
export type SettingsRequest =
  // The saved settings, and a check of the saved pi path.
  | { kind: "get_settings" }
  // Saves a new pi path if it checks out (empty, back to the installed pi,
  // always saves), then restarts pi if it works.
  | { kind: "set_pi_path"; piPath: string };

// The answer to each kind of SettingsRequest.
export type SettingsAnswers = {
  get_settings: { settings: Settings; check: PiCheck };
  set_pi_path: { saved: boolean; check: PiCheck };
};

