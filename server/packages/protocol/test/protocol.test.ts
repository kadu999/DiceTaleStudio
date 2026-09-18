import { describe, expect, it } from "vitest";
import {
  actionResultSchema,
  clientToServerSchema,
  createRequestId,
  editorToServerSchema,
  gameStateSchema,
  parseClientToServer,
  parseEditorToServer,
  parseJsonMessage,
  parseServerToClient,
  parseServerToEditor,
  serverToClientSchema,
} from "../src/messages";

describe("协议：前端 → 服务端", () => {
  it("接受既有消息（保持向后兼容）", () => {
    expect(parseClientToServer({ type: "request_join" }).type).toBe("request_join");
    expect(parseClientToServer({ type: "heartbeat" }).type).toBe("heartbeat");

    const registered = parseClientToServer({
      type: "register_map_objects",
      mapName: "Map001",
      objects: [
        {
          id: "door_01",
          name: "木门",
          kind: "SceneObject",
          position: { x: -345, y: 118 },
          componentData: [{ component: "OptionValue", displayName: "状态", data: "{\"options\":[]}" }],
        },
      ],
    });

    expect(registered.type).toBe("register_map_objects");
  });

  it("接受新增的 register_actions 与 action_result", () => {
    const actions = parseClientToServer({
      type: "register_actions",
      objectId: "door_01",
      componentId: "OptionValue",
      actions: [{ actionId: "act_1", type: "ShowHide", displayName: "显隐" }],
    });
    expect(actions.type).toBe("register_actions");

    const result = parseClientToServer({
      type: "action_result",
      requestId: "r1",
      objectId: "door_01",
      actionId: "act_1",
      ok: true,
      effects: ["已执行"],
    });
    expect(result.type).toBe("action_result");
  });

  it("拒绝未知类型与缺字段的消息", () => {
    expect(() => parseClientToServer({ type: "nope" })).toThrow(/校验失败/);
    expect(() => parseClientToServer({ type: "register_players" })).toThrow(/校验失败/);
    expect(() => parseClientToServer({ type: "report_player_position", playerId: "p" })).toThrow(
      /校验失败/,
    );
  });
});

describe("协议：服务端 → 前端", () => {
  it("既有原子命令全部保留", () => {
    for (const message of [
      { type: "set_option", objectId: "o", option: "打开" },
      { type: "set_bool", objectId: "o", value: true },
      { type: "set_int", objectId: "o", value: 3 },
      { type: "set_float", objectId: "o", value: 1.5 },
      { type: "set_object_items", objectId: "o", items: ["钥匙"] },
      { type: "erase_mask", objectId: "o", stroke: { points: [{ x: 0, y: 0 }], radius: 0.1, softness: 0.2 } },
      { type: "teleport_player", mapName: "Map002", spawnId: "Default" },
    ]) {
      expect(parseServerToClient(message).type).toBe(message.type);
    }
  });

  it("核心新增：invoke_action", () => {
    const message = parseServerToClient({
      type: "invoke_action",
      requestId: "r1",
      objectId: "door_01",
      actionId: "act_door_video",
    });

    expect(message.type).toBe("invoke_action");
  });

  it("invoke_action 缺少 actionId 时被拒绝（否则无法寻址动作）", () => {
    expect(() =>
      parseServerToClient({ type: "invoke_action", requestId: "r1", objectId: "door_01" }),
    ).toThrow(/校验失败/);
  });

  it("状态快照结构可校验（位置是世界坐标，y 向上）", () => {
    const snapshot = {
      currentMap: "Map001",
      players: { p1: { name: "调查员", position: { x: 0, y: 0 }, mapName: "Map001" } },
      objects: {
        door_01: {
          name: "木门",
          kind: "SceneObject",
          mapName: "Map001",
          position: { x: -384, y: 108 },
          actions: [{ actionId: "a1", type: "ShowHide" }],
        },
      },
    };

    expect(gameStateSchema.safeParse(snapshot).success).toBe(true);
    expect(serverToClientSchema.safeParse({ type: "sync_state", state: snapshot }).success).toBe(true);
  });
});

describe("协议：编辑器 ↔ 服务端", () => {
  it("编辑器可订阅与直通原子命令", () => {
    expect(parseEditorToServer({ type: "editor_subscribe" }).type).toBe("editor_subscribe");
    expect(parseEditorToServer({ type: "set_bool", objectId: "o", value: false }).type).toBe("set_bool");
    expect(parseEditorToServer({ type: "teleport_player", mapName: "M", spawnId: "S" }).type).toBe(
      "teleport_player",
    );
  });

  it("编辑器可触发动作", () => {
    const message = parseEditorToServer({
      type: "invoke_action",
      requestId: "r1",
      objectId: "chest_01",
      actionId: "act_chest_open",
      args: { force: true },
    });
    expect(message.type).toBe("invoke_action");
  });

  it("服务端 → 编辑器的快照与错误", () => {
    const snapshot = parseServerToEditor({
      type: "editor_snapshot",
      clientConnected: false,
      state: { currentMap: "", players: {}, objects: {} },
    });
    expect(snapshot.type).toBe("editor_snapshot");

    const error = parseServerToEditor({ type: "editor_error", requestId: "r1", reason: "前端未连接" });
    expect(error.type).toBe("editor_error");
  });

  it("action_result 在两个方向上是同一份契约", () => {
    const payload = {
      type: "action_result" as const,
      requestId: "r1",
      objectId: "o",
      actionId: "a",
      ok: false,
      reason: "未找到动作",
    };

    expect(actionResultSchema.safeParse(payload).success).toBe(true);
    expect(clientToServerSchema.safeParse(payload).success).toBe(true);
    expect(editorToServerSchema.safeParse({ type: "editor_subscribe" }).success).toBe(true);
  });
});

describe("协议：JSON 解析与请求 id", () => {
  it("非法 JSON 抛出可读错误", () => {
    expect(() => parseJsonMessage("{not json")).toThrow(/不是合法 JSON/);
  });

  it("请求 id 唯一", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRequestId()));
    expect(ids.size).toBe(50);
  });
});
