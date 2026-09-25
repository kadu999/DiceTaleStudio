import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { repairObjectComponent, setSoundClips, setSoundLayer, setSoundPicked } from "../src/commands";
import { imageOf, mapDataOf, soundDataOf } from "../src/access";
import { featureComponent } from "../src/components";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import { createEmptyScene, createSoundObject } from "../src/factory";
import { parseSceneFile } from "../src/schema";
import { formatIssues, hasErrors, validateScene } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  OBJECT_SOUND_LAYERS,
  SOUND_LAYERS,
  type SceneDoc,
  type GameObjectDoc,
} from "../src/types";

/**
 * 声音对象（弹框里「动作」种类下的**播放声音**）。
 *
 * 基础属性与实体完全同一套（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上画一枚
 * **固定的内置音频图标**（不给换贴图）；它自己那份数据只有「加进来的音频列表 + 选中的那条 +
 * 层级」。编辑器**不播放**、不碰音频解码，出声是前端的事。
 *
 * 一条贯穿全篇的规矩：**选中的那条（`picked`）挂在「加进来的音频」上**，
 * 所以列表一变它跟着走（选中的那条没了就顺到下一条）。
 * 显示名**不住在这里**：它跟着文件走（素材 `.meta` 顶层 `name`），场景里没有按对象记的名字。
 */

const CLIP_A = "project:C/Assets/audio/step1.mp3";
const CLIP_B = "project:C/Assets/audio/step2.mp3";

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

/** 手里的对象（命令都是按 id 找的）。 */
function objectOf(scene: SceneDoc, id: string): GameObjectDoc | undefined {
  return scene.objects.find((object) => object.id === id);
}

/** 场景文件里的原始 JSON 形状：v19 起声音数据住在 `PlaySound` 组件的 `data` 里。 */
function rawFile(sound: Record<string, unknown>): unknown {
  return {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: [
      {
        id: "s1",
        name: "脚步",
        kind: "PlaySound",
        active: true,
        sortingOrder: 0,
        locked: false,
        position: null,
        rotation: 0,
        scale: 1,
        components: [
          { id: "s1__PlaySound", type: DEFAULT_SLOT_COMPONENT.sound, data: sound, actions: [] },
        ],
      },
    ],
  };
}

describe("声音对象的工厂", () => {
  it("新建：kind = PlaySound，带（空的）音频列表与默认层级；不给落点就是未放置", () => {
    const sound = createSoundObject({ name: "脚步", id: "s1" });

    expect(sound.kind).toBe("PlaySound");
    expect(soundDataOf(sound)).toEqual({ clips: [], layer: "sfx" });
    expect(sound.position).toBeNull();
    // 和实体一样：没有地图数据、也没有默认贴图（画布上画内置的音频徽标）
    expect(imageOf(sound)).toBeUndefined();
    expect(mapDataOf(sound)).toBeUndefined();
    expect(sound.scale).toBe(1);
    expect(sound.locked).toBe(false);
  });

  it("可以带着音频列表、层级与世界坐标新建（它是世界里的对象；第一条就是选中的那条）", () => {
    const sound = createSoundObject({
      name: "酒馆 BGM",
      clips: [CLIP_A, CLIP_B],
      layer: "bgm",
      position: { x: -120, y: 80 },
    });

    expect(soundDataOf(sound)).toEqual({ clips: [CLIP_A, CLIP_B], picked: CLIP_A, layer: "bgm" });
    expect(sound.position).toEqual({ x: -120, y: 80 });
  });

  it("层级三档就是文档里允许的全部取值（v15 起：环境音已并进背景音乐）", () => {
    expect(SOUND_LAYERS).toEqual(["bgm", "sfx", "voice"]);
  });

  it("对象界面上只给音效 / 旁白：背景音乐已经改成项目级全局设置", () => {
    expect(OBJECT_SOUND_LAYERS).toEqual(["sfx", "voice"]);
  });
});

