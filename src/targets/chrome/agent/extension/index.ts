import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDate } from "../../../../agent/lib/date";
import { registerEnvironment } from "../../../../agent/lib/environment";
import { registerSchedule } from "../../../../agent/lib/schedule";
import registerChromeTools from "./tools";

export default function (pi: ExtensionAPI) {
  registerDate(pi);
  registerEnvironment(pi);
  registerSchedule(pi);
  registerChromeTools(pi);
}
