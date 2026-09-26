/**
 * 后端各处共用的小工具（彼此独立，也不依赖本应用的其它模块）。
 *
 * 抽出来的理由都一样：同一种写法在好几个文件里各写一遍，口径迟早不一致
 * （`instanceof Error` 漏掉非 Error 值、时间戳格式各写各的、Buffer 切片抄来抄去）。
 */

/** `unknown` 异常 → 可读字符串（`Error` 取 `message`，其余 `String()`）。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 日志时间戳：`HH:MM:SS`（固定形状，只给日志看）。 */
export function stamp(date: Date = new Date()): string {
  return date.toISOString().slice(11, 19);
}

/**
 * `Buffer` → 独立的 `ArrayBuffer`。
 *
 * `Buffer` 常常是一块共享缓冲上的视图，直接交出去会把后面的字节也带上，所以按
 * `byteOffset` / `byteLength` 切一份独立的。
 */
export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
