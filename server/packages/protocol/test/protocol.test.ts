import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  clientToServerSchema,
  createRequestId,
  editorToServerSchema,
  parseClientToServer,
  parseEditorToServer,
  parseJsonMessage,
  parseServerToClient,
  parseServerToEditor,
  sceneSchema,
  serverToClientSchema,
  type ScenePayload,
} from "../src/messages";

/** 一份最小可用场景：一个地图对象 + 一个精灵对象 + 一个声音对象。 */
function sampleScene(): ScenePayload {
  return {
    name: "场景1",
    objects: [
      {
        id: "map_01",
        name: "地图",
        kind: "Map",
        active: true,
        locked: false,
        sortingOrder: -10,
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        components: [],
        map: {
          image: { id: "project:测试项目/Assets/images/场景1.png", width: 1920, height: 1080 },
          grid: { width: 64, height: 36 },
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, 2304]] },
        },
      },
      {
        id: "sprite_01",
        name: "木门",
        kind: "SceneObject",
        active: false,
        locked: false,
        sortingOrder: 0,
        position: { x: -345, y: 118 },
        rotation: 0,
        scale: 1.5,
        components: [],
        image: { id: "project:测试项目/Assets/images/door.png", width: 128, height: 256 },
      },
      {
        id: "sound_01",
        name: "脚步",
        kind: "PlaySound",
        active: true,
        locked: false,
        sortingOrder: 0,
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        components: [],
        sound: {
          clips: ["project:测试项目/Assets/audio/step1.mp3"],
          picked: "project:测试项目/Assets/audio/step1.mp3",
          layer: "sfx",
        },
      },
    ],
  };
}

describe("协议：场景（镜像的那份对象数据）", () => {
  it("接住文档模型里的对象：地图 / 精灵 / 声音", () => {
    const scene = sceneSchema.parse(sampleScene());
    expect(scene.objects).toHaveLength(3);
    expect(scene.objects[1]?.position).toEqual({ x: -345, y: 118 });
    expect(scene.objects[1]?.active).toBe(false);
    expect(scene.objects[1]?.image?.width).toBe(128);
    expect(scene.objects[2]?.sound?.layer).toBe("sfx");
  });

  it("传送阵（动作对象）也接得住：kind 是字符串、teleport 是「候选 + 选中的那个」", () => {
    const withTeleport = sceneSchema.parse({
      name: "s",
      objects: [
        {
          ...(sampleScene().objects[0] as Record<string, unknown>),
          id: "teleport_01",
          name: "传送阵",
          kind: "Teleport",
          teleport: { targets: ["Map002", "Map003"], picked: "Map003" },
        },
        // 还没勾任何目标的传送阵（`targets: []`）同样合法
        {
          ...(sampleScene().objects[0] as Record<string, unknown>),
          id: "teleport_02",
          name: "传送阵 2",
          kind: "Teleport",
          teleport: { targets: [] },
        },
      ],
    });

    expect(withTeleport.objects[0]?.teleport).toEqual({
      targets: ["Map002", "Map003"],
      picked: "Map003",
    });
    expect(withTeleport.objects[1]?.teleport).toEqual({ targets: [] });
  });

  it("position 允许 null（还没落位的对象）", () => {
    const scene = sceneSchema.parse({
      name: "s",
      objects: [
        {
          id: "a",
          name: "a",
          kind: "SceneObject",
          active: true,
          sortingOrder: 0,
          position: null,
          rotation: 0,
          scale: 1,
        },
      ],
    });

    expect(scene.objects[0]?.position).toBeNull();
  });

  it("单轴缩放（v11）是可选的：带与不带都能解析，且原样传给前端", () => {
    // 不带：老编辑器 / 等比对象——协议必须照旧收下（**不能**因为缺字段就报错，
    // 那会让所有旧前端与旧文件都连不上）
    const uniform = sceneSchema.parse({
      name: "s",
      objects: [
        {
          id: "a",
          name: "a",
          kind: "SceneObject",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 2,
        },
      ],
    });
    expect(uniform.objects[0]?.scaleX).toBeUndefined();
    expect(uniform.objects[0]?.scaleY).toBeUndefined();

    // 带上：新编辑器发得出，前端按需取用（旧前端忽略它们，只看到等比 `scale`）
    const perAxis = sceneSchema.parse({
      name: "s",
      objects: [
        {
          id: "a",
          name: "a",
          kind: "SceneObject",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          scaleX: 4,
          scaleY: 0.25,
        },
      ],
    });
    expect(perAxis.objects[0]?.scaleX).toBe(4);
    expect(perAxis.objects[0]?.scaleY).toBe(0.25);
  });

  it("编辑器侧的额外字段不报错（前端按需取用）", () => {
    const parsed = sceneSchema.parse({
      name: "s",
      objects: [
        {
          id: "a",
          name: "a",
          kind: "SceneObject",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [{ id: "c1", type: "OptionValue", data: { currentOption: "关" }, actions: [] }],
        },
      ],
    });

    expect(parsed.objects[0]?.components).toHaveLength(1);
  });

  it("网格尺寸必须是正整数、rowOrder 只认 bottom-up", () => {
    const bad = sampleScene();
    bad.objects[0]!.map!.grid = { width: 0, height: 36 };
    expect(() => sceneSchema.parse(bad)).toThrow(/校验失败|too_small|Invalid/);

    const bad2 = sampleScene();
    (bad2.objects[0]!.map as { rowOrder: string }).rowOrder = "top-down";
    expect(() => sceneSchema.parse(bad2)).toThrow(/校验失败|Invalid/);
  });
});

