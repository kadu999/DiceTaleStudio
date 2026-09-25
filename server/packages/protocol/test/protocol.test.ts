import { describe, expect, it } from "vitest";
import {
  COMPONENT_TYPE,
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
  type GameObjectPayload,
  type ScenePayload,
} from "../src/messages";

/**
 * 造一个组件实例（v9：对象特性住在 `components` 里）。
 *
 * id 只要非空即可——协议这一层不解释它（那是编辑器的事）。
 */
function feature(
  type: string,
  data: Record<string, unknown>,
): { id: string; type: string; data: Record<string, unknown> } {
  return { id: `c_${type}`, type, data };
}

/** 从解析后的对象上取某个组件的数据（断言用；协议层不提供访问器）。 */
function featureData(
  object: GameObjectPayload | undefined,
  type: string,
): Record<string, unknown> | undefined {
  return object?.components.find((item) => item.type === type)?.data;
}

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
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        components: [
          feature(COMPONENT_TYPE.map, {
            image: { id: "project:测试项目/Assets/images/场景1.png", width: 1920, height: 1080 },
            grid: { width: 64, height: 36 },
            rowOrder: "bottom-up",
            cells: { encoding: "rle", runs: [[0, 2304]] },
            sortingOrder: -10,
          }),
        ],
      },
      {
        id: "sprite_01",
        name: "木门",
        kind: "Sprite",
        active: false,
        locked: false,
        position: { x: -345, y: 118 },
        rotation: 0,
        scale: 1.5,
        components: [
          feature(COMPONENT_TYPE.image, {
            id: "project:测试项目/Assets/images/door.png",
            width: 128,
            height: 256,
            sortingOrder: 0,
          }),
        ],
      },
      {
        id: "sound_01",
        name: "脚步",
        kind: "PlaySound",
        active: true,
        locked: false,
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        components: [
          feature(COMPONENT_TYPE.sound, {
            clips: ["project:测试项目/Assets/audio/step1.mp3"],
            picked: "project:测试项目/Assets/audio/step1.mp3",
            layer: "sfx",
          }),
        ],
      },
    ],
  };
}

/** 把样例场景的第一个对象（地图）换成「同一个对象、带别的组件」。 */
function mapObjectWith(component: { id: string; type: string; data: Record<string, unknown> }): Record<
  string,
  unknown
> {
  const map = sampleScene().objects[0] as unknown as Record<string, unknown>;
  return { ...map, components: [component] };
}

/**
 * 一个精灵对象，它的 `SpriteLayer` 挂着给定的图片引用（精灵那一组用例用）。
 *
 * v11 起精灵的图住在 `SpriteLayer`、贴图的住在 `ImageLayer`——两者**同一份 schema**，
 * 所以这里换成 `COMPONENT_TYPE.sprite` 也一样收得下（协议不区分对象类型，只认组件名）。
 */
function spriteObjectWith(image: Record<string, unknown>): Record<string, unknown> {
  const sprite = sampleScene().objects[1] as unknown as Record<string, unknown>;
  return { ...sprite, components: [feature(COMPONENT_TYPE.sprite, image)] };
}

