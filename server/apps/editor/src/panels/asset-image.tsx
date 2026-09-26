import { spriteSheetOfMeta, type ImageRef } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetRawUrl, assetThumbnailUrl, spriteCellBackgroundPosition } from "./asset-picker";

/**
 * 把一份**图片引用**（`ImageRef`）画出来：整张图，或者它图集里的**一格**。
 *
 * 为什么用 CSS 背景而不是 `<img>`：「取一格」是「整张图按几行几列放大、再挪到那一格」——
 * 与素材面板里的精灵预览（`InspectorPanel`）同一套算式，`<img>` 做不到裁剪。
 * 长宽比取引用里**声明的宽高**（挑图那一刻写进去的正是整张 / 那一格的尺寸），
 * 所以不用先加载图片量像素；背景百分比是相对盒子算的，换成缩略图也一样对得上。
 *
 * 尺寸由消费者给（`className` / `style`）：小方块给一个固定小框，舞台给 `fitBox` 算出来的那块。
 */
export function AssetImage({
  image,
  className,
  testId,
  source = "thumbnail",
}: {
  readonly image: ImageRef;
  readonly className?: string;
  readonly testId?: string;
  /** `raw` = 原图（放大镜那扇窗的中间）；`thumbnail` = 后端缩略图（列表里的小图）。 */
  readonly source?: "raw" | "thumbnail";
}): React.JSX.Element {
  // 切分住在素材自己的 `.meta` 里（「几行几列」只有那一份），按图 id 查当前这一份
  const metaTable = useEditorStore((state) => state.assetMetaTable);
  const sheet = spriteSheetOfMeta(metaTable[image.id]);
  const sprite = image.sprite;
  const url = source === "raw" ? assetRawUrl(image.id) : assetThumbnailUrl(image.id);

  return (
    <span
      data-testid={testId}
      className={`block bg-no-repeat ${className ?? ""}`}
      style={{
        aspectRatio: `${Math.max(1, image.width)} / ${Math.max(1, image.height)}`,
        backgroundImage: `url(${url})`,
        backgroundSize:
          sprite === undefined ? "contain" : `${sheet.columns * 100}% ${sheet.rows * 100}%`,
        backgroundPosition:
          sprite === undefined
            ? "center"
            : spriteCellBackgroundPosition(
                sprite.row * sheet.columns + sprite.column,
                sheet.columns,
                sheet.rows,
              ),
      }}
    />
  );
}
