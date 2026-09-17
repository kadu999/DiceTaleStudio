import { z } from "zod";
import { DEFAULT_RESOURCE_DIRS, type ResourceDirs } from "./provider";
import { DEFAULT_CAMPAIGN_FOLDERS, type ResourceKind } from "./ids";

/**
 * 应用配置（`resources/config/app.json`）。
 *
 * 资源根与各类别子目录名**全部由此配置声明**；代码只读配置、不硬编码目录名。
 */

// 显式列出每个类别，并用 satisfies 保证与 ResourceKind 一一对应（漏一个就编译失败）
const dirsSchema = z.object({
  config: z.string().min(1),
  campaign: z.string().min(1),
} satisfies Record<ResourceKind, z.ZodString>);

export const appConfigSchema = z.object({
  /** 资源根：相对 server/ 的路径，或绝对路径。缺省时后端按模块位置推导。 */
  resourceRoot: z.string().min(1).default("resources"),
  /** 各类别在资源根下的子目录名。 */
  dirs: dirsSchema.default(DEFAULT_RESOURCE_DIRS as ResourceDirs),
  /** 新建跑团时自动创建的子目录（相对跑团根）。 */
  campaignFolders: z.array(z.string().min(1)).default([...DEFAULT_CAMPAIGN_FOLDERS]),
  server: z
    .object({
      host: z.string().min(1).default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(1420),
    })
    .default({ host: "0.0.0.0", port: 1420 }),
  /** 由图片推导网格尺寸时的默认每格像素数（DiceTale 现有地图为 30）。 */
  defaultCellPixels: z.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/** 内置默认配置（配置文件缺失或字段缺省时使用）。 */
export function defaultAppConfig(): AppConfig {
  return appConfigSchema.parse({});
}

/** 解析并校验配置对象；失败时抛出带路径的可读错误。 */
export function parseAppConfig(raw: unknown): AppConfig {
  const result = appConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`app 配置校验失败: ${detail}`);
  }

  return result.data;
}
