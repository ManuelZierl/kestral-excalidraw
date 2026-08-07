import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    setupFiles: ["./src/testSetup.ts"],
    server: {
      deps: {
        inline: ["@excalidraw/excalidraw", "roughjs"],
      },
    },
  },
});
