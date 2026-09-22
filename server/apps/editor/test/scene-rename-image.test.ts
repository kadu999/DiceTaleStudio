import { describe, expect, it } from "vitest";
import {
  FEATURE_COMPONENT,
  SPRITE_COMPONENT,
  componentOf,
  createMapObject,
  createSceneObject,
  mapDataOf,
  withFeature,
  type SceneFileDoc,
  type SceneObjectDoc,
} from "@dts/document";
import { withRenamedSceneImage } from "../src/state/editor-store";

/**
 * 重命名场景时**贴图引用跟着走**。
 *
 * 场景贴图是按「与场景同名」的约定自动指向 `Assets/images/<场景名>.png` 的
 * （见 `projectSceneImageId`），所以场景一改名，那张贴图立刻就会找不到——
 * 除非把地图的贴图引用一起改指到新名字。
 *
 * 这条用例是**回归护栏**：v19 把贴图搬进 `GridMap` 组件之后，这段代码曾经还在往对象上写
 * 一个扁平的 `map` 字段——schema 会把它当未知键丢掉，于是「改名成功、贴图丢失」，
 * 而且类型检查抓不到（`Array.map` 的回调没有上下文返回类型，多余的键不报错）。
 */

const MAP_IMAGE = "project:测试/Assets/images/旧名.png";

function mapFile(): SceneObjectDoc {
  return createMapObject({
    id: "map-1",
    name: "地图",
    image: { id: MAP_IMAGE, width: 400, height: 300 },
    grid: { width: 8, height: 6 },
  });
}

function file(objects: readonly SceneObjectDoc[]): SceneFileDoc {
  return { formatVersion: 19, objects: [...objects] };
}

describe("重命名场景：同名贴图跟着改指", () => {
  it("地图的贴图指向旧场景名时，改指到新场景名（仍然住在一个 GridMap 组件里）", () => {
    const before = file([mapFile()]);

    const result = withRenamedSceneImage("测试", before, "旧名", "新名");

    expect(result.changed).toBe(1);
    const object = result.file.objects[0]!;
    expect(mapDataOf(object)?.image.id).toBe("project:测试/Assets/images/新名.png");
    // 关键：**没有留下一个扁平的 map 字段**（它会被 schema 丢掉，等于贴图丢了）
    expect((object as unknown as Record<string, unknown>).map).toBeUndefined();
    // 组件实例还是原来那一个（id 不变、只有 data 换了）
    expect(object.components).toHaveLength(1);
    expect(componentOf(object, FEATURE_COMPONENT.map)?.id).toBe("map-1__GridMap");
    // 网格数据一个字节都没动
    expect(mapDataOf(object)?.cells.runs).toEqual([[0, 48]]);
  });

  it("精灵的图片不动（那是用户明确挑的文件，哪怕它和场景同名）", () => {
    const sprite = withFeature(
      createSceneObject({ id: "sprite-1", name: "精灵" }),
      SPRITE_COMPONENT,
      { id: MAP_IMAGE, width: 100, height: 100 },
    );

    const result = withRenamedSceneImage("测试", file([sprite]), "旧名", "新名");

    expect(result.changed).toBe(0);
    expect(result.file.objects[0]).toBe(sprite);
  });

  it("地图用的是别的贴图（手工指定的）时不动它", () => {
    const handPicked = withFeature(mapFile(), FEATURE_COMPONENT.map, {
      ...mapDataOf(mapFile())!,
      image: { id: "project:测试/Assets/images/Bridge.png", width: 400, height: 300 },
    });

    const result = withRenamedSceneImage("测试", file([handPicked]), "旧名", "新名");

    expect(result.changed).toBe(0);
    expect(result.file.objects[0]).toBe(handPicked);
  });
});
