import { openAiCompatibleProvider } from "./types";

/**
 * OpenAI 官方（`gpt-image-1`）。
 *
 * 文生图走最小形状的 `/images/generations`；`edit` 走 OpenAI 的 `/images/edits`（multipart 传原图）。
 *
 * **地址与模型不在这里**：写在 `app.json` 的 `imageGen.platforms.openai`（走代理 / 中转时改那里）。
 */
export const provider = openAiCompatibleProvider({
  id: "openai",
  label: "OpenAI",
  size: "1024x1024",
  sizes: ["1024x1024", "1024x1536", "1536x1024", "512x512"],
  edit: { kind: "multipart", endpoint: "/images/edits" },
  // OpenAI 的 `images/edits` 认 `mask`（透明处 = 要重画的区域）——先把能力位打开
  supportsMask: true,
});
