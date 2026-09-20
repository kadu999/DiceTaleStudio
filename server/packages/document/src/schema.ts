import { z } from "zod";
import {
  DOCUMENT_FORMAT_VERSION,
  SOUND_LAYERS,
  type ProjectDoc,
  type SceneDoc,
  type SceneFileDoc,
} from "./types";

/**
 * 文档 zod 校验。
 *
 * 加载任何文件都必须先过这里：不合法就报错，**不静默丢字段**。
 * 工程文件（`project.json`）与场景文件（`Assets/scenes/<场景名>.json`）各有一套 schema；
 * 旧版本（v1：地图即场景；v2：场景内联在工程文件里；v4 及更早：位置是归一化坐标）
 * 由 `upgradeRawDocument` / `migrateScenePositions` 先升级结构，再走 schema。
 */

export const worldPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const imageRefSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const gridSpecSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const cellRunsSchema = z.object({
  encoding: z.literal("rle"),
  runs: z.array(z.tuple([z.number().int().min(0).max(255), z.number().int().nonnegative()])),
});

/**
 * 战争雾（v10 起）：指定哪些区域算雾区。
 *
 * `regions` 给默认值 `[]` 是有意的（与 v7 的 `active` 同理）：**字段在、内容空**和
 * 「字段整个不在」在语义上是一回事（没指定任何雾区），给默认值省掉一处三元判断。
 * 位值范围只挡到 1–255（与格子掩码同一个口径）；「必须是已知的可绘制位」属于语义校验，
 * 由 `validateScene` 报 warning——手写文件里的越界位要在界面上看得见，而不是读不开文件。
 */
export const mapFogSchema = z.object({
  regions: z.array(z.number().int().min(1).max(255)).default([]),
});

export const mapDataSchema = z.object({
  image: imageRefSchema,
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
  fog: mapFogSchema.optional(),
});

/**
 * 播放声音（动作对象）的数据：加进来的音频列表 + 选中的那条（可选）+ 每个文件的显示名（可选）+ 层级。
 *
 * `clips` 给默认值 `[]`、`layer` 给默认值 `"sfx"`：手写文件里少写一项时，
 * 语义只能是「还没加音频」「音效这一层」，给默认值省掉一处三元判断。
 * 层级只认四档（`SOUND_LAYERS`）：写了别的值说明数据不是这份编辑器写的，报错比猜更安全。
 * `picked` 缺省 = 还没选（播放按钮点不了）：它必须落在 `clips` 里，越界不算解析错误
 * （`validateScene` 会把「选中的那条不在列表里」提醒出来并按没选处理）。
 * `names` 是「文件 → 显示名」的可选标签（缺省 = 素材文件名）：空白名字不在这里硬拒，
 * 由 `validateScene` 提醒。
 */
export const soundDataSchema = z.object({
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  names: z.record(z.string(), z.string()).optional(),
  layer: z.enum(SOUND_LAYERS).default("sfx"),
});

export const conditionSchema = z.object({
  valueType: z.enum(["Bool", "String", "Number", "Integer"]),
  op: z.enum(["Equal", "NotEqual", "AtLeast", "AtMost"]),
  target: z.union([z.boolean(), z.string(), z.number()]),
});

export const actionInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  enabled: z.boolean(),
  condition: conditionSchema.optional(),
  params: z.record(z.string(), z.unknown()),
});

export const componentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  displayName: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  actions: z.array(actionInstanceSchema),
});

export const sceneObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(["Map", "SceneObject", "Player", "Item", "Event", "PlaySound"]),
  // v7 起：是否显示 + 显示顺序。**给默认值**是有意的——v6 及更早的文件没有这两个字段，
  // 「没写」只能是「显示、顺序 0」；写成必填会让所有旧文件直接读不开。
  active: z.boolean().default(true),
  sortingOrder: z.number().int().default(0),
  // v9 起：是否锁定（不能被移动）。同样是「老文件里没有 = 默认值」，默认不锁
  locked: z.boolean().default(false),
  position: worldPositionSchema.nullable(),
  rotation: z.number(),
  // v8 起：等比缩放。同样给默认值（v7 及更早的文件没有它，语义只能是 1 = 原始尺寸）；
  // 0 / 负数 / NaN 这类坏值不在这里硬拒（读不开比画不出来更糟），由 `validateScene` 报错
  scale: z.number().default(1),
  // v11 起：单轴缩放（可选）。存在时覆盖 `scale` 在对应轴上的值；**不给默认值**是有意的
  // ——「没写」的语义是「用 `scale`」，补成 1 会把等比对象悄悄变成非等比。
  // 取值与坏值处理同 `scale`（见 `@dts/document` 的 `effectiveScaleX` / `validateScene`）
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  components: z.array(componentSchema),
  map: mapDataSchema.optional(),
  // 动作对象（播放声音）的声音数据
  sound: soundDataSchema.optional(),
  // 对象要显示的图片（精灵用；地图的贴图在 map.image 里）
  image: imageRefSchema.optional(),
});