describe("声音对象的命令", () => {
  it("setSoundClips：去空、去重，其余按传入顺序（顺序就是加进来的先后）；没选过就默认选第一条", () => {
    const scene = mutate(sceneWith([createSoundObject({ name: "脚步", id: "s1" })]), (draft) => {
      expect(setSoundClips(draft, "s1", [CLIP_A, "  ", CLIP_B, CLIP_A])).toBe(true);
    });

    expect(soundDataOf(objectOf(scene, "s1")!)?.clips).toEqual([CLIP_A, CLIP_B]);
    // 加进来却没选中时面板上「播放」是灰的，很容易以为是坏的：兜底选第一条
    expect(soundDataOf(objectOf(scene, "s1")!)?.picked).toBe(CLIP_A);
  });

  it("setSoundClips 移出选中的那条：选中的顺到下一条", () => {
    const start = sceneWith([
      createSoundObject({ name: "雷雨", id: "s1", clips: [CLIP_A, CLIP_B] }),
    ]);

    // 移走选中的 A：选中顺到 B（还剩几条时不该「没得播」）
    const removed = mutate(start, (draft) => {
      expect(setSoundClips(draft, "s1", [CLIP_B])).toBe(true);
    });
    expect(soundDataOf(objectOf(removed, "s1")!)).toEqual({
      clips: [CLIP_B],
      picked: CLIP_B,
      layer: "sfx",
    });

    // 一条不剩：选中的那条删掉（不留空壳）
    const empty = mutate(removed, (draft) => {
      expect(setSoundClips(draft, "s1", [])).toBe(true);
    });
    expect(soundDataOf(objectOf(empty, "s1")!)).toEqual({ clips: [], layer: "sfx" });
  });

  it("setSoundPicked：只能选加进来的那几条；再点同一条 / 取消都不算变更", () => {
    const start = sceneWith([
      createSoundObject({ name: "脚步", id: "s1", clips: [CLIP_A, CLIP_B] }),
    ]);

    const switched = mutate(start, (draft) => {
      expect(setSoundPicked(draft, "s1", CLIP_B)).toBe(true);
      expect(setSoundPicked(draft, "s1", CLIP_B)).toBe(false);
      // 不在列表里的（还没加进来）：直接拒掉，不悄悄把它加进 clips
      expect(setSoundPicked(draft, "s1", "project:C/Assets/audio/别的.mp3")).toBe(false);
    });
    expect(soundDataOf(objectOf(switched, "s1")!)?.picked).toBe(CLIP_B);
    expect(soundDataOf(objectOf(switched, "s1")!)?.clips).toEqual([CLIP_A, CLIP_B]);

    const none = mutate(switched, (draft) => {
      expect(setSoundPicked(draft, "s1", null)).toBe(true);
      expect(setSoundPicked(draft, "s1", null)).toBe(false);
    });
    expect(soundDataOf(objectOf(none, "s1")!)?.picked).toBeUndefined();
  });

  it("setSoundClips / setSoundLayer：值没变就不算变更（历史不入栈）", () => {
    const scene = mutate(
      sceneWith([createSoundObject({ name: "脚步", id: "s1", clips: [CLIP_A], layer: "voice" })]),
      (draft) => {
        expect(setSoundClips(draft, "s1", [CLIP_A])).toBe(false);
        expect(setSoundLayer(draft, "s1", "voice")).toBe(false);
        expect(setSoundClips(draft, "不存在", [CLIP_A])).toBe(false);
        expect(setSoundPicked(draft, "不存在", CLIP_A)).toBe(false);
      },
    );

    expect(soundDataOf(objectOf(scene, "s1")!)).toEqual({ clips: [CLIP_A], picked: CLIP_A, layer: "voice" });
  });

  it("setSoundLayer：换成同一层不算变更、换成别的层才算", () => {
    const start = sceneWith([createSoundObject({ name: "脚步", id: "s1", layer: "sfx" })]);

    const same = mutate(start, (draft) => {
      expect(setSoundLayer(draft, "s1", "sfx")).toBe(false);
    });
    expect(soundDataOf(objectOf(same, "s1")!)?.layer).toBe("sfx");

    const changed = mutate(start, (draft) => {
      expect(setSoundLayer(draft, "s1", "bgm")).toBe(true);
    });
    expect(soundDataOf(objectOf(changed, "s1")!)?.layer).toBe("bgm");
  });

  it("普通对象挂不上声音数据（命令返回 false，不动文档）", () => {
    const door: GameObjectDoc = {
      id: "door",
      name: "木门",
      kind: "Sprite",
      active: true,
      sortingOrder: 0,
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
      locked: false,
      components: [],
    };

    const scene = mutate(sceneWith([door]), (draft) => {
      expect(setSoundClips(draft, "door", [CLIP_A])).toBe(false);
      expect(setSoundLayer(draft, "door", "bgm")).toBe(false);
      expect(setSoundPicked(draft, "door", CLIP_A)).toBe(false);
    });

    expect(soundDataOf(objectOf(scene, "door")!)).toBeUndefined();
  });

  it("缺声音组件时普通字段写入不补建；显式修复后可编辑", () => {
    // 只有 kind，没有 PlaySound 组件（schema 里组件是可选的，读得开——校验会报错提醒）
    const broken: GameObjectDoc = { ...createSoundObject({ name: "脚步", id: "s1" }), components: [] };

    const scene = mutate(sceneWith([broken]), (draft) => {
      expect(setSoundLayer(draft, "s1", "voice")).toBe(false);
    });

    expect(soundDataOf(objectOf(scene, "s1")!)).toBeUndefined();
    const repaired = mutate(scene, (draft) => {
      expect(repairObjectComponent(draft, "s1", "PlaySound")).toBe(true);
    });
    expect(soundDataOf(objectOf(repaired, "s1")!)).toEqual({ clips: [], layer: "sfx" });
    const edited = mutate(repaired, (draft) => {
      expect(setSoundLayer(draft, "s1", "voice")).toBe(true);
    });
    expect(soundDataOf(objectOf(edited, "s1")!)).toEqual({ clips: [], layer: "voice" });
  });
});

