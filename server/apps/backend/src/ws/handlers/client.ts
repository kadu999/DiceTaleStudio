import { PROTOCOL_MISMATCH_CODE, PROTOCOL_VERSION } from "@dts/protocol";
import type { RuntimeClientInfo } from "../runtime-session";
import { defineClientHandlers } from "./types";

/**
 * 前端（Unity）→ 服务端：**一条消息一个函数**。
 *
 * 前端只回四件事（`client_hello` / `command_result` / `pong` / `resources_ready`）——
 * 它**不上报任何游戏数据**，数据方向是单向的（后台 → 前端）。
 */
export const CLIENT_HANDLERS = defineClientHandlers({
  /** `client_hello`：版本握手 + 补上「前端是谁」。版本不符直接以 `4002` 断开。 */
  client_hello(ctx, ws, message) {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      const reason = `协议版本不一致：前端 ${message.protocolVersion}，服务端 ${PROTOCOL_VERSION}`;
      ctx.log("warn", reason);
      ctx.logToEditors("error", reason);
      ws.close(PROTOCOL_MISMATCH_CODE, reason);
      return;
    }

    const info: RuntimeClientInfo = {
      name: message.name,
      version: message.version,
      // 连接时刻在 accept 时就记下了（这里保留它，而不是用「标识时刻」）
      connectedAt: ctx.session.client?.connectedAt ?? Date.now(),
      address: ctx.clientAddress,
    };

    ctx.session.setClient(info);
    ctx.log("info", `前端已标识：${message.name} v${message.version}`);
    ctx.broadcastEditorState();
    ctx.logToEditors("info", `前端已标识：${message.name} v${message.version}`);
  },

  /**
   * `command_result`：命令回执（**必须回**，不回就只有 15s 超时那条路）。
   *
   * 清掉等待记录 + 把结果广播给所有编辑器 + 两边各记一条日志。
   */
  command_result(ctx, _ws, message) {
    ctx.settleCommand(message.requestId);

    ctx.log(
      message.ok ? "info" : "warn",
      `命令回执 ${message.requestId}: ${message.ok ? "成功" : `失败(${message.reason ?? "未知"})`}`,
    );
    ctx.broadcastToEditors({
      type: "editor_command_result",
      requestId: message.requestId,
      ok: message.ok,
      ...(message.reason === undefined ? {} : { reason: message.reason }),
      ...(message.effects === undefined ? {} : { effects: message.effects }),
    });
    ctx.logToEditors(
      message.ok ? "info" : "warn",
      `命令 ${message.ok ? "执行成功" : `执行失败：${message.reason ?? "未知原因"}`}`,
    );
  },

  /** `pong`：心跳应答（连续丢失计数清零）。 */
  pong(ctx, _ws, _message) {
    ctx.resetMissedPongs();
  },

  /**
   * `resources_ready`：前端本地资源包的结果（成功失败都报）。
   *
   * 它**不参与任何寻址**，只是让编辑器运行面板能显示「素材下到哪了」。
   */
  resources_ready(ctx, _ws, message) {
    ctx.session.setResources({
      project: message.project,
      fingerprint: message.fingerprint,
      fileCount: message.fileCount,
      bytes: message.bytes,
      ok: message.ok,
      at: Date.now(),
      ...(message.reason === undefined ? {} : { reason: message.reason }),
    });

    ctx.log(
      message.ok ? "info" : "warn",
      `前端资源包「${message.project}」${message.ok ? "就绪" : "失败"}` +
        `（${message.fileCount} 个文件 / ${message.bytes} 字节 / ${message.fingerprint}）` +
        `${message.reason === undefined ? "" : `：${message.reason}`}`,
    );
    ctx.broadcastEditorState();
    ctx.logToEditors(
      message.ok ? "info" : "warn",
      `前端资源包${message.ok ? "已就绪" : "失败"}：「${message.project}」${message.fileCount} 个文件` +
        `${message.reason === undefined ? "" : `（${message.reason}）`}`,
    );
  },
});
