import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  addObjectComponent,
  addObjectVideoBlend,
  createGameObject,
  removeObjectComponent,
  removeObjectVideoBlend,
  setComponentField,
  setVideoBlendClips,
  setVideoBlendPicked,
} from "../src/commands";
import { videoBlendDataOf } from "../src/access";
import { ASSET_META_FORMAT_VERSION, createAssetMetas } from "../src/asset-meta";
import { featureComponent } from "../src/components";
import { sceneAssetRefsToGuids, sceneAssetRefsToIds } from "../src/scene-asset-refs";
import {
  DEFAULT_SLOT_COMPONENT,
  DEFAULT_VIDEO_BLEND_AUDIO,
  DEFAULT_VIDEO_LOOP,
  supportsVideoBlend,
} from "../src/presets";
import { createEmptyScene, createSoundObject } from "../src/factory";
import { parseSceneFile, videoBlendDataSchema } from "../src/schema";
import { validateScene } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, VIDEO_BLEND_AUDIO, type GameObjectDoc, type SceneDoc } from "../src/types";

/**
 * 视频混合（`VideoBlend`，新增）：**两条视频通道叠在同一个矩形上用 Mask 混合**——
 * A 盖住、擦开露 B。
 *
 * 它与「视频」（`VideoOverlay`）是**两个组件**，别混：
 * - 视频：一个对象一条流，整块盖在对象自己的矩形上；
 * - 视频混合：两条流 + 一张**纯运行态**的遮罩（不写文档，由 `erase_video_mask` 驱动），
 *   文档里只声明「放哪两条 / 循环 / 声音从哪来」。
 *
 * 一条贯穿全篇的规矩（照抄声音 / 视频那套）：每条通道是 `{ clips, picked? }`，
 * **选中的那条挂在「加进来的列表」上**，列表一变它跟着走；`loop` / `audio` 是**组件自己的设置**，
 * 清空列表也不该被抹掉。
 */

