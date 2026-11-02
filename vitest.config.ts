import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./scripts/test-setup.mjs"],
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "**/.next*/**",
      "artifacts/**",
      ".artifacts/**",
      "logs/**",
    ],
  },
});
