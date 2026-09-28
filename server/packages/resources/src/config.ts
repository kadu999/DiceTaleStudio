import { z } from "zod";
import { DEFAULT_RESOURCE_DIRS, type ResourceDirs } from "./provider";
import { DEFAULT_PROJECT_FOLDERS, type ResourceKind } from "./ids";

/**
 * 应用配置（`resources/config/app.json`）。
 *
 * 资源根与各类别子目录名**全部由此配置声明**；代码只读配置、不硬编码目录名。
 */

// 显式列出每个类别，并用 satisfies 保证与 ResourceKind 一一对应（漏一个就编译失败）
const dirsSchema = z.object({
  config: z.string().min(1),
  project: z.string().min(1),
} satisfies Record<ResourceKind, z.ZodString>);

/**
 * 生图平台的配置（`app.json` 的 `imageGen.platforms.<平台>`）。
 *
 * 平台文件（`apps/backend/src/image-gen/providers/<平台>.ts`）只描述**协议知识**
 * （端点 / 尺寸形状 / 额外字段 / 修图形状）；**地址与模型是部署参数，只在这里给**——
 * 走自建网关 / 中转、或换接入点时改这里，不用碰代码。其余字段（尺寸 / 超时 / 额外字段）
 * 可留空，用平台文件里的默认值。密钥也放这里（或环境变量）。
 */
export const imagePlatformSchema = z.object({
  /** API 根地址（如 `https://ark.cn-beijing.volces.com/api/v3`）；可被环境变量 `DTS_IMAGE_API_BASE` 覆盖。 */
  baseUrl: z.string().default(""),
  /** 模型名 / 接入点 ID（如 `doubao-seedream-4-0-250828`）；可被 `DTS_IMAGE_MODEL` 覆盖。 */
  model: z.string().default(""),
  /** 密钥；留空 = 这个平台没配好（接口回 400，不会发一个注定 401 的请求）。 */
  apiKey: z.string().default(""),
  /** 默认出图尺寸（`宽x高`，或平台档位如 `2K`）；编辑器里可以逐次改。留空 = 用平台默认。 */
  size: z.string().optional(),
  /** 编辑器尺寸下拉的选项（覆盖平台默认值）。 */
  sizes: z.array(z.string()).optional(),
  /** 覆盖**密钥**的环境变量名（默认用平台自己声明的那个）。 */
  apiKeyEnv: z.string().optional(),
  /** 单次生成的整体超时（毫秒）——出图慢，默认给到 3 分钟。 */
  timeoutMs: z.number().int().positive().optional(),
  /** 额外塞进请求体的字段（与平台默认值**合并**，同名字段以这里为准）。 */
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

export type ImagePlatformOverride = z.infer<typeof imagePlatformSchema>;

export const appConfigSchema = z.object({
  /** 资源根：相对 server/ 的路径，或绝对路径。缺省时后端按模块位置推导。 */
  resourceRoot: z.string().min(1).default("resources"),
  /** 各类别在资源根下的子目录名。 */
  dirs: dirsSchema.default(DEFAULT_RESOURCE_DIRS as ResourceDirs),
  /** 新建项目时自动创建的子目录（相对项目根）。 */
  projectFolders: z.array(z.string().min(1)).default([...DEFAULT_PROJECT_FOLDERS]),
  server: z
    .object({
      host: z.string().min(1).default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(1420),
    })
    .default({ host: "0.0.0.0", port: 1420 }),
  /** 由图片推导网格尺寸时的默认每格像素数（DiceTale 现有地图为 30）。 */
  defaultCellPixels: z.number().int().positive().default(30),
  /**
   * 运行态资源包（前端连上后整包拉取当前项目的 `Assets/`）。
   *
   * `maxTotalBytes` 是**整包上限**：超了就让 `/api/resources/bundle` 回 413，
   * 让前端退回逐文件远程取——服务端是把整包在内存里拼出来的，不设上限会在大项目上把内存吃光。
   */
  bundle: z
    .object({
      maxTotalBytes: z.number().int().positive().default(256 * 1024 * 1024),
    })
    .default({ maxTotalBytes: 256 * 1024 * 1024 }),
  /**
   * HTTP 请求体上限（字节）。
   *
   * 所有读写接口（`/api/resources/raw` / `/api/resources/text` 与各 JSON 接口）都会把
   * **整个 body 读进内存**（`http/requests.ts` 的 `readBody`），不设上限时一个超大请求就能
   * 把服务端内存吃光。超限的请求回 **413**，且在流式读取途中就提前中断（不只信 `content-length`）。
   */
  http: z
    .object({
      maxBodyBytes: z.number().int().positive().default(64 * 1024 * 1024),
    })
    .default({ maxBodyBytes: 64 * 1024 * 1024 }),
  /**
   * AI 生图（编辑器「工具 → AI 生图」用的**外部接口**）。
   *
   * 平台是**一个文件一个平台**（`apps/backend/src/image-gen/providers/*.ts`），后端自动发现；
   * 这里放「用哪个平台（`default`）、落盘目录、默认抠背景」，以及**每个平台的地址 / 模型 /
   * 密钥**（`platforms.<平台>`）。地址与模型是部署参数，只从配置来——平台文件里不写死。
   *
   * 密钥与地址**只在服务端**：环境变量 `DTS_IMAGE_PLATFORM` / `DTS_IMAGE_API_BASE` /
   * `DTS_IMAGE_API_KEY` / `DTS_IMAGE_MODEL` 优先（后三个覆盖**当前平台**的字段），
   * 其次这份配置——浏览器那一侧永远拿不到密钥。
   * 没配密钥 = 这个功能不可用（接口回 400），其余功能一切照旧。
   */
  imageGen: z
    .object({
      /** 用哪个平台（provider 的 `id`）；可被环境变量 `DTS_IMAGE_PLATFORM` 覆盖。 */
      default: z.string().default("volcengine"),
      /** 生成的 PNG 落在项目里的哪个目录（**项目内相对路径**）。 */
      outputDir: z.string().default("Assets/images/generated"),
      /** 是否默认抠掉纯色背景（出图后转成带透明通道的 PNG）；编辑器里可逐次改。 */
      removeBackground: z.boolean().default(false),
      /** 每个平台的地址 / 模型 / 密钥（与尺寸 / 超时等可选覆盖项）。 */
      platforms: z.record(z.string(), imagePlatformSchema).default({}),
    })
    .default({
      default: "volcengine",
      outputDir: "Assets/images/generated",
      removeBackground: false,
      platforms: {},
    }),
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
