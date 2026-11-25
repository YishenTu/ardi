import type { ImageAttachment } from "../chat";
import { restoreOf } from "../restore";

// Text and images for a chat's message box that no panel showing that chat
// could take (none open, or the chat is off screen), by chat id, until one
// can. In chrome.storage.local: Chrome may stop the worker meanwhile.
// Changes run one at a time, so none overwrites another's.
export type Returned = { text: string; images?: ImageAttachment[] }[];
type Restore = NonNullable<ReturnType<typeof restoreOf>>;
type Held = Record<string, Returned>;

const KEY = "held";

let queue: Promise<void> = Promise.resolve();

// Runs `change` on what's held, in turn; it returns what to store, or
// nothing to leave it as it is. A change that fails (storage full, say) is
// lost, but the ones after it still run.
function update(change: (held: Held) => Held | undefined): Promise<void> {
  queue = queue
    .then(async () => {
      const { [KEY]: held = {} } = await chrome.storage.local.get(KEY);
      const next = change(held as Held);
      if (next) await chrome.storage.local.set({ [KEY]: next });
    })
    // Not the text itself: it's the user's.
    .catch((error: unknown) => console.warn("held text not saved:", error instanceof Error ? error.message : String(error)));
  return queue;
}

export function hold(id: number, messages: Returned): void {
  void update((held) => ({ ...held, [id]: [...(held[id] ?? []), ...messages] }));
}

// Offers what's held for the chat `id` names when its turn comes (the chat
// on screen then, not when asked) to `deliver`, and clears it only once
// `deliver` says a panel took it.
export function handOver(id: () => number, deliver: (restore: Restore) => boolean): Promise<void> {
  return update((held) => {
    const { [id()]: mine, ...rest } = held;
    const restore = mine && restoreOf(mine);
    return restore && deliver(restore) ? rest : undefined;
  });
}

// Drops what's held for a deleted chat.
export function drop(id: number): void {
  void update((held) => {
    const { [id]: _, ...rest } = held;
    return rest;
  });
}
