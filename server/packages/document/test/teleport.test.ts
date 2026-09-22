import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { setTeleportPicked, setTeleportTargets } from "../src/commands";
import { imageOf, mapDataOf, soundDataOf, teleportDataOf } from "../src/access";
import { featureComponent } from "../src/components";
import { FEATURE_COMPONENT } from "../src/features";
import { createEmptyScene, createTeleportObject } from "../src/factory";
import { parseSceneFile } from "../src/schema";
import { formatIssues, hasErrors, validateScene } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  type SceneDoc,
  type SceneObjectDoc,
} from "../src/types";

/**
 * 传送阵（弹框里「动作」种类下的**传送阵**）。
 *
 * 基础属性与实体完全同一套（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上画一枚
 * **固定的内置徽标**（不给换贴图）；它自己那份数据与播放声音**同一个形状**：
 * 「**加进来的候选目标场景** + **选中的那一个**」。
 *
 * **触发它 = 切换当前场景**（编辑器 → 整份 `scene_push` → 前端换镜像），所以它
 * 不需要新协议命令；这里钉的是**数据**这一侧：清单怎么加 / 取、选中的那个怎么跟着走。
 *
 * 一条贯穿全篇的规矩（与声音完全一致）：**选中的那一个挂在「候选清单」上**——
 * 清单一变它跟着走；清单空了它整个消失，不留空壳。
 */

const A = "Map002";
const B = "Map003";

function sceneWith(objects: readonly SceneObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

function objectOf(scene: SceneDoc, id: string): SceneObjectDoc | undefined {
  return scene.objects.find((object) => object.id === id);
}

/**
 * v18 形状的原始 JSON：传送数据还挂在对象的扁平字段 `teleport` 上。
 *
 * 这是**迁移的输入**，所以保持扁平写法不变——`parseSceneFile` 会把它搬进
 * `Teleport` 组件的 `data`（断言一律走 `teleportDataOf`）。
 */
function rawFile(formatVersion: number, teleport?: Record<string, unknown>): unknown {
  return {
    formatVersion,
    objects: [
      {
        id: "t1",
        name: "传送阵",
        kind: "Teleport",
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        sortingOrder: 0,
        active: true,
        locked: false,
        components: [],
        ...(teleport === undefined ? {} : { teleport }),
      },
    ],
  };
}

describe("传送阵的工厂", () => {
  it("新建：kind = Teleport，候选是空的（还没勾场景）；不给落点就是未放置", () => {
    const teleport = createTeleportObject({ name: "传送阵", id: "t1" });

    expect(teleport.kind).toBe("Teleport");
    expect(teleportDataOf(teleport)).toEqual({ targets: [] });
    expect(teleport.position).toBeNull();
    // 和实体一样：没有地图数据、也没有默认贴图（画布上画内置的传送徽标）
    expect(imageOf(teleport)).toBeUndefined();
    expect(mapDataOf(teleport)).toBeUndefined();
    expect(soundDataOf(teleport)).toBeUndefined();
    expect(teleport.scale).toBe(1);
    expect(teleport.locked).toBe(false);
    // v19 起传送数据就是它身上唯一的组件
    expect(teleport.components.map((component) => component.type)).toEqual([
      FEATURE_COMPONENT.teleport,
    ]);
  });

  it("可以带着候选场景与世界坐标新建；没指定选哪个就默认选第一条", () => {
    const teleport = createTeleportObject({
      name: "地窖入口",
      targets: [A, B],
      position: { x: 120, y: -40 },
    });

    expect(teleportDataOf(teleport)).toEqual({ targets: [A, B], picked: A });
    expect(teleport.position).toEqual({ x: 120, y: -40 });
  });

  it("也可以指定选中的那一个（面板上点小方块选出来的就是它）", () => {
    const teleport = createTeleportObject({ name: "传送阵", targets: [A, B], picked: B, id: "t1" });

    expect(teleportDataOf(teleport)).toEqual({ targets: [A, B], picked: B });
  });
});

describe("setTeleportTargets：加 / 移候选场景", () => {
  it("加进来（去空白、去重、保持勾进来的顺序）", () => {
    const scene = sceneWith([createTeleportObject({ name: "传送阵", id: "t1" })]);
    const next = mutate(scene, (draft) => {
      expect(setTeleportTargets(draft, "t1", ["  Map002  ", "Map003", "Map002", ""])).toBe(true);
    });

    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [A, B], picked: A });
  });

  it("清单没变就不算改动（不进撤销栈）", () => {
    const scene = sceneWith([createTeleportObject({ name: "传送阵", id: "t1", targets: [A, B] })]);

    const changed = mutate(scene, (draft) => {
      expect(setTeleportTargets(draft, "t1", [A, B])).toBe(false);
    });

    expect(changed).toBe(scene);
  });

  it("移出去的正好是**选中的那一个**：顺到剩下的第一条", () => {
    const scene = sceneWith([
      createTeleportObject({ name: "传送阵", id: "t1", targets: [A, B], picked: A }),
    ]);

    const next = mutate(scene, (draft) => {
      expect(setTeleportTargets(draft, "t1", [B])).toBe(true);
    });

    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [B], picked: B });
  });

  it("一条都不剩：`picked` 整个删掉（不留空壳）", () => {
    const scene = sceneWith([createTeleportObject({ name: "传送阵", id: "t1", targets: [A, B] })]);

    const next = mutate(scene, (draft) => {
      expect(setTeleportTargets(draft, "t1", [])).toBe(true);
    });

    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [] });
  });

  it("手写文件里整个传送组件都没有时兜底补一份，而不是静默失败", () => {
    const broken: SceneObjectDoc = {
      ...createTeleportObject({ name: "传送阵", id: "t1" }),
      components: [],
    };

    const next = mutate(sceneWith([broken]), (draft) => {
      expect(setTeleportTargets(draft, "t1", [A])).toBe(true);
    });

    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [A], picked: A });
  });

  it("非传送阵对象：改不动（返回 false）", () => {
    const door: SceneObjectDoc = {
      ...createTeleportObject({ name: "木门", id: "d1" }),
      kind: "Sprite",
    };
    const scene = sceneWith([door]);

    mutate(scene, (draft) => {
      expect(setTeleportTargets(draft, "d1", [A])).toBe(false);
    });

    expect(teleportDataOf(objectOf(scene, "d1")!)).toEqual({ targets: [] });
  });
});

