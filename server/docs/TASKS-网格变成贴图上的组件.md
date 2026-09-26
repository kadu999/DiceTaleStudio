# TASKS：取消 Map 类型，网格变成贴图上的可选组件

日期：2026-09-26
状态：已完成（`pnpm check` 全绿；Unity 侧改了代码，编译 / 测试需在 Unity 里跑——本轮没有 Unity MCP）
前置：[[TASKS-战争雾独立对象]]（文档 v27 / 协议 v15）

## 目标（用户拍板）

「搞复杂了。把网格地图和渲染相关的去掉，网格地图就变成只存数据对象 + 编辑功能，没有实体。」

选定的做法（方案 C）：**取消 `Map` 对象类型**——「网格地图」= 一张**贴图** + 一个 **`GridMap` 组件**
（可选能力，可加可移除）。网格只有数据（`grid` / `rowOrder` / `cells`）与网格编辑窗口，**没有任何渲染实体**；
贴图与显示顺序由对象自己的 `ImageLayer` 承载。

> 先前的方向（v28 草案：保留 `Map` 类型，只把 image/sortingOrder 搬进 `ImageLayer`）已按用户要求
> **还原到 `c67fb97` 后重做**——本方案在它之上又取消了 `Map` 类型。

## 数据模型

- 文档 **v27 → v28**：
  - `MapDataDoc` 去掉 `image` 与 `sortingOrder`，只剩 `grid` / `rowOrder` / `cells`；
  - `Map` kind 取消（`LEGACY_KINDS` 把老 `Map` 落到 `Image`），`GridMap` 改为可选组件
    （`templateKinds: ["Image"]` / `optionalKinds: ["Image"]`，无 `repairKinds`）；
  - `Image` 预设声明 `image` / `map` / `video` 三个槽位（后两个是可选能力）；
  - 迁移：`renameObjectKinds`（Map → Image）+ 新增 `migrateGridMapImageToLayer`
    （GridMap 的 image/sortingOrder → `ImageLayer`，幂等）。
- 协议 **v15 → v16**：`mapDataSchema` 去掉 `image` / `sortingOrder`；地图对象改为下发 `ImageLayer`
  组件；`resourceIdsOfObject` 去掉单独的 `map.image` 分支。

## 任务清单

- [x] D1 文档：类型 / schema / 迁移 / 预设 / 组件定义 / 工厂（`createGridMapObject`）/ 访问器
      （删 `objectImageSlot`，`objectImage` = `imageOf`，`sortingOrderOf` 只看图片层）/ 命令
      （`addObjectGridMap` / `removeObjectGridMap` 取代 `repairMapObjectComponent`）/ 校验 / `sprites.ts`
- [x] D2 协议：v16 + `mapDataSchema` + `resourceIdsOfObject`
- [x] D3 编辑器：对象类型表（「网格地图」瓦片 = `kind: Image` + `withGrid`）/ 创建流程 /
      属性面板（「网格地图」组给「添加 / 移除网格」，贴图与显示顺序归「图片层」组）/
      场景改名同步贴图改读图片层 / 三个对话框读 `objectImage`
- [x] D4 Unity：`MirrorMap` 去 `image`/`sortingOrder`；`DisplayImage => image`；
      `ResolveSortingOrder` 去掉地图分支；`FogOfWar.Apply` 多收一个 `MirrorImage`（遮罩尺寸）；
      `SceneObjectView` 雾分支从被引用对象取图；`Protocol.Version = 16`
- [x] D5 验证：`pnpm check` 全绿（typecheck / 1186 单测 / lint / 文档统计）；e2e 夹具与规格改写
- [x] D6 文档：CODE-STRUCTURE / README / 运行时镜像协议；`测试项目` 场景迁到 v28

## 遗留

- **Unity 编译 / 测试本轮没跑**（工具目录里没有 Unity MCP）：请在 Unity 里重新编译并跑
  EditMode / PlayMode，重点看 `ComponentDrivenMirrorTests` 的雾用例与 `SceneObjectView`。
- 语义后果：**普通贴图也会出现「网格地图」组**（给「添加网格」入口），与「视频」组同一套可选能力模型。
