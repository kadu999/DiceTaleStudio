import type { ProjectDoc } from "@dts/document";
import type { ResourceTreeNode } from "../services/project-api";
import { assetDisplayName } from "./asset-info";
import { assetDisplayPath, listAudioAssets } from "./asset-picker";

/**
 * **音频清单 + 标注（含标签表）→ 列表行**（BGM 弹框与「音频文件」窗口共用一份）。
 *
 * 两个窗口看的是同一批东西，但关注点不同：一个是「现在放哪一首」，一个是「给文件起名字 / 打标签」。
 * 所以筛选与归一化做成纯函数放在这里，界面只管画——不然「按名字 / 标签找」这件事会被抄成两套，
 * 两边行为迟早不一样（而且不好单测）。
 *
 * 标签这套学 Unity：**tag 是个整数**（就是 `doc.audioTags` 的下标），名字住在表里。
 * 所以这里对外给的是 `{ id, name }` 引用：**显示用名字、编辑用 ID**——改名字只改表，
 * 文件里的 `[0, 2]` 一个字节都不动。
 *
 * 一句话口径：**显示名 = 全局标注的名字，没有就退回素材文件名**；标签只在编辑器里用
 * （不进协议、不下发 Unity），资源面板的文件树仍然显示真实文件名（那是文件浏览器）。
 */

/** 一个标签的引用：ID 是身份（进文档），名字只是显示文本（住在标签表里）。 */
export interface AudioTagRef {
  readonly id: number;
  /** 表里的名字（已 trim；可能是空串——那说明这个名字没填，界面上会写成「未命名」）。 */
  readonly name: string;
}

/** 表里的一个标签 + 用量（给「标签」「选择标签」窗口用）。 */
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
  /** 目录（`audio`、`audio/act-2`）；直接躺在 `Assets/` 下的是「（根目录）」。 */
  readonly dir: string;
  /** 标签（已解析：跳过越界 / 已删 / 没名字的 ID；顺序按 ID 升序）。 */
  readonly tags: readonly AudioTagRef[];
  /** 项目里找不到这个文件（只剩标注；在「音频文件」窗口里列出来，好清理）。 */
  readonly missing: boolean;
}

/** 目录名：`audio/act-2/x.mp3` → `audio/act-2`（没有目录就是「（根目录）」）。 */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "（根目录）" : path.slice(0, slash);
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
 * 越界、指向已删（洞）、名字是空的 ID 一律**跳过**（`validateProject` 会为前两种报 warning）——
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
 * 组装清单：**项目里的音频 ∪ 标注里有、项目里已经没有的 key**。
 *
 * 后者（`missing`）只在「音频文件」窗口里露面——标注还在、文件没了，得让人看得见才清得掉；
 * BGM 弹框不列它们（点了只会发出一条注定失败的命令）。
 * 顺序按路径排（与 `listAudioAssets` 同一套：中文拼音序 + 数字按数值比）。
 */
export function audioCatalog(
  tree: readonly ResourceTreeNode[],
  meta: ProjectDoc["audioMeta"],
  table: ProjectDoc["audioTags"],
): AudioCatalogRow[] {
  const rows: AudioCatalogRow[] = [];
  const known = new Set<string>();

  for (const asset of listAudioAssets(tree)) {
    known.add(asset.id);
    const path = assetDisplayPath(asset.id);
    const customName = meta?.[asset.id]?.name?.trim() ?? "";
    rows.push({
      id: asset.id,
      fileName: assetDisplayName(asset.name),
      displayName: customName.length > 0 ? customName : assetDisplayName(asset.name),
      customName,
      path,
      dir: dirOf(path),
      tags: tagsOfClip(table, meta?.[asset.id]?.tags),
      missing: false,
    });
  }

  for (const [id, entry] of Object.entries(meta ?? {})) {
    if (known.has(id)) {
      continue;
    }

    const fileName = assetDisplayName(id.slice(id.lastIndexOf("/") + 1));
    const customName = entry.name?.trim() ?? "";
    rows.push({
      id,
      fileName,
      displayName: customName.length > 0 ? customName : fileName,
      customName,
      // 素材已经不在树里：拿逻辑 ID 当路径显示（比空着强，至少能看出它在哪个项目 / 目录）
      path: assetDisplayPath(id),
      dir: dirOf(assetDisplayPath(id)),
      tags: tagsOfClip(table, entry.tags),
      missing: true,
    });
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true }));
}

/** 标注里的显示名（没起名字 / 只有空白 → `undefined`）。给名字兜底链用。 */
export function audioNameOf(meta: ProjectDoc["audioMeta"], id: string): string | undefined {
  const name = meta?.[id]?.name?.trim();
  return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * 名字兜底链：**对象自己的名字 → 全局显示名 → 素材文件名**。
 *
 * 「对象自己的名字」是 `sound.names`（「编辑声音」窗口里按对象起的），它是**覆盖**；
 * 留空就跟随音频文件自己的名字（在「音频文件」窗口里改）——三处口径只有这一处实现。
 */
export function audioDisplayName(
  meta: ProjectDoc["audioMeta"],
  id: string,
  objectName?: string,
): string {
  const override = objectName?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }

  return audioNameOf(meta, id) ?? assetDisplayName(id.slice(id.lastIndexOf("/") + 1));
}

/** 搜索命中：显示名 / 自定义名 / 文件名 / 路径 / 标签名（大小写不敏感）。 */
export function matchesAudioQuery(row: AudioCatalogRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }

  const haystack = [
    row.displayName,
    row.customName,
    row.fileName,
    row.path,
    ...row.tags.map((tag) => tag.name),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle);
}

/** 先按标签名筛（**AND**：每个都要有），再按搜索词筛（两件事叠加）。 */
export function filterAudioRows(
  rows: readonly AudioCatalogRow[],
  input: { readonly query: string; readonly tags: readonly string[] },
): AudioCatalogRow[] {
  return rows.filter(
    (row) =>
      input.tags.every((name) => row.tags.some((tag) => tag.name === name)) &&
      matchesAudioQuery(row, input.query),
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

/** 按目录分组（目录首次出现的顺序；目录内保持传入顺序 = 按路径排过序的）。 */
export function groupByDir(
  rows: readonly AudioCatalogRow[],
): Array<[string, AudioCatalogRow[]]> {
  const byDir = new Map<string, AudioCatalogRow[]>();
  for (const row of rows) {
    const bucket = byDir.get(row.dir);
    if (bucket === undefined) {
      byDir.set(row.dir, [row]);
    } else {
      bucket.push(row);
    }
  }

  return [...byDir.entries()];
}

/**
 * 输入框里敲进来的一串文本 → 一个标签名（`undefined` = 空，别加）。
 *
 * 只做去首尾空白：不加别的规矩（名字是自由的），重名由「新建」那条路自己判。
 */
export function tagFromInput(raw: string): string | undefined {
  const tag = raw.trim();
  return tag.length === 0 ? undefined : tag;
}
