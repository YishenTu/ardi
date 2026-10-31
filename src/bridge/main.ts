// Native messaging host: the browser starts this (built to dist/<target>/bridge/main.js,
// via ~/.ardi/runtime/<target>/launch.sh, written by `bun run host:install`) when the extension
// connects, and closes our stdin when it disconnects. Runs on bun.

import { onExtensionMessage, sendToExtension } from "./nativeMessaging";
import { checkPi } from "./launch";
import { BUILD_TARGET } from "../build-target";
import { ChromeBrowserRelay } from "./chrome-relay";
import { PiSession } from "./PiSession";
import type { BridgeEvent, BridgeRequest } from "./protocol";

const browser = BUILD_TARGET === "ardia" ? undefined : new ChromeBrowserRelay(sendToExtension);
if (browser) {
  process.env.ARDI_BROWSER_URL = browser.url;
  process.env.ARDI_BROWSER_TOKEN = browser.token;
} else {
  delete process.env.ARDI_BROWSER_URL;
  delete process.env.ARDI_BROWSER_TOKEN;
}
const session = new PiSession((event: BridgeEvent) => sendToExtension(event));

onExtensionMessage(
  (message) => {
    const request = message as BridgeRequest;
    switch (request.type) {
      case "browser_reply":
        return browser?.reply(request);
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
    browser?.dispose();
    session.shutdown();
    process.exit(0);
  },
);
