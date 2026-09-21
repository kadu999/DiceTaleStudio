import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";import { AssetsPanel } from "../src/panels/assets/AssetsPanel";
import { useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * 资源面板（目录树 + 右列内容）的四件事：图标、可点的展开三角、选中文件的定位、
 * 「打开目录」打开的是**选中的那一层**。
 *
 * 面板整体是**只读**的（素材由外部提交到目录里），所以这里不验任何写盘动作；
 * `fetch` 只用来截「打开目录」打出去的请求体——真的去调文件管理器会弹窗口。
 *
 * 注意两边的 path 口径不同：**左树**的面板根就是 `Assets`（path 是空串），
 * **右列**用的是项目内相对路径（`Assets/...`）——这正是这个面板要对齐 Unity 的地方。
 */

const TREE: ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: "project:测试/Assets",
    type: "folder",
    children: [
      {
        name: "images",
        path: "Assets/images",
        id: "project:测试/Assets/images",
        type: "folder",
        children: [
          {
            name: "Map001.png",
            path: "Assets/images/Map001.png",
            id: "project:测试/Assets/images/Map001.png",
            type: "file",
            size: 4096,
          },
        ],
      },
      {
        name: "audio",
        path: "Assets/audio",
        id: "project:测试/Assets/audio",
        type: "folder",
        children: [
          {
            name: "bgm",
            path: "Assets/audio/bgm",
            id: "project:测试/Assets/audio/bgm",
            type: "folder",
            children: [
              {
                name: "theme.mp3",
                path: "Assets/audio/bgm/theme.mp3",
                id: "project:测试/Assets/audio/bgm/theme.mp3",
                type: "file",
                size: 2048,
              },
            ],
          },
        ],
      },
      {
        name: "note.txt",
        path: "Assets/note.txt",
        id: "project:测试/Assets/note.txt",
        type: "file",
        size: 20,
      },
    ],
  },
];

/** 所有目录树行的 path，按 DOM 顺序。 */
function treePaths(): (string | null)[] {
  return screen.queryAllByTestId("folder-tree-row").map((row) => row.getAttribute("data-path"));
}

/** 右列所有内容行的 path，按 DOM 顺序。 */
function contentPaths(): (string | null)[] {
  return screen
    .queryAllByTestId("folder-content-row")
    .map((row) => row.getAttribute("data-path"));
}

/** 按属性找一行（找不到就抛，免得后面报「undefined 不能读」这种难懂的错）。 */
function findRow(
  testId: string,
  path: string,
): HTMLElement {
  const row = screen
    .queryAllByTestId(testId)
    .find((item) => item.getAttribute("data-path") === path);
  if (row === undefined) {
    throw new Error(`没有这一行：${testId} / ${path}`);
  }

  return row;
}

/** 行里那个**可点的 label**（行容器自己没挂 onClick，点它不会触发任何事）。 */
function rowButton(rowTestId: string, path: string, buttonTestId: string): HTMLElement {
  const button = findRow(rowTestId, path).querySelector<HTMLElement>(`[data-testid="${buttonTestId}"]`);
  if (button === null) {
    throw new Error(`${path} 这一行里没有 ${buttonTestId}`);
  }

  return button;
}

/** 右列的某个文件夹 / 文件行。 */
function contentRow(path: string): HTMLElement {
  return findRow("folder-content-row", path);
}

/** 右列某一行的可点 label。 */
function contentButton(path: string): HTMLElement {
  return rowButton("folder-content-row", path, "folder-content-label");
}

