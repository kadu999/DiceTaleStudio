/**
 * AI 生图的 HTTP 客户端（编辑器那一侧）。
 *
 * **密钥不在这里**：真正打供应商接口的是后端（`/api/tools/generate-image`）。
 * 浏览器只告诉它「要画什么」，拿回来的是**刚存进项目的那份素材**（id / guid / 宽高）——
 * 与「从项目里挑一张图」拿到的东西完全一样，所以后面的用法也共用同一条路。
 */

export interface GeneratedImage {
  /** 素材的逻辑 ID（`project:<项目>/Assets/…png`）。 */
  readonly id: string;
  /** 项目内相对路径（显示用）。 */
  readonly path: string;
  /** 素材身份（GUID）：写进 `ImageRef` 的那一个。 */
  readonly guid: string;
  readonly width: number;
  readonly height: number;
}

export interface GenerateImageInput {
  readonly project: string;
  readonly prompt: string;
  /** `宽x高`（如 `1024x1024`）；不给就用后端配置里的默认值。 */
  readonly size?: string;
}

export const imageGenApi = {
  /**
   * 画一张（后端调接口 + 存成项目素材，**一次到位**）。
   *
   * 出图是几十秒到几分钟的事，所以这里**不设超时**：真要等，就让它等（超时由后端那份配置管）。
   * 失败时抛 `Error`，消息就是后端给的那句（没配密钥 / 供应商的原话 / 尺寸写错了…）。
   */
  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    const response = await fetch("/api/tools/generate-image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      let reason = `${response.status.toString()} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (typeof body.error === "string" && body.error.length > 0) {
          reason = body.error;
        }
      } catch {
        // 保持默认原因
      }

      throw new Error(reason);
    }

    return (await response.json()) as GeneratedImage;
  },
};
