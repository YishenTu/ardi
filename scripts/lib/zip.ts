import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Windows has no zip command, but its bsdtar (tar.exe) reads and writes zip
// files. Name it rather than resolve it from PATH: under Git Bash, `tar.exe`
// is GNU tar, which takes `C:\...` for a remote host.
export const windowsTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

// Zips the contents of `dir` into `archive`, leaving out the top-level
// files and folders in `exclude`.
export function zip(archive: string, dir: string, exclude: string[] = []): void {
  const entries = readdirSync(dir).filter((name) => !exclude.includes(name));
  const [command, ...args] = process.platform === "win32" ? [windowsTar, "-a", "-c", "-f", archive, ...entries] : ["zip", "-qr", archive, ...entries];
  const result = spawnSync(command, args, { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Could not zip ${dir}`);
}
