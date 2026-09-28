/**
 * 生图平台的**接口**：一个平台 = 一个文件（`providers/*.ts` 导出一个 `provider`）。
 *
 * 平台文件只描述**协议知识**（端点 / 尺寸形状 / 额外字段 / 修图形状），不放业务
 * （存盘、素材身份、失败怎么回），也**不放部署参数**：
 * `baseUrl` 与 `model` 可能因自建网关 / 中转 / 不同接入点而不同，属于**部署配置**，
 * 一律写在 `resources/config/app.json` 的 `imageGen.platforms.<平台>` 里（见 `@dts/resources`
 * 的 `imagePlatformSchema`）——平台文件里不写死，改地址 / 换模型不用碰代码。
 *
 * 绝大多数平台吃 OpenAI 兼容的 `{model, prompt, size, n}`，直接调 `openAiCompatibleProvider`
 * 一行建出来；形状确实不同的，实现这个接口即可。
 *
 * **加一个平台 = 在 `providers/` 下加一个文件**（导出 `provider`），无需改任何注册表：
 * 目录里的文件由 `providers/index.ts` 自动发现。地址与模型则在该平台的配置项里给。
 *
 * **一次请求两种用途**：`input.images` 为空 = **文生图**；有输入图 = **图生图 / 修图**
 * （各平台自己决定怎么带上输入图，接口只要求把差异封在 `buildRequest` 里）。
 *
 * 修图再分两种粒度（都在接口里预留，平台按自己支持情况声明）：
 * - **整图重画 / 多图参考**：`images` 给 1 张（待改的图）或多张（垫图 / 风格参考）；
 * - **蒙版局部重绘**：再给一个 `mask`（与首图同尺寸，白 / 不透明处 = 要重画），
 *   需要平台声明 `supportsMask`——不支持的平台带 mask 会被路由明确回 400。
 */

/** 一张输入图（图生图 / 修图 / 参考图 / 蒙版）。 */
export interface ImageInput {
  readonly data: Buffer;
  /** `image/png` / `image/jpeg` / `image/webp`。 */
  readonly mime: string;
}

/** 「画一张」要用的入参（业务层组装好再交给平台）。 */
export interface ImageGenerationInput {
  readonly prompt: string;
  readonly size: string;
  readonly model: string;
  /** 平台默认 `extraBody` 与配置覆盖合并后的结果。 */
  readonly extraBody: Record<string, unknown>;
  /**
   * 输入图；空 = 文生图。
   * - 1 张 = 待编辑的图（整图重画）；
   * - 多张 = 垫图 / 风格参考（平台支持几张由自己决定）。
   */
  readonly images: readonly ImageInput[];
  /** 蒙版局部重绘的蒙版（需平台 `supportsMask`；与 `images[0]` 同尺寸）。 */
  readonly mask?: ImageInput;
}

/** 发给平台的一个请求：要么 JSON，要么 multipart（带文件，如 OpenAI 的 `images/edits`）。 */
export type ImageRequest =
  | {
      readonly kind: "json";
      /** 相对 `baseUrl` 的端点路径。 */
      readonly endpoint: string;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly kind: "multipart";
      readonly endpoint: string;
      /** 文本字段（值一律是字符串）。 */
      readonly fields: Record<string, string>;
      /** 文件字段（`image[]` / `image` 由平台决定）。 */
      readonly files: ReadonlyArray<{
        readonly field: string;
        readonly filename: string;
        readonly mime: string;
        readonly data: Buffer;
      }>;
    };

/**
 * 平台默认值（可被 `app.json` 的 `imageGen.platforms.<id>` 覆盖）。
 *
 * **不在其中**：`baseUrl` 与 `model`——它们是部署参数，只从配置来（见文件头说明）。
 */
export interface ImageProviderDefaults {
  /** 默认出图尺寸（`宽x高`，或平台自己的档位如 `2K`）。 */
  readonly size: string;
  /** 编辑器尺寸下拉里给的选项。 */
  readonly sizes: readonly string[];
  /** 单次生成的整体超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 额外塞进请求体的字段（各平台的开关，如 `response_format` / `watermark`）。 */
  readonly extraBody: Record<string, unknown>;
}

