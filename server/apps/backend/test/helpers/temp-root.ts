import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type LoadedConfig } from "../../src/config";

/**
 * 建一个临时资源根，供「真的会写盘」的测试使用。
 *
 * 为什么要隔离：这些测试原本直接写仓库里的 `resources/`，既会留下残留，
 * 也可能与同时运行的服务端/其它测试抢占同一目录而偶发失败。
 * 临时根里没有 `config/app.json`，因此走内置默认值（目录名与生产一致）。
 */
export async function createTempResourceRoot(): Promise<{
  config: LoadedConfig;
  root: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "dts-test-"));
  const config = await loadConfig(root);

  return {
    config,
    root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
