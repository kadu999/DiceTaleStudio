import {
  createMapObject,
  createGameObject,
  createFogObject,
  createSoundObject,
  createTeleportObject,
  type ObjectKind,
  type GameObjectDoc,
  type WorldPosition,
} from "@dts/document";
import { gridSizeFromImage } from "@dts/grid";
import { projectSceneImageId } from "@dts/resources";
import { DEFAULT_MAP_IMAGE } from "./store-core";

interface GameObjectFactoryInput {
  readonly project: string;
  readonly sceneName: string;
  readonly name: string;
  readonly position: WorldPosition;
  /** 战争雾（`Fog`）需要：引用哪张地图（由 `createObject` 现算）。 */
  readonly mapId?: string;
}

type GameObjectFactory = (input: GameObjectFactoryInput) => GameObjectDoc;

/** 每种文档对象在编辑器中新建时的组装规则；添加 ObjectKind 时必须明确登记工厂。 */
const GAME_OBJECT_FACTORIES: Record<ObjectKind, GameObjectFactory> = {
  GameObject: ({ name, position }) => createGameObject({ name, kind: "GameObject", position }),
  Sprite: ({ name, position }) => createGameObject({ name, kind: "Sprite", position }),
  Image: ({ name, position }) => createGameObject({ name, kind: "Image", position }),
  Map: ({ project, sceneName, name, position }) =>
    createMapObject({
      name,
      image: {
        id: projectSceneImageId(project, sceneName),
        width: DEFAULT_MAP_IMAGE.width,
        height: DEFAULT_MAP_IMAGE.height,
      },
      grid: gridSizeFromImage(DEFAULT_MAP_IMAGE),
      position,
    }),
  Player: ({ name, position }) => createGameObject({ name, kind: "Player", position }),
  Item: ({ name, position }) => createGameObject({ name, kind: "Item", position }),
  Event: ({ name, position }) => createGameObject({ name, kind: "Event", position }),
  // 战争雾：引用一张地图（`mapId` 由 createObject 现算；没有地图时创建会被挡在 store 那一层）
  Fog: ({ name, position, mapId }) => createFogObject({ name, mapId: mapId ?? "", position }),
  PlaySound: ({ name, position }) => createSoundObject({ name, position }),
  Teleport: ({ name, position }) => createTeleportObject({ name, position }),
};

export function createGameObjectForKind(
  kind: ObjectKind,
  input: GameObjectFactoryInput,
): GameObjectDoc {
  return GAME_OBJECT_FACTORIES[kind](input);
}
