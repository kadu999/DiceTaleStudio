import type { Draft } from "immer";
import { ensureComponentData } from "../access";
import { REJECT, coerceFieldValue } from "../component-spec";
import { componentSpecOf } from "../component-specs";
import { objectFieldOf } from "../object-spec";
import type { SceneDoc } from "../types";
import { withObject } from "./shared";

/**
 * **规格驱动的泛型写入**（组件字段 + 对象自身字段）。
 *
 * 存在的理由：过去加一个布尔要新写一条命令（默认值 / 类型收窄 / 无变更判据各写一遍），
 * 于是「小功能」在文档层就要碰四五个文件。这里把「描述符接管的字段」统一收成一条路，
 * 键名、类型收窄、夹取范围、默认值全部来自那份规格（`component-specs/` 与 `object-spec.ts`）。
 *
 * **它们只管描述符接管的字段**：
 * - 不在规格里的字段（组件的 `clips` / `picked`、对象的 `name` / `scale` …）→ 返回 `false`，
 *   继续走各自的专用命令；
 * - 描述符表达不了的形状（列表 / 资源引用 / 颜色…）→ `coerceFieldValue` 直接 `REJECT`；
 * - 有副作用的开关（例如 `video.enabled` 关掉时要摘掉整个组件）**刻意不进规格**，
 *   否则泛型写入会在文件里留下一个空壳，破坏「与从没开过同义」那个不变量。
 *
 * 布尔约定与其它命令一致：**无变更返回 `false`**（历史不入栈），非法值也返回 `false`
 * ——判据从严，宁可不动文档，也不写进一个会被 zod 拒掉或语义不明的值。
 */

/**
 * 改**组件数据**上的一个字段（按组件规格）。
 *
 * `type` 是组件类型 ID；对象上没有这个组件时按规格补一份完整的默认数据再写
 * （判据与 `ensureSlotData` 逐字一致，见 `ensureComponentData`）。
 */
export function setComponentField(
  scene: Draft<SceneDoc>,
  objectId: string,
  type: string,
  key: string,
  value: unknown,
): boolean {
  return withObject(scene, objectId, (object) => {
    const spec = componentSpecOf(type);
    const field = spec?.fields.find((item) => item.key === key);
    if (spec === undefined || field === undefined) {
      return false;
    }

    const data = ensureComponentData(object, type);
    if (data === undefined) {
      return false;
    }

    const coerced = coerceFieldValue(field, value);
    if (coerced === REJECT) {
      return false;
    }

    if (data[field.key] === coerced) {
      return false;
    }

    data[field.key] = coerced;
    return true;
  });
}

/**
 * 改**对象自身**的一个字段（按对象字段规格，`object-spec.ts`）。
 *
 * 与 `setComponentField` 的分工只有「写在哪」：一个写进 `object.components[].data`，
 * 一个写 `object` 自己。收窄、夹取、无变更判据完全共用（同一份 `coerceFieldValue`）。
 */
export function setObjectField(
  scene: Draft<SceneDoc>,
  objectId: string,
  key: string,
  value: unknown,
): boolean {
  return withObject(scene, objectId, (object) => {
    const field = objectFieldOf(key);
    if (field === undefined) {
      return false;
    }

    const coerced = coerceFieldValue(field, value);
    if (coerced === REJECT) {
      return false;
    }

    // 对象自己没有索引签名，按记录索引一次；键由规格（`keyof GameObjectDoc`）保证真的存在
    const data = object as unknown as Record<string, unknown>;
    if (data[field.key] === coerced) {
      return false;
    }

    data[field.key] = coerced;
    return true;
  });
}
