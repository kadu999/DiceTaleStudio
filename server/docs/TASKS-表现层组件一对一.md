# TASKS：表现层组件一对一（组件袋重构）

日期：2026-09-26
状态：进行中
前置：[[TASKS-属性组与组件一一对应]]（文档 v25 / 协议 v13，已提交 41d2ac2）

## 背景与目标

后台编辑器的属性组已经与协议组件一一对应（上一任务）。但前端 Unity 表现层把**所有实体的功能
都塞在 `SceneObjectView` 一个类里**：图片渲染分派、占位色、取图、战争雾层的建拆与摆放、
视频层的几何同步，全部在这一个 513 行的类中。

用户决策（原话两点）：

1. **动作类（`PlaySound` / `Teleport`）和事件类场景对象不需要严格一对一**——反正只是发协议
   命令，维持现状（`NeedsView = false`，不建 GameObject）。
2. **实体类组件需要严格一对一（组件对组件）**：`GridMap` / `FogOfWar` / `ImageLayer` /
   `SpriteLayer` / `VideoOverlay` 各自一个 C# 表现组件类，免得把所有功能都塞在
   `SceneObjectView` 里。

目标：实体对象的 GameObject 变成**组件袋**——每个实体协议组件在表现层有且只有一个对应组件；
`SceneObjectView` 退化为协调器（只管对象本体：transform / 激活 / 顺序 / 占位 / 取图分派）。

## 设计决策（拍板，不再讨论）

### D1 组件对应表

| 协议组件 | 表现组件 | 职责 | 状态 |
|---|---|---|---|
| （对象本体属性：position/rotation/active/sortingOrder/name/scale） | `SceneObjectView`（协调器） | GameObject、激活、摆放、占位色、显示顺序、取图与分派 | 瘦身 |
| `GridMap` | **`GridMapView`（新建）** | 持有当前 `MirrorMap`（gridWidth/gridHeight/cells），是格子数据的展示层唯一入口；未来的网格线绘制落这里 | 新建 |
| `ImageLayer` | `ImageLayer` | 整张图面片 | 不动 |
| `SpriteLayer` | `SpriteLayer` | 图集子图面片 | 不动 |
| `FogOfWar` | `FogOfWar`（重构） | 自建/自管渲染子物体 `FogOverlay`，遮罩 + 揭示 + 羽化 | 重构 |
| `VideoOverlay` | `VideoOverlay` | 视频面片与播放器（命令驱动建拆） | 不动 |
| `PlaySound` / `Teleport` | （无） | 动作对象不建视图，只留镜像数据 | 不动 |

### D2 FogOfWar 改为组件自治（最大的行为变化）

- `FogOfWar` 组件**挂在对象自己的 GameObject 上**（与其他组件并列，组件袋一员），它自己负责
  建/拆自己的渲染子物体 `FogOverlay`（子物体挂 `ImageLayer`，贴羽化后的 RenderTexture）。
- 「该不该有雾层」的三个条件（有 `GridMapView`、开关 `enabled`、雾区 `regions` 非空）**全部
  内聚进 `FogOfWar`**，不再由 `SceneObjectView.ApplyFog` 判断。
- **语义变化（有意为之）**：`FogOverlay` 从「场景根节点同级」改为「地图对象的子物体」——
  - 位置 / 旋转 / 缩放自动跟随，不再由视图拿同一份数值摆两遍；
  - 地图对象被隐藏（`active=false` / 未落位）时雾**跟着隐藏**（雾属于这张地图，没有可盖的东西）；
  - 视图销毁时子物体自动带走，`OnDestroy` 里不再手动收尸。
- 显示顺序仍取 `short.MaxValue`（盖最前，与对象自己的 sortingOrder 无关）；离地 = 地图 lift +
  `0.002`（常数 `FogLift` 从 SceneObjectView 移入 FogOfWar）。
- 渲染子物体的销毁要保留「运行时 `Destroy` / 编辑器 `DestroyImmediate`」的切换
  （`DestroyOwned` 从 SceneObjectView 移入 FogOfWar）。

### D3 GridMapView 与 FogOfWar 的依赖方向

