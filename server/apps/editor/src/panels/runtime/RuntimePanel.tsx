import { useEditorStore } from "../../state/editor-store";

/**
 * 运行态面板：连接状态、可触发动作、执行回执与日志。
 *
 * 运行态数据来自服务端镜像（`runtime` 切片），**不参与文档编辑、不进撤销栈**。
 */
export function RuntimePanel(): React.JSX.Element {
  const mode = useEditorStore((state) => state.mode);
  const runtime = useEditorStore((state) => state.runtime);
  const invokeAction = useEditorStore((state) => state.invokeAction);
  const clearRuntimeLogs = useEditorStore((state) => state.clearRuntimeLogs);

  const objects = Object.entries(runtime.state.objects).filter(
    ([, object]) => (object.actions?.length ?? 0) > 0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col panel">
      <div className="panel-header">
        <span>运行态</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px]">
            {runtime.status === "open" ? "已连接服务端" : runtime.status === "connecting" ? "连接中…" : "未连接"}
          </span>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background:
                runtime.status === "open"
                  ? "var(--color-editor-ok)"
                  : runtime.status === "connecting"
                    ? "var(--color-editor-warn)"
                    : "var(--color-editor-danger)",
            }}
          />
        </div>
      </div>

      {mode === "edit" ? (
        <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
          当前为编辑状态。切换到「运行」后会连接服务端，并可触发对象上的动作。
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center gap-3 border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px]">
            <span>
              前端：
              <span style={{ color: runtime.clientConnected ? "var(--color-editor-ok)" : "var(--color-editor-danger)" }}>
                {runtime.clientConnected ? "已连接" : "未连接"}
              </span>
            </span>
            <span className="text-[var(--color-editor-text-dim)]">
              当前地图 {runtime.state.currentMap || "—"}
            </span>
            <span className="ml-auto text-[var(--color-editor-text-dim)]">
              可触发对象 {objects.length}
            </span>
          </div>

          {runtime.lastError.length > 0 ? (
            <div className="border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px] text-[var(--color-editor-danger)]">
              {runtime.lastError}
            </div>
          ) : null}

          <div className="p-1">
            {objects.length === 0 ? (
              <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
                还没有可触发的动作。前端连上后会通过 <code>register_actions</code> 上报每个对象上的动作清单；
                本地调试可以运行 <code>pnpm --filter @dts/backend mock</code> 启动 Mock 前端。
              </div>
            ) : (
              objects.map(([objectId, object]) => (
                <div key={objectId} className="mb-2">
                  <div className="flex items-center gap-2 px-1.5 py-0.5 text-[11px]">
                    <span className="truncate">{object.name}</span>
                    <span className="font-mono text-[10px] text-[var(--color-editor-text-dim)]">{objectId}</span>
                  </div>
                  <div className="pl-2">
                    {(object.actions ?? []).map((action) => (
                      <div
                        key={action.actionId}
                        className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-editor-panel-alt)]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                          {action.displayName ?? action.actionId}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                          {action.type}
                        </span>
                        <button
                          type="button"
                          className="toolbar-button hover:toolbar-button-hover"
                          onClick={() => invokeAction(objectId, action.actionId)}
                        >
                          触发
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-[var(--color-editor-border)] px-2 py-0.5 text-[10px] text-[var(--color-editor-text-dim)]">
        <span>日志 {runtime.logs.length}</span>
        <button type="button" className="toolbar-button hover:toolbar-button-hover" onClick={clearRuntimeLogs}>
          清空
        </button>
      </div>

      <div className="h-28 min-h-0 overflow-auto border-t border-[var(--color-editor-border)] bg-black/30 px-2 py-1 font-mono text-[10px] leading-relaxed">
        {runtime.logs.length === 0 ? (
          <div className="text-[var(--color-editor-text-dim)]">（暂无日志）</div>
        ) : (
          runtime.logs
            .slice()
            .reverse()
            .map((entry) => (
              <div
                key={entry.id}
                style={{
                  color:
                    entry.level === "error"
                      ? "var(--color-editor-danger)"
                      : entry.level === "warn"
                        ? "var(--color-editor-warn)"
                        : "var(--color-editor-text)",
                }}
              >
                {entry.time} {entry.message}
              </div>
            ))
        )}
      </div>
    </div>
  );
}
