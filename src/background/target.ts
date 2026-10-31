import type { BrowserRelayEvent, BrowserReply } from "../bridge/protocol";

// Browser control a target performs in the extension for one native
// connection, answering the bridge's relay requests.
export interface BrowserLink {
  receive(event: BrowserRelayEvent): void;
  // Called when the user sends a prompt; the returned callback runs only if
  // pi starts a new run for it.
  preparePrompt(): () => void;
  // The user pressed Stop.
  cancel(): void;
  dispose(): Promise<void>;
}

// What the shared background needs from its browser target. The target's
// background entry sets it before anything else runs.
export interface BackgroundTarget {
  nativeHost: string;
  connectBrowser?(reply: (reply: BrowserReply) => void): BrowserLink;
}

let current: BackgroundTarget | undefined;

export function setTarget(target: BackgroundTarget): void {
  current = target;
}

export function target(): BackgroundTarget {
  if (!current) throw new Error("The background's browser target is not set");
  return current;
}
