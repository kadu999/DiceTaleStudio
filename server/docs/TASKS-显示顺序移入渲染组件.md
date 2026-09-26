# TASKS：显示顺序移入渲染组件

日期：2026-09-26
状态：已完成（Unity MCP：EditMode 12/12、PlayMode 2/2 通过）
前置：[[TASKS-属性组与组件一一对应]]（v25/v13）、[[TASKS-表现层组件一对一]]（组件袋）

## 目标（用户原话）

后台编辑器的场景对象，把**显示顺序**（`sortingOrder`）这个属性**移到渲染层**——网格地图
（GridMap）、贴图层（ImageLayer）、精灵层（SpriteLayer）；**没有渲染层就不需要这个参数**
（PlaySound / Teleport / 以及没挑图的 Player / Item / Event，都不再有这个字段）。

## 设计决策（拍板）

### D1 文档（@dts/document）：v25 → v26

- `GameObjectDoc.sortingOrder` **删除**（类型 + `schema.ts` 的 `gameObjectSchema` + `types.ts`
  相关注释；`locked` 的 tooltip 里「显示顺序」字样同步）。
- 渲染组件数据各加一个 `sortingOrder: number`（int，schema `default(0)`）：
  - `MapDataDoc`（GridMap 组件数据）——schema `mapDataSchema` 扩展；
  - `ImageLayer` / `SpriteLayer` 组件数据 —— **不是**塞进 `ImageRef`（它是「只存引用」的共享
    形状，`GridMap.image` 也是它，污染不得）；新形状 = `imageRefSchema.extend({ sortingOrder })`，
    TS 类型用交叉类型 `ImageRef & { readonly sortingOrder: number }`。
- **迁移 v26** `migrateSortingOrderToRenderComponents`：对象级 `sortingOrder` →
  有 GridMap 进 GridMap.data；否则有 image 槽位组件（ImageLayer/SpriteLayer）进它的 data；
  都没有（动作对象 / 无图实体）→ **丢弃**（反正它们不渲染，旧值无意义）。
  挂在迁移链 v25（雾拆组件）之后。
- **写入路径**：新增专用命令 `setRenderSortingOrder(scene, objectId, value)`（放
  `commands/object.ts`）：取整 + 夹 ±9999（`SORTING_ORDER_LIMIT` 从 `object-spec.ts` 挪到
  `commands/shared.ts`）；找渲染组件（先 GridMap，后 image 槽位组件），**没有就返回 false**
  （没渲染层 = 没这个参数）；无变更返回 false。
  **不**走 `setComponentField` 泛型路——那把 GridMap/图片组件整个搬进规格注册表是更大的
  搬迁，本次不做（与 `component-specs/index.ts`「一个一个搬」的渐进哲学一致）。
- **`setObjectImage` / `setObjectSprite` 的写洞**：图片数据现在是「引用 + sortingOrder」，
  这两处 `writeFeature(object, imageComponent, next)` 是**整份替换**，会把 sortingOrder 抹掉——
  改为「旧 data 展开 + 新引用字段」。
  （map 路径 `{ ...map, image: next }` 本来就是展开的，天然安全。）
- **读取路径**：`access.ts` 加 `sortingOrderOf(object): number`——GridMap → image 槽位 → 0，
  全仓唯一读口（画布排序、mock 客户端、测试读回全走它）。
- `commands/object.ts` 的 `objectsInDrawOrder` 改用 `sortingOrderOf`。
- **object-spec.ts**：`OBJECT_SPEC.fields` 清空（机制保留给下一个无专属语义的标量字段），
  类注释更新；`setObjectField` 对 sortingOrder 随之不再接（测试改）。
- **factory.ts**：`createGridMapObject` 的对象级 `sortingOrder: -10` 挪进 GridMap data
  （`MAP_DEFAULT_SORTING_ORDER` 不变）；声音 / 传送阵工厂直接删这个字段。
- `DEFAULT_SORTING_ORDER`（0）语义变为「缺省」，仍留在 shared.ts（新建无渲染层对象不再写它）。

### D2 协议（@dts/protocol）：v13 → v14

- `gameObjectSchema.sortingOrder`（必填）**删除**——不兼容改动，必须 +1。
- 组件数据 schema 镜像 D1：`mapDataSchema` 与 image/sprite 组件数据 schema 各加
  `sortingOrder: z.number().int().default(0)`。
- `PROTOCOL_VERSION = 14`，版本表加 v14 一条；客户端 `Protocol.cs` 同步（`Version = 14`）。

### D3 编辑器（apps/editor）

- **属性面板**：「基础」组的 sortingOrder 行消失（OBJECT_SPEC 空了自然没了）；在三个渲染组
  各加一行「显示顺序」：网格地图组、图片层组、精灵层组——手写行组件
  `SortingOrderField`（照 `CellSizeField` 的模式，放 `object-fields.tsx`），
  经 store 新 action `setRenderSortingOrder` 写入。
