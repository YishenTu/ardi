import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueuedMessage } from "../chat";
import { joinParts, postInParts } from "../parts";
import {
  PANEL_PORT,
  type PanelRequest,
  type PanelUpdate,
  type PiStatus,
  type SessionMeta,
  type SettingsAnswers,
  type SettingsRequest,
} from "../panel-protocol";

type Listener = {
  // Called on (re)connect and chat switch; the UI redraws from it.
  replay: (history: ChatMessage[] | null, live: ChatChunk[]) => void;
  model: (model: ModelState) => void;
  commands: (commands: PiCommand[]) => void;
  live: (chunk: ChatChunk) => void;
  queue: (queue: QueuedMessage[]) => void;
  // Messages taken back (a stop, an edit, rejected or never answered).
  restore: (text: string, images?: ImageAttachment[]) => void;
  status: (s: PiStatus) => void;
  sessions: (sessions: SessionMeta[], currentId: number) => void;
};

// Talks to the pi session in the background service worker. The session
// outlives the panel; this connection only lasts while the panel is open.
export class PiClient {
  private port: chrome.runtime.Port | null = null;
  // Requests leave in the order they were made, so a prompt still reading
  // its images can't be overtaken by a later prompt or a chat switch.
  private outbox: Promise<void> = Promise.resolve();
  // The port once connected. While the panel reconnects, queued requests
  // wait here for the new one instead of being dropped.
  private connected!: Promise<chrome.runtime.Port>;
  private onConnected!: (port: chrome.runtime.Port) => void;

  constructor(private on: Listener) {
    this.awaitPort();
  }

  private awaitPort() {
    this.connected = new Promise((resolve) => (this.onConnected = resolve));
  }

  connect() {
    const port = chrome.runtime.connect({ name: PANEL_PORT });
    port.onMessage.addListener(joinParts<PanelUpdate>((u) => {
      switch (u.kind) {
        case "replay":
          this.on.status(u.status);
          this.on.model(u.model);
          this.on.commands(u.commands);
          this.on.replay(u.history, u.live);
          this.on.queue(u.queue);
          break;
        case "queue":
          this.on.queue(u.queue);
          break;
        case "restore":
          this.on.restore(u.text, u.images);
          break;
        case "model":
          this.on.model(u.model);
          break;
        case "status":
          this.on.status(u.status);
          break;
        case "live":
          this.on.live(u.chunk);
          break;
        case "sessions":
          this.on.sessions(u.sessions, u.currentId);
          break;
      }
    }));
    // The service worker restarted; reconnect to the fresh one.
    port.onDisconnect.addListener(() => {
      this.port = null;
      this.awaitPort();
      setTimeout(() => this.connect(), 500);
    });
    this.port = port;
    this.onConnected(port);
  }

  // A promise is a request still being prepared; null sends nothing. Stop
  // goes at once: it can't wait for a prompt's images.
  send(req: PanelRequest | Promise<PanelRequest | null>) {
    if (!(req instanceof Promise) && req.kind === "abort") {
      if (this.port) postInParts(this.port, req);
      return;
    }
    this.outbox = this.outbox
      .then(async () => {
        const ready = await req;
        if (ready) postInParts(await this.connected, ready);
      })
      // A failed request (posted as the port died, say) mustn't block the rest.
      .catch((error: unknown) => console.error("panel request failed:", error));
  }
}

// Asks the background a settings question and waits for the answer.
export function askSettings<R extends SettingsRequest>(req: R): Promise<SettingsAnswers[R["kind"]]> {
  return chrome.runtime.sendMessage(req);
}
