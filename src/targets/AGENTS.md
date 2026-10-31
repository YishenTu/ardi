# AGENTS.md

- Every subdirectory is a build target: the build, packaging scripts and tests enumerate them. Each needs `manifest.json` (overlay on `src/manifest.json`), `target.json`, `background/index.ts`, `bridge/main.ts`, `agent/extension/index.ts` and `agent/references/`.
- Reference paths must resolve to the running build's `agent/references/`. Do not rewrite a shared `~/.ardi/references` link: the two distributions can run concurrently.
