import { joinParts, type PiCheck } from "../bridge/protocol";
import type { Settings } from "../shared";
import { target } from "./target";

// Ardi's settings, in chrome.storage.local. Owned here: the side panel asks
// for them and for changes, and pi-session reads them when it starts pi.

const DEFAULTS: Settings = { piPath: "" };
const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(stored as Partial<Settings> | undefined) };
}

// Checks `piPath` and saves it only if pi runs from there. Clearing it (back
// to the installed pi) always saves, so a bad path can be undone.
export async function setPiPath(piPath: string): Promise<{ saved: boolean; check: PiCheck }> {
  const check = await checkPi(piPath);
  const saved = !check.error || !piPath;
  if (saved) await chrome.storage.local.set({ [KEY]: { ...(await loadSettings()), piPath } });
  return { saved, check };
}

// Asks a short-lived bridge to run `pi --version`. It's separate from the
// bridge running pi, which may be down because of a bad path.
export function checkPi(piPath: string): Promise<PiCheck> {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(target().nativeHost);
    port.onMessage.addListener(
      joinParts((event) => {
        if (event.type !== "pi_check") return;
        const { type: _, ...check } = event;
        resolve(check);
        port.disconnect();
      }),
    );
    port.onDisconnect.addListener(() => {
      resolve({ command: piPath, error: chrome.runtime.lastError?.message ?? "The bridge closed" });
    });
    port.postMessage({ type: "check_pi", piPath: piPath || undefined });
  });
}
