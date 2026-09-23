import { describe, expect, it } from "vitest";
import {
  assetGuidOfId,
  assetIdOfGuid,
  createAssetMeta,
  createAssetMetas,
  createEmptyScene,
  createSceneObject,
  setObjectImage,
  sceneAssetRefsToGuids,
  sceneAssetRefsToIds,
} from "../src/index";

const IMAGE_ID = "project:P/Assets/images/hero.png";

describe("scene asset identity", () => {
  it("stores references as GUIDs and resolves them to the current path", () => {
    const meta = createAssetMeta("texture");
    const metas = createAssetMetas([{ id: IMAGE_ID, meta }]);
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [createSceneObject({ id: "sprite-1", name: "sprite" })],
    };
    setObjectImage(scene, "sprite-1", { id: IMAGE_ID, width: 64, height: 64 });

    const stored = sceneAssetRefsToGuids(scene, metas);
    const storedImage = (stored.objects[0]!.components[0]!.data as { id: string }).id;
    expect(storedImage).toBe(meta.guid);
    expect(storedImage).not.toContain("Assets/");

    const loaded = sceneAssetRefsToIds(stored, metas);
    const loadedImage = (loaded.objects[0]!.components[0]!.data as { id: string });
    expect(loadedImage.id).toBe(IMAGE_ID);
    expect(assetGuidOfId(metas, IMAGE_ID)).toBe(meta.guid);
    expect(assetIdOfGuid(metas, meta.guid)).toBe(IMAGE_ID);
  });

  it("converts resource IDs nested in scene data without changing unrelated strings", () => {
    const audioId = "project:P/Assets/audio/hit.wav";
    const meta = createAssetMeta("audio");
    const metas = createAssetMetas([{ id: audioId, meta }]);
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [
        {
          ...createSceneObject({ id: "sound-1", name: "sound" }),
          components: [
            {
              id: "custom",
              type: "PlaySound",
              data: { clips: [audioId], label: "Assets/audio/hit.wav" },
              actions: [],
            },
          ],
        },
      ],
    };

    const stored = sceneAssetRefsToGuids(scene, metas);
    const storedData = stored.objects[0]!.components[0]!.data;
    expect((storedData.clips as string[])[0]).toBe(meta.guid);
    expect(storedData.label).toBe("Assets/audio/hit.wav");
    const loaded = sceneAssetRefsToIds(stored, metas);
    expect((loaded.objects[0]!.components[0]!.data.clips as string[])[0]).toBe(audioId);
  });

  it("leaves unresolved legacy references untouched", () => {
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [createSceneObject({ id: "sprite-1", name: "sprite" })],
    };
    setObjectImage(scene, "sprite-1", { id: IMAGE_ID, width: 64, height: 64 });

    const stored = sceneAssetRefsToGuids(scene, createAssetMetas([]));
    expect((stored.objects[0]!.components[0]!.data as { id: string }).id).toBe(IMAGE_ID);
  });
});
