import { describe, expect, it, vi } from "vitest";
import { createMapObject, createGameObject, type SceneDoc } from "@dts/document";
import { serializeSceneFile } from "../src/state/editor-store";

/**
 * 场景文件的序列化（以及它**按引用缓存**这件事）。
 *
 * 拖手柄时每一帧都要拿序列化结果比对「有没有未保存的改动」（`dirtySceneNames`），
 * 所以没变过的场景不该被反复 `JSON.stringify`——一个项目里通常只有一个场景在变。
 * 缓存成立的唯一前提是「文档不可变、只有真改过的场景才换对象引用」：这条由 immer 保证。
 *
 * 字符串是原始值、只按值比较，所以「有没有真的重新序列化」要看 `JSON.stringify`
 * 被调了几次，而不是比较返回值。
 */

function scene(name: string): SceneDoc {
  const map = createMapObject({
    id: "map-1",
    name: "地图",
    image: { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 },
    grid: { width: 8, height: 6 },
  });
  const sprite = createGameObject({ id: "sprite-1", name: "精灵", position: { x: 10, y: 20 } });

  return { name, objects: [map, sprite] };
}

describe("serializeSceneFile：按场景对象引用缓存", () => {
  it("同一个引用连着算两次只序列化一次，结果内容相同", () => {
    const value = scene("Map001");
    const stringify = vi.spyOn(JSON, "stringify");

    const first = serializeSceneFile(value);
    const second = serializeSceneFile(value);

    expect(stringify).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    stringify.mockRestore();
  });

  it("换了引用（内容一样）会重算一次——缓存只看引用，不做深比较", () => {
    const stringify = vi.spyOn(JSON, "stringify");

    serializeSceneFile(scene("Map001"));
    serializeSceneFile(scene("Map001"));

    expect(stringify).toHaveBeenCalledTimes(2);
    stringify.mockRestore();
  });

  it("内容真的变了，文本跟着变（缓存不会把改动吃掉）", () => {
    const before = scene("Map001");
    const textBefore = serializeSceneFile(before);
    const changed: SceneDoc = {
      name: before.name,
      objects: before.objects.map((object) =>
        object.id === "sprite-1" ? { ...object, position: { x: 999, y: 20 } } : object,
      ),
    };

    const textAfter = serializeSceneFile(changed);
    expect(textAfter).not.toBe(textBefore);
    expect(textAfter).toContain("999");
  });
});
