import { createId } from "./commands";
import {
  DOCUMENT_FORMAT_VERSION,
  type GridSpec,
  type ImageRef,
  type MapDataDoc,
  type ProjectDoc,
  type SceneDoc,
  type SceneObjectDoc,
} from "./types";

/**
 * 文档工厂。
 *
 * 注意：`image.id` 是**资源逻辑 ID**（由调用方经 `@dts/resources` 的同名约定生成），
 * `document` 包不依赖 `resources` 包，因此不在这里拼装 ID。
 */

/** 新建场景：**空场景**——对象由调用方按需添加（地图也只是其中一个对象）。 */
export function createSceneDoc(input: { readonly name: string; readonly id?: string }): SceneDoc {
  return {
    id: input.id ?? createId("scene"),
    name: input.name,
    objects: [],
    spawnPoints: [{ id: "Default", name: "默认", position: { x: 0.5, y: 0.5 } }],
  };
}

/** 新建地图对象：携带贴图与网格（整张空白格）。 */
export function createMapObject(input: {
  readonly name: string;
  readonly image: ImageRef;
  readonly grid: GridSpec;
  readonly id?: string;
  readonly cellSize?: number;
}): SceneObjectDoc {
  const map: MapDataDoc = {
    image: input.image,
    grid: { ...input.grid, cellSize: input.cellSize ?? input.grid.cellSize },
    rowOrder: "bottom-up",
    // 显式写出「整张图都是空格子」，而不是留空数组：
    // 校验时 runs 的展开格数必须等于 width*height，留空会被判为数据不完整。
    cells: { encoding: "rle", runs: [[0, input.grid.width * input.grid.height]] },
  };

  return {
    id: input.id ?? createId("map"),
    name: input.name,
    kind: "Map",
    position: null,
    rotation: 0,
    components: [],
    map,
  };
}

export function createEmptyProject(name = "未命名项目"): ProjectDoc {
  return {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    name,
    scenes: [],
    items: {
      source: "item.xlsx",
      updatedAt: new Date().toISOString().slice(0, 10),
      count: 0,
      items: [],
    },
  };
}