describe("setTeleportPicked：选「传送」送到哪一个", () => {
  function withTargets(): SceneDoc {
    return sceneWith([
      createTeleportObject({ name: "传送阵", id: "t1", targets: [A, B], picked: A }),
    ]);
  }

  it("只能选候选里的（不在清单里直接拒掉，不悄悄加进去）", () => {
    const scene = withTargets();

    const next = mutate(scene, (draft) => {
      expect(setTeleportPicked(draft, "t1", "Map999")).toBe(false);
    });

    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [A, B], picked: A });
  });

  it("选另一个候选：写进文档；值没变就不算改动", () => {
    const scene = withTargets();

    const next = mutate(scene, (draft) => {
      expect(setTeleportPicked(draft, "t1", B)).toBe(true);
    });
    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [A, B], picked: B });

    const same = mutate(next, (draft) => {
      expect(setTeleportPicked(draft, "t1", B)).toBe(false);
    });
    expect(same).toBe(next);
  });

  it("传 null = 取消选中（`picked` 删掉，候选留着）", () => {
    const next = mutate(withTargets(), (draft) => {
      expect(setTeleportPicked(draft, "t1", null)).toBe(true);
    });

    expect(teleportDataOf(objectOf(next, "t1")!)).toEqual({ targets: [A, B] });

    // 本来就没选：再取消一次不算改动
    const again = mutate(next, (draft) => {
      expect(setTeleportPicked(draft, "t1", null)).toBe(false);
    });
    expect(again).toBe(next);
  });
});

