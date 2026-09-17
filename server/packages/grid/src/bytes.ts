import type { GridSize } from "./coords";
import { isValidMask } from "./mask";

/**
 * 网格数据：尺寸 + 每格掩码（`Uint8Array`，行主序 `y * width + x`，`y = 0` 为图片最下面一行）。
 */
export interface GridData {
  readonly size: GridSize;
  /** 长度 = width * height，值为格子掩码（0..255）。 */
  readonly cells: Uint8Array;
}

/** `.bytes` 头长度：int32 width + int32 height。 */
export const BYTES_HEADER_SIZE = 8;
/** `.bytes` 每格字节数：int32 mask。 */
export const BYTES_CELL_SIZE = 4;

/** 给定网格尺寸对应的 `.bytes` 字节长度。 */
export function gridBytesLength(size: GridSize): number {
  return BYTES_HEADER_SIZE + size.width * size.height * BYTES_CELL_SIZE;
}

/** 创建全空的网格数据。 */
export function createGridData(size: GridSize): GridData {
  return { size, cells: new Uint8Array(size.width * size.height) };
}

/**
 * 编码为 DiceTale `.bytes`：小端 `int32 width`、`int32 height`，随后 `width*height` 个小端 `int32 mask`。
 * 与 Unity `GridMap.SaveData` / `GridMapEditorState.SaveData` 的输出格式一致。
 */
export function encodeGridBytes(data: GridData): ArrayBuffer {
  const { size, cells } = data;
  const count = size.width * size.height;
  if (cells.length !== count) {
    throw new Error(`cells 长度 ${cells.length} 与网格尺寸 ${size.width}x${size.height} 不匹配`);
  }

  const buffer = new ArrayBuffer(gridBytesLength(size));
  const view = new DataView(buffer);
  view.setInt32(0, size.width, true);
  view.setInt32(4, size.height, true);
  for (let i = 0; i < count; i += 1) {
    view.setInt32(BYTES_HEADER_SIZE + i * BYTES_CELL_SIZE, cells[i] ?? 0, true);
  }

  return buffer;
}

/**
 * 解码 DiceTale `.bytes`。非法尺寸或长度不足时抛错（不静默截断，避免损坏数据被悄悄接受）。
 */
export function decodeGridBytes(buffer: ArrayBuffer): GridData {
  if (buffer.byteLength < BYTES_HEADER_SIZE) {
    throw new Error(`.bytes 长度 ${buffer.byteLength} 小于头部 ${BYTES_HEADER_SIZE} 字节`);
  }

  const view = new DataView(buffer);
  const width = view.getInt32(0, true);
  const height = view.getInt32(4, true);
  if (width <= 0 || height <= 0) {
    throw new Error(`.bytes 网格尺寸非法: ${width}x${height}`);
  }

  const count = width * height;
  const expected = gridBytesLength({ width, height });
  if (buffer.byteLength < expected) {
    throw new Error(`.bytes 长度 ${buffer.byteLength} 小于期望 ${expected}（${width}x${height}）`);
  }

  const cells = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const mask = view.getInt32(BYTES_HEADER_SIZE + i * BYTES_CELL_SIZE, true);
    if (!isValidMask(mask)) {
      throw new Error(`第 ${i} 格掩码越界: ${mask}`);
    }

    cells[i] = mask;
  }

  return { size: { width, height }, cells };
}

/** 编码为 base64（便于放进 JSON 或经 HTTP 传输）。 */
export function encodeGridBytesToBase64(data: GridData): string {
  const bytes = new Uint8Array(encodeGridBytes(data));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/** 从 base64 解码。 */
export function decodeGridBytesFromBase64(base64: string): GridData {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return decodeGridBytes(bytes.buffer);
}
