import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDate } from "./date";
import registerChromeTools from "./chrome-tools";

export default function (pi: ExtensionAPI) {
  registerDate(pi);
  registerChromeTools(pi);
}
