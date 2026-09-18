import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E 配置。
 *
 * 用后端托管**已构建**的编辑器产物（与生产一致），因此跑 E2E 前需要先 `pnpm build`。
 * 平板档位用 Chromium 的触摸模拟（hasTouch + 触摸优先断点），先覆盖交互与布局；
 * 真实 iPad/Safari（WebKit）档位需要额外下载 WebKit 浏览器，留作后续补充。
 *
 * E2E 跑在**临时资源根**上（`DTS_RESOURCES_DIR`）：用例自建自删项目，既不往仓库的
 * `resources/` 里留垃圾，也不受仓库里现成项目的影响（用例必须自给自足）。
 * 临时根里没有 `config/app.json`，后端因此用内置默认值（目录名与生产一致）。
 */

const PORT = Number(process.env.E2E_PORT ?? 1421);

/**
 * 本次运行的临时资源根。
 *
 * 这里**故意不做建目录这类副作用**：worker 进程也会重新求值本文件，任何副作用都会
 * 按 worker 数量翻倍留下垃圾。所以只算路径——目录由后端在首次写入时按需创建
 * （`loadConfig` 读不到 `config/app.json` 就用内置默认值，资源根不存在也不影响启动）。
 */
const RESOURCE_ROOT = join(tmpdir(), `dts-e2e-${process.pid}-${Date.now()}`);
// teardown 模块（只能是文件路径）靠这个环境变量找到同一个临时根
process.env.DTS_E2E_RESOURCES = RESOURCE_ROOT;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tablet-touch-portrait",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: "tablet-touch-landscape",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: "pnpm --filter @dts/backend start",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT), DTS_RESOURCES_DIR: RESOURCE_ROOT },
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
