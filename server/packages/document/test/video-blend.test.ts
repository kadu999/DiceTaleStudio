import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  addObjectComponent,
  addObjectVideoBlend,
  createGameObject,
  removeObjectComponent,
  removeObjectVideoBlend,
  setComponentField,
  setVideoBlendChannelId,
  setVideoBlendChannelKind,
  setVideoEnabled,
} from "../src/commands";
import { videoBlendDataOf, videoDataOf } from "../src/access";
import { ASSET_META_FORMAT_VERSION, createAssetMetas } from "../src/asset-meta";
import { featureComponent } from "../src/components";
import { sceneAssetRefsToGuids, sceneAssetRefsToIds } from "../src/scene-asset-refs";
import {
  DEFAULT_SLOT_COMPONENT,
  DEFAULT_VIDEO_AUTO_PLAY,
  DEFAULT_VIDEO_BLEND_AUDIO,
  DEFAULT_VIDEO_BLEND_KIND,
  DEFAULT_VIDEO_LOOP,
  supportsVideoBlend,
} from "../src/presets";
import { createEmptyScene, createSoundObject } from "../src/factory";
import { parseSceneFile, videoBlendDataSchema } from "../src/schema";
import { validateScene } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  VIDEO_BLEND_AUDIO,
  VIDEO_BLEND_KINDS,
  type GameObjectDoc,
  type SceneDoc,
} from "../src/types";

/**
 * 视频混合（`VideoBlend`）：**两路素材叠在同一个矩形上用 Mask 混合**——
 * A 盖住、擦开露 B。
 *
 * 它与「视频」（`VideoOverlay`）是**两个组件**，别混：
 * - 视频：一个对象一条流，整块盖在对象自己的矩形上；
 * - 视频混合：两路 + 一张**纯运行态**的遮罩（不写文档，由 `erase_video_mask` 驱动），
 *   文档里只声明「每路放什么 / 循环 / 自动播放 / 声音从哪来」。
 *
 * 一条贯穿全篇的规矩（v29 起）：**每路只放一个素材**（`{ kind, id? }`），
 * `kind` 是图片还是视频；`loop` / `autoPlay` / `audio` 是**组件自己的设置**，
 * 清掉素材也不该被抹掉。遮罩不在文档里（纯运行态）。
 */

const CLIP_A = "project:C/Assets/video/a.mp4";
const CLIP_B = "project:C/Assets/video/b.mp4";
const CLIP_C = "project:C/Assets/video/c.mp4";
const IMG_A = "project:C/Assets/images/a.png";

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

