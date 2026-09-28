/**
 * 后端配置客户端（编辑器那一侧）。
 *
 * `GET /api/config` 是编辑器知道「资源根长什么样、默认每格多少像素、生图现在用哪个平台」的
 * 唯一来源。这里只取**生图那一小块**给工具窗口用；**密钥不在这里**（服务端不下发）。
 */

export interface ImageGenConfig {
  /** 当前平台名（如 `volcengine`）——只用于界面提示。 */
  readonly platform: string;
  /** 这个平台配好密钥没有（没配 = 生成按钮的提示会说明去哪儿配）。 */
  readonly configured: boolean;
  /** 这个平台支不支持图生图 / 修图（不支持就不显示「参考图」那一栏）。 */
  readonly supportsEdit: boolean;
  /** 这个平台支不支持蒙版局部重绘（编辑器将来做「涂抹重绘」时按它决定露不露入口）。 */
  readonly supportsMask: boolean;
  /** 默认出图尺寸（`宽x高`，或平台自己的档位如 `2K`）。 */
  readonly defaultSize: string;
  /** 可选尺寸（平台各不同；空数组 = 用编辑器内置默认几档）。 */
  readonly sizes: readonly string[];
  /** 默认是否抠背景。 */
  readonly removeBackground: boolean;
  /** 生成图落进项目的哪个目录（显示用）。 */
  readonly outputDir: string;
}

export interface ServerConfig {
  readonly defaultCellPixels: number;
  readonly projectFolders: readonly string[];
  readonly imageGen: ImageGenConfig | null;
}

export const configApi = {
  /** 读一次服务端配置；失败就抛（调用方决定退回默认值还是提示）。 */
  async get(): Promise<ServerConfig> {
    const response = await fetch("/api/config");
    if (!response.ok) {
      throw new Error(`读取配置失败：${response.status.toString()} ${response.statusText}`);
    }

    return (await response.json()) as ServerConfig;
  },
};
