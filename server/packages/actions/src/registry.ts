import type { FieldDef } from "@dts/document";

/**
 * 动作类型注册表。
 *
 * 与前端 `Backend/Actions/*.cs` 一一对应：字段名严格照抄 Unity 的序列化字段，
 * 保证编辑器保存的动作能被前端导入器直接落成组件。
 *
 * `conditional` 对应前端是否继承 `ConditionalBackendChangeAction`（带唯一条件）。
 * `implemented=false` 表示前端该类目前是空壳（如 PlayAudioAction），编辑器禁止导出并标注。
 */

export interface ActionTypeDef {
  /** 动作类型 ID（= 前端类名去掉 Action 后缀前的形态，与类名一致：ShowHide / Teleport / ...）。 */
  readonly type: string;
  readonly displayName: string;
  readonly tooltip: string;
  /** 是否带条件（前端 ConditionalBackendChangeAction 子类）。 */
  readonly conditional: boolean;
  /** 前端是否已实现（空壳类为 false）。 */
  readonly implemented: boolean;
  readonly fields: readonly FieldDef[];
  /** 一句话描述该动作的效果（运行态日志与列表摘要用）。 */
  readonly summary: (params: Readonly<Record<string, unknown>>) => string;
}

function text(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

export const ACTION_TYPES: readonly ActionTypeDef[] = [
  {
    type: "ShowHide",
    displayName: "显示/隐藏",
    tooltip: "条件满足时激活目标物体，否则停用；目标留空表示作用于自身",
    conditional: true,
    implemented: true,
    fields: [
      {
        key: "targetObjectId",
        label: "目标物体",
        kind: "objectRef",
        tooltip: "留空表示作用于动作所在对象自身",
      },
    ],
    summary: (params) => {
      const target = text(params, "targetObjectId");
      return `根据条件显示/隐藏 ${target.length > 0 ? target : "自身"}`;
    },
  },
  {
    type: "Teleport",
    displayName: "传送（范围内玩家）",
    tooltip: "把半径范围内（或全部）玩家传送到目标地图的标记点",
    conditional: true,
    implemented: true,
    fields: [
      { key: "range", label: "范围半径", kind: "number", min: 0, step: 0.5 },
      { key: "teleportAllPlayers", label: "传送全部玩家", kind: "boolean" },
      { key: "targetMapName", label: "目标地图", kind: "string", required: true },
      { key: "targetMarkerId", label: "目标标记点", kind: "string", required: true },
    ],
    summary: (params) => {
      const scope = params.teleportAllPlayers === true ? "全部玩家" : `半径 ${String(params.range ?? 1)} 内玩家`;
      return `传送 ${scope} → ${text(params, "targetMapName")}#${text(params, "targetMarkerId")}`;
    },
  },
  {
    type: "TeleportZone",
    displayName: "传送区域",
    tooltip: "开启后玩家进入该区域即被传送（目标地图 + 标记点）",
    conditional: true,
    implemented: true,
    fields: [
      { key: "targetMapName", label: "目标地图", kind: "string", required: true },
      { key: "targetMarkerId", label: "目标标记点", kind: "string", required: true },
    ],
    summary: (params) => `传送区域 → ${text(params, "targetMapName")}#${text(params, "targetMarkerId")}`,
  },
  {
    type: "PlayVideo",
    displayName: "播放视频",
    tooltip: "在目标对象的 SmartVideoPlayer 上按索引播放视频（可循环、调速）",
    conditional: true,
    implemented: true,
    fields: [
      { key: "targetObjectId", label: "视频对象", kind: "objectRef", required: true },
      { key: "index", label: "视频索引", kind: "integer", min: 0 },
      { key: "isLooping", label: "循环播放", kind: "boolean" },
      { key: "speed", label: "播放速度", kind: "number", min: 0, step: 0.1 },
    ],
    summary: (params) =>
      `播放 ${text(params, "targetObjectId")} 的第 ${String(params.index ?? 0)} 个视频${
        params.isLooping === true ? "（循环）" : ""
      }`,
  },
  {
    type: "PlayAudio",
    displayName: "播放音频",
    tooltip: "前端 PlayAudioAction 目前是空壳（OnComponentChanged 无实现），暂不可用",
    conditional: true,
    implemented: false,
    fields: [
      { key: "targetObjectId", label: "音频对象", kind: "objectRef" },
      { key: "clip", label: "音频资源", kind: "resourceRef", resourceKind: "audio" },
      { key: "loop", label: "循环播放", kind: "boolean" },
      { key: "volume", label: "音量", kind: "number", min: 0, max: 1, step: 0.05 },
    ],
    summary: (params) => `播放音频 ${text(params, "clip")}`,
  },
];

const BY_TYPE = new Map(ACTION_TYPES.map((def) => [def.type, def]));

export function findActionType(type: string): ActionTypeDef | undefined {
  return BY_TYPE.get(type);
}

export function isKnownActionType(type: string): boolean {
  return BY_TYPE.has(type);
}

export function isActionImplemented(type: string): boolean {
  return BY_TYPE.get(type)?.implemented ?? false;
}
