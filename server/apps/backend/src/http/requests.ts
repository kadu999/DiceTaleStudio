import type { IncomingMessage } from "node:http";
import { HttpError } from "./responses";

/**
 * 请求体 / 查询参数的读取助手。
 *
 * 抽出来只为去掉「同一种读法在十几个处理器里各写一遍」——**语义与拆分前完全一致**，
 * 包括那两条容易被“顺手改掉”的细节：
 * - 空体视为 `{}`（前端 `fetch` 不带 body 的 POST 不会因此报错）；
 * - 非法 JSON 抛的是**普通 Error**（→ 500），不是 400。调用方本来就都会自己校验字段。
 *
 * 唯一的收紧：请求体**必须有上限**（`maxBodyBytes`，来自 app 配置）。整个 body 是先进内存
 * 再解析的，没有上限时一个超大请求就能把进程内存吃光——超限回 **413**。
 */

/** 读完整个请求体（原始字节）；超过 `maxBytes` 抛 413（读取途中就断，不只信 `content-length`）。 */
export function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new HttpError(413, bodyTooLargeMessage(maxBytes)));
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        // **暂停而不是销毁**：`for await` 提前 return 会销毁 socket，413 就送不到客户端了。
        // 这里停下不读，让服务端把 413 写回去，连接随后由 Node 关闭。
        request.pause();
        cleanup();
        reject(new HttpError(413, bodyTooLargeMessage(maxBytes)));
        return;
      }

      chunks.push(chunk);
    };

    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

function bodyTooLargeMessage(maxBytes: number): string {
  return `请求体超过上限（${maxBytes} 字节）`;
}

/** 读并解析 JSON 请求体；空体视为 `{}`。 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const raw = (await readBody(request, maxBytes)).toString("utf8").trim();
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
