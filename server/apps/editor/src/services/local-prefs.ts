/**
 * 浏览器本地偏好读写的公共骨架（`localStorage`）。
 *
 * 读写一律吞掉异常：隐私模式 / 禁用站点存储时，记不住也不该让编辑器打不开（同 `session.ts`）。
 * 键名、默认值与逐字段解析归各 prefs 模块自己（`editor-prefs.ts` / `grid-paint-prefs.ts`）——
 * 存储是用户能改的、也能被旧版本写坏，「脏记录怎么兜底」每种偏好有自己的规矩。
 */

/** 读偏好；没有记录、内容损坏或存储不可用时退回默认值（不抛错）。 */
export function readPrefs<T>(key: string, parse: (raw: unknown) => T, fallback: () => T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw.length === 0) {
      return fallback();
    }

    return parse(JSON.parse(raw) as unknown);
  } catch {
    return fallback();
  }
}

/** 记住这次的选择。 */
export function writePrefs<T>(key: string, prefs: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // 存储不可用：本次会话照常工作，只是下次回到默认值
  }
}
