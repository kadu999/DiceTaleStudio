import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  parseServerToClient,
  type ServerToClientMessage,
  type ServerToEditorMessage,
} from "@dts/protocol";
import { loadConfig } from "../src/config";
import { createHttpServer } from "../src/http/server";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";

/**
 * 运行态端到端测试：**编辑器触发动作 → 服务端中转 → 前端执行 → 回执回到编辑器**。
 *
 * 真实前端（Unity）尚未开放，这里用一个最小假前端实现 `/client` 协议，
 * 保证「如何告诉前端执行一个动作」这条链路是被测试锁住的，而不是靠人工点。
 */

/** 收消息的小工具：按谓词等待，带超时。 */
class Inbox {
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<{ predicate: (message: unknown) => boolean; resolve: (value: unknown) => void }> = [];

  push(raw: string): void {
    const parsed: unknown = JSON.parse(raw);
    const index = this.waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.resolve(parsed);
      return;
    }

    this.queue.push(parsed);
  }

  waitFor<T>(predicate: (message: unknown) => boolean, timeoutMs = 2000): Promise<T> {
    const existing = this.queue.findIndex((message) => predicate(message));
    if (existing >= 0) {
      const [message] = this.queue.splice(existing, 1);
      return Promise.resolve(message as T);
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待消息超时")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
      });
    });
  }
}

function connect(url: string): { socket: WebSocket; inbox: Inbox } {
  const socket = new WebSocket(url);
  const inbox = new Inbox();
  socket.on("message", (data) => {
    inbox.push(typeof data === "string" ? data : data.toString());
  });
  return { socket, inbox };
}

async function waitOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

describe("运行态端到端（编辑器 → 服务端 → 前端）", () => {
  let server: Server;
  let hub: RuntimeHub;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const config = await loadConfig();
    const provider = new FsResourceProvider(config.resourceRoot, config.dirs);
    hub = new RuntimeHub(() => {});
    server = createHttpServer({ config, provider, hub, log: () => {} });
    hub.attach(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.close();
    }

    sockets.length = 0;
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function startClient(): Promise<{ socket: WebSocket; inbox: Inbox }> {
    const connection = connect(`ws://${baseUrl}/client`);
    sockets.push(connection.socket);
    await waitOpen(connection.socket);
    return connection;
  }

  async function startEditor(): Promise<{ socket: WebSocket; inbox: Inbox }> {
    const connection = connect(`ws://${baseUrl}/editor`);
    sockets.push(connection.socket);
    await waitOpen(connection.socket);
    return connection;
  }

  /** 最小假前端：注册两个可触发动作，并对 invoke_action 回执。 */
  async function registerFakeClient(): Promise<{ socket: WebSocket; inbox: Inbox }> {
    const client = await startClient();
    send(client.socket, { type: "request_join" });
    send(client.socket, {
      type: "register_map_objects",
      mapName: "Map001",
      spawnPoints: [{ id: "Default" }],
      objects: [
        {
          id: "door_01",
          name: "木门",
          kind: "SceneObject",
          position: { x: 0.32, y: 0.61 },
          componentData: [{ component: "OptionValue", displayName: "状态", data: "{}" }],
        },
      ],
    });
    send(client.socket, {
      type: "register_actions",
      objectId: "door_01",
      componentId: "OptionValue",
      actions: [
        { actionId: "act_open", type: "PlayVideo", displayName: "开门过场" },
        { actionId: "act_show", type: "ShowHide", displayName: "开门显隐" },
      ],
    });

    // 假前端：收到 invoke_action 就回执（未知动作回 ok:false）
    const known = new Set(["act_open", "act_show"]);
    client.socket.on("message", (data) => {
      const message = parseServerToClient(JSON.parse(typeof data === "string" ? data : data.toString()));
      if (message.type !== "invoke_action") {
        return;
      }

      const ok = known.has(message.actionId);
      send(client.socket, {
        type: "action_result",
        requestId: message.requestId,
        objectId: message.objectId,
        actionId: message.actionId,
        ok,
        ...(ok ? { effects: ["已执行（假前端）"] } : { reason: "该对象上没有这个动作" }),
      });
    });

    return client;
  }

  it("编辑器订阅后能拿到含动作清单的快照", async () => {
    await registerFakeClient();
    const editor = await startEditor();
    send(editor.socket, { type: "editor_subscribe" });

    const snapshot = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => (message as { type?: string }).type === "editor_snapshot",
    );

    if (snapshot.type !== "editor_snapshot") {
      throw new Error("类型不符");
    }

    expect(snapshot.clientConnected).toBe(true);
    expect(snapshot.state.currentMap).toBe("Map001");
    expect(snapshot.state.objects.door_01?.actions?.map((action) => action.actionId)).toEqual([
      "act_open",
      "act_show",
    ]);
  });

  it("编辑器触发动作 → 前端执行 → 回执回到编辑器", async () => {
    await registerFakeClient();
    const editor = await startEditor();
    send(editor.socket, { type: "editor_subscribe" });
    await editor.inbox.waitFor((message) => (message as { type?: string }).type === "editor_snapshot");

    send(editor.socket, {
      type: "invoke_action",
      requestId: "req-1",
      objectId: "door_01",
      actionId: "act_open",
    });

    const result = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => (message as { type?: string }).type === "action_result",
    );

    if (result.type !== "action_result") {
      throw new Error("类型不符");
    }

    expect(result.requestId).toBe("req-1");
    expect(result.actionId).toBe("act_open");
    expect(result.ok).toBe(true);
    expect(result.effects).toEqual(["已执行（假前端）"]);
  });

  it("动作不存在时前端回执失败原因（不静默）", async () => {
    await registerFakeClient();
    const editor = await startEditor();
    send(editor.socket, { type: "editor_subscribe" });
    await editor.inbox.waitFor((message) => (message as { type?: string }).type === "editor_snapshot");

    send(editor.socket, {
      type: "invoke_action",
      requestId: "req-2",
      objectId: "door_01",
      actionId: "act_missing",
    });

    const result = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => (message as { type?: string }).type === "action_result",
    );

    if (result.type !== "action_result") {
      throw new Error("类型不符");
    }

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/没有这个动作/);
  });

  it("前端未连接时触发动作给出明确错误（不静默失败）", async () => {
    const editor = await startEditor();
    send(editor.socket, { type: "editor_subscribe" });
    await editor.inbox.waitFor((message) => (message as { type?: string }).type === "editor_snapshot");

    send(editor.socket, {
      type: "invoke_action",
      requestId: "req-3",
      objectId: "door_01",
      actionId: "act_open",
    });

    const error = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        (message as { type?: string }).type === "editor_error" &&
        (message as { requestId?: string }).requestId === "req-3",
    );

    if (error.type !== "editor_error") {
      throw new Error("类型不符");
    }

    expect(error.reason).toMatch(/前端未连接/);
  });

  it("前端断开后运行态清空（单客户端架构）", async () => {
    const client = await registerFakeClient();
    const editor = await startEditor();
    send(editor.socket, { type: "editor_subscribe" });
    await editor.inbox.waitFor((message) => (message as { type?: string }).type === "editor_snapshot");

    client.socket.close();

    const offline = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        (message as { type?: string }).type === "editor_snapshot" &&
        (message as { clientConnected?: boolean }).clientConnected === false,
    );

    if (offline.type !== "editor_snapshot") {
      throw new Error("类型不符");
    }

    expect(offline.state.objects).toEqual({});
    expect(offline.clientConnected).toBe(false);
  });

  it("原子命令直通到前端（低层触发路径仍然可用）", async () => {
    const client = await registerFakeClient();
    const editor = await startEditor();
    send(editor.socket, { type: "editor_subscribe" });
    await editor.inbox.waitFor((message) => (message as { type?: string }).type === "editor_snapshot");

    send(editor.socket, { type: "set_option", objectId: "door_01", option: "打开" });

    const forwarded = await client.inbox.waitFor<ServerToClientMessage>(
      (message) => (message as { type?: string }).type === "set_option",
    );

    if (forwarded.type !== "set_option") {
      throw new Error("类型不符");
    }

    expect(forwarded.option).toBe("打开");
  });
});

