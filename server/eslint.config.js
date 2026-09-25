import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint 扁平配置。
 *
 * 注意：模块边界（packages 不得依赖 UI/宿主、不得互相越权、不得硬编码资源路径）
 * 由 `test/architecture.test.ts` 强制执行——那比 lint 规则更严格也更可读，
 * 这里只做通用的代码质量检查。
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // 迁就既有代码风格：显式 any 在测试与协议解析里偶有使用
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  {
    // Node 脚本（如 scripts/check-code-structure-stats.mjs）跑在 Node 全局上
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },

  {
    // 测试与 e2e 里允许更松的写法
    files: ["**/test/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
