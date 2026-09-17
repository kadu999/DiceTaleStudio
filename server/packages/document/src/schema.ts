import { z } from "zod";
import { DOCUMENT_FORMAT_VERSION, type ProjectDoc } from "./types";

/**
 * 文档 zod 校验。
 *
 * 加载任何项目文件都必须先过这里：不合法就报错，**不静默丢字段**。
 * 未来 `formatVersion` 升级时在 `migrateProjectDoc` 里逐级迁移。
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
  runs: z.array(
    z.tuple([z.number().int().min(0).max(255), z.number().int().nonnegative()]),
  ),
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
  kind: z.enum(["SceneObject", "Player", "Item", "Event"]),
  position: normPositionSchema.nullable(),
  rotation: z.number(),
  components: z.array(componentSchema),
});

export const mapDocSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  image: imageRefSchema,
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
  spawnPoints: z.array(spawnPointSchema),
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

export const projectDocSchema = z.object({
  formatVersion: z.number().int().positive(),
  name: z.string().min(1),
  maps: z.array(mapDocSchema),
  items: itemLibrarySchema,
});

/** 校验失败时抛出带字段路径的可读错误。 */
export function parseProjectDoc(raw: unknown): ProjectDoc {
  const result = projectDocSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`项目文档校验失败: ${detail}`);
  }

  return migrateProjectDoc(result.data as ProjectDoc);
}

/**
 * 版本迁移。当前只有 v1；遇到更高版本明确拒绝（避免高版本字段被静默丢弃后回存造成数据损坏）。
 */
export function migrateProjectDoc(doc: ProjectDoc): ProjectDoc {
  if (doc.formatVersion > DOCUMENT_FORMAT_VERSION) {
    throw new Error(
      `项目文档 formatVersion=${doc.formatVersion} 高于本编辑器支持的 ${DOCUMENT_FORMAT_VERSION}，请升级编辑器`,
    );
  }

  return doc;
}
