import { randomUUID } from "node:crypto";
import type { BrowserRelay } from "../../../bridge/host";
import type { BridgeEvent, BrowserReply } from "../../../bridge/protocol";
import type { BrowserRequest } from "../protocol";

// Private transport for this host's Pi process. The random bearer token is
// inherited by Pi, never sent to a web page or included in model instructions.
export class ChromeBrowserRelay implements BrowserRelay {
  readonly token = randomUUID();
  readonly url: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly pending = new Map<string, (reply: BrowserReply) => void>();
  private closed = false;

  constructor(send: (event: BridgeEvent) => void, timeoutMs = 30_000) {
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 40, maxRequestBodySize: 1024 * 1024,
      fetch: async (request) => {
        if (request.headers.has("origin") || request.headers.get("authorization") !== `Bearer ${this.token}`) return new Response("Forbidden", { status: 403 });
        if (request.method !== "POST") return new Response("POST required", { status: 405 });
        if (this.closed) return Response.json({ error: "Browser disconnected" });
        let body: BrowserRequest;
        try {
          body = await request.json() as BrowserRequest;
          if (!body || !["list", "open", "close", "eval", "cdp"].includes(body.op)) throw new Error("Unknown operation");
        } catch { return Response.json({ error: "Invalid browser request" }, { status: 400 }); }
        if (request.signal.aborted) return new Response(null, { status: 499 });
        const id = randomUUID();
        return new Promise<Response>((resolve) => {
          const finish = (reply: BrowserReply) => {
            clearTimeout(timer);
            request.signal.removeEventListener("abort", aborted);
            this.pending.delete(id);
            resolve(Response.json(reply.error ? { error: reply.error } : { result: reply.result ?? null }));
          };
          const cancel = (error: string) => {
            send({ type: "browser_cancel", id });
            finish({ type: "browser_reply", id, error });
          };
          const aborted = () => cancel("Browser request aborted");
          const timer = setTimeout(() => cancel("Browser request timed out"), timeoutMs);
          this.pending.set(id, finish);
          request.signal.addEventListener("abort", aborted, { once: true });
          send({ type: "browser_request", id, request: body });
        });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}/`;
  }

  reply(reply: BrowserReply) { this.pending.get(reply.id)?.(reply); }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, finish] of this.pending) finish({ type: "browser_reply", id, error: "Browser disconnected" });
    void this.server.stop();
  }
}
