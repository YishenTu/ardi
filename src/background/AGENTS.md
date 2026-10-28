# AGENTS.md

- The bridge connection (and so pi) lives here in the service worker, not in the side panel. Closing the panel must not stop pi or lose the conversation.
- pi's session file is the record of the conversation. IndexedDB holds only the chat list; don't store transcripts or events there.
- Settings are owned here (`settings.ts`): this is the only code that writes them, and it answers the side panel's `SettingsRequest`s.
- Read every native port through `joinParts` (`src/bridge/protocol.ts`). The bridge splits events over Chrome's 1 MB limit into `part`s, and a listener without it breaks on long chats.
- Session changes come only from the extension (new chat, switch chat), sent to the running pi as `open` (pi switches session in place; no restart). Don't re-query or follow pi's session during a run.
