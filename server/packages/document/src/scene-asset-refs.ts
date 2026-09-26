import { assetGuidOfId, assetIdOfGuid, type AssetMetas } from "./asset-meta";
import type { SceneDoc } from "./types";

/** Persist scene asset identity as GUIDs while keeping logical IDs in memory. */
export function sceneAssetRefsToGuids(scene: SceneDoc, metas: AssetMetas): SceneDoc {
  return mapSceneAssets(scene, metas, "guid");
}

/** Resolve persisted GUID references back to current logical resource IDs. */
export function sceneAssetRefsToIds(scene: SceneDoc, metas: AssetMetas): SceneDoc {
  return mapSceneAssets(scene, metas, "id");
}

function mapSceneAssets(scene: SceneDoc, metas: AssetMetas, mode: "guid" | "id"): SceneDoc {
  let changed = false;
  const objects = scene.objects.map((object) => {
    const mapped = mapObjectAssets(object, metas, mode);
    changed ||= mapped !== object;
    return mapped;
  });
  return changed ? { ...scene, objects } : scene;
}

function mapObjectAssets(object: SceneDoc["objects"][number], metas: AssetMetas, mode: "guid" | "id"): SceneDoc["objects"][number] {
  let changed = false;
  const components = object.components.map((component) => {
    const data = mapComponentData(component.type, component.data, metas, mode);
    if (data === component.data) return component;
    changed = true;
    return { ...component, data };
  });
  return changed ? { ...object, components } : object;
}

function mapComponentData(
  type: string,
  data: Record<string, unknown>,
  metas: AssetMetas,
  mode: "guid" | "id",
): Record<string, unknown> {
  // 图片层：整份就是「图片引用 + 显示顺序」，只有 `id` 是资源 ID
  if (type === "ImageLayer" || type === "SpriteLayer") {
    const next = mapImageReference(data, metas, mode);
    return next === data ? data : (next as Record<string, unknown>);
  }

  // 声音 / 视频：只有「列表 + 选中」是资源 ID。
  // v28 起 `GridMap` 的 data 里没有 `image`、按项记的 `names` 也已退役——那两段是
  // **永远匹配不到**的旧分支，已经删掉（手写文件里的 `names` 由 schema 当未知键丢弃）。
  if (type !== "PlaySound" && type !== "VideoOverlay") {
    return data;
  }

  let changed = false;
  const mapped: Record<string, unknown> = { ...data };
  for (const key of ["clips", "picked"] as const) {
    const value = data[key];
    const next = mapResourceValue(value, metas, mode);
    if (next !== value) {
      changed = true;
      mapped[key] = next;
    }
  }
  return changed ? mapped : data;
}

function mapImageReference(value: unknown, metas: AssetMetas, mode: "guid" | "id"): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const image = value as Record<string, unknown>;
  const id = image.id;
  if (typeof id !== "string") return value;
  const next = mapResourceValue(id, metas, mode);
  if (mode === "id" && next !== id && /^[0-9a-f]{32}$/.test(id)) {
    return { ...image, id: next, guid: image.guid ?? id };
  }
  return next === id ? value : { ...image, id: next };
}

function mapResourceValue(value: unknown, metas: AssetMetas, mode: "guid" | "id"): unknown {
  if (typeof value === "string") {
    if (mode === "guid") return assetGuidOfId(metas, value) ?? value;
    return /^[0-9a-f]{32}$/.test(value) ? assetIdOfGuid(metas, value) ?? value : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = mapResourceValue(item, metas, mode);
      changed ||= next !== item;
      return next;
    });
    return changed ? mapped : value;
  }
  return value;
}
