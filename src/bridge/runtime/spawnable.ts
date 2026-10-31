// What to actually spawn for a command. On Windows, npm installs pi as a
// pi.cmd shim, and Node and Bun refuse to start .cmd files without a shell,
// which would re-parse every argument through cmd.exe. So Ardi reads the
// shim, finds the script it runs, and runs that script with node itself.
// Ported from Claudian (src/core/process/windowsCmdShim.ts and
// src/providers/pi/runtime/PiSubprocess.ts).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";

export interface Spawnable {
  command: string;
  args: string[];
}

export function spawnable(command: string, args: string[], platform = process.platform): Spawnable {
  if (platform !== "win32") return { command, args };
  const path = isAbsolute(command) ? command : (Bun.which(command) ?? command);
  const extension = extname(path).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const script = readShimTarget(path);
    if (!script) throw new Error(`Can't start ${path}: it isn't an npm launcher. Set the path to the script it runs instead.`);
    return { command: nodeFor(path), args: [script, ...args] };
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { command: nodeFor(path), args: [path, ...args] };
  return { command: path, args };
}

// The script an npm `.cmd` shim runs with node: its last line ends with
// `"%dp0%\path\to\cli.js" %*` (or `%~dp0`, or an absolute path).
export function readShimTarget(shim: string): string | null {
  let contents: string;
  try { contents = readFileSync(shim, "utf8"); } catch { return null; }
  for (const line of contents.split(/\r?\n/).reverse()) {
    const relative = /"%(?:~dp0|dp0%)\\?([^"]+)"\s+%\*\s*$/i.exec(line);
    const absolute = /"([a-z]:[\\/][^"]+|\\\\[^"]+)"\s+%\*\s*$/i.exec(line);
    const target = relative ? resolve(dirname(shim), relative[1].replace(/\\/g, "/")) : absolute ? normalize(absolute[1]) : null;
    if (target && existsSync(target) && statSync(target).isFile()) return target;
  }
  return null;
}

// npm shims prefer a node.exe beside them, else node on PATH.
function nodeFor(path: string): string {
  const local = join(dirname(path), "node.exe");
  return existsSync(local) ? local : (Bun.which("node") ?? "node");
}
