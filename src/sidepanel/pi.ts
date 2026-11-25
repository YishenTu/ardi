import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueuedMessage } from "../chat";
import { joinParts, postInParts } from "../parts";
import {
  PANEL_PORT,
  type PanelRequest,
  type PanelUpdate,
  type PiStatus,
  type SessionMeta,
  type PanelAnswers,
  type PanelQuestion,
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
  sessions: (sessions: SessionMeta[], currentId: number, running: number[]) => void;
};

// The panel's port: connected, or waiting for one (before the first
// connect, and while reconnecting to a restarted worker). Requests in order
// wait for `port` instead of being dropped; Stop goes only while connected.
type Link =
  | { state: "connected"; port: chrome.runtime.Port }
  | { state: "waiting"; port: Promise<chrome.runtime.Port>; connected: (port: chrome.runtime.Port) => void };

function waiting(): Link {
  let connected!: (port: chrome.runtime.Port) => void;
  const port = new Promise<chrome.runtime.Port>((resolve) => (connected = resolve));
  return { state: "waiting", port, connected };
}

// Talks to the pi session in the background service worker. The session
// outlives the panel; this connection only lasts while the panel is open.
export class PiClient {
  private link = waiting();
  // Requests leave in the order they were made, so a prompt still reading
  // its images can't be overtaken by a later prompt or a chat switch.
  private outbox: Promise<void> = Promise.resolve();

  constructor(private on: Listener) {}

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
          this.on.sessions(u.sessions, u.currentId, u.running);
          break;
      }
    }));
    // The service worker restarted; reconnect to the fresh one.
    port.onDisconnect.addListener(() => {
      this.link = waiting();
      setTimeout(() => this.connect(), 500);
    });
    const { link } = this;
    this.link = { state: "connected", port };
    if (link.state === "waiting") link.connected(port);
  }

  // A promise is a request still being prepared; null sends nothing. Stop
  // goes at once: it can't wait for a prompt's images.
  send(req: PanelRequest | Promise<PanelRequest | null>) {
    if (!(req instanceof Promise) && req.kind === "abort") {
      if (this.link.state === "connected") postInParts(this.link.port, req);
      return;
    }
    this.outbox = this.outbox
      .then(async () => {
        const ready = await req;
        if (ready) postInParts(await this.link.port, ready);
      })
      // A failed request (posted as the port died, say) mustn't block the rest.
      .catch((error: unknown) => console.error("panel request failed:", error));
  }
}

// Asks the background a settings question and waits for the answer.
export function askBackground<R extends PanelQuestion>(req: R): Promise<PanelAnswers[R["kind"]]> {
  return chrome.runtime.sendMessage(req);
}
