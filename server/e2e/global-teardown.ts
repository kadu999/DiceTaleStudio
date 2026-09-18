import { rmSync } from "node:fs";

/**
 * E2E 收尾：删掉本次运行用的临时资源根。
 *
 * `playwright.config.ts` 里 globalTeardown 只能给**文件路径**（不能给函数），
 * 所以临时根的路径经环境变量 `DTS_E2E_RESOURCES` 传进来。
 * 资源根可能是空的（没有任何用例写过盘），`force: true` 让删除照常成功。
 */
export default function globalTeardown(): void {
  const root = process.env.DTS_E2E_RESOURCES;
  if (root !== undefined && root.length > 0) {
    rmSync(root, { recursive: true, force: true });
  }
}
