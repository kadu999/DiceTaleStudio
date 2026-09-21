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

  it("战争雾的总开关（v13）：缺省算开（老场景只有 regions），关着时原样传给前端", () => {
    const mapObject = sampleScene().objects[0] as Record<string, unknown>;
    const parseWithFog = (fog: unknown): ReturnType<typeof sceneSchema.parse> =>
      sceneSchema.parse({
        name: "s",
        objects: [{ ...mapObject, map: { ...(mapObject.map as Record<string, unknown>), fog } }],
      });

    // 老场景（协议 v3 及更早）里只有 regions：「有 fog」就等于「开着」
    expect(parseWithFog({ regions: [8] }).objects[0]?.map?.fog).toEqual({
      enabled: true,
      regions: [8],
    });

    // 编辑器关掉了：前端看到的就是关着（**不是**建了再藏起来）
    expect(parseWithFog({ enabled: false, regions: [8] }).objects[0]?.map?.fog).toEqual({
      enabled: false,
      regions: [8],
    });
  });

  it("视频（v14）：列表 / 选中 / 循环 / 声音原样传给前端；显示名不进协议", () => {
    const mapObject = sampleScene().objects[0] as Record<string, unknown>;
    const clip = "project:测试项目/Assets/video/opening.mp4";

    const parsed = sceneSchema.parse({
      name: "s",
      objects: [
        {
          ...mapObject,
          video: { clips: [clip], picked: clip, names: { [clip]: "开场" }, loop: true, audio: true },
        },
      ],
    });

    expect(parsed.objects[0]?.video).toEqual({
      // 总开关缺省算开（与文档 schema 同一口径）
      enabled: true,
      clips: [clip],
      picked: clip,
      loop: true,
      audio: true,
    });

    // 老编辑器（还没这个字段）不发，前端的 `video` 就是 undefined（= 这个对象不放视频）
    expect(sceneSchema.parse(sampleScene()).objects[0]?.video).toBeUndefined();

    // 手写的少写几个开关：默认开着、不循环、静音
    const minimal = sceneSchema.parse({
      name: "s",
      objects: [{ ...mapObject, video: { clips: [clip] } }],
    });
    expect(minimal.objects[0]?.video).toEqual({ enabled: true, clips: [clip], loop: false, audio: false });

    // 关掉总开关：原样传给前端（前端据此连那一层都不建）
    const disabled = sceneSchema.parse({
      name: "s",
      objects: [{ ...mapObject, video: { enabled: false, clips: [clip], picked: clip } }],
    });
    expect(disabled.objects[0]?.video).toEqual({
      enabled: false,
      clips: [clip],
      picked: clip,
      loop: false,
      audio: false,
    });
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

  it("战争雾：擦除只发轨迹（不是整张遮罩），整区开关带区域位", () => {
    const stroke = {
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.25 },
      ],
      radius: 0.05,
      softness: 1,
    };

    const erase = parseEditorToServer({
      type: "editor_command",
      requestId: "fog-1",
      command: { kind: "erase_mask", objectId: "map_01", stroke },
    });

    expect(erase.type).toBe("editor_command");
    if (erase.type === "editor_command") {
      expect(erase.command).toEqual({ kind: "erase_mask", objectId: "map_01", stroke });
      // 命令里**没有**雾数据：没有格子、没有贴图、没有位图
      const wire = JSON.stringify(erase.command);
      expect(wire).not.toContain("cells");
      expect(wire).not.toContain("image");
      expect(wire).not.toContain("regions");
    }

    const region = parseEditorToServer({
      type: "editor_command",
      requestId: "fog-2",
      command: { kind: "reveal_fog_region", objectId: "map_01", region: 8, revealed: false },
    });
    expect(region.type).toBe("editor_command");
    if (region.type === "editor_command") {
      expect(region.command).toEqual({
        kind: "reveal_fog_region",
        objectId: "map_01",
        region: 8,
        revealed: false,
      });
    }
  });

  it("声音（v6）：暂停 / 继续按**层级**给（同层只响一条，所以暂停这一层 = 暂停当前那条）", () => {
    for (const kind of ["pause_sound", "resume_sound"] as const) {
      const parsed = parseEditorToServer({
        type: "editor_command",
        requestId: `sound-${kind}`,
        command: { kind, layer: "bgm" },
      });

      expect(parsed.type).toBe("editor_command");
      if (parsed.type === "editor_command") {
        // 命令里**没有数据**：只有层级（响的是哪一条由前端从镜像里读）
        expect(parsed.command).toEqual({ kind, layer: "bgm" });
        expect(JSON.stringify(parsed.command)).not.toContain("clips");
      }
    }

    // 层级只认四档，别的值 / 缺字段都拒
    for (const command of [
      { kind: "pause_sound", layer: "bogus" },
      { kind: "pause_sound" },
      { kind: "resume_sound", layer: "" },
    ] as const) {
      expect(() =>
        parseEditorToServer({ type: "editor_command", requestId: "sound-bad", command }),
      ).toThrow();
    }
  });

  it("视频（v5）：四条命令都只带 objectId（放哪一条 / 循环 / 声音在对象数据里）", () => {
    for (const kind of ["play_video", "pause_video", "resume_video", "stop_video"] as const) {
      const parsed = parseEditorToServer({
        type: "editor_command",
        requestId: `video-${kind}`,
        command: { kind, objectId: "map_01" },
      });

      expect(parsed.type).toBe("editor_command");
      if (parsed.type === "editor_command") {
        // 命令里**没有**视频数据：没有 clip、没有循环 / 声音开关
        expect(parsed.command).toEqual({ kind, objectId: "map_01" });
        const wire = JSON.stringify(parsed.command);
        expect(wire).not.toContain("clips");
        expect(wire).not.toContain("loop");
      }
    }
  });

  it("视频：缺 objectId / 空 id 都拒（畸形结构不进管线）", () => {
    for (const command of [
      { kind: "play_video" },
      { kind: "play_video", objectId: "" },
      { kind: "stop_video", objectId: "" },
      { kind: "pause_video" },
    ] as const) {
      expect(() =>
        parseEditorToServer({ type: "editor_command", requestId: "video-bad", command }),
      ).toThrow();
    }
  });

  it("战争雾：空轨迹 / 非有限数 / 缺字段都拒（畸形结构不进管线）", () => {
    const cases: unknown[] = [
      // 空轨迹：前端会拒（一笔至少要一个点），后端先挡，别白转发一条无效笔画
      { kind: "erase_mask", objectId: "map_01", stroke: { points: [], radius: 0.05, softness: 1 } },
      // 半径 / 软边必须是有限的数（zod 4 的 z.number() 不收 NaN 与 Infinity）
      {
        kind: "erase_mask",
        objectId: "map_01",
        stroke: { points: [{ x: 0, y: 0 }], radius: Number.POSITIVE_INFINITY, softness: 1 },
      },
      {
        kind: "erase_mask",
        objectId: "map_01",
        stroke: { points: [{ x: 0, y: 0 }], radius: 0.05, softness: Number.NaN },
      },
      // 少了整笔
      { kind: "erase_mask", objectId: "map_01" },
      // 点不是 {x, y}
      {
        kind: "erase_mask",
        objectId: "map_01",
        stroke: { points: [{ x: 0 }], radius: 0.05, softness: 1 },
      },
      // 整区开关少了 revealed / region 不是整数
      { kind: "reveal_fog_region", objectId: "map_01", region: 1 },
      { kind: "reveal_fog_region", objectId: "map_01", region: 1.5, revealed: true },
    ];

    for (const command of cases) {
      expect(() => parseEditorToServer({ type: "editor_command", requestId: "fog-3", command })).toThrow(
        /校验失败/,
      );
    }
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
