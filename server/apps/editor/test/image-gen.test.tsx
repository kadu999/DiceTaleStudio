import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  SPRITE_COMPONENT,
  createEmptyProject,
  createGameObject,
  featureComponent,
  type GameObjectDoc,
} from "@dts/document";
import { ImageGenDialog } from "../src/app/ImageGenDialog";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **AI 生图**（菜单栏「工具 → AI 生图」）：聊天框 + 一条后端接口。
 *
 * 这里钉住编辑器这一侧的四件事：
 * 1. 写一句提示词就发 `/api/tools/generate-image`（项目名 / 提示词 / 尺寸都带上）；
 * 2. 画好的图**当成普通项目素材**记下来（id / path / guid / 宽高）并刷新资源树；
 * 3. 失败**留在对话里**（红字 + 后端给的原因），不弹一次性提示；
 * 4. 「用作选中对象的贴图」走的是与「从项目里挑一张图」**同一条命令**（身份 GUID 也带上），
 *    没选中 / 选多了则只回一句人话，什么都不改。
 *
 * 真调供应商那一侧不在这里（那是后端的事，`apps/backend/test/image-gen-api.test.ts` 逐字钉了
 * URL / body / Bearer 与三种失败码）；真点菜单交给 e2e（Radix 下拉在 jsdom 里开不利索）。
 */

const PROJECT = "测试";
const GEN_ID = `project:${PROJECT}/Assets/images/generated/gen-1.png`;
const TREE: ResourceTreeNode[] = [
  {
    name: "images",
    path: "Assets/images",
    id: `project:${PROJECT}/Assets/images`,
    type: "folder",
    children: [
      { name: "gen-1.png", path: "Assets/images/generated/gen-1.png", id: GEN_ID, type: "file", size: 1 },
    ],
  },
];

/** 一个能贴图的精灵对象。 */
function sprite(id = "sprite-1"): GameObjectDoc {
  return {
    ...createGameObject({ id, name: "精灵", position: { x: 0, y: 0 } }),
    components: [featureComponent(id, SPRITE_COMPONENT, { id: `project:${PROJECT}/Assets/images/old.png`, width: 8, height: 8 })],
  };
}

/** 种一份场景 + 工程文件，并把 store 摆成「项目已打开、选好对象」。 */
function seed(objects: GameObjectDoc[], selected: readonly string[]): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  projectHistory.reset(createEmptyProject(PROJECT));
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [...selected],
    project: { list: [], current: PROJECT, tree: [], busy: false, error: "" },
    imageGenDialog: true,
    imageGenEntries: [],
    imageGenBusy: false,
  });
}

describe("AI 生图", () => {
  let calls: { url: string; body: unknown }[];
  let status: number;
  let payload: unknown;

  beforeEach(() => {
    calls = [];
    status = 200;
    payload = { id: GEN_ID, path: "Assets/images/generated/gen-1.png", guid: "a".repeat(32), width: 64, height: 64 };

    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown, code = 200): Response =>
        new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

      if (url.includes("/api/tools/generate-image")) {
        calls.push({ url, body: JSON.parse(String(init?.body)) as unknown });
        return Promise.resolve(json(payload, status));
      }

      if (url.includes("/api/projects/tree")) {
        return Promise.resolve(json({ tree: TREE }));
      }

      if (url.includes("/api/projects/meta")) {
        return Promise.resolve(json({ metas: {}, unreadable: [] }));
      }

      return Promise.resolve(json({ ok: true }));
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("写一句提示词：带上项目名 / 提示词 / 尺寸发给后端，画好的图记进对话并刷新资源树", async () => {
    seed([sprite()], ["sprite-1"]);

    await act(async () => {
      await useEditorStore.getState().generateImage("一把生锈的黄铜钥匙", "512x512");
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      project: PROJECT,
      prompt: "一把生锈的黄铜钥匙",
      size: "512x512",
    });

    const state = useEditorStore.getState();
    expect(state.imageGenBusy).toBe(false);
    expect(state.imageGenEntries).toHaveLength(1);
    expect(state.imageGenEntries[0]!.status).toBe("done");
    expect(state.imageGenEntries[0]!.image?.id).toBe(GEN_ID);
    // 新素材进了项目：资源树刷过一遍，素材面板立刻能看到它
    expect(state.project.tree).toEqual(TREE);
  });

  it("后端报错：错误原文留在那一条对话里（不吞掉、也不改成「内部错误」）", async () => {
    status = 400;
    payload = { error: "还没配置生图接口：设置环境变量 DTS_IMAGE_API_KEY…" };
    seed([sprite()], ["sprite-1"]);

    await act(async () => {
      await useEditorStore.getState().generateImage("一把钥匙");
    });

    const state = useEditorStore.getState();
    expect(state.imageGenBusy).toBe(false);
    expect(state.imageGenEntries[0]!.status).toBe("error");
    expect(state.imageGenEntries[0]!.error).toContain("DTS_IMAGE_API_KEY");
  });

  it("用作选中对象的贴图：走「挑图」同一条命令，身份 GUID 一起写上", async () => {
    seed([sprite()], ["sprite-1"]);
    await act(async () => {
      await useEditorStore.getState().generateImage("一把钥匙");
    });

    const entryId = useEditorStore.getState().imageGenEntries[0]!.id;
    let message = "";
    act(() => {
      message = useEditorStore.getState().useGeneratedImage(entryId);
    });

    expect(message).toBe("");
    const image = useEditorStore.getState().scenes[0]!.objects[0]!.components[0]!.data as Record<string, unknown>;
    expect(image.id).toBe(GEN_ID);
    expect(image.width).toBe(64);
    expect(image.height).toBe(64);
    expect(image.guid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("没选中 / 选多了：只回一句人话，一个字节都不改", async () => {
    seed([sprite("a"), sprite("b")], ["a", "b"]);
    await act(async () => {
      await useEditorStore.getState().generateImage("一把钥匙");
    });

    const before = useEditorStore.getState().scenes[0]!.objects[0]!.components[0]!.data;
    const entryId = useEditorStore.getState().imageGenEntries[0]!.id;
    let message = "";
    act(() => {
      message = useEditorStore.getState().useGeneratedImage(entryId);
    });

    expect(message).toContain("选中");
    expect(useEditorStore.getState().scenes[0]!.objects[0]!.components[0]!.data).toBe(before);
  });

  it("聊天框：写一句 → 点「生成」→ 出图；在画的那会儿输入框与按钮一起禁用", async () => {
    seed([sprite()], ["sprite-1"]);
    render(<ImageGenDialog />);

    fireEvent.change(screen.getByTestId("image-gen-prompt"), { target: { value: "海边的灯塔" } });

    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const pending = { id: GEN_ID, path: "Assets/images/generated/gen-1.png", guid: "b".repeat(32), width: 64, height: 64 };
    // 卡住这一次生成：好在「正在画」的那一瞬间检查按钮状态
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/tools/generate-image")) {
        calls.push({ url, body: JSON.parse(String(init?.body)) as unknown });
        await gate;
        return new Response(JSON.stringify(pending), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response(JSON.stringify({ tree: TREE, metas: {}, unreadable: [], ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("image-gen-send"));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("image-gen-pending")).toBeTruthy();
    expect((screen.getByTestId("image-gen-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("image-gen-prompt") as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      released?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("image-gen-image")).toBeTruthy();
    });
    expect((screen.getByTestId("image-gen-image") as HTMLImageElement).getAttribute("src")).toContain(
      encodeURIComponent(GEN_ID),
    );
  });
});
