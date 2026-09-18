import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { addObject, findScene, isSceneNameTaken, validateSceneName } from "../src/commands";
import { createEmptyScene, createMapObject } from "../src/factory";
import type { SceneDoc } from "../src/types";

/** 场景层命令：场景已各自成文件，这里只剩「按名字找 / 判重名 / 名校验」。 */

const IMAGE = { id: "project:C/Assets/images/Map001.png", width: 1920, height: 1080 };
const GRID = { width: 64, height: 36, cellSize: 1 };

function scene(name: string): SceneDoc {
  return createEmptyScene(name);
}

function mutate(sceneDoc: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(sceneDoc, recipe);
}

describe("场景名校验", () => {
  it("接受正常名字", () => {
    for (const name of ["Map001", "第一章 酒馆", "scene-1"]) {
      expect(validateSceneName(name)).toBeUndefined();
    }
  });

  it("拒绝空名、超长名与非法字符（场景名会直接成为文件名）", () => {
    expect(validateSceneName("")).toMatch(/不能为空/);
    expect(validateSceneName("   ")).toMatch(/不能为空/);
    expect(validateSceneName("x".repeat(65))).toMatch(/64/);
    for (const name of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateSceneName(name)).toMatch(/不能包含/);
    }
    expect(validateSceneName(".")).toMatch(/不合法/);
  });
});

describe("场景查找与重名判定", () => {
  it("按名字查场景（传送动作按场景名引用目标）", () => {
    const scenes = [scene("Map001"), scene("酒馆")];
    expect(findScene(scenes, "酒馆")?.name).toBe("酒馆");
    expect(findScene(scenes, " MAP001 ")?.name).toBe("Map001");
    expect(findScene(scenes, "不存在")).toBeUndefined();
  });

  it("同名判定大小写不敏感，且可排除自身（改名时不误判）", () => {
    const scenes = [scene("Map001"), scene("酒馆")];
    expect(isSceneNameTaken(scenes, "map001")).toBe(true);
    expect(isSceneNameTaken(scenes, "酒馆 ")).toBe(true);
    expect(isSceneNameTaken(scenes, "Map003")).toBe(false);
    expect(isSceneNameTaken(scenes, "Map001", "Map001")).toBe(false);
    expect(isSceneNameTaken(scenes, "map001", "Map001")).toBe(false);
    expect(isSceneNameTaken(scenes, "map001", "酒馆")).toBe(true);
  });
});

describe("场景内容命令", () => {
  it("新建场景是空场景：没有对象、也没有地图", () => {
    const first = scene("Map001");
    expect(first.name).toBe("Map001");
    expect(first.objects).toEqual([]);
  });

  it("对象可以独立于地图添加（地图只是场景里的一个对象）", () => {
    const result = mutate(scene("Map001"), (draft) => {
      addObject(draft, {
        id: "door",
        name: "木门",
        kind: "SceneObject",
        position: { x: 0.3, y: 0.4 },
        rotation: 0,
        components: [],
      });
    });

    expect(result.objects.map((object) => object.id)).toEqual(["door"]);
  });

  it("地图也可以后加进场景", () => {
    const result = mutate(scene("Map001"), (draft) => {
      addObject(draft, createMapObject({ name: "背景地图", image: IMAGE, grid: GRID, id: "m1" }));
    });

    expect(result.objects[0]?.kind).toBe("Map");
    expect(result.objects[0]?.map?.grid).toEqual(GRID);
  });
});
