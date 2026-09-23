# server 代码分析报告：场景对象架构 & 重复实现

> ## ⚠️ 这是一份**历史快照（2025-06）**，不要照它下判断
>
> 它描述的不少东西**已经不存在**了。现行结构的权威说明是 [`CODE-STRUCTURE.md`](CODE-STRUCTURE.md)；
> 「加一个功能要碰哪些文件」的实测数字看 [`BASELINE-加一个组件要碰哪些文件.md`](BASELINE-加一个组件要碰哪些文件.md)。
> 下面逐条标出它已经过时的地方（都是核对过仓库现状的）：
>
> | 这份文档说 | 现状 |
> |---|---|
> | §1.2 组件注册表有 **13 种**组件（7 通用 + 6 特性），每项带 `fields` / `conditionValueTypes` / `commandTypes` | 现在只有 **6 种**（全部是从对象特性提升上来的）；没有 `conditionValueTypes` / `commandTypes`；`fields` 也已从注册表移除——字段的归属地改成了 `component-specs/` 的组件规格（`ComponentTypeDef` 现在只管**注册**：type / displayName / gmEditable / slot / legacyField / tooltip） |
> | §1.2、§1.4 提到 `features.ts`（特性路由表）与 `kinds.ts`（kind 层级表） | **两个文件都已删除**。职能并进 `presets.ts` 的 `OBJECT_PRESETS`：kind 只是**预设 id**，每个预设的 `slots` 声明「允许哪些能力槽位、缺省由哪个组件承载」 |
> | §1.3 说 kind 层级是声明式元数据（`OBJECT_KIND_DEFS` 带 `parent`） | v22 起**层级已整层移除**，`OBJECT_KIND_DEFS` 不存在。`kind` 不再有父子关系 |
> | §1.5 说 `ComponentDoc` 的 `data` 是「属性 bag」且 **`actions[]` 挂在组件上** | `data` 仍然是不透明 bag（没错），但 **`actions[]` 那一层已整层删除**（连同 `invoke_action` / `register_*` / `report_*` 那套旧模型）。组件实例现在只有 `id` / `type` / `displayName?` / `data` |
> | §2.1① 「`@dts/actions` 整个包是死代码，**建议删除**」 | ✅ **已删除**（整包 + `apps/editor/package.json` 里那条依赖声明）；同源的 7 种旧组件类型与 condition / action schema 也一并清了。现在 `packages/` 只有 5 个包：grid / resources / protocol / document / renderer |
> | §2.1② protocol 与 document 两套复刻 schema（约 200 行复刻 + 240 行契约测试） | ⏳ **仍然存在**，且仍然是**有意的**依赖方向妥协（由 `server/test/architecture.test.ts` 的 `ALLOWED` 表守住 `protocol: []`）。收敛的三个选项与建议见 BASELINE 文档 §4 的「阶段 C（T1）」 |
> | §2.1③ 三对模板级近似重复（播放记账 ×3、Sound/Video 弹框、Fog/Grid 窗口+切片） | ⏳ **基本仍然成立**——**这是这份文档现在唯一还值得读的部分** |
> | §1.6 「已把 CODE-STRUCTURE 的『真 ECS』措辞改掉」 | ✅ 已改 |
>
> **处理建议**：不要删这份文档（§2.1③ 那份同构拷贝的对比还在用），但读之前先看这张表。

