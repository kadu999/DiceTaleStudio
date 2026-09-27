import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  addMagnifierState,
  removeMagnifierState,
  repairObjectComponent,
  setMagnifierPicked,
  setMagnifierStateImage,
  setMagnifierStateText,
  setMagnifierStateTitle,
} from "../src/commands";
import {
  imageOf,
  magnifierDataOf,
  magnifierImageOf,
  magnifierStateIsEmpty,
  magnifierStateOf,
  mapDataOf,
  soundDataOf,
} from "../src/access";
import { featureComponent } from "../src/components";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import { createEmptyScene, createMagnifierObject } from "../src/factory";
import { ASSET_META_FORMAT_VERSION, createAssetMetas, type AssetMetaDoc } from "../src/asset-meta";
import { sceneAssetRefsToGuids, sceneAssetRefsToIds } from "../src/scene-asset-refs";
import { resolveSceneSprites } from "../src/sprites";
import { parseSceneFile } from "../src/schema";
import { formatIssues, hasErrors, validateScene } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  type ImageRef,
  type SceneDoc,
  type GameObjectDoc,
  type MagnifierState,
  type SpriteSheetDoc,
} from "../src/types";

/**
 * 放大镜（弹框里「动作」种类下的**放大镜**，v30 加；v31 起数据是**状态列表**）。
 *
 * 基础属性与实体完全同一套（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上画一枚
 * **固定的内置放大镜徽标**（不给换贴图）；它自己那份数据是「**状态列表 + 当前展示的那一个**」，
 * 每个状态 = 标题 + 图 + 文字（三项都可以没有），触发它 = 让**前端**弹一扇窗显示选中的那个状态
 * （开 / 关两条命令，换状态不是命令）。
 *
 * 这里钉的是**数据**这一侧，四条贯穿全篇的规矩：
 * 1. 一个状态的三项都可选，「空状态槽」是合法数据（「添加状态」先加的就是它）；
 * 2. 状态里那张图就是一份**图片引用**（`ImageRef`，可以取图集里的一格）——与贴图 / 精灵同一个形状；
 * 3. **选中是下标**（空状态槽没有 id 可用，位置才是身份）——移出一个要顺手调 `picked`；
 * 4. 存盘走 GUID、推送补 `spriteGrid`——与图片层完全同一条链（这里各钉一条）。
 */

const IMAGE_ID = "project:C/Assets/images/handout.png";
const IMAGE_GUID = "ab".repeat(16);
const OTHER_ID = "project:C/Assets/images/clue.png";
const OTHER_GUID = "cd".repeat(16);

function imageOf_(overrides: Partial<ImageRef> & { sprite?: { column: number; row: number } }): ImageRef {
  return { id: IMAGE_ID, width: 400, height: 300, ...overrides };
}

/** 一个「只有图」的状态（v30 那些老数据的形状，也是迁移之后的结果）。 */
function imageState(image: ImageRef): MagnifierState {
  return { image };
}

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

function objectOf(scene: SceneDoc, id: string): GameObjectDoc | undefined {
  return scene.objects.find((object) => object.id === id);
}

function dataOf(scene: SceneDoc, id = "m1") {
  return magnifierDataOf(objectOf(scene, id)!);
}

/** 原始 JSON：放大镜数据挂在 `components[]` 里（这个 kind 是 v30 新加的）。 */
function rawFile(data?: Record<string, unknown>, formatVersion = DOCUMENT_FORMAT_VERSION): unknown {
  return {
    formatVersion,
    objects: [
      {
        id: "m1",
        name: "放大镜",
        kind: "Magnifier",
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        active: true,
        locked: false,
        components:
          data === undefined
            ? []
            : [{ id: "m1__Magnifier", type: DEFAULT_SLOT_COMPONENT.magnifier, data }],
      },
    ],
  };
}

function metaWith(guid: string, sheet?: SpriteSheetDoc): AssetMetaDoc {
  return sheet === undefined
    ? { formatVersion: ASSET_META_FORMAT_VERSION, guid, importer: "texture" }
    : {
        formatVersion: ASSET_META_FORMAT_VERSION,
        guid,
        importer: "texture",
        sprite: { mode: "Multiple", sheet },
      };
}

