import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageProvider } from "./types";

/**
 * 平台**自动发现**：读本目录下除 `types.ts` / `index.ts` 外的每个 `.ts`，
 * 取其导出的 `provider`。于是「加一个平台」= 往这里丢一个文件，**不用改任何注册表**。
 *
 * 用 `import.meta.url` 定位目录（与运行方式无关：tsx / 测试 / 打包后都对），
 * 文件按名字排序，保证顺序稳定（`app.json` 没指定平台时的兜底是可预期的）。
 */
export async function loadProviders(): Promise<ImageProvider[]> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && name !== "types.ts" && name !== "index.ts")
    .sort();

  const providers: ImageProvider[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(join(dir, file)).href)) as {
      provider?: ImageProvider;
    };
    if (module.provider !== undefined) {
      providers.push(module.provider);
    }
  }

  return providers;
}
