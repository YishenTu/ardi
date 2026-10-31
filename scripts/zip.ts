import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const buildDir = resolve(process.env.ARDI_BUILD_DIR || resolve(root, "dist"));
const releaseDir = resolve(process.env.ARDI_RELEASE_DIR || root);
mkdirSync(releaseDir, { recursive: true });

for (const target of readdirSync(join(root, "src/targets"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const archive = resolve(releaseDir, `ardi-${target}.zip`);
  rmSync(archive, { force: true });
  const result = spawnSync("zip", ["-r", archive, ".", "-x", "bridge/*", "agent/*", "target.json"], { cwd: resolve(buildDir, target), stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Could not package ${target}`);
}
