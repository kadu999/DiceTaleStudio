import { createRequestId, type ScenePayload } from "@dts/protocol";

/**
 * 运行态会话（内存态，**不持久化**）。
 *
 * 运行态由**编辑器**驱动：编辑器点「运行」= `runtime_start`（开闸），点「编辑」或它的 WS 断开 = 关闸。
 * 没开闸时服务端**拒绝** `/client` 的 WebSocket 升级——前端连不上，也就谈不上被控制。
 *
 * 这里只记三件事：
 * - 开没开闸（`runtimeActive`）；
 * - 前端是谁（`client`，`client_hello` 后填上名字与版本）；
 * - **最近一份场景**（`scene`，编辑器 `scene_push` 推来的整份文档）。
 *   它同时是「后连上的前端也能立刻拿到全量」的依据：前端一连上就补发这份。
 *
 * 旧模型里那个「对象 / 玩家 / 动作清单」镜像已经删掉：新方向下数据在后台，
 * 前端不再上报任何东西，服务端也就没有可镜像的对象。
 */

export interface RuntimeClientInfo {
  readonly name: string;
  readonly version: string;
  readonly connectedAt: number;
  readonly address: string;
}

export interface RuntimeSceneInfo {
  readonly name: string;
  readonly objectCount: number;
  readonly updatedAt: number;
}

export interface RuntimeSnapshot {
  readonly runtimeActive: boolean;
  readonly client: RuntimeClientInfo | null;
  readonly scene: RuntimeSceneInfo | null;
}

export class RuntimeSession {
  /** 本次运行态的会话 id（前端 `server_hello` 里看到它，日志排查用）。 */
  readonly sessionId = createRequestId("sess");

  private active = false;
  private clientInfo: RuntimeClientInfo | null = null;
  private sceneDoc: ScenePayload | null = null;
  private sceneUpdatedAt = 0;

  get runtimeActive(): boolean {
    return this.active;
  }

  get client(): RuntimeClientInfo | null {
    return this.clientInfo;
  }

  /** 最近一份场景（没有 = null）。 */
  get scene(): ScenePayload | null {
    return this.sceneDoc;
  }

  get snapshot(): RuntimeSnapshot {
    return {
      runtimeActive: this.active,
      client: this.clientInfo,
      scene:
        this.sceneDoc === null
          ? null
          : {
              name: this.sceneDoc.name,
              objectCount: this.sceneDoc.objects.length,
              updatedAt: this.sceneUpdatedAt,
            },
    };
  }

  /** 开闸（编辑器点「运行」）。幂等：重复调用不会清掉已推的场景。 */
  start(): void {
    this.active = true;
  }

  /** 关闸（退出运行态）：清场景缓存与前端信息，旧运行态不留痕。 */
  stop(): void {
    this.active = false;
    this.sceneDoc = null;
    this.sceneUpdatedAt = 0;
    this.clientInfo = null;
  }

  setClient(info: RuntimeClientInfo | null): void {
    this.clientInfo = info;
  }

  /** 推一份场景（`null` = 编辑器没有打开的场景，前端据此清空镜像）。 */
  setScene(scene: ScenePayload | null): void {
    this.sceneDoc = scene;
    this.sceneUpdatedAt = Date.now();
  }
}