describe("放大镜的工厂", () => {
  it("新建：kind = Magnifier，状态列表是空的（还没加）；不给落点就是未放置", () => {
    const magnifier = createMagnifierObject({ name: "放大镜", id: "m1" });

    expect(magnifier.kind).toBe("Magnifier");
    expect(magnifierDataOf(magnifier)).toEqual({ states: [] });
    expect(magnifier.position).toBeNull();
    // 和实体一样：没有地图数据、也没有默认贴图（画布上画内置的放大镜徽标）
    expect(imageOf(magnifier)).toBeUndefined();
    expect(mapDataOf(magnifier)).toBeUndefined();
    expect(soundDataOf(magnifier)).toBeUndefined();
    expect(magnifier.scale).toBe(1);
    expect(magnifier.locked).toBe(false);
    // v30 起放大镜数据就是它身上唯一的组件
    expect(magnifier.components.map((component) => component.type)).toEqual([
      DEFAULT_SLOT_COMPONENT.magnifier,
    ]);
  });

  it("可以带着状态与世界坐标新建；没指定展示哪一个就默认展示第一个", () => {
    const magnifier = createMagnifierObject({
      name: "线索放大镜",
      states: [imageState(imageOf_({})), imageState(imageOf_({ id: OTHER_ID, sprite: { column: 1, row: 0 } }))],
      position: { x: 120, y: -40 },
    });

    expect(magnifierDataOf(magnifier)).toEqual({
      states: [imageState(imageOf_({})), imageState(imageOf_({ id: OTHER_ID, sprite: { column: 1, row: 0 } }))],
      picked: 0,
    });
    expect(magnifier.position).toEqual({ x: 120, y: -40 });
  });

  it("也可以指定展示第几个（窗口下排状态槽上点出来的就是它）", () => {
    const magnifier = createMagnifierObject({
      name: "放大镜",
      states: [imageState(imageOf_({})), imageState(imageOf_({ id: OTHER_ID }))],
      picked: 1,
      id: "m1",
    });

    expect(magnifierDataOf(magnifier)?.picked).toBe(1);
  });

  it("状态可以只有标题或只有文字（三项都空也行）", () => {
    const magnifier = createMagnifierObject({
      name: "放大镜",
      states: [{ title: "线索一" }, { text: "这里什么也没有\n第二行" }, {}],
      id: "m1",
    });

    expect(magnifierDataOf(magnifier)?.states).toEqual([
      { title: "线索一" },
      { text: "这里什么也没有\n第二行" },
      {},
    ]);
  });
});

describe("addMagnifierState：末尾加一个空状态槽", () => {
  function empty(): SceneDoc {
    return sceneWith([createMagnifierObject({ name: "放大镜", id: "m1" })]);
  }

  it("第一个加进来就选中它（接着就要在上面那块区域里填它）", () => {
    const next = mutate(empty(), (draft) => {
      expect(addMagnifierState(draft, "m1")).toBe(true);
    });

    expect(dataOf(next)).toEqual({ states: [{}], picked: 0 });
  });

  it("再加一个：列表变长，选中**新加的那个**（刚加的就该是正在编辑的那个）", () => {
    let scene = mutate(empty(), (draft) => {
      addMagnifierState(draft, "m1");
    });
    scene = mutate(scene, (draft) => {
      setMagnifierStateTitle(draft, "m1", 0, "线索一");
    });

    const next = mutate(scene, (draft) => {
      expect(addMagnifierState(draft, "m1")).toBe(true);
    });

    expect(dataOf(next)).toEqual({ states: [{ title: "线索一" }, {}], picked: 1 });
  });

  it("缺放大镜组件时加不进去（不补建）；显式修复后可编辑", () => {
    const broken: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m1" }),
      components: [],
    };

    const next = mutate(sceneWith([broken]), (draft) => {
      expect(addMagnifierState(draft, "m1")).toBe(false);
    });
    expect(dataOf(next)).toBeUndefined();

    const repaired = mutate(next, (draft) => {
      expect(repairObjectComponent(draft, "m1", "Magnifier")).toBe(true);
    });
    expect(dataOf(repaired)).toEqual({ states: [] });

    const edited = mutate(repaired, (draft) => {
      expect(addMagnifierState(draft, "m1")).toBe(true);
    });
    expect(dataOf(edited)?.states).toHaveLength(1);
  });
});

