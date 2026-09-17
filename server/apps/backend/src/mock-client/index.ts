import WebSocket from "ws";
import {
  parseJsonMessage,
  parseServerToClient,
  type ClientToServerMessage,
} from "@dts/protocol";

/**
 * Mock 前端（假 Unity 客户端）。
 *
 * 真实前端（Unity）尚未开放，这个进程实现同一套 `/client` 协议，让编辑器的
 * **运行态与动作触发链路今天就能端到端跑通并写测试**：
 * - 连上后上报地图对象、玩家、以及可触发动作清单；
 * - 收到 `invoke_action` 后模拟执行并回 `action_result`；
 * - 收到原子命令（set_option / set_bool ...）时更新本地镜像值并打印。
 *
 * 用法：`pnpm --filter @dts/backend mock`（端口取 PORT，默认 1420）
 */

interface MockAction {
  readonly actionId: string;
  readonly type: string;
  readonly displayName: string;
}

interface MockObject {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly position: { x: number; y: number };
  readonly components: Array<{ component: string; displayName: string; data: Record<string, unknown> }>;
  readonly actions: MockAction[];
}

const MAP_NAME = "Map001";

function buildObjects(): MockObject[] {
  return [
    {
      id: "door_01",
      name: "木门",
      kind: "SceneObject",
      position: { x: 0.32, y: 0.61 },
      components: [
        {
          component: "OptionValue",
          displayName: "状态",
          data: { currentOption: "关闭", options: ["关闭", "打开"] },
        },
      ],
      actions: [
        { actionId: "act_door_video", type: "PlayVideo", displayName: "开门播放过场" },
        { actionId: "act_door_show", type: "ShowHide", displayName: "开门显隐" },
      ],
    },
    {
      id: "chest_01",
      name: "旧宝箱",
      kind: "SceneObject",
      position: { x: 0.55, y: 0.44 },
      components: [
        { component: "BoolValue", displayName: "已开启", data: { value: false } },
        { component: "ItemExchange", displayName: "道具货源", data: { itemName: "钥匙", quantity: 1 } },
      ],
      actions: [{ actionId: "act_chest_open", type: "ShowHide", displayName: "开箱显隐" }],
    },
    {
      id: "player_01",
      name: "调查员",
      kind: "Player",
      position: { x: 0.5, y: 0.5 },
      components: [{ component: "Backpack", displayName: "背包", data: { items: [] } }],
      actions: [],
    },
  ];
}

function main(): void {
  const port = process.env.PORT ?? "1420";
  const url = process.env.DTS_SERVER_URL ?? `ws://127.0.0.1:${port}/client`;
  const objects = buildObjects();

  console.log(`[mock] 连接 ${url}`);
  const socket = new WebSocket(url);

  const send = (message: ClientToServerMessage): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  socket.on("open", () => {
    console.log("[mock] 已连接，上报注册信息");
    send({ type: "request_join" });
    send({
      type: "register_map_objects",
      mapName: MAP_NAME,
      spawnPoints: [{ id: "Default" }, { id: "NorthEntrance" }],
      objects: objects.map((object) => ({
        id: object.id,
        name: object.name,
        kind: object.kind,
        mapName: MAP_NAME,
        position: object.position,
        componentData: object.components.map((component) => ({
          component: component.component,
          displayName: component.displayName,
          data: JSON.stringify(component.data),
        })),
      })),
    });

    send({
      type: "register_players",
      players: objects
        .filter((object) => object.kind === "Player")
        .map((object) => ({ id: object.id, name: object.name })),
    });

    for (const object of objects) {
      if (object.actions.length === 0) {
        continue;
      }

      send({
        type: "register_actions",
        objectId: object.id,
        componentId: object.components[0]?.component ?? "BackendObject",
        actions: object.actions.map((action) => ({
          actionId: action.actionId,
          type: action.type,
          displayName: action.displayName,
        })),
      });
    }

    console.log(`[mock] 注册完成：${objects.length} 个对象`);
  });

  socket.on("message", (data) => {
    let message;
    try {
      message = parseServerToClient(parseJsonMessage(typeof data === "string" ? data : data.toString()));
    } catch (error) {
      console.warn(`[mock] 收到无法解析的消息: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    switch (message.type) {
      case "invoke_action": {
        const object = objects.find((item) => item.id === message.objectId);
        const action = object?.actions.find((item) => item.actionId === message.actionId);
        const ok = action !== undefined;
        console.log(
          `[mock] 触发动作 ${message.objectId}/${message.actionId} → ${ok ? "执行成功" : "未找到动作"}`,
        );
        send({
          type: "action_result",
          requestId: message.requestId,
          objectId: message.objectId,
          actionId: message.actionId,
          ok,
          ...(ok
            ? { effects: [`${action?.type ?? "unknown"} 已执行（Mock）`] }
            : { reason: "该对象上没有这个动作" }),
        });
        break;
      }

      case "sync_state":
        console.log(`[mock] 收到状态同步：当前地图 ${message.state.currentMap || "(空)"}`);
        break;

      case "set_option":
        console.log(`[mock] 原子命令 set_option: ${message.objectId} → ${message.option}`);
        break;

      case "set_bool":
        console.log(`[mock] 原子命令 set_bool: ${message.objectId} → ${String(message.value)}`);
        break;

      case "set_int":
      case "set_float":
        console.log(`[mock] 原子命令 ${message.type}: ${message.objectId} → ${String(message.value)}`);
        break;

      case "teleport_player":
      case "set_map":
        console.log(`[mock] 切图/传送: ${message.mapName}`);
        break;

      default:
        console.log(`[mock] 收到命令: ${message.type}`);
        break;
    }
  });

  socket.on("close", () => {
    console.log("[mock] 连接已关闭");
  });

  socket.on("error", (error: Error) => {
    console.error(`[mock] 连接错误: ${error.message}`);
  });

  const heartbeat = setInterval(() => {
    send({ type: "heartbeat" });
  }, 15000);

  process.on("SIGINT", () => {
    clearInterval(heartbeat);
    socket.close();
    process.exit(0);
  });
}

main();
