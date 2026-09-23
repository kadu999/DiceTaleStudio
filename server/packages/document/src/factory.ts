import {
  DEFAULT_OBJECT_SCALE,
  DEFAULT_SORTING_ORDER,
  MAP_DEFAULT_SORTING_ORDER,
  createId,
} from "./commands";
import { featureComponent } from "./components";
// 特性缺省值与缺省承载组件住在 `presets.ts`（那张表是「哪个 kind 允许哪个槽位」的唯一归属地）
import { DEFAULT_SLOT_COMPONENT, DEFAULT_SOUND_LAYER } from "./presets";
// 全局设置的缺省值住在 schema 里（那里也是「形状 + 默认值」的家）：新建工程与读老文件
// 补齐共用同一份，不会出现「新建的缺一样、读出来的缺另一样」
import { defaultProjectSettings } from "./schema";
import {
  DOCUMENT_FORMAT_VERSION,
  type GridSpec,
  type ImageRef,
  type MapDataDoc,
  type ProjectDoc,
  type SceneDoc,
  type SceneFileDoc,
  type GameObjectDoc,
  type SoundLayer,
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
}): GameObjectDoc {
  const id = input.id ?? createId("map");
  const map: MapDataDoc = {
    image: input.image,
    grid: { ...input.grid },
    rowOrder: "bottom-up",
    // 显式写出「整张图都是空格子」，而不是留空数组：
    // 校验时 runs 的展开格数必须等于 width*height，留空会被判为数据不完整。
    cells: { encoding: "rle", runs: [[0, input.grid.width * input.grid.height]] },
  };

  return {
    id,
    name: input.name,
    kind: "Map",
    // 地图默认是「垫在所有东西下面」的那一层，所以给一个负的显示顺序
    active: true,
    sortingOrder: MAP_DEFAULT_SORTING_ORDER,
    position: input.position ?? { x: 0, y: 0 },
    rotation: 0,
    scale: DEFAULT_OBJECT_SCALE,
    // 新建出来的对象都不锁：锁是「摆好之后别再被拖走」，不是默认状态
    locked: false,
    // 贴图与网格就是它的 `GridMap` 组件（v19 起）
    components: [featureComponent(id, DEFAULT_SLOT_COMPONENT.map, map)],
  };
}

/**
 * 新建**声音对象**（动作对象）：和实体一样摆在世界里，另带「候选音频列表 + 层级」。
 *
 * 位置 / 缩放 / 激活 / 锁定 / 显示顺序与实体完全同一套；**画布上的样子是固定的**：
 * 编辑器给它画一枚**内置音频图标**（不给换贴图，所以没有贴图组件），不然一个没有图的
 * 「播放声音」在场景里既看不见也点不到。
 * 新建时音频列表是空的（还没挑素材）——空列表 = 这条声音还不响；给了 `clips` 就把第一条
 * 当作已选中（点开面板就能直接播）。
 */
export function createSoundObject(input: {
  readonly name: string;
  readonly clips?: readonly string[];
  readonly layer?: SoundLayer;
  readonly id?: string;
  /** 对象中心的世界坐标；不传 = 未放置（与普通对象同一个口径，由调用方给落点）。 */
  readonly position?: WorldPosition | null;
}): GameObjectDoc {
  const id = input.id ?? createId("sound");
  const clips = [...(input.clips ?? [])];
  const picked = clips.length > 0 ? clips[0] : undefined;

  return {
    id,
    name: input.name,
    kind: "PlaySound",
    active: true,
    sortingOrder: DEFAULT_SORTING_ORDER,
    position: input.position ?? null,
    rotation: 0,
    scale: DEFAULT_OBJECT_SCALE,
    locked: false,
    components: [
      featureComponent(id, DEFAULT_SLOT_COMPONENT.sound, {
        clips,
        layer: input.layer ?? DEFAULT_SOUND_LAYER,
        ...(picked === undefined ? {} : { picked }),
      }),
    ],
  };
}

/**
 * 新建**传送阵**（动作对象）：和实体一样摆在世界里，另带「候选目标场景 + 选中的那一个」。
 *
 * 位置 / 缩放 / 激活 / 锁定 / 显示顺序与实体完全同一套；**画布上的样子是固定的**：
 * 编辑器给它画一枚**内置传送徽标**（不给换贴图，所以没有贴图组件），不然一个没有图的
 * 「传送阵」在场景里既看不见也点不到。
 *
 * 新建时候选是空的（还没勾场景）——「传送目标」窗口里勾几个，「传送」才点得动。
 * 给了 `targets` 就把第一条当作已选中（与 `createSoundObject` 同一个口径：点开面板就能用）。
 */
export function createTeleportObject(input: {
  readonly name: string;
  readonly targets?: readonly string[];
  readonly picked?: string;
  readonly id?: string;
  /** 对象中心的世界坐标；不传 = 未放置（与普通对象同一个口径，由调用方给落点）。 */
  readonly position?: WorldPosition | null;
}): GameObjectDoc {
  const id = input.id ?? createId("teleport");
  const targets = [...(input.targets ?? [])];
  const picked = input.picked ?? targets[0];

  return {
    id,
    name: input.name,
    kind: "Teleport",
    active: true,
    sortingOrder: DEFAULT_SORTING_ORDER,
    position: input.position ?? null,
    rotation: 0,
    scale: DEFAULT_OBJECT_SCALE,
    locked: false,
    components: [
      featureComponent(id, DEFAULT_SLOT_COMPONENT.teleport, {
        targets,
        ...(picked === undefined ? {} : { picked }),
      }),
    ],
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
    // v15 起：全局设置（音频）随工程文件一起建出来——歌单空、没有默认曲、三档音量用缺省值。
    // 用 schema 里那份默认值工厂，保证「新建」与「读老文件补齐」得到的是同一份形状。
    settings: defaultProjectSettings(),
  };
}