describe("removeMagnifierState：移出一个，并收拾「展示第几个」", () => {
  function withStates(): SceneDoc {
    return sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        states: [
          imageState(imageOf_({})),
          imageState(imageOf_({ id: OTHER_ID })),
          { title: "只有标题" },
        ],
        picked: 1,
      }),
    ]);
  }

  it("移出展示中的那个：留在同一个下标（后面那个补上来）", () => {
    const next = mutate(withStates(), (draft) => {
      expect(removeMagnifierState(draft, "m1", 1)).toBe(true);
    });

    expect(dataOf(next)).toEqual({
      states: [imageState(imageOf_({})), { title: "只有标题" }],
      picked: 1,
    });
  });

  it("移出的是最后一个、而它正被展示：退到新的最后一个", () => {
    const last = mutate(withStates(), (draft) => {
      setMagnifierPicked(draft, "m1", 2);
    });
    const next = mutate(last, (draft) => {
      expect(removeMagnifierState(draft, "m1", 2)).toBe(true);
    });

    expect(dataOf(next)?.picked).toBe(1);
  });

  it("移出的是**前面**的一个：下标跟着减一（还是同一个状态被展示）", () => {
    const next = mutate(withStates(), (draft) => {
      expect(removeMagnifierState(draft, "m1", 0)).toBe(true);
    });

    expect(dataOf(next)?.picked).toBe(0);
    expect(dataOf(next)?.states).toHaveLength(2);
  });

  it("一个不剩：`picked` 整个删掉（不留空壳）", () => {
    let scene = sceneWith([
      createMagnifierObject({ name: "放大镜", id: "m1", states: [imageState(imageOf_({}))] }),
    ]);
    scene = mutate(scene, (draft) => {
      expect(removeMagnifierState(draft, "m1", 0)).toBe(true);
    });

    expect(dataOf(scene)).toEqual({ states: [] });
  });

  it("越界 / 不是整数：无变更（不进撤销栈）", () => {
    const scene = withStates();
    for (const index of [-1, 3, 1.5]) {
      const next = mutate(scene, (draft) => {
        expect(removeMagnifierState(draft, "m1", index)).toBe(false);
      });
      expect(next).toBe(scene);
    }
  });
});

describe("setMagnifierPicked：换展示的那一个", () => {
  function withStates(): SceneDoc {
    return sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        states: [imageState(imageOf_({})), imageState(imageOf_({ id: OTHER_ID }))],
        picked: 0,
      }),
    ]);
  }

  it("换一个：写进文档；值没变就不算改动", () => {
    const next = mutate(withStates(), (draft) => {
      expect(setMagnifierPicked(draft, "m1", 1)).toBe(true);
    });
    expect(dataOf(next)?.picked).toBe(1);

    const same = mutate(next, (draft) => {
      expect(setMagnifierPicked(draft, "m1", 1)).toBe(false);
    });
    expect(same).toBe(next);
  });

  it("越界的下标直接拒掉（不悄悄夹到最后一个）", () => {
    const scene = withStates();
    for (const index of [-1, 2, 0.5]) {
      const next = mutate(scene, (draft) => {
        expect(setMagnifierPicked(draft, "m1", index)).toBe(false);
      });
      expect(next).toBe(scene);
    }
  });

  it("传 null = 取消选中（`picked` 删掉，状态留着）", () => {
    const next = mutate(withStates(), (draft) => {
      expect(setMagnifierPicked(draft, "m1", null)).toBe(true);
    });

    expect(dataOf(next)).toEqual({
      states: [imageState(imageOf_({})), imageState(imageOf_({ id: OTHER_ID }))],
    });

    const again = mutate(next, (draft) => {
      expect(setMagnifierPicked(draft, "m1", null)).toBe(false);
    });
    expect(again).toBe(next);
  });
});

