import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "@dts/document";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";
import { FakeSocket, connect, editorState, parsedSent, sentTypes } from "./helpers/fake-socket";

/**
 * **背景音乐与项目设置解耦**（v16）在 store 这一层的完整链路。
 *
 * 用一只假的 WebSocket 走真链路（`runtime_start` → `editor_state` → 命令），后端用 `fetch` 打桩，
 * 所以「推了什么、写了什么盘」都是可断言的事实。要钉住的五件事：
 *
 * 1. **设置里只剩三档音量**：进运行态推 `settings_push`，载荷里**没有任何歌单 / 默认曲字段**；
 * 2. **进运行态不会自动出声**（没有默认曲这回事了）：前端连上、资源包就绪，命令列表仍是空的；
 * 3. DM 点一首 → `play_bgm{clip}`（同一首再来一次也真发）；暂停 / 继续 / 停止各一条；
 * 4. 前端（重）连上 → 补发记账里的那一首（暂停态先放再暂停）；点过停止就什么都不补；
 * 5. 退出运行态：音量**还原到进入运行前的样子**，播放记账清零。
 */

const PROJECT = "Demo";

/** 发出去的命令（按顺序）：`editor_command` 里的 command 节点。 */
const sentCommands = (socket: FakeSocket): Array<Record<string, unknown>> =>
  parsedSent(socket)
    .filter((message) => message.type === "editor_command")
    .map((message) => message.command as Record<string, unknown>);

/** 资源包就绪的回执（前端把 `Assets/` 下完之后报的那一条）。 */
const RESOURCES_READY = {
  project: PROJECT,
  fingerprint: "fp",
  fileCount: 3,
  bytes: 1024,
  ok: true,
  at: 1,
} as const;

const CLIENT = { name: "DiceTale Unity", version: "0.1.0", connectedAt: 1 } as const;

/** 后端打桩：记下 `PUT`（写盘）与 `GET`（读盘）的完整路径（带 query，好区分场景 / 工程文件）。 */
function stubBackend(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url, "http://localhost");
    calls.push(`${init?.method ?? "GET"} ${parsed.pathname}${parsed.search}`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const writes = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith("PUT"));

/** 写工程文件（`project.json`）的那几次——场景文件写盘不算。 */
const projectWrites = (calls: readonly string[]): string[] =>
  writes(calls).filter((call) => call.includes("project.json"));

const TREE: readonly ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: `project:${PROJECT}/Assets`,
    type: "folder",
    children: [
      { name: "audio", path: "Assets/audio", id: `project:${PROJECT}/Assets/audio`, type: "folder" },
      { name: "scenes", path: "Assets/scenes", id: `project:${PROJECT}/Assets/scenes`, type: "folder" },
    ],
  },
];

const TRACK_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const TRACK_B = `project:${PROJECT}/Assets/audio/battle.wav`;

/** 装载一个项目（工程文件走 `resetDoc`，与 `openProject` 同一个入口）。 */
function seedProject(volume = 0.6): { readonly calls: string[]; readonly socket: FakeSocket } {
  const calls = stubBackend();
  const doc = createEmptyProject(PROJECT);

  useEditorStore.getState().resetDoc({
    ...doc,
    settings: {
      audio: {
        bgm: { volume },
        sfx: { volume: 0.8 },
        voice: { volume: 1 },
      },
    },
  });
  useEditorStore.setState({
    project: { list: [], current: PROJECT, tree: [...TREE], busy: false, error: "" },
  });
  // 场景也装一个（`scene_push` 的去重是按内容比的：没有场景就什么都不推）
  sceneHistory.reset([{ name: "Map001", objects: [] }]);
  useEditorStore.setState({ activeSceneName: "Map001" });

  return { calls, socket: connect() };
}

const bgmOf = (): ReturnType<typeof useEditorStore.getState>["doc"]["settings"]["audio"]["bgm"] =>
  useEditorStore.getState().doc.settings.audio.bgm;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances.length = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  // 关掉这只假连接：`RuntimeClient.connect` 对「还开着」的连接是空操作，
  // 不关的话下一条用例拿到的还是上一只 socket（`sent` 会串台）
  FakeSocket.instances.at(-1)?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();

  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    sceneSaveState: "saved",
    projectSaveState: "saved",
    bgmPlayback: { clip: null, paused: false },
    bgmDialog: false,
    globalSettings: false,
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

describe("推设置：只剩三档音量", () => {
  it("进运行态推一份设置，且**排在场景前面**；载荷里没有任何歌单 / 默认曲字段", () => {
    const { socket } = seedProject();

    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true }));

    const types = sentTypes(socket);
    expect(types).toContain("settings_push");
    expect(types).toContain("scene_push");
    expect(types.indexOf("settings_push")).toBeLessThan(types.indexOf("scene_push"));

    const pushed = parsedSent(socket).find((message) => message.type === "settings_push");
    const settings = pushed?.settings as { audio: Record<string, Record<string, unknown>> };
    expect(settings.audio.bgm).toEqual({ volume: 0.6 });
    expect(settings.audio.sfx).toEqual({ volume: 0.8 });
    expect(settings.audio.voice).toEqual({ volume: 1 });

    // 歌单 / 默认曲 / 名字 / 循环都不再出现（这就是「与项目设置分离」的可断言版本）
    const serialized = JSON.stringify(settings);
    for (const gone of ["clips", "picked", "names", "loop"]) {
      expect(serialized).not.toContain(gone);
    }
  });

  it("运行中改音量：再推一次（去抖后只有一条）", async () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true }));

    const before = sentTypes(socket).filter((type) => type === "settings_push").length;
    useEditorStore.getState().setBgmVolume(0.2);
    useEditorStore.getState().setSfxVolume(0.3);
    await vi.advanceTimersByTimeAsync(500);

    const pushes = parsedSent(socket).filter((message) => message.type === "settings_push");
    expect(pushes.length).toBeGreaterThan(before);

    const last = pushes.at(-1)?.settings as { audio: { bgm: { volume: number }; sfx: { volume: number } } };
    expect(last.audio.bgm.volume).toBe(0.2);
    expect(last.audio.sfx.volume).toBe(0.3);
  });

  it("编辑态改设置：不推、不立刻写盘；去抖之后写进工程文件", async () => {
    const { calls, socket } = seedProject();

    useEditorStore.getState().setBgmVolume(0.4);
    expect(sentTypes(socket)).not.toContain("settings_push");
    expect(projectWrites(calls)).toEqual([]);
    expect(useEditorStore.getState().projectSaveState).toBe("pending");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(projectWrites(calls)).toEqual(["PUT /api/resources/text?id=project%3ADemo%2Fproject.json"]);
    expect(useEditorStore.getState().projectSaveState).toBe("saved");
  });
});

