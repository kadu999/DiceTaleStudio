import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThumbnailStore, type Thumbnail } from "../src/resources/thumbnail-store";

/**
 * 缩略图缓存：**内存热点 + 磁盘（跨重启）**。
 *
 * 这一份钉缓存**自己**的行为（命中 / 失效 / 落盘 / 淘汰 / 坏了不闹）；HTTP 那一层
 * （尺寸头、400、抽帧）在 `project-api.test.ts`。
 */

const MD5_A = "a".repeat(32);
const MD5_B = "b".repeat(32);
const md5Of = (value: number): string => value.toString(16).padStart(32, "0");

/** 造一张假缩略图（内容无所谓：这里只走缓存逻辑，不解图）。 */
function thumb(tag: string, width = 64, height = 48): Thumbnail {
  return { data: Buffer.from(`webp:${tag}`), width, height };
}

/** 记账用的生成器：调用了几次、生成了什么，一眼看得出。 */
function generator(tag: string, width = 64, height = 48) {
  const calls: string[] = [];
  const generate = async (): Promise<Thumbnail> => {
    calls.push(tag);
    return thumb(tag, width, height);
  };

  return { generate, calls };
}

let root: string;
let dir: string;
let logs: string[];
const log = (message: string): void => {
  logs.push(message);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dts-thumb-store-"));
  dir = join(root, "thumbnails");
  logs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("缩略图缓存：内存层", () => {
  it("同 ID 同内容：第二次不再生成", async () => {
    const store = new ThumbnailStore(dir, log);
    const gen = generator("A");

    const first = await store.get("id-1", MD5_A, gen.generate);
    const second = await store.get("id-1", MD5_A, gen.generate);

    expect(gen.calls).toEqual(["A"]);
    expect(second.data.equals(first.data)).toBe(true);
    expect(second.width).toBe(64);
    expect(second.height).toBe(48);
  });

  it("同 ID 内容变了：md5 一变就重新生成", async () => {
    const store = new ThumbnailStore(dir, log);
    const replaced = generator("B");

    await store.get("id-1", MD5_A, generator("A").generate);
    const updated = await store.get("id-1", MD5_B, replaced.generate);

    expect(replaced.calls).toEqual(["B"]);
    expect(updated.data.toString()).toBe("webp:B");
  });

  it("同一份内容被两个 ID 并发请求：只生成一次", async () => {
    const store = new ThumbnailStore(dir, log);
    const gen = generator("A");

    // 两个 get 都在第一个 await 之前就登记了同一个 job（按 md5 去重），所以只生成一次
    const [first, second] = await Promise.all([
      store.get("id-1", MD5_A, gen.generate),
      store.get("id-2", MD5_A, gen.generate),
    ]);

    expect(gen.calls).toEqual(["A"]);
    expect(second.data.equals(first.data)).toBe(true);
  });
});

describe("缩略图缓存：磁盘层（跨重启）", () => {
  it("换一个实例（= 后端重启）仍然命中磁盘，不再跑生成", async () => {
    const before = new ThumbnailStore(dir, log);
    await before.get("id-1", MD5_A, generator("A").generate);

    // 新实例 = 内存层空了（`tsx watch` 改一行就是这个效果）
    const after = new ThumbnailStore(dir, log);
    const gen = generator("绝不能跑到这里");
    const thumbnail = await after.get("id-1", MD5_A, gen.generate);

    expect(gen.calls).toEqual([]);
    expect(thumbnail.data.toString()).toBe("webp:A");
    expect(thumbnail.width).toBe(64);
    expect(thumbnail.height).toBe(48);
  });

  it("条目名就是源素材的 md5：同一份内容换个 ID / 换个项目也命中", async () => {
    const store = new ThumbnailStore(dir, log);
    await store.get("project:A/Assets/images/x.png", MD5_A, generator("A").generate);

    const gen = generator("绝不能跑到这里");
    await store.get("project:B/Assets/images/y.png", MD5_A, gen.generate);

    expect(gen.calls).toEqual([]);
  });

  it("内存层挤掉之后仍能从磁盘拿到（磁盘是那条兜底的路）", async () => {
    const store = new ThumbnailStore(dir, log);
    // 内存层上限 96：塞满 97 条，最早那条（id-0）会被挤出去
    for (let index = 0; index <= 96; index += 1) {
      await store.get(`id-${index}`, md5Of(index), generator(`g${index}`).generate);
    }

    // 把它那条**磁盘**条目删掉：若它还在内存层，这一次就不会再生成
    const entries = await readdir(dir);
    await rm(join(dir, entries.find((name) => name.startsWith(md5Of(0)))!), { force: true });

    const gen = generator("regenerated");
    await store.get("id-0", md5Of(0), gen.generate);
    expect(gen.calls).toEqual(["regenerated"]);
  });
});

describe("缩略图缓存：干净收场", () => {
  it("磁盘写不进去（目录位置被文件占了）：结果照常返回，只记一条日志", async () => {
    // 在缓存目录的位置放一个**文件**：`mkdir` 必失败
    await writeFile(dir, "占位");

    const store = new ThumbnailStore(dir, log);
    const thumbnail = await store.get("id-1", MD5_A, generator("A").generate);

    expect(thumbnail.data.toString()).toBe("webp:A");
    expect(logs.some((message) => message.includes("缩略图缓存写入失败"))).toBe(true);
  });
});

describe("缩略图缓存：磁盘淘汰", () => {
  it("条目数超上限：按 mtime 删最旧的，新写的那条留着", async () => {
    // 与实现同口径：512 条封顶（一张几 KB，512 条也就几 MB）
    const limit = 512;
    await mkdir(dir, { recursive: true });

    const base = Date.now() - 600_000;
    for (let index = 0; index < limit + 10; index += 1) {
      const file = join(dir, `${md5Of(index)}-32x32.webp`);
      await writeFile(file, "old");
      // mtime 拉开 1 秒：index 越大越新，好断言「删掉的是最旧那批」
      const stamp = new Date(base + index * 1000);
      await utimes(file, stamp, stamp);
    }

    const store = new ThumbnailStore(dir, log);
    await store.get("id-1", MD5_A, generator("A").generate);

    const left = await readdir(dir);
    expect(left.length).toBeLessThanOrEqual(limit);
    expect(left).not.toContain(`${md5Of(0)}-32x32.webp`);
    expect(left.some((name) => name.startsWith(MD5_A))).toBe(true);
  });
});
