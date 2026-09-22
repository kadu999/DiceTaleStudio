import { PROTOCOL_MISMATCH_CODE, PROTOCOL_VERSION } from "@dts/protocol";
import { projectNameOfScene } from "../runtime-session";
import { defineEditorHandlers } from "./types";

/**
 * 编辑器 → 服务端：**一条消息一个函数**。
 *
 * 这里只做「状态怎么变 + 该发给谁」；传输（升级、心跳、连接表、命令等待表）全在 `RuntimeHub`。
 */
export const EDITOR_HANDLERS = defineEditorHandlers({
  /** `editor_hello`：版本握手；一致就回一份当前运行态。 */
  editor_hello(ctx, ws, message) {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      const reason = `协议版本不一致：编辑器 ${message.protocolVersion}，服务端 ${PROTOCOL_VERSION}`;
      ctx.log("warn", reason);
      ws.close(PROTOCOL_MISMATCH_CODE, reason);
      return;
    }

    ctx.sendEditorState(ws);
  },

  /**
   * `runtime_start`：点「运行」→ **开闸**（此后 `/client` 才连得上）。
   *
   * **幂等**：重复点不会重置场景缓存——服务端只记「现在在运行」。
   */
  runtime_start(ctx, _ws, _message) {
    if (!ctx.session.runtimeActive) {
      ctx.session.start();
      ctx.resetInactiveRejectionLog();
      ctx.log("info", "进入运行态：已开闸（前端现在可以连接）");
    }

    ctx.broadcastEditorState();
  },

  /** `runtime_stop`：点「编辑」→ 关闸、踢前端、清场景与设置缓存。 */
  runtime_stop(ctx, _ws, _message) {
    if (ctx.session.runtimeActive) {
      ctx.session.stop();
      ctx.kickClient("编辑器已退出运行态");
      ctx.log("info", "退出运行态：已关闸（前端会被断开，且连不回来直到再次点运行）");
      ctx.logToEditors("warn", "已退出运行态：前端连接已关闭");
    }

    ctx.broadcastEditorState();
  },

  /** `editor_refresh`：要一份当前运行态（订阅也走它）。 */
  editor_refresh(ctx, ws, _message) {
    ctx.sendEditorState(ws);
  },

  /**
   * `scene_push`：推当前场景（**整份**，不做增量）。
   *
   * 推送很频繁（编辑器去抖后每次编辑一份），所以只更新状态、不写日志。
   * 项目换了（或编辑器第一次推场景）时**先**让前端换资源包，**再**给场景——
   * 否则就成了「场景先到、资源后下」。
   */
  scene_push(ctx, _ws, message) {
    const projectChanged = projectNameOfScene(message.scene) !== ctx.session.resourceProject;
    ctx.session.setScene(message.scene);

    const clientWs = ctx.clientSocket;
    if (clientWs !== undefined) {
      if (projectChanged) {
        ctx.prepareClientResources(clientWs);
      }

      ctx.sendTo(clientWs, { type: "scene_sync", scene: message.scene });
    }

    ctx.broadcastEditorState();
  },

  /**
   * `settings_push`：推项目级全局设置（与场景同命：缓存一份、前端一连上就补发）。
   *
   * 它与场景分开一条消息是因为**跨场景有效**——换场景不该把音量弄丢。
   * 音量是滑杆拖出来的，推送同样频繁：只更新状态、不写日志。
   */
  settings_push(ctx, _ws, message) {
    ctx.session.setSettings(message.settings);

    const clientWs = ctx.clientSocket;
    if (clientWs !== undefined) {
      ctx.sendTo(clientWs, { type: "project_settings", settings: message.settings });
    }

    ctx.broadcastEditorState();
  },

  /**
   * `editor_command`：把一条命令下发给前端。
   *
   * 三道校验都**明确报错**（都挂 `requestId`，编辑器那边才收得掉那条 pending）：
   * 没进运行态、前端没连、转发失败。通过之后记一笔等待回执（超时也报错）。
   */
  editor_command(ctx, ws, message) {
    if (!ctx.session.runtimeActive) {
      ctx.sendTo(ws, {
        type: "editor_error",
        requestId: message.requestId,
        reason: "未进入运行态，无法下发命令",
      });
      return;
    }

    if (!ctx.clientConnected) {
      ctx.sendTo(ws, {
        type: "editor_error",
        requestId: message.requestId,
        reason: "前端未连接，无法下发命令",
      });
      return;
    }

    const forwarded = ctx.forwardToClient({
      type: "command",
      requestId: message.requestId,
      command: message.command,
    });

    if (!forwarded) {
      ctx.sendTo(ws, {
        type: "editor_error",
        requestId: message.requestId,
        reason: "下发失败：前端连接不可用",
      });
      return;
    }

    ctx.trackCommand(message.requestId, ws, message.command.kind);
  },
});
