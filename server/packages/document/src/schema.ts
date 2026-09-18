import { z } from "zod";
import {
  DOCUMENT_FORMAT_VERSION,
  type ProjectDoc,
  type SceneDoc,
  type SceneFileDoc,
} from "./types";

/**
 * 文档 zod 校验。
 *
 * 加载任何文件都必须先过这里：不合法就报错，**不静默丢字段**。
 * 工程文件（`project.json`）与场景文件（`Assets/scenes/<场景名>.json`）各有一套 schema；
 * 旧版本（v1：地图即场景；v2：场景内联在工程文件里）由 `upgradeRawDocument` 先升级结构，再走 schema。
 */

export const normPositionSchema = z.object({
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
  cellSize: z.number().positive(),
});

export const cellRunsSchema = z.object({
  encoding: z.literal("rle"),
  runs: z.array(z.tuple([z.number().int().min(0).max(255), z.number().int().nonnegative()])),
});

export const mapDataSchema = z.object({
  image: imageRefSchema,
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
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
  kind: z.enum(["Map", "SceneObject", "Player", "Item", "Event"]),
  position: normPositionSchema.nullable(),
  rotation: z.number(),
  components: z.array(componentSchema),
  map: mapDataSchema.optional(),
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
 * 版本迁移。当前最高 v4；遇到更高版本明确拒绝
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
  const migratedScenes: SceneDoc[] = scenes.map((scene) => ({
    name: scene.name,
    objects: scene.objects,
  }));

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
  /** 文件是旧版本（格式已升级），调用方需要按新格式回写一次。 */
  readonly needsRewrite: boolean;
}

/** 读场景文件；场景名由调用方从文件名得到。 */
export function parseSceneFile(raw: unknown): SceneFileLoad {
  const upgraded = upgradeRawDocument(raw);
  const result = sceneFileSchema.safeParse(upgraded);
  if (!result.success) {
    throw new Error(`场景文件校验失败: ${formatIssues(result.error)}`);
  }

  // 只按版本判断是否需要回写（`formatVersion` 缺失按 1 算，与工程文件一致）
  const version = isRecord(upgraded) && typeof upgraded.formatVersion === "number" ? upgraded.formatVersion : 1;

  return {
    file: result.data as SceneFileDoc,
    needsRewrite: version < DOCUMENT_FORMAT_VERSION,
  };
}
