import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const buildDir = resolve(process.env.ARDI_BUILD_DIR || join(root, "dist"));
const releaseDir = resolve(process.env.ARDI_RELEASE_DIR || root);
mkdirSync(releaseDir, { recursive: true });
const checksums: string[] = [];
for (const target of ["ardia", "chrome"]) {
  const manifest = JSON.parse(readFileSync(join(buildDir, target, "manifest.json"), "utf8")) as { version: string };
  if (manifest.version !== version) throw new Error("package.json and manifest versions must match before releasing.");
  const staging = mkdtempSync(join(tmpdir(), "ardi-release-"));
  const name = `ardi-${target}-${version}.zip`;
  const archive = join(releaseDir, name);
  try {
    cpSync(join(buildDir, target), join(staging, "payload"), { recursive: true });
    cpSync(join(root, "scripts/install-host.ts"), join(staging, "install-host.ts"));
    cpSync(join(root, "docs/INSTALL.md"), join(staging, "INSTALL.md"));
    cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
    writeFileSync(join(staging, "release.json"), JSON.stringify({ target, version }) + "\n");
    rmSync(archive, { force: true });
    const result = spawnSync("zip", ["-qr", archive, "."], { cwd: staging, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Could not package ${target}`);
    checksums.push(`${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${name}`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
writeFileSync(join(releaseDir, "SHA256SUMS"), checksums.join("\n") + "\n");
