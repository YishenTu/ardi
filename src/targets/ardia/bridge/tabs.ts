import { execFile } from "node:child_process";
import type { TabMention } from "../../../mention";

type Window = { focused?: boolean; profile: string; tabs: { title: string; url: string; profile: string; targetId: string | null }[] };

// Ardia shows the extension every profile's tabs. The user means the loaded
// tabs (those with a page target) of the profile they're in, the focused
// window's; null when Ardia can't be asked.
export function profileTabs(): Promise<TabMention[] | null> {
  return new Promise((resolve) => {
    // ARDIA_STAR_PROMPT=0: no request to star Ardia's repo in the output.
    const env = { ...process.env, ARDIA_STAR_PROMPT: "0" };
    execFile("ardia", ["windows", "--json"], { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      try {
        if (error) throw error;
        const windows = JSON.parse(stdout) as Window[];
        const profile = (windows.find((w) => w.focused) ?? windows[0])?.profile;
        const tabs = windows.flatMap((w) => w.tabs).filter((t) => t.profile === profile && t.targetId);
        resolve(tabs.map((t) => ({ title: t.title, url: t.url })));
      } catch {
        resolve(null);
      }
    });
  });
}
