import {
  audioNameOfMeta,
  audioTagsOfMeta,
  type ProjectDoc,
} from "@dts/document";
import type { ResourceTreeNode } from "../services/project-api";
import type { AssetMetaTable } from "../state/store-types";
import { assetDisplayName } from "./asset-info";
import { assetDisplayPath, listAudioAssets } from "./asset-picker";

/**
 * **音频清单 + 标注（含标签表）→ 列表行**（「背景音乐」「选择音频」「选择标签」三个窗口共用一份）。
 *
 * 几处界面看的是同一批东西，但关注点不同：一个是「现在放哪一首」，一个是「挑一条加进声音对象」，
 * 一个是「给文件挑标签」。所以筛选 / 排序 / 归一化做成纯函数放在这里，界面只管画——
 * 不然「按名字找」「按标签筛」这件事会被抄成几套，行为迟早不一样（而且不好单测）。
 *
 * 数据住哪（v24 起）：**显示名与标签住在那个音频文件自己的 `.meta`**（`audio` 段），
 * 标签的**名字**住在工程文件那张表里（`doc.audioTags`）。所以这里对外给的是 `{ id, name }` 引用：
 * **显示用名字、编辑用 ID**——改名字只改表，meta 里的 `[0, 2]` 一个字节都不动。
 *
 * 一句话口径：**显示名 = 素材 meta 里的名字，没有就退回素材文件名**；标签只在编辑器里用
 * （不进协议、不下发 Unity），资源面板的文件树仍然显示真实文件名（那是文件浏览器）。
 *
 * **没有「文件已经没了、标注还在」这一类行了**（v23 之前有）：素材级数据现在只存在于
 * **素材旁边那份 `.meta`**，而后端只按素材找 meta（`.meta` 本身不进资源列表，
 * 见 `FsResourceProvider.list`）——素材一删，那份 `.meta` 就成了谁也看不见的孤儿，
 * 与图片那一侧同一条（见 README 的已知缺口）。所以清单**就是树里的音频**。
 */

/** 一个标签的引用：ID 是身份（进文档），名字只是显示文本（住在标签表里）。 */
export interface AudioTagRef {
  readonly id: number;
  /** 表里的名字（已 trim；可能是空串——那说明这个名字没填，界面上会写成「未命名」）。 */
  readonly name: string;
}

/** 表里的一个标签 + 用量（给「选择标签」窗口用）。 */
export interface AudioTagEntry extends AudioTagRef {
  /** 有多少个音频文件在用（含「文件已经没了」的标注行）。 */
  readonly count: number;
}

export interface AudioCatalogRow {
  /** 资源逻辑 ID（`project:我的项目/Assets/audio/x.mp3`）。 */
  readonly id: string;
  /** 素材文件名（去掉扩展名）——没起名字时的显示名，也是输入框的占位。 */
  readonly fileName: string;
  /** **显示名**：`customName` 非空就用它，否则用 `fileName`。 */
  readonly displayName: string;
  /** 全局标注里的显示名（空串 = 没起名字）。 */
  readonly customName: string;
  /** 项目内相对路径（`audio/act-2/x.mp3`）。 */
  readonly path: string;
  /** 标签（已解析：跳过越界 / 已删 / 没名字的 ID；顺序按 ID 升序）。 */
  readonly tags: readonly AudioTagRef[];
  readonly guid?: string;
}

/** 表里的标签（跳过洞）；名字已 trim。 */
export function tagEntriesOf(table: ProjectDoc["audioTags"]): AudioTagRef[] {
  const entries: AudioTagRef[] = [];
  for (const [id, name] of (table ?? []).entries()) {
    if (name === null) {
      continue;
    }

    entries.push({ id, name: name.trim() });
  }

  return entries;
}

/** 某个标签的名字（洞 / 越界 / 没有表 → `undefined`）。 */
export function tagNameOf(table: ProjectDoc["audioTags"], id: number): string | undefined {
  const name = table?.[id];
  return name === null || name === undefined ? undefined : name.trim();
}

/**
 * 解析一个文件的标签：把 `number[]` 变成 `{ id, name }[]`。
 *
 * 越界、指向已删（洞）、名字是空的 ID 一律**跳过**（`validateAssetMetas` 会为前两种报 warning）——
 * 界面不该画一个点不动的空标签出来。
 */
export function tagsOfClip(
  table: ProjectDoc["audioTags"],
  tagIds: readonly number[] | undefined,
): AudioTagRef[] {
  const refs: AudioTagRef[] = [];
  for (const id of tagIds ?? []) {
    const name = tagNameOf(table, id);
    if (name === undefined || name.length === 0) {
      continue;
    }

    refs.push({ id, name });
  }

  return refs;
}

/**
 * 组装清单：**树里的音频**（每个素材一行）。
 *
 * 名字与标签经 `assetMetaTable`（路径 ID → 那份 `.meta`）读：一个素材没有 meta
 * （理论上不该发生——编辑器打开项目时会补，见 `loadAssetMetas`）时按「没整理过」算。
 * 顺序按路径排（与 `listAudioAssets` 同一套：中文拼音序 + 数字按数值比）。
 */
