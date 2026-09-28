import {
  assetMetaIdFor,
  guidFromAssetMetaText,
  imageMimeForPath,
  parseResourceId,
  projectAssetId,
  projectNameFromId,
} from "@dts/resources";
import sharp from "sharp";
import {
  generateImage,
  imageGenConfigured,
  imageGenMissing,
  imageGenSupportsEdit,
  imageGenSupportsMask,
  isSizeAccepted,
  resolveImageGenSettings,
} from "../../image-gen/platform";
import type { ImageInput } from "../../image-gen/providers/types";
import { bodyBoolean, bodyTrimmed, readJsonBody } from "../requests";
import { HttpError, badRequest, sendJson } from "../responses";
import type { RouteContext } from "../router";

/**
 * `POST /api/tools/generate-image`：让配置好的生图平台画一张，**直接存成项目素材**。
 *
 * 这条接口是编辑器「工具 → AI 生图」全部的后端：它一次把三件事做完——调外部接口、
 * 把 PNG 写进项目、把那份素材的身份（GUID）一并回给编辑器。编辑器那边拿到 `id` + `guid`
 * 就能立刻当贴图用（与「从项目里挑一张图」完全同一条路，不另开一条）。
 *
 * 请求体：`{ project, prompt, size?, name?, removeBackground?, inputImages?, mask? }`。
 * - **不带 `inputImages`** = 文生图；**带** = 图生图 / 修图（平台不支持则 400）；
 * - `inputImages` 是**项目内素材 ID** 的数组（如 `project:我的项目/Assets/images/a.png`）；
 *   1 张 = 待编辑的图，多张 = 垫图 / 风格参考。图像字节由后端从项目里读，**不由编辑器上传**；
 * - **再带 `mask`** = 蒙版局部重绘（1 张素材 ID，与首图同尺寸；平台不支持则 400）。
 * - `size` / `removeBackground` 缺省用配置里的；`name` 只是文件名（不给就按时间戳起一个）。
 *
 * 平台与请求形状都在服务端（见 `image-gen/providers/`）；这条路由只认形状，不认哪一家。
 *
 * 三种失败各自是什么码：
 * - 参数不对 / 没配密钥 / 平台不支持修图或不支持蒙版 → **400**（都是「你还没准备好」，不是服务坏了）；
 * - 项目不存在 / 输入图不存在 → **404**；
 * - 生图接口那边出错（连不上 / 401 / 没返回图 / 转码失败）→ **502**，消息带上供应商的原话（截断）。
 */
export async function generateImageRoute(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request, ctx.config.app.http.maxBodyBytes);
  const project = bodyTrimmed(body, "project");
  const prompt = bodyTrimmed(body, "prompt");
  if (project.length === 0) {
    throw badRequest("缺少 project 参数");
  }

  if (prompt.length === 0) {
    throw badRequest("先写一句要画什么（提示词不能为空）");
  }

  if (prompt.length > MAX_PROMPT_CHARS) {
    throw badRequest(`提示词太长了（上限 ${MAX_PROMPT_CHARS} 字）`);
  }

  const settings = await resolveImageGenSettings(ctx.config.app);
  if (!imageGenConfigured(settings)) {
    throw badRequest(
      `生图平台「${settings.platform}」还没配好，缺：${imageGenMissing(settings).join("、")}。` +
        `请填 resources/config/app.json 的 imageGen.platforms.${settings.platform}` +
        "（baseUrl / model / apiKey），或用环境变量 DTS_IMAGE_API_BASE / DTS_IMAGE_MODEL / DTS_IMAGE_API_KEY 覆盖",
    );
  }

  const requestedSize = bodyTrimmed(body, "size");
  const size = requestedSize.length === 0 ? settings.size : requestedSize;
  // 形状校验按**平台**来：OpenAI 系只认「宽x高」，Seedream 还认 `2K` / `4K` 这类档位
  if (!isSizeAccepted(settings, size)) {
    throw badRequest(`尺寸要写成 宽x高（如 1024x1024），收到的是「${size}」`);
  }

  // 项目必须先存在：不然 writeBinary 会顺手造出一个空项目目录，那比报错更难查
  if (!(await ctx.provider.exists(projectAssetId(project, "project.json")))) {
    throw new HttpError(404, `项目不存在: ${project}`);
  }

  const requestedImages = bodyStringArray(body, "inputImages");
  if (requestedImages.length > MAX_INPUT_IMAGES) {
    throw badRequest(`输入图太多了（上限 ${String(MAX_INPUT_IMAGES)} 张）`);
  }

  if (requestedImages.length > 0 && !imageGenSupportsEdit(settings)) {
    throw badRequest(`生图平台「${settings.platform}」不支持图生图 / 修图`);
  }

  const maskId = bodyTrimmed(body, "mask");
  if (maskId.length > 0) {
    if (requestedImages.length === 0) {
      throw badRequest("蒙版局部重绘要同时给 inputImages（要重画的底图）");
    }

    if (!imageGenSupportsMask(settings)) {
      throw badRequest(`生图平台「${settings.platform}」不支持蒙版局部重绘`);
    }
  }

  const inputImages = await readInputImages(ctx, project, requestedImages);
  const mask = maskId.length === 0 ? undefined : (await readInputImages(ctx, project, [maskId]))[0];

  const removeBackground = bodyBoolean(body, "removeBackground") ?? ctx.config.app.imageGen.removeBackground;

  let image: { data: Buffer; mime: string };
  try {
    image = await generateImage(settings, prompt, size, removeBackground, inputImages, mask);
  } catch (error) {
    // 供应商的原话对排查最有用（密钥不在里面），整句回给客户端
    throw new HttpError(502, error instanceof Error ? error.message : String(error));
  }

  const relative = outputRelativePath(ctx.config.app.imageGen.outputDir, bodyTrimmed(body, "name"));
  const id = projectAssetId(project, relative);
  await ctx.provider.writeBinary(id, toArrayBuffer(image.data));

  // 身份：provider 写素材时顺手落了一份 meta（新 GUID），这里把它读回来一并回给编辑器
  const metaId = assetMetaIdFor(id);
  const guid =
    metaId === undefined ? "" : guidFromAssetMetaText(await ctx.provider.readText(metaId)) ?? "";

  const dimensions = await readDimensions(image.data);
  ctx.log("info", `生图已落盘: ${id}（${size}，${String(dimensions.width)}x${String(dimensions.height)}）`);
  sendJson(ctx.response, 200, {
    id,
    path: relative,
    guid,
    width: dimensions.width,
    height: dimensions.height,
  });
}

