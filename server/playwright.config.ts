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
 *
 * **用例是完全并行的**（`fullyParallel` + 多 worker）：三条档位线各自跑一份，同一份里的
 * 用例也不排队。这依赖两条纪律，破坏任何一条都会出现「偶发失败」：
 * 1. **每个用例自建自删项目**（`newProject()` 里带时间戳 + 随机后缀），不共用固定名字；
 * 2. **每个用例用自己的 page**（Playwright 默认），不共享 localStorage / 视口状态。
 * 项目名之间不会撞车，所以并行时后端也不会有跨用例的写冲突。
 */

const PORT = Number(process.env.E2E_PORT ?? 1421);

/**
 * 并行 worker 数。
 *
 * 实测（28 核机器，全量 173 条）：4 → 约 46s，连跑两次都干净；8 → 约 40s，
 * 但偶尔有一条用例因为抢不到资源而超时（`Target page, context or browser has been closed`）；
 * 14 以上开始出现真实失败。**稳定压倒快**：默认取 4，想更快再显式覆盖：
 *
 * ```
 * E2E_WORKERS=8 pnpm e2e     # 本机跑，接受偶发一条（重跑即可）
 * E2E_WORKERS=1 pnpm e2e     # 复现「串行才出现的时序问题」
 * ```
 */
const WORKERS = Number(process.env.E2E_WORKERS ?? 4);

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
  fullyParallel: true,
  workers: WORKERS,
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
