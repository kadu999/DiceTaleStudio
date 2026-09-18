import { spawn } from "node:child_process";

/**
 * 在**服务端所在的机器**上用文件管理器打开一个目录。
 *
 * 为什么在服务端做：编辑器是浏览器应用，浏览器出于安全不允许替用户打开文件夹，
 * 所以「打开目录」只能由后端调系统命令完成。它打开的是**跑服务端的那台机器**上的目录——
 * 从平板 / 手机经局域网访问时，弹出来的是那台电脑的窗口（不是平板上的文件 App）。
 *
 * 安全上有两条硬约定：
 * 1. 路径**由服务端自己算**（项目名先过 `validateProjectName`），从不接受客户端传来的任意路径；
 * 2. 命令名与参数**分开传**（不拼 shell 字符串），因此路径里的空格、`&`、中文都不会被当成命令解析。
 */

export interface FolderCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * 平台 → 打开目录的命令；不认识的平台返回 `undefined`（由调用方给出可读错误）。
 *
 * 三个平台各一条命令：Windows 用 `explorer.exe`（它会打开并选中那个目录），
 * macOS 用 `open`，Linux 用 `xdg-open`（桌面环境通常都装了）。
 */
export function folderOpenCommand(
  platform: NodeJS.Platform,
  path: string,
): FolderCommand | undefined {
  switch (platform) {
    case "win32":
      return { command: "explorer.exe", args: [path] };
    case "darwin":
      return { command: "open", args: [path] };
    case "linux":
    case "freebsd":
    case "openbsd":
      return { command: "xdg-open", args: [path] };
    default:
      return undefined;
  }
}

/**
 * 真的去打开目录。
 *
 * - **等 `spawn` 事件**再返回：命令不存在（Linux 没装 `xdg-open`）时会走 `error` 事件，
 *   于是失败能如实报给调用方，而不是「点了没反应」；
 * - **不等进程结束**：文件管理器会一直开着，服务端不该被它拖住；
 *   `detached` + `unref()` 让子进程与编辑器脱钩，关掉服务端也不会连带杀掉资源管理器。
 */
export async function openFolder(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const spec = folderOpenCommand(platform, path);
  if (spec === undefined) {
    throw new Error(`当前系统（${platform}）不支持自动打开目录，请手动打开：${path}`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], { detached: true, stdio: "ignore" });
    child.once("error", (error) => {
      reject(new Error(`无法调用 ${spec.command}：${error.message}（目录：${path}）`));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
