# TASKS：战争雾变成独立场景对象

日期：2026-09-26
状态：已完成（pnpm check 全绿；Unity MCP EditMode 13/13、PlayMode 2/2）
前置：[[TASKS-显示顺序移入渲染组件]]（文档 v26 / 协议 v14）

## 目标（用户原话与拍板）

把战争雾做成**一个可摆放的场景对象**，不要和网格地图完全绑定；战争雾**引用网格地图的数据**。
用户拍板：

1. **对象可以摆放**（有自己的位置 / 旋转 / 缩放）；
2. **一个地图对应一个雾对象**；
3. 命令按**雾对象 id** 寻址（协议破坏性改，可接受）。

## 设计决策（拍板）

- **尺寸从被引用地图推导**：雾面片宽高 = 被引用地图显示图声明尺寸 × 雾对象 `scale`
  （不存宽高，符合仓库「不存能算出来的」口径）。
- **删除地图级联删除它的雾对象**。
- **编辑器画布只画一枚图标**（像声音 / 传送阵那样，可选中 / 可拖动），雾本身只在 Mask 窗口与前端呈现。

## 数据模型

- 新 kind `Fog`；`FogOfWar` 组件从地图搬到 `Fog` 对象，`data = { mapId, enabled, regions }`。
- 文档 **v26 → v27**，`migrateFogToSceneObject`（id 确定性 `<地图 id>__Fog`、摆位复制地图、幂等）；
  一张地图最多一个雾对象由 `validateScene` 强制。
- 协议 **v14 → v15**：`FogOfWar.data` 多 `mapId`；`erase_mask` / `reveal_fog_region` 的
  `objectId` = 雾对象 id。

## 任务清单

- [x] D1 文档：类型 + schema（`mapFogSchema.mapId`）+ 迁移 v27 + 命令（`setFogMap`；
      `setFogEnabled` / `setFogRegions` 总保留组件）+ 读口（`fogMapOf` / `fogObjectOfMap`）+
      `clearMapFog` 改按雾对象 + 工厂 `createFogObject` + 校验（悬空引用 / 一图一雾）+ 工厂
- [x] D2 协议：v15 + `mapFogSchema.mapId` + 命令注释
- [x] D3 编辑器：新对象类型（效果分类）+ 画布雾徽标（renderer `drawFogBadge`）+ `FogFields`
      引用地图选择器 + store `setFogMap` + 记账按雾对象 id + 删除级联 / 复制随地图复制
- [x] D4 Unity：`MirrorFog.mapId`；`FogOfWar.Apply(MirrorMap, MirrorFog, w, h, lift)`（不再
      `GetComponent<GridMapView>`）；雾对象不建占位面片；`SceneMirror` 两趟应用 + `ObjectLookup`；
      `CommandRouter` 按雾对象；`Protocol.Version = 15`
- [x] D5 验证：`pnpm check` 全绿（typecheck / 1186 单测 / lint / 文档统计）；e2e 夹具改写；
      Unity MCP EditMode 13/13 + PlayMode 2/2
- [x] D6 文档：CODE-STRUCTURE / README / 运行时镜像协议；`测试项目` 场景迁到 v27

## 风险与遗留

- 「可摆放」的语义后果：雾只在与地图对齐时才盖住地图上那几块雾格；挪开就是一张带该地图雾图案的独立雾片。
- 雾对象**未落位**（`position: null`）时前端不建视图（与其它对象同一口径）。
- 跨场景引用不支持（雾只解析本场景的地图）。
- e2e 在本环境多测同进程时易级联超时；受影响用例单独跑均通过。
