import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createTempResourceRoot } from "./helpers/temp-root";
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
  /** 只读用例：直接读仓库里真实的 resources/。 */
  async function realProvider(): Promise<FsResourceProvider> {
    const config = await loadConfig();
    return new FsResourceProvider(config.resourceRoot, config.dirs);
  }

  /** 写盘用例：临时资源根，避免写入仓库 resources/ 或与其它进程抢目录。 */
  async function withTempProvider(): Promise<{
    provider: FsResourceProvider;
    dispose: () => Promise<void>;
  }> {
    const temp = await createTempResourceRoot();
    return {
      provider: new FsResourceProvider(temp.config.resourceRoot, temp.config.dirs),
      dispose: temp.dispose,
    };
  }

  it("按配置解析资源根，只列出真实文件（跳过 .gitkeep）", async () => {
    const provider = await realProvider();
    const entries = await provider.list("config");

    expect(entries.map((entry) => entry.id)).toContain("config:app.json");
    expect(entries.every((entry) => entry.id.endsWith(".gitkeep"))).toBe(false);
  });

  it("全部资源列出时包含配置目录下的文件", async () => {
    const provider = await realProvider();
    const entries = await provider.list();
    expect(entries.some((entry) => entry.kind === "config")).toBe(true);
  });

  it("读写往返一致，删除时连目录一起清掉", async () => {
    const { provider, dispose } = await withTempProvider();
    const id = "project:__arch_test/project.json";

    try {
      await provider.writeText(id, "{\"hello\":\"世界\"}");
      expect(await provider.exists(id)).toBe(true);
      expect(await provider.readText(id)).toBe("{\"hello\":\"世界\"}");
    } finally {
      // 连目录一起清掉：writeText 会自动建出父目录，只删文件会留下空目录
      await provider.remove("project:__arch_test");
      await dispose();
    }

    expect(await provider.exists(id)).toBe(false);
  });

  it("目录也会被列出（编辑器要能看到空目录）", async () => {
    const { provider, dispose } = await withTempProvider();
    try {
      await provider.ensureFolder("project:C/maps");

      // 文件系统会同时列出中间目录（C）与目标目录（C/maps）
      const entries = await provider.list("project");
      const described = entries.map((entry) => `${entry.type}:${entry.path}`);
      expect(described).toContain("folder:C");
      expect(described).toContain("folder:C/maps");
      expect(entries.every((entry) => entry.size === 0)).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("二进制读写往返一致", async () => {
    const { provider, dispose } = await withTempProvider();
    const id = "project:__arch_test/maps/__arch_test.bytes";

    try {
      const payload = new Uint8Array([1, 2, 3, 250]).buffer;
      await provider.writeBinary(id, payload);
      expect(new Uint8Array(await provider.readBinary(id))).toEqual(new Uint8Array([1, 2, 3, 250]));
    } finally {
      await dispose();
    }
  });

  it("拒绝越出资源根的路径", async () => {
    const provider = await realProvider();
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
          project: "C:\\Windows",
        }),
    ).toThrow(/不允许是绝对路径/);
  });

  it("配置里的相对逃逸目录被拒绝", async () => {
    const config = await loadConfig();
    expect(
      () =>
        new FsResourceProvider(config.resourceRoot, {
          ...config.dirs,
          project: "../outside",
        }),
    ).toThrow(/越出资源根/);
  });
});
