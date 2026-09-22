import type { ResourceProvider } from "@dts/resources";
import type { LoadedConfig } from "../config";
import { openFolder as openFolderInFileManager, revealFile as revealFileInFileManager } from "../open-folder";
import { BundleCache } from "../resources/bundle-cache";
import type { LogLevel, RuntimeHub } from "../ws/hub";

/**
 * 服务器级依赖。
 *
 * 这是「路由函数需要什么才拿得到什么」的唯一入口：路由不再从 `createHttpServer` 的闭包里
 * 摸 `config` / `provider` / `hub`，而是从传给它的上下文里取——于是**加一条路由不需要动服务器**。
 */
export interface HttpContext {
  readonly config: LoadedConfig;
  readonly provider: ResourceProvider;
  readonly hub: RuntimeHub;
  readonly log: (level: LogLevel, message: string) => void;
  /**
   * 「在文件管理器里打开目录 / 定位文件」的实现（`/api/projects/reveal` 用）。
   *
   * 参数是**要打开的目录路径**，以及（可选）**要选中的文件路径**——两者都是服务端自己拼出来的
   * 绝对路径。测试注入假的：真的去调系统命令会在跑测试的机器上弹出一堆窗口。
   */
  readonly openFolder: (path: string, selectFile?: string) => Promise<void>;
  /** 资源包缓存（跨请求状态，见 `BundleCache`）。 */
  readonly bundles: BundleCache;
}

export interface HttpServerOptions {
  readonly config: LoadedConfig;
  readonly provider: ResourceProvider;
  readonly hub: RuntimeHub;
  readonly log: (level: LogLevel, message: string) => void;
  /** 覆盖默认的「打开目录 / 定位文件」实现（测试注入假实现）。 */
  readonly openFolder?: (path: string, selectFile?: string) => Promise<void>;
}

/** 装配一次服务器上下文：把可选项补成默认实现，让路由函数拿到的都是必填项。 */
export function createHttpContext(options: HttpServerOptions): HttpContext {
  const { config, provider, hub, log } = options;

  return {
    config,
    provider,
    hub,
    log,
    // 给了 `selectFile` 就走「定位文件」，否则就是普通地打开目录
    openFolder:
      options.openFolder ??
      ((path: string, selectFile?: string) =>
        selectFile === undefined
          ? openFolderInFileManager(path)
          : revealFileInFileManager(selectFile)),
    bundles: new BundleCache((message) => log("info", message)),
  };
}
