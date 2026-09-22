import { describe, expect, it } from "vitest";
import { COMPONENT_TYPE, type ScenePayload } from "@dts/protocol";
import { RuntimeSession, projectNameOfScene } from "../src/ws/runtime-session";

/**
 * 运行态会话的单元测试：开闸 / 关闸、场景缓存、前端信息、快照摘要。
 *
 * 旧模型里那套「对象 / 玩家 / 动作清单镜像」的合并语义测试已经删掉——那份镜像不存在了
 * （数据在后台，前端不再上报）。
 */

/** 造一个组件实例（v9 起对象特性住在 `components` 里）。 */
function feature(
  type: string,
  data: Record<string, unknown>,
): { id: string; type: string; data: Record<string, unknown> } {
  return { id: `c_${type}`, type, data };
}

function scene(name: string, objectCount: number): ScenePayload {
  return {
    name,
    objects: Array.from({ length: objectCount }, (_value, index) => ({
      id: `o${index}`,
      name: `对象${index}`,
      kind: "Sprite",
      active: true,
      sortingOrder: 0,
      position: { x: index, y: index },
      rotation: 0,
      scale: 1,
      components: [],
    })),
  };
}

describe("RuntimeSession", () => {
  it("初始：没开闸、没前端、没场景、没设置", () => {
    const session = new RuntimeSession();
    expect(session.runtimeActive).toBe(false);
    expect(session.client).toBeNull();
    expect(session.scene).toBeNull();
    expect(session.settings).toBeNull();
    expect(session.snapshot).toEqual({
      runtimeActive: false,
      client: null,
      scene: null,
      resources: null,
      settings: null,
    });
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

  it("记前端资源包状态，关闸时一并清掉", () => {
    const session = new RuntimeSession();
    session.start();
    session.setResources({
      project: "测试项目",
      fingerprint: "abc123",
      fileCount: 12,
      bytes: 1024,
      ok: true,
      at: 1,
    });

    expect(session.snapshot.resources?.fileCount).toBe(12);
    expect(session.snapshot.resources?.fingerprint).toBe("abc123");

    session.stop();
    expect(session.snapshot.resources).toBeNull();
  });

  it("全局设置：快照只报「什么时候推的」（v16 起设置里只有三档音量），关闸一起清", () => {
    const session = new RuntimeSession();
    session.start();

    session.setSettings({
      audio: {
        bgm: { volume: 0.6 },
        sfx: { volume: 0.8 },
        voice: { volume: 1 },
      },
    });

    expect(session.settings?.audio.bgm.volume).toBe(0.6);
    expect(session.snapshot.settings?.updatedAt).toBeGreaterThan(0);

    session.stop();
    expect(session.settings).toBeNull();
    expect(session.snapshot.settings).toBeNull();
  });

  it("从场景里的资源 ID 推出项目名（前端据此先下资源包）", () => {
    const withImage: ScenePayload = {
      name: "场景1",
      objects: [
        {
          id: "o1",
          name: "精灵",
          kind: "Sprite",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            feature(COMPONENT_TYPE.image, {
              id: "project:我的项目/Assets/images/a.png",
              width: 10,
              height: 10,
            }),
          ],
        },
      ],
    };
    expect(projectNameOfScene(withImage)).toBe("我的项目");

    // 只有声音对象（clips 里带项目 ID）也要能推出来
    const withSound: ScenePayload = {
      name: "场景1",
      objects: [
        {
          id: "s1",
          name: "脚步",
          kind: "PlaySound",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            feature(COMPONENT_TYPE.sound, {
              clips: ["project:音效库/Assets/audio/step1.mp3"],
              picked: "project:音效库/Assets/audio/step1.mp3",
              layer: "sfx",
            }),
          ],
        },
      ],
    };
    expect(projectNameOfScene(withSound)).toBe("音效库");
  });

  it("场景里没有项目资源 / 场景为空时推不出项目名", () => {
    expect(projectNameOfScene(null)).toBeNull();
    expect(projectNameOfScene({ name: "空", objects: [] })).toBeNull();

    // 只有 config: 类的 ID 推不出项目（那不是项目资源）
    const configOnly: ScenePayload = {
      name: "场景1",
      objects: [
        {
          id: "o1",
          name: "地图",
          kind: "Map",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            feature(COMPONENT_TYPE.map, {
              image: { id: "config:something.png", width: 10, height: 10 },
              grid: { width: 1, height: 1 },
              rowOrder: "bottom-up",
              cells: { encoding: "rle", runs: [[0, 1]] },
            }),
          ],
        },
      ],
    };
    expect(projectNameOfScene(configOnly)).toBeNull();
  });

  it("推场景时顺手更新「当前项目」（换项目会跟着变）", () => {
    const session = new RuntimeSession();
    session.start();

    session.setScene({
      name: "场景1",
      objects: [
        {
          id: "o1",
          name: "精灵",
          kind: "Sprite",
          active: true,
          sortingOrder: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            feature(COMPONENT_TYPE.image, {
              id: "project:甲/Assets/images/a.png",
              width: 10,
              height: 10,
            }),
          ],
        },
      ],
    });
    expect(session.resourceProject).toBe("甲");

    session.setScene({ name: "空场景", objects: [] });
    expect(session.resourceProject).toBeNull();

    session.stop();
    expect(session.resourceProject).toBeNull();
  });
});
