// Ardia's native messaging host. Pi's tools drive Ardia with `ardia exec`
// directly, so there is no relay to the extension.
import { resolve } from "node:path";

import { runBridge } from "../../../bridge/host";
import target from "../target.json";

await runBridge({ extension: resolve(import.meta.dirname, "../agent/extension"), tools: target.tools });
