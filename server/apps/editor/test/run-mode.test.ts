import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_FORMAT_VERSION,
  createAssetMeta,
  createAssetMetas,
  createEmptyProject,
  createGridMapObject,
  createGameObject,
  type GameObjectDoc,
} from "@dts/document";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";
import { FakeSocket, connect, editorState, sentTypes } from "./helpers/fake-socket";

/**
 * **运行态下的改动不保存、退出运行即还原**（对齐 Unity 的播放模式）。
 *
 * 在这里钉的是这台状态机最容易错的三条边：
 *
 * 1. 运行中改的东西（隐藏 / 位置）退出运行要**整体还原**，而且**一个字节都不写盘**；
 * 2. 编辑器完全可能在服务端**已经开着运行态**时才拿到文档（刷新后接回去、开第二个窗口、
 *    运行中装载项目）——基线必须跟着文档走，否则退出运行会把文档还原成别的项目或一片空白；
 * 3. 与服务端**断线不等于关闸**：断线时若把「在运行」当成「没在运行」，运行期间的改动会被
 *    当成编辑态的改动写进文件，退出运行的还原也一起丢了。
 *
 * 用一只**假的 WebSocket** 走真链路（`runtime_start` → `editor_state` → 编辑 → `runtime_stop`），
 * 所以 RuntimeClient 的收发、store 的状态机都在覆盖范围内；后端用 `fetch` 打桩，
 * 写盘（`PUT /api/resources/text`）会被记下来——「一个字节都没写」就是这么验的。
 */

const PROJECT = "Demo";
const SCENE = "Map001";
const OTHER_SCENE = "Map002";
const DOOR = "door";

/** 编辑器推下去的场景（按顺序）：`scene_push` 的载荷，用来验「切场景有没有推」。 */
const scenePushes = (socket: FakeSocket): Array<{ name?: string } | null> =>
  socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; scene?: { name?: string } | null })
    .filter((message) => message.type === "scene_push")
    .map((message) => message.scene ?? null);

/** 后端调用记录：写盘就是 `PUT`（这个用例集里唯一要防的事）。 */
type BackendCalls = string[] & { readonly writesById: Map<string, string> };