function blendOf(scene: { readonly objects: readonly GameObjectDoc[] }, id = "tex-1") {
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
  it("贴图能加：写一份默认组件（两路空素材 + 不循环 + 不自动播 + 静音）", () => {
    const scene = sceneWith([textureObject()]);
    const added = mutate(scene, (draft) => {
      expect(addObjectVideoBlend(draft, "tex-1")).toBe(true);
    });

    expect(blendOf(added)).toEqual({
      a: { kind: DEFAULT_VIDEO_BLEND_KIND },
      b: { kind: DEFAULT_VIDEO_BLEND_KIND },
      loop: DEFAULT_VIDEO_LOOP,
      autoPlay: DEFAULT_VIDEO_AUTO_PLAY,
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
    expect(blendOf(removed)).toBeUndefined();
  });

  it("Add Component 统一入口也按类型分派到视频混合", () => {
    const scene = sceneWith([textureObject()]);
    const added = mutate(scene, (draft) => {
      expect(addObjectComponent(draft, "tex-1", "VideoBlend")).toBe(true);
    });
    expect(blendOf(added)).toBeDefined();

    const removed = mutate(added, (draft) => {
      expect(removeObjectComponent(draft, "tex-1", "VideoBlend")).toBe(true);
    });
    expect(blendOf(removed)).toBeUndefined();
  });
});

describe("视频混合：两路素材（种类 + 素材）", () => {
  it("选 / 清某一路的素材；两路互不影响；值没变 = 不变更", () => {
    const one = mutate(blendedTexture(), (draft) => {
      expect(setVideoBlendChannelId(draft, "tex-1", "a", CLIP_A)).toBe(true);
    });
    expect(blendOf(one)?.a).toEqual({ kind: "video", id: CLIP_A });
    expect(blendOf(one)?.b).toEqual({ kind: "video" });

    const two = mutate(one, (draft) => {
      expect(setVideoBlendChannelId(draft, "tex-1", "b", IMG_A)).toBe(true);
    });
    expect(blendOf(two)?.a).toEqual({ kind: "video", id: CLIP_A });
    expect(blendOf(two)?.b).toEqual({ kind: "video", id: IMG_A });

    // 值没变 = 不变更
    expect(
      mutate(two, (draft) => {
        expect(setVideoBlendChannelId(draft, "tex-1", "a", CLIP_A)).toBe(false);
      }),
    ).toBe(two);

    // 清除：`null` 把素材清掉，`kind` 留着
    const cleared = mutate(two, (draft) => {
      expect(setVideoBlendChannelId(draft, "tex-1", "a", null)).toBe(true);
    });
    expect(blendOf(cleared)?.a).toEqual({ kind: "video" });

    // 本来就没选：再清一次 = 不变更
    expect(
      mutate(cleared, (draft) => {
        expect(setVideoBlendChannelId(draft, "tex-1", "a", null)).toBe(false);
      }),
    ).toBe(cleared);
  });

  it("换种类：写进文档，并**清掉**这一路已选的素材（旧素材属于另一种类型）", () => {
    const picked = mutate(blendedTexture(), (draft) => {
      setVideoBlendChannelId(draft, "tex-1", "a", CLIP_A);
    });

    const asImage = mutate(picked, (draft) => {
      expect(setVideoBlendChannelKind(draft, "tex-1", "a", "image")).toBe(true);
    });
    expect(blendOf(asImage)?.a).toEqual({ kind: "image" });

    // 种类没变 = 不变更
    expect(
      mutate(asImage, (draft) => {
        expect(setVideoBlendChannelKind(draft, "tex-1", "a", "image")).toBe(false);
      }),
    ).toBe(asImage);

    // 另一路不受影响
    const pickedB = mutate(asImage, (draft) => {
      setVideoBlendChannelId(draft, "tex-1", "b", IMG_A);
      setVideoBlendChannelKind(draft, "tex-1", "a", "video");
    });
    expect(blendOf(pickedB)?.a).toEqual({ kind: "video" });
    expect(blendOf(pickedB)?.b).toEqual({ kind: "video", id: IMG_A });
  });

  it("非贴图对象上的命令一律不生效（返回 false，也不补组件）", () => {
    const scene = sceneWith([createSoundObject({ name: "脚步", id: "s1" })]);
    expect(
      mutate(scene, (draft) => {
        expect(setVideoBlendChannelId(draft, "s1", "a", CLIP_A)).toBe(false);
        expect(setVideoBlendChannelKind(draft, "s1", "a", "image")).toBe(false);
        expect(setComponentField(draft, "s1", DEFAULT_SLOT_COMPONENT.videoBlend, "loop", true)).toBe(false);
      }),
    ).toBe(scene);
  });
});

describe("视频混合：循环 / 声音 / 自动播放走组件规格的泛型写入", () => {
  it("setComponentField 能改 loop / audio / autoPlay；非法枚举值被拒（文档不变）", () => {
    const changed = mutate(blendedTexture(), (draft) => {
      expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "loop", true)).toBe(true);
      expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "audio", "b")).toBe(true);
      expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "autoPlay", true)).toBe(true);
    });
    expect(blendOf(changed)?.loop).toBe(true);
    expect(blendOf(changed)?.audio).toBe("b");
    expect(blendOf(changed)?.autoPlay).toBe(true);

    expect(
      mutate(changed, (draft) => {
        expect(setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "audio", "bogus")).toBe(false);
      }),
    ).toBe(changed);
  });

  it("清掉素材不会抹掉 loop / audio（那是组件自己的设置）", () => {
    const scene = mutate(blendedTexture(), (draft) => {
      setVideoBlendChannelId(draft, "tex-1", "a", CLIP_A);
      setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "loop", true);
      setComponentField(draft, "tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, "audio", "a");
    });
    const cleared = mutate(scene, (draft) => {
      setVideoBlendChannelId(draft, "tex-1", "a", null);
    });
    expect(blendOf(cleared)?.loop).toBe(true);
    expect(blendOf(cleared)?.audio).toBe("a");
  });
});

