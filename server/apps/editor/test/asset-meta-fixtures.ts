import { ASSET_META_FORMAT_VERSION, type AssetImporter, type AssetMetaDoc } from "@dts/document";

/**
 * 素材 meta（`<素材>.meta`）的**测试夹具**。
 *
 * 为什么要单独一份：v24 起「显示名 + 标签」不再住在工程文件的 `audioMeta` 里，而是住在
 * **那个音频文件自己的 `.meta`** 的 `audio` 段里；于是好几份界面用例都要种一张
 * 「素材路径 ID → `AssetMetaDoc`」的表。表长什么样由文档层定（`formatVersion` / `guid` /
 * `importer` 必填），抄在每份用例里迟早会跟 `assetMetaSchema` 走散。
 *
 * 手写字段而不是走 `withMetaAudioName` / `withMetaAudioTags`：那两个纯函数会**顺手归一化**
 * （去重、升序、丢掉越界 / 指向已删标签的 ID），而好几条用例恰恰要种一份**脏的** ID 清单，
 * 看读取端（`audioCatalog` / 校验）自己怎么处理。
 */

/** 测试用的稳定 GUID：32 位小写十六进制、按序号排——断言时一眼看得出是哪一份。 */
export function testGuid(sequence: number): string {
  return String(sequence).padStart(32, "0");
}

/** 一份素材的 `.meta`（v24 起每种素材一份，`importer` 说清是哪种）。 */
export function assetMetaDoc(input: {
  readonly importer: AssetImporter;
  readonly sequence?: number;
  readonly sprite?: AssetMetaDoc["sprite"];
  readonly audio?: AssetMetaDoc["audio"];
}): AssetMetaDoc {
  return {
    formatVersion: ASSET_META_FORMAT_VERSION,
    guid: testGuid(input.sequence ?? 1),
    importer: input.importer,
    ...(input.sprite === undefined ? {} : { sprite: input.sprite }),
    ...(input.audio === undefined ? {} : { audio: input.audio }),
  };
}

/**
 * 「路径 ID → 音频标注（`audio` 段）」→ v24 口径的素材 meta 表。
 *
 * 传 `undefined` 也收（那份 meta 只有身份、还没整理过），省得调用方为了「什么都没有」
 * 写一个空对象——「没写」与「整理成空」在文档层是有区别的。
 */
export function audioMetaTable(
  entries: Readonly<Record<string, AssetMetaDoc["audio"]>>,
): Record<string, AssetMetaDoc> {
  const table: Record<string, AssetMetaDoc> = {};
  let sequence = 0;
  for (const [id, audio] of Object.entries(entries)) {
    sequence += 1;
    table[id] = assetMetaDoc({
      importer: "audio",
      sequence,
      ...(audio === undefined ? {} : { audio }),
    });
  }

  return table;
}
