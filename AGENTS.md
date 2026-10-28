# AGENTS.md

Ardi is a side panel extension for the Ardia browser (Chromium-based) that wraps the locally installed Pi coding agent. Pi does the browser work through the `ardia` CLI.

## Constraints

- Target Ardia, not Chrome. Browser tools call `ardia exec`, which controls the running Ardia; in another browser pi would act on the wrong tabs.
- The extension ID is fixed by `key` in `public/manifest.json`, and the native host registration allows only that ID. Don't change or remove the key. After changing the host path or registration, rerun `bun run host:install`.
- The browser runs everything from `dist/`: the extension, the bridge (`dist/bridge/`) and pi's agent setup (`dist/agent/`). Rebuild after any change, including bridge and agent changes, then reload the extension so the bridge restarts.

## Reference

pi's RPC and event docs: `node_modules/@earendil-works/pi-coding-agent/docs/` (`rpc.md`, `rpc-commands.md`, `json.md`, `message-types.md`, `extensions.md`). Check event and command shapes there instead of guessing.

## Workflow

- Use bun (`bun install`, `bun run build`, `bun run lint`, `bun test`). `bun run build` typechecks `src/` (including `src/agent/`) and `test/`, and builds `dist/` (extension, bridge and agent); `bun run typecheck` is the same check without the build, for quicker feedback. `bun run lint`, `bun test` and `bun run build` must pass before committing.
- Lint is oxlint with type-aware rules (`.oxlintrc.json`), not ESLint: typescript-eslint doesn't support TypeScript 7.
- Work test-first, with meaningful tests only. For a behavior change or bug fix, first write or change a test that fails without it, run `bun test` to see it fail, then make it pass. A test is meaningful when it checks behavior someone relies on and that could plausibly break: what the user sees, a contract between the panel, background, bridge and pi, or a bug that happened. Don't add tests that restate the code, check trivial wiring, or pin implementation details, and don't add tests just to raise the count. Visual changes (CSS, layout) are checked by eye.
- Tests live in `test/`, at the path of the code they cover under `src/`: `test/unit/` tests one module through its public interface; `test/integration/` covers tests that start processes (the fake pi) or run several real modules together. They never use the real pi, Ardia or home folder: `test/setup.ts` gives each run a temporary home, pi is `test/fixtures/fake-pi.ts`, and `chrome.*` is `test/support/chrome.ts` (reset after every test). Extend those fakes when code starts using more of pi or Chrome, following the shapes in pi's docs. Each test must pass on its own and in any order; check with `bun test --randomize`.