describe("setMagnifierStateImage：给一个状态换图", () => {
  function withStates(): SceneDoc {
    return sceneWith([
      createMagnifierObject({ name: "放大镜", id: "m1", states: [{ title: "线索一" }, {}], picked: 0 }),
    ]);
  }

  it("给空状态槽挑一张图（含图集里的一格）：写进文档，标题 / 文字不动", () => {
    const next = mutate(withStates(), (draft) => {
      expect(setMagnifierStateImage(draft, "m1", 0, imageOf_({ sprite: { column: 1, row: 0 } }))).toBe(true);
    });

    expect(dataOf(next)?.states[0]).toEqual({
      title: "线索一",
      image: imageOf_({ sprite: { column: 1, row: 0 } }),
    });
  });

  it("格子取整 + 非负（界面上敲进来的小数不该原样落盘）", () => {
    const next = mutate(withStates(), (draft) => {
      setMagnifierStateImage(draft, "m1", 1, imageOf_({ sprite: { column: 1.6, row: -2 } }));
    });

    expect(dataOf(next)?.states[1]?.image?.sprite).toEqual({ column: 2, row: 0 });
  });

  it("换同一张图的同一个格子：无变更（挑图那条路每次都算出一份等价的引用）", () => {
    const scene = mutate(withStates(), (draft) => {
      setMagnifierStateImage(draft, "m1", 0, imageOf_({}));
    });

    const same = mutate(scene, (draft) => {
      expect(setMagnifierStateImage(draft, "m1", 0, imageOf_({}))).toBe(false);
    });
    expect(same).toBe(scene);

    // 声明尺寸不一样时算**变了**（重切图集之后挑出来的那一格尺寸会不同）
    const resized = mutate(scene, (draft) => {
      expect(setMagnifierStateImage(draft, "m1", 0, imageOf_({ width: 200, height: 150 }))).toBe(true);
    });
    expect(dataOf(resized)?.states[0]?.image?.width).toBe(200);
  });

  it("传 null = 清掉这个状态的图（它退回空状态槽），其余两项留着", () => {
    const scene = mutate(withStates(), (draft) => {
      setMagnifierStateImage(draft, "m1", 0, imageOf_({}));
    });

    const next = mutate(scene, (draft) => {
      expect(setMagnifierStateImage(draft, "m1", 0, null)).toBe(true);
    });
    expect(dataOf(next)?.states[0]).toEqual({ title: "线索一" });

    const again = mutate(next, (draft) => {
      expect(setMagnifierStateImage(draft, "m1", 0, null)).toBe(false);
    });
    expect(again).toBe(next);
  });

  it("下标越界 / 不是整数：无变更", () => {
    const scene = withStates();
    for (const index of [-1, 2, 0.5]) {
      const next = mutate(scene, (draft) => {
        expect(setMagnifierStateImage(draft, "m1", index, imageOf_({}))).toBe(false);
      });
      expect(next).toBe(scene);
    }
  });
});

