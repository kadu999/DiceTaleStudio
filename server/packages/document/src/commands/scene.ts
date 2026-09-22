// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：场景的查找与命名规则（纯函数）。
import type { SceneDoc } from "../types";

// ---------------------------------------------------------------- 场景

/**
 * 按名字找场景（传送动作按场景名引用目标）。
 *
 * 场景名就是文件名，所以查找要 trim + 大小写不敏感：磁盘上跨平台大小写规则不一致，
 * 用严格比较会让「Map001」和「map001」变成两个都打不开的引用。
 */
export function findScene(scenes: readonly SceneDoc[], name: string): SceneDoc | undefined {
  const normalized = name.trim().toLowerCase();
  return scenes.find((scene) => scene.name.trim().toLowerCase() === normalized);
}

/** 场景名是否已被占用（trim + 大小写不敏感；`exceptName` 用于改名时排除自身）。 */
export function isSceneNameTaken(
  scenes: readonly SceneDoc[],
  name: string,
  exceptName?: string,
): boolean {
  const found = findScene(scenes, name);
  if (found === undefined) {
    return false;
  }

  // 改名时允许「占用者就是自己」
  return exceptName === undefined || found.name.trim().toLowerCase() !== exceptName.trim().toLowerCase();
}

/** 场景名合法性：与项目名同样的限制；**场景名会直接成为文件名**，非法字符必须挡在这里。 */
export function validateSceneName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "场景名不能为空";
  }

  if (trimmed.length > 64) {
    return "场景名不能超过 64 个字符";
  }

  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return '场景名不能包含 \\ / : * ? " < > | 等字符';
  }

  if (trimmed === "." || trimmed === "..") {
    return "场景名不合法";
  }

  return undefined;
}
