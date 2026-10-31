# AGENTS.md

- `system-prompt.md` is pi's entire system prompt: the bridge passes it with `--system-prompt`, never `--append-system-prompt`, so nothing from pi's default prompt is present.
- The build copies the selected browser tools and references into `dist/<target>/agent/` (without `AGENTS.md`), and pi loads it from there at runtime (TypeScript via jiti). It may import `@earendil-works/pi-coding-agent` and `typebox`, which pi provides.
- Reference paths must resolve to the running build. Do not rewrite a shared `~/.ardi/references` link: the two distributions can run concurrently.
- Don't describe tools in `system-prompt.md`: pi sends each tool's description and parameters with every request, so tool guidance belongs in the tool's own description in `extension/ardia.ts` or `extension/chrome-tools.ts`.
