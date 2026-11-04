# AGENTS.md

- The bridge connection (and so pi) lives here in the service worker, not in the side panel. Closing the panel must not stop pi or lose the conversation.
- pi's session file is the record of the conversation. IndexedDB holds only the chat list; don't store transcripts or events there.
- Settings are owned here (`settings.ts`): this is the only code that writes them, and it answers the side panel's `SettingsRequest`s.
- Post on every port (native and panel) with `postInParts` and read every port through `joinParts` (both in `src/parts.ts`). Chrome caps messages at 1 MB from the bridge and 64 MiB elsewhere; long chats and images go past both.
- Session changes come only from the extension (new chat, switch chat), sent to the running pi as `open` (pi switches session in place; no restart). Don't re-query or follow pi's session during a run.
