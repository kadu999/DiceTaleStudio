import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_META_FORMAT_VERSION,
  DOCUMENT_FORMAT_VERSION,
  createEmptyProject,
  emptyAssetMetas,
  type AssetMetaDoc,
} from "@dts/document";
import {
  assetIdOfMetaId,
  assetMetaIdOf,
  projectAssetId,
  projectFileId,
  projectSceneFileId,
} from "@dts/resources";
import { metaHistory } from "../src/state/store-core";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";
import { assetMetaDoc } from "./asset-meta-fixtures";

/**
 * **每个素材旁边一份 `.meta`**（v24 的口径）：打开项目 / 刷新资源树时，还没有 meta 的素材
 * 各生成一份（`importer` 按路径判定）并**立刻落盘**；已经有的那份**一个字节都不动**。
 *
 * 为什么值得单独钉住：这是 v24 引入的一个**写盘动作**——在此之前「打开项目」是只读的，
 * 现在它会往盘上写文件。两种错法都要命：
 * - **写多了**：把 `Assets/config/x.json` 这种非素材也补一份，项目里会慢慢长出一堆没人认领的
 *   `.meta`（而且它们还是「看不见的孤儿」）；
 * - **写重了**：每次打开都重写一遍 = GUID 换了 = 素材身份换了，场景 / 属性里所有引用一起断
 *   （这正是 v23 引入 `.meta` 要解决的问题）。
 *
 * 走真链路：`openProject` / `refreshTree` 打桩 `fetch`（与 `run-mode.test.ts` 同一套）。
 * 假后端**会记住写进去的东西**——下一次 `/api/projects/meta` 读得到刚写的那一份，
 * 于是「已有的不动」这条才验得出来（否则第二次读回来还是空的，实现会被逼着重写一遍）。
 */

const PROJECT = "Meta";

const IMAGE = `project:${PROJECT}/Assets/images/a.png`;
const AUDIO = `project:${PROJECT}/Assets/audio/b.mp3`;
const VIDEO = `project:${PROJECT}/Assets/video/c.mp4`;
const SCENE = `project:${PROJECT}/Assets/scenes/Map001.json`;
/** 项目自己的配置：**不是素材**，不该配 meta。 */
const CONFIG = `project:${PROJECT}/Assets/config/x.json`;
/** 文本文件（`.md` 那种）：同样不是素材。 */
const README = `project:${PROJECT}/Assets/readme.md`;
/** 旧工程文件的 `audioMeta` 里留着、但盘上已经没有的那个文件（孤儿键）。 */
const GONE = `project:${PROJECT}/Assets/audio/deleted.mp3`;

const ALL_FILES = [
  "Assets/images/a.png",
  "Assets/audio/b.mp3",
  "Assets/video/c.mp4",
  "Assets/scenes/Map001.json",
  "Assets/config/x.json",
  "Assets/readme.md",
] as const;

/** 按项目内相对路径铺一棵资源树（中间目录按路径补出来）。 */
function treeOf(paths: readonly string[]): ResourceTreeNode[] {
  const assets: ResourceTreeNode = {
    name: "Assets",
    path: "Assets",
    id: projectAssetId(PROJECT, "Assets"),
    type: "folder",
    children: [],
  };

  for (const path of paths) {
    const segments = path.split("/");
    let parent = assets;
    for (let depth = 1; depth < segments.length; depth += 1) {
      const sub = segments.slice(0, depth + 1).join("/");
      const existing = (parent.children ?? []).find((child) => child.path === sub);
      if (existing !== undefined) {
        parent = existing;
        continue;
      }

      const isFile = depth === segments.length - 1;
      const node: ResourceTreeNode = {
        name: segments[depth] as string,
        path: sub,
        id: projectAssetId(PROJECT, sub),
        type: isFile ? "file" : "folder",
        ...(isFile ? {} : { children: [] }),
      };
      parent.children?.push(node);
      parent = node;
    }
  }

  return [assets];
}

/** 假后端：`PUT` **真的落进盘上**，所以下一次 `/api/projects/meta` 读得到刚写的那一份。 */
interface FakeBackend {
  /** 盘上的素材 meta（模拟后端 `/api/projects/meta` 的返回）。 */
  readonly metas: Record<string, unknown>;
  /** 写过的资源 ID → 写进去的文本（Map 保持写入顺序）。 */
  readonly writes: Map<string, string>;
  /** 换一棵资源树（模拟「在编辑器外面把文件加进来」）。 */
  setTree(tree: readonly ResourceTreeNode[]): void;
  setText(id: string, text: string): void;
}

