import { z } from "zod";
import { DOCUMENT_FORMAT_VERSION, type ProjectDoc } from "./types";

/**
 * 文档 zod 校验。
 *
 * 加载任何项目文件都必须先过这里：不合法就报错，**不静默丢字段**。
 * 旧版本（v1：地图即场景）由 `upgradeRawDocument` 先升级结构，再走本 schema。
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

export const spawnPointSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  position: normPositionSchema,
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

export const sceneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  objects: z.array(sceneObjectSchema),
  spawnPoints: z.array(spawnPointSchema),
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

export const projectDocSchema = z.object({
  formatVersion: z.number().int().positive(),
  name: z.string().min(1),
  scenes: z.array(sceneSchema),
  items: itemLibrarySchema,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      spawnPoints: Array.isArray(map.spawnPoints) ? map.spawnPoints : [],
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

/** 校验失败时抛出带字段路径的可读错误。 */
export function parseProjectDoc(raw: unknown): ProjectDoc {
  const result = projectDocSchema.safeParse(upgradeRawDocument(raw));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`项目文档校验失败: ${detail}`);
  }

  return migrateProjectDoc(result.data as ProjectDoc);
}

/**
 * 版本迁移。当前最高 v2；遇到更高版本明确拒绝
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
