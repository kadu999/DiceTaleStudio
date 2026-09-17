import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RunState } from "../src/ws/run-state";

/**
 * 运行态内存状态与文件系统资源实现的单元测试。
 *
 * 重点：运行态镜像的合并语义，以及资源路径不会逃出资源根。
 */

describe("RunState 合并语义", () => {
  it("重新加载地图时保留已上报的动作清单（合并而不是覆盖）", () => {
    const state = new RunState();
    state.registerObjects("Map001", [{ id: "door", name: "木门", kind: "SceneObject", position: null }]);
    state.registerActions("door", [{ actionId: "act_1", type: "ShowHide" }]);

    // 模拟地图重载后的再次上报（对象数据里没有 actions 字段）
    state.registerObjects("Map001", [
      { id: "door", name: "木门", kind: "SceneObject", position: { x: 0.2, y: 0.3 } },
    ]);

    expect(state.snapshot.state.objects.door?.actions?.map((action) => action.actionId)).toEqual([
      "act_1",
    ]);
    expect(state.snapshot.state.objects.door?.position).toEqual({ x: 0.2, y: 0.3 });
  });

  it("对未知对象上报动作清单返回 false（不静默创建幽灵对象）", () => {
    const state = new RunState();
    expect(state.registerActions("ghost", [{ actionId: "a", type: "ShowHide" }])).toBe(false);
  });

  it("findAction 用于触发前检查", () => {
    const state = new RunState();
    state.registerObjects("Map001", [{ id: "door" }]);
    state.registerActions("door", [{ actionId: "act_1", type: "ShowHide" }]);

    expect(state.findAction("door", "act_1")).toBe(true);
    expect(state.findAction("door", "act_2")).toBe(false);
    expect(state.findAction("ghost", "act_1")).toBe(false);
  });

  it("listActions 汇总全部可触发动作", () => {
    const state = new RunState();
    state.registerObjects("Map001", [{ id: "a" }, { id: "b" }]);
    state.registerActions("a", [{ actionId: "a1", type: "ShowHide" }]);
    state.registerActions("b", [{ actionId: "b1", type: "PlayVideo", displayName: "过场" }]);

    expect(state.listActions()).toEqual([
      { objectId: "a", actionId: "a1", type: "ShowHide" },
      { objectId: "b", actionId: "b1", type: "PlayVideo", displayName: "过场" },
    ]);
  });

  it("前端断开即清空（单客户端架构、无持久化）", () => {
    const state = new RunState();
    state.setClientConnected(true);
    state.registerObjects("Map001", [{ id: "door" }]);
    expect(Object.keys(state.snapshot.state.objects)).toHaveLength(1);

    state.setClientConnected(false);
    expect(state.snapshot.state.objects).toEqual({});
    expect(state.snapshot.state.currentMap).toBe("");
  });

  it("玩家与对象位置按 id 更新", () => {
    const state = new RunState();
    state.registerPlayers([{ id: "p1", name: "调查员" }], "Map001");
    state.setPlayerPosition("p1", { x: 0.1, y: 0.2 }, "Map002");
    expect(state.snapshot.state.players.p1).toEqual({
      name: "调查员",
      position: { x: 0.1, y: 0.2 },
      mapName: "Map002",
    });

    state.setObjectPosition("door", { x: 0.5, y: 0.5 }, "Map001");
    expect(state.snapshot.state.objects.door?.position).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("文件系统资源实现", () => {
  async function makeProvider(): Promise<FsResourceProvider> {
    const config = await loadConfig();
    return new FsResourceProvider(config.resourceRoot, config.dirs);
  }

  it("按配置解析资源根，并且只列出真实文件（跳过 .gitkeep）", async () => {
    const provider = await makeProvider();
    const entries = await provider.list("config");

    expect(entries.map((entry) => entry.id)).toContain("config:app.json");
    expect(entries.every((entry) => entry.id.endsWith(".gitkeep"))).toBe(false);
  });

  it("全部资源列出时包含配置与项目目录下的文件", async () => {
    const provider = await makeProvider();
    const entries = await provider.list();
    expect(entries.some((entry) => entry.kind === "config")).toBe(true);
  });

  it("读写往返一致（写入后能读回，并可删除）", async () => {
    const provider = await makeProvider();
    const id = "project:__arch_test.dtproj.json";

    try {
      await provider.writeText(id, "{\"hello\":\"世界\"}");
      expect(await provider.exists(id)).toBe(true);
      expect(await provider.readText(id)).toBe("{\"hello\":\"世界\"}");
    } finally {
      await provider.remove(id);
    }

    expect(await provider.exists(id)).toBe(false);
  });

  it("二进制读写往返一致", async () => {
    const provider = await makeProvider();
    const id = "map:__arch_test.bytes";

    try {
      const payload = new Uint8Array([1, 2, 3, 250]).buffer;
      await provider.writeBinary(id, payload);
      expect(new Uint8Array(await provider.readBinary(id))).toEqual(new Uint8Array([1, 2, 3, 250]));
    } finally {
      await provider.remove(id);
    }
  });

  it("拒绝越出资源根的路径", async () => {
    const provider = await makeProvider();
    await expect(provider.readText("config:../../package.json")).rejects.toThrow(
      /不允许越出资源根/,
    );
  });

  it("配置里的绝对路径目录被拒绝（防止写到仓库外）", async () => {
    const config = await loadConfig();
    expect(
      () =>
        new FsResourceProvider(config.resourceRoot, {
          ...config.dirs,
          map: "C:\\Windows",
        }),
    ).toThrow(/不允许是绝对路径/);
  });

  it("配置里的相对逃逸目录被拒绝", async () => {
    const config = await loadConfig();
    expect(
      () =>
        new FsResourceProvider(config.resourceRoot, {
          ...config.dirs,
          image: "../outside",
        }),
    ).toThrow(/越出资源根/);
  });
});
