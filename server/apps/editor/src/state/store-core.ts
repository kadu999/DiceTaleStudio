/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * React 之外的**模块级状态**与纯工具：三套历史、场景 / 工程文件序列化、视口适配、日志工厂。
 */
import {
  DOCUMENT_FORMAT_VERSION,
  DEFAULT_SLOT_COMPONENT,
  mapDataOf,
  withFeature,
  DocumentHistory,
  collapseScale,
  createEmptyProject,
  type ProjectDoc,
  type SceneDoc,
  type SceneFileDoc,
  type AssetMetas,
  sceneAssetRefsToGuids,
  type WorldPosition,
} from "@dts/document";
import { type ImageSize } from "@dts/grid";
import { projectSceneImageId } from "@dts/resources";
import { fitViewport, type TransformTool, type Viewport } from "@dts/renderer";
import { type RuntimeLogEntry } from "../services/runtime-client";
import { type ResourceTreeNode } from "../services/project-api";
import { readEditorPrefs } from "../services/editor-prefs";
import { sceneVisibleRects } from "../panels/scene/display";
import { type AssetMetaTable, type EditorUiState } from "./store-types";

/**
 * 平板（触控优先或窄屏）下默认收起左右面板，让场景铺满——
 * 三栏硬挤在平板竖屏上会把中间的场景压没。
 */
export function initialUi(): EditorUiState {
  const compact =
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 1024);
  const prefs = readEditorPrefs();

  return {
    leftOpen: !compact,
    rightOpen: !compact,
    runtimeOpen: false,
    tool: prefs.tool,
    bgmPaths: prefs.bgmPaths,
  };
}

/**
 * 场景编辑历史（React 之外持有；store 只订阅其变更）。
 *
 * 场景是独立文件、不进工程文件，所以历史挂在**场景列表**上：对象的新建 / 改名 /
 * 删除 / 移动都经 `applyScenes`，因此天然可撤销；撤销发生在哪个场景就改哪个场景。
 */
export const sceneHistory = new DocumentHistory<readonly SceneDoc[]>([], { limit: 200 });

/**
 * **工程文件**（`project.json`，v15 起才真的有可编辑内容：全局设置的三档音量）的编辑历史。
 *
 * 与 `sceneHistory` 并列而不是合并，是因为两者是**两份文件**：场景各自成文件、工程文件是项目级的。
 * 但用户只该看到一个「撤销」——所以加了 `lastEditTrack`：撤销 / 重做作用在**最近改过的那条轨道**上，
 * 那条轨道撤完了就轮到另一条（见 `undo` / `redo`）。在两套历史之间切换时还要清掉对方的重做栈
 * （`clearRedo`）：否则「撤销 A、改 B、重做」会跳回一个已经不存在的未来。
 */
export const projectHistory = new DocumentHistory<ProjectDoc>(createEmptyProject(), { limit: 200 });

/**
 * **素材 meta**（`<素材>.meta`，v23 起）的编辑历史。
 *
 * 第三份文件、第三条轨道：切分与导入设置不再住在工程文件里，而是**每个素材一份**
 * （`state/store-types.ts` 的 `AssetMetaTable`），所以落盘、撤销、去重都自成一套
 * （见 `store-context.ts` 里对 `metaHistory` 的订阅）。
 * 与前两条轨道的**相互作用**只有一处：切分参与场景载荷的解析（子图的「几行几列」随载荷走），
 * 所以它一变也要重推一次场景——与工程文件那边同一条理由。
 */
export const metaHistory = new DocumentHistory<AssetMetaTable>({}, { limit: 200 });

/** 最近一次编辑发生在哪条轨道上（三套历史共用一个撤销入口）。 */
export type EditTrack = "scenes" | "project" | "metas";

/**
 * 三条轨道的固定次序（`trackOrder` 的底子）。
 *
 * `syncHistoryFlags` 用它算「三条里有没有得撤」，所以它是一个常量数组而不是散落的字面量。
 */
