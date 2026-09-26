import WebSocket from "ws";
import {
  COMPONENT_TYPE,
  PROTOCOL_VERSION,
  componentDataOf,
  parseJsonMessage,
  parseServerToClient,
  type ClientToServerMessage,
  type ProjectSettingsPayload,
  type ScenePayload,
} from "@dts/protocol";
import { messageOf } from "../values";

/**
 * Mock 前端（假 Unity 客户端）。
 *
 * 它在新协议里的角色很小：**什么都不上报**，只做四件事——
 * 1. 连上（`/client` 只有在编辑器点「运行」之后才收，所以这里带重试）；
 * 2. 收到 `scene_sync` 就把镜像打印出来（场景名 + 每个对象的 id/kind/active/position）；
 * 3. 收到 `project_settings` 就把全局设置打印出来（歌单 / 默认曲 / 三档音量）；
 * 4. 收到 `command` 回 `command_result`（这条路是给编辑器看回执的；真出声在 Unity 里）。
 *
 * 用法：`pnpm --filter @dts/backend mock`（端口取 PORT，默认 1420）。
 * **先让编辑器进入运行态**，否则连接会被服务端以 503 拒（正常现象，会自动重试）。
 */

const RETRY_DELAY_MS = 3000;

class MockClient {
  private socket: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly url: string) {}

  start(): void {
    console.log(`[mock] 连接 ${this.url}（编辑器进入运行态后才会被接受）`);
    this.connect();
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("open", () => {
      console.log("[mock] 已连接，发送 client_hello");
      this.send({
        type: "client_hello",
        protocolVersion: PROTOCOL_VERSION,
        name: "Mock 前端",
        version: "0.0.0",
      });
    });

    socket.on("message", (data) => {
      this.onMessage(typeof data === "string" ? data : data.toString());
    });

    socket.on("close", (code, reason) => {
      this.socket = undefined;
      const detail = reason.length > 0 ? `（${reason.toString()}）` : "";
      console.log(`[mock] 连接关闭 code=${code}${detail}；${RETRY_DELAY_MS}ms 后重试`);
      this.scheduleRetry();
    });

    socket.on("error", (error: Error) => {
      // 未进入运行态时是 HTTP 503（握手失败），这里只提示一次原因
      console.log(`[mock] 连接失败：${error.message}；${RETRY_DELAY_MS}ms 后重试`);
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, RETRY_DELAY_MS);
  }

  private onMessage(text: string): void {
    let message;
    try {
      message = parseServerToClient(parseJsonMessage(text));
    } catch (error) {
      console.warn(`[mock] 收到无法解析的消息: ${messageOf(error)}`);
      return;
    }

    switch (message.type) {
      case "server_hello":
        console.log(`[mock] 服务端打招呼：协议 v${message.protocolVersion}，会话 ${message.sessionId}`);
        return;

      case "scene_sync":
        this.applyScene(message.scene);
        return;

      case "project_settings":
        this.applySettings(message.settings);
        return;

      case "command": {
        const { requestId, command } = message;
        // 真出声 / 真放视频在 Unity 里；这里只证明「后台控制前端」这条链路通了 + 回执
        const effects = [`mock 收到 ${command.kind}`];
        console.log(`[mock] 命令：${command.kind} ${JSON.stringify(command)}`);
        this.send({
          type: "command_result",
          requestId,
          ok: false,
          reason: command.kind.endsWith("_video")
            ? "mock 前端不放视频（真实播放器是 Unity）"
            : command.kind.endsWith("_bgm")
              ? "mock 前端不放背景音乐（真实播放器是 Unity）"
              : "mock 前端不出声（真实播放器是 Unity）",
        });
        console.log(`[mock] 已回执 ${requestId}（effects: ${effects.join("，")}）`);
        return;
      }

      case "ping":
        this.send({ type: "pong", seq: message.seq });
        return;

      default:
        return;
    }
  }

  /** 把整份场景当作镜像打印出来（每次推送都打印一遍，改了什么一眼看得出来）。 */
  private applyScene(scene: ScenePayload | null): void {
    if (scene === null) {
      console.log("[mock] 场景已清空（编辑器没有打开的场景）");
      return;
    }

    console.log(`[mock] 镜像场景「${scene.name}」：${scene.objects.length} 个对象`);
    for (const object of scene.objects) {
      const position = object.position === null ? "(未落位)" : `(${object.position.x}, ${object.position.y})`;
      // 组件名（v9 起对象特性住在组件里）：先列出来，再补几个重点组件的关键字段
      const components = object.components.map((item) => item.type).join("+") || "(无组件)";
      const image = componentDataOf<{ id: string; sortingOrder?: number }>(object, COMPONENT_TYPE.image);
      const sprite = componentDataOf<{ id: string; sortingOrder?: number }>(object, COMPONENT_TYPE.sprite);
      const map = componentDataOf<{ grid?: { width: number; height: number }; sortingOrder?: number }>(
        object,
        COMPONENT_TYPE.map,
      );
      // 显示顺序（v14 起）住在渲染组件里：地图 → 图片层 → 精灵层 → 缺省 0
      const order = map?.sortingOrder ?? image?.sortingOrder ?? sprite?.sortingOrder ?? 0;
      const sound = componentDataOf<{ picked?: string; layer: string }>(object, COMPONENT_TYPE.sound);
      const video = componentDataOf<{
        picked?: string;
        clips: readonly string[];
        loop: boolean;
        audio: boolean;
      }>(object, COMPONENT_TYPE.video);

      console.log(
        `[mock]   ${object.id}  kind=${object.kind}  active=${object.active}  pos=${position}  ` +
          `scale=${object.scale}  order=${order}  components=${components}` +
          (image === undefined ? "" : `  image=${image.id}`) +
          (map?.grid === undefined ? "" : `  grid=${map.grid.width}×${map.grid.height}`) +
          (sound === undefined ? "" : `  sound=${sound.picked ?? "(未选)"}@${sound.layer}`) +
          (video === undefined
            ? ""
            : `  video=${video.picked ?? "(未选)"}（${video.clips.length} 条，循环=${video.loop}，声音=${video.audio}）`),
      );
    }
  }

  /** 全局设置（三档音量）也打印出来：音量改了在前端看得见。 */
  private applySettings(settings: ProjectSettingsPayload | null): void {
    if (settings === null) {
      console.log("[mock] 全局设置已清空（编辑器没有打开的项目）");
      return;
    }

    const { bgm, sfx, voice } = settings.audio;
    console.log(
      `[mock] 全局设置：音量 bgm=${bgm.volume} / sfx=${sfx.volume} / voice=${voice.volume}`,
    );
  }

  private send(message: ClientToServerMessage): void {
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

function main(): void {
  const port = process.env.PORT ?? "1420";
  const url = process.env.DTS_SERVER_URL ?? `ws://127.0.0.1:${port}/client`;
  new MockClient(url).start();
}

main();
