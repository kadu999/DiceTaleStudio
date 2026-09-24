# 组件驱动与 kind 退役计划

## 目标

让功能由组件定义和承载：对象挂了什么组件，就拥有什么功能；属性编辑器也由组件类型提供。`kind` 不立即删除，而是逐步从功能、编辑和校验路径退役，最终只用于创建模板、分类和旧文档兼容。

本计划先改变代码职责与行为判定，不改变当前场景 JSON 形状、文档格式版本、协议载荷或 Unity 消费格式。

## 当前结构与问题

- `GameObjectDoc` 已有 `components[]`，地图、图片、声音、传送、视频数据都在组件里；通用对象字段（名称、激活、位置、缩放、排序等）留在 GameObject。
- `OBJECT_PRESETS` 同时承担创建模板和组件准入职责。访问器多数按组件 slot 读取，但缺组件补默认值、视频命令、部分校验和 Inspector fallback 仍看 `kind`。
- Inspector 已有 `SoundFields`、`TeleportFields`、`VideoFields`、`FogFields` 等独立 UI 文件，但 `registry.tsx` 仍以对象分组注册；组件类型没有完整的编辑器归属关系。
- 图片能力分为 `GridMap` 的地图图片、`ImageLayer` 的整图和 `SpriteLayer` 的子图，不能只按通用图片 slot 推断其编辑语义。
- 视频、声音、传送等专用命令带有列表同步、组件摘除和运行态记账等副作用，不能一律改成泛型字段写入。

## 目标职责

- **GameObject 自身**：只保存所有对象共有的身份与基础变换字段；`kind` 保留作原型/分类元数据，不决定已挂组件的功能。
- **组件实例**：是功能、渲染能力及属性编辑的事实来源。组件注册表声明组件类型、slot、默认数据来源及旧 kind 兼容模板。
- **组件编辑器**：每种组件类型注册自己的 Inspector 编辑器；一个组件可提供一个或多个面板分组。组件编辑器只编辑该组件数据，通用对象字段由独立 Object Editor 管理。
- **访问器与命令**：优先按实际组件实例读写；只有实例缺失且对象来自受支持的旧 kind 模板时，才按迁移兼容规则补建默认组件。
- **验证与运行时**：先按组件实例验证和执行。kind 与组件不一致时给迁移提示，不以 kind 否决现有组件行为；模板对象缺失必需组件时保留可定位诊断。

## 分阶段实施

### 阶段 1：属性编辑器按组件注册

- 保留通用 Object Editor，迁出现有对象分组注册表中的功能字段到 `ComponentType -> ComponentEditor` 注册表。
- `GridMap` 可注册“区域”和“战争雾”两个面板；`ImageLayer` / `SpriteLayer` 分别声明图片编辑语义；其他组件注册各自现有编辑器。
- 有组件实例时只显示该组件编辑器。过渡期对组件缺失的旧对象使用明确的兼容 fallback；不在读取时自动重写文档。
- 验收：现有面板、组件写入、撤销、缺组件旧对象与 kind 错位但显式挂组件的测试通过；协议和存档 golden/contract 无变化。

### 阶段 2：组件优先读写与命令（完成）

- 访问器、组件字段命令和功能专用命令统一按实际组件实例工作，不因 kind 不同而拒绝已有组件。
- 组件缺失时的默认创建兼容集中在组件定义的兼容元数据中，不再从多个 `kind -> slots` 分支重复推导。
- 图片写入选取实际承载图片的组件；`GridMap` 图片继续保存在地图组件中。子图能力按实际 `SpriteLayer` / `ImageLayer` 组件判定。
- 视频、声音、传送列表及开关继续走有副作用的专用命令；仅简单标量字段走组件规格的泛型写入。
- 验收：现有 kind 模板行为不变；kind 错位但组件有效时读、写、运行行为正常；slot 冲突/重复组件仍由现有约束处理。

### 阶段 3：组件驱动校验、显示与运行（进行中）

- 逐项迁移地图目标查找、场景贴图选择、徽标/可见视图、视频播放、声音与传送目标到组件能力。
- kind 缺少组件的旧/不完整对象保留迁移期错误或提示；显式组件不因 kind mismatch 被忽略。未知组件保持可往返，不被删除。
- 对 `kind` 只剩显示、分类、对象创建模板和兼容迁移职责建立可搜索的架构测试约束。
- 验收：组件组合夹具覆盖每个功能的可见、可编辑、可命令路径；Unity 镜像合同测试与组件协议文档合同测试通过。

### 阶段 4：缩减 kind 兼容并评估退役（盘点中）

- 统计真实项目与历史文件中的 kind/组件组合；按组件逐项停止 kind fallback，提供明确升级或继续兼容策略。
- 只有在旧文档迁移、编辑器创建流程、协议与 Unity 客户端均不再依赖 kind 功能语义后，才讨论删除 kind 字段或改文档格式版本。
- 这一步是独立的破坏性决策；未完成真实数据盘点前不改格式版本、不移除字段。

