import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Session worktrees live under .claude/; their copies of the tests aren't this checkout's.
  test: { environment: "node", exclude: [...configDefaults.exclude, ".claude/**"] },
  server: { watch: { ignored: ["**/.claude/**"] } },
});
