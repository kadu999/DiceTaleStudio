import { describe, expect, it } from "vitest";
import {
  OBJECT_KINDS,
  imageOf,
  mapDataOf,
  soundDataOf,
  teleportDataOf,
  type ObjectKind,
} from "@dts/document";
import { DEFAULT_MAP_IMAGE } from "../src/state/store-core";
import { createEditorGridMapObject, createGameObjectForKind } from "../src/state/game-object-factory";

const input = {
  project: "测试项目",
  sceneName: "场景1",
  name: "测试对象",
  position: { x: 24, y: -12 },
};

describe("场景对象工厂", () => {
  it("为每种对象类型提供工厂并保留请求的名称与位置", () => {
    for (const kind of OBJECT_KINDS) {
      const object = createGameObjectForKind(kind, input);
      expect(object.kind, kind).toBe(kind === "GameObject" ? "GameObject" : kind);
      expect(object.name, kind).toBe(input.name);
      expect(object.position, kind).toEqual(input.position);
    }
  });

  it("网格地图工厂按场景图片约定生成贴图与网格（v28：贴图在图片层）", () => {
    const object = createEditorGridMapObject({
      project: input.project,
      sceneName: input.sceneName,
      name: input.name,
      position: input.position,
    });

    expect(object.kind).toBe("Image");
    expect(imageOf(object)).toEqual({
      id: "project:测试项目/Assets/images/场景1.png",
      ...DEFAULT_MAP_IMAGE,
    });
    expect(mapDataOf(object)?.grid).toEqual({ width: 64, height: 36 });
  });

  it.each(["PlaySound", "Teleport"] as const)("%s 工厂保留专属组件", (kind: ObjectKind) => {
    const object = createGameObjectForKind(kind, input);

    if (kind === "PlaySound") {
      expect(soundDataOf(object)).toEqual({ clips: [], layer: "sfx" });
    } else {
      expect(teleportDataOf(object)).toEqual({ targets: [] });
    }
  });
});