- `FogOfWar` 运行时 `GetComponent<GridMapView>()` 取格子数据，拿不到 = 不是地图 = 不画雾。
- `SceneObjectView` 在 `Apply` 里调 `gridMapView.Adopt(obj.map)`（对象没挂 GridMap 组件则
  没有这个组件，表现层不建）。

### D4 SceneObjectView 退化后的职责边界

保留：GameObject 生命周期、`name` / `active`、`Place`（位置/旋转）、占位色 `KindColor`、
`sortingOrder` / `lift` 计算、异步取图与回调、按数据把参数分派给各组件。
移出：`ApplyFog` 整段、`FogOverlayName` / `FogSortingOrder` / `FogLift` 常数、`fog` 字段管理、
`OnDestroy` 的雾收尸。
`Fog` / `Video` 属性保留（CommandRouter 经 `view.Fog` 执行 `erase_mask` /
`reveal_fog_region`，经 `view.Video` 暂停/继续）；`fog` 改为 Create 时
`GetComponent<FogOfWar>()` 缓存（组件在袋中恒存在，overlay 子物体才有条件）。

### D5 不动的部分

- `SceneMirror`（建视图逻辑、`NeedsView` 判据、淡入淡出）不动，只同步类注释里
  「FogOverlay 与地图同级」的描述。
- `CommandRouter` 不动（`view.Fog` / `view.PlayVideo` 等入口签名不变），只同步注释。
- 数据层 `SceneModel` / `SceneParser` / 协议版本**不动**（纯表现层重构，协议与文档格式零变化）。

## 任务清单

- [x] T1 新建 `GridMapView.cs`（采纳 `MirrorMap` + 类注释说明它是 GridMap 的表现层座位）✅ 2026-09-26
- [x] T2 重构 `FogOfWar.cs`：组件上袋、自管 overlay 子物体、条件内聚、常数移入 ✅ 2026-09-26
- [x] T3 重构 `SceneObjectView.cs`：退化协调器，删雾相关全部逻辑 ✅ 2026-09-26
- [x] T4 `SceneMirror.cs` / `CommandRouter.cs` 注释同步（同级 → 子物体）✅ 2026-09-26
- [x] T5 EditMode 测试：新增 `GridMapView` 采纳与 `FogOfWar` 自建/自拆 overlay 用例 ✅ 2026-09-26
- [x] T6 MCP 跑全量 EditMode 测试验证（**11/11 通过**，8 旧 + 3 新，0 回归）✅ 2026-09-26
- [x] T7 文档同步：本文件、CODE-STRUCTURE.md（§6.5 加组件袋注记）、client/README.md ✅ 2026-09-26

## 进度日志

- 2026-09-26 任务立项：设计决策 D1–D5 拍板。
- 2026-09-26 T1–T5 实施完成（coder 子代理）：`SceneObjectView` 513 → 467 行（协调器），
  `FogOfWar` 接管 overlay 生命周期，`GridMapView` 新建（含 `.meta`），
  `SceneMirror` / `CommandRouter` 仅注释变化（git diff 可证），新增 3 个 EditMode 用例。
  实施中的连带行为变化（有意接受，已写进 FogOfWar 类注释）：
  - `FogOfWar` 组件随组件袋**常驻**对象 GameObject（不再随开关建拆），开关关着期间
    `erase_mask` / `reveal_fog_region` 会作用在**保留的遮罩与操作记录**上（状态不丢，
    重开恢复原样）；CommandRouter 里「开关关着 / 没绑雾区」的失败话术对这两条命令
    事实上不可达（代码原样保留）。
  - `Adopt` 数据不全时从「留下空白 overlay」改为「直接拆掉」（与该组件自己
    「先不画」的日志口径一致）。
  - `FogOfWar.Release` 改 `internal` 供 SceneObjectView 拆视频层复用，`DestroyOwned` 删除。
- 2026-09-26 T6 验证：Unity MCP `run_tests`（EditMode）**11/11 通过**（0.51s），
  既有 8 用例零回归；测试枚举成功本身证明编译零错误。
- 2026-09-26 T7 文档同步完成。任务收口。
