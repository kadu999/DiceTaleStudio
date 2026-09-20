import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  RUNTIME_STOPPED_CODE,
  type ScenePayload,
  type ServerToClientMessage,
  type ServerToEditorMessage,
} from "@dts/protocol";
import { loadConfig } from "../src/config";
import { createHttpServer } from "../src/http/server";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";

/**
 * 运行态端到端测试：**编辑器点运行 → 开闸 → 前端连上 → 场景整份镜像过去 → 命令能下发并回执**。
 *
 * 这里锁住四件事，都是人工点不出来的：
 * 1. 门控：没点运行，前端**根本连不上**（HTTP 503 拒握手）；退出运行态，已连的前端被踢（4003）。
 * 2. 缓存：先改场景、后开前端，前端一连上就拿到**全量** `scene_sync`。
 * 3. 转发：运行中改场景，整份推给已连接的前端（激活 / 位置都在里面）。
 * 4. 命令：只有开闸且前端连着才下发；未连接 / 未开闸都明确报错（不静默）。
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

/** 未开闸时连接应当失败：把失败原因（HTTP 状态或错误文案）取回来。 */
function connectExpectFailure(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("open", () => {
      socket.close();
      reject(new Error("未开闸却连上了"));
    });
    socket.on("unexpected-response", (_request, response) => {
      socket.terminate();
      resolve(`HTTP ${response.statusCode ?? 0}`);
    });
    socket.on("error", (error: Error) => resolve(error.message));
  });
}

const typeOf = (message: unknown): string => (message as { type?: string }).type ?? "";

/** 一份最小场景：一个地图对象（激活）+ 一个精灵对象（激活状态可调）。 */
function sampleScene(name: string, spriteActive: boolean): ScenePayload {
  return {
    name,
    objects: [
      {
        id: "map_01",
        name: "地图",
        kind: "Map",
        active: true,
        sortingOrder: -10,
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        map: {
          image: { id: "project:P/Assets/images/map.png", width: 1920, height: 1080 },
          grid: { width: 64, height: 36 },
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, 2304]] },
        },
      },
      {
        id: "sprite_01",
        name: "木门",
        kind: "SceneObject",
        active: spriteActive,
        sortingOrder: 0,
        position: { x: -345, y: 118 },
        rotation: 0,
        scale: 1,
      },
    ],
  };
}