/** 只截请求体；面板里点「打开目录」时用。 */
function stubFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${input} ${String(init?.body ?? "")}`.trim());
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, path: "/绝对/路径" }),
    });
  });
  return calls;
}

beforeEach(() => {
  useEditorStore.setState({
    project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
    selectedAssetId: null,
    activeSceneName: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("资源面板：图标", () => {
  it("目录树每一行都有文件夹图标，右列文件夹与文件各按类型给图标", () => {
    render(<AssetsPanel />);

    // 树里只列文件夹：面板根（path 是空串）+ 两个子目录
    const treeRows = screen.getAllByTestId("folder-tree-row");
    expect(treeRows.map((row) => row.getAttribute("data-icon"))).toEqual([
      "folder",
      "folder",
      "folder",
    ]);
    expect(treeRows.every((row) => row.querySelector("svg") !== null)).toBe(true);

    // 右列：文件夹 → folder、txt → text
    expect(contentRow("Assets/images").getAttribute("data-icon")).toBe("folder");
    expect(contentRow("Assets/note.txt").getAttribute("data-icon")).toBe("text");
  });

  it("进 images 之后文件行的图标跟着扩展名走", () => {
    render(<AssetsPanel />);

    fireEvent.click(contentButton("Assets/images"));

    expect(contentRow("Assets/images/Map001.png").getAttribute("data-icon")).toBe("image");
  });
});

describe("资源面板：展开三角", () => {
  it("点三角只展开 / 收起，不改变当前目录（内容列不动）", () => {
    render(<AssetsPanel />);

    // 根是展开的：Assets 的直属子目录都在，但嵌套的 bgm 还没出现
    expect(treePaths()).toEqual(["", "Assets/images", "Assets/audio"]);

    fireEvent.click(rowButton("folder-tree-row", "Assets/audio", "folder-tree-toggle"));
    expect(treePaths()).toEqual(["", "Assets/images", "Assets/audio", "Assets/audio/bgm"]);

    fireEvent.click(rowButton("folder-tree-row", "Assets/audio", "folder-tree-toggle"));
    expect(treePaths()).toEqual(["", "Assets/images", "Assets/audio"]);

    // 全程没有「进目录」：右列还在项目根（如果点三角被当成进目录，这里会变成 audio 的内容）
    expect(screen.getByTestId("folder-breadcrumb").textContent).toBe("/");
    expect(contentPaths()).toEqual(["Assets/images", "Assets/audio", "Assets/note.txt"]);
  });

  it("点行本身才进目录（并顺手展开它）", () => {
    render(<AssetsPanel />);

    fireEvent.click(rowButton("folder-tree-row", "Assets/images", "folder-tree-label"));

    expect(screen.getByTestId("folder-breadcrumb").textContent).toBe("/images");
    expect(contentRow("Assets/images/Map001.png")).toBeTruthy();
  });
});

describe("资源面板：定位选中的文件", () => {
  it("选中文件后左树里它所在的目录被高亮", () => {
    render(<AssetsPanel />);

    fireEvent.click(contentButton("Assets/images"));
    fireEvent.click(contentButton("Assets/images/Map001.png"));

    expect(findRow("folder-tree-row", "Assets/images").getAttribute("data-selected")).toBe("true");
    expect(findRow("folder-tree-row", "Assets/audio").getAttribute("data-selected")).toBe("false");
  });

  it("从右列钻进深目录时，左树自动展开到那一层并高亮", () => {
    render(<AssetsPanel />);

    // audio/bgm 一开始不在树里（audio 还没展开）
    expect(treePaths()).toEqual(["", "Assets/images", "Assets/audio"]);

    fireEvent.click(contentButton("Assets/audio"));
    fireEvent.click(contentButton("Assets/audio/bgm"));

    // 左树自己展开到 bgm，并把它标成「当前所在的目录」
    expect(treePaths()).toEqual(["", "Assets/images", "Assets/audio", "Assets/audio/bgm"]);
    expect(findRow("folder-tree-row", "Assets/audio/bgm").getAttribute("data-selected")).toBe(
      "true",
    );
  });

  it("点文件不会把右列退回上一层（选中文件 ≠ 离开这个目录）", () => {
    render(<AssetsPanel />);

    fireEvent.click(contentButton("Assets/audio"));
    fireEvent.click(contentButton("Assets/audio/bgm"));
    expect(screen.getByTestId("folder-breadcrumb").textContent).toBe("/audio/bgm");

    fireEvent.click(contentButton("Assets/audio/bgm/theme.mp3"));

    // 面包屑与右列内容都留在文件所在的那一层
    expect(screen.getByTestId("folder-breadcrumb").textContent).toBe("/audio/bgm");
    expect(contentPaths()).toEqual(["Assets/audio/bgm/theme.mp3"]);
    // 左树仍然跟着定位到文件所在目录
    expect(findRow("folder-tree-row", "Assets/audio/bgm").getAttribute("data-selected")).toBe(
      "true",
    );
  });

  it("「打开目录」按选中的东西打开（选文件就定位它，不是打开你浏览过的目录）", async () => {
    const calls = stubFetch();
    render(<AssetsPanel />);

    // 什么都没选 → 项目根
    fireEvent.click(screen.getByTestId("open-project-folder"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toBe('POST /api/projects/reveal {"name":"测试","path":"","selectFile":false}');

    // 进到 images → 打开 images 本身
    fireEvent.click(contentButton("Assets/images"));
    fireEvent.click(screen.getByTestId("open-project-folder"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe(
      'POST /api/projects/reveal {"name":"测试","path":"Assets/images","selectFile":false}',
    );

    // 选中 images 里的文件 → 打开它所在的目录并选中它。
    // 这一条正是之前的毛病：`currentPath` 抢在文件前面，开成了 `Assets/images` 而不带 selectFile
    fireEvent.click(contentButton("Assets/images/Map001.png"));
    fireEvent.click(screen.getByTestId("open-project-folder"));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toBe(
      'POST /api/projects/reveal {"name":"测试","path":"Assets/images/Map001.png","selectFile":true}',
    );
  });

  it("选中文件后再点左树的文件夹，目标换成那个文件夹（选中只有一个）", async () => {
    const calls = stubFetch();
    render(<AssetsPanel />);

    fireEvent.click(contentButton("Assets/images"));
    fireEvent.click(contentButton("Assets/images/Map001.png"));
    fireEvent.click(rowButton("folder-tree-row", "Assets/audio", "folder-tree-label"));

    fireEvent.click(screen.getByTestId("open-project-folder"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toBe(
      'POST /api/projects/reveal {"name":"测试","path":"Assets/audio","selectFile":false}',
    );
  });
});
