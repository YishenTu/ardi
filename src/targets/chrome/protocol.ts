// Chrome's browser operations, carried as the `request` of the bridge's
// relay messages (src/bridge/protocol.ts) from pi's tools to the background.
export type TabSelector = { id?: string; url?: string };
export type BrowserTab = { id: string; title: string; url: string; current: boolean };
export type BrowserRequest =
  | { op: "list" }
  | { op: "open"; url: string; background?: boolean }
  | ({ op: "eval"; code: string } & TabSelector)
  | ({ op: "cdp"; method: string; params?: Record<string, unknown> } & TabSelector)
  | { op: "close"; id: string };
