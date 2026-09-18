import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../src/state/editor-store";

/**
 * 资源面板的「打开目录」：编辑器这一侧的接线。
 *
 * 真的去开后端那台机器的资源管理器，所以这里把 `fetch` 换成假的，只验两件事：
 * 请求打到了 `/api/projects/reveal`（带上当前项目名），以及成功 / 失败各自的收尾
 * （清错误 + 记日志 / 把原因写进 `project.error`）。
 */

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  json: () => Promise<unknown>;
}

function stubFetch(response: FakeResponse | Error): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${input} ${String(init?.body ?? "")}`.trim());
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useEditorStore.setState({
    project: { list: [], current: null, tree: [], busy: false, error: "" },
    runtime: { ...useEditorStore.getState().runtime, logs: [] },
  });
});

describe("打开项目目录", () => {
  it("没有打开项目时什么都不做（面板里也不会有这个按钮）", async () => {
    const calls = stubFetch({ ok: true, status: 200, json: async () => ({ ok: true, path: "/x" }) });

    await expect(useEditorStore.getState().openProjectFolder()).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("POST /api/projects/reveal 带上当前项目名，成功后记一条日志", async () => {
    const calls = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, path: "/资源/projects/测试项目" }),
    });
    useEditorStore.setState((state) => ({
      project: { ...state.project, current: "测试项目", error: "上一次的错" },
    }));

    await expect(useEditorStore.getState().openProjectFolder()).resolves.toBe(true);

    expect(calls[0]).toBe('POST /api/projects/reveal {"name":"测试项目"}');
    expect(useEditorStore.getState().project.error).toBe("");
    expect(useEditorStore.getState().runtime.logs.at(-1)?.message).toContain(
      "/资源/projects/测试项目",
    );
  });

  it("后端说打不开（例如系统没有文件管理器）时，把原因写出来", async () => {
    stubFetch({
      ok: false,
      status: 500,
      json: async () => ({ error: "当前系统（linux）不支持自动打开目录" }),
    });
    useEditorStore.setState((state) => ({ project: { ...state.project, current: "测试项目" } }));

    await expect(useEditorStore.getState().openProjectFolder()).resolves.toBe(false);
    expect(useEditorStore.getState().project.error).toContain("不支持自动打开目录");
  });

  it("连不上服务端时也有可读的原因", async () => {
    stubFetch(new Error("connect ECONNREFUSED"));
    useEditorStore.setState((state) => ({ project: { ...state.project, current: "测试项目" } }));

    await expect(useEditorStore.getState().openProjectFolder()).resolves.toBe(false);
    expect(useEditorStore.getState().project.error).toContain("无法连接服务端");
  });
});