describe("播放：命令与补发", () => {
  it("进运行态 + 前端连上 + 资源就绪：**一条命令都不发**（不会自动出声）", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));
    socket.receive(editorState({ runtimeActive: true, client: CLIENT, resources: RESOURCES_READY }));

    expect(sentCommands(socket)).toEqual([]);
  });

  it("点一首 → play_bgm{clip}；再点同一首还是真发一条（从头重播）", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    useEditorStore.getState().playBgm(TRACK_A);
    useEditorStore.getState().playBgm(TRACK_A);

    expect(sentCommands(socket)).toEqual([
      { kind: "play_bgm", clip: TRACK_A },
      { kind: "play_bgm", clip: TRACK_A },
    ]);
    expect(useEditorStore.getState().bgmPlayback).toEqual({ clip: TRACK_A, paused: false });
  });

  it("暂停 / 继续 / 停止：各一条对应命令；停止后记账清空", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    useEditorStore.getState().playBgm(TRACK_B);
    useEditorStore.getState().pauseBgm();
    expect(useEditorStore.getState().bgmPlayback).toEqual({ clip: TRACK_B, paused: true });

    useEditorStore.getState().resumeBgm();
    expect(useEditorStore.getState().bgmPlayback).toEqual({ clip: TRACK_B, paused: false });

    useEditorStore.getState().stopBgm();
    expect(useEditorStore.getState().bgmPlayback).toEqual({ clip: null, paused: false });

    expect(sentCommands(socket).slice(1)).toEqual([
      { kind: "pause_bgm" },
      { kind: "resume_bgm" },
      { kind: "stop_bgm" },
    ]);
  });

  it("前端掉线再回来：补发记账里的那一首（暂停态先放再暂停）", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    useEditorStore.getState().playBgm(TRACK_A);
    useEditorStore.getState().pauseBgm();

    // 掉线（前端被踢）→ 重连
    socket.receive(editorState({ runtimeActive: true, client: null }));
    const before = sentCommands(socket).length;
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    expect(sentCommands(socket).slice(before)).toEqual([
      { kind: "play_bgm", clip: TRACK_A },
      { kind: "pause_bgm" },
    ]);
  });

  it("点过停止之后重连：什么都不补（前端是干净的）", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    useEditorStore.getState().playBgm(TRACK_A);
    useEditorStore.getState().stopBgm();

    socket.receive(editorState({ runtimeActive: true, client: null }));
    const before = sentCommands(socket).length;
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    expect(sentCommands(socket).slice(before)).toEqual([]);
  });

  it("前端没连时点一首：只记账 + 写一条「已记录」，等它连上补发", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true }));

    useEditorStore.getState().playBgm(TRACK_B);
    expect(sentCommands(socket)).toEqual([]);
    expect(
      useEditorStore.getState().runtime.logs.some((entry) => entry.message.includes("已记录")),
    ).toBe(true);

    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));
    expect(sentCommands(socket)).toEqual([{ kind: "play_bgm", clip: TRACK_B }]);
  });
});

describe("退出运行态：音量还原、记账清零", () => {
  it("运行态里拖的音量不落盘，退出运行后回到进入前的值", () => {
    const { socket } = seedProject(0.6);
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true, client: CLIENT }));

    useEditorStore.getState().setBgmVolume(0.1);
    expect(bgmOf().volume).toBe(0.1);
    useEditorStore.getState().playBgm(TRACK_A);

    useEditorStore.getState().setMode("edit");
    socket.receive(editorState({ runtimeActive: false }));

    expect(bgmOf().volume).toBe(0.6);
    expect(useEditorStore.getState().bgmPlayback).toEqual({ clip: null, paused: false });
  });

  it("运行态里改的音量不进撤销栈（退出运行后撤销栈是空的）", () => {
    const { socket } = seedProject();
    useEditorStore.getState().setMode("run");
    socket.receive(editorState({ runtimeActive: true }));

    useEditorStore.getState().setBgmVolume(0.3);
    expect(useEditorStore.getState().canUndo).toBe(true);

    socket.receive(editorState({ runtimeActive: false }));
    expect(useEditorStore.getState().canUndo).toBe(false);
  });
});

describe("音量编辑：与场景编辑共用一个撤销入口", () => {
  it("改音量后撤销回到原样，重做再改回去", () => {
    seedProject(0.6);

    useEditorStore.getState().setBgmVolume(0.25);
    expect(bgmOf().volume).toBe(0.25);

    useEditorStore.getState().undo();
    expect(bgmOf().volume).toBe(0.6);
    expect(useEditorStore.getState().redoLabel).toContain("背景音乐音量");

    useEditorStore.getState().redo();
    expect(bgmOf().volume).toBe(0.25);
  });
});
