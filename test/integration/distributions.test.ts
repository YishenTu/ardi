import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FAKE_PI } from "../support/executables";
import { waitFor } from "../support/wait";
import { joinParts } from "../../src/bridge/protocol";

const root = resolve(import.meta.dirname, "../..");
const run = async (args: string[], env = process.env) => {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
};

test("both distributions build and install without overwriting each other", async () => {
  const home = mkdtempSync(join(tmpdir(), "ardi-install-"));
  const buildDir = join(home, "dist");
  const env = { ...process.env, HOME: home, ARDI_BUILD_DIR: buildDir, ARDI_RELEASE_DIR: join(home, "zips") };
  // Pi supplies these dependencies via loader aliases; direct test imports
  // need equivalent resolution outside the repository.
  symlinkSync(join(root, "node_modules"), join(home, "node_modules"));
  try {
    await run(["run", "build"], env);
    for (const target of ["ardia", "chrome"]) writeFileSync(join(buildDir, target, "build-marker.txt"), target);
    await run(["scripts/zip.ts"], env);
    for (const target of ["ardia", "chrome"]) {
      const archive = join(env.ARDI_RELEASE_DIR, `ardi-${target}.zip`);
      expect(existsSync(archive)).toBe(true);
      const marker = spawnSync("unzip", ["-p", archive, "build-marker.txt"], { encoding: "utf8" });
      expect(marker.status).toBe(0);
      expect(marker.stdout).toBe(target);
      const out = join(buildDir, target);
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      expect(manifest.permissions.includes("debugger")).toBe(target === "chrome");
      // The extension ID, and so the native host's allowlist, comes from the target's key.
      expect(manifest.key).toBe(JSON.parse(readFileSync(join(root, "src/targets", target, "manifest.json"), "utf8")).key);
      expect(existsSync(join(out, "bridge/main.js"))).toBe(true);
      const agent = readFileSync(join(out, "agent/extension/index.js"), "utf8");
      expect(agent).not.toContain("ARDI_BROWSER_URL) return");
      expect(existsSync(join(out, "agent/references", target === "chrome" ? "ardia.md" : "chrome.md"))).toBe(false);
      await run(["scripts/install-host.ts", target], env);
      const hostName = target === "chrome" ? "com.ardi.chrome.pi" : "com.ardi.pi";
      const hostDir = platform() === "darwin" ? "Library/Application Support/Google/Chrome/NativeMessagingHosts" : ".config/google-chrome/NativeMessagingHosts";
      const host = JSON.parse(readFileSync(join(home, hostDir, `${hostName}.json`), "utf8"));
      const id = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).replace(/./g, h => String.fromCharCode(97 + parseInt(h, 16)));
      expect(host.name).toBe(hostName);
      expect(host.allowed_origins).toEqual([`chrome-extension://${id}/`]);
      expect(readFileSync(join(out, "background.js"), "utf8")).toContain(hostName);
      const log = join(home, `${target}-launch.json`);
      const child = spawn(host.path, [], { env: { ...process.env, HOME: home, FAKE_PI_LAUNCH_LOG: log, ARDI_BROWSER_MODE: target === "chrome" ? "ardia" : "chrome", ARDI_BROWSER_URL: "http://invalid.test" } });
      const exited = new Promise(resolve => child.once("exit", resolve));
      let ready = false;
      const receive = joinParts(event => { if (event.type === "ready") ready = true; });
      let pending = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
          const length = pending.readUInt32LE(0);
          receive(JSON.parse(pending.subarray(4, 4 + length).toString()));
          pending = pending.subarray(4 + length);
        }
      });
      try {
        const body = Buffer.from(JSON.stringify({ type: "start", piPath: FAKE_PI }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        child.stdin.write(Buffer.concat([header, body]));
        await waitFor(() => expect(ready).toBe(true));
        const launch = JSON.parse(readFileSync(log, "utf8"));
        expect(launch.cwd).toBe(realpathSync(join(home, ".ardi")));
        expect(launch.relay).toBe(target === "chrome");
        const args: string[] = launch.args;
        const extension = args[args.indexOf("--extension") + 1];
        const registered: { name: string; description: string }[] = [];
        expect(extension).toBe(realpathSync(join(out, "agent/extension")));
        const { default: register } = await import(join(extension, "index.js"));
        register({ on() {}, registerTool(tool: { name: string; description: string }) { registered.push(tool); } });
        const enabled = args[args.indexOf("--tools") + 1].split(",");
        expect(enabled).toEqual(expect.arrayContaining(registered.map(t => t.name)));
        expect(registered.map(t => t.name)).toContain(target === "chrome" ? "browser_exec" : "ardia_exec");
        expect(enabled).not.toContain(target === "chrome" ? "ardia_exec" : "browser_exec");
        const reference = join(out, "agent/references", target === "chrome" ? "chrome.md" : "ardia.md");
        expect(registered.some(t => t.description.includes(reference))).toBe(true);
        expect(existsSync(reference)).toBe(true);
        expect(existsSync(join(home, ".ardi/references"))).toBe(false);
      } finally { child.stdin.end(); await exited; }

    }
    const ardia = readFileSync(join(home, ".ardi/runtime/ardia/launch.sh"), "utf8");
    const chrome = readFileSync(join(home, ".ardi/runtime/chrome/launch.sh"), "utf8");
    expect(ardia).toContain("dist/ardia/bridge/main.js");
    expect(chrome).toContain("dist/chrome/bridge/main.js");
    await run(["scripts/install-host.ts", "ardia"], env);
    expect(readFileSync(join(home, ".ardi/runtime/chrome/launch.sh"), "utf8")).toBe(chrome);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
