// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：项目级全局设置与音频**标签表**命令。
//
// 图片的切分与导入设置（旧的 `setSpriteSheet` / `setSpriteImportSettings`）**已经从这里删掉**：
// v23 起它们不再住在工程文件里，而是写在各自素材的 `.meta` 里，写入口径是 `asset-meta.ts` 的
// `withMetaSpriteSheet` / `withMetaSpriteSettings`（纯函数，返回新 meta）。
//
// 音频文件的标注（旧的 `setAudioMetaName` / `setAudioMetaTags`）**v24 起也走了同一条路**：
// 它们现在住在**那个音频文件自己的 `.meta`** 的 `audio` 段里，写入口径是 `asset-meta.ts` 的
// `withMetaAudioName` / `withMetaAudioTags` / `withoutMetaAudioTag`。
// 留在这里的只有**项目级**的标签表（下标 = tag ID）：一张表管全项目，与某一个文件无关。
// 编辑器拿那些纯函数在**素材 meta 那条轨道**上做一次编辑、自己按撤销与去抖落盘——
// 不经这里的项目文档 draft，所以那些命令在这里没有立足点。
import type { Draft } from "immer";
// 全局设置的缺省值（形状 + 默认值都住在 schema 里）：命令在遇到缺字段的手搭文档时补一份可用的
import { defaultAudioSettings, defaultProjectSettings } from "../schema";
import type { AudioTagTableDoc, ProjectDoc, ProjectSettingsDoc } from "../types";

// ---------------------------------------------------------------- 项目级全局设置：三档音量

/**
 * 项目级全局设置里的「音频」那一份；**缺字段就补出来**。
 *
 * 手写文件、或测试里手搭的 `ProjectDoc` 可能整个 `settings` 都没有（schema 会给默认值，
 * 但纯命令调用不经过 schema）：与 `ensureSoundData` 同一个口径，第一次编辑时补一份可用的，
 * 而不是让编辑静默失败。
 *
 * 只补缺失的层：已有 `audio.bgm` 就原样返回（不覆盖作者写下的值）。
 */
function audioSettingsOf(project: Draft<ProjectDoc>): Draft<ProjectSettingsDoc>["audio"] {
  if (project.settings === undefined) {
    project.settings = defaultProjectSettings();
  }

  const audio = project.settings.audio;
  if (audio === undefined) {
    project.settings.audio = defaultAudioSettings();
  }

  return project.settings.audio;
}

/** 把一个音量夹进 `0..1`（滑杆、手写文件、旧版本都可能给出界值）。 */
function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }

  return Math.min(1, Math.max(0, volume));
}

/**
 * 背景音乐通道音量 `0..1`（越界值夹回来）；值没变返回 false。
 *
 * v16 起背景音乐在工程文件里**只剩这一项**：歌单不再进文档（编辑器「音乐」弹框直接列
 * 项目 `Assets/audio/` 下的音频，「现在放哪一首」由 `play_bgm{clip}` 这条命令说）。
 * 这一份只负责「这条声道多大声」——改完由 `settings_push` 整份下发，前端收到即生效。
 */
export function setBgmVolume(project: Draft<ProjectDoc>, volume: number): boolean {
  const audio = audioSettingsOf(project);
  const next = clampVolume(volume);
  if (audio.bgm.volume === next) {
    return false;
  }

  audio.bgm.volume = next;
  return true;
}

/** 音效通道音量 `0..1`。 */
export function setSfxVolume(project: Draft<ProjectDoc>, volume: number): boolean {
  const audio = audioSettingsOf(project);
  const next = clampVolume(volume);
  if (audio.sfx.volume === next) {
    return false;
  }

  audio.sfx.volume = next;
  return true;
}

/** 旁白通道音量 `0..1`。 */
export function setVoiceVolume(project: Draft<ProjectDoc>, volume: number): boolean {
  const audio = audioSettingsOf(project);
  const next = clampVolume(volume);
  if (audio.voice.volume === next) {
    return false;
  }

  audio.voice.volume = next;
  return true;
}

// ---------------------------------------------------------------- 项目级数据：音频**标签表**（下标 = tag ID）

/**
 * 标签表（缺就补一个空表）。
 *
 * 表只在这里被**就地改**：`deleteAudioTag` 会把槽位设成 `null`（留洞，不位移别人的 ID）。
 */
function audioTagsOf(project: Draft<ProjectDoc>): Draft<AudioTagTableDoc> {
  if (project.audioTags === undefined) {
    project.audioTags = [];
  }

  return project.audioTags;
}