function stubBackend(files: Readonly<Record<string, string>> = {}): BackendCalls {
  const calls: string[] = [];
  const writesById = new Map<string, string>();

  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${input}`);

    const text = method === "GET" ? (files[input] ?? "") : "";
    if (method !== "GET") {
      const id = new URL(input, "http://localhost").searchParams.get("id");
      if (id !== null && typeof init?.body === "string") writesById.set(id, init.body);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    });
  });

  return Object.assign(calls, { writesById });
}

const writes = (calls: readonly string[]): string[] =>
  calls.filter((call) => !call.startsWith("GET "));

const sceneFileId = (project: string, scene = SCENE): string =>
  `project:${project}/Assets/scenes/${scene}.json`;

const readUrl = (id: string): string => `/api/resources/text?id=${encodeURIComponent(id)}`;

/** 场景文件的内容（形状与编辑器写出去的一致，装载时不会因为缺字段被重写）。 */
function sceneFileText(objects: readonly GameObjectDoc[]): string {
  return `${JSON.stringify({ formatVersion: DOCUMENT_FORMAT_VERSION, objects }, null, 2)}\n`;
}

/** 项目树里的 `Assets/scenes/`（`loadScenes` 就是从这里找场景文件的）。 */
function scenesTree(project: string, scenes: readonly string[]): ResourceTreeNode[] {  return [
    {
      name: "Assets",
      path: "Assets",
      id: `project:${project}/Assets`,
      type: "folder",
      children: [
        {
          name: "scenes",
          path: "Assets/scenes",
          id: `project:${project}/Assets/scenes`,
          type: "folder",
          children: scenes.map((scene) => ({
            name: `${scene}.json`,
            path: `Assets/scenes/${scene}.json`,
            id: sceneFileId(project, scene),
            type: "file" as const,
          })),
        },
      ],
    },
  ];
}

function door(position: { x: number; y: number } = { x: 0, y: 0 }): GameObjectDoc {
  return createGameObject({ id: DOOR, name: "木门", position });
}

/**
 * 打开项目、把场景装载起来（走**真的** `loadScenes`）。
 *
 * 不直接 `setState` 塞进去：装载这一步会把「磁盘上的样子」记下来（未保存改动的判据），
 * 少了它，用例里的文档天生就是「脏」的，「一个字节都没写盘」根本验不出来。
 *
 * 返回后端调用记录（写盘 = `PUT`）。
 */
async function seedScene(
  objects: readonly GameObjectDoc[],
  sceneNames: readonly string[] = [SCENE],
): Promise<BackendCalls> {
  const files: Record<string, string> = {};
  for (const name of sceneNames) {
    files[readUrl(sceneFileId(PROJECT, name))] = sceneFileText(name === SCENE ? objects : []);
  }

  const calls = stubBackend(files);
  // 工程文件也按**真实流程**装一次（`openProject` 就是 `resetDoc` + `loadScenes`）：
  // v15 起全局设置住在 `project.json` 里，「有没有未保存改动」同样拿磁盘上的样子比
  // （少了这一步，用例里的工程文件天生是「脏」的，退出运行会顺手写一次盘）
  useEditorStore.getState().resetDoc(createEmptyProject(PROJECT));
  useEditorStore.setState({
    project: {
      list: [],
      current: PROJECT,
      tree: scenesTree(PROJECT, sceneNames),
      busy: false,
      error: "",
    },
  });
  await useEditorStore.getState().loadScenes();
  useEditorStore.setState({ selectedObjectIds: [DOOR] });
  return calls;
}

const objectOf = (id: string): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

/** 运行态里那两下改动：隐藏 + 挪到 x=500。 */
function hideAndMove(): void {
  useEditorStore.getState().setObjectActive(DOOR, false);
  useEditorStore.getState().moveObject(DOOR, { x: 500, y: 0 });
}

/**
 * 把挂着的定时器都推完再收尾。
 *
 * 去抖落盘、去抖推送、重连都是定时器：不推完就断言「没写盘」，等于什么都没验——
 * 真要有「运行中偷偷存一下」，它正好躲在还没到点的那个定时器里。
 */
const flushTimers = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(5_000);
};

beforeEach(() => {
  // 时间由测试掌控：重连 / 去抖都不会自己冒出来
  vi.useFakeTimers();
  FakeSocket.instances.length = 0;
});

afterEach(() => {
  // 关掉假连接（RuntimeClient 会因此把 socket 置空，下一条用例才能重新连）
  for (const socket of FakeSocket.instances) {
    socket.close();
  }

  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();

  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    sceneSaveState: "saved",
    project: { list: [], current: null, tree: [], busy: false, error: "" },
    runtime: {
      status: "idle",
      statusDetail: "",
      runtimeActive: false,
      client: null,
      scene: null,
      resources: null,
      settings: null,
      logs: [],
      lastError: "",
    },
  });
});

describe("运行中的改动：不保存、退出即还原", () => {
  it("loads old path references and migrates the scene file to GUIDs", async () => {
    const imageId = `project:${PROJECT}/Assets/images/Map001.png`;
    const meta = createAssetMeta("texture");
    const map = createGridMapObject({
      id: "map-1",
      name: "map",
      image: { id: imageId, width: 64, height: 64 },
      grid: { width: 8, height: 8 },
    });
    const calls = await seedScene([map]);
    useEditorStore.setState({ assetMetas: createAssetMetas([{ id: imageId, meta }]) });

    await useEditorStore.getState().loadScenes();

    const write = calls.find((call) => call.startsWith("PUT "));
    expect(write).toBeDefined();
    const sceneUrl = readUrl(sceneFileId(PROJECT));
    expect(write).toContain(sceneUrl);
    const storedText = calls.writesById.get(sceneFileId(PROJECT));
    expect(storedText).toBeDefined();
    expect(storedText).toContain(meta.guid);
    expect(storedText).not.toContain(imageId);
  });

  it("隐藏 + 挪位置：运行中界面上生效，点「编辑」后原样还回来（一个字节都没写盘）", async () => {
    const calls = await seedScene([door()]);
    const socket = connect();

    // 点「运行」：声明开闸 → 服务端广播运行态 → 当前场景整份推下去
    useEditorStore.getState().setMode("run");
    expect(sentTypes(socket)).toContain("runtime_start");
    socket.receive(editorState({ runtimeActive: true }));

    expect(useEditorStore.getState().mode).toBe("run");
    expect(useEditorStore.getState().sceneSaveState).toBe("runtime");
    expect(sentTypes(socket)).toContain("scene_push");

    hideAndMove();
    expect(objectOf(DOOR)?.active).toBe(false);
    expect(objectOf(DOOR)?.position).toEqual({ x: 500, y: 0 });

    // 点「编辑」：关闸 → 服务端广播 → 文档整体还原
    useEditorStore.getState().setMode("edit");
    expect(sentTypes(socket)).toContain("runtime_stop");
    socket.receive(editorState({ runtimeActive: false }));

    expect(useEditorStore.getState().mode).toBe("edit");
    expect(objectOf(DOOR)?.active).toBe(true);
    expect(objectOf(DOOR)?.position).toEqual({ x: 0, y: 0 });

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });

  it("运行期间的编辑不进撤销栈：退出运行后撤销栈是空的", async () => {
    await seedScene([door()]);
    const socket = connect();
    socket.receive(editorState({ runtimeActive: true }));

    hideAndMove();
    expect(useEditorStore.getState().canUndo).toBe(true);

    socket.receive(editorState({ runtimeActive: false }));
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(useEditorStore.getState().canRedo).toBe(false);
  });

  it("运行中按「保存」也不写盘（手动保存同样拦下）", async () => {
    const calls = await seedScene([door()]);
    const socket = connect();
    socket.receive(editorState({ runtimeActive: true }));

    hideAndMove();

    await expect(useEditorStore.getState().saveSceneNow()).resolves.toBe(false);
    expect(useEditorStore.getState().sceneSaveState).toBe("runtime");

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });
});

describe("切场景 = DM 的「换台」：运行态下立刻推", () => {
  it("运行中切到另一个场景：多推一条 `scene_push`，带的是新场景名（不等去抖）", async () => {
    await seedScene([door()], [SCENE, OTHER_SCENE]);
    const socket = connect();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true }));
    expect(scenePushes(socket).map((scene) => scene?.name)).toEqual([SCENE]);

    useEditorStore.getState().openScene(OTHER_SCENE);

    // **不推进定时器**就该看得见：切场景是「必须马上到」的动作（去抖 200ms 对现场太慢）
    expect(scenePushes(socket).map((scene) => scene?.name)).toEqual([SCENE, OTHER_SCENE]);
    expect(useEditorStore.getState().runtime.runtimeActive).toBe(true);
  });

  it("编辑态切场景不推（没有运行态就没有流量）", async () => {
    await seedScene([door()], [SCENE, OTHER_SCENE]);
    const socket = connect();

    useEditorStore.getState().openScene(OTHER_SCENE);

    expect(scenePushes(socket)).toEqual([]);
  });

  it("「下一场」走的是**展示顺序**，到端点不循环", async () => {
    await seedScene([door()], [SCENE, OTHER_SCENE, "Map003"]);
    expect(useEditorStore.getState().activeSceneName).toBe(SCENE);

    expect(useEditorStore.getState().openAdjacentScene(1)).toBe(true);
    expect(useEditorStore.getState().activeSceneName).toBe(OTHER_SCENE);
    expect(useEditorStore.getState().openAdjacentScene(1)).toBe(true);
    expect(useEditorStore.getState().activeSceneName).toBe("Map003");

    // 到末尾：什么都不做，也**不绕回第一场**（绕回去比没反应更让人摸不着头脑）
    expect(useEditorStore.getState().openAdjacentScene(1)).toBe(false);
    expect(useEditorStore.getState().activeSceneName).toBe("Map003");

    expect(useEditorStore.getState().openAdjacentScene(-1)).toBe(true);
    expect(useEditorStore.getState().activeSceneName).toBe(OTHER_SCENE);
  });

  it("按序号直选：第 2 格就是第 2 个场景（0 基越界返回 false）", async () => {
    await seedScene([door()], [SCENE, OTHER_SCENE, "Map003"]);

    expect(useEditorStore.getState().openSceneByIndex(2)).toBe(true);
    expect(useEditorStore.getState().activeSceneName).toBe("Map003");

    expect(useEditorStore.getState().openSceneByIndex(3)).toBe(false);
    expect(useEditorStore.getState().activeSceneName).toBe("Map003");
  });
});

describe("运行基线跟着文档走", () => {
  it("连上时服务端就已经在运行（刷新 / 第二个窗口）：退出运行照样还原", async () => {
    const calls = await seedScene([door()]);
    const socket = connect();

    // 刷新后接回去：服务端还开着运行态，这只页面手上没有任何基线
    socket.receive(editorState({ runtimeActive: true }));

    hideAndMove();
    socket.receive(editorState({ runtimeActive: false }));

    expect(objectOf(DOOR)?.active).toBe(true);
    expect(objectOf(DOOR)?.position).toEqual({ x: 0, y: 0 });

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });

  it("运行中才装载文档：退出运行还原到**装载进来的样子**，不是一片空白", async () => {
    const calls = stubBackend({ [readUrl(sceneFileId(PROJECT))]: sceneFileText([door()]) });

    // 连上时服务端就已经在运行，而此刻还没打开任何项目（手上是空文档）
    const socket = connect();
    socket.receive(editorState({ runtimeActive: true }));
    expect(useEditorStore.getState().scenes).toEqual([]);

    // 运行中装载项目：`loadScenes` 把文档整份换掉，基线要跟着换
    useEditorStore.setState((state) => ({
      project: { ...state.project, current: PROJECT, tree: scenesTree(PROJECT, [SCENE]) },
    }));
    await useEditorStore.getState().loadScenes();

    expect(useEditorStore.getState().scenes).toHaveLength(1);
    expect(useEditorStore.getState().sceneSaveState).toBe("runtime");

    hideAndMove();
    socket.receive(editorState({ runtimeActive: false }));

    expect(useEditorStore.getState().scenes).toHaveLength(1);
    expect(objectOf(DOOR)?.active).toBe(true);
    expect(objectOf(DOOR)?.position).toEqual({ x: 0, y: 0 });

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });

  it("运行中关掉项目：退出运行不会把上一个项目的场景又还原回来", async () => {
    const calls = await seedScene([door()]);
    const socket = connect();
    socket.receive(editorState({ runtimeActive: true }));

    useEditorStore.getState().closeProject();
    await useEditorStore.getState().loadScenes();
    expect(useEditorStore.getState().scenes).toEqual([]);

    socket.receive(editorState({ runtimeActive: false }));

    expect(useEditorStore.getState().scenes).toEqual([]);

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });
});

describe("运行中的文件操作与断线", () => {
  it("场景的新建 / 改名 / 删除在运行态下一律挡住（那些是文件操作，还原不回来）", async () => {
    const calls = await seedScene([door()]);
    const socket = connect();
    socket.receive(editorState({ runtimeActive: true }));

    await expect(useEditorStore.getState().createScene("新场景")).resolves.toContain("运行态下不能");
    await expect(useEditorStore.getState().renameScene("别的名字")).resolves.toContain("运行态下不能");
    // 只剩一个场景时也该说「先退出运行」，而不是「至少要保留一个场景」
    await expect(useEditorStore.getState().deleteScene()).resolves.toContain("运行态下不能");

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });

  it("运行中与服务端断线：运行态不清零，运行中的改动也不会被当成编辑写盘", async () => {
    const calls = await seedScene([door()]);
    const socket = connect();
    socket.receive(editorState({ runtimeActive: true }));

    hideAndMove();
    socket.close();

    expect(useEditorStore.getState().runtime.status).toBe("closed");
    expect(useEditorStore.getState().runtime.runtimeActive).toBe(true);
    expect(useEditorStore.getState().sceneSaveState).toBe("runtime");
    // 「前端在不在 / 推的是哪份场景」确实无从得知了，但那两样跟运行态是两回事
    expect(useEditorStore.getState().runtime.client).toBeNull();
    expect(useEditorStore.getState().runtime.scene).toBeNull();

    await expect(useEditorStore.getState().saveSceneNow()).resolves.toBe(false);

    await flushTimers();
    expect(writes(calls)).toEqual([]);
  });

  it("服务端重启后重连：场景内容没变，再点运行也要重推（不吃去重，否则前端拿到空场景）", async () => {
    await seedScene([door()]);
    const socket = connect();

    // 第一次运行：服务端开闸 → 推一份
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true }));
    expect(scenePushes(socket).map((scene) => scene?.name)).toEqual([SCENE]);

    // 服务端重启：连接断掉，重连后回一份「没在运行」。本地关闸并还原文档，
    // 场景内容与第一次推的那一份一模一样（这正是会被去重跳过的情况）。
    socket.close();
    const reconnected = connect();
    reconnected.receive(editorState({ runtimeActive: false }));
    expect(useEditorStore.getState().mode).toBe("edit");

    // 再点运行：必须真的重推——重启后的服务端缓存是空的，跳过就等于给前端一份空场景
    useEditorStore.getState().setMode("run");
    reconnected.receive(editorState({ runtimeActive: true }));
    expect(scenePushes(reconnected).map((scene) => scene?.name)).toEqual([SCENE]);
  });
});
