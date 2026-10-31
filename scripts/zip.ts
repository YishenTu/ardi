import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { zip } from "./lib/zip";

const root = resolve(import.meta.dirname, "..");
const buildDir = resolve(process.env.ARDI_BUILD_DIR || resolve(root, "dist"));
const releaseDir = resolve(process.env.ARDI_RELEASE_DIR || root);
mkdirSync(releaseDir, { recursive: true });

for (const target of readdirSync(join(root, "src/targets"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const archive = resolve(releaseDir, `ardi-${target}.zip`);
  rmSync(archive, { force: true });
  zip(archive, resolve(buildDir, target), ["bridge", "agent", "target.json"]);
}
