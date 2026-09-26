import type { EditorMode } from "../state/editor-store";
import type { RuntimeStatus } from "./runtime-client";

/**
 * 点下去会发生什么：没连上时**照样记账**，只是要等连上才补发——把这件事写在按钮的 tooltip 上。
 *
 * 背景音乐 / 声音 / 视频三处说的是同一件事、措辞必须一致，所以实现只有这一份；
 * 各自的 `*DeliveryHint` 保留成同名薄壳（调用方与测试都按那个名字取）。
 * 返回 `undefined` 表示「现在就能发下去」。
 */
export function deliveryHint(input: {
  readonly mode: EditorMode;
  readonly status: RuntimeStatus;
  readonly clientConnected: boolean;
}): string | undefined {
  if (input.mode !== "run" || input.status !== "open") {
    return "已记录：编辑器还没连上服务端，连上后自动补发";
  }

  if (!input.clientConnected) {
    return "已记录：前端（Unity）未连接，等它连上后自动补发";
  }

  return undefined;
}
