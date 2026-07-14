import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["attack/**/*.test.ts", "attack/**/*.test.tsx"],
    environment: "node",
    restoreMocks: true,
  },
});