/** 提示词上限（字符）：够写一段场景描述了；再长多半是误贴进来的东西。 */
const MAX_PROMPT_CHARS = 2000;

/** 图生图 / 修图最多几张输入图（多数平台 1–10 张；给个保守上限）。 */
const MAX_INPUT_IMAGES = 10;

/** 从请求体里取「字符串数组」字段；非数组 / 含非字符串项一律给空数组（不猜、不强转）。 */
function bodyStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 把请求里的**项目内素材 ID** 读成图像字节，供图生图 / 修图用。
 *
 * 编辑器只给 ID（素材在后端，不用上传字节）。这里逐个校验：属于本项目、是支持的图片格式、
 * 盘上存在——任一不满足就 400 / 404 说清是哪一张，绝不拿半份数据去调平台。
 */
async function readInputImages(
  ctx: RouteContext,
  project: string,
  ids: readonly string[],
): Promise<ImageInput[]> {
  const images: ImageInput[] = [];
  for (const id of ids) {
    let path: string;
    let kind: string;
    try {
      const parsed = parseResourceId(id);
      path = parsed.path;
      kind = parsed.kind;
    } catch (error) {
      throw badRequest(`输入图 ID 不合法：「${id}」（${String(error)}）`);
    }

    if (kind !== "project") {
      throw badRequest(`输入图必须是项目素材 ID，收到的是「${id}」`);
    }

    if (projectNameFromId(id) !== project) {
      throw badRequest(`输入图「${id}」不属于当前项目「${project}」`);
    }

    const mime = imageMimeForPath(path);
    if (mime === undefined) {
      throw badRequest(`输入图「${id}」不是支持的图片格式（只支持 PNG / JPEG / WebP）`);
    }

    if (!(await ctx.provider.exists(id))) {
      throw new HttpError(404, `输入图不存在: ${id}`);
    }

    images.push({ data: Buffer.from(await ctx.provider.readBinary(id)), mime });
  }

  return images;
}

/**
 * 生成的图落在项目里哪一层、叫什么。
 *
 * `outputDir` 来自配置（默认 `Assets/images/generated`）。文件名只做**保守清洗**：
 * 去掉路径分隔符与控制字符、压掉首尾空白与点，留空就按时间戳起名——
 * 文件名是给人看的，但它首先要是一个合法、不会越界的路径。
 */
function outputRelativePath(outputDir: string, requestedName: string): string {
  const dir = outputDir
    .split("/")
    .map((segment) => sanitize(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
  const base = sanitize(requestedName).replace(/\.png$/i, "");
  const name = base.length === 0 ? defaultImageName() : base;
  return `${dir.length === 0 ? "Assets/images/generated" : dir}/${name}.png`;
}

/** 只留安全字符：中文留着（项目里本来就有中文文件名），路径分隔符与保留字符去掉。 */
function sanitize(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"\\/|?*]/g, "")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 64);
}

/** `gen-20260928-153012-a1b2`：按时间排得住，又不会撞名。 */
function defaultImageName(): string {
  const now = new Date();
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const stamp =
    `${now.getFullYear().toString()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.random().toString(36).slice(2, 6);
  return `gen-${stamp}-${random}`;
}

/** 读像素尺寸（编辑器要靠它写 `ImageRef`；读不出来回 0，不影响这次生成）。 */
async function readDimensions(data: Buffer): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(data, { limitInputPixels: 100_000_000 }).metadata();
    const size = metadata.autoOrient ?? {
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    };
    return { width: size.width, height: size.height };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** `Buffer` → `ArrayBuffer`（provider 接口收的是后者；切片避免共享底层内存池）。 */
function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
