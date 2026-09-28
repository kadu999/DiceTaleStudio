import { imageGenConfigured, imageGenSupportsEdit, imageGenSupportsMask, resolveImageGenSettings } from "../../image-gen/platform";
import type { AppConfig } from "@dts/resources";
import type { RouteContext } from "../router";
import { sendJson } from "../responses";
import { messageOf } from "../../values";

/**
 * `GET /api/config`：把配置**读出来的结果**告诉编辑器。
 *
 * 编辑器不自己找资源根（它连文件系统都碰不到），启动时要的这一份就是它知道
 * 「资源根在哪、标准子目录叫什么、每格默认多少像素、配置是从文件读的还是内置默认值」的
 * 唯一来源。`resourceRoot` 是**服务端机器上的绝对路径**，只用于显示与排查。
 *
 * `imageGen` 只回**能给编辑器看的**（平台名 / 当前平台配没配好 / 支持哪些修图能力 / 尺寸档 /
 * 是否默认抠背景）——**密钥与地址永不出现**在这里（它们只活在服务端，见 `image-gen/platform.ts`）。
 */
export async function getConfig(ctx: RouteContext): Promise<void> {
  const { config } = ctx;
  sendJson(ctx.response, 200, {
    resourceRoot: config.resourceRoot,
    dirs: config.dirs,
    projectFolders: config.app.projectFolders,
    defaultCellPixels: config.app.defaultCellPixels,
    usingDefaults: config.usingDefaults,
    imageGen: await imageGenSummary(config.app, ctx),
  });
}

/** 生图设置里可以下发给编辑器的那一部分（**不含密钥 / 地址**）。 */
async function imageGenSummary(
  app: AppConfig,
  ctx: RouteContext,
): Promise<{
  platform: string;
  label: string;
  configured: boolean;
  supportsEdit: boolean;
  supportsMask: boolean;
  defaultSize: string;
  sizes: readonly string[];
  removeBackground: boolean;
  outputDir: string;
} | null> {
  try {
    const settings = await resolveImageGenSettings(app);
    return {
      platform: settings.platform,
      label: settings.label,
      configured: imageGenConfigured(settings),
      supportsEdit: imageGenSupportsEdit(settings),
      supportsMask: imageGenSupportsMask(settings),
      defaultSize: settings.size,
      sizes: settings.sizes,
      removeBackground: app.imageGen.removeBackground,
      outputDir: app.imageGen.outputDir,
    };
  } catch (error) {
    // 生图平台发现 / 解析出岔子，不该牵连配置接口（编辑器还要靠它拿资源根与目录约定）：
    // 如实记一条日志，`imageGen` 回 null，编辑器据此退回内置默认
    ctx.log("error", `读取生图配置失败：${messageOf(error)}`);
    return null;
  }
}
