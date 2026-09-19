import { describe, expect, it } from "vitest";
import type { ScenePayload } from "@dts/protocol";
import { RuntimeSession } from "../src/ws/runtime-session";

/**
 * 运行态会话的单元测试：开闸 / 关闸、场景缓存、前端信息、快照摘要。
 *
 * 旧模型里那套「对象 / 玩家 / 动作清单镜像」的合并语义测试已经删掉——那份镜像不存在了
 * （数据在后台，前端不再上报）。
 */

function scene(name: string, objectCount: number): ScenePayload {
  return {
    name,
    objects: Array.from({ length: objectCount }, (_value, index) => ({
      id: `o${index}`,
      name: `对象${index}`,
      kind: "SceneObject",
      active: true,
      sortingOrder: 0,
      position: { x: index, y: index },
      rotation: 0,
      scale: 1,
    })),
  };
}

describe("RuntimeSession", () => {
  it("初始：没开闸、没前端、没场景", () => {
    const session = new RuntimeSession();
    expect(session.runtimeActive).toBe(false);
    expect(session.client).toBeNull();
    expect(session.scene).toBeNull();
    expect(session.snapshot).toEqual({ runtimeActive: false, client: null, scene: null });
  });

  it("开闸是幂等的，不会把已推的场景清掉", () => {
    const session = new RuntimeSession();
    session.start();
    session.setScene(scene("场景1", 2));
    session.start();

    expect(session.runtimeActive).toBe(true);
    expect(session.scene?.objects).toHaveLength(2);
  });

  it("快照里的场景是摘要：名字 + 对象数 + 更新时间", () => {
    const session = new RuntimeSession();
    session.start();
    session.setScene(scene("场景1", 3));

    const summary = session.snapshot.scene;
    expect(summary?.name).toBe("场景1");
    expect(summary?.objectCount).toBe(3);
    expect(summary?.updatedAt).toBeGreaterThan(0);
  });

  it("关闸清掉场景缓存与前端信息（旧运行态不留痕）", () => {
    const session = new RuntimeSession();
    session.start();
    session.setClient({ name: "Unity", version: "1.0.0", connectedAt: 1, address: "127.0.0.1" });
    session.setScene(scene("场景1", 1));

    session.stop();

    expect(session.runtimeActive).toBe(false);
    expect(session.client).toBeNull();
    expect(session.scene).toBeNull();
    expect(session.snapshot.scene).toBeNull();
  });

  it("推 null = 编辑器没有打开的场景（前端据此清空镜像）", () => {
    const session = new RuntimeSession();
    session.start();
    session.setScene(scene("场景1", 1));
    session.setScene(null);

    expect(session.scene).toBeNull();
    // updatedAt 仍然会被刷新（前端知道「刚刚同步过一次空场景」）
    expect(session.snapshot.scene).toBeNull();
  });

  it("会话 id 稳定且可读（同一次运行态里不变）", () => {
    const session = new RuntimeSession();
    const first = session.sessionId;
    session.start();
    session.stop();
    expect(session.sessionId).toBe(first);
    expect(first.startsWith("sess-")).toBe(true);
  });
});
