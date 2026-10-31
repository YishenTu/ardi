import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Zips the contents of `dir` into `archive`, leaving out the top-level
// files and folders in `exclude`. Windows has no zip command, but its
// bsdtar (tar.exe) writes zip files.
export function zip(archive: string, dir: string, exclude: string[] = []): void {
  const entries = readdirSync(dir).filter((name) => !exclude.includes(name));
  const [command, ...args] = process.platform === "win32" ? ["tar.exe", "-a", "-c", "-f", archive, ...entries] : ["zip", "-qr", archive, ...entries];
  const result = spawnSync(command, args, { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Could not zip ${dir}`);
}
