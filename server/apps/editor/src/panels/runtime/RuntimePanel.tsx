import { useEditorStore } from "../../state/editor-store";
import { SOUND_LAYER_LABELS } from "@dts/document";

/** 字节数说人话（资源包小到几 KB、大到几百 MB，固定单位看着别扭）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 运行态面板：**服务端连接 + 运行态开关 + 前端镜像 + 命令日志**。
 *
 * 数据方向是单向的（编辑器/服务端 → 前端）：面板上要看的就三件事——
 * 1. 我连上服务端了吗；
 * 2. 开闸了吗（没开闸前端根本连不上）；
 * 3. **镜像到哪了**：前端是谁、推下去的是哪个场景、几个对象。
 *
 * 「可触发动作」那张表已经删掉：前端不再上报动作（旧模型），能下发的命令就是声音那两条，
 * 入口在声音对象的属性面板里。
 */
export function RuntimePanel(): React.JSX.Element {
  const mode = useEditorStore((state) => state.mode);
  const runtime = useEditorStore((state) => state.runtime);
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const pushRuntimeScene = useEditorStore((state) => state.pushRuntimeScene);
  const clearRuntimeLogs = useEditorStore((state) => state.clearRuntimeLogs);

  const activeScene = scenes.find((scene) => scene.name === activeSceneName) ?? null;
  const clientConnected = runtime.client !== null;
  const syncedAt = runtime.scene === null ? "" : new Date(runtime.scene.updatedAt).toLocaleTimeString("zh-CN", { hour12: false });

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
          当前为编辑状态。点「运行」后：服务端开闸（前端这时才连得上），并把当前场景整份推给前端。
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* 运行态 / 开闸 */}
          <div className="flex items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px]">
            <span
              className="inline-block h-2 w-2 flex-none rounded-full"
              style={{
                background: runtime.runtimeActive ? "var(--color-editor-ok)" : "var(--color-editor-warn)",
              }}
            />
            <span>{runtime.runtimeActive ? "运行态已开闸" : "正在开闸…"}</span>
            <span className="text-[var(--color-editor-text-dim)]">
              {runtime.runtimeActive ? "（前端可以连接）" : ""}
            </span>
          </div>

          {/* 前端镜像：连没连 + 镜像到哪了 */}
          <div
            data-testid="runtime-client"
            data-connected={clientConnected ? "yes" : "no"}
            className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px]"
          >
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-full ${clientConnected ? "animate-pulse" : ""}`}
                style={{
                  background: clientConnected ? "var(--color-editor-ok)" : "var(--color-editor-text-dim)",
                }}
              />
              <span style={{ color: clientConnected ? "var(--color-editor-ok)" : "var(--color-editor-text-dim)" }}>
                {clientConnected ? "前端已连接" : "等待前端连接"}
              </span>
            </span>
            {clientConnected && runtime.client !== null ? (
              <span className="text-[var(--color-editor-text-dim)]">
                {runtime.client.name}
                {runtime.client.version === "" ? "" : ` v${runtime.client.version}`}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px]">
            <span>
              镜像场景：
              <span
                data-testid="runtime-mirror-scene"
                className="text-[var(--color-editor-text)]"
              >
                {runtime.scene?.name ?? (activeScene?.name ?? "—")}
              </span>
            </span>
            <span className="text-[var(--color-editor-text-dim)]">
              对象 {runtime.scene?.objectCount ?? activeScene?.objects.length ?? 0}
            </span>
            {syncedAt === "" ? null : (
              <span className="text-[var(--color-editor-text-dim)]">同步于 {syncedAt}</span>
            )}
            <button
              type="button"
              data-testid="runtime-resync"
              className="toolbar-button ml-auto hover:toolbar-button-hover"
              title="再把当前场景整份推一次（前端会自动重连并拿到全量）"
              onClick={pushRuntimeScene}
            >
              重新同步
            </button>
          </div>

          {runtime.lastError.length > 0 ? (
            <div className="border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px] text-[var(--color-editor-danger)]">
              {runtime.lastError}
            </div>
          ) : null}

          {/*
            前端本地资源包：连上后它会把当前项目的 Assets/ 整包下到本地，之后资源不再逐张走 HTTP。
            没收到回执时明确写「还没报」——不静默留白，也不假装就绪。
          */}
          <div
            data-testid="runtime-resources"
            data-ready={runtime.resources === null ? "unknown" : runtime.resources.ok ? "yes" : "no"}
            className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px]"
          >
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  background:
                    runtime.resources === null
                      ? "var(--color-editor-text-dim)"
                      : runtime.resources.ok
                        ? "var(--color-editor-ok)"
                        : "var(--color-editor-danger)",
                }}
              />
              <span
                style={{
                  color:
                    runtime.resources === null
                      ? "var(--color-editor-text-dim)"
                      : runtime.resources.ok
                        ? "var(--color-editor-ok)"
                        : "var(--color-editor-danger)",
                }}
              >
                资源包：
                {runtime.resources === null
                  ? "等待前端回执"
                  : runtime.resources.ok
                    ? "已就绪"
                    : "失败"}
              </span>
            </span>
            {runtime.resources === null ? null : (
              <>
                <span className="text-[var(--color-editor-text-dim)]">
                  「{runtime.resources.project}」{runtime.resources.fileCount} 个文件 / {formatBytes(runtime.resources.bytes)}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-editor-text-dim)]" title="资源指纹：素材一变它就变">
                  {runtime.resources.fingerprint}
                </span>
                {runtime.resources.reason === undefined || runtime.resources.reason.length === 0 ? null : (
                  <span className="text-[var(--color-editor-danger)]">{runtime.resources.reason}</span>
                )}
              </>
            )}
          </div>

          <div className="px-2 py-2 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
            <div className="mb-1 text-[var(--color-editor-warn)]">
              运行中的改动<span className="font-medium">不会保存</span>，也不会进撤销栈：点「编辑」退出运行会把文档
              还原到进入运行前的样子（对齐 Unity 的运行模式）。
            </div>
            <div>
              声音对象在属性面板里点「播放 / 停止」：命令只带
              <code> objectId + layer </code>
              ，播哪一条由前端从它自己的镜像里读（
              {Object.entries(SOUND_LAYER_LABELS)
                .map(([slug, label]) => `${slug}=${label}`)
                .join(" / ")}
              ）。
            </div>
            <div className="mt-1">
              本地调试：先切到运行态，再跑 <code>pnpm --filter @dts/backend mock</code>（它会自动重试到连上）。
            </div>
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
