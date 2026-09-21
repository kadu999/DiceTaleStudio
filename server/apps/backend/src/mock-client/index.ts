import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  parseJsonMessage,
  parseServerToClient,
  type ClientToServerMessage,
  type ScenePayload,
} from "@dts/protocol";

/**
 * Mock 前端（假 Unity 客户端）。
 *
 * 它在新协议里的角色很小：**什么都不上报**，只做三件事——
 * 1. 连上（`/client` 只有在编辑器点「运行」之后才收，所以这里带重试）；
 * 2. 收到 `scene_sync` 就把镜像打印出来（场景名 + 每个对象的 id/kind/active/position）；
 * 3. 收到 `command` 回 `command_result`（这条路是给编辑器看回执的；真出声在 Unity 里）。
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
      console.warn(`[mock] 收到无法解析的消息: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    switch (message.type) {
      case "server_hello":
        console.log(`[mock] 服务端打招呼：协议 v${message.protocolVersion}，会话 ${message.sessionId}`);
        return;

      case "scene_sync":
        this.applyScene(message.scene);
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
      console.log(
        `[mock]   ${object.id}  kind=${object.kind}  active=${object.active}  pos=${position}  ` +
          `scale=${object.scale}  order=${object.sortingOrder}` +
          (object.image === undefined ? "" : `  image=${object.image.id}`) +
          (object.sound === undefined ? "" : `  sound=${object.sound.picked ?? "(未选)"}@${object.sound.layer}`) +
          (object.video === undefined
            ? ""
            : `  video=${object.video.picked || "(未选)"}（${object.video.clips.length} 条，循环=${object.video.loop}，声音=${object.video.audio}）`),
      );
    }
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
