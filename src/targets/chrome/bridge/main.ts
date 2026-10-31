// Chrome's native messaging host. Pi's tools reach the extension's debugger
// API through the relay.
import { resolve } from "node:path";

import { runBridge } from "../../../bridge/host";
import target from "../target.json";
import { ChromeBrowserRelay } from "./relay";

await runBridge({
  extension: resolve(import.meta.dirname, "../agent/extension"),
  tools: target.tools,
  relay: (send) => ChromeBrowserRelay.start(send),
});