const CLIP_A = "project:C/Assets/video/a.mp4";
const CLIP_B = "project:C/Assets/video/b.mp4";
const CLIP_C = "project:C/Assets/video/c.mp4";

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("场景1"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

/** 一张贴图（视频混合唯一的合法宿主）。 */
function textureObject(id = "tex-1"): GameObjectDoc {
  return createGameObject({ id, name: "贴图", kind: "Image" });
}

/** 已经挂上视频混合组件的贴图。 */
function blendedTexture(): SceneDoc {
  return mutate(sceneWith([textureObject()]), (draft) => {
    addObjectVideoBlend(draft, "tex-1");
  });
}

function channelsOf(scene: { readonly objects: readonly GameObjectDoc[] }, id = "tex-1") {
  const object = scene.objects.find((item) => item.id === id);
  return object === undefined ? undefined : videoBlendDataOf(object);
}

describe("视频混合：哪些对象能带", () => {
  it("只有贴图能带；精灵 / 动作对象 / 战争雾都不行", () => {
    expect(supportsVideoBlend("Image")).toBe(true);
    for (const kind of ["Sprite", "Player", "Item", "Event", "PlaySound", "Teleport", "Fog", "GameObject"] as const) {
      expect(supportsVideoBlend(kind), kind).toBe(false);
    }
  });
});

describe("视频混合：添加与移除", () => {
  it("贴图能加：写一份默认组件（两条空通道 + 不循环 + 静音）", () => {
    const scene = sceneWith([textureObject()]);
    const added = mutate(scene, (draft) => {
      expect(addObjectVideoBlend(draft, "tex-1")).toBe(true);
    });

    expect(channelsOf(added)).toEqual({
      a: { clips: [] },
      b: { clips: [] },
      loop: DEFAULT_VIDEO_LOOP,
      audio: DEFAULT_VIDEO_BLEND_AUDIO,
    });

    // 已经挂过 = 没变更
    expect(
      mutate(added, (draft) => {
        expect(addObjectVideoBlend(draft, "tex-1")).toBe(false);
      }),
    ).toBe(added);
  });

  it("精灵加不了（无变更）", () => {
    const scene = sceneWith([createGameObject({ id: "sprite-1", name: "精灵" })]);
    expect(
      mutate(scene, (draft) => {
        expect(addObjectVideoBlend(draft, "sprite-1")).toBe(false);
      }),
    ).toBe(scene);
  });

  it("移除组件：没有组件 / 对象不在 = 没变更", () => {
    const scene = sceneWith([textureObject()]);
    expect(
      mutate(scene, (draft) => {
        expect(removeObjectVideoBlend(draft, "tex-1")).toBe(false);
      }),
    ).toBe(scene);
    expect(
      mutate(scene, (draft) => {
        expect(removeObjectVideoBlend(draft, "nope")).toBe(false);
      }),
    ).toBe(scene);

    const removed = mutate(blendedTexture(), (draft) => {
      expect(removeObjectVideoBlend(draft, "tex-1")).toBe(true);
    });
    expect(channelsOf(removed)).toBeUndefined();
  });

  it("Add Component 统一入口也按类型分派到视频混合", () => {
    const scene = sceneWith([textureObject()]);
    const added = mutate(scene, (draft) => {
      expect(addObjectComponent(draft, "tex-1", "VideoBlend")).toBe(true);
    });
    expect(channelsOf(added)).toBeDefined();

    const removed = mutate(added, (draft) => {
      expect(removeObjectComponent(draft, "tex-1", "VideoBlend")).toBe(true);
    });
    expect(channelsOf(removed)).toBeUndefined();
  });
});

describe("视频混合：两条通道的列表与选中", () => {
  it("加列表：去空去重、默认选中第一条；两条通道互不影响", () => {
    const one = mutate(blendedTexture(), (draft) => {
      expect(setVideoBlendClips(draft, "tex-1", "a", [CLIP_A, CLIP_A, "  ", CLIP_B])).toBe(true);
    });
    expect(channelsOf(one)?.a).toEqual({ clips: [CLIP_A, CLIP_B], picked: CLIP_A });
    expect(channelsOf(one)?.b).toEqual({ clips: [] });

    const two = mutate(one, (draft) => {
      expect(setVideoBlendClips(draft, "tex-1", "b", [CLIP_C])).toBe(true);
    });
    expect(channelsOf(two)?.a).toEqual({ clips: [CLIP_A, CLIP_B], picked: CLIP_A });
    expect(channelsOf(two)?.b).toEqual({ clips: [CLIP_C], picked: CLIP_C });

    // 值没变 = 不变更
    expect(
      mutate(two, (draft) => {
        expect(setVideoBlendClips(draft, "tex-1", "a", [CLIP_A, CLIP_B])).toBe(false);
      }),
    ).toBe(two);
  });

  it("移出选中的那条 → 顺到第一条；清空 → 删掉 picked", () => {
    const added = mutate(blendedTexture(), (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", [CLIP_A, CLIP_B]);
    });
    const pickedB = mutate(added, (draft) => {
      expect(setVideoBlendPicked(draft, "tex-1", "a", CLIP_B)).toBe(true);
    });
    expect(channelsOf(pickedB)?.a.picked).toBe(CLIP_B);

    const removedB = mutate(pickedB, (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", [CLIP_A]);
    });
    expect(channelsOf(removedB)?.a.picked).toBe(CLIP_A);

    const cleared = mutate(removedB, (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", []);
    });
    expect(channelsOf(cleared)?.a).toEqual({ clips: [] });
  });

  it("选中只能选本通道 clips 里的；取消选中可空", () => {
    const scene = mutate(blendedTexture(), (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", [CLIP_A]);
    });

    // CLIP_C 不在 A 的列表里（哪怕以后加到 B 里也不行）
    expect(
      mutate(scene, (draft) => {
        expect(setVideoBlendPicked(draft, "tex-1", "a", CLIP_C)).toBe(false);
      }),
    ).toBe(scene);

    const unset = mutate(scene, (draft) => {
      expect(setVideoBlendPicked(draft, "tex-1", "a", null)).toBe(true);
    });
    expect(channelsOf(unset)?.a.picked).toBeUndefined();
  });

  it("非贴图对象上的命令一律不生效（返回 false，也不补组件）", () => {
    const scene = sceneWith([createSoundObject({ name: "脚步", id: "s1" })]);
    expect(
      mutate(scene, (draft) => {
        expect(setVideoBlendClips(draft, "s1", "a", [CLIP_A])).toBe(false);
        expect(setVideoBlendPicked(draft, "s1", "a", CLIP_A)).toBe(false);
        expect(setComponentField(draft, "s1", DEFAULT_SLOT_COMPONENT.videoBlend, "loop", true)).toBe(false);
      }),
    ).toBe(scene);
  });
});

describe("视频混合：循环 / 声音走组件规格的泛型写入", () => {
  it("setComponentField 能改 loop 与 audio；非法枚举值被拒（文档不变）", () => {
    const changed = mutate(blendedTexture(), (draft) => {
      expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "loop", true)).toBe(true);
      expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "audio", "b")).toBe(true);
    });
    expect(channelsOf(changed)?.loop).toBe(true);
    expect(channelsOf(changed)?.audio).toBe("b");

    expect(
      mutate(changed, (draft) => {
        expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "audio", "bogus")).toBe(false);
      }),
    ).toBe(changed);
  });

  it("清空列表不会抹掉 loop / audio（那是组件自己的设置）", () => {
    const scene = mutate(blendedTexture(), (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", [CLIP_A]);
      setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "loop", true);
      setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "audio", "a");
    });
    const cleared = mutate(scene, (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", []);
    });
    expect(channelsOf(cleared)?.loop).toBe(true);
    expect(channelsOf(cleared)?.audio).toBe("a");
  });
});

