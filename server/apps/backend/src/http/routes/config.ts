import type { RouteContext } from "../router";
import { sendJson } from "../responses";

/**
 * `GET /api/config`：把配置**读出来的结果**告诉编辑器。
 *
 * 编辑器不自己找资源根（它连文件系统都碰不到），启动时要的这一份就是它知道
 * 「资源根在哪、标准子目录叫什么、每格默认多少像素、配置是从文件读的还是内置默认值」的
 * 唯一来源。`resourceRoot` 是**服务端机器上的绝对路径**，只用于显示与排查。
 */
export function getConfig(ctx: RouteContext): void {
  const { config } = ctx;
  sendJson(ctx.response, 200, {
    resourceRoot: config.resourceRoot,
    dirs: config.dirs,
    projectFolders: config.app.projectFolders,
    defaultCellPixels: config.app.defaultCellPixels,
    usingDefaults: config.usingDefaults,
  });
}