describe("setMagnifierStateTitle / setMagnifierStateText：标题与文字", () => {
  function withStates(): SceneDoc {
    return sceneWith([createMagnifierObject({ name: "放大镜", id: "m1", states: [{}], picked: 0 })]);
  }

  it("标题与文字各自写进那一个状态（互不干扰）", () => {
    const next = mutate(withStates(), (draft) => {
      expect(setMagnifierStateTitle(draft, "m1", 0, "线索一")).toBe(true);
      expect(setMagnifierStateText(draft, "m1", 0, "第一行\n第二行")).toBe(true);
    });

    expect(dataOf(next)?.states[0]).toEqual({ title: "线索一", text: "第一行\n第二行" });
  });

  it("两头 trim，中间的换行原样留着", () => {
    const next = mutate(withStates(), (draft) => {
      setMagnifierStateTitle(draft, "m1", 0, "  线索一  ");
      setMagnifierStateText(draft, "m1", 0, "\n  第一行\n第二行  \n");
    });

    expect(dataOf(next)?.states[0]).toEqual({ title: "线索一", text: "第一行\n第二行" });
  });

  it("写空（或只有空白）= 删掉那个字段（「没写」与「写了空串」同义）", () => {
    const scene = mutate(withStates(), (draft) => {
      setMagnifierStateTitle(draft, "m1", 0, "线索一");
      setMagnifierStateText(draft, "m1", 0, "第一行");
    });

    const next = mutate(scene, (draft) => {
      expect(setMagnifierStateTitle(draft, "m1", 0, "   ")).toBe(true);
      expect(setMagnifierStateText(draft, "m1", 0, "")).toBe(true);
    });
    expect(dataOf(next)?.states[0]).toEqual({});

    // 本来就没有：再删一次不算改动
    const again = mutate(next, (draft) => {
      expect(setMagnifierStateTitle(draft, "m1", 0, "")).toBe(false);
      expect(setMagnifierStateText(draft, "m1", 0, " ")).toBe(false);
    });
    expect(again).toBe(next);
  });

  it("值没变：无变更（输入框失焦时不会往撤销栈里塞一条空的）", () => {
    const scene = mutate(withStates(), (draft) => {
      setMagnifierStateTitle(draft, "m1", 0, "线索一");
      setMagnifierStateText(draft, "m1", 0, "第一行");
    });

    const same = mutate(scene, (draft) => {
      expect(setMagnifierStateTitle(draft, "m1", 0, "线索一")).toBe(false);
      expect(setMagnifierStateText(draft, "m1", 0, "第一行")).toBe(false);
    });
    expect(same).toBe(scene);
  });

  it("下标越界 / 不是整数：无变更", () => {
    const scene = withStates();
    for (const index of [-1, 1, 0.5]) {
      const next = mutate(scene, (draft) => {
        expect(setMagnifierStateTitle(draft, "m1", index, "线索一")).toBe(false);
        expect(setMagnifierStateText(draft, "m1", index, "第一行")).toBe(false);
      });
      expect(next).toBe(scene);
    }
  });
});

describe("放大镜的读口", () => {
  const scene = sceneWith([
    createMagnifierObject({
      name: "放大镜",
      id: "m1",
      states: [{ title: "只有标题" }, imageState(imageOf_({})), {}],
      picked: 1,
    }),
  ]);

  it("`magnifierStateOf` 取当前展示的那个状态；越界 / 没选都是 undefined", () => {
    expect(magnifierStateOf(objectOf(scene, "m1")!)).toEqual(imageState(imageOf_({})));

    const unpicked = mutate(scene, (draft) => {
      setMagnifierPicked(draft, "m1", null);
    });
    expect(magnifierStateOf(objectOf(unpicked, "m1")!)).toBeUndefined();

    const stale: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m2" }),
      components: [
        featureComponent("m2", DEFAULT_SLOT_COMPONENT.magnifier, { states: [{}], picked: 3 }),
      ],
    };
    expect(magnifierStateOf(stale)).toBeUndefined();
  });

  it("`magnifierImageOf` 取那个状态里的图；那个状态还没图就是 undefined", () => {
    expect(magnifierImageOf(objectOf(scene, "m1")!)).toEqual(imageOf_({}));

    const pickedText = mutate(scene, (draft) => {
      setMagnifierPicked(draft, "m1", 0);
    });
    expect(magnifierImageOf(objectOf(pickedText, "m1")!)).toBeUndefined();
  });

  it("`magnifierStateIsEmpty`：三项都没有内容才算空（有图 / 有标题 / 有文字都不算）", () => {
    expect(magnifierStateIsEmpty(undefined)).toBe(true);
    expect(magnifierStateIsEmpty({})).toBe(true);
    expect(magnifierStateIsEmpty({ title: "" })).toBe(true);
    expect(magnifierStateIsEmpty({ text: " " })).toBe(false); // 空格也是内容（trim 是命令那边的事）
    expect(magnifierStateIsEmpty({ title: "线索一" })).toBe(false);
    expect(magnifierStateIsEmpty({ text: "只有文字" })).toBe(false);
    expect(magnifierStateIsEmpty(imageState(imageOf_({})))).toBe(false);
  });
});