describe("视频混合：schema 与校验", () => {
  it("默认值：两条空通道 + 不循环 + 静音；声音枚举只有三档", () => {
    expect(videoBlendDataSchema.parse({})).toEqual({
      a: { clips: [] },
      b: { clips: [] },
      loop: false,
      audio: "none",
    });
    expect([...VIDEO_BLEND_AUDIO]).toEqual(["none", "a", "b"]);
    expect(videoBlendDataSchema.safeParse({ audio: "bogus" }).success).toBe(false);
    expect(videoBlendDataSchema.safeParse({ a: { clips: [""] } }).success).toBe(false);
  });

  it("落盘往返：整份读得出、不需要迁移", () => {
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          ...textureObject(),
          components: [
            featureComponent("tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, {
              a: { clips: [CLIP_A], picked: CLIP_A },
              b: { clips: [CLIP_B] },
              loop: true,
              audio: "a",
            }),
          ],
        },
      ],
    };

    const loaded = parseSceneFile(raw);
    expect(loaded.needsRewrite).toBe(false);
    expect(channelsOf(loaded.file)).toEqual({
      a: { clips: [CLIP_A], picked: CLIP_A },
      b: { clips: [CLIP_B] },
      loop: true,
      audio: "a",
    });
  });

  it("校验：空条目 / 选中不在列表 / 与「视频」并存都给 warning", () => {
    const object = textureObject();
    const scene = sceneWith([
      {
        ...object,
        components: [
          featureComponent(object.id, DEFAULT_SLOT_COMPONENT.video, {
            clips: [CLIP_C],
            enabled: true,
            loop: false,
            audio: false,
          }),
          featureComponent(object.id, DEFAULT_SLOT_COMPONENT.videoBlend, {
            a: { clips: [CLIP_A, "  "], picked: CLIP_B },
            b: { clips: [] },
            loop: false,
            audio: "none",
          }),
        ],
      },
    ]);

    const messages = validateScene(scene)
      .map((issue) => issue.message)
      .join("\n");
    expect(messages).toMatch(/视频混合通道 A 里有空条目/);
    expect(messages).toMatch(/通道 A 选中的那条视频不在它的列表里/);
    expect(messages).toMatch(/同时挂了「视频」与「视频混合」/);
  });
});

describe("视频混合：场景文件里存素材 GUID", () => {
  it("两条通道的 clips / picked 都按 guid ↔ id 换算", () => {
    const guidA = "a".repeat(32);
    const guidB = "b".repeat(32);
    const metas = createAssetMetas([
      { id: CLIP_A, meta: { formatVersion: ASSET_META_FORMAT_VERSION, guid: guidA, importer: "video" } },
      { id: CLIP_B, meta: { formatVersion: ASSET_META_FORMAT_VERSION, guid: guidB, importer: "video" } },
    ]);

    const scene = mutate(blendedTexture(), (draft) => {
      setVideoBlendClips(draft, "tex-1", "a", [CLIP_A]);
      setVideoBlendClips(draft, "tex-1", "b", [CLIP_B]);
    });

    const persisted = sceneAssetRefsToGuids(scene, metas);
    expect(channelsOf(persisted)?.a).toEqual({ clips: [guidA], picked: guidA });
    expect(channelsOf(persisted)?.b).toEqual({ clips: [guidB], picked: guidB });

    const restored = sceneAssetRefsToIds(persisted, metas);
    expect(channelsOf(restored)?.a).toEqual({ clips: [CLIP_A], picked: CLIP_A });
    expect(channelsOf(restored)?.b).toEqual({ clips: [CLIP_B], picked: CLIP_B });
  });
});
