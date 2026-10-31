import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDate } from "../../../../agent/lib/date";
import { registerEnvironment } from "../../../../agent/lib/environment";
import registerChromeTools from "./tools";

export default function (pi: ExtensionAPI) {
  registerDate(pi);
  registerEnvironment(pi);
  registerChromeTools(pi);
}