describe("放大镜的解析、迁移与版本", () => {
  it("带状态与展示项能往返解析（三项都有、也有空状态槽）", () => {
    const states = [
      { title: "线索一", image: imageOf_({}), text: "第一行\n第二行" },
      {},
      { image: imageOf_({ id: OTHER_ID, sprite: { column: 1, row: 0 } }) },
    ];
    const parsed = parseSceneFile(rawFile({ states, picked: 2 }));

    expect(magnifierDataOf(parsed.file.objects[0]!)).toEqual({ states, picked: 2 });
  });

  it("`states` 不写就当成空列表（还没加状态），`picked` 不写就是还没选", () => {
    const parsed = parseSceneFile(rawFile({}));

    expect(magnifierDataOf(parsed.file.objects[0]!)).toEqual({ states: [] });
  });

  it("v30 的老文件：`images` 每一条搬成 `states[i].image`，`picked` 照旧是下标", () => {
    const parsed = parseSceneFile(
      rawFile(
        {
          images: [
            imageOf_({ guid: IMAGE_GUID }),
            imageOf_({ id: OTHER_ID, guid: OTHER_GUID, sprite: { column: 1, row: 0 } }),
          ],
          picked: 1,
        },
        30,
      ),
    );

    expect(magnifierDataOf(parsed.file.objects[0]!)).toEqual({
      states: [
        imageState(imageOf_({ guid: IMAGE_GUID })),
        imageState(imageOf_({ id: OTHER_ID, guid: OTHER_GUID, sprite: { column: 1, row: 0 } })),
      ],
      picked: 1,
    });
    // 迁移过就要求回写一次（磁盘上的文件重新变得自描述）
    expect(parsed.needsRewrite).toBe(true);
  });

  it("当前文档格式（v33 起放大镜一屏的媒体支持视频 + 动画）", () => {
    expect(DOCUMENT_FORMAT_VERSION).toBe(33);
  });

  it("`picked` 只收非负整数（小数 / 负数直接被 schema 拒掉）", () => {
    expect(() => parseSceneFile(rawFile({ states: [{}], picked: 0.5 }))).toThrow(/场景文件校验失败/);
    expect(() => parseSceneFile(rawFile({ states: [{}], picked: -1 }))).toThrow(/场景文件校验失败/);
  });

  it("状态里的图缺 `id` = 解析错误（那是引用，不是备注）", () => {
    expect(() => parseSceneFile(rawFile({ states: [{ image: { width: 10, height: 10 } }] }))).toThrow(
      /场景文件校验失败/,
    );
  });
});

describe("放大镜的校验", () => {
  it("缺状态数据（整个组件没有）= error", () => {
    const broken: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m1" }),
      components: [],
    };

    const issues = validateScene(sceneWith([broken]));
    expect(hasErrors(issues)).toBe(true);
    expect(formatIssues(issues)).toMatch(/缺少状态数据/);
  });

  it("还没加状态 = warning（新建出来就是这个状态，是合法的）", () => {
    const issues = validateScene(sceneWith([createMagnifierObject({ name: "放大镜", id: "m1" })]));

    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/还没有状态/);
  });

  it("有状态但没选 = warning；选中的下标越界也 = warning", () => {
    const unpicked: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m1" }),
      components: [
        featureComponent("m1", DEFAULT_SLOT_COMPONENT.magnifier, { states: [imageState(imageOf_({}))] }),
      ],
    };
    expect(formatIssues(validateScene(sceneWith([unpicked])))).toMatch(/还没选要展示哪一个状态/);

    const stale: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m2" }),
      components: [
        featureComponent("m2", DEFAULT_SLOT_COMPONENT.magnifier, {
          states: [imageState(imageOf_({}))],
          picked: 3,
        }),
      ],
    };
    expect(formatIssues(validateScene(sceneWith([stale])))).toMatch(/不在状态列表里/);
  });

  it("只有标题 / 文字的状态**不算问题**（纯文字线索卡放得出来）；三项全空才报「是空的」", () => {
    const textOnly = sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        states: [{ title: "只有标题" }, { text: "只有文字" }, imageState(imageOf_({}))],
        picked: 0,
      }),
    ]);
    expect(hasErrors(validateScene(textOnly))).toBe(false);
    expect(formatIssues(validateScene(textOnly))).not.toMatch(/是空的/);

    const pickedText = mutate(textOnly, (draft) => {
      setMagnifierPicked(draft, "m1", 1);
    });
    expect(formatIssues(validateScene(pickedText))).not.toMatch(/是空的/);

    // 三项全空（「添加状态」刚加出来、还没填）：这一条要提醒
    const emptyState = mutate(pickedText, (draft) => {
      addMagnifierState(draft, "m1");
    });
    expect(formatIssues(validateScene(emptyState))).toMatch(/是空的/);

    // 没选它就没有这条
    const pickedImage = mutate(emptyState, (draft) => {
      setMagnifierPicked(draft, "m1", 2);
    });
    const issues = validateScene(pickedImage);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).not.toMatch(/是空的/);
  });
});

