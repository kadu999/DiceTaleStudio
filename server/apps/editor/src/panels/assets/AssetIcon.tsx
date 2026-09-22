import type { AssetIconKind } from "../asset-info";

/**
 * 资源面板的图标：**内联 SVG**，不依赖 emoji 字形。
 *
 * 为什么不用 emoji：同一枚 📁 在 Windows / macOS / Android 上形状与粗细差很多，
 * 而且大小跟着字体走——「三角太小」「图标糊成一团」正是这么来的。SVG 用 `currentColor`
 * 描边 + 明确尺寸，深色主题下三种设备看起来才一致。
 *
 * 图标一律 `aria-hidden`：它只是行的装饰，行的可读文本与测试断言都不该因此变化。
 *
 * 每枚图标另带一个 `data-icon`（`chevron` / `folder` / 文件类型名）：一行里可能同时有
 * **展开三角与类型图标**两枚 SVG（目录树的行就是这样），e2e 要能分别断言它们各自在不在
 * ——按 `svg` 数量断言会在下次加图标时变成假红。
 */

/** 图标尺寸（= 1rem 的 3/4；行高 12px 文字下的视觉平衡点）。 */
const ICON_CLASS = "h-3.5 w-3.5 flex-none";

/** 文件夹图标的颜色（对齐 Unity Project 窗口里那种暖色调）。 */
const FOLDER_COLOR = "text-[var(--color-editor-warn)]";

const FILE_COLORS: Record<AssetIconKind, string> = {
  image: "text-[var(--color-editor-ok)]",
  video: "text-[var(--color-editor-accent)]",
  audio: "text-[var(--color-editor-accent)]",
  scene: "text-[var(--color-editor-warn)]",
  text: "text-[var(--color-editor-text-dim)]",
  file: "text-[var(--color-editor-text-dim)]",
};

/**
 * 展开 / 收起的小三角。
 *
 * 用 SVG **chevron**（`>`）而不是 `▸/▾` 字形：字形只有 10px 上下、还带自己的行距，
 * 鼠标 / 手指都很难点中。这里固定 14px、`stroke-width: 2`，展开时整体转 90°。
 */
export function AssetChevron({ expanded }: { readonly expanded: boolean }): React.JSX.Element {
  return (
    <svg
      data-icon="chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`h-3.5 w-3.5 flex-none transition-transform duration-100 ${
        expanded ? "rotate-90" : ""
      }`}
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** 文件夹：未展开是闭合的，展开后右上角掀开。 */
export function FolderIcon({ open }: { readonly open: boolean }): React.JSX.Element {
  return (
    <svg
      data-icon="folder"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${ICON_CLASS} ${FOLDER_COLOR}`}
    >
      {open ? (
        <>
          <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v1" />
          <path d="M3 9h16.6a1.5 1.5 0 0 1 1.45 1.9l-1.6 6A2 2 0 0 1 17.5 18H5a2 2 0 0 1-2-2z" />
        </>
      ) : (
        <path d="M3 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8L11 7h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      )}
    </svg>
  );
}

/**
 * 文件图标：按类型给不同轮廓。
 *
 * 一张纸的底（折角）是共用的，只在纸上加各自的记号——所以六种图标看上去是**一套**，
 * 而不是六个来源不同的符号拼在一起。
 */
export function AssetFileIcon({ kind }: { readonly kind: AssetIconKind }): React.JSX.Element {
  return (
    <svg
      data-icon={kind}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${ICON_CLASS} ${FILE_COLORS[kind]}`}
    >
      {/* 纸：折角那一眼让所有文件图标长成一家 */}
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
      {kind === "image" ? (
        <>
          <circle cx="9.5" cy="12.5" r="1.2" />
          <path d="M6.6 18.6l3.6-3.2 2.6 2.2 1.6-1.3 2.4 2.3" />
        </>
      ) : null}
      {kind === "video" ? <path d="M10 11.5l4.5 3-4.5 3z" /> : null}
      {kind === "audio" ? (
        <>
          <path d="M9.5 17.5V10l5-1v7.5" />
          <circle cx="8.4" cy="17.6" r="1.2" />
          <circle cx="13.4" cy="16.6" r="1.2" />
        </>
      ) : null}
      {kind === "scene" ? (
        <>
          <path d="M9 11h6M9 14h6M9 17h3.5" />
        </>
      ) : null}
      {kind === "text" ? <path d="M9 11h6M9 14h6M9 17h4" /> : null}
    </svg>
  );
}

/** 子精灵图标：与父图片的山景图标区分，表示它是图集里的一个裁剪格。 */
export function SpriteIcon(): React.JSX.Element {
  return (
    <svg
      data-icon="sprite"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-3.5 w-3.5 flex-none text-[var(--color-editor-accent)]"
    >
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 12h16M12 4v16" />
      <path d="M8 8h.01M16 16h.01" strokeWidth={2.6} />
    </svg>
  );
}
