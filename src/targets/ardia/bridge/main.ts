// Ardia's native messaging host. Pi's tools drive Ardia with the ardia
// command (`ardia browse`) directly, so there is no relay to the extension.
import { resolve } from "node:path";

import { runBridge } from "../../../bridge/host";
import target from "../target.json";
import { profileTabs } from "./tabs";

await runBridge({ extension: resolve(import.meta.dirname, "../agent/extension"), tools: target.tools, mentionableTabs: profileTabs });