export function audioCatalog(
  tree: readonly ResourceTreeNode[],
  metas: AssetMetaTable,
  table: ProjectDoc["audioTags"],
): AudioCatalogRow[] {
  const rows: AudioCatalogRow[] = [];
  for (const asset of listAudioAssets(tree)) {
    const meta = metas[asset.id];
    const customName = audioNameOfMeta(meta)?.trim() ?? "";
    rows.push({
      id: asset.id,
      fileName: assetDisplayName(asset.name),
      displayName: customName.length > 0 ? customName : assetDisplayName(asset.name),
      customName,
      path: assetDisplayPath(asset.id),
      tags: tagsOfClip(table, audioTagsOfMeta(meta)),
      ...(meta === undefined ? {} : { guid: meta.guid }),
    });
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true }));
}

/** 素材 meta 里的显示名（没起名字 / 只有空白 → `undefined`）。给名字兜底链用。 */
export function audioNameOf(metas: AssetMetaTable, id: string, currentId = id): string | undefined {
  const name = (audioNameOfMeta(metas[currentId]) ?? audioNameOfMeta(metas[id]))?.trim();
  return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * 名字兜底链：**对象自己的名字 → 素材 meta 里的显示名 → 素材文件名**。
 *
 * 「对象自己的名字」是 `sound.names`（「编辑声音」窗口里按对象起的），它是**覆盖**；
 * 留空就跟随音频文件自己的名字（属性面板里选中那个音频文件时改）——三处口径只有这一处实现。
 */
export function audioDisplayName(
  metas: AssetMetaTable,
  id: string,
  objectName?: string,
  currentId = id,
): string {
  const override = objectName?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }

  return audioNameOf(metas, id, currentId) ?? assetDisplayName(currentId.slice(currentId.lastIndexOf("/") + 1));
}

/**
 * 搜索命中：显示名 / 自定义名 / 文件名 / 路径（大小写不敏感）。
 *
 * `searchTags = false` 时**连标签名也不搜**：BGM 弹框里标签是**勾的**（清单上方那一排），
 * 不需要再让搜索框兼职——一个框搜两件事，敲进去的是标签还是名字只能靠猜。
 */
export function matchesAudioQuery(
  row: AudioCatalogRow,
  query: string,
  searchTags = true,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }

  const haystack = [
    row.displayName,
    row.customName,
    row.fileName,
    row.path,
    ...(searchTags ? row.tags.map((tag) => tag.name) : []),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle);
}

/**
 * 先按标签名筛（**AND**：每个都要有），再按搜索词筛（两件事叠加）。
 *
 * 标签名是**名字**不是 ID——筛选是界面上的一次性动作，不进文档；改标签名时选中态跟着名字走
 * （与行上那些 chip 同一套）。
 */
export function filterAudioRows(
  rows: readonly AudioCatalogRow[],
  input: {
    readonly query: string;
    readonly tags: readonly string[];
    /** 搜索词是否也匹配标签名（默认匹配，见 `matchesAudioQuery`）。 */
    readonly searchTags?: boolean;
  },
): AudioCatalogRow[] {
  return rows.filter(
    (row) =>
      input.tags.every((name) => row.tags.some((tag) => tag.name === name)) &&
      matchesAudioQuery(row, input.query, input.searchTags ?? true),
  );
}

/**
 * 按**显示名**排序（BGM 弹框：清单不分组，靠名字扫）。
 *
 * 同名的两首（比如两个目录下都叫 `theme`）按路径定序——排序要**稳**，
 * 每次打开顺序都跳一下，人就不敢用「第几行」这个记忆了。
 */
export function sortAudioRowsByName(rows: readonly AudioCatalogRow[]): AudioCatalogRow[] {
  return [...rows].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName, "zh-Hans-CN", { numeric: true }) ||
      a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true }),
  );
}

/**
 * 标签表里的标签 + 用量（用量降序、同量按 **ID 升序**）。
 *
 * 列表**含还没被用到的标签**（count = 0）：表就是词表，先建后用是正常用法
 * （对齐 Unity 的 TagManager：标签先在表里，再往对象上打）。
 */
export function allTagsOf(
  table: ProjectDoc["audioTags"],
  rows: readonly AudioCatalogRow[],
): AudioTagEntry[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    for (const tag of row.tags) {
      counts.set(tag.id, (counts.get(tag.id) ?? 0) + 1);
    }
  }

  return tagEntriesOf(table)
    .map((entry) => ({ ...entry, count: counts.get(entry.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.id - b.id);
}

/**
 * 标签表里的标签按**名字**排（给「勾标签」那一排用）。
 *
 * 与 `allTagsOf` 的分工：那里按用量排（「哪个标签用得多」），这里就是一排可勾的按钮，
 * 顺序只求**可预期**——名字排，找哪个标签不用先想它被用了几次。
 * 空名字的槽（还没起名字）**不列**：按它筛不出任何东西（`tagsOfClip` 本来就跳过空名字）。
 */
export function tagOptionsOf(table: ProjectDoc["audioTags"]): AudioTagRef[] {
  return tagEntriesOf(table)
    .filter((tag) => tag.name.length > 0)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }) ||
        a.id - b.id,
    );
}
