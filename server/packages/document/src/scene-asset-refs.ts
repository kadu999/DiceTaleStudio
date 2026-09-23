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
  const resourceKeys = new Set<string>();
  if (type === "GridMap") resourceKeys.add("image");
  const imageLayer = type === "ImageLayer" || type === "SpriteLayer";
  if (imageLayer) resourceKeys.add("id");
  if (type === "PlaySound" || type === "VideoOverlay") {
    resourceKeys.add("clips");
    resourceKeys.add("picked");
    resourceKeys.add("names");
  }
  if (type === "MaskImage") resourceKeys.add("image");
  if (resourceKeys.size === 0) return data;

  let changed = false;
  if (imageLayer) {
    const next = mapImageReference(data, metas, mode);
    return next === data ? data : (next as Record<string, unknown>);
  }

  const mapped: Record<string, unknown> = { ...data };
  for (const key of resourceKeys) {
    const value = data[key];
    const next = key === "names"
      ? mapResourceNameTable(value, metas, mode)
      : key === "image" && type === "GridMap"
        ? mapImageReference(value, metas, mode)
        : mapResourceValue(value, metas, mode);
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

function mapResourceNameTable(value: unknown, metas: AssetMetas, mode: "guid" | "id"): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(value)) {
    const next = mapResourceValue(key, metas, mode);
    mapped[String(next)] = name;
    changed ||= next !== key;
  }
  return changed ? mapped : value;
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
