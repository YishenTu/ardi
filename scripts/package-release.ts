import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { zip } from "./lib/zip";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const buildDir = resolve(process.env.ARDI_BUILD_DIR || join(root, "dist"));
const releaseDir = resolve(process.env.ARDI_RELEASE_DIR || root);
mkdirSync(releaseDir, { recursive: true });
const checksums: string[] = [];
for (const target of readdirSync(join(root, "src/targets"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const manifest = JSON.parse(readFileSync(join(buildDir, target, "manifest.json"), "utf8")) as { version: string };
  if (manifest.version !== version) throw new Error("package.json and manifest versions must match before releasing.");
  const staging = mkdtempSync(join(tmpdir(), "ardi-release-"));
  const name = `ardi-${target}-${version}.zip`;
  const archive = join(releaseDir, name);
  try {
    cpSync(join(buildDir, target), join(staging, "payload"), { recursive: true });
    // Users run the installer with Node: no TypeScript, no Bun.
    const installer = spawnSync(process.execPath, ["build", join(root, "scripts/install-host.ts"), "--target=node", "--outfile", join(staging, "install-host.mjs")], { stdio: "inherit" });
    if (installer.status !== 0) throw new Error("bun build of the installer failed");
    cpSync(join(root, "docs/INSTALL.md"), join(staging, "INSTALL.md"));
    cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
    writeFileSync(join(staging, "release.json"), JSON.stringify({ target, version }) + "\n");
    rmSync(archive, { force: true });
    zip(archive, staging);
    checksums.push(`${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${name}`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
writeFileSync(join(releaseDir, "SHA256SUMS"), checksums.join("\n") + "\n");