describe("后端 HTTP 接口", () => {
  let server: Server;
  let hub: RuntimeHub;
  let baseUrl: string;

  beforeEach(async () => {
    const config = await loadConfig();
    const provider = new FsResourceProvider(config.resourceRoot, config.dirs);
    hub = new RuntimeHub(() => {});
    server = createHttpServer({ config, provider, hub, log: () => {} });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("/api/health 返回连接状态", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as { ok: boolean; clientConnected: boolean };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.clientConnected).toBe(false);
  });

  it("/api/config 使用资源目录配置（代码不硬编码目录）", async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    const body = (await response.json()) as { resourceRoot: string; dirs: Record<string, string> };
    expect(body.resourceRoot).toContain("resources");
    expect(body.dirs.map).toBe("maps");
    expect(body.dirs.image).toBe("images");
  });

  it("/api/resources/index 列出资源并可按类别过滤", async () => {
    const all = (await (await fetch(`${baseUrl}/api/resources/index`)).json()) as {
      entries: Array<{ id: string; kind: string }>;
    };
    // resources/config 下的配置文件应当被列出来（.gitkeep 除外）
    expect(all.entries.some((entry) => entry.id === "config:app.json")).toBe(true);
    expect(all.entries.some((entry) => entry.id.endsWith(".gitkeep"))).toBe(false);

    const configOnly = (await (
      await fetch(`${baseUrl}/api/resources/index?kind=config`)
    ).json()) as { entries: Array<{ kind: string }> };
    expect(configOnly.entries.every((entry) => entry.kind === "config")).toBe(true);
  });

  it("/api/resources/raw 可读配置文件，未知 id 返回 404", async () => {
    const ok = await fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent("config:app.json")}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("resourceRoot");

    const missing = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent("map:Nope.json")}`);
    expect(missing.status).toBe(404);
  });

  it("/api/state 暴露运行态与可触发动作", async () => {
    const response = await fetch(`${baseUrl}/api/state`);
    const body = (await response.json()) as { clientConnected: boolean; actions: unknown[] };
    expect(body.clientConnected).toBe(false);
    expect(body.actions).toEqual([]);
  });

  it("未构建前端时根路径给出可操作提示而不是报错", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/DiceTaleStudio|编辑器/);
  });
});