/** 场景文件内容：**不含场景名**——名字就是文件名，重复存名字迟早会和磁盘上的名字不一致。 */
export const sceneFileSchema = z.object({
  formatVersion: z.number().int().positive(),
  objects: z.array(sceneObjectSchema),
});

export const itemDefSchema = z.object({
  name: z.string().min(1),
  price: z.number().nullable(),
  category: z.string(),
  identify: z.string(),
  usage: z.string(),
});

export const itemLibrarySchema = z.object({
  source: z.string(),
  updatedAt: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(itemDefSchema),
});

/** 工程文件：只有项目级数据，场景在 `Assets/scenes/` 下各自成文件。 */
export const projectDocSchema = z.object({
  formatVersion: z.number().int().positive(),
  name: z.string().min(1),
  items: itemLibrarySchema,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验失败时把 zod 的问题列表拼成「字段路径: 消息」的可读形式。 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * v1 → v2 结构升级。
 *
 * v1 把地图当成场景本身（`map.image/grid/cells/objects`）；v2 里场景是容器，
 * 地图降级为场景里的一个普通对象（`kind: "Map"`，数据挂在 `object.map` 上）。
 * 升级时把原来的地图数据原样搬到一个新建的地图对象上，其余对象保持不动。
 */
function upgradeV1Document(raw: Record<string, unknown>): Record<string, unknown> {
  const maps = Array.isArray(raw.maps) ? raw.maps : [];

  const scenes = maps.filter(isRecord).map((map) => {
    const id = typeof map.id === "string" ? map.id : `scene_${Math.random().toString(36).slice(2, 8)}`;
    const name = typeof map.name === "string" ? map.name : id;
    const objects = Array.isArray(map.objects) ? map.objects.filter(isRecord) : [];

    const mapObject = {
      id: `${id}__map`,
      name: `${name} 地图`,
      kind: "Map",
      position: null,
      rotation: 0,
      components: [],
      map: {
        image: map.image,
        grid: map.grid,
        rowOrder: map.rowOrder,
        cells: map.cells,
      },
    };

    return {
      id,
      name,
      objects: [mapObject, ...objects],
    };
  });

  const upgraded: Record<string, unknown> = { ...raw, formatVersion: 2, scenes };
  delete upgraded.maps;
  return upgraded;
}

/** 按 `formatVersion` 把旧结构升级到当前结构（只做结构搬运，不做字段补全）。 */
export function upgradeRawDocument(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }

  const version = typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
  if (version <= 1 && Array.isArray(raw.maps)) {
    return upgradeV1Document(raw);
  }

  return raw;
}

/**
 * 场景范围的兜底尺寸（旧文件里没写尺寸、调用方也拿不到时用）。
 *
 * 与编辑器新建地图对象的默认贴图尺寸一致（1920×1080 → 64×36 格）。
 */
const FALLBACK_SCENE_SIZE = { width: 1920, height: 1080 } as const;

/** 位置迁移用到的场景尺寸：优先用调用方给的（地图贴图尺寸），否则兜底。 */
export interface SceneSizeHint {
  readonly width: number;
  readonly height: number;
}

/**
 * 给对象补上 v7 的 `active` / `sortingOrder`、v8 的 `scale`、v9 的 `locked`，
 * 并给**没有位置的地图**补上世界原点。
 *
 * - 地图是摆在世界里的对象，必须有位置才能渲染（`position: null` 的地图没有地方可画）。
 *   旧文件里确实可能是 `null`（v1→v2 升级时造的地图对象、或手写文件），补成 `(0, 0)`
 *   正好是它以前被隐式绘制的那个位置（世界原点为中心），画面不变。
 * - `active` / `sortingOrder` / `scale` / `locked` 是后来新增的**显式**字段：老文件里没有，
 *   语义只能是「显示、顺序 0、缩放 1、不锁」。补进内存后要求调用方回写一次，
 *   否则会出现「内存里已补全、磁盘上还是缺字段」的长期不一致。
 * - v11 的 `scaleX` / `scaleY` **刻意不在这里补**：它们是**可选**的，「没写」本身就是合法
 *   且有意义的（= 用等比 `scale`）。补成 1 会把等比对象悄悄变成非等比，那才是改坏数据。
 *
 * 返回是否补过：补了就要求调用方回写一次文件。
 */
function withFilledObjectFields(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object) => {
    if (!isRecord(object)) {
      return object;
    }

    let filled = object;
    if (typeof filled.active !== "boolean") {
      filled = { ...filled, active: true };
      changed = true;
    }

    if (typeof filled.sortingOrder !== "number") {
      filled = { ...filled, sortingOrder: 0 };
      changed = true;
    }

    if (typeof filled.scale !== "number") {
      filled = { ...filled, scale: 1 };
      changed = true;
    }

    if (typeof filled.locked !== "boolean") {
      filled = { ...filled, locked: false };
      changed = true;
    }

    if (filled.kind === "Map" && (filled.position === null || filled.position === undefined)) {
      filled = { ...filled, position: { x: 0, y: 0 } };
      changed = true;
    }

    return filled;
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v4 → v5：位置从**归一化坐标 `[0,1]`（y 向下）**换算成**世界坐标（x 向右，y 向上）**。
 *
 * 换算与 `@dts/grid` 的 `world.ts` 一致，这里手写一遍是为了**不引入依赖**（document 只依赖 grid
 * 的字节与掩码工具，坐标换算在迁移里只出现这一次）。旧值越界（不在 `[0,1]`）时**原样保留**，
 * 宁可让它在画布上偏出去，也不静默夹到边界——那会把错误数据伪装成正确数据。
 *
 * 地图对象的位置**照常换算**：地图是摆在世界里的对象，位置就是它的贴图中心。
 */
function migrateScenePositions(
  raw: Record<string, unknown>,
  size: SceneSizeHint,
): Record<string, unknown> {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];

  return {
    ...raw,
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: objects.map((object) => {
      if (!isRecord(object) || !isRecord(object.position)) {
        return object;
      }

      const { x, y } = object.position;
      if (typeof x !== "number" || typeof y !== "number") {
        return object;
      }

      if (x < 0 || x > 1 || y < 0 || y > 1) {
        return object;
      }

      return {
        ...object,
        position: {
          x: x * size.width - size.width / 2,
          y: size.height / 2 - y * size.height,
        },
      };
    }),
  };
}

/**
 * 文件里写的 `formatVersion`（没写就按 v1 算）。
 *
 * **判断迁移不能拿它跟 `DOCUMENT_FORMAT_VERSION` 比**：版本号一涨，所有旧文件都会被
 * 判成「需要做位置换算」，那会把已经是世界坐标的 v5 文件再换算一次（(0,0) 变成 (-960, …)）。
 * 每一步迁移只认它自己那个版本线（见 `WORLD_POSITION_VERSION`）。
 */
function formatVersionOf(raw: Record<string, unknown>): number {
  return typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
}

/** v5 起位置是世界坐标；更早的是归一化坐标 `[0,1]`（y 向下）。 */
const WORLD_POSITION_VERSION = 5;

/**
 * 版本迁移。当前最高 v6；遇到更高版本明确拒绝
 * （避免高版本字段被静默丢弃后回存造成数据损坏）。
 */
export function migrateProjectDoc(doc: ProjectDoc): ProjectDoc {
  if (doc.formatVersion > DOCUMENT_FORMAT_VERSION) {
    throw new Error(
      `项目文档 formatVersion=${doc.formatVersion} 高于本编辑器支持的 ${DOCUMENT_FORMAT_VERSION}，请升级编辑器`,
    );
  }

  return doc;
}

/** 场景文件的内部形状（内存里用），加载出来后再补上「场景名 = 文件名」。 */
export interface ProjectFileLoad {
  readonly doc: ProjectDoc;
  /** 旧版工程文件里内联的场景：调用方需要把它们写成 scenes/ 下的独立文件。 */
  readonly migratedScenes: readonly SceneDoc[];
  /** 工程文件是旧版本，需要按新格式回写。 */
  readonly needsRewrite: boolean;
}

/**
 * 读取工程文件。
 *
 * v1/v2 的工程文件里场景是内联的，这里只把它们**拆出来**交给调用方落盘——
 * document 包不碰文件系统，写不写、写到哪由调用方决定；
 * 迁移后的 `doc.formatVersion` 一律提升到当前版本，回写时不会再把旧版本号写回磁盘。
 */
export function parseProjectFile(raw: unknown): ProjectFileLoad {
  const upgraded = upgradeRawDocument(raw);
  const result = projectDocSchema.safeParse(upgraded);
  if (!result.success) {
    throw new Error(`项目文档校验失败: ${formatIssues(result.error)}`);
  }

  // v2（以及经 v1 升级后的 v2）的工程文件里还有内联场景；v3 起没有
  const scenes = isRecord(upgraded) && Array.isArray(upgraded.scenes) ? upgraded.scenes : [];
  const migratedScenes: SceneDoc[] = scenes.map((scene) => {
    const file = parseSceneFile(scene).file;
    return { name: scene.name, objects: file.objects };
  });

  const needsRewrite = migratedScenes.length > 0 || result.data.formatVersion < DOCUMENT_FORMAT_VERSION;
  const doc = migrateProjectDoc({
    ...(result.data as ProjectDoc),
    ...(needsRewrite ? { formatVersion: DOCUMENT_FORMAT_VERSION } : {}),
  });

  return { doc, migratedScenes, needsRewrite };
}

/** 读工程文件，只要项目级数据（调用方不关心迁移时用它）。 */
export function parseProjectDoc(raw: unknown): ProjectDoc {
  return parseProjectFile(raw).doc;
}

/** 场景文件加载结果。 */
export interface SceneFileLoad {
  readonly file: SceneFileDoc;
  /** 文件需要按新格式回写一次（旧版本升级，或补上了缺失的字段）。 */
  readonly needsRewrite: boolean;
}

/**
 * 读场景文件；场景名由调用方从文件名得到。
 *
 * `size` 是场景（地图贴图）尺寸，旧格式的归一化位置靠它换算成世界坐标；
 * 拿不到时用兜底尺寸（1920×1080）。
 */
export function parseSceneFile(raw: unknown, size?: SceneSizeHint): SceneFileLoad {
  const upgraded = upgradeRawDocument(raw);
  let normalized = upgraded;
  let needsRewrite = false;

  if (isRecord(upgraded)) {
    const version = formatVersionOf(upgraded);
    // 高版本文件明确拒绝：读不懂的字段被静默丢掉再回存，等于把数据毁掉
    if (version > DOCUMENT_FORMAT_VERSION) {
      throw new Error(
        `场景文件 formatVersion=${version} 高于本编辑器支持的 ${DOCUMENT_FORMAT_VERSION}，请升级编辑器`,
      );
    }

    // 归一化坐标（v4 及更早）先换算成世界坐标；地图的位置照常换算，它也是摆在世界里的对象
    const migrated =
      version < WORLD_POSITION_VERSION
        ? migrateScenePositions(upgraded, size ?? FALLBACK_SCENE_SIZE)
        : upgraded;
    // 再补上 v7 的显式字段（active / sortingOrder）与「没有位置的地图」
    const filled = withFilledObjectFields(migrated);
    // 读出来的文档一律是当前版本（v6 起网格里不再存 `cellSize`，顺手被 schema 丢掉）
    normalized = { ...filled.raw, formatVersion: DOCUMENT_FORMAT_VERSION };
    needsRewrite = version < DOCUMENT_FORMAT_VERSION || filled.changed;
  }

  const result = sceneFileSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(`场景文件校验失败: ${formatIssues(result.error)}`);
  }

  return {
    file: result.data as SceneFileDoc,
    needsRewrite,
  };
}
