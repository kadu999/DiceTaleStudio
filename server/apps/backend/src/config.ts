import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RESOURCE_DIRS,
  configId,
  parseAppConfig,
  type AppConfig,
  type ResourceDirs,
} from "@dts/resources";
import { readFile } from "node:fs/promises";

/**
 * 后端配置加载。
 *
 * 这里是**全项目唯一允许出现资源根字面量的地方**（引导路径）：先由环境变量
 * `DTS_RESOURCES_DIR` 或默认值定位资源根，再从中读取 `config/app.json` 得到完整配置。
 * 其余代码一律通过 `ResourceProvider` + 逻辑 ID 访问资源，不碰路径。
 */

/**
 * 默认资源根：**基于模块位置解析**，而不是当前工作目录。
 *
 * 原因：pnpm 执行 workspace 脚本时会把 cwd 设为包目录（`apps/backend`），
 * 若按 cwd 解析会去找不存在的 `apps/backend/resources`，
 * 于是配置静默退回内置默认值、资源接口指向错误目录。
 * 模块位置永远不变，因此这里用 `apps/backend/src/` → `server/resources`。
 */
export function defaultResourceRoot(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../../resources", moduleUrl));
}

export interface LoadedConfig {
  readonly app: AppConfig;
  readonly resourceRoot: string;
  readonly dirs: ResourceDirs;
  /** 配置文件缺失时为 true（使用内置默认值）。 */
  readonly usingDefaults: boolean;
}

function resolveResourceRoot(explicit?: string): string {
  const fromEnv = process.env.DTS_RESOURCES_DIR;
  const value =
    explicit ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : defaultResourceRoot());
  // 默认值已是绝对路径；显式传入的相对路径仍按当前工作目录解析
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export async function loadConfig(explicitRoot?: string): Promise<LoadedConfig> {
  const resourceRoot = resolveResourceRoot(explicitRoot);
  const appConfigPath = resolve(
    resourceRoot,
    DEFAULT_RESOURCE_DIRS.config,
    configId("app").slice("config:".length),
  );

  let raw: unknown = {};
  let usingDefaults = true;
  try {
    raw = JSON.parse(await readFile(appConfigPath, "utf8")) as unknown;
    usingDefaults = false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`读取配置文件失败 ${appConfigPath}: ${String(error)}`, { cause: error });
    }
  }

  const app = parseAppConfig(raw);
  const dirs = { ...DEFAULT_RESOURCE_DIRS, ...app.dirs };

  return { app, resourceRoot, dirs, usingDefaults };
}

/** 端口/主机：环境变量优先于配置文件（与 DiceTale 既有约定一致）。 */
export function resolveServerAddress(app: AppConfig): { host: string; port: number } {
  const host = process.env.HOST ?? app.server.host;
  const portRaw = process.env.PORT;
  const port = portRaw !== undefined && portRaw.length > 0 ? Number(portRaw) : app.server.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`端口非法: ${String(portRaw)}`);
  }

  return { host, port };
}

/** 供日志使用（不暴露绝对路径之外的敏感信息）。 */
export function describeConfig(config: LoadedConfig): string {
  const source = config.usingDefaults ? "内置默认值" : "config/app.json";
  return `资源根: ${config.resourceRoot}（配置来源: ${source}）`;
}

export { dirname };
