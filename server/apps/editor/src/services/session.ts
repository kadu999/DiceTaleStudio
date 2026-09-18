/**
 * 编辑器会话记忆（浏览器本地）。
 *
 * 只记一件事：**上次打开的项目名**。项目数据全在服务端，这里不复制任何内容——
 * 打开动作由浏览器发起，服务端只知道文件夹在不在，不知道「谁上次开了哪个项目」，
 * 所以这份记忆只能留在客户端。
 *
 * 读写一律吞掉异常：隐私模式 / 禁用站点存储时，记不住也不该让编辑器打不开。
 */

const LAST_PROJECT_KEY = "dts.editor.lastProject";

/** 读上次打开的项目名；没有记录或存储不可用时返回 null。 */
export function readLastProject(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_PROJECT_KEY);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 记住这次打开的项目。 */
export function writeLastProject(name: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, name);
  } catch {
    // 存储不可用：本次会话照常工作，只是下次不会自动打开
  }
}

/** 忘记上次打开的项目（用户主动关闭项目 / 记录已失效时调用）。 */
export function clearLastProject(): void {
  try {
    window.localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // 同上
  }
}
