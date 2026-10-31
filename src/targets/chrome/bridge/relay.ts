import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserRelay } from "../../../bridge/host";
import type { BridgeEvent, BrowserReply } from "../../../bridge/protocol";
import type { BrowserRequest } from "../protocol";

const MAX_BODY_BYTES = 1024 * 1024;

// Private transport for this host's Pi process. The random bearer token is
// inherited by Pi, never sent to a web page or included in model instructions.
export class ChromeBrowserRelay implements BrowserRelay {
  readonly token = randomUUID();
  url = "";
  private readonly server: Server;
  private readonly pending = new Map<string, (reply: BrowserReply) => void>();
  private closed = false;

  // Listens on a free local port; `url` is set once it does.
  static async start(send: (event: BridgeEvent) => void, timeoutMs = 30_000): Promise<ChromeBrowserRelay> {
    const relay = new ChromeBrowserRelay(send, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      relay.server.once("error", reject);
      relay.server.listen(0, "127.0.0.1", resolve);
    });
    relay.url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}/`;
    return relay;
  }

  private constructor(private readonly send: (event: BridgeEvent) => void, private readonly timeoutMs: number) {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const respond = (status: number, body: unknown) => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    if (request.headers.origin !== undefined || request.headers.authorization !== `Bearer ${this.token}`) return respond(403, { error: "Forbidden" });
    if (request.method !== "POST") return respond(405, { error: "POST required" });
    if (this.closed) return respond(200, { error: "Browser disconnected" });
    let body: BrowserRequest;
    try {
      body = JSON.parse(await readBody(request)) as BrowserRequest;
      if (!body || !["list", "open", "close", "eval", "cdp"].includes(body.op)) throw new Error("Unknown operation");
    } catch { return respond(400, { error: "Invalid browser request" }); }
    if (response.destroyed) return;
    const id = randomUUID();
    const finish = (reply: BrowserReply) => {
      clearTimeout(timer);
      response.off("close", aborted);
      this.pending.delete(id);
      respond(200, reply.error ? { error: reply.error } : { result: reply.result ?? null });
    };
    const cancel = (error: string) => {
      this.send({ type: "browser_cancel", id });
      finish({ type: "browser_reply", id, error });
    };
    // The caller hung up before a reply.
    const aborted = () => cancel("Browser request aborted");
    const timer = setTimeout(() => cancel("Browser request timed out"), this.timeoutMs);
    this.pending.set(id, finish);
    response.once("close", aborted);
    this.send({ type: "browser_request", id, request: body });
  }

  reply(reply: BrowserReply) { this.pending.get(reply.id)?.(reply); }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, finish] of this.pending) finish({ type: "browser_reply", id, error: "Browser disconnected" });
    this.server.close();
    this.server.closeIdleConnections();
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return reject(new Error("Request too large"));
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
