import type { ResourceProvider } from "@dts/resources";
import { buildBundle, type ProjectManifest } from "./bundle";

/** 缓存里的一份整包（指纹 + 字节 + 响应头）。 */
export interface CachedBundle {
  readonly fingerprint: string;
  readonly zip: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * 资源包缓存：**每个项目只留最近一份**（key = 项目名）。
 *
 * 打一次包要把整个 `Assets/` 读进内存再拼 zip，几十 MB 量级每次都重打太浪费；
 * 但素材是**外部工具随时可能改**的，所以进缓存前由调用方先算一次指纹（成本 = 一次 `list`），
 * 指纹变了就重打——不需要文件监听，也不会发出发霉的包。
 *
 * 从 `http/server.ts` 搬出来是因为它是**跨请求的状态**：放在服务器闭包里，路由函数就只能
 * 通过闭包拿到它；做成一个对象之后，路由只依赖 `HttpContext`，不再知道「有个 Map」。
 */
export class BundleCache {
  private readonly entries = new Map<string, CachedBundle>();

  constructor(private readonly log: (message: string) => void) {}

  /**
   * 取当前指纹对应的整包；没缓存过或指纹变了就重打一份并替换缓存。
   *
   * `current` 由调用方给出（它已经为了 304 判定算过一次指纹），所以这里**不重复算**。
   */
  async get(
    provider: ResourceProvider,
    project: string,
    current: ProjectManifest,
    maxTotalBytes: number,
  ): Promise<CachedBundle> {
    const cached = this.entries.get(project);
    if (cached !== undefined && cached.fingerprint === current.fingerprint) {
      return cached;
    }

    const built = await buildBundle(provider, project, { maxTotalBytes });
    const next: CachedBundle = {
      fingerprint: built.manifest.fingerprint,
      zip: built.zip,
      headers: { ...built.headers },
    };
    this.entries.set(project, next);
    this.log(
      `已打包资源「${project}」：${built.manifest.entries.length} 个文件 / ` +
        `${built.manifest.bytes} 字节 / ${built.manifest.fingerprint}`,
    );
    return next;
  }
}