describe("协议：场景（镜像的那份对象数据）", () => {
  it("接住文档模型里的对象：地图 / 精灵 / 声音", () => {
    const scene = sceneSchema.parse(sampleScene());
    expect(scene.objects).toHaveLength(3);
    expect(scene.objects[1]?.position).toEqual({ x: -345, y: 118 });
    expect(scene.objects[1]?.active).toBe(false);
    expect(featureData(scene.objects[1], COMPONENT_TYPE.image)?.width).toBe(128);
    expect(featureData(scene.objects[2], COMPONENT_TYPE.sound)?.layer).toBe("sfx");
  });

  it("战争雾（v15 起挂在独立的 `Fog` 对象上）：缺省算开（老视角只有 regions），关着时原样传给前端", () => {
    // v15 起雾是 `components[]` 里的 `FogOfWar` 实例（挂在 `Fog` 对象上）：引用地图 + 总开关 + 雾区
    const parseWithFog = (fog: unknown): ReturnType<typeof sceneSchema.parse> =>
      sceneSchema.parse({
        name: "s",
        objects: [mapObjectWith(feature(COMPONENT_TYPE.fog, fog as Record<string, unknown>))],
      });

    // 老视角（协议 v3 及更早）里只有 regions：「有 fog」就等于「开着」
    expect(featureData(parseWithFog({ regions: [8] }).objects[0], COMPONENT_TYPE.fog)).toEqual({
      mapId: "",
      enabled: true,
      regions: [8],
    });

    // 编辑器关掉了：前端看到的就是关着（**不是**建了再藏起来）
    expect(
      featureData(parseWithFog({ mapId: "map_01", enabled: false, regions: [8] }).objects[0], COMPONENT_TYPE.fog),
    ).toEqual({
      mapId: "map_01",
      enabled: false,
      regions: [8],
    });
  });

  it("视频（v14）：列表 / 选中 / 循环 / 声音原样传给前端；显示名不进协议", () => {
    const clip = "project:测试项目/Assets/video/opening.mp4";

    const parsed = sceneSchema.parse({
      name: "s",
      objects: [
        mapObjectWith(
          feature(COMPONENT_TYPE.video, {
            clips: [clip],
            picked: clip,
            names: { [clip]: "开场" },
            loop: true,
            audio: true,
          }),
        ),
      ],
    });

    expect(featureData(parsed.objects[0], COMPONENT_TYPE.video)).toEqual({
      // 总开关缺省算开（与文档 schema 同一口径）
      enabled: true,
      autoPlay: false,
      clips: [clip],
      picked: clip,
      loop: true,
      audio: true,
    });

    // 老编辑器（还没有这个组件）不发，前端的 `video` 就是 undefined（= 这个对象不放视频）
    expect(featureData(sceneSchema.parse(sampleScene()).objects[1], COMPONENT_TYPE.video)).toBeUndefined();

    // 手写的少写几个开关：默认开着、不循环、静音
    const minimal = sceneSchema.parse({
      name: "s",
      objects: [mapObjectWith(feature(COMPONENT_TYPE.video, { clips: [clip] }))],
    });
    expect(featureData(minimal.objects[0], COMPONENT_TYPE.video)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [clip],
      loop: false,
      audio: false,
    });

    // 关掉总开关：原样传给前端（前端据此连那一层都不建）
    const disabled = sceneSchema.parse({
      name: "s",
      objects: [
        mapObjectWith(feature(COMPONENT_TYPE.video, { enabled: false, clips: [clip], picked: clip })),
      ],
    });
    expect(featureData(disabled.objects[0], COMPONENT_TYPE.video)).toEqual({
      enabled: false,
      autoPlay: false,
      clips: [clip],
      picked: clip,
      loop: false,
      audio: false,
    });
  });

  it("传送阵（动作对象）也接得住：kind 是字符串、Teleport 组件是「候选 + 选中的那个」", () => {
    const base = sampleScene().objects[0] as unknown as Record<string, unknown>;
    const withTeleport = sceneSchema.parse({
      name: "s",
      objects: [
        {
          ...base,
          id: "teleport_01",
          name: "传送阵",
          kind: "Teleport",
          components: [
            feature(COMPONENT_TYPE.teleport, { targets: ["Map002", "Map003"], picked: "Map003" }),
          ],
        },
        // 还没勾任何目标的传送阵（`targets: []`）同样合法
        {
          ...base,
          id: "teleport_02",
          name: "传送阵 2",
          kind: "Teleport",
          components: [feature(COMPONENT_TYPE.teleport, { targets: [] })],
        },
      ],
    });

    expect(featureData(withTeleport.objects[0], COMPONENT_TYPE.teleport)).toEqual({
      targets: ["Map002", "Map003"],
      picked: "Map003",
    });
    expect(featureData(withTeleport.objects[1], COMPONENT_TYPE.teleport)).toEqual({ targets: [] });
  });

  it("position 允许 null（还没落位的对象）", () => {
    const scene = sceneSchema.parse({
      name: "s",
      objects: [
        {
          id: "a",
          name: "a",
          kind: "Sprite",
          active: true,
          position: null,
          rotation: 0,
          scale: 1,
        },
      ],
    });

    expect(scene.objects[0]?.position).toBeNull();
    // 组件缺省给空数组（「什么都没有的对象」是合法状态）
    expect(scene.objects[0]?.components).toEqual([]);
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
          kind: "Sprite",
          active: true,
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
          kind: "Sprite",
          active: true,
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

  it("未知类型都收下（data 宽松，不因新组件把整条消息判非法）", () => {
    const parsed = sceneSchema.parse({
      name: "s",
      objects: [
        {
          id: "a",
          name: "a",
          kind: "Sprite",
          active: true,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            feature("将来的新组件", { whatever: 1 }),
            feature("AnotherCustom", { nested: { a: 1 } }),
          ],
        },
      ],
    });

    expect(parsed.objects[0]?.components).toHaveLength(2);
    expect(featureData(parsed.objects[0], "将来的新组件")?.whatever).toBe(1);
  });

  it("网格尺寸必须是正整数、rowOrder 只认 bottom-up", () => {
    // zod 的 `parse` 抛的是 issue 列表（消息是 JSON），所以这里只要求「确实被拒了」
    const rejected = /校验失败|Invalid|too_small|custom/;

    const bad = sampleScene();
    const badMap = featureData(bad.objects[0], COMPONENT_TYPE.map);
    (badMap as { grid: unknown }).grid = { width: 0, height: 36 };
    expect(() => sceneSchema.parse(bad)).toThrow(rejected);

    const bad2 = sampleScene();
    const badMap2 = featureData(bad2.objects[0], COMPONENT_TYPE.map) as { rowOrder: string };
    badMap2.rowOrder = "top-down";
    expect(() => sceneSchema.parse(bad2)).toThrow(rejected);
  });

  it("精灵（v10）：sprite + spriteGrid 原样传给前端；只有整图时两项都不在", () => {
    const withSprite = sceneSchema.parse({
      name: "s",
      objects: [spriteObjectWith({ id: "project:P/Assets/images/sheet.png", width: 64, height: 64, sprite: { column: 1, row: 0 }, spriteGrid: { columns: 4, rows: 2 } })],
    });
    expect(featureData(withSprite.objects[0], COMPONENT_TYPE.sprite)).toEqual({
      id: "project:P/Assets/images/sheet.png",
      width: 64,
      height: 64,
      sprite: { column: 1, row: 0 },
      spriteGrid: { columns: 4, rows: 2 },
      sortingOrder: 0,
    });

    // v9 那样的整图引用：解析出来只多 v14 的 sortingOrder（前端照旧铺满整张）
    const plain = sceneSchema.parse({
      name: "s",
      objects: [spriteObjectWith({ id: "project:P/Assets/images/sheet.png", width: 64, height: 64 })],
    });
    expect(featureData(plain.objects[0], COMPONENT_TYPE.sprite)).toEqual({
      id: "project:P/Assets/images/sheet.png",
      width: 64,
      height: 64,
      sortingOrder: 0,
    });
  });

  it("精灵：越界的格子被拒（编辑器推送前会夹，所以这是坏载荷）", () => {
    const rejected = /校验失败|Invalid|too_small|custom|超出切分/;

    // column 落在范围外（4 列的图集没有第 4 列）
    expect(() =>
      sceneSchema.parse({
        name: "s",
        objects: [
          spriteObjectWith({
            id: "project:P/Assets/images/sheet.png",
            width: 64,
            height: 64,
            sprite: { column: 4, row: 0 },
            spriteGrid: { columns: 4, rows: 2 },
          }),
        ],
      }),
    ).toThrow(rejected);

    // 只有 sprite、没有 spriteGrid（手写载荷）：收下，但前端算不出 UV，只能当整图——
    // 「两项必须成对」由 `spriteGrid` 的缺省语义兜住（缺 = 1×1 = 整图），不必判整条消息非法
    expect(() =>
      sceneSchema.parse({
        name: "s",
        objects: [
          spriteObjectWith({
            id: "project:P/Assets/images/sheet.png",
            width: 64,
            height: 64,
            sprite: { column: 0, row: 0 },
          }),
        ],
      }),
    ).not.toThrow();

    // 切分本身也受 1..64 约束
    expect(() =>
      sceneSchema.parse({
        name: "s",
        objects: [
          spriteObjectWith({
            id: "project:P/Assets/images/sheet.png",
            width: 64,
            height: 64,
            sprite: { column: 0, row: 0 },
            spriteGrid: { columns: 0, rows: 2 },
          }),
        ],
      }),
    ).toThrow(rejected);
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

    // 层级只认三档（v7 起删掉了环境音），别的值 / 缺字段都拒
    for (const command of [
      { kind: "pause_sound", layer: "bogus" },
      { kind: "pause_sound", layer: "ambient" },
      { kind: "pause_sound" },
      { kind: "resume_sound", layer: "" },
    ] as const) {
      expect(() =>
        parseEditorToServer({ type: "editor_command", requestId: "sound-bad", command }),
      ).toThrow();
    }
  });

  it("全局背景音乐（v7）：play_bgm 带 clip 播 / 切某一条，暂停·继续·停止不带载荷", () => {
    const play = parseEditorToServer({
      type: "editor_command",
      requestId: "bgm-play",
      command: { kind: "play_bgm", clip: "project:P/Assets/audio/theme.mp3" },
    });

    expect(play.type).toBe("editor_command");
    if (play.type === "editor_command") {
      // 与视频 / 声音不同：歌单在**项目设置**里，切歌是运行动作——所以命令里带着要放的那一首
      expect(play.command).toEqual({
        kind: "play_bgm",
        clip: "project:P/Assets/audio/theme.mp3",
      });
    }

    for (const kind of ["pause_bgm", "resume_bgm", "stop_bgm"] as const) {
      const parsed = parseEditorToServer({
        type: "editor_command",
        requestId: `bgm-${kind}`,
        command: { kind },
      });

      expect(parsed.type).toBe("editor_command");
      if (parsed.type === "editor_command") {
        expect(parsed.command).toEqual({ kind });
      }
    }

    // 没有 clip 的 play_bgm 是畸形命令（放哪一首都没说），拒掉
    expect(() =>
      parseEditorToServer({
        type: "editor_command",
        requestId: "bgm-bad",
        command: { kind: "play_bgm" },
      }),
    ).toThrow();
    expect(() =>
      parseEditorToServer({
        type: "editor_command",
        requestId: "bgm-bad",
        command: { kind: "play_bgm", clip: "" },
      }),
    ).toThrow();
  });

  it("项目设置（v8）：settings_push 收整份设置或 null；缺字段的一项也有默认值", () => {
    const pushed = parseEditorToServer({
      type: "settings_push",
      settings: {
        audio: {
          bgm: { volume: 0.25 },
          sfx: { volume: 0.5 },
          voice: { volume: 0.75 },
        },
      },
    });

    expect(pushed.type).toBe("settings_push");
    if (pushed.type === "settings_push") {
      expect(pushed.settings?.audio.bgm.volume).toBe(0.25);
      expect(pushed.settings?.audio.sfx.volume).toBe(0.5);
      // 歌单 / 默认曲 / 名字都不再进协议：背景音乐只剩音量
      const serialized = JSON.stringify(pushed.settings);
      expect(serialized).not.toContain("clips");
      expect(serialized).not.toContain("picked");
      expect(serialized).not.toContain("names");
      expect(serialized).not.toContain("loop");
    }

    // 没有打开项目时推 null（前端据此清掉本地的设置）
    const cleared = parseEditorToServer({ type: "settings_push", settings: null });
    expect(cleared.type === "settings_push" && cleared.settings).toBeNull();

    // 缺字段的音频设置补默认值：三档音量各用缺省（0.6 / 0.8 / 1）
    const sparse = parseEditorToServer({ type: "settings_push", settings: { audio: {} } });
    if (sparse.type !== "settings_push") {
      throw new Error("类型不符");
    }

    expect(sparse.settings?.audio.bgm).toEqual({ volume: 0.6 });
    expect(sparse.settings?.audio.sfx).toEqual({ volume: 0.8 });
    expect(sparse.settings?.audio.voice).toEqual({ volume: 1 });
  });

  it("服务端 → 前端：project_settings 带整份设置或 null", () => {
    const parsed = parseServerToClient({
      type: "project_settings",
      settings: {
        audio: {
          bgm: { volume: 0.6 },
          sfx: { volume: 0.8 },
          voice: { volume: 1 },
        },
      },
    });

    expect(parsed.type).toBe("project_settings");

    const cleared = parseServerToClient({ type: "project_settings", settings: null });
    expect(cleared.type === "project_settings" && cleared.settings).toBeNull();
  });

  it("编辑器状态（v8）：settings 摘要是必填项（没推过给 null），只带推送时间", () => {
    const parsed = parseServerToEditor({
      type: "editor_state",
      runtimeActive: true,
      client: null,
      scene: null,
      resources: null,
      settings: { updatedAt: 1 },
      serverTime: 1,
    });

    expect(parsed.type).toBe("editor_state");
    expect(parsed.type === "editor_state" && parsed.settings?.updatedAt).toBe(1);

    const empty = parseServerToEditor({
      type: "editor_state",
      runtimeActive: false,
      client: null,
      scene: null,
      resources: null,
      settings: null,
      serverTime: 1,
    });

    expect(empty.type === "editor_state" && empty.settings).toBeNull();
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
      settings: null,
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
      settings: null,
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
      settings: null,
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
      settings: null,
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
