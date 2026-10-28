# AGENTS.md

- `system-prompt.md` is pi's entire system prompt: the bridge passes it with `--system-prompt`, never `--append-system-prompt`, so nothing from pi's default prompt is present.
- The build copies this folder as is into `dist/agent/` (without `AGENTS.md`), and pi loads it from there at runtime (TypeScript via jiti). It may import `@earendil-works/pi-coding-agent` and `typebox`, which pi provides.
- `references/` is linked into `~/.ardi/references`; tool descriptions and the references themselves point to these files by that relative path (`references/ardia.md`).
- Don't describe tools in `system-prompt.md`: pi sends each tool's description and parameters with every request, so tool guidance belongs in the tool's own description in `extension/index.ts`.
