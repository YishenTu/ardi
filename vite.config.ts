import { spawnSync } from "node:child_process";
import { cpSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;

// The bridge and pi's agent setup go into dist/ too, so a build updates
// everything the browser runs: dist/bridge/main.js (bundled for bun, which
// ~/.ardi/launch.sh runs) and dist/agent/ (loaded by pi as is).
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
      const out = dir ?? resolve(root, "dist");
      const bundle = spawnSync("bun", ["build", "src/bridge/main.ts", "--target=bun", "--outdir", join(out, "bridge")], { cwd: root, stdio: "inherit" });
      if (bundle.status !== 0) throw new Error("bun build of the bridge failed");
      cpSync(resolve(root, "src/agent"), join(out, "agent"), {
        recursive: true,
        filter: (path) => !["AGENTS.md", ".DS_Store"].includes(basename(path)),
      });
    },
  };
}

export default defineConfig({
  plugins: [host()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        sidepanel: resolve(root, "src/sidepanel/index.html"),
        background: resolve(root, "src/background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
