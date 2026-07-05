import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 在任何源码模块加载前隔离存储路径(见 vitest.setup.ts)
    setupFiles: ["./vitest.setup.ts"],
  },
});
