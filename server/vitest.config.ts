import { defineConfig } from "vitest/config";

/**
 * 统一测试配置。
 *
 * - 内部包（packages/*）与后端跑在 node 环境；
 * - 编辑器组件测试跑在 jsdom；
 * - 架构边界测试（test/）也跑在 node。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "test/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "apps/backend/test/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "editor",
          environment: "jsdom",
          include: ["apps/editor/test/**/*.test.ts", "apps/editor/test/**/*.test.tsx"],
        },
      },
    ],
  },
});
