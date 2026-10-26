import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Session worktrees live in this checkout's .claude/ folder; ignore only that one (a worktree's
// own path also contains ".claude", so a "**/.claude/**" pattern would ignore everything there).
const ownClaudeDir = fileURLToPath(new URL("./.claude/", import.meta.url));

export default defineConfig({
  test: { environment: "node", exclude: [...configDefaults.exclude, ".claude/**"] },
  server: { watch: { ignored: [`${ownClaudeDir}**`] } },
});
