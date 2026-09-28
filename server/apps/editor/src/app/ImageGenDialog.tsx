import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayPath, assetRawUrl, listImageAssets } from "../panels/asset-picker";
import type { ImageGenEntry } from "../state/store-types";

/**
 * 「AI 生图」工具（菜单栏「工具 → AI 生图」）：一个**聊天框**。
 *
 * 写一句要画什么 → 后端调生图平台画一张、**直接存成项目素材** → 这里显示结果，
 * 并且可以一键「用作选中对象的贴图」。它**不是文档数据**：聊天记录只活在这一次会话里，
 * 生出来的图则已经是普通项目素材（素材面板里一样能看见、改名、删）。
 *
 * 平台与协议都在服务端（编辑器只从 `/api/config` 拿到「平台名 / 配没配好 / 尺寸档 / 默认抠背景」）。
 * 三个刻意的取舍：
 * - 出图慢（几十秒级），所以**同一时刻只画一张**（`imageGenBusy`），输入框与按钮一起禁用；
 *   失败也留在对话里（红字 + 供应商的原话），而不是弹一个转身就忘的提示。
 * - 尺寸档**由平台配置给**（火山 Seedream 认 `2K` / `4K`，OpenAI 只认几档 `宽x高`）；取不到就用内置默认。
 * - 抠背景是**逐次开关**（默认取服务端配置）：出图后转成带透明通道的 PNG，适合角色 / 道具贴图。
 */

/** 内置默认尺寸（服务端没给尺寸档时用；贴近 OpenAI 那几档）。 */
const DEFAULT_SIZE_OPTIONS = ["1024x1024", "1024x1536", "1536x1024", "512x512"] as const;

const DEFAULT_SIZE = "1024x1024";