export const EDIT_TRACKS: readonly EditTrack[] = ["scenes", "project", "metas"];

let lastEditTrack: EditTrack = "scenes";

/** 撤销入口要能不理泛型地操作三条轨道，所以只依赖这点共同接口。 */
interface EditHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | undefined;
  readonly redoLabel: string | undefined;
  undo(): boolean;
  redo(): boolean;
}

/**
 * 按「先试哪条轨道」的顺序排：最近改过的那条优先，撤完了轮到另一条。
 *
 * 三条轨道里除最近改过的那条之外，**其余两条按固定次序**（`EDIT_TRACKS` 的顺序）：
 * 「连续按撤销」时先沿着最近那条一路撤到底，撤空了再按固定次序接手——
 * 语序稳定（不会因为上一条撤空而换一个「下一条」），人也好预期。
 */
function trackOrder(preferred: EditTrack): readonly EditTrack[] {
  return [preferred, ...EDIT_TRACKS.filter((track) => track !== preferred)];
}

export function historyOf(track: EditTrack): EditHistory {
  if (track === "scenes") {
    return sceneHistory;
  }

  return track === "project" ? projectHistory : metaHistory;
}

/**
 * 下一次撤销 / 重做会作用在哪条轨道上。
 *
 * 菜单文案与实际执行**共用这一个判定**（`undo` / `redo` / `syncHistoryFlags` 都调它），
 * 所以「撤销 移动对象」点下去必然撤销的就是那件事。三条都没得撤时返回最近改过的那条
 * （此时标签本来就是空的）。
 */
export function activeTrack(action: "undo" | "redo"): EditTrack {
  for (const track of trackOrder(lastEditTrack)) {
    if ((action === "undo" ? historyOf(track).canUndo : historyOf(track).canRedo)) {
      return track;
    }
  }

  return lastEditTrack;
}

/** 自动落盘的防抖窗口：连续拖动 / 连续输入只写一次盘。 */
export const SCENE_SAVE_DEBOUNCE_MS = 800;

/** 场景里对象位置的默认落点：世界原点。 */
export const SCENE_CENTER: WorldPosition = { x: 0, y: 0 };

/**
 * 新建地图对象时的默认贴图尺寸。
 *
 * 贴图按同名约定放在 `Assets/images/<场景名>.png`，网格尺寸由图片算出来，不手写 64×36。
 */
export const DEFAULT_MAP_IMAGE = { width: 1920, height: 1080 } as const;

/**
 * 「适配视图」/「复位」/ 首次量到画布尺寸时的默认视野：**同一个算法，只有这一份**。
 *
 * 装的是当前场景里**画布上看得见的东西**（地图 / 贴图 / 徽标…，见 `sceneVisibleRects`），
 * 外框居中、按需缩放，四周留 24px 边距。
 *
 * **只缩不放（上限 1:1）**：装得下就按 1:1 摆中间——「尽量看到所有对象」要的是
 * **别把东西漏在屏幕外**，而不是把小场景放大到糊脸（一张 120×120 的精灵铺满 1400px 的画布
 * 既没有信息量，还会让人以为比例坏了）。装不下才缩，缩到刚好装下。
 *
 * 单独提出来是因为它有三个入口——用户点「复位」/「视图 → 适配视口」，以及**视口尺寸第一次
 * 量出来时**的默认视野（打开场景、转屏、拉开面板）。三处必须同一套算法，否则「默认看到的」
 * 与「按一下复位看到的」会不一样。
 */
export function fitSceneViewport(
  scenes: readonly SceneDoc[],
  activeSceneName: string | null,
  size: { readonly width: number; readonly height: number },
): Viewport {
  const scene = scenes.find((item) => item.name === activeSceneName);
  return fitViewport(sceneVisibleRects(scene), size, 24, { max: 1 });
}

/**
 * 从**原始场景文件 JSON** 里挖出场景尺寸（地图对象的贴图尺寸）。
 *
 * 旧格式的位置是归一化坐标，读文件时就要用它换算成世界坐标——那时还没解析出对象，
 * 所以这里直接看原始 JSON；挖不到就返回 undefined（由 `parseSceneFile` 用兜底尺寸）。
 */