function stubBackend(input: {
  readonly tree: readonly ResourceTreeNode[];
  readonly metas?: Readonly<Record<string, unknown>>;
  /** 盘上的工程文件原文（缺省是一份当前版本的干净工程文件）。 */
  readonly projectText?: string;
}): FakeBackend {
  let tree = input.tree;
  const metas: Record<string, unknown> = { ...input.metas };
  const writes = new Map<string, string>();
  // 按资源 ID 读得到的东西：工程文件与场景文件（`loadScenes` 要读后者）
  const texts = new Map<string, string>([
    [
      projectFileId(PROJECT),
      input.projectText ?? `${JSON.stringify(createEmptyProject(PROJECT), null, 2)}\n`,
    ],
    [
      SCENE,
      `${JSON.stringify({ formatVersion: DOCUMENT_FORMAT_VERSION, objects: [] }, null, 2)}\n`,
    ],
  ]);

  const respond = (body: string): unknown => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  });

  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const id = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("id") ?? "";
    if ((init?.method ?? "GET") !== "GET") {
      const body = typeof init?.body === "string" ? init.body : "";
      writes.set(id, body);
      const assetId = id.length === 0 ? undefined : assetIdOfMetaId(id);
      if (assetId === undefined) {
        texts.set(id, body);
      } else {
        // 后端把 `.meta` 写进文件：下一次读回来就是这一份（内容一模一样，一个字节没动过）
        metas[assetId] = JSON.parse(body) as unknown;
      }

      return Promise.resolve(respond("{}"));
    }

    if (url.startsWith("/api/projects/tree")) {
      return Promise.resolve(respond(JSON.stringify({ tree })));
    }

    if (url.startsWith("/api/projects/meta")) {
      return Promise.resolve(respond(JSON.stringify({ metas })));
    }

    return Promise.resolve(respond(texts.get(id) ?? ""));
  });

  return {
    metas,
    writes,
    setTree(next) {
      tree = next;
    },
    setText(id, text) {
      texts.set(id, text);
    },
  };
}

/** 写进去的那份 meta（没写就是 `null`，断言时一眼看得出「有没有写」）。 */
const written = (backend: FakeBackend, id: string): AssetMetaDoc | null =>
  JSON.parse(backend.writes.get(assetMetaIdOf(id)) ?? "null") as AssetMetaDoc | null;

