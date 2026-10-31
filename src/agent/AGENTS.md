# AGENTS.md

- `system-prompt.md` is pi's entire system prompt: the bridge passes it with `--system-prompt`, never `--append-system-prompt`, so nothing from pi's default prompt is present.
- Don't describe tools in `system-prompt.md`: pi sends each tool's description and parameters with every request, so tool guidance belongs in the tool's own description in `src/targets/<target>/agent/extension/`.