/**
 * 新建一个标签（或复用同名的那个）：返回它的 **ID**；名字为空返回 `null`。
 *
 * 对齐 Unity 的 TagManager：**tag 是个整数**，名字只是它的显示文本。所以
 * 「新建」= 在表里占一个槽（**优先复用第一个洞**，没有洞才往后追加），
 * 同名（trim 后完全一样）就返回已有那个 ID——不会出现两个写法相同、ID 不同的标签。
 */
export function addAudioTag(project: Draft<ProjectDoc>, name: string): number | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const table = audioTagsOf(project);
  const existing = table.indexOf(trimmed);
  if (existing >= 0) {
    return existing;
  }

  const hole = table.indexOf(null);
  if (hole >= 0) {
    table[hole] = trimmed;
    return hole;
  }

  table.push(trimmed);
  return table.length - 1;
}

/**
 * 给某个 tag ID 改名字（**只改这一张表**）。
 *
 * 这正是「文件里存整数」的好处：所有引用它的音频文件一个字节都不用动。
 * 空名字 / ID 越界或指向已删的槽 / 名字没变都返回 `false`。
 * 名字与别的标签重名**不拦**（与 Unity 一致：允许存在两个同名标签，`validateProject` 报一条 warning）；
 * 想让某个标签不再显示，就把它删掉。
 */
export function renameAudioTag(project: Draft<ProjectDoc>, tagId: number, name: string): boolean {
  const table = project.audioTags;
  if (table === undefined || !Number.isInteger(tagId) || tagId < 0 || tagId >= table.length) {
    return false;
  }

  if (table[tagId] === null) {
    return false;
  }

  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed === table[tagId]) {
    return false;
  }

  table[tagId] = trimmed;
  return true;
}

/**
 * 给**指定的槽位**命名（槽位不存在就把它补出来）。
 *
 * 与 `renameAudioTag` 的区别在「谁定序号」：
 * - `renameAudioTag` 只改**已经存在**的槽（编辑器较早的「新建」流程用它）；
 * - 这一条是给「序号预先定好、只填名字」的界面用的（对齐 Unity 的 TagManager）：
 *   界面上从 `#0` 开始一列到底，人往第 N 个格子里敲名字，那 N 就是它以后的 ID。
 *
 * 下标不够长时**把中间的空槽补成 `""`**（空名字 = 还没起名字）；已经是 `null` 的洞**保留**——
 * 洞是「曾经删过」的记号，不能悄悄改成空名字，不然 `audioMeta` 里那些指向洞的旧引用会被重新点亮。
 *
 * 名字为空 / 没变 / 指向洞 / 下标非法 → `false`（不进撤销栈）。
 */
export function setAudioTagName(
  project: Draft<ProjectDoc>,
  tagId: number,
  name: string,
): boolean {
  if (!Number.isInteger(tagId) || tagId < 0) {
    return false;
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const table = audioTagsOf(project);
  if (tagId < table.length && table[tagId] === null) {
    return false;
  }

  if (table[tagId] === trimmed) {
    return false;
  }

  // 中间的缺口补空名字（不是洞）：它们只是「还没起名字」的槽
  while (table.length < tagId) {
    table.push("");
  }

  table[tagId] = trimmed;
  return true;
}

/**
 * 删掉一个标签（按 tag ID）：表里把槽设成 `null`（**留洞**）。
 *
 * 为什么留洞而不是把后面的标签往前挪：ID 是身份，一挪就会把别的标签的 ID 改掉，
 * 文件里那些引用全成了另一个标签——Unity 的 TagManager 也是「列表 + 下标」，
 * 我们这边明确留洞，新建时优先复用。
 *
 * **引用不在这里摘**：v24 起「哪个文件用了这个标签」住在**那个文件自己的 `.meta`** 里，
 * 而这一条命令只拿得到工程文件。摘引用的那一半是 `asset-meta.ts` 的 `withoutMetaAudioTag`
 * （纯函数，一文件一次），由调用方在 meta 轨道上与这一条合起来做——
 * 两条轨道各撤各的，不会出现「撤销一半」的中间态。
 * （界面上目前没有删除入口，见 README「标签」那一节；这条命令留给工具与迁移。）
 *
 * 该 ID 越界 / 已经是洞 → `false`（不进撤销栈）。
 */
export function deleteAudioTag(project: Draft<ProjectDoc>, tagId: number): boolean {
  const table = project.audioTags;
  if (
    table === undefined ||
    !Number.isInteger(tagId) ||
    tagId < 0 ||
    tagId >= table.length ||
    table[tagId] === null
  ) {
    return false;
  }

  table[tagId] = null;

  // 表里一个名字都不剩（全是洞 / 空表）：整个字段删掉，不留空壳
  if (table.every((name) => name === null)) {
    delete project.audioTags;
  }

  return true;
}