describe("放大镜的存盘与推送", () => {
  function sceneWithStates(): SceneDoc {
    return sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        states: [
          { title: "线索一", image: { id: IMAGE_ID, guid: IMAGE_GUID, width: 400, height: 300 } },
          {
            image: { id: OTHER_ID, guid: OTHER_GUID, width: 100, height: 100, sprite: { column: 1, row: 0 } },
            text: "第一行",
          },
        ],
        picked: 1,
      }),
    ]);
  }

  it("存盘：每个状态里那张图的 id 都换算成 GUID（与图片层同一条链）", () => {
    const metas = createAssetMetas([
      { id: IMAGE_ID, meta: metaWith(IMAGE_GUID) },
      { id: OTHER_ID, meta: metaWith(OTHER_GUID) },
    ]);

    const stored = sceneAssetRefsToGuids(sceneWithStates(), metas);
    const states = dataOf(stored)?.states ?? [];

    expect(states.map((state) => state.image?.id)).toEqual([IMAGE_GUID, OTHER_GUID]);
    // 读回来又变回路径（guid 原样留着）
    const back = sceneAssetRefsToIds(stored, metas);
    expect(dataOf(back)?.states.map((state) => state.image?.id)).toEqual([IMAGE_ID, OTHER_ID]);
  });

  it("推送：格子补上 `spriteGrid`（几行几列），越界的夹到最后一格；没有图的状态原样留着", () => {
    const metas = createAssetMetas([
      { id: IMAGE_ID, meta: metaWith(IMAGE_GUID, { columns: 2, rows: 2 }) },
      { id: OTHER_ID, meta: metaWith(OTHER_GUID, { columns: 4, rows: 2 }) },
    ]);
    const scene = sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        states: [
          {
            title: "线索一",
            image: { id: IMAGE_ID, guid: IMAGE_GUID, width: 200, height: 150, sprite: { column: 1, row: 1 } },
          },
          // 越界（这一张只切了 4 列 2 行）：夹到最后一格
          { image: { id: OTHER_ID, guid: OTHER_GUID, width: 25, height: 50, sprite: { column: 9, row: 9 } } },
          { text: "只有文字" },
        ],
        picked: 0,
      }),
    ]);

    const payload = resolveSceneSprites(scene, metas);
    const states = dataOf(payload)?.states ?? [];
    const raw = states as unknown as Array<Record<string, unknown>>;

    // 载荷的 id 是路径 ID（guid 不下发），格子带「几行几列」
    expect(raw[0]).toEqual({
      title: "线索一",
      image: {
        id: IMAGE_ID,
        width: 200,
        height: 150,
        sprite: { column: 1, row: 1 },
        spriteGrid: { columns: 2, rows: 2 },
      },
    });
    expect(raw[1]).toMatchObject({
      image: {
        id: OTHER_ID,
        sprite: { column: 3, row: 1 },
        spriteGrid: { columns: 4, rows: 2 },
      },
    });
    // 没有图的状态（只有文字）原样留着
    expect(raw[2]).toEqual({ text: "只有文字" });
  });

  it("已经是载荷形状的列表原样返回（内容没变不重造对象）", () => {
    const metas = createAssetMetas([]);
    const scene = sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        states: [{ image: { id: IMAGE_ID, width: 400, height: 300 } }, {}],
        picked: 0,
      }),
    ]);

    expect(resolveSceneSprites(scene, metas)).toBe(scene);
  });
});