export interface ImageProvider {
  /** 平台唯一名（`app.json` 的 `platforms` 用它当键，环境变量 `DTS_IMAGE_PLATFORM` 也是）。 */
  readonly id: string;
  /** 给人看的名字（日志 / 界面）。 */
  readonly label: string;
  /** 默认的密钥环境变量名（如 `DTS_IMAGE_API_KEY`）。 */
  readonly apiKeyEnv: string;
  readonly defaults: ImageProviderDefaults;
  /** **文生图**的端点路径（如需按尺寸请求的 `type`，由平台自己拼）。 */
  readonly endpoint: string;
  /** 支不支持**图生图 / 修图**（不支持时，带输入图的请求会被路由明确回 400）。 */
  readonly supportsEdit: boolean;
  /** 支不支持**蒙版局部重绘**（不支持时，带 `mask` 的请求会被路由明确回 400）。 */
  readonly supportsMask: boolean;
  /** 这个平台认的尺寸形状（如 Seedream 还认 `2K` / `4K` 档位）。 */
  acceptsSize(size: string): boolean;
  /** 组请求体：有输入图时走「修图」，没有就是「文生图」。 */
  buildRequest(input: ImageGenerationInput): ImageRequest;
  /** 从响应 JSON 里取图：`b64_json` 优先，其次 `url`。取不到返回 undefined。 */
  parseImage(payload: unknown): { base64?: string; url?: string } | undefined;
}

/** `宽x高`（如 `1024x1024`）——OpenAI 系只认这一种。 */
export const WIDTH_HEIGHT = /^\d{2,4}x\d{2,4}$/;

/** 尺寸档位（如 `2K` / `4K`）——Seedream 这类平台认。 */
export const SIZE_TIER = /^\d+K$/i;

/** `data[0]` 里的图：`b64_json` 优先，其次 `url`（Dall·E 那种只回链接）。 */
export function parseDataEntry(payload: unknown): { base64?: string; url?: string } | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    return undefined;
  }

  const first: unknown = data[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }

  const b64Json = (first as { b64_json?: unknown }).b64_json;
  const url = (first as { url?: unknown }).url;
  const hasB64 = typeof b64Json === "string" && b64Json.length > 0;
  const hasUrl = typeof url === "string" && url.length > 0;
  if (!hasB64 && !hasUrl) {
    return undefined;
  }

  return {
    ...(hasB64 ? { base64: b64Json as string } : {}),
    ...(hasUrl ? { url: url as string } : {}),
  };
}

/** 把 `extraBody` 的值摊成 multipart 的字符串字段（标量直接转，对象用 JSON）。 */
function asFieldText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** OpenAI 式 `images/edits`：multipart 传原图（可选再带一个蒙版）。 */
export interface MultipartEdit {
  readonly kind: "multipart";
  /** 修图端点（如 `/images/edits`）。 */
  readonly endpoint: string;
  /** 输入图的字段名（默认 `image`）。 */
  readonly fileField?: string;
  /** 蒙版字段名（默认 `mask`）；`supportsMask` 为 true 时用它放 `input.mask`。 */
  readonly maskField?: string;
}

/** 国内常见：仍走文生图端点，把原图当 data URI 放进 JSON 的某个字段。 */
export interface DataUriEdit {
  readonly kind: "data-uri";
  /** 放输入图的字段名（默认 `image`）。 */
  readonly imageField?: string;
  /** 放蒙版的字段名（默认 `mask`）；`supportsMask` 为 true 时用它放 `input.mask`。 */
  readonly maskField?: string;
}

export type EditMode = MultipartEdit | DataUriEdit;