describe("传送阵的解析与版本", () => {
  it("`teleport` 是可选的：老文件（没有这个字段）照常解析", () => {
    const parsed = parseSceneFile({
      formatVersion: 11,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          position: null,
          rotation: 0,
          scale: 1,
          sortingOrder: 0,
          active: true,
          locked: false,
          components: [],
        },
      ],
    });

    expect(hasErrors(validateScene({ name: "Map001", objects: parsed.file.objects }))).toBe(false);
    // v11 的文件比当前版本旧 → 提示调用方回写一次
    expect(parsed.needsRewrite).toBe(true);
    expect(DOCUMENT_FORMAT_VERSION).toBeGreaterThan(11);
  });

  it("带候选与选中的传送阵能往返解析", () => {
    const parsed = parseSceneFile(rawFile(DOCUMENT_FORMAT_VERSION, { targets: [A, B], picked: B }));

    expect(teleportDataOf(parsed.file.objects[0]!)).toEqual({ targets: [A, B], picked: B });
  });

  it("`targets` 不写就当成空清单（还没加目标），`picked` 不写就是还没选", () => {
    const parsed = parseSceneFile(rawFile(DOCUMENT_FORMAT_VERSION, {}));

    expect(teleportDataOf(parsed.file.objects[0]!)).toEqual({ targets: [] });
  });

  it("中间那一版写下的「单目标」文件读得回来：搬进候选清单，并顺手选中它", () => {
    const parsed = parseSceneFile(rawFile(11, { target: A }));

    // 不搬的话 `target` 会被 schema 静默丢掉、变成「还没加目标」——文件里明明写着
    expect(teleportDataOf(parsed.file.objects[0]!)).toEqual({ targets: [A], picked: A });
    expect(parsed.needsRewrite).toBe(true);
  });

  it("已经有 `targets` 的就不动它（哪怕同一个对象里还留着 `target` 这种脏数据）", () => {
    const parsed = parseSceneFile(
      rawFile(DOCUMENT_FORMAT_VERSION, { targets: [A, B], picked: B, target: A }),
    );

    expect(teleportDataOf(parsed.file.objects[0]!)).toEqual({ targets: [A, B], picked: B });
  });

  it("没见过的 kind 仍然被枚举挡住（不是「什么都能塞」）", () => {
    expect(() =>
      parseSceneFile({
        formatVersion: DOCUMENT_FORMAT_VERSION,
        objects: [
          {
            id: "x",
            name: "?",
            kind: "Portal",
            position: null,
            rotation: 0,
            scale: 1,
            sortingOrder: 0,
            active: true,
            locked: false,
            components: [],
          },
        ],
      }),
    ).toThrow(/场景文件校验失败/);
  });
});

describe("传送阵的校验", () => {
  it("缺传送数据（整个 teleport 没有）= error", () => {
    // v19 下「缺传送数据」= 没有 `Teleport` 组件
    const broken: SceneObjectDoc = {
      ...createTeleportObject({ name: "传送阵", id: "t1" }),
      components: [],
    };

    const issues = validateScene(sceneWith([broken]));
    expect(hasErrors(issues)).toBe(true);
    expect(formatIssues(issues)).toMatch(/缺少传送数据/);
  });

  it("还没加目标 = warning（新建出来就是这个状态，是合法的）", () => {
    const issues = validateScene(sceneWith([createTeleportObject({ name: "传送阵", id: "t1" })]));

    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/还没加目标场景/);
  });

  it("有候选但没选 = warning；选中的不在候选里也 = warning", () => {
    const unpicked: SceneObjectDoc = {
      ...createTeleportObject({ name: "传送阵", id: "t1", targets: [A, B] }),
      components: [featureComponent("t1", FEATURE_COMPONENT.teleport, { targets: [A, B] })],
    };
    expect(formatIssues(validateScene(sceneWith([unpicked])))).toMatch(/还没选要传送到哪一张场景/);

    const stale: SceneObjectDoc = {
      ...createTeleportObject({ name: "传送阵", id: "t2", targets: [A] }),
      components: [featureComponent("t2", FEATURE_COMPONENT.teleport, { targets: [A], picked: B })],
    };
    expect(formatIssues(validateScene(sceneWith([stale])))).toMatch(/不在候选里/);
  });

  it("选中的就是自己所在的场景 = warning（按下去什么都不会发生）", () => {
    const self = createTeleportObject({ name: "传送阵", id: "t1", targets: ["Map001"], picked: "Map001" });
    expect(formatIssues(validateScene(sceneWith([self])))).toMatch(/目标就是它自己所在的场景/);

    // 候选里没有它自己：没有这条提醒
    const other = createTeleportObject({ name: "传送阵", id: "t2", targets: [A], picked: A });
    expect(formatIssues(validateScene(sceneWith([other])))).not.toMatch(/目标就是它自己/);
  });

  it("传送阵挂了贴图会被提醒（它画的是固定徽标）", () => {
    const withImage: SceneObjectDoc = {
      ...createTeleportObject({ name: "传送阵", id: "t1", targets: [A], picked: A }),
      components: [
        featureComponent("t1", FEATURE_COMPONENT.teleport, { targets: [A], picked: A }),
        featureComponent("t1", FEATURE_COMPONENT.image, {
          id: "project:C/Assets/images/a.png",
          width: 64,
          height: 64,
        }),
      ],
    };

    expect(formatIssues(validateScene(sceneWith([withImage])))).toMatch(/不允许改贴图/);
  });

  it("非传送阵对象带了传送数据会被提醒", () => {
    const door: SceneObjectDoc = {
      ...createTeleportObject({ name: "木门", id: "d1" }),
      kind: "Sprite",
      components: [featureComponent("d1", FEATURE_COMPONENT.teleport, { targets: [A] })],
    };

    expect(formatIssues(validateScene(sceneWith([door])))).toMatch(/不应携带传送数据/);
  });
});
