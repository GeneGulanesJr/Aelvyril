import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx", "app/**/*.test.tsx"],
    // Component tests use jsdom — opt-in per file with `// @vitest-environment jsdom`.
    environmentMatchGlobs: [
      ["components/**/*.test.tsx", "jsdom"],
      ["app/**/*.test.tsx", "jsdom"],
    ],
  },
});
