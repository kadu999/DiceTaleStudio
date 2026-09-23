import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  createGameObject,
  setVideoAudio,
  setVideoAutoPlay,
  setVideoClipName,
  setVideoClips,
  setVideoEnabled,
  setVideoLoop,
  setVideoPicked,
} from "../src/commands";
import { isVideoEnabled, videoDataOf } from "../src/access";
import { featureComponent } from "../src/components";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import {
  DEFAULT_VIDEO_AUDIO,
  DEFAULT_VIDEO_AUTO_PLAY,
  DEFAULT_VIDEO_ENABLED,
  DEFAULT_VIDEO_LOOP,
  supportsVideo,
} from "../src/presets";
import { createEmptyScene, createMapObject, createSoundObject } from "../src/factory";
import { parseSceneFile } from "../src/schema";
import { formatIssues, hasErrors, validateScene } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type SceneDoc, type GameObjectDoc } from "../src/types";

/**
 * 地图 / 精灵上的**视频列表**（v14 起）：一组视频 + 选中哪条 + 循环 / 声音两个开关。
 *
 * 它与「声音对象」是**两个不同的东西**，别混：
 * - 声音是单独一种动作对象（`kind: "PlaySound"`），带层级、能同时响好几条；
 * - 视频挂在**对象自己身上**（v21 起只有地图与**贴图**能带，精灵不行），画面盖在那个对象的
 *   矩形上，每个对象各自一条、互不影响。
 *
 * 一条贯穿全篇的规矩（照抄声音那套）：**名字（`names`）与选中的那条（`picked`）都挂在
 * 「加进来的视频」上**，所以列表一变，这两样跟着走；而 `loop` / `audio` 是**对象自己的设置**，
 * 列表清空也不该被抹掉。
 */

const CLIP_A = "project:C/Assets/video/opening.mp4";
const CLIP_B = "project:C/Assets/video/rain.webm";

const IMAGE = { id: "project:C/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

function objectOf(scene: SceneDoc, id: string): GameObjectDoc | undefined {
  return scene.objects.find((object) => object.id === id);
}

/** 这个对象的视频开关（`isVideoEnabled` 的断言包装；对象不在就抛，免得在 undefined 上空转）。 */
function videoEnabled(scene: SceneDoc, id: string): boolean {
  const object = objectOf(scene, id);
  if (object === undefined) {
    throw new Error(`场景里没有这个对象：${id}`);
  }

  return isVideoEnabled(object);
}

/** 一张地图（视频的合法宿主之一）。 */
function mapObject(id = "map-1"): GameObjectDoc {
  return createMapObject({ id, name: "网格地图", image: IMAGE, grid: GRID });
}

/** 一张贴图（另一个合法宿主，v21 起取代精灵）。 */
function textureObject(id = "tex-1"): GameObjectDoc {
  return createGameObject({ id, name: "贴图", kind: "Image" });
}

/** 一个精灵（**不再是**视频宿主：它的渲染选项归「渲染」那一组）。 */
function spriteObject(id = "sprite-1"): GameObjectDoc {
  return createGameObject({ id, name: "精灵" });
}

describe("视频：哪些对象能带", () => {
  it("只有地图与贴图能放视频；精灵与动作对象不行", () => {
    expect(supportsVideo("Map")).toBe(true);
    expect(supportsVideo("Image")).toBe(true);
    expect(supportsVideo("Sprite")).toBe(false);
    expect(supportsVideo("PlaySound")).toBe(false);
    expect(supportsVideo("Teleport")).toBe(false);
    expect(supportsVideo("Player")).toBe(false);
  });

  it("两个开关的默认值：开着、不循环、静音", () => {
    expect(DEFAULT_VIDEO_ENABLED).toBe(true);
    expect(DEFAULT_VIDEO_AUTO_PLAY).toBe(false);
    expect(DEFAULT_VIDEO_LOOP).toBe(false);
    expect(DEFAULT_VIDEO_AUDIO).toBe(false);
  });

  it("autoplay setting defaults off and can be enabled", () => {
    const scene = sceneWith([mapObject()]);
    const withClip = mutate(scene, (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A]);
    });
    const autoplay = mutate(withClip, (draft) => {
      expect(setVideoAutoPlay(draft, "map-1", true)).toBe(true);
    });
    expect(videoDataOf(objectOf(autoplay, "map-1")!)?.autoPlay).toBe(true);

    const parsed = parseSceneFile({
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          ...mapObject(),
          components: [featureComponent("map-1", DEFAULT_SLOT_COMPONENT.video, { clips: [CLIP_A] })],
        },
      ],
    });
    expect(videoDataOf(parsed.file.objects[0]!)?.autoPlay).toBe(false);
  });

  it("非地图 / 贴图对象上的视频命令一律不生效（返回 false，也不补字段）", () => {
    const scene = sceneWith([createSoundObject({ name: "脚步", id: "s1" })]);

    expect(
      mutate(scene, (draft) => {
        expect(setVideoClips(draft, "s1", [CLIP_A])).toBe(false);
        expect(setVideoEnabled(draft, "s1", true)).toBe(false);
        expect(setVideoLoop(draft, "s1", true)).toBe(false);
        expect(setVideoAudio(draft, "s1", true)).toBe(false);
        expect(setVideoPicked(draft, "s1", CLIP_A)).toBe(false);
        expect(setVideoClipName(draft, "s1", CLIP_A, "开场")).toBe(false);
      }),
    ).toBe(scene);
  });
});

