import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultResourceRoot, loadConfig } from "../src/config";

/**
 * 资源根解析。
 *
 * 回归背景：默认资源根原先按 `process.cwd()` 解析，而 pnpm 执行 workspace 脚本时
 * 会把 cwd 设为包目录（`apps/backend`），于是去找不存在的 `apps/backend/resources`，
 * 配置静默退回内置默认值、资源接口指向错误目录——启动日志里会显示「内置默认值」。
 * 现在改为基于模块位置解析，这里把行为锁住。
 */

const SERVER_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("资源根解析（不受启动目录影响）", () => {
  it("默认资源根由模块位置决定，指向 server/resources", () => {
    expect(defaultResourceRoot()).toBe(join(SERVER_ROOT, "resources"));
  });

  it("是纯函数：从任意模块 URL 出发都解析到该布局下的 resources", () => {
    const moduleUrl = pathToFileURL(
      join(SERVER_ROOT, "apps", "backend", "src", "config.ts"),
    ).href;

    expect(defaultResourceRoot(moduleUrl)).toBe(join(SERVER_ROOT, "resources"));
  });

  it("默认配置能真正读到 config/app.json（不是静默退回内置默认值）", async () => {
    const config = await loadConfig();

    expect(config.usingDefaults).toBe(false);
    expect(config.resourceRoot).toBe(join(SERVER_ROOT, "resources"));
    expect(config.app.server.port).toBe(1420);
    expect(config.dirs.project).toBe("projects");
    expect(config.dirs.config).toBe("config");
    expect(config.app.projectFolders).toContain("Assets/scenes");
  });

  it("显式传入的绝对路径同样生效", async () => {
    const config = await loadConfig(join(SERVER_ROOT, "resources"));
    expect(config.usingDefaults).toBe(false);
    expect(config.resourceRoot).toBe(join(SERVER_ROOT, "resources"));
  });
});
