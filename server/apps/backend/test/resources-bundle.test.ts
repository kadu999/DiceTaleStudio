import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createMemoryResourceProvider } from "@dts/resources";
import {
  BUNDLE_MANIFEST_NAME,
  BundleTooLargeError,
  ProjectNotFoundError,
  buildBundle,
  fingerprintOf,
  readProjectManifest,
} from "../src/resources/bundle";

/**
 * 资源包（`/api/resources/bundle` 背后那套）：清单、指纹、zip 结构。
 *
 * **刻意不复用被测代码里的 zip writer 来解包**：这里自己按 zip 规范从字节里读中央目录、
 * 定位每条数据的偏移与 CRC——writer 的字段写错了（偏移、大小、CRC），这里立刻就炸。
 */

const PROJECT = "测试项目";

/** 造一个项目：项目文件 + Assets 下的图片 / 音频 + 一个 .gitkeep。 */
function makeProvider(): ReturnType<typeof createMemoryResourceProvider> {
  const provider = createMemoryResourceProvider();
  provider.seed(`project:${PROJECT}/project.json`, '{"formatVersion":10}');
  provider.seed(`project:${PROJECT}/Assets/images/Map001.png`, "PNG-DATA-001");
  provider.seed(`project:${PROJECT}/Assets/audio/step1.mp3`, "MP3-DATA-STEP1");
  provider.seed(`project:${PROJECT}/Assets/scenes/场景1.json`, '{"objects":[]}');
  provider.seed(`project:${PROJECT}/Assets/images/.gitkeep`, "");
  return provider;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** 最小 zip reader：走中央目录（EOCD → central → local header → data）。 */
function readZipStored(zip: Buffer): ZipEntry[] {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) {
    throw new Error("找不到 EOCD：这不是一个 zip");
  }

  const count = zip.readUInt16LE(endOffset + 10);
  let cursor = zip.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`第 ${index} 条中央目录签名不对`);
    }

    const method = zip.readUInt16LE(cursor + 10);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (method !== 0) {
      throw new Error(`条目 ${name} 的压缩方式不是 STORED（0）：${method}`);
    }

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`条目 ${name} 的本地头签名不对`);
    }

    if (zip.readUInt32LE(localOffset + 14) !== expectedCrc) {
      throw new Error(`条目 ${name} 本地头与中央目录的 CRC 不一致`);
    }

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + size);

    if (zlibCrc32(data) !== expectedCrc) {
      throw new Error(`条目 ${name} 的 CRC 校验失败（数据被写坏）`);
    }

    entries.push({ name, data: Buffer.from(data) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe("资源包：清单与指纹", () => {
  it("只收 Assets/ 下的文件：项目文件与 .gitkeep 不进包", async () => {
    const manifest = await readProjectManifest(makeProvider(), PROJECT);

    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
      "Assets/audio/step1.mp3",
      "Assets/images/Map001.png",
      "Assets/scenes/场景1.json",
    ]);
    expect(manifest.entries.some((entry) => entry.path.endsWith(".gitkeep"))).toBe(false);
    expect(manifest.entries.some((entry) => entry.path === "project.json")).toBe(false);
  });

  it("bytes = 文件大小之和，路径按字典序稳定排序", async () => {
    const manifest = await readProjectManifest(makeProvider(), PROJECT);
    const expected = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);

    expect(manifest.bytes).toBe(expected);
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("内容变了指纹就变；内容没变指纹稳定", async () => {
    const provider = makeProvider();
    const first = await readProjectManifest(provider, PROJECT);
    const again = await readProjectManifest(provider, PROJECT);
    expect(again.fingerprint).toBe(first.fingerprint);

    // 同名同长度、但内容不同：靠 size 是发现不了的，这正是有 mtime 那一项的原因；
    // 内存 provider 不提供 mtime，所以这里换成「改了长度」这条最直接的路径。
    provider.seed(`project:${PROJECT}/Assets/images/Map001.png`, "PNG-DATA-001-CHANGED");
    const changed = await readProjectManifest(provider, PROJECT);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(changed.bytes).toBeGreaterThan(first.bytes);
  });

  it("指纹把 mtime 算进去（同尺寸同内容、只有时间不同也要变）", () => {
    const base = [{ id: "project:P/A.png", path: "Assets/images/A.png", size: 10, mtimeMs: 1000 }];
    const later = [{ ...base[0]!, mtimeMs: 2000 }];

    expect(fingerprintOf(later)).not.toBe(fingerprintOf(base));
    expect(fingerprintOf(base)).toBe(fingerprintOf([...base]));
  });

  it("项目不存在时抛 ProjectNotFoundError（HTTP 层据此回 404）", async () => {
    await expect(readProjectManifest(createMemoryResourceProvider(), "没有这个项目")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it("超过上限时抛 BundleTooLargeError（HTTP 层据此回 413）", async () => {
    await expect(
      buildBundle(makeProvider(), PROJECT, { maxTotalBytes: 4 }),
    ).rejects.toBeInstanceOf(BundleTooLargeError);
  });
});

describe("资源包：zip 结构", () => {
  it("包内条目名 = 项目根相对路径，且另外带一份清单文件", async () => {
    const built = await buildBundle(makeProvider(), PROJECT);
    const entries = readZipStored(built.zip);
    const names = entries.map((entry) => entry.name).sort();

    expect(names).toEqual([
      "Assets/audio/step1.mp3",
      "Assets/images/Map001.png",
      "Assets/scenes/场景1.json",
      BUNDLE_MANIFEST_NAME,
    ].sort());

    // 条目名不带项目名前缀：前端按逻辑 ID 去掉项目名后直接对得上
    expect(names.every((name) => !name.startsWith(PROJECT))).toBe(true);
  });

  it("包里每个文件的字节与源文件逐字节一致", async () => {
    const provider = makeProvider();
    const built = await buildBundle(provider, PROJECT);
    const entries = readZipStored(built.zip);

    for (const entry of built.manifest.entries) {
      const packed = entries.find((candidate) => candidate.name === entry.path);
      expect(packed).toBeDefined();
      const source = Buffer.from(await provider.readBinary(entry.id));
      expect(packed!.data.equals(source)).toBe(true);
    }
  });

  it("包内清单文件里带项目名、指纹与文件数（前端解压后可直接核对）", async () => {
    const built = await buildBundle(makeProvider(), PROJECT);
    const packed = readZipStored(built.zip).find((entry) => entry.name === BUNDLE_MANIFEST_NAME);
    expect(packed).toBeDefined();

    const manifest = JSON.parse(packed!.data.toString("utf8")) as {
      project: string;
      fingerprint: string;
      bytes: number;
      files: Array<{ path: string }>;
    };

    expect(manifest.project).toBe(PROJECT);
    expect(manifest.fingerprint).toBe(built.manifest.fingerprint);
    expect(manifest.bytes).toBe(built.manifest.bytes);
    expect(manifest.files).toHaveLength(built.manifest.entries.length);
  });

  it("中文条目名按 UTF-8 写出（通用位标记 0x0800）并能原样读回", async () => {
    const built = await buildBundle(makeProvider(), PROJECT);
    const entries = readZipStored(built.zip);

    // 中央目录里那一位必须置上，否则 Windows 资源管理器之类会按 CP437 解出乱码
    const endOffset = built.zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let cursor = built.zip.readUInt32LE(endOffset + 16);
    const flags: number[] = [];
    for (let index = 0; index < built.zip.readUInt16LE(endOffset + 10); index += 1) {
      flags.push(built.zip.readUInt16LE(cursor + 8));
      cursor += 46 + built.zip.readUInt16LE(cursor + 28) + built.zip.readUInt16LE(cursor + 30) + built.zip.readUInt16LE(cursor + 32);
    }

    expect(flags.every((flag) => (flag & 0x0800) !== 0)).toBe(true);
    expect(entries.some((entry) => entry.name.includes("场景1"))).toBe(true);
  });

  it("响应头带上项目 / 指纹 / 文件数 / 字节数", async () => {
    const built = await buildBundle(makeProvider(), PROJECT);
    expect(decodeURIComponent(built.headers["x-dts-project"]!)).toBe(PROJECT);
    expect(built.headers["x-dts-fingerprint"]).toBe(built.manifest.fingerprint);
    expect(Number(built.headers["x-dts-file-count"])).toBe(built.manifest.entries.length);
    expect(Number(built.headers["x-dts-bytes"])).toBe(built.manifest.bytes);
  });

  it("没有任何素材的项目也能打包（只有清单文件）", async () => {
    const provider = createMemoryResourceProvider();
    provider.seed(`project:空项目/project.json`, "{}");

    const built = await buildBundle(provider, "空项目");
    expect(built.manifest.entries).toHaveLength(0);
    expect(readZipStored(built.zip).map((entry) => entry.name)).toEqual([BUNDLE_MANIFEST_NAME]);
  });
});