- **store**：`setObjectSortingOrder` 改名改实现 → `setRenderSortingOrder(id, value)`
  （`store-types.ts` 注释、`object-slice.ts` 实现、InspectorPanel 等调用点同步）。
- **画布排序**：`ScenePanel` 走 `objectsInDrawOrder`（已改为 `sortingOrderOf`），无其他改动。
- **backend mock-client** 的 `object.sortingOrder` 打印改走 `sortingOrderOf`。

### D4 Unity 客户端

- `SceneParser.cs`：对象级 `sortingOrder` 不再读；改为解析组件数据——GridMap data 里有
  就取，否则 ImageLayer / SpriteLayer data 里取，都没有 = 0。
- `MirrorObject.sortingOrder` **保留为派生便利字段**（解析器填好，表现层
  SceneObjectView / FogOfWar / VideoOverlay 一行不用改）。
- `Protocol.cs`：`Version = 14` + 版本注释。
- EditMode 测试：新增「sortingOrder 从 GridMap / ImageLayer / SpriteLayer 组件数据解析」
  用例；老用例里的对象级 sortingOrder 载荷若有时同步移除。

### D5 测试与夹具

- 文档包测试：构造字面量里的对象级 `sortingOrder` 全部按新形状改写（渲染组件 data 带、
  其它对象不带）；新增 v26 迁移用例（进 GridMap / 进图片组件 / 无渲染层丢弃）；
  `component-field.test.ts` 的 OBJECT_SPEC 期望改空、sortingOrder 的夹取/无变更判据移到
  新命令的测试。
- 协议包测试：v14 载荷（对象级无 sortingOrder、组件数据里带）+ 旧 v13 载荷被拒。
- e2e：`helpers/editor.ts` 的 `gameObjectDoc(name, kind, pos, { sortingOrder })` 改把值写进
  渲染组件 data；读回处改走辅助读口；`CURRENT_SCENE_FORMAT_VERSION` → 26；
  假客户端 spec 的 `protocolVersion` → 14；相关 spec（object-edit 重叠命中、
  hierarchy、scene-menu 字段清单）同步。
- 资源场景文件（resources/projects/测试项目）随测试迁移到 v26。

### D6 文档

- `CODE-STRUCTURE.md`（§1 对象字段清单、object-spec 行、schema 行、迁移表、默认值表、
  §6.5 层级表、协议契约表）、`client/README.md`（sortingOrder 相关段落）、
  `docs/specs/2026-09-19-runtime-mirror-protocol.md`（对象字段表 + 映射表）。
- 历史文档（ANALYSIS / BASELINE）只加一行注记，不重写。

## 任务清单

- [x] D1 文档包：类型 + schema + 迁移 v26 + 新命令 + 读口 + 写洞修复 + 工厂
- [x] D2 协议包：v14 + 组件 schema + 版本表
- [x] D3 编辑器：面板行 ×3 + store action + mock-client
- [x] D4 Unity 客户端：解析 + 版本 + 测试
- [x] D5 全量验证：`pnpm check` 全绿 + e2e（非 runtime + @runtime）+ MCP EditMode
- [x] D6 文档同步

## 进度日志

- 2026-09-26 立项：全链路调查完成（文档 / 协议 / 编辑器 / 客户端 168 处引用），D1–D6 拍板。
- 2026-09-26 实施完成（D1–D6）：
  - 文档 v26 / 协议 v14；`GameObjectDoc.sortingOrder` 删除，`MapDataDoc` 与图片层数据各加
    `sortingOrder`（`ImageRef & { sortingOrder }`）；`migrateSortingOrderToRenderComponents`
    先地图、后图片层、无渲染层丢弃；`access.sortingOrderOf` 是唯一读口；
    `setRenderSortingOrder` 取代 `setObjectSortingOrder`；`setObjectImage` / `setObjectSprite` /
    `resolveSceneSprites` 三处「整份替换」的写洞已补。
  - `OBJECT_SPEC` 清空；`SortingOrderField` 出现在网格地图 / 图片层 / 精灵层三个渲染组；
    `snapshot` 相关测试与 e2e helper 改走派生读口；测试项目三个场景迁到 v26。
  - 验证：`pnpm typecheck`、`pnpm test`（80 文件全绿）、`pnpm lint`、`pnpm check:docs` 全通过。
  - Unity：`Protocol.Version = 14`、`SceneParser` 从渲染组件解析 `sortingOrder`、
    新增 EditMode 用例 `SortingOrderComesFromRenderComponents`。
  - 2026-09-26 Unity MCP 验证：强刷 + 编译（控制台 0 错误）后跑测试——
    **EditMode 12/12 通过**（含新用例）、**PlayMode 2/2 通过**，零回归。