afterEach(() => {
  vi.unstubAllGlobals();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  // 素材 meta 是**第三条轨道**：不重置它，上一条用例的表会漏到下一条
  metaHistory.reset({});
  useEditorStore.setState({
    assetMetaTable: {},
    assetMetas: emptyAssetMetas(),
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: null,
    mode: "edit",
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
});

describe("打开项目：缺 meta 的素材各补一份", () => {
  it("按路径判定种类（图片 / 音频 / 视频 / 场景）并落盘；配置与文本不生成", async () => {
    const backend = stubBackend({ tree: treeOf(ALL_FILES) });

    await expect(useEditorStore.getState().openProject(PROJECT)).resolves.toBe(true);

    expect(written(backend, IMAGE)?.importer).toBe("texture");
    expect(written(backend, AUDIO)?.importer).toBe("audio");
    expect(written(backend, VIDEO)?.importer).toBe("video");
    expect(written(backend, SCENE)?.importer).toBe("scene");

    // 新 GUID + 当前 meta 格式版本：写出去的那一份是自描述的
    for (const id of [IMAGE, AUDIO, VIDEO, SCENE]) {
      expect(written(backend, id)?.formatVersion).toBe(ASSET_META_FORMAT_VERSION);
      expect(written(backend, id)?.guid).toMatch(/^[0-9a-f]{32}$/);
    }

    // **就这四份**：`Assets/config/x.json` 与 `.md` 不是素材（`.json` 只有在
    // `Assets/scenes/` 里才算场景），不该长出一份没人认领的 meta
    expect([...backend.writes.keys()].sort()).toEqual(
      [assetMetaIdOf(IMAGE), assetMetaIdOf(AUDIO), assetMetaIdOf(VIDEO), assetMetaIdOf(SCENE)].sort(),
    );

    // 装配进 store 的表也该有它们（面板 / 校验 / 推送读的是这一份）
    const table = useEditorStore.getState().assetMetaTable;
    expect(table[IMAGE]?.importer).toBe("texture");
    expect(table[SCENE]?.importer).toBe("scene");
    expect(table[CONFIG]).toBeUndefined();
    expect(table[README]).toBeUndefined();
  });

  it("已经有 meta 的素材：一个字节都不动（guid 照旧，不重写盘）", async () => {
    const existing = assetMetaDoc({ importer: "texture", sequence: 7 });
    const backend = stubBackend({ tree: treeOf(ALL_FILES), metas: { [IMAGE]: existing } });

    await expect(useEditorStore.getState().openProject(PROJECT)).resolves.toBe(true);

    // 盘上那份没被碰过，内存里也是同一份（连 guid 都没换）
    expect(backend.writes.has(assetMetaIdOf(IMAGE))).toBe(false);
    expect(backend.metas[IMAGE]).toEqual(existing);
    expect(useEditorStore.getState().assetMetaTable[IMAGE]).toEqual(existing);
    // 别的三份照旧补上
    expect([...backend.writes.keys()].sort()).toEqual(
      [assetMetaIdOf(AUDIO), assetMetaIdOf(VIDEO), assetMetaIdOf(SCENE)].sort(),
    );
  });
});

describe("旧工程文件（v23）：audioMeta 搬进各素材自己的 .meta", () => {
  it("搬出来的那份立刻落盘；找不到素材的孤儿键丢弃并写一条说明", async () => {
    // v23 的工程文件：音频标注还住在工程文件里（`audioTags` 已经是整数表）
    const legacy = {
      ...createEmptyProject(PROJECT),
      formatVersion: 23,
      audioTags: ["战斗"],
      audioMeta: {
        [AUDIO]: { name: "开场曲", tags: [0] },
        [GONE]: { name: "删掉的那首" },
      },
    };
    const backend = stubBackend({
      tree: treeOf(ALL_FILES),
      projectText: `${JSON.stringify(legacy, null, 2)}\n`,
    });

    await expect(useEditorStore.getState().openProject(PROJECT)).resolves.toBe(true);

    // 标注按路径搬进那个文件自己的 `.meta`（标签 ID 过了表）并落盘；装配进 store 的是同一份
    expect(written(backend, AUDIO)?.importer).toBe("audio");
    expect(written(backend, AUDIO)?.audio).toEqual({ name: "开场曲", tags: [0] });
    expect(useEditorStore.getState().assetMetaTable[AUDIO]?.audio).toEqual({
      name: "开场曲",
      tags: [0],
    });

    // 孤儿键（工程文件里指着一条已经不在树里的素材）：**丢弃**并说清是哪一个——
    // 不猜它属于谁，也不给一份没有归属的素材写 `.meta`
    expect(backend.writes.has(assetMetaIdOf(GONE))).toBe(false);
    const logs = useEditorStore.getState().runtime.logs.map((entry) => entry.message);
    expect(logs.some((line) => line.includes("孤儿") && line.includes(GONE))).toBe(true);

    // 搬过一次的工程文件本身也回写一次：版本号前进，`audioMeta` 从文件里消失（`audioTags` 留下）
    const projectText = backend.writes.get(projectFileId(PROJECT));
    expect(projectText).toBeDefined();
    expect(projectText).not.toContain("audioMeta");
    expect(projectText).toContain("audioTags");
  });
});

describe("刷新资源树：新加的素材补一份，已有的不动", () => {
  it("依次刷新两次：第二次只写新出现的那一张图，先前生成的 guid 不变", async () => {
    const backend = stubBackend({ tree: treeOf(["Assets/audio/b.mp3"]) });
    // 刷新走的是「项目已经打开」这条路（`project.current` 是它的入口条件）
    useEditorStore.setState({
      project: { list: [], current: PROJECT, tree: [], busy: false, error: "" },
    });

    await useEditorStore.getState().refreshTree(true);

    const firstGuid = useEditorStore.getState().assetMetaTable[AUDIO]?.guid;
    expect(firstGuid).toMatch(/^[0-9a-f]{32}$/);
    expect([...backend.writes.keys()]).toEqual([assetMetaIdOf(AUDIO)]);

    // 在编辑器外面拷了一张图进来：再刷新一次，补的是它
    backend.setTree(treeOf(["Assets/audio/b.mp3", "Assets/images/a.png"]));
    await useEditorStore.getState().refreshTree(true);

    expect([...backend.writes.keys()].slice(1)).toEqual([assetMetaIdOf(IMAGE)]);
    // 音频那份**一个字节都没重写**：guid 还是第一次那个
    // （重写一次 = 素材换了个身份，场景里所有引用一起断）
    expect(useEditorStore.getState().assetMetaTable[AUDIO]?.guid).toBe(firstGuid);
    expect(backend.metas[AUDIO]).toEqual(useEditorStore.getState().assetMetaTable[AUDIO]);
  });

  it("素材外部改名后按 GUID 迁移 meta 键、选择状态和场景引用到新路径", async () => {
    const oldImage = IMAGE;
    const newImage = projectAssetId(PROJECT, "Assets/images/renamed.png");
    const guid = "ab".repeat(16);
    const oldMeta = assetMetaDoc({
      importer: "texture",
      sequence: 17,
      sprite: { mode: "Multiple", sheet: { columns: 4, rows: 2 } },
    });
    const projectWithOldImage = {
      ...createEmptyProject(PROJECT),
    };
    const backend = stubBackend({
      tree: treeOf(["Assets/images/a.png", "Assets/scenes/Map001.json"]),
      metas: { [oldImage]: { ...oldMeta, guid } },
    });
    backend.setText(
      SCENE,
      `${JSON.stringify({
        formatVersion: DOCUMENT_FORMAT_VERSION,
        objects: [
          {
            id: "sprite-1",
            name: "sprite",
            kind: "Sprite",
            active: true,
            sortingOrder: 0,
            locked: false,
            position: null,
            rotation: 0,
            scale: 1,
            components: [
              {
                id: "sprite-1__SpriteLayer",
                type: "SpriteLayer",
                data: { id: guid, width: 64, height: 32 },
                actions: [],
              },
            ],
          },
        ],
      }, null, 2)}\n`,
    );
    useEditorStore.setState({
      doc: projectWithOldImage,
      project: { list: [], current: PROJECT, tree: treeOf(["Assets/images/a.png", "Assets/scenes/Map001.json"]), busy: false, error: "" },
      selectedAssetId: oldImage,
    });

    await useEditorStore.getState().refreshTree(true);
    expect(useEditorStore.getState().scenes[0]?.objects[0]?.components[0]?.data).toMatchObject({
      id: oldImage,
    });

    backend.setTree(treeOf(["Assets/images/renamed.png", "Assets/scenes/Map001.json"]));
    delete backend.metas[oldImage];
    backend.metas[newImage] = { ...oldMeta, guid };
    backend.setText(
      SCENE,
      `${JSON.stringify({
        formatVersion: DOCUMENT_FORMAT_VERSION,
        objects: [
          {
            id: "sprite-1",
            name: "sprite",
            kind: "Sprite",
            active: true,
            sortingOrder: 0,
            locked: false,
            position: null,
            rotation: 0,
            scale: 1,
            components: [
              {
                id: "sprite-1__SpriteLayer",
                type: "SpriteLayer",
                data: { id: guid, width: 64, height: 32 },
                actions: [],
              },
            ],
          },
        ],
      }, null, 2)}\n`,
    );

    expect(await useEditorStore.getState().refreshTree(true)).toBe(true);
    const image = useEditorStore.getState().scenes[0]?.objects[0]?.components[0]?.data as {
      id: string;
      guid?: string;
    };
    expect(image).toMatchObject({ id: newImage, guid });
    expect(useEditorStore.getState().assetMetaTable[newImage]?.sprite?.sheet).toEqual({
      columns: 4,
      rows: 2,
    });
    expect(useEditorStore.getState().assetMetaTable[oldImage]).toBeUndefined();
    expect(useEditorStore.getState().selectedAssetId).toBe(newImage);
    expect(useEditorStore.getState().project.tree.flatMap((node) => node.children ?? []).flatMap((node) => node.children ?? []).map((node) => node.id)).toContain(newImage);
    expect(useEditorStore.getState().project.tree.flatMap((node) => node.children ?? []).flatMap((node) => node.children ?? []).map((node) => node.id)).not.toContain(oldImage);
    expect(projectSceneFileId(PROJECT, "Map001")).toBe(SCENE);
  });
});
