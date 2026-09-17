import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  addObject,
  addScene,
  findSceneByName,
  isSceneNameTaken,
  removeScene,
  renameScene,
  validateSceneName,
} from "../src/commands";
import { createEmptyProject, createMapObject, createSceneDoc } from "../src/factory";
import type { ProjectDoc } from "../src/types";

/** 场景（= 跑团里的关卡容器）的文档层命令。 */

const IMAGE = { id: "campaign:C/images/maps/Map001.png", width: 1920, height: 1080 };
const GRID = { width: 64, height: 36, cellSize: 1 };

function scene(name: string, id = name) {
  return createSceneDoc({ id, name });
}

function mutate(doc: ProjectDoc, recipe: (draft: Draft<ProjectDoc>) => void): ProjectDoc {
  return produce(doc, recipe);
}

function projectWith(...names: string[]): ProjectDoc {
  const base = createEmptyProject("测试项目");
  return mutate(base, (draft) => {
    for (const name of names) {
      addScene(draft, scene(name));
    }
  });
}

describe("场景名校验", () => {
  it("接受正常名字", () => {
    for (const name of ["Map001", "第一章 酒馆", "scene-1"]) {
      expect(validateSceneName(name)).toBeUndefined();
    }
  });

  it("拒绝空名、超长名与非法字符", () => {
    expect(validateSceneName("")).toMatch(/不能为空/);
    expect(validateSceneName("   ")).toMatch(/不能为空/);
    expect(validateSceneName("x".repeat(65))).toMatch(/64/);
    for (const name of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateSceneName(name)).toMatch(/不能包含/);
    }
    expect(validateSceneName(".")).toMatch(/不合法/);
  });
});

describe("场景命令", () => {
  it("追加场景后顺序稳定", () => {
    const doc = projectWith("Map001", "Map002");
    expect(doc.scenes.map((item) => item.name)).toEqual(["Map001", "Map002"]);
  });

  it("删除场景", () => {
    const doc = projectWith("Map001", "Map002");
    const next = mutate(doc, (draft) => {
      removeScene(draft, "Map001");
    });
    expect(next.scenes.map((item) => item.name)).toEqual(["Map002"]);

    const again = mutate(next, (draft) => {
      removeScene(draft, "不存在");
    });
    expect(again.scenes).toHaveLength(1);
  });

  it("重命名场景", () => {
    const doc = projectWith("Map001");
    const next = mutate(doc, (draft) => {
      renameScene(draft, "Map001", "酒馆");
    });
    expect(next.scenes[0]?.name).toBe("酒馆");
  });

  it("同名判定大小写不敏感，且可排除自身（重命名时不误判）", () => {
    const doc = projectWith("Map001", "酒馆");
    expect(isSceneNameTaken(doc, "map001")).toBe(true);
    expect(isSceneNameTaken(doc, "酒馆 ")).toBe(true);
    expect(isSceneNameTaken(doc, "Map003")).toBe(false);
    expect(isSceneNameTaken(doc, "Map001", "Map001")).toBe(false);
  });

  it("按名字查场景（传送动作按场景名引用目标）", () => {
    const doc = projectWith("Map001", "酒馆");
    expect(findSceneByName(doc, "酒馆")?.id).toBe("酒馆");
    expect(findSceneByName(doc, " MAP001 ")?.name).toBe("Map001");
    expect(findSceneByName(doc, "不存在")).toBeUndefined();
  });

  it("新建场景是空场景：没有对象、没有地图，只有一个默认出生点", () => {
    const doc = projectWith("Map001");
    const first = doc.scenes[0];
    expect(first?.objects).toEqual([]);
    expect(first?.spawnPoints.map((spawn) => spawn.id)).toEqual(["Default"]);
  });

  it("对象可以独立于地图添加（地图只是场景里的一个对象）", () => {
    const doc = mutate(projectWith("Map001"), (draft) => {
      const target = draft.scenes[0];
      if (target !== undefined) {
        addObject(target, {
          id: "door",
          name: "木门",
          kind: "SceneObject",
          position: { x: 0.3, y: 0.4 },
          rotation: 0,
          components: [],
        });
      }
    });

    expect(doc.scenes[0]?.objects.map((object) => object.id)).toEqual(["door"]);
  });

  it("地图也可以后加进场景", () => {
    const doc = mutate(projectWith("Map001"), (draft) => {
      const target = draft.scenes[0];
      if (target !== undefined) {
        addObject(target, createMapObject({ name: "背景地图", image: IMAGE, grid: GRID, id: "m1" }));
      }
    });

    expect(doc.scenes[0]?.objects[0]?.kind).toBe("Map");
    expect(doc.scenes[0]?.objects[0]?.map?.grid).toEqual(GRID);
  });
});
