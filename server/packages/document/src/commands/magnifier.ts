// 本文件从 `commands.ts` 拆出（照 `teleport.ts` 的样子）：放大镜（动作对象）命令。
import type { Draft } from "immer";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureMagnifierData } from "../access";
import {
  DEFAULT_MAGNIFIER_VIDEO_AUDIO,
  DEFAULT_MAGNIFIER_VIDEO_LOOP,
} from "../presets";
import type {
  ImageRef,
  ImageSpriteRef,
  MagnifierState,
  MagnifierTween,
  SceneDoc,
} from "../types";
import { withMediaData } from "./shared";

// ---------------------------------------------------------------- 放大镜（动作对象）

/**
 * 放大镜的状态列表：**一个一个加 / 移出 + 换当前展示的那一个 + 往一个状态里填内容**。
 *
 * 与声音 / 视频 / 传送阵那三份「列表 + 选中」的差别只有一处：**选中是下标**（`picked: number`）
 * ——它们那份列表的元素是字符串（可以当键），而这里的元素是一个**状态**，空状态槽没有 id
 * 可用，位置才是这把列表里的身份。代价就是「移出一个」要顺手把 `picked` 调一格
 * （`removeMagnifierState` 里集中处理）。
 *
 * 「往一个状态里填内容」是三条命令（图 / 标题 / 文字）而不是一条 patch：三者的**判据与
 * 规范化各不相同**（图要收格子、标题与文字要 trim、空串要删字段），分开写比在一条里分三岔
 * 更清楚，调用方也各自知道自己要改的是哪一项。
 */

/**
 * 末尾加一个**空状态槽**（标题 / 图 / 文字都没有）并**选中它**。
 *
 * 「添加状态」按下去之后就是要在上面那块区域里填它，所以顺手选中：不然刚加的那条与正在编辑
 * 的那条不是同一个，人会往错的状态里打字（与 `createSoundObject` 给第一条选中同义）。
 * 选中了但还没有图时「在画面上打开」点不了——那是**合法状态**（刚加出来就是这样），
 * `validateScene` 会提醒一句。
 */
export function addMagnifierState(scene: Draft<SceneDoc>, objectId: string): boolean {
  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    data.states.push({});
    data.picked = data.states.length - 1;
    return true;
  });
}

/**
 * 移出第 `index` 个状态（越界 / 不是整数 → 无变更），并**收拾 `picked`**：
 *
 * - 移出的正好是当前展示那个 → 留在同一个下标（也就是原来它后面那个）；后面没有了就退到最后一个；
 * - 比它大的下标都减一（列表短了一格）；
 * - 一个不剩 → `picked` 整个删掉（不留空壳，与 `syncMediaSideData` 同一条规矩）。
 */
export function removeMagnifierState(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
): boolean {
  if (!Number.isInteger(index) || index < 0) {
    return false;
  }

  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    if (index >= data.states.length) {
      return false;
    }

    data.states.splice(index, 1);

    if (data.picked !== undefined) {
      if (data.states.length === 0) {
        delete data.picked;
      } else if (data.picked === index) {
        // 原来它后面那个补了上来；移出的是最后一个时退到新的最后一个
        data.picked = Math.min(index, data.states.length - 1);
      } else if (data.picked > index) {
        data.picked -= 1;
      }
    }

    return true;
  });
}

/**
 * 改「当前展示第几个」（`null` = 取消选中）；越界的下标拒掉（不悄悄夹到最后一个——
 * 那是渲染 / 推送对**格子**的兜底口径，不是对「用户点了哪一条」的）。
 */
export function setMagnifierPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number | null,
): boolean {
  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    if (index === null) {
      if (data.picked === undefined) {
        return false;
      }

      delete data.picked;
      return true;
    }

    if (!Number.isInteger(index) || index < 0 || index >= data.states.length || data.picked === index) {
      return false;
    }

    data.picked = index;
    return true;
  });
}

/**
 * 给第 `index` 个状态**换图**（`null` = 清掉这个状态的图，它退回空状态槽）。
 *
 * 同一张图的同一个格子（连声明宽高都一样）时无变更——挑图那条路每次都会算出一份等价的引用，
 * 不判它就会往撤销栈里塞一堆「什么也没改」。
 */
export function setMagnifierStateImage(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  image: ImageRef | null,
): boolean {
  if (image === null) {
    return withMagnifierState(scene, objectId, index, (state) => {
      if (state.image === undefined) {
        return false;
      }

      delete state.image;
      return true;
    });
  }

  const next = normalizeMagnifierImage(image);
  return withMagnifierState(scene, objectId, index, (state) => {
    if (state.image !== undefined && sameImageRef(state.image, next)) {
      return false;
    }

    state.image = next;
    // 一屏只有一块媒体（v33）：放图就把视频删掉
    delete state.video;
    return true;
  });
}

/**
 * 给第 `index` 个状态**放一条视频**（v33；`null` = 清掉视频，它退回只剩下标题 / 文字）。
 *
 * 与 {@link setMagnifierStateImage} **二选一**：放视频会把这个状态的**图删掉**（反过来放图也删视频）
 * ——一屏只有一块媒体。新放的视频用默认开关（**循环、静音**）；换一条时沿用原开关。
 */
