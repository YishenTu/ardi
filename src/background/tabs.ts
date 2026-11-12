import type { TabMention } from "../mention";
import { askBridge } from "./ask-bridge";
import { target } from "./target";

// The tabs the @ menu may list, or null for any web page tab: the target's
// own answer, or null when it can't give one.
export function mentionableTabs(): Promise<TabMention[] | null> {
  if (!target().narrowsTabs) return Promise.resolve(null);
  return askBridge(
    { type: "list_tabs" },
    (event) => (event.type === "tabs" ? event.tabs : undefined),
    () => null,
  );
}