describe("视频命令：列表", () => {
  it("setVideoClips：去空、去重，其余按传入顺序；没选过就默认选第一条", () => {
    const scene = mutate(sceneWith([mapObject()]), (draft) => {
      expect(setVideoClips(draft, "map-1", [CLIP_A, "  ", CLIP_B, CLIP_A])).toBe(true);
    });

    expect(videoDataOf(objectOf(scene, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP_A, CLIP_B],
      picked: CLIP_A,
      loop: false,
      audio: false,
    });
  });

  it("列表清空**不删字段**：循环 / 声音是对象自己的设置，还得留着", () => {
    const start = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A]);
      setVideoLoop(draft, "map-1", true);
      setVideoAudio(draft, "map-1", true);
    });

    const cleared = mutate(start, (draft) => {
      expect(setVideoClips(draft, "map-1", [])).toBe(true);
    });

    expect(videoDataOf(objectOf(cleared, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [],
      loop: true,
      audio: true,
    });
    // 选中的那条跟着列表走：一条都没有了就不留 `picked`
    expect(videoDataOf(objectOf(cleared, "map-1")!)?.picked).toBeUndefined();
  });

  it("setVideoClips 把移出去的视频一起收拾掉：名字不留，选中的那条顺到下一条", () => {
    const start = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A, CLIP_B]);
      setVideoClipName(draft, "map-1", CLIP_A, "开场");
      setVideoClipName(draft, "map-1", CLIP_B, "下雨");
    });

    // 移出**选中的第一条**（CLIP_A）：顺到剩下的 CLIP_B，名字只清 A 那条
    const withoutA = mutate(start, (draft) => {
      setVideoClips(draft, "map-1", [CLIP_B]);
    });
    expect(videoDataOf(objectOf(withoutA, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP_B],
      picked: CLIP_B,
      names: { [CLIP_B]: "下雨" },
      loop: false,
      audio: false,
    });

    // 再移出最后一条：`names` 字段整个消失（不留空壳）
    const empty = mutate(withoutA, (draft) => {
      setVideoClips(draft, "map-1", []);
    });
    expect(videoDataOf(objectOf(empty, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [],
      loop: false,
      audio: false,
    });
  });

  it("同一个列表再写一次 = 没变更（不进撤销栈）", () => {
    const scene = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A, CLIP_B]);
    });

    expect(
      mutate(scene, (draft) => {
        setVideoClips(draft, "map-1", [CLIP_A, CLIP_B]);
      }),
    ).toBe(scene);
  });
});

describe("视频命令：选中与名字", () => {
  it("只能选加进来的那条；`null` 取消选中", () => {
    const scene = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A, CLIP_B]);
      expect(setVideoPicked(draft, "map-1", CLIP_B)).toBe(true);
    });
    expect(videoDataOf(objectOf(scene, "map-1")!)?.picked).toBe(CLIP_B);

    // 不在列表里的：直接拒掉，不悄悄把它加进去
    expect(
      mutate(scene, (draft) => {
        setVideoPicked(draft, "map-1", "project:C/Assets/video/ghost.mp4");
      }),
    ).toBe(scene);

    // 连点同一条：没变更
    expect(
      mutate(scene, (draft) => {
        setVideoPicked(draft, "map-1", CLIP_B);
      }),
    ).toBe(scene);

    const cleared = mutate(scene, (draft) => {
      expect(setVideoPicked(draft, "map-1", null)).toBe(true);
    });
    expect(videoDataOf(objectOf(cleared, "map-1")!)?.picked).toBeUndefined();

    // 取消一个本来就没选的 = 没变更
    expect(
      mutate(cleared, (draft) => {
        setVideoPicked(draft, "map-1", null);
      }),
    ).toBe(cleared);
  });

  it("名字按文件记；留空退回素材文件名，不在列表里的拒掉", () => {
    let scene = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A]);
    });

    scene = mutate(scene, (draft) => {
      expect(setVideoClipName(draft, "map-1", CLIP_A, "  开场动画  ")).toBe(true);
    });
    expect(videoDataOf(objectOf(scene, "map-1")!)?.names).toEqual({ [CLIP_A]: "开场动画" });

    // 不在列表里的文件：名字挂不上去
    expect(
      mutate(scene, (draft) => {
        setVideoClipName(draft, "map-1", CLIP_B, "别的");
      }),
    ).toBe(scene);

    // 留空 = 删掉这个名字（文件里不留空字符串，字段也不留空壳）
    const cleared = mutate(scene, (draft) => {
      expect(setVideoClipName(draft, "map-1", CLIP_A, "   ")).toBe(true);
    });
    expect(videoDataOf(objectOf(cleared, "map-1")!)?.names).toBeUndefined();
  });
});

