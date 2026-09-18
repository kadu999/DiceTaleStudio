import { createId } from "./commands";
import {
  DOCUMENT_FORMAT_VERSION,
  type GridSpec,
  type ImageRef,
  type MapDataDoc,
  type ProjectDoc,
  type SceneDoc,
  type SceneFileDoc,
  type SceneObjectDoc,
  type WorldPosition,
} from "./types";

/**
 * 文档工厂。
 *
 * 注意：`image.id` 是**资源逻辑 ID**（由调用方经 `@dts/resources` 的同名约定生成），
 * `document` 包不依赖 `resources` 包，因此不在这里拼装 ID。
 */

/** 新建场景文件内容：**空场景**，且不含场景名（名字就是文件名）。 */
export function createEmptySceneFile(): SceneFileDoc {
  return {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: [],
  };
}

/** 新建内存场景：场景名 = 将来的文件名，所以这里只带名字，不生成 id。 */
export function createEmptyScene(name: string): SceneDoc {
  return {
    name,
    objects: [],
  };
}

/** 新建地图对象：携带贴图与网格（整张空白格）。 */
export function createMapObject(input: {
  readonly name: string;
  readonly image: ImageRef;
  readonly grid: GridSpec;
  readonly id?: string;
  /** 地图中心的世界坐标；不传就是世界原点。 */
  readonly position?: WorldPosition;
}): SceneObjectDoc {
  const map: MapDataDoc = {
    image: input.image,
    grid: { ...input.grid },
    rowOrder: "bottom-up",
    // 显式写出「整张图都是空格子」，而不是留空数组：
    // 校验时 runs 的展开格数必须等于 width*height，留空会被判为数据不完整。
    cells: { encoding: "rle", runs: [[0, input.grid.width * input.grid.height]] },
  };

  return {
    id: input.id ?? createId("map"),
    name: input.name,
    kind: "Map",
    position: input.position ?? { x: 0, y: 0 },
    rotation: 0,
    components: [],
    map,
  };
}

/** 新建工程文件内容：只有项目级数据，场景由调用方在 `Assets/scenes/` 下各自建文件。 */
export function createEmptyProject(name = "未命名项目"): ProjectDoc {
  return {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    name,
    items: {
      source: "item.xlsx",
      updatedAt: new Date().toISOString().slice(0, 10),
      count: 0,
      items: [],
    },
  };
}
