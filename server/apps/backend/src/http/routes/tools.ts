import { assetMetaIdFor, guidFromAssetMetaText, projectAssetId } from "@dts/resources";
import sharp from "sharp";
import {
  generateImage,
  imageGenConfigured,
  resolveImageGenSettings,
} from "../../image-gen/openai-image";
import { bodyTrimmed, readJsonBody } from "../requests";
import { HttpError, badRequest, sendJson } from "../responses";
import type { RouteContext } from "../router";

/**
 * `POST /api/tools/generate-image`：让配置好的生图接口画一张，**直接存成项目素材**。
 *
 * 这条接口是编辑器「工具 → AI 生图」全部的后端：它一次把三件事做完——调外部接口、
 * 把 PNG 写进项目、把那份素材的身份（GUID）一并回给编辑器。编辑器那边拿到 `id` + `guid`
 * 就能立刻当贴图用（与「从项目里挑一张图」完全同一条路，不另开一条）。
 *
 * 请求体：`{ project, prompt, size?, name? }`；`size` 缺省用配置里的，
 * `name` 只是文件名（不给就按时间戳起一个）。
 *
 * 三种失败各自是什么码：
 * - 参数不对 / 没配密钥 → **400**（这两件都是「你还没准备好」，不是服务坏了）；
 * - 项目不存在 → **404**；
 * - 生图接口那边出错（连不上 / 401 / 没返回图）→ **502**，消息带上供应商的原话（截断）。
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

  const settings = resolveImageGenSettings(ctx.config.app);
  if (!imageGenConfigured(settings)) {
    throw badRequest(
      "还没配置生图接口：设置环境变量 DTS_IMAGE_API_KEY（可选 DTS_IMAGE_API_BASE / DTS_IMAGE_MODEL），" +
        "或填 resources/config/app.json 的 imageGen.apiKey",
    );
  }

  const requestedSize = bodyTrimmed(body, "size");
  const size = requestedSize.length === 0 ? settings.size : requestedSize;
  if (!/^\d{2,4}x\d{2,4}$/.test(size)) {
    throw badRequest(`尺寸要写成 宽x高（如 1024x1024），收到的是「${size}」`);
  }

  // 项目必须先存在：不然 writeBinary 会顺手造出一个空项目目录，那比报错更难查
  if (!(await ctx.provider.exists(projectAssetId(project, "project.json")))) {
    throw new HttpError(404, `项目不存在: ${project}`);
  }

  let image: { data: Buffer; mime: string };
  try {
    image = await generateImage(settings, prompt, size);
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
