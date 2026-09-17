import type { GameStateSnapshot, ObjectStateSnapshot, PlayerStateSnapshot } from "@dts/protocol";

/**
 * 运行态状态（内存态，与 DiceTale 既有语义一致：客户端断开即清空，不做持久化）。
 *
 * 注意：这里是**运行态镜像**，与编辑器文档完全隔离——运行态的变更绝不写回文档。
 */

export interface RunStateSnapshot {
  readonly state: GameStateSnapshot;
  readonly clientConnected: boolean;
}

export function createEmptyGameState(): GameStateSnapshot {
  return { currentMap: "", players: {}, spawnPoints: {}, objects: {} };
}

export class RunState {
  private gameState: GameStateSnapshot = createEmptyGameState();
  private clientConnected = false;

  get snapshot(): RunStateSnapshot {
    return { state: this.gameState, clientConnected: this.clientConnected };
  }

  get isClientConnected(): boolean {
    return this.clientConnected;
  }

  get currentMap(): string {
    return this.gameState.currentMap;
  }

  setClientConnected(connected: boolean): void {
    this.clientConnected = connected;
    if (!connected) {
      // 单客户端架构：断开即清空
      this.reset();
    }
  }

  reset(): void {
    this.gameState = createEmptyGameState();
  }

  setMap(mapName: string): void {
    this.gameState.currentMap = mapName;
  }

  /** 注册地图对象：合并语义（重新加载地图不会丢掉已有对象的动作清单）。 */
  registerObjects(
    mapName: string,
    objects: ReadonlyArray<{
      id: string;
      name?: string;
      kind?: string;
      position?: { x: number; y: number } | null;
      componentData?: Array<{ component: string; displayName?: string; data: string }>;
    }>,
  ): void {
    this.gameState.currentMap = mapName;

    for (const object of objects) {
      const existing = this.gameState.objects[object.id];
      const next: ObjectStateSnapshot = {
        name: object.name ?? existing?.name ?? object.id,
        kind: object.kind ?? existing?.kind ?? "SceneObject",
        mapName,
        position: object.position ?? existing?.position ?? null,
        ...(object.componentData === undefined
          ? existing?.componentData === undefined
            ? {}
            : { componentData: existing.componentData }
          : { componentData: object.componentData }),
        ...(existing?.actions === undefined ? {} : { actions: existing.actions }),
      };

      this.gameState.objects[object.id] = next;
    }
  }

  /** 注册某对象上的可触发动作清单（`register_actions`）。 */
  registerActions(
    objectId: string,
    actions: ReadonlyArray<{
      actionId: string;
      type: string;
      displayName?: string;
      paramSummary?: string;
      conditionSummary?: string;
    }>,
  ): boolean {
    const object = this.gameState.objects[objectId];
    if (object === undefined) {
      return false;
    }

    object.actions = [...actions];
    return true;
  }

  registerPlayers(players: ReadonlyArray<{ id: string; name: string }>, mapName: string): void {
    for (const player of players) {
      this.gameState.players[player.id] = {
        name: player.name,
        position: this.gameState.players[player.id]?.position ?? { x: 0.5, y: 0.5 },
        mapName,
      };
    }
  }

  registerSpawnPoints(
    mapName: string,
    spawnPoints: ReadonlyArray<{ id: string }>,
  ): void {
    this.gameState.spawnPoints[mapName] = spawnPoints.map((spawn) => ({ id: spawn.id }));
  }

  setPlayerPosition(playerId: string, position: { x: number; y: number }, mapName: string): void {
    const existing = this.gameState.players[playerId];
    const next: PlayerStateSnapshot = {
      name: existing?.name ?? playerId,
      position,
      mapName,
    };
    this.gameState.players[playerId] = next;
  }

  setObjectPosition(objectId: string, position: { x: number; y: number }, mapName: string): void {
    const existing = this.gameState.objects[objectId];
    if (existing === undefined) {
      this.gameState.objects[objectId] = {
        name: objectId,
        kind: "SceneObject",
        mapName,
        position,
      };
      return;
    }

    existing.position = position;
    existing.mapName = mapName;
  }

  /** 查找某对象上是否存在指定动作（触发前的存在性检查）。 */
  findAction(objectId: string, actionId: string): boolean {
    const actions = this.gameState.objects[objectId]?.actions;
    return actions?.some((action) => action.actionId === actionId) ?? false;
  }

  /** 全部已知动作（编辑器用；可直接触发而无需前端上报清单时）。 */
  listActions(): Array<{ objectId: string; actionId: string; type: string; displayName?: string }> {
    const result: Array<{ objectId: string; actionId: string; type: string; displayName?: string }> = [];
    for (const [objectId, object] of Object.entries(this.gameState.objects)) {
      for (const action of object.actions ?? []) {
        result.push({
          objectId,
          actionId: action.actionId,
          type: action.type,
          ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
        });
      }
    }

    return result;
  }
}