export interface OpenAiCompatibleOptions {
  id: string;
  label: string;
  /** 默认出图尺寸（`宽x高`，或平台档位如 `2K`）。 */
  size: string;
  /** 编辑器尺寸下拉的选项。 */
  sizes: readonly string[];
  /** 默认 `DTS_IMAGE_API_KEY`。 */
  apiKeyEnv?: string;
  /** 默认 3 分钟。 */
  timeoutMs?: number;
  /** 额外请求体字段。 */
  extraBody?: Record<string, unknown>;
  /** 是否额外汇认 `2K` 这类档位（如火山 Seedream）。 */
  sizeTiers?: boolean;
  /** 图生图 / 修图的形状。不给 = 这个平台只支持文生图。 */
  edit?: EditMode;
  /**
   * 这个平台支不支持**蒙版局部重绘**（默认 false）。为 true 时才允许带 `mask`，
   * 并按对应 `edit` 形状把蒙版放进 `maskField`。**仅预留能力**，平台上没有把握就别开。
   */
  supportsMask?: boolean;
}

/**
 * **通用（OpenAI 兼容）平台工厂**：事实标准，国内外大多数生图服务都吃这一套。
 * 一个平台通常就是「填几个默认值」——所以大多数 `providers/<name>.ts` 只有十来行。
 *
 * 这里**不接收 `baseUrl` / `model`**：地址与模型是部署参数，从 `app.json` 来（见文件头）。
 *
 * 文生图走 JSON `/images/generations`；带输入图时的形状由 `edit` 决定：
 * - `multipart`（OpenAI 官方 `images/edits`）：FormData 传文件；
 * - `data-uri`（很多国内平台）：同一个端点，把原图当 `data:` URI 放进 JSON 字段。
 */
export function openAiCompatibleProvider(options: OpenAiCompatibleOptions): ImageProvider {
  const acceptsSize = (size: string): boolean =>
    WIDTH_HEIGHT.test(size) || (options.sizeTiers === true && SIZE_TIER.test(size));

  const baseBody = (input: ImageGenerationInput): Record<string, unknown> => ({
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    n: 1,
    // 各平台的开关（如 `response_format: "b64_json"` / `watermark`）只从配置来
    ...input.extraBody,
  });

  return {
    id: options.id,
    label: options.label,
    apiKeyEnv: options.apiKeyEnv ?? "DTS_IMAGE_API_KEY",
    defaults: {
      size: options.size,
      sizes: options.sizes,
      timeoutMs: options.timeoutMs ?? 180_000,
      extraBody: options.extraBody ?? {},
    },
    endpoint: "/images/generations",
    supportsEdit: options.edit !== undefined,
    supportsMask: options.supportsMask === true,
    acceptsSize,
    buildRequest: (input) => {
      if (input.images.length === 0) {
        return { kind: "json", endpoint: "/images/generations", body: baseBody(input) };
      }

      const edit = options.edit;
      if (edit === undefined) {
        // 理论上到不了这里（路由先按 supportsEdit 拦住了）；留着以防直接调用
        throw new Error(`${options.label} 不支持图生图 / 修图`);
      }

      if (edit.kind === "data-uri") {
        const field = edit.imageField ?? "image";
        const body: Record<string, unknown> = {
          ...baseBody(input),
          [field]: input.images.map((image) => `data:${image.mime};base64,${image.data.toString("base64")}`),
        };
        if (input.mask !== undefined) {
          body[edit.maskField ?? "mask"] = `data:${input.mask.mime};base64,${input.mask.data.toString("base64")}`;
        }

        return { kind: "json", endpoint: "/images/generations", body };
      }

      const fields: Record<string, string> = {
        model: input.model,
        prompt: input.prompt,
        size: input.size,
        n: "1",
      };
      for (const [key, value] of Object.entries(input.extraBody)) {
        fields[key] = asFieldText(value);
      }

      const fileField = edit.fileField ?? "image";
      const files = input.images.map((image, index) => ({
        field: fileField,
        filename: `image-${index.toString()}.png`,
        mime: image.mime,
        data: image.data,
      }));
      if (input.mask !== undefined) {
        files.push({
          field: edit.maskField ?? "mask",
          filename: "mask.png",
          mime: input.mask.mime,
          data: input.mask.data,
        });
      }

      return { kind: "multipart", endpoint: edit.endpoint, fields, files };
    },
    parseImage: parseDataEntry,
  };
}
