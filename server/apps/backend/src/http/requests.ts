import type { IncomingMessage } from "node:http";

/**
 * 请求体 / 查询参数的读取助手。
 *
 * 抽出来只为去掉「同一种读法在十几个处理器里各写一遍」——**语义与拆分前完全一致**，
 * 包括那两条容易被“顺手改掉”的细节：
 * - 空体视为 `{}`（前端 `fetch` 不带 body 的 POST 不会因此报错）；
 * - 非法 JSON 抛的是**普通 Error**（→ 500），不是 400。调用方本来就都会自己校验字段。
 */

/** 读完整个请求体（原始字节）。 */
export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/** 读并解析 JSON 请求体；空体视为 `{}`。 */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(request)).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

/** 查询参数，缺失时给空串（`?name=` 与没有 `name` 在这里不做区分，由调用方判空）。 */
export function queryRaw(url: URL, key: string): string {
  return url.searchParams.get(key) ?? "";
}

/** 查询参数，顺手去掉首尾空白（项目名 / 路径这类参数适用）。 */
export function queryTrimmed(url: URL, key: string): string {
  return queryRaw(url, key).trim();
}

/** 请求体里的字符串字段；不是字符串一律给空串（不猜、不当字符串强转）。 */
export function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

/** 请求体里的字符串字段，顺手去掉首尾空白。 */
export function bodyTrimmed(body: Record<string, unknown>, key: string): string {
  return bodyString(body, key).trim();
}
