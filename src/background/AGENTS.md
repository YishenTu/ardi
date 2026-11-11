# AGENTS.md

- The bridge connection (and so pi) lives here in the service worker, not in the side panel. Closing the panel must not stop pi or lose the conversation.
- pi's session file is the record of the conversation. IndexedDB holds only the chat list; don't store transcripts or events there.
- Settings are owned here (`settings.ts`): this is the only code that writes them, and it answers the side panel's `PanelQuestion`s (the @ menu's in `tabs.ts`).
- Post on every port (native and panel) with `postInParts` and read every port through `joinParts` (both in `src/parts.ts`). Chrome caps messages at 1 MB from the bridge and 64 MiB elsewhere; long chats and images go past both.
- Session changes come only from the extension (new chat, switch chat), sent to the running pi as `open` (pi switches session in place; no restart). Don't re-query or follow pi's session during a run.
- Every `start` and `open` carries a new `epoch`; the bridge labels its session events (`SessionEvent`) with the epoch of the session pi is on. Drop events with an older epoch. Never tell chats apart by timing or by counting replies.
- Chat bubbles come only from pi (`user` chunks). Don't echo a sent message: until pi answers (`prompt_result`) it is held in `unanswered` and goes back to the message box if the bridge goes away.
- Requests that change the chat or reach pi (prompt, chat switches, compact, model) run one at a time through `inOrder` in `pi-session.ts`, so a message still being stored can't land in the next chat. Stop, restart and queue edits (steer, edit, remove) skip it: they act on what is on screen now, and the bridge orders them against pi. Nothing queued may wait on pi.