describe("视频命令：循环与声音开关", () => {
  it("两个开关都写进文档；值没变返回 false", () => {
    const scene = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A]);
      expect(setVideoLoop(draft, "map-1", true)).toBe(true);
      expect(setVideoAudio(draft, "map-1", true)).toBe(true);
    });

    expect(videoDataOf(objectOf(scene, "map-1")!)?.loop).toBe(true);
    expect(videoDataOf(objectOf(scene, "map-1")!)?.audio).toBe(true);

    expect(
      mutate(scene, (draft) => {
        setVideoLoop(draft, "map-1", true);
        setVideoAudio(draft, "map-1", true);
      }),
    ).toBe(scene);
  });

  it("贴图与地图一样能带视频（两个宿主同一套）", () => {
    const scene = mutate(sceneWith([textureObject()]), (draft) => {
      setVideoClips(draft, "tex-1", [CLIP_A]);
      setVideoPicked(draft, "tex-1", CLIP_A);
    });

    expect(videoDataOf(objectOf(scene, "tex-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP_A],
      picked: CLIP_A,
      loop: false,
      audio: false,
    });
  });
});

describe("视频命令：总开关（启用）", () => {
  it("打开先写一份空列表；关掉时列表留着——一条都没有才把字段摘掉", () => {
    let scene = sceneWith([mapObject()]);
    expect(videoEnabled(scene, "map-1")).toBe(false);

    // 打开：开关状态本身也是要存的数据（否则下次打开项目又变回关着）
    scene = mutate(scene, (draft) => {
      expect(setVideoEnabled(draft, "map-1", true)).toBe(true);
    });
    expect(videoDataOf(objectOf(scene, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [],
      loop: false,
      audio: false,
    });
    expect(videoEnabled(scene, "map-1")).toBe(true);

    // 同一个状态再写一次 = 没变更（不进撤销栈）
    expect(
      mutate(scene, (draft) => {
        setVideoEnabled(draft, "map-1", true);
      }),
    ).toBe(scene);

    // 加视频 + 拨开关：开关原样不动
    scene = mutate(scene, (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A]);
      setVideoLoop(draft, "map-1", true);
    });
    expect(videoDataOf(objectOf(scene, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP_A],
      picked: CLIP_A,
      loop: true,
      audio: false,
    });

    // 关掉：**列表与开关都留着**（先关掉看看效果、再打开不该逼人重新加一遍）
    scene = mutate(scene, (draft) => {
      expect(setVideoEnabled(draft, "map-1", false)).toBe(true);
    });
    expect(videoDataOf(objectOf(scene, "map-1")!)).toEqual({
      enabled: false,
      autoPlay: false,
      clips: [CLIP_A],
      picked: CLIP_A,
      loop: true,
      audio: false,
    });
    expect(videoEnabled(scene, "map-1")).toBe(false);

    // 关着的时候照样能改列表（开关与内容是两件事）
    scene = mutate(scene, (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A, CLIP_B]);
    });
    expect(videoDataOf(objectOf(scene, "map-1")!)?.clips).toEqual([CLIP_A, CLIP_B]);

    // 关着且一条都没有：字段整个摘掉（与「从没开过」同义，不留空壳）
    const off = mutate(sceneWith([mapObject()]), (draft) => {
      setVideoEnabled(draft, "map-1", true);
      setVideoEnabled(draft, "map-1", false);
    });
    expect(videoDataOf(objectOf(off, "map-1")!)).toBeUndefined();

    // 关着一个本来就没开的 = 没变更
    const fresh = sceneWith([mapObject()]);
    expect(
      mutate(fresh, (draft) => {
        setVideoEnabled(draft, "map-1", false);
      }),
    ).toBe(fresh);
  });

  it("重新打开：列表 / 循环 / 声音都原样回来", () => {
    const scene = mutate(sceneWith([textureObject()]), (draft) => {
      setVideoClips(draft, "tex-1", [CLIP_B]);
      setVideoAudio(draft, "tex-1", true);
      setVideoEnabled(draft, "tex-1", false);
    });

    const reopened = mutate(scene, (draft) => {
      expect(setVideoEnabled(draft, "tex-1", true)).toBe(true);
    });

    expect(videoDataOf(objectOf(reopened, "tex-1")!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP_B],
      picked: CLIP_B,
      loop: false,
      audio: true,
    });
  });
});

