import { describe, expect, it } from "vitest";
import { DocumentHistory } from "../src/history";

interface Doc {
  counter: number;
  items: string[];
  nested: { label: string };
}

function initial(): Doc {
  return { counter: 0, items: [], nested: { label: "a" } };
}

describe("补丁式历史：撤销 / 重做", () => {
  it("记录变更并可撤销、重做", () => {
    const history = new DocumentHistory<Doc>(initial());

    expect(history.apply("加一", (draft) => {
      draft.counter += 1;
    })).toBe(true);

    expect(history.current.counter).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    expect(history.undo()).toBe(true);
    expect(history.current.counter).toBe(0);
    expect(history.canRedo).toBe(true);

    expect(history.redo()).toBe(true);
    expect(history.current.counter).toBe(1);
  });

  it("无实际变更时返回 false 且不入栈", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("加一", (draft) => {
      draft.counter += 1;
    });

    const changed = history.apply("空操作", () => {
      // 什么都不改
    });

    expect(changed).toBe(false);
    expect(history.undoDepth).toBe(1);
  });

  it("多次撤销后回到初始状态，再多撤销返回 false", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("a", (draft) => {
      draft.items.push("x");
    });
    history.apply("b", (draft) => {
      draft.items.push("y");
    });

    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(history.current.items).toEqual([]);
    expect(history.undo()).toBe(false);
  });

  it("撤销标签反映最近一次操作", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("移动对象", (draft) => {
      draft.counter = 5;
    });
    expect(history.undoLabel).toBe("移动对象");
  });

  it("嵌套结构也能正确还原（深拷贝语义）", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("改标签", (draft) => {
      draft.nested.label = "b";
    });
    expect(history.current.nested.label).toBe("b");
    history.undo();
    expect(history.current.nested.label).toBe("a");
  });

  it("撤销后产生新变更会清空重做栈", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("a", (draft) => {
      draft.counter = 1;
    });
    history.undo();
    expect(history.canRedo).toBe(true);

    history.apply("b", (draft) => {
      draft.counter = 9;
    });
    expect(history.canRedo).toBe(false);
  });

  it("clearRedo：只丢重做栈（撤销栈与当前值不动）——两套历史共用撤销入口时用", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("a", (draft) => {
      draft.counter = 1;
    });
    history.undo();
    expect(history.canRedo).toBe(true);

    history.clearRedo();

    expect(history.canRedo).toBe(false);
    expect(history.canUndo).toBe(false);
    expect(history.current.counter).toBe(0);
    // 撤销栈没被动过：清完之后还能继续正常编辑与撤销
    history.apply("b", (draft) => {
      draft.counter = 2;
    });
    expect(history.undoLabel).toBe("b");
  });
});

describe("补丁式历史：连续操作合并", () => {
  it("相同 coalesceKey 的连续操作合并为一条记录（拖拽/连续绘制）", () => {
    const history = new DocumentHistory<Doc>(initial());
    const recipe = (draft: Doc): void => {
      draft.counter += 1;
    };

    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });
    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });
    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });

    expect(history.current.counter).toBe(3);
    expect(history.undoDepth).toBe(1);

    history.undo();
    expect(history.current.counter).toBe(0);
  });

  it("不同 coalesceKey 不合并", () => {
    const history = new DocumentHistory<Doc>(initial());
    const recipe = (draft: Doc): void => {
      draft.counter += 1;
    };

    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });
    history.apply("拖拽", recipe, { coalesceKey: "drag:obj2" });

    expect(history.undoDepth).toBe(2);
  });

  it("endCoalescing 之后的同键操作另起一条记录（松手后重新计一次）", () => {
    const history = new DocumentHistory<Doc>(initial());
    const recipe = (draft: Doc): void => {
      draft.counter += 1;
    };

    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });
    history.endCoalescing();
    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });

    expect(history.undoDepth).toBe(2);
    history.undo();
    expect(history.current.counter).toBe(1);
  });

  it("超过合并时间窗后不合并", async () => {
    const history = new DocumentHistory<Doc>(initial(), { coalesceWindowMs: 5 });
    const recipe = (draft: Doc): void => {
      draft.counter += 1;
    };

    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    history.apply("拖拽", recipe, { coalesceKey: "drag:obj1" });

    expect(history.undoDepth).toBe(2);
  });
});

describe("补丁式历史：上限与重置", () => {
  it("超过上限时丢弃最老的记录", () => {
    const history = new DocumentHistory<Doc>(initial(), { limit: 3 });
    for (let i = 1; i <= 5; i += 1) {
      history.apply(`第 ${i} 次`, (draft) => {
        draft.counter = i;
      });
    }

    expect(history.undoDepth).toBe(3);
    history.undo();
    history.undo();
    history.undo();
    expect(history.undo()).toBe(false);
    // 最老的两条被丢弃，因此撤销三次后停在 counter = 2
    expect(history.current.counter).toBe(2);
  });

  it("reset 替换文档并清空历史", () => {
    const history = new DocumentHistory<Doc>(initial());
    history.apply("a", (draft) => {
      draft.counter = 1;
    });

    history.reset({ counter: 100, items: ["z"], nested: { label: "n" } });

    expect(history.current.counter).toBe(100);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it("订阅者在每次变更时被通知", () => {
    const history = new DocumentHistory<Doc>(initial());
    let calls = 0;
    const unsubscribe = history.subscribe(() => {
      calls += 1;
    });

    history.apply("a", (draft) => {
      draft.counter = 1;
    });
    history.undo();
    history.redo();
    expect(calls).toBe(3);

    unsubscribe();
    history.apply("b", (draft) => {
      draft.counter = 2;
    });
    expect(calls).toBe(3);
  });
});
