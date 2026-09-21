import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";

/**
 * 「全局设置」窗口（v15 起）：**项目级**参数，目前是音频那一节。
 *
 * v16 起它只有**三档音量**（背景音乐 / 音效 / 旁白）——全局参数，前端收到即生效（不需要命令）：
 * - **背景音乐的曲目清单不在这里**：清单就是项目 `Assets/audio/` 下的音频，顶栏「音乐」弹框
 *   点一首就发 `play_bgm{clip}`（「现在放哪一首」是运行动作，不是设置）；
 * - 这一份写进**工程文件**（`project.json`），所以它有未保存状态、能撤销；
 *   **运行态里改不落盘**（改动立刻生效，退出运行会还原到进入运行前的样子）。
 */
export function GlobalSettingsDialog(): React.JSX.Element {
  const open = useEditorStore((state) => state.globalSettings);
  const openGlobalSettings = useEditorStore((state) => state.openGlobalSettings);
  const bgm = useEditorStore((state) => state.doc.settings.audio.bgm);
  const sfx = useEditorStore((state) => state.doc.settings.audio.sfx);
  const voice = useEditorStore((state) => state.doc.settings.audio.voice);

  const setBgmVolume = useEditorStore((state) => state.setBgmVolume);
  const setSfxVolume = useEditorStore((state) => state.setSfxVolume);
  const setVoiceVolume = useEditorStore((state) => state.setVoiceVolume);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => openGlobalSettings(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="global-settings-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[320px] w-[560px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            全局设置：音频音量
          </Dialog.Title>

          <div className="min-h-0 flex-1 overflow-auto" data-testid="global-settings-body">
            <div className="rounded border border-[var(--color-editor-border)]">
              <div className="border-b border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-2 py-1 text-[11px] font-semibold">
                音量
              </div>
              <VolumeRow
                testId="volume-bgm"
                label="背景音乐"
                value={bgm.volume}
                onChange={setBgmVolume}
              />
              <VolumeRow testId="volume-sfx" label="音效" value={sfx.volume} onChange={setSfxVolume} />
              <VolumeRow
                testId="volume-voice"
                label="旁白"
                value={voice.volume}
                onChange={setVoiceVolume}
              />
            </div>
          </div>

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>
              这些是项目级设置（写进工程文件）；<span className="text-[var(--color-editor-text)]">背景音乐放哪一首</span>
              在顶栏「音乐」弹框里点。运行态里改会立刻生效，但退出运行会还原。
            </span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="global-settings-close"
                className="toolbar-button hover:toolbar-button-hover"
              >
                关闭
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 一路音量：滑杆 + 百分比（0..1，前端按这个数用它）。 */
function VolumeRow({
  testId,
  label,
  value,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className="w-20 flex-none text-[11px] text-[var(--color-editor-text-dim)]">{label}</span>
      <input
        type="range"
        data-testid={testId}
        aria-label={`${label}音量`}
        min={0}
        max={1}
        step={0.05}
        value={value}
        title={`${label}音量（0..1）`}
        className="min-w-0 flex-1"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 flex-none text-right font-mono text-[10px] text-[var(--color-editor-text-dim)]">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}