#### 阶段 4 首轮盘点

| 组件 | 历史 kind / 组件证据 | 当前 kind fallback 的用途 | 首轮决策 |
| --- | --- | --- | --- |
| `GridMap` | 历史 `Map` 快照曾无组件；v19 迁移从扁平 `map` 搬入 | 缺组件诊断；地图能力/创建模板路由 | 不退役。历史迁移已覆盖，但需保留当前损坏文档的诊断与地图创建语义 |
| `ImageLayer` | 历史 `Map` / `Image` / `Player` / `Item` / `Event` 图片字段或旧图片组件 | 新建空对象选图时选择承载组件；无图对象 Inspector 入口；旧格式迁移 | 不退役。先把创建模板路由与旧文档读取 fallback 拆开评估，不能让空白新对象失去选图入口 |
| `SpriteLayer` | 历史 `SceneObject` 图片字段/旧组件，之后迁移为 `SpriteLayer` | 新建空精灵选择子图组件与编辑入口；旧格式迁移 | 不退役。创建模板职责仍依赖 `Sprite`，旧格式由 schema 迁移 |
| `PlaySound` | 历史 `PlaySound` 快照曾无组件；v19 从扁平 `sound` 迁移 | 旧字段由 schema 迁移；现行缺组件通过显式修复恢复默认数据 | 已停止字段编辑时按 kind 隐式补建；校验保留错误，Inspector 提供可撤销修复 |
| `Teleport` | 历史 `Teleport` 快照曾无组件；v19 从扁平 `teleport` 迁移 | 旧字段由 schema 迁移；现行缺组件通过显式修复恢复默认数据 | 同 `PlaySound`，不再由目标编辑命令隐式补建 |
| `VideoOverlay` | 历史 `Map` / `Image` 视频字段在 v19 搬入组件 | 地图/贴图可以启用可选视频能力；开启开关或编辑列表时按 kind 补组件 | 暂不退役。当前没有通用“添加组件”UI，移除后地图/贴图无法从 Inspector 开始添加视频 |

数据范围：仓库当前只有一份样例项目，3 个场景文件共 7 个对象；现行组合为 `Map/GridMap` 1、`Map/GridMap+VideoOverlay` 2、`Sprite/SpriteLayer` 1、`Image/ImageLayer` 1、`PlaySound/PlaySound` 1、`Teleport/Teleport` 1，均匹配。沿样例场景文件 Git 历史收集到 13 种对象快照组合（按每个提交的对象出现次数计）：`Map/<none>` 26、`Map/GridMap` 9、`Map/GridMap+VideoOverlay` 11、`PlaySound/<none>` 7、`PlaySound/PlaySound` 8、`Teleport/<none>` 3、`Teleport/Teleport` 8、`SceneObject/<none>` 15、`SceneObject/SpriteLayer` 1、`SceneObject/TextureRenderer` 1、`Sprite/SpriteLayer` 6、`Image/ImageLayer` 6、`Texture/ImageLayer` 1。该统计会重复计算跨提交未变对象；`<none>` 仅表示快照没有 `components[]` 实例，旧格式可能把能力存在扁平字段中，不代表对象没有该能力。外部真实项目/历史存档不可见，因此这份盘点不能作为停用兼容的用户数据依据。

首轮结论：原 `defaultKinds` 同时承载创建模板路由、可选组件准入和缺组件修复，不能整体删除。v18 及更早扁平字段由 schema 迁移搬入组件；现行格式中组件缺失属于不完整/损坏文档。`PlaySound` / `Teleport` 已提供显式、可撤销的默认组件修复，字段编辑不再按 kind 隐式补建；其它必需组件 fallback 与可选视频准入仍保留，因为它们分别支撑图片入口、地图能力和视频启用流程。外部真实项目/历史存档仍不可见，不能据仓库样例决定全面停用。

## 兼容约束

- 一个 slot 当前最多一个承载组件；不在本轮引入多实例组件或同 slot 多态混挂。
- `kind` mismatch 本身不能覆盖或静默删除组件数据；迁移提示不得变成写入拒绝。已知组件 mismatch 时不再用 kind 为其它 slot 补默认组件。
- 历史组件重命名、旧 kind 规范化仍由现有 schema migration 处理；新代码不复制第二套迁移逻辑。
- `GridMap` 与 `ImageLayer` 同时存在时，地图图片语义优先取自 `GridMap`；普通图片 slot 不得覆盖地图图像。

## 当前进度与阻塞

