# AGENTS.md

- The panel is only a view and can close or reload at any time. It rebuilds from the background's `replay` and `live` updates; keep chat state in the background, not here.
- The panel talks only to the background: the panel port (`PanelRequest`, via `PiClient`) and `askSettings` (`SettingsRequest`). It never connects to the bridge or writes `chrome.storage`. The one exception is reading open tabs with `chrome.tabs` for the @ menu.
- Answers, tool output and tab titles can carry text from web pages. Insert model or page text with `textContent`, or sanitize it with DOMPurify before using it as HTML (as `markdown()` in `ChatView.ts` does).
- A tab mention is `[@Title](url)` in the prompt text (`src/mention.ts`). The composer shows it as a chip, and so do sent messages; the system prompt tells pi to read it with `read_tab`'s `url`. Change all three together.
