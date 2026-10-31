# AGENTS.md

Ardi is a side panel extension that wraps the locally installed Pi coding agent. The Ardia build controls the browser through `ardia exec`; the Chrome build uses the extension's debugger API in the user's existing Chrome profile.

## Browser and installation constraints

- **Keep browser targets explicit.** Ardia tools use `ardia exec`; Chrome tools use the hosting extension's debugger API without remote-debugging flags. Never fall back across browsers.
- **Keep targets split.** Browser-specific code, configuration and Pi setup live in `src/targets/<target>/`. Shared code never imports a target or branches on one; targets plug in through `BackgroundTarget` (`src/background/target.ts`) and `BridgeTarget` (`src/bridge/host.ts`) from their entry points. Targets never import each other.
- **Preserve extension identities.** Keep each extension's key in `src/targets/<target>/manifest.json` and its native host name in `target.json`: native host allowlists depend on them. After changing a host path or registration, rerun `bun run host:install <ardia|chrome>`.
- **Resolve runtime files at entry depth.** The bridge and Pi extension are each bundled into one file, so every bundled module's `import.meta.dirname` is the entry's output directory. Resolve files only from modules in `src/bridge/` or a target's `bridge/` or `agent/extension/`, so source and `dist/` paths agree.
- **Rebuild and reload.** Development artifacts, including each bridge and agent setup, live in `dist/<target>/`. Release installers copy them into `~/.ardi/runtime/<target>/app/`. After source changes, rebuild and reload the affected extension so its bridge restarts.
- **Preserve the shared working directory.** Both versions run Pi in `~/.ardi/` and share user instructions and skills. Pi stores sessions per working directory, so changing it breaks resume.
- **Keep launchers separate.** Generated launchers belong in `~/.ardi/runtime/<target>/` so installing one version cannot redirect the other.

## Commands

Use Bun.

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies. |
| `bun run build` | Typecheck `src/` and `test/`, then build both distributions with their bridges and agent setups. |
| `bun run typecheck` | Run the same typecheck without building. |
| `bun run dev` | Watch and rebuild Ardia. |
| `bun run dev:chrome` | Watch and rebuild Chrome. |
| `bun run lint` | Run type-aware oxlint rules from `.oxlintrc.json`. |
| `bun test` | Run unit and integration tests. |
| `bun test --randomize` | Check that tests pass in any order. |
| `bun run zip` | Build both extension-only ZIPs. |
| `bun run release:package` | Build complete downloads with the native bridge, installer and checksums. |

**Before committing:** `bun run lint`, `bun test` and `bun run build` must pass.

Lint uses oxlint, not ESLint: typescript-eslint doesn't support TypeScript 7.

## Testing

### Test behavior first

For a behavior change or bug fix:

1. Write or change a test that fails without the fix.
2. Run `bun test` and observe the failure.
3. Implement the change and make the test pass.

Test behavior someone relies on that could plausibly break: what the user sees, a contract between the panel, background, bridge and Pi, or a bug that happened. Don't add tests that restate code, check trivial wiring, pin implementation details, or only raise the test count.

Check visual changes (CSS and layout) by eye.

### Placement and isolation

Tests live under `test/`, mirroring the code's path under `src/`.

- `test/unit/`: one module through its public interface.
- `test/integration/`: processes (the fake Pi) or several real modules together.

Tests never use the real Pi, Ardia or home folder. Use these fixtures:

| Resource | Fixture |
| --- | --- |
| Temporary home | `test/setup.ts` |
| Pi process | `test/fixtures/fake-pi.ts` |
| `chrome.*` APIs | `test/support/chrome.ts`, reset after every test |

Extend the fakes when code starts using more of Pi or Chrome, following the shapes in Pi's docs. Build and packaging tests must use temporary `ARDI_BUILD_DIR` and `ARDI_RELEASE_DIR` paths so they cannot overwrite loaded extensions or release assets.

Each test must pass on its own and in any order; verify with `bun test --randomize`.

## Pi reference

Check event and command shapes in `node_modules/@earendil-works/pi-coding-agent/docs/` instead of guessing: `rpc.md`, `rpc-commands.md`, `json.md`, `message-types.md` and `extensions.md`.
