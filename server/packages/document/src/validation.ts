import { PAINTABLE_MASKS, decodeRle } from "@dts/grid";
import { findComponentType, isKnownComponentType } from "./components";
import { collectActionIds } from "./commands";
import type { ProjectDoc, SceneDoc, SceneObjectDoc } from "./types";

/**
 * 结构性校验（**不依赖动作注册表**，因此放在 document 包内）。
 * 动作类型与参数引用相关校验在 `@dts/actions` 里（依赖方向：actions → document）。
 */

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  readonly level: IssueLevel;
  /** 定位路径，例如 `scenes/Map001/objects/door_01`。 */
  readonly path: string;
  readonly message: string;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}

function checkPosition(
  position: { x: number; y: number },
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    issues.push({ level: "error", path, message: "位置不是有限数值" });
  }

  // 世界坐标的范围就是场景范围（±宽/2、±高/2），而校验拿不到场景尺寸；
  // 这里**不**给坐标设上下限——越界的对象在画布上看得见，比静默拒绝更有用。
}

function validateObject(object: SceneObjectDoc, path: string, issues: ValidationIssue[]): void {
  if (object.position !== null) {
    checkPosition(object.position, `${path}/position`, issues);
  }

  // 缩放：画布按「矩形尺寸 × 缩放」画，0 / 负数 / NaN 都画不出来（渲染端会退回 1，
  // 但那是兜底，不是数据正确——所以这里明确报错，别让坏数据悄悄留在文件里）。
  //
  // v8 起是等比的 `scale`，v11 起还可以有**可选**的单轴 `scaleX` / `scaleY`：
  // 三个字段各自按同一个规则查（缺省的单轴字段本身就是合法写法，不报错），
  // 路径分别写出来，才知道是哪一个数坏了。
  if (!Number.isFinite(object.scale) || object.scale <= 0) {
    issues.push({
      level: "error",
      path: `${path}/scale`,
      message: `缩放必须是正数（现在 ${String(object.scale)}）`,
    });
  }

  for (const axis of ["scaleX", "scaleY"] as const) {
    const value = object[axis];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      issues.push({
        level: "error",
        path: `${path}/${axis}`,
        message: `单轴缩放必须是正数（现在 ${String(value)}）`,
      });
    }
  }

  // 地图对象：数据必须完整（没有数据的「地图对象」在场景里就是个空壳）
  if (object.kind === "Map") {
    if (object.map === undefined) {
      issues.push({ level: "error", path, message: "地图对象缺少地图数据（贴图 / 网格）" });
    } else {
      try {
        decodeRle(object.map.cells.runs, object.map.grid.width * object.map.grid.height);
      } catch (error) {
        issues.push({
          level: "error",
          path: `${path}/map/cells`,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (object.map.image.id.trim().length === 0) {
        issues.push({ level: "warning", path: `${path}/map/image`, message: "地图贴图未指定" });
      }

      // 战争雾指定的雾区位必须是可绘制的区域位：手写文件里写了别的值（0、3、256…），
      // 编辑器会把它丢掉，所以这里得说出来——不然「明明指定了却不生效」无从排查
      const fogRegions = object.map.fog?.regions ?? [];
      const unknownRegions = fogRegions.filter((bit) => !PAINTABLE_MASKS.some((value) => value === bit));
      if (unknownRegions.length > 0) {
        issues.push({
          level: "warning",
          path: `${path}/map/fog/regions`,
          message: `战争雾指定的 ${unknownRegions.join(", ")} 不是可绘制的区域位（会被忽略）`,
        });
      }
    }

    // 地图的贴图在 map.image 里：再挂一份 object.image 就是同一件事写了两遍（显示到底听谁的？）
    if (object.image !== undefined) {
      issues.push({
        level: "warning",
        path: `${path}/image`,
        message: "地图对象的贴图写在 map.image 里，多余的 image 字段会被忽略",
      });
    }
  } else if (object.map !== undefined) {
    issues.push({
      level: "warning",
      path: `${path}/map`,
      message: `非地图对象（kind=${object.kind}）不应携带地图数据`,
    });
  }

  // 声音对象（动作对象）：基础属性与实体一样，另加声音数据——缺了就是个什么都不播的空壳
  if (object.kind === "PlaySound") {
    const sound = object.sound;
    if (sound === undefined) {
      issues.push({
        level: "error",
        path,
        message: "声音对象缺少声音数据（音频列表 / 层级）",
      });
    }

    if (sound !== undefined && sound.clips.some((clip) => clip.trim().length === 0)) {
      issues.push({
        level: "warning",
        path: `${path}/sound/clips`,
        message: "音频列表里有空条目（会被忽略）",
      });
    }

    // 选中的那条必须落在音频列表里：对不上就是数据坏了，按「还没选」处理（播放按钮点不了）
    if (sound?.picked !== undefined && !sound.clips.includes(sound.picked)) {
      issues.push({
        level: "warning",
        path: `${path}/sound/picked`,
        message: "选中的那条音频不在音频列表里（按还没选处理）",
      });
    }

    // 名字是给人看的标签：空白名字会被当成「没起名字」，退回素材文件名
    const namedClips = sound?.names === undefined ? [] : Object.entries(sound.names);
    for (const [clipId, name] of namedClips) {
      if (name.trim().length === 0) {
        issues.push({
          level: "warning",
          path: `${path}/sound/names/${clipId}`,
          message: "声音名字是空的（会退回素材文件名）",
        });
      } else if (sound !== undefined && !sound.clips.includes(clipId)) {
        // 名字挂在文件上：对应的音频已经不在列表里了，这条名字就是看不见的死数据
        issues.push({
          level: "warning",
          path: `${path}/sound/names/${clipId}`,
          message: "这条名字对应的音频不在音频列表里（会被忽略）",
        });
      }
    }

    // 它画的是**固定的内置图标**（不给换贴图），所以 `image` 字段没有意义
    if (object.image !== undefined) {
      issues.push({
        level: "warning",
        path: `${path}/image`,
        message: "声音对象用固定的内置图标（不允许改贴图），多余的 image 字段会被忽略",
      });
    }
  } else if (object.sound !== undefined) {
    issues.push({
      level: "warning",
      path: `${path}/sound`,
      message: `非声音对象（kind=${object.kind}）不应携带声音数据`,
    });
  }

  const componentIds = new Set<string>();
  for (const component of object.components) {
    const componentPath = `${path}/components/${component.id}`;
    if (componentIds.has(component.id)) {
      issues.push({ level: "error", path: componentPath, message: `组件 id 重复: ${component.id}` });
    }

    componentIds.add(component.id);

    if (!isKnownComponentType(component.type)) {
      issues.push({
        level: "warning",
        path: componentPath,
        message: `未知组件类型: ${component.type}（数据将原样保留）`,
      });
      continue;
    }

    // OptionValue：当前选项必须在选项列表里
    if (component.type === "OptionValue") {
      const options = component.data.options;
      const current = component.data.current;
      if (Array.isArray(options) && typeof current === "string" && current.length > 0) {
        if (!options.includes(current)) {
          issues.push({
            level: "error",
            path: `${componentPath}/data/current`,
            message: `当前选项 "${current}" 不在选项列表中`,
          });
        }
      }
    }

    // 值组件的 value 类型
    const valueType = findComponentType(component.type)?.fields.find((field) => field.key === "value")
      ?.kind;
    if (valueType !== undefined) {
      const value = component.data.value;
      if (valueType === "boolean" && typeof value !== "boolean") {
        issues.push({ level: "error", path: `${componentPath}/data/value`, message: "应为布尔值" });
      }

      if (valueType === "integer" && !Number.isInteger(value)) {
        issues.push({ level: "error", path: `${componentPath}/data/value`, message: "应为整数" });
      }

      if (valueType === "number" && typeof value !== "number") {
        issues.push({ level: "error", path: `${componentPath}/data/value`, message: "应为数值" });
      }
    }

    for (const action of component.actions) {
      if (action.id.trim().length === 0) {
        issues.push({ level: "error", path: `${componentPath}/actions`, message: "动作 id 不能为空" });
      }

      if (action.condition !== undefined) {
        const target = action.condition.target;
        const ok =
          (action.condition.valueType === "Bool" && typeof target === "boolean") ||
          (action.condition.valueType === "String" && typeof target === "string") ||
          ((action.condition.valueType === "Number" || action.condition.valueType === "Integer") &&
            typeof target === "number");

        if (!ok) {
          issues.push({
            level: "error",
            path: `${componentPath}/actions/${action.id}/condition`,
            message: `${action.condition.valueType} 条件的比较目标类型不符`,
          });
        }
      }
    }
  }
}

/** 校验单个场景。 */
export function validateScene(scene: SceneDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = `scenes/${scene.name}`;

  if (scene.name.trim().length === 0) {
    issues.push({ level: "error", path: base, message: "场景名不能为空" });
  }

  // 对象（地图也只是其中之一）
  const objectIds = new Set<string>();
  for (const object of scene.objects) {
    const path = `${base}/objects/${object.id}`;
    if (objectIds.has(object.id)) {
      issues.push({ level: "error", path, message: `对象 id 重复: ${object.id}` });
    }

    objectIds.add(object.id);
    if (object.id.trim().length === 0) {
      issues.push({ level: "error", path, message: "对象 id 不能为空" });
    }

    validateObject(object, path, issues);
  }

  // 动作 id 全场景唯一（运行态靠 actionId 寻址，重名会触发到错误动作）
  for (const [actionId, owners] of collectActionIds(scene)) {
    if (owners.length > 1) {
      issues.push({
        level: "error",
        path: `${base}/actions/${actionId}`,
        message: `动作 id 重复: ${actionId}（出现在 ${owners.join(", ")}）`,
      });
    }
  }

  return issues;
}

/**
 * 校验工程文件里的项目级数据。
 *
 * 场景已各自成文件、由 `validateScene` 逐个校验，所以这里不再遍历场景；
 * 场景名唯一性也由文件系统保证（同名即同文件）。
 */
export function validateProject(doc: ProjectDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (doc.items.count !== doc.items.items.length) {
    issues.push({
      level: "warning",
      path: "items/count",
      message: `道具库 count=${doc.items.count} 与实际条目数 ${doc.items.items.length} 不一致`,
    });
  }

  return issues;
}

/** 把问题列表整理成可读多行文本（进入运行态被阻止时展示）。 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.level === "error" ? "✗" : "!"} ${issue.path}: ${issue.message}`)
    .join("\n");
}
