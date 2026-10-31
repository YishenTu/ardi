// Register one distribution without changing the other launcher or host.
// Usage: bun run host:install <ardia|chrome> (development), or in a release
// download, node install-host.mjs <ardia|chrome> (bundled for Node).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { which as whichOn } from "../src/bridge/runtime/spawnable";

const target = process.argv[2];
if (!target || !/^[a-z]+$/.test(target)) throw new Error("Usage: node install-host.mjs <ardia|chrome> (from source: bun run host:install <ardia|chrome>)");

const windows = platform() === "win32";
// Pi's own minimum for npm installs; the bridge needs no newer.
const MIN_NODE = [22, 19];
const releaseFile = join(import.meta.dirname, "release.json");
const release = existsSync(releaseFile) ? JSON.parse(readFileSync(releaseFile, "utf8")) as { target: string; version: string } : undefined;
if (release && release.target !== target) throw new Error(`This download is for ${release.target}; run node install-host.mjs ${release.target}.`);
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
const which = (bin: string) => whichOn(bin, PATH) ?? "";
// Optional: without it, the bridge runs the pi set in Settings, or `pi` on PATH.
const piBin = which("pi");
const nodeBin = findNode();
if (release && !piBin) throw new Error("pi not found on PATH; install the Pi coding agent before running this installer.");
if (release) {
  // npm's pi.cmd can only run through cmd.exe. Fine for this fixed
  // command line; the bridge runs pi without it (src/bridge/runtime/spawnable.ts).
  const viaCmd = windows && /\.(cmd|bat)$/i.test(piBin);
  const check = viaCmd
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${piBin}" --version"`], { env: { ...process.env, PATH }, encoding: "utf8", timeout: 10_000, windowsVerbatimArguments: true })
    : spawnSync(piBin, ["--version"], { env: { ...process.env, PATH }, encoding: "utf8", timeout: 10_000 });
  if (check.status !== 0) throw new Error(`Cannot run ${piBin} --version: ${check.stderr || check.error?.message || "command failed"}`);
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
// to node and pi in a launcher script. It's machine-specific, so it lives
// in ~/.ardi rather than the repo.
mkdirSync(workDir, { recursive: true });
// npm's pi runs `node` from PATH, so the Node found here goes on it too.
const hostPATH = PATH.split(delimiter).includes(dirname(nodeBin)) ? PATH : [dirname(nodeBin), PATH].join(delimiter);
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
      `set "PATH=${cmd(hostPATH)}"`,
      ...(piBin ? [`set "ARDI_PI_BIN=${cmd(piBin)}"`] : []),
      `"${cmd(nodeBin)}" "${cmd(hostScript)}" %*`,
      "",
    ].join("\r\n"),
  );
} else {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  writeFileSync(
    launcher,
    `#!/bin/sh\nexport PATH=${quote(hostPATH)}\n${piBin ? `export ARDI_PI_BIN=${quote(piBin)}\n` : ""}exec ${quote(nodeBin)} ${quote(hostScript)}\n`,
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
console.log(`Launcher: ${launcher} (node: ${nodeBin}; pi: ${piBin || "not found; set its path in Ardi's Settings"})`);

console.log(`Load unpacked: ${installed}`);
for (const line of install) console.log(line);
console.log("Reload the extension after an upgrade.");

// The bridge runs on Node, which Pi needs too, so use the Node Pi uses:
// npm's node.exe beside pi.cmd on Windows, node on PATH, or the private Node
// pi.dev's installer keeps off PATH (its pi launcher adds it). The first new
// enough for Pi wins.
// TODO: where pi.dev's Windows installer keeps its Node is unverified.
function findNode(): string {
  const candidates = [
    windows && /\.(cmd|bat)$/i.test(piBin) ? join(dirname(piBin), "node.exe") : "",
    which("node"),
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "pi-node/current/bin", windows ? "node.exe" : "node"),
  ];
  const found: string[] = [];
  for (const candidate of new Set(candidates.filter((path) => path && existsSync(path)))) {
    const version = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim() ?? "";
    const [major = 0, minor = 0] = /^v(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number) ?? [];
    if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return candidate;
    found.push(`${candidate} (${version || "unknown version"})`);
  }
  throw new Error(`Node.js ${MIN_NODE.join(".")} or newer not found${found.length ? `; found ${found.join(", ")}` : ""}. Install the Node.js that Pi needs, then run this installer again.`);
}
