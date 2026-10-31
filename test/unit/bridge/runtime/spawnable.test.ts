import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { npmShim } from "../../../support/executables";
import { readShimTarget, spawnable } from "../../../../src/bridge/runtime/spawnable";

const SCRIPT = "node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";

// An npm global install of pi: <prefix>\pi.cmd running the package's bin.
function install(withNode: boolean): { shim: string; script: string; prefix: string } {
  const prefix = join(homedir(), `npm-${withNode ? "node" : "bare"}`);
  const script = join(prefix, ...SCRIPT.split("\\"));
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(script, "");
  if (withNode) writeFileSync(join(prefix, "node.exe"), "");
  const shim = join(prefix, "pi.cmd");
  writeFileSync(shim, npmShim(SCRIPT));
  return { shim, script, prefix };
}

describe("spawnable", () => {
  test("runs commands as they are outside Windows", () => {
    expect(spawnable("/usr/bin/pi", ["--version"], "darwin")).toEqual({ command: "/usr/bin/pi", args: ["--version"] });
  });

  test("on Windows, runs the script an npm pi.cmd launches with node itself, arguments intact", () => {
    const { shim, script, prefix } = install(true);
    const args = ["--system-prompt", "C:\\Users\\A & B\\prompt.md", "--tools", "read,powershell"];
    expect(spawnable(shim, args, "win32")).toEqual({ command: join(prefix, "node.exe"), args: [script, ...args] });
  });

  test("on Windows, uses node on PATH when npm installed no node.exe beside the shim", () => {
    const { shim, script } = install(false);
    const { command, args } = spawnable(shim, [], "win32");
    expect(command).not.toContain(homedir());
    expect(args).toEqual([script]);
  });

  test("on Windows, runs a JavaScript entry set in Settings with node", () => {
    const { script } = install(false);
    expect(spawnable(script, ["--version"], "win32").args).toEqual([script, "--version"]);
  });

  test("on Windows, refuses a .cmd that isn't an npm launcher instead of running it through cmd.exe", () => {
    const other = join(homedir(), "other.cmd");
    writeFileSync(other, "@echo off\r\necho hi\r\n");
    expect(readShimTarget(other)).toBeNull();
    expect(() => spawnable(other, [], "win32")).toThrow("isn't an npm launcher");
  });
});