describe("视频混合：schema 与校验", () => {
  it("默认值：两路空素材（默认视频）+ 不循环 + 不自动播 + 静音；枚举各只有合法几档", () => {
    expect(videoBlendDataSchema.parse({})).toEqual({
      a: { kind: "video" },
      b: { kind: "video" },
      loop: false,
      autoPlay: false,
      audio: "none",
    });
    expect([...VIDEO_BLEND_AUDIO]).toEqual(["none", "a", "b"]);
    expect([...VIDEO_BLEND_KINDS]).toEqual(["image", "video"]);
    expect(videoBlendDataSchema.safeParse({ audio: "bogus" }).success).toBe(false);
    expect(videoBlendDataSchema.safeParse({ a: { kind: "bogus" } }).success).toBe(false);
    expect(videoBlendDataSchema.safeParse({ a: { kind: "image", id: "" } }).success).toBe(false);
  });

  it("落盘往返：整份读得出、不需要迁移（v29 的单素材形状）", () => {
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          ...textureObject(),
          components: [
            featureComponent("tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, {
              a: { kind: "video", id: CLIP_A },
              b: { kind: "image", id: IMG_A },
              loop: true,
              autoPlay: true,
              audio: "a",
            }),
          ],
        },
      ],
    };

    const loaded = parseSceneFile(raw);
    expect(loaded.needsRewrite).toBe(false);
    expect(blendOf(loaded.file)).toEqual({
      a: { kind: "video", id: CLIP_A },
      b: { kind: "image", id: IMG_A },
      loop: true,
      autoPlay: true,
      audio: "a",
    });
  });

  it("v28 的「列表 + 选中」迁移成一个素材：取 picked、没选取第一条、`kind` 记视频", () => {
    const raw = {
      formatVersion: 28,
      objects: [
        {
          ...textureObject(),
          components: [
            featureComponent("tex-1", DEFAULT_SLOT_COMPONENT.videoBlend, {
              a: { clips: [CLIP_A, CLIP_B], picked: CLIP_B },
              b: { clips: [CLIP_C] },
              loop: true,
              audio: "a",
            }),
          ],
        },
      ],
    };

    const loaded = parseSceneFile(raw);
    expect(loaded.needsRewrite).toBe(true);
    expect(blendOf(loaded.file)).toEqual({
      a: { kind: "video", id: CLIP_B },
      b: { kind: "video", id: CLIP_C },
      loop: true,
      autoPlay: false,
      audio: "a",
    });

    // 再读一次不再回写（自描述）
    expect(parseSceneFile(loaded.file).needsRewrite).toBe(false);
  });

  it("与「视频」并存是 **error**（二者互斥；读取不拦）", () => {
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
            a: { kind: "video", id: CLIP_A },
            b: { kind: "image" },
            loop: false,
            audio: "none",
          }),
        ],
      },
    ]);

    const issues = validateScene(scene);
    expect(issues.find((issue) => /同时挂了「视频」与「视频混合」/.test(issue.message))?.level).toBe(
      "error",
    );
  });
});

describe("视频混合：与「视频」互斥", () => {
  it("挂了视频就加不上视频混合（准入层直接拒绝，无变更）", () => {
    const withVideo = mutate(sceneWith([textureObject()]), (draft) => {
      setVideoEnabled(draft, "tex-1", true);
    });
    expect(videoDataOf(withVideo.objects[0]!)).toBeDefined();

    const blocked = mutate(withVideo, (draft) => {
      expect(addObjectVideoBlend(draft, "tex-1")).toBe(false);
      expect(addObjectComponent(draft, "tex-1", "VideoBlend")).toBe(false);
    });
    expect(blocked).toBe(withVideo);
    expect(videoBlendDataOf(blocked.objects[0]!)).toBeUndefined();
  });

  it("挂了视频混合就加不上视频（准入层直接拒绝，无变更）", () => {
    const blended = mutate(sceneWith([textureObject()]), (draft) => {
      addObjectVideoBlend(draft, "tex-1");
    });

    const blocked = mutate(blended, (draft) => {
      expect(setVideoEnabled(draft, "tex-1", true)).toBe(false);
      expect(addObjectComponent(draft, "tex-1", "VideoOverlay")).toBe(false);
    });
    expect(blocked).toBe(blended);
    expect(videoDataOf(blocked.objects[0]!)).toBeUndefined();
  });

  it("摘掉一个之后另一个就加得上（互斥不是单向锁）", () => {
    const withVideo = mutate(sceneWith([textureObject()]), (draft) => {
      setVideoEnabled(draft, "tex-1", true);
    });
    const removed = mutate(withVideo, (draft) => {
      removeObjectComponent(draft, "tex-1", "VideoOverlay");
    });
    const blended = mutate(removed, (draft) => {
      expect(addObjectVideoBlend(draft, "tex-1")).toBe(true);
    });
    expect(videoBlendDataOf(blended.objects[0]!)).toBeDefined();
  });
});

describe("视频混合：场景文件里存素材 GUID", () => {
  it("两路的素材 ID 都按 guid ↔ id 换算（视频与图片同一路）", () => {
    const guidVideo = "a".repeat(32);
    const guidImage = "b".repeat(32);
    const metas = createAssetMetas([
      { id: CLIP_A, meta: { formatVersion: ASSET_META_FORMAT_VERSION, guid: guidVideo, importer: "video" } },
      { id: IMG_A, meta: { formatVersion: ASSET_META_FORMAT_VERSION, guid: guidImage, importer: "texture" } },
    ]);

    const scene = mutate(blendedTexture(), (draft) => {
      setVideoBlendChannelId(draft, "tex-1", "a", CLIP_A);
      setVideoBlendChannelKind(draft, "tex-1", "b", "image");
      setVideoBlendChannelId(draft, "tex-1", "b", IMG_A);
    });

    const persisted = sceneAssetRefsToGuids(scene, metas);
    expect(blendOf(persisted)?.a).toEqual({ kind: "video", id: guidVideo });
    expect(blendOf(persisted)?.b).toEqual({ kind: "image", id: guidImage });

    const restored = sceneAssetRefsToIds(persisted, metas);
    expect(blendOf(restored)?.a).toEqual({ kind: "video", id: CLIP_A });
    expect(blendOf(restored)?.b).toEqual({ kind: "image", id: IMG_A });
  });
});
