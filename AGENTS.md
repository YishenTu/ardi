# AGENTS.md

Ardi is a side panel extension that wraps the locally installed Pi coding agent. Its Ardia build controls the browser through `ardia exec`; its Chrome build uses the extension's debugger API in the user's existing Chrome profile.

## Constraints

- Build targets are explicit: Ardia tools use `ardia exec`; Chrome tools use the hosting extension's debugger API in the existing profile, without remote-debugging flags. Never fall back across browsers.
- Preserve the Ardia key in `public/manifest.json` and Chrome key in `config/chrome.json`: native host allowlists depend on these identities. After changing a host path or registration, rerun `bun run host:install <ardia|chrome>`.
- Development artifacts live in `dist/ardia/` and `dist/chrome/`, including each bridge and agent setup. Release installers copy them into `~/.ardi/runtime/<target>/app/`. Rebuild after source changes, then reload the affected extension so its bridge restarts.
- Both versions use `~/.ardi/` as Pi's working directory and share user instructions and skills. Pi stores sessions per working directory, so changing it breaks resume. Keep generated launchers separate under `~/.ardi/runtime/<target>/` so installation of one version cannot redirect the other.

## Reference

pi's RPC and event docs: `node_modules/@earendil-works/pi-coding-agent/docs/` (`rpc.md`, `rpc-commands.md`, `json.md`, `message-types.md`, `extensions.md`). Check event and command shapes there instead of guessing.

## Workflow

- Use bun (`bun install`, `bun run build`, `bun run lint`, `bun test`). `bun run build` typechecks `src/` (including `src/agent/`) and `test/`, and builds both `dist/ardia/` and `dist/chrome/` (extension, bridge and agent for each); `bun run typecheck` is the same check without the build, for quicker feedback. `bun run lint`, `bun test` and `bun run build` must pass before committing.
- Lint is oxlint with type-aware rules (`.oxlintrc.json`), not ESLint: typescript-eslint doesn't support TypeScript 7.
- Work test-first, with meaningful tests only. For a behavior change or bug fix, first write or change a test that fails without it, run `bun test` to see it fail, then make it pass. A test is meaningful when it checks behavior someone relies on and that could plausibly break: what the user sees, a contract between the panel, background, bridge and pi, or a bug that happened. Don't add tests that restate the code, check trivial wiring, or pin implementation details, and don't add tests just to raise the count. Visual changes (CSS, layout) are checked by eye.
- Tests live in `test/`, at the path of the code they cover under `src/`: `test/unit/` tests one module through its public interface; `test/integration/` covers tests that start processes (the fake pi) or run several real modules together. They never use the real pi, Ardia or home folder: `test/setup.ts` gives each run a temporary home, pi is `test/fixtures/fake-pi.ts`, and `chrome.*` is `test/support/chrome.ts` (reset after every test). Extend those fakes when code starts using more of pi or Chrome, following the shapes in pi's docs. Build and packaging tests must use temporary `ARDI_BUILD_DIR` and `ARDI_RELEASE_DIR` paths so they cannot overwrite loaded extensions or release assets. Each test must pass on its own and in any order; check with `bun test --randomize`.
