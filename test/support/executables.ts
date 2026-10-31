// Programs tests run: the fake pi, and small scripts in the temp home. On
// Windows each is installed the way npm installs pi there: a .cmd shim that
// runs a JS file with the node.exe beside it (here, a copy of bun).
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FAKE_PI_SOURCE = resolve(import.meta.dirname, "../fixtures/fake-pi.ts");

// npm's cmd-shim output for a package bin, as `npm install -g` writes it.
export function npmShim(script: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    "",
  ].join("\r\n");
}

// Writes an executable `dir/name` (`name.cmd` on Windows) that runs the
// JavaScript `source` on bun, and returns the path to run.
export function executable(name: string, source: string, dir = homedir()): string {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env bun\n${source}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const script = `node_modules\\${name}\\cli.js`;
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, script), source);
  const node = join(dir, "node.exe");
  if (!existsSync(node)) {
    try { linkSync(process.execPath, node); } catch { copyFileSync(process.execPath, node); }
  }
  const shim = join(dir, `${name}.cmd`);
  writeFileSync(shim, npmShim(script));
  return shim;
}

// Installs the fake pi as `pi` in `dir` (a PATH folder, say), and returns
// the path to run.
export function fakePi(dir: string): string {
  if (process.platform === "win32") return executable("pi", `await import(${JSON.stringify(pathToFileURL(FAKE_PI_SOURCE).href)});`, dir);
  mkdirSync(dir, { recursive: true });
  symlinkSync(FAKE_PI_SOURCE, join(dir, "pi"));
  return join(dir, "pi");
}

export const FAKE_PI = process.platform === "win32" ? fakePi(join(homedir(), "fake-pi")) : FAKE_PI_SOURCE;
