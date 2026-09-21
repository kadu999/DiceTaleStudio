import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { setBgmVolume, setSfxVolume, setVoiceVolume } from "../src/commands";
import { createEmptyProject, createEmptyScene, createSoundObject } from "../src/factory";
import {
  DEFAULT_BGM_VOLUME,
  DEFAULT_SFX_VOLUME,
  DEFAULT_VOICE_VOLUME,
  defaultProjectSettings,
  parseProjectDoc,
  parseProjectFile,
  parseSceneFile,
} from "../src/schema";
import { validateProject, validateScene } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  type ProjectDoc,
  type SceneDoc,
  type SceneObjectDoc,
} from "../src/types";

/**
 * **项目级音频设置**（v15 起）：三档音量（背景音乐 / 音效 / 旁白）。
 *
 * v16 起背景音乐在这一份设置里**只剩音量**——歌单 / 默认曲 / 名字 / 循环都从文档里拿掉了：
 * 曲目清单就是项目 `Assets/audio/` 下的音频，由编辑器顶栏「音乐」弹框列出来给 DM 点，
 * 点一首发一条 `play_bgm{clip}`。所以这里盯住四件事：
 * - 缺字段（老工程文件、手搭文档）读出来一律是一份可用的设置；
 * - v15 文件的歌单字段被**显式**迁走（只留音量），并标记回写；
 * - 三档音量是全局参数：进文档、越界夹回 `0..1`、校验只报 warning；
 * - 声音对象的层级里不再有背景音乐（老对象报一条指路警告）。
 */

const CLIP_A = "project:C/Assets/audio/theme.mp3";
const CLIP_B = "project:C/Assets/audio/battle.wav";

function projectWith(recipe: (draft: Draft<ProjectDoc>) => void): ProjectDoc {
  return produce(createEmptyProject("测试项目"), recipe);
}

function bgmOf(project: ProjectDoc): ProjectDoc["settings"]["audio"]["bgm"] {
  return project.settings.audio.bgm;
}

/** v15 形状的工程文件：背景音乐带着歌单 / 默认曲 / 名字 / 循环。 */
function legacyBgmFile(): Record<string, unknown> {
  return {
    formatVersion: 15,
    name: "测试项目",
    items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
    settings: {
      audio: {
        bgm: {
          clips: [CLIP_A, CLIP_B],
          picked: CLIP_A,
          names: { [CLIP_A]: "主题曲" },
          loop: false,
          volume: 0.25,
        },
        sfx: { volume: 0.5 },
        voice: { volume: 0.75 },
      },
    },
  };
}

describe("全局设置的缺省值", () => {
  it("新建项目就带一份可用的音频设置：三档音量有缺省", () => {
    const project = createEmptyProject("测试项目");

    expect(project.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(project.settings).toEqual({
      audio: {
        bgm: { volume: DEFAULT_BGM_VOLUME },
        sfx: { volume: DEFAULT_SFX_VOLUME },
        voice: { volume: DEFAULT_VOICE_VOLUME },
      },
    });
    expect(project.settings).toEqual(defaultProjectSettings());
  });

  it("老工程文件里没有 settings：读出来补一份，并要求回写（磁盘上从此自描述）", () => {
    const legacy = {
      formatVersion: 4,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
    };

    const load = parseProjectFile(legacy);

    expect(load.needsRewrite).toBe(true);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.doc.settings).toEqual(defaultProjectSettings());
  });

  it("当前版本的工程文件（v16 形状）：不要求回写，原样读回来", () => {
    const file = {
      ...createEmptyProject("测试项目"),
      settings: {
        audio: {
          bgm: { volume: 0.25 },
          sfx: { volume: 0.5 },
          voice: { volume: 0.75 },
        },
      },
    };

    const load = parseProjectFile(file);

    expect(load.needsRewrite).toBe(false);
    expect(bgmOf(load.doc)).toEqual({ volume: 0.25 });
    expect(load.doc.settings.audio.sfx).toEqual({ volume: 0.5 });
    expect(load.doc.settings.audio.voice).toEqual({ volume: 0.75 });
  });

  it("工程文件里的设置字段只写了一半（手写）：缺的用缺省补上", () => {
    const file = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.3 } } },
    };

    const doc = parseProjectDoc(file);

    expect(bgmOf(doc)).toEqual({ volume: 0.3 });
    expect(doc.settings.audio.sfx).toEqual({ volume: DEFAULT_SFX_VOLUME });
    expect(doc.settings.audio.voice).toEqual({ volume: DEFAULT_VOICE_VOLUME });
  });
});

describe("v16 迁移：背景音乐的歌单从工程文件里拿掉", () => {
  it("v15 文件带歌单 / 默认曲 / 名字 / 循环：读出来只剩音量，并要求回写", () => {
    const load = parseProjectFile(legacyBgmFile());

    expect(load.needsRewrite).toBe(true);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 只留音量：那四项不是「读丢了」，是这次迁移**故意**去掉的
    expect(bgmOf(load.doc)).toEqual({ volume: 0.25 });
    expect(load.doc.settings.audio.sfx).toEqual({ volume: 0.5 });
  });

  it("v15 文件只写了歌单没写音量：补上缺省音量，不回退成「没有设置」", () => {
    const file = legacyBgmFile();
    const settings = file.settings as { audio: { bgm: Record<string, unknown> } };
    delete settings.audio.bgm.volume;

    const load = parseProjectFile(file);

    expect(bgmOf(load.doc)).toEqual({ volume: DEFAULT_BGM_VOLUME });
    expect(load.needsRewrite).toBe(true);
  });

  it("盘上没有 settings 的 v15 文件：整份设置补默认值（与「有 settings 但缺 bgm」两条路都对）", () => {
    const file = legacyBgmFile();
    delete file.settings;

    const load = parseProjectFile(file);

    expect(load.doc.settings).toEqual(defaultProjectSettings());
    expect(load.needsRewrite).toBe(true);
  });
});