describe("视频：文档校验", () => {
  it("非地图 / 贴图带 video：只报警告（字段会被忽略）", () => {
    const scene = mutate(sceneWith([createSoundObject({ name: "脚步", id: "s1" })]), (draft) => {
      // v19 起「带视频」= 挂着 VideoOverlay 组件（kind 不是地图 / 贴图时校验会提醒）
      draft.objects[0]?.components.push(
        featureComponent("s1", DEFAULT_SLOT_COMPONENT.video, {
          enabled: true,
          clips: [CLIP_A],
          picked: CLIP_A,
          loop: false,
          audio: false,
        }),
      );
    });

    expect(hasErrors(validateScene(scene))).toBe(false);
    expect(formatIssues(validateScene(scene))).toMatch(/只有地图与贴图能放视频/);
  });

  it("精灵身上的旧 video 组件：只报警告，组件数据不删（不静默改用户数据）", () => {
    const scene = mutate(sceneWith([spriteObject()]), (draft) => {
      draft.objects[0]?.components.push(
        featureComponent("sprite-1", DEFAULT_SLOT_COMPONENT.video, {
          enabled: true,
          clips: [CLIP_A],
          picked: CLIP_A,
          loop: false,
          audio: false,
        }),
      );
    });

    expect(hasErrors(validateScene(scene))).toBe(false);
    expect(formatIssues(validateScene(scene))).toMatch(/只有地图与贴图能放视频/);
    expect(scene.objects[0]?.components.some((item) => item.type === DEFAULT_SLOT_COMPONENT.video)).toBe(
      true,
    );
  });

  it("空条目 / 选中的不在列表 / 空名字 / 孤儿名字：各一条警告", () => {
    const scene = mutate(sceneWith([mapObject()]), (draft) => {
      draft.objects[0]?.components.push(
        featureComponent("map-1", DEFAULT_SLOT_COMPONENT.video, {
          enabled: true,
          clips: [CLIP_A, "  "],
          picked: "project:C/Assets/video/ghost.mp4",
          names: { [CLIP_A]: "  ", "project:C/Assets/video/ghost.mp4": "幽灵" },
          loop: false,
          audio: false,
        }),
      );
    });

    const issues = formatIssues(validateScene(scene));
    expect(hasErrors(validateScene(scene))).toBe(false);
    expect(issues).toMatch(/视频列表里有空条目/);
    expect(issues).toMatch(/选中的那条视频不在视频列表里/);
    expect(issues).toMatch(/视频名字是空的/);
    expect(issues).toMatch(/这条名字对应的视频不在视频列表里/);
  });

  it("干净的视频配置没有一句警告", () => {
    const scene = mutate(sceneWith([mapObject(), textureObject()]), (draft) => {
      setVideoClips(draft, "map-1", [CLIP_A]);
      setVideoClipName(draft, "map-1", CLIP_A, "开场");
      setVideoClips(draft, "tex-1", [CLIP_B]);
      setVideoLoop(draft, "tex-1", true);
      setVideoAudio(draft, "tex-1", true);
    });

    expect(formatIssues(validateScene(scene))).not.toMatch(/视频/);
  });
});

describe("视频：格式版本", () => {
  it("v13 的老文件读出来升到 v14 并要求回写一次（没有 video 字段也不补空壳）", () => {
    const object = mapObject();
    const load = parseSceneFile({ formatVersion: 13, objects: [object] });

    expect(load.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 没有 VideoOverlay 组件 = 这个对象不放视频（不补空壳）
    expect(videoDataOf(load.file.objects[0]!)).toBeUndefined();
    expect(load.needsRewrite).toBe(true);
  });

  it("手写的 video 少写 enabled / autoPlay / loop / audio：补兼容默认值", () => {
    const object = textureObject();
    const load = parseSceneFile({
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          ...object,
          components: [
            featureComponent("tex-1", DEFAULT_SLOT_COMPONENT.video, {
              clips: [CLIP_A],
              picked: CLIP_A,
            }),
          ],
        },
      ],
    });

    expect(videoDataOf(load.file.objects[0]!)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP_A],
      picked: CLIP_A,
      loop: false,
      audio: false,
    });
  });
});
