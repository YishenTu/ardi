import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { waitFor } from "../support/wait";
import { fakePi } from "../support/executables";
import { cleanUp, installEnv, LAUNCHER, startHost, unzip, withPath } from "../support/nativeHost";

const windows = process.platform === "win32";

function linkOrCopy(from: string, to: string): void {
  try { linkSync(from, to); } catch { copyFileSync(from, to); }
}

const root = resolve(import.meta.dirname, "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("release installs survive deleting downloads, coexist, and preserve shared user files", async () => {
  // Spaces, quotes and non-ASCII letters in paths reach every launcher.
  const temp = mkdtempSync(join(tmpdir(), "ardi release 'tést-"));
  const home = join(temp, "home");
  const bin = join(temp, "bin");
  mkdirSync(bin, { recursive: true });
  // The build runs bun from PATH. (On Windows the installer pins the bun running it.)
  if (windows) linkOrCopy(process.execPath, join(bin, "bun.exe"));
  else symlinkSync(process.execPath, join(bin, "bun"));
  fakePi(bin);
  const releaseDir = join(temp, "releases");
  const system = windows ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  const env = { ...withPath(process.env, [bin, ...system].join(delimiter)), ARDI_BUILD_DIR: join(temp, "dist"), ARDI_RELEASE_DIR: releaseDir, ...installEnv(home) };
  const run = (command: string[], cwd = root) => {
    const result = spawnSync(command[0], command.slice(1), { cwd, env, encoding: "utf8" });
    expect({ code: result.status, error: result.status ? result.stdout + result.stderr : "" }).toEqual({ code: 0, error: "" });
    return result.stdout;
  };
  try {
    run([process.execPath, "run", "release:package"]);
    mkdirSync(join(home, ".ardi/.agents/skills"), { recursive: true });
    writeFileSync(join(home, ".ardi/AGENTS.md"), "User instructions\n");
    writeFileSync(join(home, ".ardi/.agents/skills/keep.md"), "User skill\n");
    const launchers: string[] = [];
    // Ardia doesn't support Windows yet; its installer says so.
    if (windows) {
      const download = join(temp, "download-ardia");
      mkdirSync(download);
      unzip(join(releaseDir, `ardi-ardia-${version}.zip`), download);
      const refused = spawnSync(process.execPath, ["install-host.ts", "ardia"], { cwd: download, env, encoding: "utf8" });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("doesn't support win32 yet");
    }
    for (const target of windows ? ["chrome"] : ["ardia", "chrome"]) {
      const download = join(temp, `download-${target}`);
      mkdirSync(download);
      unzip(join(releaseDir, `ardi-${target}-${version}.zip`), download);
      const output = run([process.execPath, "install-host.ts", target], download);
      const installed = join(home, ".ardi/runtime", target, "app");
      expect(output).toContain(installed);
      expect(output).toContain(target === "ardia" ? "Settings → Extensions → Add extensions → Load unpacked extension" : "chrome://extensions");
      expect(existsSync(join(installed, "manifest.json"))).toBe(true);
      const launcher = join(home, ".ardi/runtime", target, LAUNCHER);
      launchers.push(readFileSync(launcher, "utf8"));
      expect(launchers.at(-1)).not.toContain(download);
      const wrong = spawnSync(process.execPath, ["install-host.ts", target === "ardia" ? "chrome" : "ardia"], { cwd: download, env, encoding: "utf8" });
      expect(wrong.status).not.toBe(0);
      expect(wrong.stderr).toContain(`This download is for ${target}`);
      // A failed prerequisite check must leave the installed application intact.
      rmSync(join(bin, windows ? "pi.cmd" : "pi"));
      const missing = spawnSync(process.execPath, ["install-host.ts", target], { cwd: download, env, encoding: "utf8" });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("pi not found on PATH");
      expect(readFileSync(launcher, "utf8")).toBe(launchers[launchers.length - 1]);
      fakePi(bin);
      // Reinstall from the same download, then discard it as a user would.
      run([process.execPath, "install-host.ts", target], download);
      rmSync(download, { recursive: true });
      const log = join(home, `${target}-launch.json`);
      const child = startHost(launcher, { ...env, FAKE_PI_LAUNCH_LOG: log });
      const exited = new Promise(resolve => child.once("exit", resolve));
      let events = "";
      child.stdout.on("data", (data: Buffer) => { events += data.toString(); });
      try {
        const body = Buffer.from(JSON.stringify({ type: "start" }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        child.stdin.write(Buffer.concat([header, body]));
        await waitFor(() => expect(events).toContain('"type":"ready"'));
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