describe("协议：编辑器 → 服务端", () => {
  it("hello / 运行态开关 / 订阅", () => {
    expect(parseEditorToServer({ type: "editor_hello", protocolVersion: PROTOCOL_VERSION }).type).toBe(
      "editor_hello",
    );
    expect(parseEditorToServer({ type: "runtime_start" }).type).toBe("runtime_start");
    expect(parseEditorToServer({ type: "runtime_stop" }).type).toBe("runtime_stop");
    expect(parseEditorToServer({ type: "editor_refresh" }).type).toBe("editor_refresh");
  });

  it("scene_push 推整份场景，也允许 null（没有打开的场景）", () => {
    const pushed = parseEditorToServer({ type: "scene_push", scene: sampleScene() });
    expect(pushed.type).toBe("scene_push");
    expect(pushed.type === "scene_push" && pushed.scene?.objects).toHaveLength(3);

    const cleared = parseEditorToServer({ type: "scene_push", scene: null });
    expect(cleared.type === "scene_push" && cleared.scene).toBeNull();
  });

  it("editor_command 只带触发器，不带数据", () => {
    const play = parseEditorToServer({
      type: "editor_command",
      requestId: "snd-1",
      command: { kind: "play_sound", objectId: "sound_01", layer: "sfx" },
    });

    expect(play.type).toBe("editor_command");
    if (play.type === "editor_command") {
      expect(play.command).toEqual({ kind: "play_sound", objectId: "sound_01", layer: "sfx" });
      // 命令里没有 clips：前端从镜像里的那个对象读 picked
      expect(JSON.stringify(play.command)).not.toContain("clips");
    }

    const stop = parseEditorToServer({
      type: "editor_command",
      requestId: "snd-2",
      command: { kind: "stop_sound", layer: "voice" },
    });
    expect(stop.type).toBe("editor_command");
  });

  it("拒绝旧模型的消息（整层删除，不再兼容）", () => {
    for (const legacy of [
      { type: "request_join" },
      { type: "heartbeat" },
      { type: "register_map_objects", mapName: "Map001" },
      { type: "report_player_position", playerId: "p", position: { x: 0, y: 0 }, mapName: "m" },
      { type: "register_actions", objectId: "o", componentId: "c", actions: [] },
      { type: "action_result", requestId: "r", objectId: "o", actionId: "a", ok: true },
    ]) {
      expect(() => parseClientToServer(legacy)).toThrow(/校验失败/);
    }

    for (const legacy of [
      { type: "invoke_action", requestId: "r", objectId: "o", actionId: "a" },
      { type: "set_option", objectId: "o", option: "开" },
      { type: "sync_state", state: { currentMap: "", players: {}, objects: {} } },
    ]) {
      expect(() => parseEditorToServer(legacy)).toThrow(/校验失败/);
    }
  });

  it("拒绝未知类型、缺字段与非法层级", () => {
    expect(() => parseEditorToServer({ type: "nope" })).toThrow(/校验失败/);
    expect(() => parseEditorToServer({ type: "scene_push" })).toThrow(/校验失败/);
    expect(() =>
      parseEditorToServer({
        type: "editor_command",
        requestId: "r",
        command: { kind: "play_sound", objectId: "o", layer: "music" },
      }),
    ).toThrow(/校验失败/);
    expect(() =>
      parseEditorToServer({ type: "editor_command", requestId: "", command: { kind: "stop_sound", layer: "sfx" } }),
    ).toThrow(/校验失败/);
  });
});

