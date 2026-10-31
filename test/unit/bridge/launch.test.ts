import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { script } from "../../support/executables";
import { buildPiLaunchSpec, piCommand, prepareWorkDir, WORK_DIR } from "../../../src/bridge/launch";

afterEach(() => {
  delete process.env.ARDI_PI_BIN;
});

describe("piCommand", () => {
  test("with no path, uses the pi host:install found, else pi on PATH", () => {
    expect(piCommand()).toBe("pi");
    expect(piCommand("  ")).toBe("pi");
    process.env.ARDI_PI_BIN = "/opt/bin/pi";
    expect(piCommand("")).toBe("/opt/bin/pi");
  });

  test("expands ~ to the home folder", () => {
    const path = script("my-pi", "exit 0");
    expect(piCommand("~/my-pi")).toBe(path);
  });

  test("rejects a path that doesn't exist or isn't a file, pointing at Settings", () => {
    expect(() => piCommand("/nowhere/pi")).toThrow("Pi not found at /nowhere/pi. Fix the path in Settings.");
    mkdirSync(join(homedir(), "a-folder"), { recursive: true });
    expect(() => piCommand("~/a-folder")).toThrow("is not a file");
  });
});

describe("buildPiLaunchSpec", () => {
  test("runs pi in RPC mode in ~/.ardi, isolated from the user's own pi setup except AGENTS.md", () => {
    const spec = buildPiLaunchSpec();
    expect(spec.cwd).toBe(join(homedir(), ".ardi"));
    expect(spec.args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates"]) expect(spec.args).toContain(flag);
    // AGENTS.md loads the way pi normally does it, so ~/.ardi/AGENTS.md holds the user's instructions for Ardi.
    expect(spec.args).not.toContain("--no-context-files");
    // Ardi's own prompt, extension and skills come back in explicitly.
    expect(spec.args[spec.args.indexOf("--system-prompt") + 1]).toEndWith("src/agent/system-prompt.md");
    expect(spec.args[spec.args.indexOf("--extension") + 1]).toEndWith("src/agent/extension/chrome.ts");
    expect(spec.args[spec.args.indexOf("--skill") + 1]).toBe(join(WORK_DIR, ".agents", "skills"));
    expect(spec.args[spec.args.indexOf("--tools") + 1].split(",")).toContain("browser_exec");
  });

  test("resumes a session only when given one", () => {
    expect(buildPiLaunchSpec().args).not.toContain("--session");
    const args = buildPiLaunchSpec("/s/chat.jsonl").args;
    expect(args[args.indexOf("--session") + 1]).toBe("/s/chat.jsonl");
  });
});

describe("prepareWorkDir", () => {
  test("preserves an existing references link owned by an older installation", () => {
    mkdirSync(WORK_DIR, { recursive: true });
    const refs = join(WORK_DIR, "references");
    rmSync(refs, { force: true });
    symlinkSync("/old/checkout/src/agent/references", refs);
    prepareWorkDir();
    const target = readlinkSync(refs);
    expect(target).toBe("/old/checkout/src/agent/references");
  });
});
