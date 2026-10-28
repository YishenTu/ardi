import type { ChatMessage, ModelState, PiCommand } from "../chat";
import {
  PANEL_PORT,
  type LiveItem,
  type PanelRequest,
  type PanelUpdate,
  type PiStatus,
  type SessionMeta,
  type SettingsAnswers,
  type SettingsRequest,
} from "../shared";

type Listener = {
  // Called on (re)connect and chat switch; the UI redraws from it.
  replay: (history: ChatMessage[] | null, live: LiveItem[]) => void;
  model: (model: ModelState) => void;
  commands: (commands: PiCommand[]) => void;
  live: (item: LiveItem) => void;
  status: (s: PiStatus) => void;
  sessions: (sessions: SessionMeta[], currentId: number) => void;
};

// Talks to the pi session in the background service worker. The session
// outlives the panel; this connection only lasts while the panel is open.
export class PiClient {
  private port: chrome.runtime.Port | null = null;

  constructor(private on: Listener) {}

  connect() {
    const port = chrome.runtime.connect({ name: PANEL_PORT });
    port.onMessage.addListener((u: PanelUpdate) => {
      switch (u.kind) {
        case "replay":
          this.on.status(u.status);
          this.on.model(u.model);
          this.on.commands(u.commands);
          this.on.replay(u.history, u.live);
          break;
        case "model":
          this.on.model(u.model);
          break;
        case "status":
          this.on.status(u.status);
          break;
        case "live":
          this.on.live(u.item);
          break;
        case "sessions":
          this.on.sessions(u.sessions, u.currentId);
          break;
      }
    });
    // The service worker restarted; reconnect to the fresh one.
    port.onDisconnect.addListener(() => {
      this.port = null;
      setTimeout(() => this.connect(), 500);
    });
    this.port = port;
  }

  send(req: PanelRequest) {
    this.port?.postMessage(req);
  }
}

// Asks the background a settings question and waits for the answer.
export function askSettings<R extends SettingsRequest>(req: R): Promise<SettingsAnswers[R["kind"]]> {
  return chrome.runtime.sendMessage(req);
}
