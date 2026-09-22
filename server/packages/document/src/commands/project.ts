// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：项目级全局设置与音频标注 / 标签表命令。
import type { Draft } from "immer";
// 全局设置的缺省值（形状 + 默认值都住在 schema 里）：命令在遇到缺字段的手搭文档时补一份可用的
import { defaultAudioSettings, defaultProjectSettings } from "../schema";
import { isTrivialSpriteSheet, normalizeSpriteSheet } from "../sprites";
import type {
  AudioMetaDoc,
  AudioTagTableDoc,
  ProjectDoc,
  ProjectSettingsDoc,
  SpriteImportSettingsDoc,
  SpriteSheetDoc,
} from "../types";

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

// ---------------------------------------------------------------- 项目级数据：音频文件标注（显示名 + 标签）

/**
 * 归一化一组标签 ID：丢掉越界的、指向已删（`null`）槽的、重复的，再升序。
 *
 * 升序是有意的：ID 是**身份**（不是顺序），排一下让「同一组标签」在文件里长得一样，
 * 「值没变」的判断也就成了逐项比较。
 */
function normalizeTagIds(tags: readonly number[], table: readonly (string | null)[]): number[] {
  const seen = new Set<number>();
  for (const raw of tags) {
    if (!Number.isInteger(raw) || raw < 0 || raw >= table.length || table[raw] === null) {
      continue;
    }

    seen.add(raw);
  }

  return [...seen].sort((a, b) => a - b);
}

/** 标注容器；**缺就补一个**（第一次编辑时，而不是让编辑静默失败）。 */
function audioMetaOf(project: Draft<ProjectDoc>): Record<string, Draft<AudioMetaDoc>> {
  if (project.audioMeta === undefined) {
    project.audioMeta = {};
  }

  return project.audioMeta;
}

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
 * 收拾空壳：这一条既没名字也没标签就把 entry 删掉；整个 `audioMeta` 空了就把字段删掉。
 *
 * 「不留空壳」是与 `video` / `teleport` 同一套规矩：`{}` 与「没有这一项」是两回事，
 * 后者才是「这个项目还没整理过音频」的事实；留着空壳会让工程文件白白变脏。
 */
function pruneAudioMeta(project: Draft<ProjectDoc>, clipId: string): void {
  const meta = project.audioMeta;
  if (meta === undefined) {
    return;
  }

  const entry = meta[clipId];
  if (entry !== undefined && entry.name === undefined && entry.tags === undefined) {
    delete meta[clipId];
  }

  if (Object.keys(meta).length === 0) {
    delete project.audioMeta;
  }
}

/**
 * 给一个音频文件起**显示名**（`""` = 退回素材文件名）。
 *
 * 名字只是编辑器里给人看的（找不到素材时也靠它认），**不进协议、不参与播放**。
 * `clipId` 空 / 值没变返回 `false`（不进撤销栈）。
 */
export function setAudioMetaName(project: Draft<ProjectDoc>, clipId: string, name: string): boolean {
  const id = clipId.trim();
  if (id.length === 0) {
    return false;
  }

  const trimmed = name.trim();
  const current = project.audioMeta?.[id]?.name;
  if (trimmed === (current ?? "")) {
    return false;
  }

  const meta = audioMetaOf(project);
  const entry = meta[id] ?? {};
  if (trimmed.length === 0) {
    delete entry.name;
  } else {
    entry.name = trimmed;
  }

  meta[id] = entry;
  pruneAudioMeta(project, id);
  return true;
}

/**
 * 替换一个音频文件的**整份标签 ID 清单**（与 `setTeleportTargets` 同一个口径：
 * 界面那边只看得到「现在勾了哪些」，传整份最直接）。
 *
 * 归一化（丢掉越界 / 已删 / 重复的 ID，升序）后与原值逐项比较：没变返回 `false`；
 * 清空 = 删掉 `tags` 字段。
 */
export function setAudioMetaTags(
  project: Draft<ProjectDoc>,
  clipId: string,
  tags: readonly number[],
): boolean {
  const id = clipId.trim();
  if (id.length === 0) {
    return false;
  }

  const next = normalizeTagIds(tags, project.audioTags ?? []);
  const current = project.audioMeta?.[id]?.tags ?? [];
  if (next.length === current.length && next.every((tag, index) => tag === current[index])) {
    return false;
  }

  const meta = audioMetaOf(project);
  const entry = meta[id] ?? {};
  if (next.length === 0) {
    delete entry.tags;
  } else {
    entry.tags = next;
  }

  meta[id] = entry;
  pruneAudioMeta(project, id);
  return true;
}