describe("协议：前端 → 服务端", () => {
  it("client_hello / command_result / pong", () => {
    const hello = parseClientToServer({
      type: "client_hello",
      protocolVersion: PROTOCOL_VERSION,
      name: "DiceTale Unity",
      version: "1.0.0",
    });
    expect(hello.type).toBe("client_hello");

    const result = parseClientToServer({
      type: "command_result",
      requestId: "snd-1",
      ok: false,
      reason: "前端尚未实现 play_sound",
    });
    expect(result.type).toBe("command_result");

    expect(parseClientToServer({ type: "pong", seq: 3 }).type).toBe("pong");
  });

  it("前端不再上报对象 / 玩家 / 位置（没有这种消息了）", () => {
    for (const gone of [
      { type: "register_map_objects", mapName: "m" },
      { type: "register_players", players: [] },
      { type: "report_object_position", objectId: "o", position: { x: 0, y: 0 }, mapName: "m" },
      { type: "request_teleport", mapName: "m", spawnId: "s" },
    ]) {
      expect(() => parseClientToServer(gone)).toThrow(/校验失败/);
    }
  });

  it("command_result 缺 requestId 或 ok 时被拒（回执必须能对上号）", () => {
    expect(() => parseClientToServer({ type: "command_result", ok: true })).toThrow(/校验失败/);
    expect(() => parseClientToServer({ type: "command_result", requestId: "r" })).toThrow(/校验失败/);
  });

  it("resources_ready：成功与失败都收，字段缺失被拒", () => {
    const ready = parseClientToServer({
      type: "resources_ready",
      project: "测试项目",
      fingerprint: "398ff8e23aada15d",
      fileCount: 14,
      bytes: 39_765_209,
      ok: true,
    });
    expect(ready.type).toBe("resources_ready");
    if (ready.type === "resources_ready") {
      expect(ready.project).toBe("测试项目");
      expect(ready.fileCount).toBe(14);
      expect(ready.bytes).toBe(39_765_209);
      expect(ready.reason).toBeUndefined();
    }

    const failed = parseClientToServer({
      type: "resources_ready",
      project: "测试项目",
      fingerprint: "398ff8e23aada15d",
      fileCount: 0,
      bytes: 0,
      ok: false,
      reason: "解压资源包失败：CRC 校验失败",
    });
    expect(failed.type === "resources_ready" && failed.reason).toMatch(/CRC/);

    // 指纹是「本地这份是哪一版」的依据，缺了就没法判断，必须拒
    expect(() =>
      parseClientToServer({ type: "resources_ready", project: "p", fileCount: 0, bytes: 0, ok: true }),
    ).toThrow(/校验失败/);
    expect(() => parseClientToServer({ type: "resources_ready", fingerprint: "f", ok: true })).toThrow(
      /校验失败/,
    );
  });
});

