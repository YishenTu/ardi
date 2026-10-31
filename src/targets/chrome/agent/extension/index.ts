import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDate } from "../../../../agent/lib/date";
import registerChromeTools from "./tools";

export default function (pi: ExtensionAPI) {
  registerDate(pi);
  registerChromeTools(pi);
}
