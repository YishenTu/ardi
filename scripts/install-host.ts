// Register one distribution without changing the other launcher or host.
// Usage: bun run host:install <ardia|chrome>

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const target = process.argv[2];
if (!target || !/^[a-z]+$/.test(target)) throw new Error("Usage: bun run host:install <ardia|chrome>");

if (!["darwin", "linux"].includes(platform())) throw new Error("This installer supports macOS and Linux only.");
const releaseFile = join(import.meta.dirname, "release.json");
const release = existsSync(releaseFile) ? JSON.parse(readFileSync(releaseFile, "utf8")) as { target: string; version: string } : undefined;
if (release && release.target !== target) throw new Error(`This download is for ${release.target}; run bun install-host.ts ${release.target}.`);
const root = resolve(import.meta.dirname, "..");
const source = release ? join(import.meta.dirname, "payload") : resolve(process.env.ARDI_BUILD_DIR || join(root, "dist"), target);
const workDir = join(homedir(), ".ardi", "runtime", target);
const installed = release ? join(workDir, "app") : source;
// The built bridge, so a build updates it along with the extension.
const hostScript = join(installed, "bridge/main.js");
if (!existsSync(join(source, "bridge/main.js"))) throw new Error("Built bridge not found; run `bun run build` first.");
// Written by the build from src/targets/<target>/target.json.
const { nativeHost, install } = JSON.parse(readFileSync(join(source, "target.json"), "utf8")) as { nativeHost: string; install: string[] };
// Chrome's extension ID: first 32 hex chars of sha256(public key), a-p.
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as { key: string };
const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
  .split("")
  .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
  .join("");

// `bun run` puts node_modules/.bin first on PATH, and the pi dev dependency
// lives there; the user's own PATH, without those, is what the host gets.
const PATH = (process.env.PATH ?? "").split(":").filter((dir) => !dir.endsWith("node_modules/.bin")).join(":");
const which = (bin: string) => {
  try {
    return execSync(`command -v ${bin}`, { shell: "/bin/sh", env: { ...process.env, PATH } }).toString().trim();
  } catch {
    return "";
  }
};
// Optional: without it, the bridge runs the pi set in Settings, or `pi` on PATH.
const piBin = which("pi");
// The bridge is TypeScript and runs on bun.
const bunBin = which("bun");
if (!bunBin) throw new Error("bun not found on PATH; install Bun before running this installer.");
if (release && !piBin) throw new Error("pi not found on PATH; install the Pi coding agent before running this installer.");
if (release) {
  for (const bin of [bunBin, piBin]) {
    const check = spawnSync(bin, ["--version"], { env: { ...process.env, PATH }, encoding: "utf8", timeout: 10_000 });
    if (check.status !== 0) throw new Error(`Cannot run ${bin} --version: ${check.stderr || check.error?.message || "command failed"}`);
  }
  for (const file of ["system-prompt.md", "extension/index.js", "references"]) {
    if (!existsSync(join(source, "agent", file))) throw new Error(`Incomplete download: missing agent/${file}`);
  }
  // Stage a complete copy before replacing the installed application. Only
  // generated files under this target are replaced; shared user data is untouched.
  mkdirSync(workDir, { recursive: true });
  const staging = mkdtempSync(join(workDir, ".install-"));
  const previous = join(staging, "previous");
  try {
    cpSync(source, join(staging, "app"), { recursive: true });
    if (existsSync(installed)) renameSync(installed, previous);
    try { renameSync(join(staging, "app"), installed); }
    catch (error) { if (existsSync(previous)) renameSync(previous, installed); throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// Chrome starts the host with a minimal environment, so pin absolute paths
// to bun and pi in a launcher script. It's machine-specific, so it lives
// in ~/.ardi rather than the repo.
mkdirSync(workDir, { recursive: true });
const launcher = join(workDir, "launch.sh");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
writeFileSync(
  launcher,
  `#!/bin/sh\nexport PATH=${quote(PATH)}\n${piBin ? `export ARDI_PI_BIN=${quote(piBin)}\n` : ""}exec ${quote(bunBin)} ${quote(hostScript)}\n`,
);
chmodSync(launcher, 0o755);

const manifestDir =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts")
    : join(homedir(), ".config/google-chrome/NativeMessagingHosts");
mkdirSync(manifestDir, { recursive: true });

const manifestPath = join(manifestDir, `${nativeHost}.json`);
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      name: nativeHost,
      description: "Ardi bridge to the pi coding agent",
      path: launcher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  ) + "\n",
);

console.log(`Installed ${manifestPath} for extension ${extensionId}`);
console.log(`Launcher: ${launcher} (pi: ${piBin || "not found; set its path in Ardi's Settings"})`);

console.log(`Load unpacked: ${installed}`);
for (const line of install) console.log(line);
console.log("Reload the extension after an upgrade.");