describe("协议：服务端 → 前端", () => {
  it("server_hello / scene_sync / command / ping", () => {
    expect(
      parseServerToClient({ type: "server_hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s1", serverTime: 1 })
        .type,
    ).toBe("server_hello");

    const sync = parseServerToClient({ type: "scene_sync", scene: sampleScene() });
    expect(sync.type).toBe("scene_sync");
    expect(sync.type === "scene_sync" && sync.scene?.name).toBe("场景1");

    const command = parseServerToClient({
      type: "command",
      requestId: "r1",
      command: { kind: "play_sound", objectId: "sound_01", layer: "sfx" },
    });
    expect(command.type).toBe("command");

    expect(parseServerToClient({ type: "ping", seq: 1 }).type).toBe("ping");
  });

  it("scene_sync 允许 null（编辑器没打开场景 → 前端清空镜像）", () => {
    const cleared = parseServerToClient({ type: "scene_sync", scene: null });
    expect(cleared.type === "scene_sync" && cleared.scene).toBeNull();
  });
});

describe("协议：服务端 → 编辑器", () => {
  it("editor_state 带运行态、前端信息与场景摘要", () => {
    const state = parseServerToEditor({
      type: "editor_state",
      runtimeActive: true,
      client: { name: "DiceTale Unity", version: "1.0.0", connectedAt: 123 },
      scene: { name: "场景1", objectCount: 3, updatedAt: 456 },
      resources: null,
      serverTime: 789,
    });

    expect(state.type).toBe("editor_state");
    if (state.type === "editor_state") {
      expect(state.client?.name).toBe("DiceTale Unity");
      expect(state.scene?.objectCount).toBe(3);
    }
  });

  it("没前端 / 没场景时 client 与 scene 都是 null", () => {
    const state = parseServerToEditor({
      type: "editor_state",
      runtimeActive: false,
      client: null,
      scene: null,
      resources: null,
      serverTime: 1,
    });
    expect(state.type === "editor_state" && state.client).toBeNull();
    expect(state.type === "editor_state" && state.resources).toBeNull();
  });

  it("editor_state 带上前端的资源包状态（就绪 / 失败）", () => {
    const ready = parseServerToEditor({
      type: "editor_state",
      runtimeActive: true,
      client: null,
      scene: null,
      resources: {
        project: "测试项目",
        fingerprint: "abc123",
        fileCount: 12,
        bytes: 37_000_000,
        ok: true,
        at: 1,
      },
      serverTime: 2,
    });
    expect(ready.type === "editor_state" && ready.resources?.fileCount).toBe(12);

    const failed = parseServerToEditor({
      type: "editor_state",
      runtimeActive: true,
      client: null,
      scene: null,
      resources: {
        project: "测试项目",
        fingerprint: "abc123",
        fileCount: 0,
        bytes: 0,
        ok: false,
        at: 3,
        reason: "zip 解压失败",
      },
      serverTime: 4,
    });
    expect(failed.type === "editor_state" && failed.resources?.reason).toBe("zip 解压失败");
  });

  it("editor_command_result / editor_log / editor_error", () => {
    expect(
      parseServerToEditor({ type: "editor_command_result", requestId: "r", ok: true, effects: ["已播放"] }).type,
    ).toBe("editor_command_result");
    expect(parseServerToEditor({ type: "editor_log", level: "info", message: "前端已连接", time: "10:00:00" }).type).toBe(
      "editor_log",
    );
    expect(parseServerToEditor({ type: "editor_error", reason: "前端未连接" }).type).toBe("editor_error");
    expect(() => parseServerToEditor({ type: "editor_log", level: "debug", message: "x", time: "t" })).toThrow(
      /校验失败/,
    );
  });
});

describe("协议：JSON 解析与请求 id", () => {
  it("非法 JSON 抛出可读错误", () => {
    expect(() => parseJsonMessage("{不是 json")).toThrow(/不是合法 JSON/);
  });

  it("请求 id 唯一", () => {
    const first = createRequestId("snd");
    const second = createRequestId("snd");
    expect(first).not.toBe(second);
    expect(first.startsWith("snd-")).toBe(true);
  });

  it("三端 schema 都是判别式联合（未知 type 直接拒）", () => {
    expect(() => clientToServerSchema.parse({ type: "x" })).toThrow();
    expect(() => serverToClientSchema.parse({ type: "x" })).toThrow();
    expect(() => editorToServerSchema.parse({ type: "x" })).toThrow();
  });
});
