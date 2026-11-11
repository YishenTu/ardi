import type { PiCheck } from "./bridge/protocol";
import type { TabMention } from "./mention";
// So the panel gets it from here, not from the bridge.
export type { PiCheck };
import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueueAction, QueuedMessage, ThinkingLevel } from "./chat";

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

// Side panel -> background, over the panel's port.
export type PanelRequest =
  // `steer`: if pi is working, it takes this after the current step instead
  // of once it's done.
  | { kind: "prompt"; text: string; images?: ImageAttachment[]; steer?: boolean }
  // An `edit` comes back as `restore`.
  | ({ kind: "queue_action" } & QueueAction)
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
  // `history` is null while a saved chat's history loads. `live`: what pi
  // sent since, on top of that history (in memory only).
  | { kind: "replay"; status: PiStatus; session: SessionMeta; history: ChatMessage[] | null; live: ChatChunk[]; queue: QueuedMessage[]; model: ModelState; commands: PiCommand[] }
  | { kind: "model"; model: ModelState }
  | { kind: "status"; status: PiStatus }
  | { kind: "live"; chunk: ChatChunk }
  // Messages waiting for pi while it works.
  | { kind: "queue"; queue: QueuedMessage[] }
  // Messages taken back (a stop, an edit, rejected or never answered), for the message box.
  | { kind: "restore"; text: string; images?: ImageAttachment[] }
  | { kind: "sessions"; sessions: SessionMeta[]; currentId: number };

export type Settings = {
  // pi's executable. Empty: the pi found by the installer.
  piPath: string;
};

// The panel's one-off questions (the settings screen's, the @ menu's), sent
// with chrome.runtime.sendMessage, and their answers.
export type PanelQuestion =
  // The saved settings, and a check of the saved pi path.
  | { kind: "get_settings" }
  // Saves a new pi path if it checks out (empty, back to the installed pi,
  // always saves), then restarts pi if it works.
  | { kind: "set_pi_path"; piPath: string }
  // The tabs the @ menu may list; null for any web page tab.
  | { kind: "mention_tabs" };

// The answer to each kind of PanelQuestion.
export type PanelAnswers = {
  get_settings: { settings: Settings; check: PiCheck };
  set_pi_path: { saved: boolean; check: PiCheck };
  mention_tabs: { tabs: TabMention[] | null };
};