describe("运行态：门控 + 场景镜像中继", () => {
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

  async function startEditor(options: { running?: boolean } = {}): Promise<{ socket: WebSocket; inbox: Inbox }> {
    const connection = connect(`ws://${baseUrl}/editor`);
    sockets.push(connection.socket);
    await waitOpen(connection.socket);
    send(connection.socket, { type: "editor_hello", protocolVersion: PROTOCOL_VERSION });

    if (options.running !== false) {
      send(connection.socket, { type: "runtime_start" });
      await connection.inbox.waitFor<ServerToEditorMessage>(
        (message) => typeOf(message) === "editor_state" && (message as { runtimeActive?: boolean }).runtimeActive === true,
      );
    }

    return connection;
  }

  it("没点运行：前端连不上（握手就被 503 拒）", async () => {
    expect(await connectExpectFailure(`ws://${baseUrl}/client`)).toMatch(/503/);
    expect(hub.runtimeActive).toBe(false);
  });

  it("点运行后前端能连上，退出运行态被 4003 踢下线", async () => {
    // 开闸前先确认连不上
    expect(await connectExpectFailure(`ws://${baseUrl}/client`)).toMatch(/503/);

    const editor = await startEditor();
    expect(hub.runtimeActive).toBe(true);

    const client = await startClient();
    const hello = await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "server_hello");
    if (hello.type !== "server_hello") {
      throw new Error("类型不符");
    }

    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);

    // 编辑器看到「前端已连接」
    const online = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { client?: unknown }).client !== null,
    );
    if (online.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(online.runtimeActive).toBe(true);

    // 退出运行态：前端被踢，编辑器状态回到未开闸
    const closed = new Promise<number>((resolve) => client.socket.once("close", (code) => resolve(code)));
    send(editor.socket, { type: "runtime_stop" });

    expect(await closed).toBe(RUNTIME_STOPPED_CODE);

    const offline = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { runtimeActive?: boolean }).runtimeActive === false,
    );
    if (offline.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(offline.client).toBeNull();
    expect(hub.clientConnected).toBe(false);
  });

  it("先推场景、后开前端：连上立刻拿到全量镜像", async () => {
    const editor = await startEditor();
    send(editor.socket, { type: "scene_push", scene: sampleScene("场景1", false) });

    await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { scene?: unknown }).scene !== null,
    );

    const client = await startClient();
    const sync = await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "scene_sync");
    if (sync.type !== "scene_sync") {
      throw new Error("类型不符");
    }

    expect(sync.scene?.name).toBe("场景1");
    expect(sync.scene?.objects).toHaveLength(2);
    expect(sync.scene?.objects[1]?.active).toBe(false);
    expect(sync.scene?.objects[1]?.position).toEqual({ x: -345, y: 118 });
  });

  it("运行中改场景：整份推给已连接的前端（激活 / 位置都跟着变）", async () => {
    const editor = await startEditor();
    send(editor.socket, { type: "scene_push", scene: sampleScene("场景1", false) });

    const client = await startClient();
    await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "scene_sync");

    // 编辑器把精灵对象激活、并挪个位置
    const next = sampleScene("场景1", true);
    next.objects[1]!.position = { x: 100, y: -50 };
    send(editor.socket, { type: "scene_push", scene: next });

    const updated = await client.inbox.waitFor<ServerToClientMessage>(
      (message) =>
        typeOf(message) === "scene_sync" &&
        (message as { scene?: { objects?: Array<{ active?: boolean }> } }).scene?.objects?.[1]?.active === true,
    );
    if (updated.type !== "scene_sync") {
      throw new Error("类型不符");
    }

    expect(updated.scene?.objects[1]?.position).toEqual({ x: 100, y: -50 });
  });

  it("编辑器状态里带上「镜像到哪了」的摘要与前端标识", async () => {
    const editor = await startEditor();
    send(editor.socket, { type: "scene_push", scene: sampleScene("场景1", true) });

    const withScene = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { scene?: unknown }).scene !== null,
    );
    if (withScene.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(withScene.scene?.name).toBe("场景1");
    expect(withScene.scene?.objectCount).toBe(2);

    const client = await startClient();
    send(client.socket, { type: "client_hello", protocolVersion: PROTOCOL_VERSION, name: "DiceTale Unity", version: "1.0.0" });

    const identified = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        typeOf(message) === "editor_state" &&
        (message as { client?: { name?: string } }).client?.name === "DiceTale Unity",
    );
    if (identified.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(identified.client?.version).toBe("1.0.0");
  });

  it("命令：前端在 → 原样转发 + 回执回到编辑器 + 日志", async () => {
    const editor = await startEditor();
    const client = await startClient();
    send(client.socket, { type: "client_hello", protocolVersion: PROTOCOL_VERSION, name: "Mock", version: "0.0.0" });

    // 假前端：收到 command 就回执（命令里只有 objectId + layer，数据在场景里）
    client.socket.on("message", (data) => {
      const parsed = JSON.parse(typeof data === "string" ? data : data.toString()) as {
        type?: string;
        requestId?: string;
      };
      if (parsed.type !== "command") {
        return;
      }

      send(client.socket, {
        type: "command_result",
        requestId: parsed.requestId,
        ok: false,
        reason: "前端尚未实现 play_sound（下一步）",
      });
    });

    send(editor.socket, {
      type: "editor_command",
      requestId: "cmd-1",
      command: { kind: "play_sound", objectId: "sound_01", layer: "sfx" },
    });

    const forwarded = await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "command");
    if (forwarded.type !== "command") {
      throw new Error("类型不符");
    }

    expect(forwarded.requestId).toBe("cmd-1");
    expect(forwarded.command).toEqual({ kind: "play_sound", objectId: "sound_01", layer: "sfx" });

    const result = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_command_result",
    );
    if (result.type !== "editor_command_result") {
      throw new Error("类型不符");
    }

    expect(result.requestId).toBe("cmd-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/尚未实现/);

    // 编辑器日志里也有一条（界面上看得见，不用翻服务端控制台）
    const logged = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        typeOf(message) === "editor_log" &&
        (message as { message?: string }).message?.includes("执行失败") === true,
    );
    expect(typeOf(logged)).toBe("editor_log");
  });

  it("命令：前端不在 → 明确报错；未进入运行态 → 也明确报错", async () => {
    const editor = await startEditor();

    send(editor.socket, {
      type: "editor_command",
      requestId: "cmd-offline",
      command: { kind: "stop_sound", layer: "sfx" },
    });

    const offline = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        typeOf(message) === "editor_error" && (message as { requestId?: string }).requestId === "cmd-offline",
    );
    if (offline.type !== "editor_error") {
      throw new Error("类型不符");
    }

    expect(offline.reason).toMatch(/前端未连接/);

    // 关闸之后再发（编辑器还连着，但运行态没了）
    send(editor.socket, { type: "runtime_stop" });
    await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { runtimeActive?: boolean }).runtimeActive === false,
    );

    send(editor.socket, {
      type: "editor_command",
      requestId: "cmd-inactive",
      command: { kind: "stop_sound", layer: "sfx" },
    });

    const inactive = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        typeOf(message) === "editor_error" && (message as { requestId?: string }).requestId === "cmd-inactive",
    );
    if (inactive.type !== "editor_error") {
      throw new Error("类型不符");
    }

    expect(inactive.reason).toMatch(/未进入运行态/);
  });

  it("编辑器刷新 / 断开**不影响**运行态：前端还在，重连后还看到在运行", async () => {
    const editor = await startEditor();
    const client = await startClient();
    await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "server_hello");

    // 模拟刷新页面：编辑器那只 WS 断开
    editor.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 运行态还在：前端没被踢，新连接照样连得上
    expect(hub.runtimeActive).toBe(true);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    const reopened = await startEditor({ running: false });
    const state = await reopened.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state",
    );
    if (state.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(state.runtimeActive).toBe(true);
  });

  it("只有点「编辑」才关闸：前端被踢，且连不回来", async () => {
    const editor = await startEditor();
    const client = await startClient();
    await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "server_hello");

    const closed = new Promise<number>((resolve) => client.socket.once("close", (code) => resolve(code)));
    send(editor.socket, { type: "runtime_stop" });

    expect(await closed).toBe(RUNTIME_STOPPED_CODE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.runtimeActive).toBe(false);
    expect(await connectExpectFailure(`ws://${baseUrl}/client`)).toMatch(/503/);
  });

  it("协议版本不一致：前端被 4002 断开", async () => {
    await startEditor();
    const client = await startClient();

    const closed = new Promise<number>((resolve) => client.socket.once("close", (code) => resolve(code)));
    send(client.socket, { type: "client_hello", protocolVersion: 99, name: "旧前端", version: "0.9" });

    expect(await closed).toBe(4002);
  });

  it("顺序：前端一连上就先收到 resources_prepare，再收到 scene_sync", async () => {
    const editor = await startEditor();
    send(editor.socket, { type: "scene_push", scene: sampleScene("场景1", true) });
    await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { scene?: unknown }).scene !== null,
    );

    // 记录前端**收到消息的先后顺序**（这是「先下资源、再载入场景」的协议依据）
    const order: string[] = [];
    const client = connect(`ws://${baseUrl}/client`);
    sockets.push(client.socket);
    client.socket.on("message", (data) => {
      order.push((JSON.parse(data.toString()) as { type: string }).type);
    });
    await waitOpen(client.socket);

    const prepare = await client.inbox.waitFor<ServerToClientMessage>(
      (message) => typeOf(message) === "resources_prepare",
    );
    if (prepare.type !== "resources_prepare") {
      throw new Error("类型不符");
    }

    // 项目名从场景里的资源逻辑 ID 推出（示例场景的地图贴图是 project:P/…）
    expect(prepare.project).toBe("P");
    await client.inbox.waitFor<ServerToClientMessage>((message) => typeOf(message) === "scene_sync");

    expect(order.indexOf("resources_prepare")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("scene_sync")).toBeGreaterThan(order.indexOf("resources_prepare"));
  });

  it("还没推过场景时：resources_prepare 的 project 是 null（前端照旧等场景）", async () => {
    await startEditor();
    const client = await startClient();

    const prepare = await client.inbox.waitFor<ServerToClientMessage>(
      (message) => typeOf(message) === "resources_prepare",
    );
    if (prepare.type !== "resources_prepare") {
      throw new Error("类型不符");
    }

    expect(prepare.project).toBeNull();
  });

  it("运行中换项目：会给前端重发一次 resources_prepare", async () => {
    const editor = await startEditor();
    send(editor.socket, { type: "scene_push", scene: sampleScene("场景1", true) });

    const client = await startClient();
    await client.inbox.waitFor<ServerToClientMessage>(
      (message) => typeOf(message) === "resources_prepare" && (message as { project?: string }).project === "P",
    );

    // 换成另一个项目的场景（同样的对象结构，只换资源 ID 里的项目名）
    const other = sampleScene("场景1", true);
    other.objects[0]!.map = {
      image: { id: "project:Q/Assets/images/map.png", width: 1920, height: 1080 },
      grid: { width: 64, height: 36 },
      rowOrder: "bottom-up",
      cells: { encoding: "rle", runs: [[0, 2304]] },
    };
    send(editor.socket, { type: "scene_push", scene: other });

    const again = await client.inbox.waitFor<ServerToClientMessage>(
      (message) => typeOf(message) === "resources_prepare" && (message as { project?: string }).project === "Q",
    );
    expect(typeOf(again)).toBe("resources_prepare");
  });

  it("前端上报资源包结果：编辑器在状态里看得见，关闸后清掉", async () => {
    const editor = await startEditor();
    const client = await startClient();
    send(client.socket, { type: "client_hello", protocolVersion: PROTOCOL_VERSION, name: "DiceTale Unity", version: "1.0.0" });

    send(client.socket, {
      type: "resources_ready",
      project: "测试项目",
      fingerprint: "398ff8e23aada15d",
      fileCount: 14,
      bytes: 39_765_209,
      ok: true,
    });

    const withResources = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) => typeOf(message) === "editor_state" && (message as { resources?: unknown }).resources !== null,
    );
    if (withResources.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(withResources.resources?.project).toBe("测试项目");
    expect(withResources.resources?.fileCount).toBe(14);
    expect(withResources.resources?.ok).toBe(true);
    expect(withResources.resources?.fingerprint).toBe("398ff8e23aada15d");

    // 失败也要如实记下来（不假装就绪）
    send(client.socket, {
      type: "resources_ready",
      project: "测试项目",
      fingerprint: "398ff8e23aada15d",
      fileCount: 0,
      bytes: 0,
      ok: false,
      reason: "解压资源包失败：CRC 校验失败",
    });

    const failed = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        typeOf(message) === "editor_state" &&
        (message as { resources?: { ok?: boolean } }).resources?.ok === false,
    );
    if (failed.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(failed.resources?.reason).toMatch(/CRC/);

    // 关闸：运行态里的资源包状态一并清掉（下一次运行重新算）
    send(editor.socket, { type: "runtime_stop" });
    const cleared = await editor.inbox.waitFor<ServerToEditorMessage>(
      (message) =>
        typeOf(message) === "editor_state" &&
        (message as { runtimeActive?: boolean }).runtimeActive === false,
    );
    if (cleared.type !== "editor_state") {
      throw new Error("类型不符");
    }

    expect(cleared.resources).toBeNull();
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

  it("/api/health 返回运行态与连接状态", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as {
      ok: boolean;
      runtimeActive: boolean;
      clientConnected: boolean;
      editorConnections: number;
    };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runtimeActive).toBe(false);
    expect(body.clientConnected).toBe(false);
    expect(body.editorConnections).toBe(0);
  });

  it("/api/config 使用资源目录配置（代码不硬编码目录）", async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    const body = (await response.json()) as {
      resourceRoot: string;
      dirs: Record<string, string>;
      projectFolders: string[];
    };
    expect(body.resourceRoot).toContain("resources");
    expect(body.dirs.project).toBe("projects");
    expect(body.projectFolders).toContain("Assets/scenes");
  });

  it("/api/resources/index 列出资源并可按类别过滤", async () => {
    const all = (await (await fetch(`${baseUrl}/api/resources/index`)).json()) as {
      entries: Array<{ id: string; kind: string }>;
    };
    // resources/config 下的配置文件应当被列出来（.gitkeep 除外）
    expect(all.entries.some((entry) => entry.id === "config:app.json")).toBe(true);
    expect(all.entries.some((entry) => entry.id.endsWith(".gitkeep"))).toBe(false);

    const configOnly = (await (await fetch(`${baseUrl}/api/resources/index?kind=config`)).json()) as {
      entries: Array<{ kind: string }>;
    };
    expect(configOnly.entries.every((entry) => entry.kind === "config")).toBe(true);
  });

  it("/api/resources/raw 可读配置文件，未知 id 返回 404", async () => {
    const ok = await fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent("config:app.json")}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("resourceRoot");

    const missing = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent("project:Nope/project.json")}`);
    expect(missing.status).toBe(404);
  });

  it("/api/state 暴露运行态摘要（前端是谁 / 镜像的是哪份场景）", async () => {
    const response = await fetch(`${baseUrl}/api/state`);
    const body = (await response.json()) as {
      runtimeActive: boolean;
      client: unknown;
      scene: unknown;
      serverTime: number;
    };

    expect(body.runtimeActive).toBe(false);
    expect(body.client).toBeNull();
    expect(body.scene).toBeNull();
    expect(typeof body.serverTime).toBe("number");
  });

  it("未构建前端时根路径给出可操作提示而不是报错", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/DiceTaleStudio|编辑器/);
  });
});
