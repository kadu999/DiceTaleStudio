import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scenePayloadOf,
  scenePayloadText,
  ScenePushScheduler,
  shouldPushScene,
} from "../src/services/runtime-push";
import { SPRITE_COMPONENT, type SceneDoc } from "@dts/document";

/**
 * 运行态场景推送的判定与去抖：这几条规则决定「编辑器改一下，前端多久、会不会收到」。
 */

function scene(name: string, x: number): SceneDoc {
  return {
    name,
    objects: [
      {
        id: "o1",
        name: "对象",
        kind: "Sprite",
        active: true,
        locked: false,
        sortingOrder: 0,
        position: { x, y: 0 },
        rotation: 0,
        scale: 1,
        components: [],
      },
    ],
  };
}

describe("shouldPushScene", () => {
  it("运行态 + 连着 + 内容变了 → 推", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: "a", next: "b" }),
    ).toBe(true);
  });

  it("编辑态不推（前端还没连）", () => {
    expect(
      shouldPushScene({ mode: "edit", connected: true, lastPushed: "a", next: "b" }),
    ).toBe(false);
  });

  it("没连服务端不推（重连时会补一次全量）", () => {
    expect(
      shouldPushScene({ mode: "run", connected: false, lastPushed: "a", next: "b" }),
    ).toBe(false);
  });

  it("内容没变不推（撤销回到原样、重绘、切页签都不该产生流量）", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: "same", next: "same" }),
    ).toBe(false);
  });

  it("第一次推（lastPushed 为空）要推", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: null, next: "a" }),
    ).toBe(true);
  });

  it("推空场景也算一次变更（清空前端的镜像）", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: "a", next: null }),
    ).toBe(true);
  });
});

describe("scenePayloadText", () => {
  it("带上场景名与对象：切场景算一次变更", () => {
    const first = scenePayloadText(scene("场景1", 0));
    const sameContentOtherName = scenePayloadText(scene("场景2", 0));
    expect(first).not.toBe(sameContentOtherName);
  });

  it("同一份内容算出的文本一致（否则去重会失效）", () => {
    expect(scenePayloadText(scene("场景1", 10))).toBe(scenePayloadText(scene("场景1", 10)));
  });

  it("位置改了文本就变（拖动必须被推下去）", () => {
    expect(scenePayloadText(scene("场景1", 10))).not.toBe(scenePayloadText(scene("场景1", 11)));
  });

  it("null 表示没有打开的场景", () => {
    expect(scenePayloadText(null)).toBeNull();
  });

  it("精灵：子图的切分随载荷走；改切分文本就变（没有子图的对象不受影响）", () => {
    const imageId = "project:P/Assets/images/sheet.png";
    const sheets = { [imageId]: { columns: 4, rows: 2 } };

    expect(scenePayloadOf(sceneWithSprite(imageId, { column: 1, row: 0 }), sheets)).toMatchObject({
      objects: [
        {
          components: [
            {
              data: {
                id: imageId,
                sprite: { column: 1, row: 0 },
                spriteGrid: { columns: 4, rows: 2 },
              },
            },
          ],
        },
      ],
    });

    // 同一份场景 + 同一张表：文本一致（去重照旧有效）
    const withSprite = sceneWithSprite(imageId, { column: 1, row: 0 });
    expect(scenePayloadText(withSprite, sheets)).toBe(scenePayloadText(withSprite, sheets));

    // 改切分（4×2 → 2×1）：文本必须变——这就是「改切分，所有引用它的对象一起变」
    expect(scenePayloadText(withSprite, sheets)).not.toBe(
      scenePayloadText(withSprite, { [imageId]: { columns: 2, rows: 1 } }),
    );

    // 越界的格子在载荷里被夹到最后一格（协议会拒越界值）
    expect(
      (
        scenePayloadOf(sceneWithSprite(imageId, { column: 9, row: 9 }), sheets)?.objects[0]
          ?.components[0]?.data as { sprite?: unknown }
      ).sprite,
    ).toEqual({ column: 3, row: 1 });

    // 没有子图引用的对象：整份载荷与以前逐字一样（老项目不会因为这次改动多推任何东西）
    expect(scenePayloadText(scene("场景1", 0), sheets)).toBe(JSON.stringify(scene("场景1", 0)));
  });
});

/** 一个带子图引用的精灵（推送那几条用例用）。 */
function sceneWithSprite(imageId: string, sprite: { column: number; row: number }): SceneDoc {
  const base = scene("场景1", 0);
  const object = base.objects[0];
  if (object === undefined) {
    throw new Error("样例场景里没有对象");
  }

  return {
    ...base,
    objects: [
      {
        ...object,
        components: [
          {
            id: `${object.id}__${SPRITE_COMPONENT}`,
            type: SPRITE_COMPONENT,
            data: { id: imageId, width: 64, height: 32, sprite },
            actions: [],
          },
        ],
      },
    ],
  };
}

describe("ScenePushScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续 schedule 只推最后一次（拖动去抖）", () => {
    vi.useFakeTimers();
    const pushed: Array<string | null> = [];
    const scheduler = new ScenePushScheduler({ delayMs: 200, push: (text) => pushed.push(text) });

    scheduler.schedule("a");
    scheduler.schedule("b");
    scheduler.schedule("c");

    expect(pushed).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(pushed).toEqual(["c"]);
  });

  it("flush 立刻推，并取消还没发出去的那次", () => {
    vi.useFakeTimers();
    const pushed: Array<string | null> = [];
    const scheduler = new ScenePushScheduler({ delayMs: 200, push: (text) => pushed.push(text) });

    scheduler.schedule("later");
    scheduler.flush("now");

    expect(pushed).toEqual(["now"]);
    vi.advanceTimersByTime(500);
    expect(pushed).toEqual(["now"]);
  });

  it("cancel 之后什么都不会推（退出运行态时用）", () => {
    vi.useFakeTimers();
    const pushed: Array<string | null> = [];
    const scheduler = new ScenePushScheduler({ delayMs: 200, push: (text) => pushed.push(text) });

    scheduler.schedule("a");
    scheduler.cancel();
    vi.advanceTimersByTime(500);

    expect(pushed).toEqual([]);
  });
});