// ---------------------------------------------------------------- 项目级数据：音频**标签表**（下标 = tag ID）

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
 * 删掉一个标签（按 tag ID）：从**所有**音频文件上摘掉这个 ID，表里把槽设成 `null`（**留洞**）。
 *
 * 为什么留洞而不是把后面的标签往前挪：ID 是身份，一挪就会把别的标签的 ID 改掉，
 * 文件里那些引用全成了另一个标签——Unity 的 TagManager 也是「列表 + 下标」，
 * 我们这边明确留洞，新建时优先复用。
 *
 * 该 ID 越界 / 已经是洞 / 没被任何文件用到 → `false`（不进撤销栈）。
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

  const meta = project.audioMeta;
  if (meta !== undefined) {
    for (const [clipId, entry] of Object.entries(meta)) {
      const tags = entry.tags;
      if (tags === undefined || !tags.includes(tagId)) {
        continue;
      }

      const next = tags.filter((item) => item !== tagId);
      if (next.length === 0) {
        delete entry.tags;
      } else {
        entry.tags = next;
      }

      pruneAudioMeta(project, clipId);
    }
  }

  // 表里一个名字都不剩（全是洞 / 空表）：整个字段删掉，不留空壳
  if (table.every((name) => name === null)) {
    delete project.audioTags;
  }

  return true;
}

// ---------------------------------------------------------------- 项目级数据：图片切分（精灵表）

/**
 * 改一张图的**切分**（`图片逻辑 ID → 列×行`）；`null` = 恢复整图。
 *
 * 这是「一张图按几行几列切」的**唯一一份**数据：对象身上只有「引用哪张图 + 第几格」，
 * 所以改这里 = 所有引用它的对象一起变（对齐 Unity：Sprite 的矩形住在资源自己的导入设置里）。
 *
 * 三条收拾规矩：
 * - 行列取整 + 夹到 `1..SPRITE_SHEET_MAX`（坏数字不该让整张图集画不出来）；
 * - **`1×1` = 整图**，与 `null` 一样**把表项删掉**（不留空壳，与 `audioMeta` / `video` 同一个口径）；
 * - 整个表空了就把字段删掉。
 *
 * 已经在用它的对象**不在这里动**：格子越界由渲染与推送统一夹到最后一格（那要跨到场景那条
 * 撤销轨道去改对象，一次操作落在两条轨道上会让撤销说不清）。值没变返回 `false`。
 */
export function setSpriteSheet(
  project: Draft<ProjectDoc>,
  imageId: string,
  sheet: SpriteSheetDoc | null,
): boolean {
  const id = imageId.trim();
  if (id.length === 0) {
    return false;
  }

  const current = project.spriteSheets?.[id];
  const next = sheet === null ? null : normalizeSpriteSheet(sheet);
  // 1×1 = 整图：与 `null` 一样按「把这一项删掉」处理
  const removing = next === null || isTrivialSpriteSheet(next);

  if (removing) {
    if (current === undefined) {
      // 本来就按整图算（没这项）：什么都没变
      return false;
    }

    delete project.spriteSheets?.[id];
    if (project.spriteSheets !== undefined && Object.keys(project.spriteSheets).length === 0) {
      delete project.spriteSheets;
    }

    return true;
  }

  if (current !== undefined && current.columns === next.columns && current.rows === next.rows) {
    return false;
  }

  if (project.spriteSheets === undefined) {
    project.spriteSheets = {};
  }

  project.spriteSheets[id] = next;
  return true;
}

/** 更新一张图片的精灵导入类型；Default 会显式记录为普通图片。 */
export function setSpriteImportSettings(
  project: Draft<ProjectDoc>,
  imageId: string,
  settings: SpriteImportSettingsDoc | null,
): boolean {
  const id = imageId.trim();
  if (id.length === 0) {
    return false;
  }

  const current = project.spriteSettings?.[id];
  const next =
    settings === null || settings.type === "Default"
      ? { type: "Default" as const }
      : { type: "Sprite" as const, mode: settings.mode ?? ("Single" as const) };
  const sheets = project.spriteSheets;
  const hasSheet = sheets?.[id] !== undefined;
  const shouldKeepSheet = next.type === "Sprite" && next.mode === "Multiple";
  if (current?.type === next.type && current.mode === next.mode && (!hasSheet || shouldKeepSheet)) {
    return false;
  }

  project.spriteSettings ??= {};
  project.spriteSettings[id] = next;
  // Single/Default 不使用网格切分；清掉旧表项，避免导入设置与渲染结果分叉。
  if (!shouldKeepSheet && sheets !== undefined && hasSheet) {
    delete sheets[id];
    if (Object.keys(sheets).length === 0) {
      delete project.spriteSheets;
    }
  }
  return true;
}