export function ImageGenDialog(): React.JSX.Element {
  const open = useEditorStore((state) => state.imageGenDialog);
  const openDialog = useEditorStore((state) => state.openImageGenDialog);
  const entries = useEditorStore((state) => state.imageGenEntries);
  const busy = useEditorStore((state) => state.imageGenBusy);
  const generateImage = useEditorStore((state) => state.generateImage);
  const clearHistory = useEditorStore((state) => state.clearImageGenHistory);
  const useGeneratedImage = useEditorStore((state) => state.useGeneratedImage);
  const removeBackground = useEditorStore((state) => state.imageGenRemoveBackground);
  const setRemoveBackground = useEditorStore((state) => state.setImageGenRemoveBackground);
  const referenceImage = useEditorStore((state) => state.imageGenReferenceImage);
  const setReferenceImage = useEditorStore((state) => state.setImageGenReferenceImage);
  const imageGenConfig = useEditorStore((state) => state.imageGenConfig);
  const images = useEditorStore((state) => state.project.tree);
  const project = useEditorStore((state) => state.project.current);
  const selection = useEditorStore((state) => state.selectedObjectIds);

  const sizeOptions =
    imageGenConfig !== null && imageGenConfig.sizes.length > 0
      ? imageGenConfig.sizes
      : DEFAULT_SIZE_OPTIONS;
  const defaultSize = imageGenConfig?.defaultSize ?? DEFAULT_SIZE;
  const supportsEdit = imageGenConfig?.supportsEdit ?? false;
  const imageOptions = listImageAssets(images);

  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<string>(DEFAULT_SIZE);
  const [note, setNote] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 配置回来（或换了平台）时把尺寸对齐到平台的默认档；当前值仍是合法选项就不动
  useEffect(() => {
    if (!sizeOptions.includes(size)) {
      setSize(defaultSize);
    }
  }, [sizeOptions, defaultSize, size]);

  // 新的一条进来（或在画的那条出结果）就滚到底：聊天框的手感
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const send = async (): Promise<void> => {
    const text = prompt;
    if (busy || text.trim().length === 0) {
      return;
    }

    setPrompt("");
    setNote(null);
    await generateImage(text, size);
  };

  const apply = (entry: ImageGenEntry): void => {
    const message = useGeneratedImage(entry.id);
    setNote({ id: entry.id, text: message.length === 0 ? "已贴到选中的那个对象上" : message });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : openDialog(false))}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[55] bg-black/60" />
        <Dialog.Content
          data-testid="image-gen-dialog"
          className="fixed left-1/2 top-1/2 z-[56] flex h-[560px] max-h-[92vh] w-[600px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] shadow-2xl"
        >
          <div className="flex flex-none items-center gap-2 border-b border-[var(--color-editor-border)] px-3 py-2">
            <Dialog.Title className="text-[13px] font-semibold">AI 生图</Dialog.Title>
            <span className="text-[10px] text-[var(--color-editor-text-dim)]">
              画完直接存进项目，可以当贴图用
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                data-testid="image-gen-clear"
                disabled={entries.length === 0}
                title="清空对话（已经生成的图不会删，它们已经是项目素材）"
                className="rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  clearHistory();
                  setNote(null);
                }}
              >
                清空
              </button>
              <Dialog.Close
                data-testid="image-gen-close"
                aria-label="关闭"
                className="rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
              >
                关闭
              </Dialog.Close>
            </div>
          </div>

          <div
            data-testid="image-gen-messages"
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3"
          >
            {entries.length === 0 ? (
              <p className="m-auto max-w-[80%] text-center text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
                写一句要画什么（比如「一把生锈的黄铜钥匙，放在羊皮纸上」）。
                <br />
                画出来的图会直接存进项目的
                <span className="text-[var(--color-editor-text)]"> Assets/images/generated/</span>
                ，随后可以一键用作选中对象的贴图。
              </p>
            ) : null}

            {entries.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-1">
                {/* 你说的话 */}
                <div className="ml-auto max-w-[80%] rounded bg-[var(--color-editor-accent-dim)] px-2 py-1 text-[11px] leading-relaxed text-[var(--color-editor-text)]">
                  {entry.prompt}
                </div>

                {/* 它画的东西 */}
                <div className="flex max-w-[80%] flex-col gap-1 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 py-1.5">
                  {entry.status === "pending" ? (
                    <span
                      data-testid="image-gen-pending"
                      className="animate-pulse text-[11px] text-[var(--color-editor-text-dim)]"
                    >
                      正在画…（出图要几十秒，别关窗口）
                    </span>
                  ) : null}

                  {entry.status === "error" ? (
                    <span
                      data-testid="image-gen-error"
                      className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-editor-danger)]"
                    >
                      ✗ {entry.error}
                    </span>
                  ) : null}

                  {entry.image === undefined ? null : (
                    <>
                      <img
                        data-testid="image-gen-image"
                        src={assetRawUrl(entry.image.id)}
                        alt={entry.prompt}
                        className="max-h-56 w-auto self-start rounded border border-[var(--color-editor-border)]"
                      />
                      <span className="break-all text-[10px] text-[var(--color-editor-text-dim)]">
                        {entry.image.width}×{entry.image.height} · {entry.image.path}
                      </span>
                      <button
                        type="button"
                        data-testid="image-gen-apply"
                        disabled={selection.length !== 1}
                        title={
                          selection.length === 1
                            ? "把这张图设为当前选中对象的贴图"
                            : "先在画布上选中**一个**要贴这张图的对象"
                        }
                        className="self-start rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)] disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => apply(entry)}
                      >
                        用作选中对象的贴图
                      </button>
                    </>
                  )}

                  {note?.id !== entry.id ? null : (
                    <span
                      data-testid="image-gen-apply-note"
                      className="text-[10px] text-[var(--color-editor-text-dim)]"
                    >
                      {note.text}
                    </span>
                  )}
                </div>
              </div>
            ))}

            <div ref={bottomRef} />
          </div>

          <div className="flex flex-none flex-col gap-1.5 border-t border-[var(--color-editor-border)] p-3">
            <textarea
              data-testid="image-gen-prompt"
              value={prompt}
              disabled={busy || project === null}
              placeholder={
                project === null
                  ? "先打开一个项目"
                  : "要画什么？回车生成，Shift+回车换行（中英文都可以）"
              }
              rows={2}
              className="resize-none rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 py-1 text-[12px] leading-relaxed text-[var(--color-editor-text)] outline-none placeholder:text-[var(--color-editor-text-dim)] focus:border-[var(--color-editor-accent)] disabled:opacity-50"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[10px] text-[var(--color-editor-text-dim)]">
                <span>尺寸</span>
                <select
                  data-testid="image-gen-size"
                  value={size}
                  disabled={busy}
                  className="rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-1 py-0.5 text-[10px] text-[var(--color-editor-text)] outline-none focus:border-[var(--color-editor-accent)]"
                  onChange={(event) => setSize(event.target.value)}
                >
                  {sizeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option.replace("x", "×")}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="flex items-center gap-1 text-[10px] text-[var(--color-editor-text-dim)]"
                title="出图后抠掉纯色背景，转成带透明通道的 PNG（适合角色 / 道具贴图）"
              >
                <input
                  data-testid="image-gen-remove-bg"
                  type="checkbox"
                  checked={removeBackground}
                  disabled={busy}
                  onChange={(event) => setRemoveBackground(event.target.checked)}
                />
                <span>抠背景</span>
              </label>
              {imageGenConfig === null ? null : (
                <span
                  data-testid="image-gen-platform"
                  className="text-[10px] text-[var(--color-editor-text-dim)]"
                  title={
                    imageGenConfig.configured
                      ? "生图平台已配置"
                      : "还没配密钥：设置环境变量 DTS_IMAGE_API_KEY，或填 resources/config/app.json"
                  }
                >
                  {imageGenConfig.configured ? imageGenConfig.platform : `${imageGenConfig.platform}（未配密钥）`}
                </span>
              )}
              {imageGenConfig === null || !supportsEdit ? null : (
                imageOptions.length === 0 ? null : (
                  <label className="flex items-center gap-1 text-[10px] text-[var(--color-editor-text-dim)]" title="图生图 / 修图：选一张项目里的图当参考（留空 = 文生图）">
                    <span>参考图</span>
                    <select
                      data-testid="image-gen-reference"
                      value={referenceImage}
                      disabled={busy}
                      className="max-w-[150px] rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-1 py-0.5 text-[10px] text-[var(--color-editor-text)] outline-none focus:border-[var(--color-editor-accent)]"
                      onChange={(event) => setReferenceImage(event.target.value)}
                    >
                      <option value="">（无）</option>
                      {imageOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {assetDisplayPath(option.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              )}
              <button
                type="button"
                data-testid="image-gen-send"
                disabled={busy || project === null || prompt.trim().length === 0}
                className="ml-auto rounded border border-[var(--color-editor-accent)] px-3 py-1 text-[11px] text-[var(--color-editor-text)] hover:bg-[var(--color-editor-accent-dim)] disabled:cursor-not-allowed disabled:border-[var(--color-editor-border)] disabled:opacity-40"
                onClick={() => void send()}
              >
                {busy ? "正在画…" : "生成"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
