import { openAiCompatibleProvider } from "./types";

/**
 * 火山方舟 · 豆包 Seedream（默认平台）。
 *
 * 端点和请求体与 OpenAI 兼容，差异都声明在这里：
 * - `response_format: "b64_json"`：默认它只回签名 URL，带上就直接回图（省一次下载）；
 * - `watermark: false`：关掉默认加在右下角的「AI生成」水印（素材要干净）；
 * - `sizeTiers`：除 `宽x高` 外还认 `2K` / `4K` 档位；
 * - `edit: data-uri`：图生图 / 修图仍走 `/images/generations`，把原图当 `data:` URI 放进 `image` 字段。
 *
 * **地址与模型不在这里**：它们是部署参数，写在 `app.json` 的
 * `imageGen.platforms.volcengine`（可走自建网关 / 中转 / 换接入点）。
 */
export const provider = openAiCompatibleProvider({
  id: "volcengine",
  label: "火山方舟 Seedream",
  size: "1024x1024",
  sizes: ["1024x1024", "1536x1024", "1024x1536", "2K", "4K"],
  extraBody: { response_format: "b64_json", watermark: false },
  sizeTiers: true,
  edit: { kind: "data-uri" },
});