export function sceneSizeHint(raw: unknown): ImageSize | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const objects = (raw as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) {
    return undefined;
  }

  for (const object of objects) {
    if (typeof object !== "object" || object === null) {
      continue;
    }

    const map = (object as { map?: unknown }).map;
    if (typeof map !== "object" || map === null) {
      continue;
    }

    const image = (map as { image?: unknown }).image;
    if (typeof image !== "object" || image === null) {
      continue;
    }

    const { width, height } = image as { width?: unknown; height?: unknown };
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { width, height };
    }
  }

  return undefined;
}

/** 逻辑 ID 里的文件名（`project:项目/Assets/images/Map001.png` → `Map001.png`）。 */
function fileNameOfResourceId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

/**
 * 场景改名时同步**场景名隐式引用**的贴图 ID。
 *
 * 贴图是按「与场景同名」的约定自动指到 `Assets/images/<场景名>.png` 的
 * （见 `projectSceneImageId`）。所以只要某个**地图**的贴图当前指向旧场景名，
 * 就把它改指到新场景名——否则场景一改名，贴图立刻就找不到了。
 *
 * **只动地图的 `map.image`，不动精灵的 `image`**：地图的引用是**约定**（跟着场景名走），
 * 精灵的图片是用户**明确挑的**（哪怕它恰好和场景同名，那也还是他挑的那张文件，
 * 改指到别的文件反而是篡改）。手工指定的其它贴图同理不受影响。
 */
export function withRenamedSceneImage(
  project: string,
  file: SceneFileDoc,
  oldName: string,
  newName: string,
): { file: SceneFileDoc; changed: number } {
  const oldFile = `${oldName}.png`;
  let changed = 0;

  const objects = file.objects.map((object) => {
    const map = mapDataOf(object);
    if (map === undefined || fileNameOfResourceId(map.image.id) !== oldFile) {
      return object;
    }

    changed += 1;
    // v19：贴图在 `GridMap` 组件里——**必须经访问器替换**，不能再往对象上写一个扁平 `map`
    // （那样 schema 会在下次解析时把它当未知键丢掉，场景一改名贴图就找不到了）
    return withFeature(object, DEFAULT_SLOT_COMPONENT.map, {
      ...map,
      image: { ...map.image, id: projectSceneImageId(project, newName) },
    });
  });

  return { file: { ...file, objects }, changed };
}

/** 副本相对原对象的偏移量（世界像素，按第几个副本递增，避免整批叠在一起）。 */
const COPY_OFFSET = 24;

/** 复制出来的副本落点：偏移一点（世界无限大，不用夹）。 */
export function offsetPosition(position: WorldPosition | null, step: number): WorldPosition {
  const base = position ?? SCENE_CENTER;
  return { x: base.x + COPY_OFFSET * step, y: base.y + COPY_OFFSET * step };
}

/** 在场景列表里按名字找场景（对象编辑都作用于当前场景）。 */
export function findSceneByName(
  scenes: readonly SceneDoc[],
  name: string | null,
): SceneDoc | undefined {
  return name === null ? undefined : scenes.find((scene) => scene.name === name);
}

/** 撤销记录上显示的变换动作名（与工具一一对应，用户看到的和点的一致）。 */
export const TRANSFORM_LABELS: Record<TransformTool, string> = {
  none: "移动对象",
  move: "移动对象",
  rotate: "旋转对象",
  scale: "缩放对象",
};

