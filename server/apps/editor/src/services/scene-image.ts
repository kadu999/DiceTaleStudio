/**
 * 场景贴图加载器。
 *
 * 贴图是**资源逻辑 ID**（`project:<项目>/Assets/images/<场景名>.png`），真正的字节由后端
 * `/api/resources/raw` 给出。编辑器的绘制循环是 rAF，**不能在里面发请求**，所以：
 *
 * - 同一个逻辑 ID 只加载一次（成功后一直缓存，图片对象本身就持有解码结果）；
 * - 加载中返回 null，画布这一帧先画棋盘格，加载完成触发一次重绘；
 * - 失败时**不缓存失败结果**（素材后补进目录、刷新一下就能重试），并把原因交给调用方显示。
 *
 * 这里缓存的是 `HTMLImageElement`：切换场景来回切不会重复下载，代价是贴图会驻留内存——
 * 与 Unity 的已加载资源同理，所以**切项目时调用 `clearSceneImageCache()` 释放**。
 */

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement | null>>();
const failures = new Map<string, string>();
/** 加载完成的订阅者（按逻辑 ID）；绘制是 rAF 循环，得有人通知它「贴图好了」。 */
const listeners = new Map<string, Set<() => void>>();

/** 取贴图；还没加载好返回 null（并开始后台加载）。 */
export function sceneImage(id: string): HTMLImageElement | null {
  const cached = cache.get(id);
  if (cached !== undefined) {
    return cached;
  }

  if (!pending.has(id)) {
    const task = load(id);
    pending.set(id, task);
    void task.then((image) => {
      pending.delete(id);
      if (image !== null) {
        cache.set(id, image);
      }

      // 成功与失败都要通知：失败也要让画布把「贴图未显示」的原因摆出来
      notify(id);
    });
  }

  return null;
}

/**
 * 订阅「某张贴图加载有结果了」（成功或失败都会回调）；已经有结果就立刻回调一次。
 *
 * 返回取消订阅的函数。
 */
export function subscribeSceneImage(id: string, listener: () => void): () => void {
  if (cache.has(id) || failures.has(id)) {
    listener();
    return () => undefined;
  }

  const group = listeners.get(id) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(id, group);

  return () => {
    group.delete(listener);
    if (group.size === 0) {
      listeners.delete(id);
    }
  };
}

function notify(id: string): void {
  for (const listener of listeners.get(id) ?? []) {
    listener();
  }
}

/** 贴图加载失败的原因（按逻辑 ID）；没失败过就是 undefined。 */
export function sceneImageError(id: string): string | undefined {
  return failures.get(id);
}

/** 释放全部贴图（切项目 / 关项目时调用，避免上一项目的贴图常驻内存）。 */
export function clearSceneImageCache(): void {
  cache.clear();
  pending.clear();
  failures.clear();
  listeners.clear();
}

async function load(id: string): Promise<HTMLImageElement | null> {
  try {
    const response = await fetch(`/api/resources/raw?id=${encodeURIComponent(id)}`);
    if (!response.ok) {
      failures.set(id, `找不到资源 ${id}（HTTP ${response.status}）`);
      return null;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片解码失败"));
        image.src = url;
      });

      // 解码完成后 blob URL 就没用了：图片已经把数据拿在手里
      URL.revokeObjectURL(url);
      failures.delete(id);
      return image;
    } catch (error) {
      URL.revokeObjectURL(url);
      failures.set(id, error instanceof Error ? error.message : String(error));
      return null;
    }
  } catch (error) {
    failures.set(id, error instanceof Error ? error.message : String(error));
    return null;
  }
}
