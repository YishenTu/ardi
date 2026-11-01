// Installed native hosts, found and started the way the browser does it on
// each OS.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { windowsTar } from "../../scripts/lib/zip";

const windows = platform() === "win32";

export const LAUNCHER = windows ? "launch.cmd" : "launch.sh";

// Environment for an installer run, with its own home. On Windows, hosts
// register under a throwaway registry key (removed by `cleanUp`), never
// Chrome's real one.
export function installEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USERPROFILE: home };
  if (windows) env.ARDI_NATIVE_HOSTS_KEY = `HKCU\\Software\\ArdiTest\\${randomUUID()}`;
  return env;
}

export function cleanUp(env: Record<string, string>): void {
  if (env.ARDI_NATIVE_HOSTS_KEY) spawnSync("reg.exe", ["delete", env.ARDI_NATIVE_HOSTS_KEY, "/f"]);
}

// The host manifest the installer registered for `name`.
export function readHostManifest(env: Record<string, string>, name: string): { name: string; path: string; allowed_origins: string[] } {
  let file: string;
  if (windows) {
    const query = spawnSync("reg.exe", ["query", `${env.ARDI_NATIVE_HOSTS_KEY}\\${name}`, "/ve"], { encoding: "utf8" });
    file = /REG_SZ\s+(.+)/.exec(query.stdout)![1].trim();
  } else {
    const dir = platform() === "darwin" ? "Library/Application Support/Google/Chrome/NativeMessagingHosts" : ".config/google-chrome/NativeMessagingHosts";
    file = join(env.HOME, dir, `${name}.json`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

// Starts a host's launcher as Chrome does: directly, or on Windows through
// `cmd.exe /d /s /c` with the caller's origin.
export function startHost(launcher: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (!windows) return spawn(launcher, [], { env });
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${launcher}" chrome-extension://test/ --parent-window=0"`], { env, windowsVerbatimArguments: true, windowsHide: true });
}

// Extracts a zip; Windows' bsdtar reads zip files.
export function unzip(archive: string, dest: string): void {
  const result = windows ? spawnSync(windowsTar, ["-x", "-f", archive, "-C", dest], { encoding: "utf8" }) : spawnSync("unzip", ["-q", archive, "-d", dest], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not extract ${archive}: ${result.stderr}`);
}

// One file from a zip.
export function unzipFile(archive: string, file: string): string {
  const result = windows ? spawnSync(windowsTar, ["-x", "-O", "-f", archive, file], { encoding: "utf8" }) : spawnSync("unzip", ["-p", archive, file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not read ${file} from ${archive}: ${result.stderr}`);
  return result.stdout;
}

// `env` with PATH replaced. Windows spells it Path, and a child given both
// spellings sees either.
export function withPath(env: NodeJS.ProcessEnv, path: string): Record<string, string> {
  const rest = Object.fromEntries(Object.entries(env).filter(([key, value]) => key.toUpperCase() !== "PATH" && value !== undefined)) as Record<string, string>;
  return { ...rest, PATH: path };
}
