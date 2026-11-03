// Chrome's browser operations, carried as the `request` of the bridge's
// relay messages (src/bridge/protocol.ts) from pi's tools to the background.
export type TabSelector = { id?: string; url?: string };
export type BrowserTab = { id: string; title: string; url: string; current: boolean };

// A userscript as chrome.userScripts registers it; `id` is its @name.
export type Userscript = {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  excludeGlobs?: string[];
  runAt: "document_start" | "document_end" | "document_idle";
  world: "MAIN" | "USER_SCRIPT";
  allFrames: boolean;
  code: string;
};
export type InstalledUserscript = Omit<Userscript, "code">;
// What a script did in its test tab.
export type UserscriptRun = { tab: BrowserTab; logs: string[]; errors: string[] };

export type BrowserRequest =
  | { op: "list" }
  | { op: "open"; url: string; background?: boolean }
  | ({ op: "eval"; code: string } & TabSelector)
  | ({ op: "cdp"; method: string; params?: Record<string, unknown> } & TabSelector)
  | { op: "close"; id: string }
  | { op: "scripts_list" }
  | { op: "scripts_install"; script: Userscript }
  | { op: "scripts_uninstall"; id: string }
  | { op: "scripts_test"; url: string; code: string; waitMs: number };

// Every operation, checked against BrowserRequest so neither can grow alone.
const OPS: Record<BrowserRequest["op"], true> = { list: true, open: true, close: true, eval: true, cdp: true, scripts_list: true, scripts_install: true, scripts_uninstall: true, scripts_test: true };
export const BROWSER_OPS = Object.keys(OPS) as BrowserRequest["op"][];
