// Native messaging host: the browser starts a target's bridge entry (built to
// dist/<target>/bridge/main.js, via ~/.ardi/runtime/<target>/launch.sh (launch.cmd on Windows),
// written by the installer) when the extension connects, and closes our stdin
// when it disconnects. Runs on Node.

import { onExtensionMessage, sendToExtension } from "./nativeMessaging";
import { checkPi, type PiTarget } from "./launch";
import { PiSession } from "./PiSession";
import { RELAY_TOKEN_ENV, RELAY_URL_ENV, type BridgeEvent, type BridgeRequest, type BrowserReply } from "./protocol";

// A local endpoint pi's tools call to reach the extension (see protocol.ts).
export interface BrowserRelay {
  readonly url: string;
  readonly token: string;
  reply(reply: BrowserReply): void;
  dispose(): void;
}

export interface BridgeTarget extends PiTarget {
  relay?(send: (event: BridgeEvent) => void): Promise<BrowserRelay>;
}

// Stdin is read only once the relay listens, so pi always gets its address.
export async function runBridge(target: BridgeTarget): Promise<void> {
  const relay = await target.relay?.(sendToExtension);
  // pi reaches the extension only through this host's own relay, never one
  // it inherited.
  delete process.env[RELAY_URL_ENV];
  delete process.env[RELAY_TOKEN_ENV];
  if (relay) {
    process.env[RELAY_URL_ENV] = relay.url;
    process.env[RELAY_TOKEN_ENV] = relay.token;
  }
  const session = new PiSession(target, (event: BridgeEvent) => sendToExtension(event));

  onExtensionMessage(
    (message) => {
      const request = message as BridgeRequest;
      switch (request.type) {
        case "browser_reply":
          return relay?.reply(request);
        case "start":
          return session.start(request.sessionFile, request.piPath);
        case "check_pi":
          return void checkPi(request.piPath).then((check) => sendToExtension({ type: "pi_check", ...check }));
        case "open":
          return session.open(request.sessionFile);
        case "prompt":
          return void session.prompt(request.text, request.promptId);
        case "abort":
          return void session.abort();
        case "compact":
          return void session.compact();
        case "set_model":
          return void session.setModel(request.provider, request.modelId);
        case "set_thinking_level":
          return void session.setThinkingLevel(request.level);
      }
    },
    () => {
      relay?.dispose();
      void session.shutdown().finally(() => process.exit(0));
    },
  );
}
