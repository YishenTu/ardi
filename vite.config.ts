import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const target = process.env.ARDI_BUILD_TARGET;
if (target !== "ardia" && target !== "chrome") throw new Error("Set ARDI_BUILD_TARGET to ardia or chrome.");
const chrome = target === "chrome";

// Each distribution carries the bridge and matching Pi setup beside its extension.
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
      const bundle = spawnSync("bun", ["build", "src/bridge/main.ts", "--target=bun", "--define", `__ARDI_TARGET__=${JSON.stringify(target)}`, "--outdir", join(out, "bridge")], { cwd: root, stdio: "inherit" });
      if (bundle.status !== 0) throw new Error("bun build of the bridge failed");
      cpSync(resolve(root, "src/agent"), join(out, "agent"), {
        recursive: true,
        filter: (path) => !["AGENTS.md", ".DS_Store", ...(chrome ? ["ardia.ts", "ardia.md", "pydoll.md"] : ["chrome.ts", "chrome-tools.ts", "chrome.md"])].includes(basename(path)),
      });
      const manifest = JSON.parse(readFileSync(resolve(root, "public/manifest.json"), "utf8"));
      if (chrome) {
        Object.assign(manifest, JSON.parse(readFileSync(resolve(root, "config/chrome.json"), "utf8")));
        manifest.permissions.push("debugger");
        manifest.action.default_title = manifest.name;
      }
      writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  plugins: [host()],
  define: { __ARDI_TARGET__: JSON.stringify(target) },
  build: {
    outDir: resolve(process.env.ARDI_BUILD_DIR || join(root, "dist"), target),
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
