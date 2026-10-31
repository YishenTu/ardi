// Register one distribution without changing the other launcher or host.
// Usage: bun run host:install <ardia|chrome>

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve } from "node:path";

const target = process.argv[2];
if (!target || !/^[a-z]+$/.test(target)) throw new Error("Usage: bun run host:install <ardia|chrome>");

const windows = platform() === "win32";
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
const { nativeHost, nativeHostLocations, install } = JSON.parse(readFileSync(join(source, "target.json"), "utf8")) as {
  nativeHost: string;
  // Where the browser looks for native hosts on each OS: a folder, or on
  // Windows a registry key. A target without the OS doesn't support it yet.
  nativeHostLocations: Partial<Record<string, string>>;
  install: string[];
};
if (!nativeHostLocations[platform()]) throw new Error(`Ardi for ${target} doesn't support ${platform()} yet.`);
// Tests point this at a throwaway key so they never replace a real registration.
const nativeHostLocation = (windows && process.env.ARDI_NATIVE_HOSTS_KEY) || nativeHostLocations[platform()]!;
// Chrome's extension ID: first 32 hex chars of sha256(public key), a-p.
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as { key: string };
const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
  .split("")
  .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
  .join("");

// `bun run` puts node_modules/.bin first on PATH, and the pi dev dependency
// lives there; the user's own PATH, without those, is what the host gets.
const PATH = (process.env.PATH ?? "").split(delimiter).filter((dir) => !/node_modules[\\/]\.bin[\\/]?$/.test(dir)).join(delimiter);
const which = (bin: string) => Bun.which(bin, { PATH }) ?? "";
// Optional: without it, the bridge runs the pi set in Settings, or `pi` on PATH.
const piBin = which("pi");
// The bridge is TypeScript and runs on bun. On Windows, bun on PATH may be
// an npm .cmd shim that Chrome can't keep running; the bun running this
// installer is a real bun.exe.
const bunBin = windows ? process.execPath : which("bun");
if (!bunBin) throw new Error("bun not found on PATH; install Bun before running this installer.");
if (release && !piBin) throw new Error("pi not found on PATH; install the Pi coding agent before running this installer.");
if (release) {
  for (const bin of [bunBin, piBin]) {
    // npm's pi.cmd can only run through cmd.exe. Fine for this fixed
    // command line; the bridge runs pi without it (src/bridge/runtime/spawnable.ts).
    const viaCmd = windows && /\.(cmd|bat)$/i.test(bin);
    const check = viaCmd
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${bin}" --version"`], { env: { ...process.env, PATH }, encoding: "utf8", timeout: 10_000, windowsVerbatimArguments: true })
      : spawnSync(bin, ["--version"], { env: { ...process.env, PATH }, encoding: "utf8", timeout: 10_000 });
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
const launcher = join(workDir, windows ? "launch.cmd" : "launch.sh");
if (windows) {
  // Chrome runs a .cmd host with `cmd.exe /d /s /c`. cmd reads the file in
  // the console code page, so switch to UTF-8 before any path appears; `%`
  // is cmd's only special character inside `set "NAME=value"` and quotes.
  const cmd = (value: string) => value.replaceAll("%", "%%");
  writeFileSync(
    launcher,
    [
      "@echo off",
      "chcp 65001 >nul",
      `set "PATH=${cmd(PATH)}"`,
      ...(piBin ? [`set "ARDI_PI_BIN=${cmd(piBin)}"`] : []),
      `"${cmd(bunBin)}" "${cmd(hostScript)}" %*`,
      "",
    ].join("\r\n"),
  );
} else {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  writeFileSync(
    launcher,
    `#!/bin/sh\nexport PATH=${quote(PATH)}\n${piBin ? `export ARDI_PI_BIN=${quote(piBin)}\n` : ""}exec ${quote(bunBin)} ${quote(hostScript)}\n`,
  );
  chmodSync(launcher, 0o755);
}

// macOS and Linux read host manifests from a folder; Windows reads a
// registry key naming the manifest, which then lives with the launcher.
const manifestDir = windows ? workDir : nativeHostLocation.replace(/^~(?=\/|$)/, homedir());
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

if (windows) {
  const key = `${nativeHostLocation}\\${nativeHost}`;
  const reg = spawnSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { encoding: "utf8", windowsHide: true });
  if (reg.status !== 0) throw new Error(`Could not register ${key}: ${reg.stderr || reg.error?.message}`);
  console.log(`Registered ${key}`);
}

console.log(`Installed ${manifestPath} for extension ${extensionId}`);
console.log(`Launcher: ${launcher} (pi: ${piBin || "not found; set its path in Ardi's Settings"})`);

console.log(`Load unpacked: ${installed}`);
for (const line of install) console.log(line);
console.log("Reload the extension after an upgrade.");
