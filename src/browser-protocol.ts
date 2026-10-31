// Browser control contract across agent -> native bridge -> extension.
// Type-only imports let the agent copy in dist/ stay self-contained.
export type TabSelector = { id?: string; url?: string };
export type BrowserTab = { id: string; title: string; url: string; current: boolean };
export type BrowserRequest =
  | { op: "list" }
  | { op: "open"; url: string; background?: boolean }
  | ({ op: "eval"; code: string } & TabSelector)
  | ({ op: "cdp"; method: string; params?: Record<string, unknown> } & TabSelector)
  | { op: "close"; id: string };
export type BrowserReply = { type: "browser_reply"; id: string; result?: unknown; error?: string };