describe("三档音量", () => {
  it("写进文档；越界与非法值都夹进 0..1；值没变返回 false", () => {
    const project = projectWith((draft) => {
      expect(setBgmVolume(draft, 1.5)).toBe(true);
      expect(setSfxVolume(draft, -2)).toBe(true);
      expect(setVoiceVolume(draft, Number.POSITIVE_INFINITY)).toBe(true);
    });

    expect(bgmOf(project).volume).toBe(1);
    expect(project.settings.audio.sfx.volume).toBe(0);
    expect(project.settings.audio.voice.volume).toBe(0);

    const same = produce(project, (draft) => {
      expect(setBgmVolume(draft, 1)).toBe(false);
    });

    expect(same).toBe(project);
  });

  it("手搭的文档里连 settings 都没有：第一次改音量也补得出来", () => {
    const bare = { ...createEmptyProject("测试项目") } as ProjectDoc;
    delete (bare as { settings?: unknown }).settings;

    const fixed = produce(bare, (draft) => {
      expect(setVoiceVolume(draft, 0.5)).toBe(true);
    });

    expect(fixed.settings.audio.voice).toEqual({ volume: 0.5 });
    expect(bgmOf(fixed)).toEqual({ volume: DEFAULT_BGM_VOLUME });
  });
});

describe("校验", () => {
  it("工程设置：只有越界音量报 warning（bgm / sfx 各一条，合法的 voice 不报）", () => {
    const doc: ProjectDoc = {
      ...createEmptyProject("测试项目"),
      settings: {
        audio: {
          bgm: { volume: 2 },
          sfx: { volume: -1 },
          voice: { volume: 0.5 },
        },
      },
    };

    const issues = validateProject(doc);
    const paths = issues.map((issue) => issue.path);

    expect(paths).toContain("settings/audio/bgm/volume");
    expect(paths).toContain("settings/audio/sfx/volume");
    expect(paths).not.toContain("settings/audio/voice/volume");
    // 全是警告：不许因为这些把工程文件拦在门外
    expect(issues.every((issue) => issue.level === "warning")).toBe(true);
  });

  it("音量为 0 是合法的（静音一档），不报越界", () => {
    const doc = projectWith((draft) => {
      setBgmVolume(draft, 0);
    });

    expect(validateProject(doc).map((issue) => issue.path)).not.toContain("settings/audio/bgm/volume");
  });

  it("声音对象用了背景音乐层：报一条警告，指路到顶栏「音乐」弹框", () => {
    const scene: SceneDoc = {
      ...createEmptyScene("Map001"),
      objects: [
        {
          ...createSoundObject({ name: "酒馆 BGM", id: "s1", clips: [CLIP_A], layer: "bgm" }),
        } as SceneObjectDoc,
      ],
    };

    const issues = validateScene(scene);
    const layerIssue = issues.find(
      (issue) => issue.path === "scenes/Map001/objects/s1/sound/layer",
    );

    expect(layerIssue?.message).toContain("音乐");
    expect(layerIssue?.message).toContain("play_bgm");
  });

  it("音效 / 旁白对象不报这条警告（对象的两档是合法的）", () => {
    const scene: SceneDoc = {
      ...createEmptyScene("Map001"),
      objects: [createSoundObject({ name: "脚步", id: "s1", clips: [CLIP_A], layer: "voice" })],
    };

    expect(validateScene(scene).map((issue) => issue.path)).not.toContain(
      "scenes/Map001/objects/s1/sound/layer",
    );
  });
});

describe("场景格式 v15：环境音并进背景音乐", () => {
  function sceneFileWithLayer(layer: string): unknown {
    return {
      formatVersion: 14,
      objects: [
        {
          id: "s1",
          name: "雷雨",
          kind: "PlaySound",
          active: true,
          sortingOrder: 0,
          locked: false,
          position: null,
          rotation: 0,
          scale: 1,
          components: [],
          sound: { clips: [CLIP_A], layer },
        },
      ],
    };
  }

  it("layer: \"ambient\" → bgm，并要求回写一次", () => {
    const load = parseSceneFile(sceneFileWithLayer("ambient"));

    expect(load.file.objects[0]?.sound?.layer).toBe("bgm");
    expect(load.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.needsRewrite).toBe(true);
  });

  it("其它层级原样读回来（sfx / voice / 老文件里的 bgm）", () => {
    for (const layer of ["sfx", "voice", "bgm"] as const) {
      const load = parseSceneFile(sceneFileWithLayer(layer));
      expect(load.file.objects[0]?.sound?.layer).toBe(layer);
    }
  });

  it("已经删掉的第四档不再是合法值：写了别的 slug 直接读不开（不猜）", () => {
    expect(() => parseSceneFile(sceneFileWithLayer("music"))).toThrow(/层级|layer|invalid/i);
  });
});
