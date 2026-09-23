import {
  createMapObject,
  createSceneObject,
  createSoundObject,
  createTeleportObject,
  type ObjectKind,
  type SceneObjectDoc,
  type WorldPosition,
} from "@dts/document";
import { gridSizeFromImage } from "@dts/grid";
import { projectSceneImageId } from "@dts/resources";
import { DEFAULT_MAP_IMAGE } from "./store-core";

interface SceneObjectFactoryInput {
  readonly project: string;
  readonly sceneName: string;
  readonly name: string;
  readonly position: WorldPosition;
}

type SceneObjectFactory = (input: SceneObjectFactoryInput) => SceneObjectDoc;

/** 每种文档对象在编辑器中新建时的组装规则；添加 ObjectKind 时必须明确登记工厂。 */
const SCENE_OBJECT_FACTORIES: Record<ObjectKind, SceneObjectFactory> = {
  SceneObject: ({ name, position }) => createSceneObject({ name, kind: "SceneObject", position }),
  Sprite: ({ name, position }) => createSceneObject({ name, kind: "Sprite", position }),
  Image: ({ name, position }) => createSceneObject({ name, kind: "Image", position }),
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
  Player: ({ name, position }) => createSceneObject({ name, kind: "Player", position }),
  Item: ({ name, position }) => createSceneObject({ name, kind: "Item", position }),
  Event: ({ name, position }) => createSceneObject({ name, kind: "Event", position }),
  PlaySound: ({ name, position }) => createSoundObject({ name, position }),
  Teleport: ({ name, position }) => createTeleportObject({ name, position }),
};

export function createSceneObjectForKind(
  kind: ObjectKind,
  input: SceneObjectFactoryInput,
): SceneObjectDoc {
  return SCENE_OBJECT_FACTORIES[kind](input);
}
