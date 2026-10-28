import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

// Session worktrees live in this checkout's .claude/ folder; ignore only that one (a worktree's
// own path also contains ".claude", so a "**/.claude/**" pattern would ignore everything there).
const ownClaudeDir = fileURLToPath(new URL("./.claude/", import.meta.url));

/**
 * Writes dist/sw.js from src/pwa/sw.js once the build is done: the list of every built file
 * (for the offline copy) and a version from their contents, so any change makes a new version.
 */
function serviceWorker(): Plugin {
  return {
    name: "koffbeat-service-worker",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir!;
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      // .woff copies are only for browsers without .woff2; every browser with service workers has it.
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split("\\").join("/"))
        .filter((f) => f !== "sw.js" && !f.endsWith(".woff") && !f.endsWith(".map"))
        .sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const source = readFileSync(fileURLToPath(new URL("./src/pwa/sw.js", import.meta.url)), "utf8")
        .replace("__VERSION__", version)
        .replace("__FILES__", JSON.stringify(["./", ...files.filter((f) => f !== "index.html"), "index.html"]));
      writeFileSync(join(outDir, "sw.js"), source);
    },
  };
}

export default defineConfig({
  // Relative asset paths, so the built app works from any folder (GitHub Pages serves it
  // from /koffbeat/).
  base: "./",
  plugins: [serviceWorker()],
  test: { environment: "node", exclude: [...configDefaults.exclude, ".claude/**"] },
  server: { watch: { ignored: [`${ownClaudeDir}**`] } },
});
