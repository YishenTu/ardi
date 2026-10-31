import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const target = process.env.ARDI_BUILD_TARGET ?? "";
const targetDir = resolve(root, "src/targets", target);
if (!target || !existsSync(join(targetDir, "target.json"))) {
  throw new Error(`Set ARDI_BUILD_TARGET to one of: ${readdirSync(resolve(root, "src/targets"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).join(", ")}.`);
}

function bun(args: string[], what: string) {
  const result = spawnSync("bun", ["build", ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`bun build of ${what} failed`);
}

// Each distribution carries its target's bridge and Pi setup beside its extension.
function host(): Plugin {
  return {
    name: "ardi-host",
    buildStart() {
      // So `bun run dev` rebuilds on bridge and agent changes too.
      for (const file of readdirSync(resolve(root, "src"), { recursive: true, withFileTypes: true })) {
        if (file.isFile()) this.addWatchFile(join(file.parentPath, file.name));
      }
    },
    writeBundle({ dir }) {
      const out = dir ?? resolve(root, "dist", target);
      bun([join(targetDir, "bridge/main.ts"), "--target=bun", "--outdir", join(out, "bridge")], "the bridge");
      // Pi supplies its own SDK and typebox to extensions.
      bun([join(targetDir, "agent/extension/index.ts"), "--target=node", "--external", "@earendil-works/pi-coding-agent", "--external", "typebox", "--outdir", join(out, "agent/extension")], "the Pi extension");
      cpSync(resolve(root, "src/agent/system-prompt.md"), join(out, "agent/system-prompt.md"));
      cpSync(join(targetDir, "agent/references"), join(out, "agent/references"), { recursive: true, filter: (path) => !path.endsWith(".DS_Store") });
      // For the installer: the native host name and loading instructions.
      cpSync(join(targetDir, "target.json"), join(out, "target.json"));
      const base = JSON.parse(readFileSync(resolve(root, "src/manifest.json"), "utf8"));
      const overlay = JSON.parse(readFileSync(join(targetDir, "manifest.json"), "utf8"));
      const manifest = { ...base, ...overlay, permissions: [...base.permissions, ...(overlay.permissions ?? [])] };
      manifest.action = { ...manifest.action, default_title: manifest.name };
      writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  plugins: [host()],
  build: {
    outDir: resolve(process.env.ARDI_BUILD_DIR || join(root, "dist"), target),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        sidepanel: resolve(root, "src/sidepanel/index.html"),
        background: join(targetDir, "background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
