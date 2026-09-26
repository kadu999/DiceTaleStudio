import { useEffect, useState } from "react";
import { assetImageInfoUrl } from "../panels/asset-picker";

/**
 * 探测一份**素材的像素尺寸**（后端 `?info=1`：图片读它的真实宽高，视频用 ffmpeg 抽首帧读宽高）。
 *
 * 两处要用它，都是「编辑器不解码、但要按真实尺寸算点什么」：
 * - 视频混合的 Mask 窗口：遮罩的长宽比要按它来（笔刷在屏幕上才不变形）；
 * - 放大镜那扇窗：中间那张图（可能是图集里的一格）要按**真实**尺寸等比装进可视区——
 *   引用里声明的宽高只决定「画多大」，与磁盘上的真实像素不一致时不能拿它当长宽比。
 *
 * 探不到（网络失败 / 后端不认这类素材）就返回 `undefined`，调用方自己落一个兜底长宽比——
 * **不阻塞窗口**。
 */
export function useAssetSize(
  id: string | undefined,
): { readonly width: number; readonly height: number } | undefined {
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);

  useEffect(() => {
    if (id === undefined) {
      setSize(undefined);
      return;
    }

    let alive = true;
    fetch(assetImageInfoUrl(id))
      .then((response) => (response.ok ? response.json() : undefined))
      .then((info: { width?: unknown; height?: unknown } | undefined) => {
        if (
          alive &&
          info !== undefined &&
          typeof info.width === "number" &&
          typeof info.height === "number"
        ) {
          setSize({ width: info.width, height: info.height });
        }
      })
      .catch(() => {
        // 探不到就按调用方的兜底（形状对得上就够用）
      });

    return () => {
      alive = false;
    };
  }, [id]);

  return size;
}
