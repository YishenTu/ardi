// Registers the native messaging host with Chrome (macOS / Linux).
// Usage: bun run host:install
//
// The extension ID is fixed by the `key` in public/manifest.json, so it's
// the same on every machine and folder. It's computed from that key here.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import { NATIVE_HOST } from "../src/shared";

const root = resolve(import.meta.dirname, "..");
// The built bridge, so a build updates it along with the extension.
const hostScript = join(root, "dist/bridge/main.js");
if (!existsSync(hostScript)) throw new Error("dist/bridge/main.js not found; run `bun run build` first.");
const workDir = join(homedir(), ".ardi");

// Chrome's extension ID: first 32 hex chars of sha256(public key), a-p.
const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8")) as { key: string };
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
if (!bunBin) throw new Error("bun not found on PATH; the bridge needs it.");

// Chrome starts the host with a minimal environment, so pin absolute paths
// to bun and pi in a launcher script. It's machine-specific, so it lives
// in ~/.ardi rather than the repo.
mkdirSync(workDir, { recursive: true });
const launcher = join(workDir, "launch.sh");
writeFileSync(
  launcher,
  `#!/bin/sh\nexport PATH="${PATH}"\n${piBin ? `export ARDI_PI_BIN="${piBin}"\n` : ""}exec "${bunBin}" "${hostScript}"\n`,
);
chmodSync(launcher, 0o755);

const manifestDir =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts")
    : join(homedir(), ".config/google-chrome/NativeMessagingHosts");
mkdirSync(manifestDir, { recursive: true });

const manifestPath = join(manifestDir, `${NATIVE_HOST}.json`);
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      name: NATIVE_HOST,
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