/**
 * 场景文件的序列化。
 *
 * 场景名**不进文件**（它就是文件名），所以写出去的内容只有内容本身——
 * 这也是「重命名场景 = 只改文件名」能成立的前提。
 *
 * 写出去之前每个对象都过一遍 `collapseScale`：两轴相等的缩放**只写等比 `scale`**。
 * 少了这一步，用角手柄拖出来的（或单轴拖回等比的）对象会带着 `scaleX` / `scaleY` 落盘，
 * 而那两个字段 Unity 客户端还不认——等比场景本来不需要它们。
 *
 * **按场景对象引用缓存结果**（`WeakMap`）：拖手柄时每一帧都要拿它比对「有没有未保存的改动」，
 * 而一个项目里通常只有一个场景在变——没变的那些场景不该被反复 `JSON.stringify`。
 * 缓存成立的前提是**文档不可变**（immer 每次修改都产出新对象，只有真改过的场景才换引用），
 * 所以拿引用当键不会读到脏文本。
 */
const serializedScenes = new WeakMap<SceneDoc, string>();
const serializedScenesWithMetas = new WeakMap<SceneDoc, WeakMap<AssetMetas, string>>();

export function serializeSceneFile(scene: SceneDoc, metas?: AssetMetas): string {
  if (metas !== undefined) {
    const cachedByMetas = serializedScenesWithMetas.get(scene);
    const cached = cachedByMetas?.get(metas);
    if (cached !== undefined) {
      return cached;
    }

    const file: SceneFileDoc = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: sceneAssetRefsToGuids(scene, metas).objects.map(collapseScale),
    };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    const nextCache = cachedByMetas ?? new WeakMap<AssetMetas, string>();
    nextCache.set(metas, text);
    serializedScenesWithMetas.set(scene, nextCache);
    return text;
  }

  const cached = serializedScenes.get(scene);
  if (cached !== undefined) {
    return cached;
  }

  const file: SceneFileDoc = {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: scene.objects.map(collapseScale),
  };

  const text = `${JSON.stringify(file, null, 2)}\n`;
  serializedScenes.set(scene, text);
  return text;
}

/**
 * 工程文件（`project.json`）的序列化。
 *
 * 与场景文件那套同一个写法（两空格缩进 + 末尾换行），差别只有内容：工程文件里**有项目名**
 * （场景文件里没有，场景名就是文件名），并且带着项目级的那几样东西——道具库与 v15 起的全局设置。
 *
 * `formatVersion` 每次都写当前版本：工程文件里的字段是**会被补齐的**（缺 `settings` 就补一份），
 * 写回时版本号一起前进，磁盘上的文件从此自描述。
 */
export function serializeProjectFile(doc: ProjectDoc): string {
  return `${JSON.stringify({ ...doc, formatVersion: DOCUMENT_FORMAT_VERSION }, null, 2)}\n`;
}

/**
 * 场景的**展示顺序**：中文拼音序 + **数字按数值比**。
 *
 * `numeric: true` 是这条的关键：没有它，`第10幕` 会排在 `第2幕` 前面（逐字符比），
 * 而编号恰恰是 DM 给「跑团顺序」最常用的办法（`01-门厅`、`第2幕-地牢`）。
 * 顺序就是 `scenes` 数组的顺序，切换条、`1`-`9` 直选、上一场 / 下一场都按它走。
 */
export function compareSceneNames(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true });
}

/** 在资源树里按条件找节点（找场景目录、按 id 找选中的资源文件）。 */
export function findResourceNode(
  nodes: readonly ResourceTreeNode[],
  match: (node: ResourceTreeNode) => boolean,
): ResourceTreeNode | undefined {
  for (const node of nodes) {
    if (match(node)) {
      return node;
    }

    const found = findResourceNode(node.children ?? [], match);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

export const MAX_LOGS = 200;
let logSeq = 0;

export function makeLog(level: RuntimeLogEntry["level"], message: string): RuntimeLogEntry {
  logSeq += 1;
  return {
    id: `log_${logSeq}`,
    level,
    message,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  };
}

/**
 * 撤销 / 重做作用在哪条轨道上：`undo` / `redo` 执行后写回，下一次由 `activeTrack` 读。
 */
export function setLastEditTrack(track: EditTrack): void {
  lastEditTrack = track;
}

/** 运行日志的自增序号（`makeLog` 用它拼 id）。 */
export function nextLogId(): number {
  logSeq += 1;
  return logSeq;
}
