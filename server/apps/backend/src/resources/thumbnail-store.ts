import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "../values";

/**
 * 缩略图的**两级缓存**：内存（进程内热点）+ 磁盘（跨重启）。
 *
 * 为什么要有磁盘这一层：缩略图是**派生数据**——一张小 WebP 要读原始素材、跑一次 sharp；
 * 视频还得先落临时文件让 ffmpeg 抽首帧。只有内存缓存的话，后端一重启（开发时 `tsx watch`
 * 改一行就重启一次）就得把整个素材面板的缩略图重算一遍，视频那段尤其慢。
 *
 * 磁盘条目**按内容寻址**（文件名就是源素材的 md5）：内容没变就永远命中，内容一变自动换
 * 名字、旧条目由 `sweep` 淘汰——不需要另写一套「失效」逻辑；同一份素材被两个项目引用时
 * 也共用一条（md5 是内容的指纹，与落在哪无关）。
 *
 * 缓存出任何问题（写不进去 / 读坏了）都**只记日志**，绝不拖垮这一次请求：它只是加速。
 */

/** 一张生成好的缩略图。宽高是**源素材**的（不是这张小图的）——编辑器按它排版。 */
export interface Thumbnail {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * 磁盘条目名：`<源素材 md5>-<宽>x<高>.webp`。
 *
 * 宽高写进**文件名**是为了读的时候不用再解一次图，也不用另挂一份索引文件。
 */
const ENTRY_PATTERN = /^([0-9a-f]{32})-(\d+)x(\d+)\.webp$/;

/** 内存热点层：条数封顶，命中挪到队尾、超了挤掉队首。 */
const MEMORY_MAX_ENTRIES = 96;

/** 磁盘层：条目数封顶，超了按 mtime 删最旧的（一张几 KB，512 条也就几 MB）。 */
const DISK_MAX_ENTRIES = 512;

/** 原子写的临时后缀（必须同目录，`rename` 才同卷）。 */
const TEMP_SUFFIX = ".dts-tmp";

export class ThumbnailStore {
  /** 内存层按**资源 ID**索引（一个 ID 对应一份内容），值里带 md5 好判断内容换没换。 */
  private readonly memory = new Map<string, { readonly md5: string; readonly thumbnail: Thumbnail }>();

  /**
   * 正在生成的活，按 **md5** 去重（不是按资源 ID）：同一份内容被两张贴图引用时共用一次生成，
   * 也就不会两个请求同时往同一个条目文件里写。
   */
  private readonly jobs = new Map<string, Promise<Thumbnail>>();

  /** 临时文件名的自增序号（同一进程内不重名）。 */
  private seq = 0;

  constructor(
    /** 缓存目录（不存在会按需创建）；放哪由 `config.ts` 决定。 */
    private readonly dir: string,
    /** 缓存层的日志（写入失败这类**不该影响请求**的毛病走这里）。 */
    private readonly log: (message: string) => void,
  ) {}

  /**
   * 取一张缩略图：**内存 → 磁盘 → `generate()`**。
   *
   * `md5` 是源素材的指纹，调用方本来就要读一次字节、顺手算好；`generate` 只在两级都没
   * 命中时调用，且同一份内容的并发请求只调一次。`generate` 抛错会原样传给调用方
   * （缓存不吞业务错误）。
   */
  async get(id: string, md5: string, generate: () => Promise<Thumbnail>): Promise<Thumbnail> {
    const hit = this.memory.get(id);
    if (hit !== undefined && hit.md5 === md5) {
      // 命中挪到队尾（LRU）；`Map` 保持插入顺序，队首就是最久没用的
      this.memory.delete(id);
      this.memory.set(id, hit);
      return hit.thumbnail;
    }

    let job = this.jobs.get(md5);
    if (job === undefined) {
      job = this.load(md5, generate);
      this.jobs.set(md5, job);
    }

    try {
      const thumbnail = await job;
      this.remember(id, md5, thumbnail);
      return thumbnail;
    } finally {
      if (this.jobs.get(md5) === job) {
        this.jobs.delete(md5);
      }
    }
  }

  /** 磁盘先试；没有才生成，生成完落盘（落盘失败也只是少一条缓存）。 */
  private async load(md5: string, generate: () => Promise<Thumbnail>): Promise<Thumbnail> {
    const cached = await this.readDisk(md5);
    if (cached !== undefined) {
      return cached;
    }

    const thumbnail = await generate();
    await this.writeDisk(md5, thumbnail);
    return thumbnail;
  }

  private remember(id: string, md5: string, thumbnail: Thumbnail): void {
    this.memory.delete(id);
    this.memory.set(id, { md5, thumbnail });
    if (this.memory.size > MEMORY_MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) {
        this.memory.delete(oldest);
      }
    }
  }

  /** 读磁盘条目；目录还没有 / 条目不在 / 读坏了，一律当**没命中**，交给重新生成。 */
  private async readDisk(md5: string): Promise<Thumbnail | undefined> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      // 目录还不存在（一次都没写过）：最正常不过的「没命中」
      return undefined;
    }

    const name = names.find((item) => item.startsWith(`${md5}-`) && item.endsWith(".webp"));
    if (name === undefined) {
      return undefined;
    }

    const parsed = ENTRY_PATTERN.exec(name);
    if (parsed === null) {
      return undefined;
    }

    try {
      const data = await readFile(join(this.dir, name));
      return { data, width: Number(parsed[2]), height: Number(parsed[3]) };
    } catch {
      // 刚好被清掉 / 权限不对：当没命中
      return undefined;
    }
  }

  /**
   * 写磁盘条目：**同目录临时文件 + rename** 的原子写（与 `fs-provider` 的 `writeAtomically`
   * 同一套理由——读者要么看到旧内容、要么看到完整的新内容，不会看到写了一半的图）。
   * 写不进去只记一条日志：缓存是加速，不是功能。
   */
  private async writeDisk(md5: string, thumbnail: Thumbnail): Promise<void> {
    const name = `${md5}-${thumbnail.width}x${thumbnail.height}.webp`;
    const temp = join(
      this.dir,
      `${name}.${process.pid.toString(36)}-${(this.seq += 1).toString(36)}${TEMP_SUFFIX}`,
    );

    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temp, thumbnail.data);
      await rename(temp, join(this.dir, name));
    } catch (error) {
      // 内容寻址：目标多半是别人先写好的同一份内容，不影响这次结果
      this.log(`缩略图缓存写入失败（${name}）：${messageOf(error)}`);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }

    await this.sweep();
  }

  /** 条目数超了就按 mtime 删最旧的（缓存而已，删错了下次重算）；清理失败不影响这次请求。 */
  private async sweep(): Promise<void> {
    try {
      const names = await readdir(this.dir);
      if (names.length <= DISK_MAX_ENTRIES) {
        return;
      }

      const stamped: { name: string; mtimeMs: number }[] = [];
      for (const name of names) {
        try {
          const info = await stat(join(this.dir, name));
          stamped.push({ name, mtimeMs: info.mtimeMs });
        } catch {
          // 刚好被别处删了：跳过
        }
      }

      stamped.sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const entry of stamped.slice(0, stamped.length - DISK_MAX_ENTRIES)) {
        await rm(join(this.dir, entry.name), { force: true }).catch(() => {});
      }
    } catch {
      // 目录读不了：这次不清理，下次再说
    }
  }
}
