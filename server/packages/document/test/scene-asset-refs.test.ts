import { describe, expect, it } from "vitest";
import {
  assetGuidOfId,
  assetIdOfGuid,
  createAssetMeta,
  createAssetMetas,
  createEmptyScene,
  createGameObject,
  repairImageObjectComponent,
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
      objects: [createGameObject({ id: "sprite-1", name: "sprite" })],
    };
    repairImageObjectComponent(scene, "sprite-1", { id: IMAGE_ID, width: 64, height: 64 });

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

  it("resolves a renamed image by GUID and keeps its stable identity in memory", () => {
    const renamedId = "project:P/Assets/images/renamed.png";
    const meta = createAssetMeta("texture");
    const oldMetas = createAssetMetas([{ id: IMAGE_ID, meta }]);
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [createGameObject({ id: "sprite-1", name: "sprite" })],
    };
    repairImageObjectComponent(scene, "sprite-1", { id: IMAGE_ID, width: 64, height: 64 });
    const persisted = sceneAssetRefsToGuids(scene, oldMetas);

    const currentMetas = createAssetMetas([{ id: renamedId, meta }]);
    const loaded = sceneAssetRefsToIds(persisted, currentMetas);
    const image = loaded.objects[0]!.components[0]!.data as { id: string; guid?: string };

    expect(image.id).toBe(renamedId);
    expect(image.guid).toBe(meta.guid);
  });

  it("converts resource IDs nested in scene data without changing unrelated strings", () => {
    const audioId = "project:P/Assets/audio/hit.wav";
    const meta = createAssetMeta("audio");
    const metas = createAssetMetas([{ id: audioId, meta }]);
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [
        {
          ...createGameObject({ id: "sound-1", name: "sound" }),
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

  it("resolves renamed audio and video IDs from their stable GUIDs", () => {
    const oldAudio = "project:P/Assets/audio/old.wav";
    const newAudio = "project:P/Assets/audio/new.wav";
    const oldVideo = "project:P/Assets/video/old.mp4";
    const newVideo = "project:P/Assets/video/new.mp4";
    const audioMeta = createAssetMeta("audio");
    const videoMeta = createAssetMeta("video");
    const oldMetas = createAssetMetas([
      { id: oldAudio, meta: audioMeta },
      { id: oldVideo, meta: videoMeta },
    ]);
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [
        {
          ...createGameObject({ id: "sound-1", name: "sound" }),
          components: [
            {
              id: "sound-1__PlaySound",
              type: "PlaySound",
              data: { clips: [oldAudio], picked: oldAudio },
              actions: [],
            },
          ],
        },
        {
          ...createGameObject({ id: "image-1", name: "image", kind: "Image" }),
          components: [
            {
              id: "image-1__VideoOverlay",
              type: "VideoOverlay",
              data: { clips: [oldVideo], picked: oldVideo },
              actions: [],
            },
          ],
        },
      ],
    };
    const persisted = sceneAssetRefsToGuids(scene, oldMetas);
    const currentMetas = createAssetMetas([
      { id: newAudio, meta: audioMeta },
      { id: newVideo, meta: videoMeta },
    ]);

    const loaded = sceneAssetRefsToIds(persisted, currentMetas);
    const sound = loaded.objects[0]!.components[0]!.data;
    const video = loaded.objects[1]!.components[0]!.data;
    expect(sound).toMatchObject({ clips: [newAudio], picked: newAudio });
    expect(video).toMatchObject({ clips: [newVideo], picked: newVideo });
  });

  it("leaves unresolved legacy references untouched", () => {
    const scene = {
      ...createEmptyScene("Map001"),
      objects: [createGameObject({ id: "sprite-1", name: "sprite" })],
    };
    repairImageObjectComponent(scene, "sprite-1", { id: IMAGE_ID, width: 64, height: 64 });

    const stored = sceneAssetRefsToGuids(scene, createAssetMetas([]));
    expect((stored.objects[0]!.components[0]!.data as { id: string }).id).toBe(IMAGE_ID);
  });
});
