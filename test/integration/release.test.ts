import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { waitFor } from "../support/wait";
import { fakePi, NODE } from "../support/executables";
import { cleanUp, installEnv, LAUNCHER, startHost, unzip, withPath } from "../support/nativeHost";

const windows = process.platform === "win32";

const root = resolve(import.meta.dirname, "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("release installs survive deleting downloads, coexist, and preserve shared user files", async () => {
  // Spaces, quotes and non-ASCII letters in paths reach every launcher.
  const temp = mkdtempSync(join(tmpdir(), "ardi release 'tést-"));
  const home = join(temp, "home");
  const bin = join(temp, "bin");
  mkdirSync(bin, { recursive: true });
  // Users have Node (Pi needs it) and Pi, but no Bun. On Windows, node.exe
  // sits beside npm's pi.cmd, as npm installs it.
  if (!windows) symlinkSync(NODE, join(bin, "node"));
  fakePi(bin);
  const releaseDir = join(temp, "releases");
  const system = windows ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  const env: Record<string, string> = { ...withPath(process.env, [bin, ...system].join(delimiter)), ARDI_BUILD_DIR: join(temp, "dist"), ARDI_RELEASE_DIR: releaseDir, ...installEnv(home) };
  const run = (command: string[], cwd = root, runEnv: Record<string, string> = env) => {
    const result = spawnSync(command[0], command.slice(1), { cwd, env: runEnv, encoding: "utf8" });
    expect({ code: result.status, error: result.status ? result.stdout + result.stderr : "" }).toEqual({ code: 0, error: "" });
    return result.stdout;
  };
  const install = (target: string, cwd: string, runEnv = env) => spawnSync(NODE, ["install-host.mjs", target], { cwd, env: runEnv, encoding: "utf8" });
  try {
    // Only the build uses Bun.
    run([process.execPath, "run", "release:package"], root, { ...env, PATH: [dirname(process.execPath), env.PATH].join(delimiter) });
    mkdirSync(join(home, ".ardi/.agents/skills"), { recursive: true });
    writeFileSync(join(home, ".ardi/AGENTS.md"), "User instructions\n");
    writeFileSync(join(home, ".ardi/.agents/skills/keep.md"), "User skill\n");
    const launchers: string[] = [];
    // Ardia doesn't support Windows yet; its installer says so.
    if (windows) {
      const download = join(temp, "download-ardia");
      mkdirSync(download);
      unzip(join(releaseDir, `ardi-ardia-${version}.zip`), download);
      const refused = install("ardia", download);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("doesn't support win32 yet");
    }
    for (const target of windows ? ["chrome"] : ["ardia", "chrome"]) {
      const download = join(temp, `download-${target}`);
      mkdirSync(download);
      unzip(join(releaseDir, `ardi-${target}-${version}.zip`), download);
      if (!windows) {
        // A Node too old for Pi is refused before anything is installed.
        const old = join(temp, "old-node");
        mkdirSync(old, { recursive: true });
        writeFileSync(join(old, "node"), "#!/bin/sh\necho v20.0.0\n", { mode: 0o755 });
        const tooOld = install(target, download, { ...env, PATH: [old, bin, ...system].join(delimiter) });
        expect(tooOld.status).not.toBe(0);
        expect(tooOld.stderr).toContain("Node.js 22.19 or newer");
      }
      const output = run([NODE, "install-host.mjs", target], download);
      const installed = join(home, ".ardi/runtime", target, "app");
      expect(output).toContain(installed);
      expect(output).toContain(target === "ardia" ? "Settings → Extensions → Add extensions → Load unpacked extension" : "chrome://extensions");
      expect(existsSync(join(installed, "manifest.json"))).toBe(true);
      const launcher = join(home, ".ardi/runtime", target, LAUNCHER);
      launchers.push(readFileSync(launcher, "utf8"));
      expect(launchers.at(-1)).not.toContain(download);
      expect(launchers.at(-1)).not.toMatch(/\bbun\b/i);
      const wrong = install(target === "ardia" ? "chrome" : "ardia", download);
      expect(wrong.status).not.toBe(0);
      expect(wrong.stderr).toContain(`This download is for ${target}`);
      // A failed prerequisite check must leave the installed application intact.
      rmSync(join(bin, windows ? "pi.cmd" : "pi"));
      const missing = install(target, download);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("pi not found on PATH");
      expect(readFileSync(launcher, "utf8")).toBe(launchers[launchers.length - 1]);
      fakePi(bin);
      // Reinstall from the same download, then discard it as a user would.
      run([NODE, "install-host.mjs", target], download);
      rmSync(download, { recursive: true });
      const log = join(home, `${target}-launch.json`);
      const child = startHost(launcher, { ...env, FAKE_PI_LAUNCH_LOG: log });
      const exited = new Promise(resolve => child.once("exit", resolve));
      const events: any[] = [];
      let buffer = Buffer.alloc(0);
      child.stdout.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
          events.push(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
          buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
        }
      });
      const send = (message: unknown) => {
        const body = Buffer.from(JSON.stringify(message));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        child.stdin.write(Buffer.concat([header, body]));
      };
      try {
        send({ type: "start" });
        await waitFor(() => expect(events.map(e => e.type)).toContain("ready"));
        if (target === "chrome") {
          // Pi's browser tools reach the extension through the bridge's relay.
          send({ type: "prompt", text: "browser:list" });
          await waitFor(() => expect(events.map(e => e.type)).toContain("browser_request"));
          send({ type: "browser_reply", id: events.find(e => e.type === "browser_request").id, result: [] });
          await waitFor(() => expect(events).toContainEqual({ type: "chunk", chunk: { type: "text", content: "echo: []" } }));
        }
        const launch = JSON.parse(readFileSync(log, "utf8"));
        expect(launch.relay).toBe(target === "chrome");
        const entrypoint = launch.args[launch.args.indexOf("--extension") + 1];
        expect(entrypoint).toEndWith(join("runtime", target, "app", "agent", "extension"));
        expect(existsSync(join(entrypoint, "index.js"))).toBe(true);
      } finally { child.stdin.end(); await exited; }
      expect(existsSync(join(installed, "agent/references", target === "ardia" ? "ardia.md" : "chrome.md"))).toBe(true);
      if (target === "ardia") expect(readFileSync(join(installed, "agent/references/ardia.md"), "utf8")).not.toContain(root);
    }
    if (!windows) expect(readFileSync(join(home, ".ardi/runtime/ardia", LAUNCHER), "utf8")).toBe(launchers[0]);
    expect(readFileSync(join(home, ".ardi/AGENTS.md"), "utf8")).toBe("User instructions\n");
    expect(readFileSync(join(home, ".ardi/.agents/skills/keep.md"), "utf8")).toBe("User skill\n");
  } finally { cleanUp(env); rmSync(temp, { recursive: true, force: true }); }
}, 60_000);