> 范围：`server/` 下全部代码（apps/* + packages/*，不含 `client/` Unity 前端）。
> 方法：静态阅读 + 全仓 grep 交叉验证（含 import 引用核查），2025-06 快照。
> 结论速览：场景对象**确实是 Unity 式的实体+组件模式**（一个实体挂接多个组件，模拟 GameObject + Component；非 ECS 框架）；重复实现**存在但有边界**——1 处死代码、1 处刻意复刻、若干模板级近似重复；文件多的主因是竖切式拆分与高测试密度，而非重复造轮子。

---

## 1. 场景对象的实现：实体 + 组件 ✅

### 1.1 模式判定

**采用了 Unity 式的实体 + 组件模式（GameObject + Component）：一个实体可挂接多个组件，不是 ECS 框架。** 这与设计意图一致（场景对象模拟 Unity 对象），代码里有直接的对应证据：

| Unity | 本代码库 |
|---|---|
| `GameObject` | `GameObjectDoc`（name / active / 变换 / sortingOrder） |
| `Component`（如 `SpriteRenderer`） | `ComponentDoc`（`type` = 前端 C# 组件类名，`data` 为属性 bag，`actions[]` 挂在组件上） |
| `[DisallowMultipleComponent]` | 同一类型每对象最多一个（`components.ts:251`） |
| `MonoBehaviour` 行为 | 在 Unity 客户端的 C# 组件类里；编辑器/服务端只做数据与校验，没有 system/调度循环 |

核心证据——全代码库只有**一个**对象数据类型 `GameObjectDoc`（`packages/document/src/types.ts:430`）：

```ts
export interface GameObjectDoc {
  readonly id: string;
  readonly name: string;
  readonly kind: ObjectKind;      // 自由字符串标签 + 层级归属
  readonly active: boolean;
  readonly locked: boolean;
  readonly sortingOrder: number;
  readonly position: WorldPosition | null;
  readonly rotation: number;
  readonly scale: number;
  readonly components: ComponentDoc[];   // ← 一切特性/能力都住这里
}
```

- 对象差异**全部**靠 `components: ComponentDoc[]` 组合表达，没有任何 `Sprite extends GameObject` 式的类。
- `kind` 只是创建原型标签：协议注释明确写「v9 起 `kind` 只是创建原型标签，不再决定行为，对象有什么全看 `components`」（`packages/protocol/src/messages.ts:367`）。
- 有演进史佐证：v19 把 5 个扁平字段（map/image/sound/teleport/video）搬进组件（`types.ts:53-57` 版本注释）；v22 才补上 kind 层级。`features.ts:5-11` 注释记录该表就是为消灭散落的 `kind === "PlaySound"` 式判断而立的**唯一归属地**。

### 1.2 组件系统的三层结构

| 层 | 位置 | 作用 |
|---|---|---|
| 组件类型注册表 | `packages/document/src/components.ts:20,56` | 13 种组件（7 通用 + 6 特性），每项带 `fields`/`gmEditable`/`conditionValueTypes`/`commandTypes` |
| 特性路由表 | `packages/document/src/features.ts:33,71` | 「哪个 kind 带哪个特性、由哪个组件承载」的唯一归属地，判据沿 kind 层级向上查 |
| 实例 + 访问器 | `types.ts:222`、`packages/document/src/access.ts:43` 起 | 实例 id 确定性生成 `<objectId>__<ComponentType>`；读一律走访问器（`mapDataOf`/`imageOf`…），注释明令禁止调用处写 `components.find(...)` |

### 1.3 kind 层级是声明式元数据，不是继承

`packages/document/src/kinds.ts:73` 用一张表表达 9 种 kind 的归属（抽象基类 `GameObject` + `Sprite`/`Image`/`Map`/`Player`/`Item`/`Event`/`PlaySound`/`Teleport`）：

```ts
export const OBJECT_KIND_DEFS: readonly ObjectKindDef[] = [
  { kind: "GameObject", abstract: true },
  { kind: "Sprite", parent: "GameObject" },
  ...
];
```

注意 `Player`/`Item`/`Event` 目前**没有任何专有数据**（`components: []`、编辑器里 `creatable: false`），纯靠 kind 归类。

### 1.4 新增一种对象类型需要改的地方（扩展性评估）

共约 11 处，但多数是「注册表加一行」级别的机械修改，且编译期强制（`Record<ObjectKind, ...>` 少键报错）：

1. `document/src/kinds.ts` — kind 定义
2. `document/src/features.ts` — 特性声明
3. `document/src/components.ts` — 若需新组件类型
4. `document/src/factory.ts` / `commands/object.ts` — 工厂
5. `document/src/schema.ts` — zod schema + `DOCUMENT_FORMAT_VERSION` + 迁移
6. `document/src/validation.ts` — 语义校验
7. `apps/editor/src/state/game-object-factory.ts:24` — 编辑器工厂登记
8. `apps/editor/src/panels/object-kinds.ts` — 归类 + 标签
9. `panels/scene/display.ts`、`renderer/src/scene-renderer.ts:217` — 显示规则/配色
10. `protocol/src/messages.ts` — 仅当带新特性组件时（kind 本身是自由字符串，**不用改**）
11. Unity 客户端（`client/`）+ 契约测试自动兜底

### 1.5 渲染侧与序列化

- **renderer 包不构成第二份模型**：`@dts/renderer` 是无状态即时模式 Canvas 2D 渲染器，只认每帧传入的 `SceneLayer[]` DTO（`renderer/src/scene-renderer.ts:37,110`）。编辑器 `ScenePanel.tsx:903` 每帧把 `GameObjectDoc` 经访问器 flatMap 成 `SceneLayer`。
- **序列化**：磁盘为每场景一个 `Assets/scenes/<名>.json`（`SceneFileDoc`，`formatVersion: 24`）；ws 协议为整份推 `scene_push` → 服务端缓存转发 `scene_sync`。命令消息只带 `objectId` 触发信息、**不带数据**（`messages.ts:11-16`）。
- **grid 包与对象无结构关系**：它是 `Map` 对象内部数据的数学工具（格子掩码/RLE 编码/坐标换算/战争雾笔刷），**不是空间索引**——场景拾取是线性扫描（`ScenePanel.tsx:473-485`），全库无 quadtree。

### 1.6 与 CODE-STRUCTURE.md 表述的差异

`docs/CODE-STRUCTURE.md` §0.1 原自称「实体 + 组件（**真 ECS**）」，措辞不准确：这不是 ECS 框架（没有 system、没有按组件类型分储的 world、没有调度循环），而是**Unity 式的 GameObject + Component 模式**——组件的"行为"实际发生在 Unity 前端（C# 组件类，与 `ComponentDoc.type` 一一对应），编辑器/服务端只做数据与校验。**已把该文档措辞改为「Unity 式实体+组件（GameObject + Component）」**（§0.1、§1.6）。

---

## 2. 重复实现排查

### 2.1 真正的重复（按优先级）

**① `@dts/actions` 整个包是死代码（旧模型遗留）— 建议删除**

- `packages/actions/src/{registry.ts, condition.ts, validation.ts}`，约 425 行。
- 全仓库（含 test）**没有任何** `import ... from "@dts/actions"`；唯一引用是 `apps/editor/package.json:14` 一条未被使用的依赖声明。
- 协议注释（`messages.ts:15-16`）写明旧模型（`invoke_action`/`register_*`/`report_*`）已整层删除——actions 包就是那条被删方向剩下的残骸。
- 同源死代码：`document/src/components.ts:21-33` 的 7 种旧组件类型（`OptionValue`/`Backpack`/`ItemExchange`/`MaskImage`/`FloatValue`/`IntValue`/`BoolValue`）和 `schema.ts:165-178` 的 `conditionSchema`/`actionInstanceSchema` 无任何使用方。

**② protocol 与 document 两套完全相同的 zod schema（刻意复刻）**

- `packages/document/src/schema.ts:41-401` 与 `packages/protocol/src/messages.ts:102-401` 是同名字段同形状的两份拷贝；常量也各写一份（`SPRITE_SHEET_MAX`、默认音量等）。
- 这是**有意的**依赖方向妥协（`messages.ts:96-101` 注释明说）：protocol 是最底层包、不能依赖 document，所以复刻一份只读 schema。
- 靠契约测试盯住不漂移：`apps/backend/test/protocol-document-contract.test.ts`（约 240 行）逐字断言两份一致。
- 收敛方案：接受 `protocol → document` 依赖，或把纯类型抽进第三个更底层包，可消掉约 200 行复刻 + 整个契约测试文件。

**③ 模板级近似重复（三对）**

| 对 | 位置 | 重复程度 |
|---|---|---|
| 三个「期望播放状态」记账服务 | `editor/src/services/bgm-playback.ts`(99行) / `sound-playback.ts`(97行) / `video-playback.ts` | 同构拷贝：`emptyXxx`/`withXxxPlaying`/`withXxxPaused`/`withXxxStopped`/`xxxResendPlan`，注释互相引用"同一套" |
| 声音/视频编辑弹框 | `editor/src/app/SoundEditDialog.tsx`(265行) ↔ `VideoEditDialog.tsx`(273行)（+ 近亲 `AudioTagEditorDialog.tsx` 197行） | 相同 Row 接口/`fileNameOf`/交互骨架，Video 版注释自承"照「编辑声音」" |
| 两个画布编辑窗口 + 切片 | `FogMaskDialog.tsx`(462行) ↔ `GridEditDialog.tsx`(459行)；`state/slices/fog-slice.ts`(224行) ↔ `grid-paint-slice.ts`(150行) | 窗口骨架相同（canvas state/贴图铺底/坐标换算/笔画批处理），绘制对象不同 |

**④ 小额重复**

- localStorage 偏好读写两份：`services/editor-prefs.ts`(86行) / `grid-paint-prefs.ts`(116行)，后者注释自承"同一套写法"。
- 资源 provider 双实现里的重复校验：`packages/resources/src/memory.ts:147-167` 与 `backend/src/resources/fs-provider.ts:166-204` 手写同一组错误消息。
- 测试里两份相同 FakeWebSocket：`editor/test/bgm-settings.test.ts:36-65` / `run-mode.test.ts:52-84`。

### 2.2 用户怀疑但**不成立**的几对（澄清）

- **后端 ws handler 没有复制场景/对象操作逻辑**：`ws/handlers/editor.ts:62-76` 的 `scene_push` 只做「缓存 + 转发」；对象操作只有一份，在 `packages/document/src/commands/`。
- **mock-client 不是复制的客户端逻辑**：`backend/src/mock-client/index.ts:13-24` 自述是假 Unity 客户端开发工具（连接重试/打印场景镜像/回 command_result），192 行无业务逻辑。
- **没有两套场景状态**：editor 的 `state/slices/*` 是薄封装——校验/日志/撤销 → 委托 `@dts/document` 命令改 immer draft。单一数据源在 document。
- **坐标换算只有一套**：世界/网格换算只在 `packages/grid`；屏幕换算只在 `renderer/src/viewport.ts`。`panels/scene/transform.ts:6-12` 甚至 re-export 并注释「两处各写一遍 atan2 迟早会因为参数顺序不同而反号」——作者有自觉。
- **id 生成只有一份**（`document/src/commands/shared.ts:35`）；EventEmitter/深拷贝无重复实现。

### 2.3 文件为什么多

src 共 **162 个 .ts/.tsx、约 3.6 万行**；测试 97 个。主因**不是重复造轮子**：

| 成因 | 证据 | 数量 |
|---|---|---|
| 巨型 store 拆分 | `editor/src/state/`：16 个 slice，每个文件头写「从 editor-store.ts 拆出（纯搬运）」 | 22 个文件 |
| 每特性一条竖切 | 每特性 ≈ slice + service + Dialog + inspector `*Fields.tsx` + e2e + 单测，1:1 机械映射 | app/ 下 16 个 Dialog、inspector 6 个 `*Fields.tsx` |
| 命令层按节拆分 | `document/src/commands/index.ts:1-5`：原 1985 行 `commands.ts` 按分节标题拆分 | 8 个文件 |
| 测试与功能近 1:1 | 97 个测试文件 vs 162 个 src 文件 | — |
| 死代码 | `@dts/actions` 整包 + 7 种旧组件类型 + condition/action schema | 500+ 行 |

---

## 3. 总体结论与建议

**架构纪律整体良好**：单一数据源（document 包）、访问器收口（禁 `components.find`）、特性路由唯一归属地、注释里到处是「只有这一份」的自觉。文件膨胀来自竖切式架构与拆文件策略，属可维护性取舍而非失控。

按收益排序的改进清单：

1. **删除 `@dts/actions` 死包**（及 editor package.json 里的依赖声明），连带清理 document 中无人消费的 7 种旧组件类型与 condition/action schema。零风险、纯收益。
2. **收敛 protocol schema 复刻**：调整依赖方向或抽公共类型包，消掉约 200 行复刻 + 240 行契约测试。
3. **合并三对模板**（playback×3、Sound/Video 弹框、Fog/Grid 窗口+切片）：可抽公共骨架，但收益小于前两项，优先级低。
4. **修正 `CODE-STRUCTURE.md` §0.1 的「真 ECS」措辞**为「Unity 式实体+组件（GameObject + Component）」。（已完成）
5. 顺手项：合并两份 FakeWebSocket 测试夹具、抽公共 localStorage 偏好读写。