export function setMagnifierStateVideo(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  clipId: string | null,
): boolean {
  if (clipId === null) {
    return withMagnifierState(scene, objectId, index, (state) => {
      if (state.video === undefined) {
        return false;
      }

      delete state.video;
      return true;
    });
  }

  const next = clipId.trim();
  if (next.length === 0) {
    return false;
  }

  return withMagnifierState(scene, objectId, index, (state) => {
    if (state.video !== undefined && state.video.id === next) {
      return false;
    }

    state.video = {
      id: next,
      loop: state.video?.loop ?? DEFAULT_MAGNIFIER_VIDEO_LOOP,
      audio: state.video?.audio ?? DEFAULT_MAGNIFIER_VIDEO_AUDIO,
    };
    // 一屏只有一块媒体（v33）：放视频就把图删掉
    delete state.image;
    return true;
  });
}

/** 改第 `index` 个状态那条视频的**循环 / 声音**开关（那个状态没有视频时无变更）。 */
export function setMagnifierStateVideoSwitch(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  patch: { readonly loop?: boolean; readonly audio?: boolean },
): boolean {
  return withMagnifierState(scene, objectId, index, (state) => {
    const video = state.video;
    if (video === undefined) {
      return false;
    }

    const loop = patch.loop ?? video.loop;
    const audio = patch.audio ?? video.audio;
    if (loop === video.loop && audio === video.audio) {
      return false;
    }

    state.video = { id: video.id, loop, audio };
    return true;
  });
}

/**
 * 改第 `index` 个状态媒体那块的**动画**（v33）：`null` / `"none"` = 不动（字段删掉，文件自描述）。
 */
export function setMagnifierStateTween(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  tween: MagnifierTween | null,
): boolean {
  return withMagnifierState(scene, objectId, index, (state) => {
    const next = tween === null || tween === "none" ? undefined : tween;
    if (state.tween === next) {
      return false;
    }

    if (next === undefined) {
      delete state.tween;
    } else {
      state.tween = next;
    }

    return true;
  });
}

/**
 * 改第 `index` 个状态的**标题**（trim 之后为空 = 删掉这个字段）。
 *
 * 「没写」与「写了空串」在数据里同义（schema 两项都收），所以这里统一按「空 = 不留字段」
 * 写：文件自描述，前端也不用判空串。
 */
export function setMagnifierStateTitle(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  title: string,
): boolean {
  const next = title.trim();
  return withMagnifierState(scene, objectId, index, (state) => {
    if (next.length === 0) {
      if (state.title === undefined) {
        return false;
      }

      delete state.title;
      return true;
    }

    if (state.title === next) {
      return false;
    }

    state.title = next;
    return true;
  });
}

/**
 * 改第 `index` 个状态的**文字描述**（多行纯文本；trim 之后为空 = 删掉这个字段）。
 *
 * 与标题同一套口径（空 = 不留字段）。只 trim **两头**：中间的换行与空格是用户排版的一部分，
 * 一个字符都不动。
 */
export function setMagnifierStateText(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  text: string,
): boolean {
  const next = text.trim();
  return withMagnifierState(scene, objectId, index, (state) => {
    if (next.length === 0) {
      if (state.text === undefined) {
        return false;
      }

      delete state.text;
      return true;
    }

    if (state.text === next) {
      return false;
    }

    state.text = next;
    return true;
  });
}

/** 三条「改某个状态」的命令共用的前奏：对象找得到、下标落在列表里，再交给 `change`。 */
function withMagnifierState(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
  change: (state: Draft<MagnifierState>) => boolean,
): boolean {
  if (!Number.isInteger(index) || index < 0) {
    return false;
  }

  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    const state = data.states[index];
    if (state === undefined) {
      return false;
    }

    return change(state);
  });
}

/**
 * 收干净一条图片引用：格子取整 + 非负（越界要不要夹由渲染那条链路统一做，这里只保证是整数），
 * 并把 `guid` / `sprite` 的「没写」落实成**不留字段**（别用 `undefined` 去污染 JSON）。
 */
function normalizeMagnifierImage(image: ImageRef): ImageRef {
  const base = {
    id: image.id,
    ...(image.guid === undefined ? {} : { guid: image.guid }),
    width: image.width,
    height: image.height,
  };

  return image.sprite === undefined ? base : { ...base, sprite: normalizeSpriteRef(image.sprite) };
}

/** 取整 + 非负（与 `commands/object.ts` 的 `normalizeSpriteRef` 同一个口径）。 */
function normalizeSpriteRef(sprite: ImageSpriteRef): ImageSpriteRef {
  return {
    column: Number.isFinite(sprite.column) ? Math.max(0, Math.round(sprite.column)) : 0,
    row: Number.isFinite(sprite.row) ? Math.max(0, Math.round(sprite.row)) : 0,
  };
}

/**
 * 两条引用是不是**一模一样**（身份 + 声明尺寸 + 格子）：`setMagnifierStateImage` 的
 * 「无变更」判据。逐字段比而不是比序列化——`guid` / `sprite` 的「没写」在这里就是 `undefined`，
 * 键的顺序不该影响判据。
 */
function sameImageRef(left: ImageRef, right: ImageRef): boolean {
  if (left.id !== right.id || left.guid !== right.guid) {
    return false;
  }

  if (left.width !== right.width || left.height !== right.height) {
    return false;
  }

  if (left.sprite === undefined || right.sprite === undefined) {
    return left.sprite === undefined && right.sprite === undefined;
  }

  return left.sprite.column === right.sprite.column && left.sprite.row === right.sprite.row;
}