- 已提交阶段 1 的 Inspector 组件编辑器注册表：`af2ec3f refactor(editor): register inspector editors by component`。
- 阶段 2 的实现与自动化验证已完成，提交为 `af5f7b4 refactor(document): drive object behavior from components`。访问器、通用组件字段命令、视频/声音/传送专用命令均优先使用实际组件；阶段 4 切片验证之前的兼容元数据按用途分别声明，并有测试约束模板与组件路由一致。
- 本轮遇到并处理的问题：`validation.ts` 与 `commands/video.ts` 引用了不存在/错层的组件能力查询名，导致类型检查失败及多个测试级联失败；精灵图片默认组件查询使用了错误来源，导致一批图片/子图读写与协议解析测试失败；将 `ComponentType` 导入一并误删导致 presets 类型错误。更正后，`pnpm typecheck` 通过，9 个定向测试文件的 277 个测试通过。
- 已补齐 kind 错位的 Inspector、动作徽标、视频运行命令和校验回归；校验只给 mismatch warning，不拒绝或删除显式组件。未知组件仍按原样保留。
- 最终自动化验证：`pnpm typecheck` 通过；`pnpm test` 通过（79 个文件、1155 个测试）；`pnpm lint` 通过；`pnpm e2e:smoke` 通过（桌面 5 项通过，平板专用用例 1 项按项目配置跳过）。构建仅有依赖 `eruda` direct eval 与 Tailwind sourcemap 警告。
- 已搜索 `kind` 功能判断残留：编辑器里的功能操作改按组件能力；剩余 `kind` 读取用于分类/筛选、标签展示、创建模板，或按组件定义的 fallback/optional 准入为缺失组件提供兼容。`schema.ts` 中历史迁移属于预期职责。Unity 的对象视图创建与视频命令也按组件判断；`kind` 仍用于镜像字段及占位色。
- `GridMap` 与 `ImageLayer` 并存时地图图片优先，Inspector 隐藏普通图片面板；已覆盖文档层优先级。kind mismatch 下显式组件的 Inspector 与校验已有回归。协议载荷、文档格式和 Unity 消费格式未改。
- `apps/backend/test/protocol-document-contract.test.ts` 的 7 个协议-文档合同测试已通过。本轮通过 Unity MCP `http://127.0.0.1:8080/mcp` 连接当前 `client` 工程（Unity `6000.3.19f1`）：强制脚本刷新/编译后控制台 0 error / 0 warning；Editor 内 4 条运行时断言通过，覆盖 kind 错位时 PlaySound / Teleport 视图判定、ImageLayer 视图判定、VideoOverlay 字段解析及未知组件保留。随后新增 `DiceTale.Tests` EditMode 程序集，Unity 已发现并通过 5 个可重复用例（5/5），覆盖动作/图片视图判定、SpriteLayer 身份、VideoOverlay 与未知组件解析、组件字段 fallback；修正了 TestAssemblies 与显式 TestRunner 引用重复的问题。项目仍只有通用占位 PlayMode 测试 `Client`，实际 PlayMode 业务用例为 0；需补充运行时生命周期/渲染行为测试，但“缺少项目级 Unity 测试程序集”不再是阻塞。
- 阶段 4 已开始首轮审计：仓库样例当前 7 个对象无 mismatch；历史提交包含迁移前的无组件快照。逐组件决策与限制见上表；没有外部用户项目样本，不能全面停用兼容路径。
- 阶段 4 首个代码切片已提交：将 `defaultKinds` 职责拆为预设组件关联 `templateKinds`、必需组件缺失修复 `repairFallbackKinds`、可选组件准入 `optionalKinds`。`VideoOverlay` 仅保留地图/贴图的可选准入，不再走必需组件 fallback。
- 阶段 4 第二个代码切片已提交：把运行时必需组件 fallback 明确命名为 `repairFallbackKinds`，避免与 schema 的旧格式迁移职责混淆。
- 阶段 4 第三个代码切片：新增 `PlaySound` / `Teleport` 显式修复命令与 Inspector 入口，修复进入撤销栈；两者从隐式 `repairFallbackKinds` 移至显式 `repairKinds`，普通字段命令在组件缺失时不再补建。校验仍报告缺组件错误。地图、图片与视频流程暂不改变。
- 下一步：为 Unity 镜像补充有实际运行态覆盖的 PlayMode 测试；对 GridMap/ImageLayer/SpriteLayer 分别设计数据安全的显式修复或组件添加流程，再结合真实项目盘点评估是否缩减其 fallback。仍不改格式版本、不移除 `kind` 字段。

## 当前相关入口

- `packages/document/src/components.ts`：组件定义、创建模板 kind 与兼容准入元数据。
- `packages/document/src/presets.ts`：现存对象创建模板和兼容查询；后续逐阶段缩减其功能判定职责。
- `packages/document/src/access.ts`、`packages/document/src/commands/`：组件访问与写入规则。
- `apps/editor/src/panels/inspector/registry.tsx`：Object Editor 与组件编辑器注册表。
- `packages/protocol/src/messages.ts`、`client/Assets/DiceTale/Scripts/`：运行载荷与 Unity 镜像端；第一至三阶段保持兼容。