describe("声音对象的场景文件 schema", () => {
  it("读得回来（层级四档 + 音频列表）", () => {
    const parsed = parseSceneFile(rawFile({ clips: [CLIP_A, CLIP_B], layer: "bgm" }));

    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.file.objects[0]?.kind).toBe("PlaySound");
    // 文件里的声音数据住在 `PlaySound` 组件里，`data` 就是原来那份 `sound`
    expect(soundDataOf(parsed.file.objects[0]!)).toEqual({ clips: [CLIP_A, CLIP_B], layer: "bgm" });
  });

  it("选中的那条（picked）读得回来；没写就没有这个字段", () => {
    const picked = parseSceneFile(
      rawFile({ clips: [CLIP_A, CLIP_B], picked: CLIP_B, layer: "sfx" }),
    );
    expect(soundDataOf(picked.file.objects[0]!)?.picked).toBe(CLIP_B);

    const none = parseSceneFile(rawFile({ clips: [CLIP_A] }));
    expect(soundDataOf(none.file.objects[0]!)?.picked).toBeUndefined();
  });

  it("旧版按对象记的显示名表（names）随读随丢：不再进文档数据", () => {
    const legacy = parseSceneFile(
      rawFile({ clips: [CLIP_A], names: { [CLIP_A]: "雷雨·高" }, layer: "sfx" }),
    );
    expect(soundDataOf(legacy.file.objects[0]!)).toEqual({ clips: [CLIP_A], layer: "sfx" });

    const unnamed = parseSceneFile(rawFile({ clips: [CLIP_A] }));
    expect(soundDataOf(unnamed.file.objects[0]!)).toEqual({ clips: [CLIP_A], layer: "sfx" });
  });

  it("少写一项时按默认值读（列表空、层级音效）", () => {
    const parsed = parseSceneFile(rawFile({ clips: [CLIP_A] }));
    expect(soundDataOf(parsed.file.objects[0]!)).toEqual({ clips: [CLIP_A], layer: "sfx" });

    const minimal = parseSceneFile(rawFile({}));
    expect(soundDataOf(minimal.file.objects[0]!)).toEqual({ clips: [], layer: "sfx" });
  });

  it("层级写了四档以外的值：拒绝读入（不静默改成默认）", () => {
    expect(() => parseSceneFile(rawFile({ clips: [CLIP_A], layer: "music" }))).toThrow(
      /场景文件校验失败/,
    );
  });
});

describe("声音对象的校验", () => {
  it("声音对象缺少声音数据 → 报错（它是个什么都不播的空壳）", () => {
    // 「缺少声音数据」在 v19 下 = 没有 `PlaySound` 组件（手写文件里可能整个组件都没有）
    const broken = { ...createSoundObject({ name: "脚步", id: "s1" }), components: [] };

    const issues = validateScene(sceneWith([broken]));
    expect(hasErrors(issues)).toBe(true);
    expect(formatIssues(issues)).toMatch(/缺少声音数据/);
  });

  it("声音对象正常（含空音频列表）时不报错——刚建出来就是这样", () => {
    expect(hasErrors(validateScene(sceneWith([createSoundObject({ name: "脚步", id: "s1" })])))).toBe(
      false,
    );
  });

  it("普通对象带声音数据 / 声音对象带贴图 → 各给一条警告", () => {
    // v19 起「带声音数据」= 挂着 PlaySound 组件（kind 不是 PlaySound 时校验会提醒）
    const door: GameObjectDoc = {
      id: "door",
      name: "木门",
      kind: "Sprite",
      active: true,
      sortingOrder: 0,
      position: null,
      rotation: 0,
      scale: 1,
      locked: false,
      components: [
        featureComponent("door", DEFAULT_SLOT_COMPONENT.sound, { clips: [CLIP_A], layer: "sfx" }),
      ],
    };
    // 声音对象画的是**固定的内置图标**，贴图组件没有意义（手写文件里可能挂着一个）
    const soundWithImage: GameObjectDoc = {
      ...createSoundObject({ name: "脚步", id: "s1", position: { x: 0, y: 0 } }),
      components: [
        featureComponent("s1", DEFAULT_SLOT_COMPONENT.sound, { clips: [], layer: "sfx" }),
        featureComponent("s1", DEFAULT_SLOT_COMPONENT.image, {
          id: "project:C/Assets/images/audio.png",
          width: 32,
          height: 32,
        }),
      ],
    };

    const issues = validateScene(sceneWith([door, soundWithImage]));
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).not.toMatch(/不应携带声音数据/);
    expect(formatIssues(issues)).toMatch(/声音对象用固定的内置图标（不允许改贴图）/);
  });

  it("选中的那条不在列表里 → 警告（手写文件才会这样）", () => {
    const stale: GameObjectDoc = {
      ...createSoundObject({ name: "脚步", id: "s1", clips: [CLIP_A] }),
      components: [
        featureComponent("s1", DEFAULT_SLOT_COMPONENT.sound, {
          clips: [CLIP_A],
          picked: CLIP_B,
          layer: "sfx",
        }),
      ],
    };

    const issues = validateScene(sceneWith([stale]));
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/选中的那条音频不在音频列表里/);
  });
});
