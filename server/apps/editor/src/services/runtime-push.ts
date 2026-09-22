import { emptyAssetMetas, resolveSceneSprites, type AssetMetas, type ProjectSettingsDoc, type SceneDoc } from "@dts/document";

/**
 * 运行态「把当前场景推给服务端」的判定与去抖。
 *
 * 抽成不依赖 React / 网络的纯逻辑，是为了能直接单测这几条规则：
 * - **只在运行态推**（编辑态不推：前端本来就还没连）；
 * - **只在服务端连接开着时推**（没连上推了也是丢，等重连时补一次全量）；
 * - **内容没变不推**（撤销回到原样、画布重绘、切页签都不该产生流量）；
 * - **去抖**：连续拖动 / 连续输入只推最后一次。
 */

export const RUNTIME_PUSH_DEBOUNCE_MS = 200;

/** 推送判定用的输入：都在 store 里现成算得出来（不需要额外状态）。 */
export interface ScenePushDecision {
  readonly mode: "edit" | "run";
  /** 编辑器与服务端的 WS 是否 open。 */
  readonly connected: boolean;
  /** 上次成功推出去的场景文本；null = 本次运行态还没推过。 */
  readonly lastPushed: string | null;
  /** 这次要推的场景文本；null = 没有打开的场景（推空）。 */
  readonly next: string | null;
}

/** 该不该推？（去抖之外的纯判定，单测直接打这张表。） */
export function shouldPushScene(decision: ScenePushDecision): boolean {
  if (decision.mode !== "run" || !decision.connected) {
    return false;
  }

  return decision.lastPushed !== decision.next;
}

/**
 * 场景 → 比对 / 传输用的文本。
 *
 * 用 `JSON.stringify` 而不是 `serializeSceneFile`：后者是**文件格式**（只有对象、不带场景名），
 * 而运行态要的是「场景名 + 对象」，切场景也得算一次变更。
 *
 * `metas`（素材 meta 的索引）是**必须传进来的**：子图引用上只写着「第几格」，
 * 「几行几列」要解析进载荷里（前端手上没有 `.meta`）——见 `resolveSceneSprites`。
 * 于是**改切分也会改变这份文本**，运行态据此把新的一款推下去（这是有意的：口径就是
 * 「改切分，所有引用它的对象一起变」）。
 */
export function scenePayloadText(scene: SceneDoc | null, metas: AssetMetas = emptyAssetMetas()): string | null {
  if (scene === null) {
    return null;
  }

  return JSON.stringify(resolveSceneSprites(scene, metas));
}

/**
 * 推送用的场景载荷（与 `scenePayloadText` 是同一份东西的对象形式）。
 *
 * 单独一支是因为推送要的是**对象**（直接交给 WebSocket），而比对要的是文本；
 * 两者都走 `resolveSceneSprites`，所以「发出去的」与「比过的」不可能是两份不同的数据。
 */
export function scenePayloadOf(scene: SceneDoc | null, metas: AssetMetas = emptyAssetMetas()): SceneDoc | null {
  return scene === null ? null : resolveSceneSprites(scene, metas);
}

/**
 * 项目级全局设置 → 比对 / 传输用的文本。
 *
 * 与场景那一份同一个用处：内容没变就不重推（音量滑杆拖回来、撤销回原样都不该产生流量）。
 * 没有打开项目时是 `null`——推上去等于告诉前端「清掉你手上的设置」。
 */
export function projectSettingsPayloadText(settings: ProjectSettingsDoc | null): string | null {
  return settings === null ? null : JSON.stringify(settings);
}

/** 去抖调度器：`schedule` 反复调用，只有停下来 `delayMs` 之后才真的推一次。 */
export class ScenePushScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingText: string | null = null;

  constructor(
    private readonly options: {
      readonly delayMs?: number;
      readonly push: (text: string | null) => void;
    },
  ) {}

  /** 安排一次推送（覆盖上一次还没发出去的）。 */
  schedule(text: string | null): void {
    this.pendingText = text;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pendingText;
      this.pendingText = null;
      this.options.push(pending);
    }, this.options.delayMs ?? RUNTIME_PUSH_DEBOUNCE_MS);
  }

  /** 立刻推（进运行态、重连补发这种「必须马上到」的场合）。 */
  flush(text: string | null): void {
    this.cancel();
    this.options.push(text);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.pendingText = null;
  }
}
