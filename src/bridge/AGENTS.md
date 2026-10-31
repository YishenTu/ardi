# AGENTS.md

- The build bundles it into `dist/<target>/bridge/main.js`, which runs on bun (`~/.ardi/runtime/<target>/launch.sh`), not Node. It finds pi's prompt and extension at `../agent`, which works both from `src/` (tests) and from `dist/`.
- Stdout is the native messaging channel (4-byte length + JSON). Log only to stderr. Send events only through `sendToExtension`: Chrome drops messages over 1 MB, so it splits big ones into `part`s.
- pi's RPC output and session files are JSONL split on LF only. Don't use Node `readline`: it also splits on U+2028/U+2029, which are valid inside JSON strings.
- Before any input reaches pi, prove it is on the requested session file (`get_state`), both at launch (`--session`) and after `open` (`switch_session`/`new_session`). pi exits on `--session` for a file it never saved, so resume only files that exist.
- pi is isolated from the user's own pi setup: global extensions, skills and prompt templates are off, and the tool list is explicit. AGENTS.md files load as pi does by default, which is how `~/.ardi/AGENTS.md` reaches it. The only skills pi loads are in `~/.ardi/.agents/skills/` (`--no-skills` plus `--skill`). It gets every built-in tool plus Ardi's browser tools by design; don't narrow it without asking. For the prompt flag, see `src/agent/AGENTS.md`.
- `runtime/`, `normalization/` and `history/` are adapted from Claudian's pi provider (github.com/YishenTu/claudian, `src/providers/pi`); each file's header names its source. Check the source when fixing pi protocol behavior there.
