// Native messaging host: the browser starts this (built to dist/bridge/main.js,
// via ~/.ardi/launch.sh, written by `bun run host:install`) when the extension
// connects, and closes our stdin when it disconnects. Runs on bun.

import { onExtensionMessage, sendToExtension } from "./nativeMessaging";
import { checkPi } from "./launch";
import { PiSession } from "./PiSession";
import type { BridgeEvent, BridgeRequest } from "./protocol";

const session = new PiSession((event: BridgeEvent) => sendToExtension(event));

onExtensionMessage(
  (message) => {
    const request = message as BridgeRequest;
    switch (request.type) {
      case "start":
        return session.start(request.sessionFile, request.piPath);
      case "check_pi":
        return void checkPi(request.piPath).then((check) => sendToExtension({ type: "pi_check", ...check }));
      case "open":
        return session.open(request.sessionFile);
      case "prompt":
        return void session.prompt(request.text);
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
    session.shutdown();
    process.exit(0);
  },
);
