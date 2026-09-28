# 方案：降低改动面（去枚举化 + 生成 + 版本归零）

> 目标：让「改一个需求」触碰的**既有文件**尽量少——理想是**加一个字段 = 1 处**、**加一个组件 = 1 处注册 + 行为**。
> 相关：`docs/BASELINE-加一个组件要碰哪些文件.md`（触点实测）、`docs/PLAN-单一数据源与codegen.md`（常量生成 / 契约守卫 / 阶段 3 评估）、
> `docs/CODE-STRUCTURE.md`（现行结构）。本方案是更上位的那一层：**收「枚举型依赖」**。

---

## 0. 一句话

**组件是 hub 没错，访问器也把「查询」收口了；贵的是「有哪些组件」这张清单被抄到了太多地方——抄的每一处，加一个组件就要改一行。**
所以本方案只做三件事：

1. **去枚举化**：把能变成「按 `type` / `slot` 查」的依赖改成查询型；
2. **生成兜底**：剩下真正枚举不了的那几处，机器写（阶段 1 已起步）；
3. **版本归零**：砍掉每需求抬双版本 + 迁移的仪式。

---

## 1. 问题：两种成本要分开看

| 成本 | 含义 | 例子 |
|---|---|---|
| **fan-out（改动广度）** | 一次改动碰到 N 个文件 | 「加一个组件要改约 30 个文件」 |
| **fan-in（依赖广度）** | N 个文件依赖「组件」这个概念 | 「很多文件都依赖组件」 |

fan-in 本身**不是罪**：hub 越稳越好。真正决定成本的是 fan-in 里**枚举型**的那部分：

| 依赖方式 | 是否知道「有哪些组件」 | 加一个组件时 |
|---|---|---|
| **查询型（数据驱动）** | ❌ 只知道「有组件」 | ✅ **不用改** |
| **枚举型（登记型）** | ✅ 列举了清单 | ❌ **每处补一行** |

**结论：改动面 ≈ 枚举型依赖的处数。** 降本 = 把枚举型改成查询型，剩下的用生成。

---

## 2. 证据（实测）

- 加一个组件 ≈ **30 个文件**（+2 文档）、约 2,100 行，其中**纯注册只有约 25 行、却散在 9 个文件**（BASELINE）；
- 加一个布尔：改造前 **19 个文件**（只有 2 个含真实逻辑）→ 阶段 A 后 **7 个**（BASELINE 附录）；
- 一次改动规模（近 20 次提交）：**14–42 个文件**；
- 组件相关的 TS 引用约 **319 处**、C# 约 **28 处**；按上表分类后，其中**查询型占多数、枚举型是少数**——
  但那少数正是「加组件要改的地方」。

## 3. 现状清单：组件 hub 的依赖点分类

### 3.1 查询型（加组件**不用**改，已收口）

`componentOf` / `componentOfSlot` / `componentDataOf` / `componentDataOfSlot` / `findComponentType` /
`isKnownComponentType` / `carriesComponent` / `supportsObjectComponent` / `setComponentField` /
`ensureSlotData` / `writeFeature` / `removeFeature` / `defaultDataOf`；
C# 的 `HasComponent` / `ComponentData` / `ComponentBool` / `ComponentString` / `ComponentNumber` /
`ComponentObject` / `ComponentArray`。

> 这是现有设计最值钱的部分：**大多数文件已经只依赖「组件」这个概念，不依赖清单。**

### 3.2 枚举型（加组件要改一行 / 一个文件）

| 位置 | 要加什么 | 能否去枚举化 |
|---|---|---|
| `packages/document/src/components.ts` | `ComponentType` 联合 + `COMPONENT_TYPES` 条目 | **天然保留 1 处**（唯一枚举地） |
| `packages/document/src/presets.ts` | `DEFAULT_SLOT_COMPONENT` 一行 + `OBJECT_PRESETS[*].slots` | ⚠️ 可让「缺省承载」从组件注册表派生（组件自报槽位），减少一处手工清单 |
| `packages/document/src/schema.ts` | `sceneComponentSchema` 分支（+ 少数迁移分支） | ⚠️ 可从唯一 schema 派生 |
| `packages/document/src/access.ts` | 能力组件的 `xxxOf` / `ensureXxxData` | ⚠️ 已有泛型 `ensureSlotData`，可继续收 |
| `packages/document/src/validation.ts` | 每条特性的语义校验 | ❌ 多为**行为**（规则本身） |
| `packages/document/src/factory.ts` | 创建工厂 / 默认数据 | ⚠️ 默认数据已在 `component-specs`，可派生 |
| `packages/document/src/commands/<特性>.ts` | 新写命令文件 | ❌ **行为**（除非只走泛型 `setComponentField`） |
| `packages/document/src/scene-asset-refs.ts` | 资源引用收集 | ⚠️ 可数据驱动（组件自报是否引用素材） |
| `packages/protocol/src/messages.ts` | 组件名（**已生成**）、data schema、`sceneComponentSchema` 分支 | ⚠️ 承接「单一数据源」阶段 3 |
| `apps/editor/src/panels/inspector/registry.tsx` | 面板组一行 | ✅ **简单字段已自动**（`DescriptorRows`）；只有自定义交互才要一行 |
| `apps/editor/src/panels/object-kinds.ts` | kind → 归类 / 标签 | ⚠️ 可从预设表派生 |
| `apps/editor/src/state/*` | slice / `store-types` / `store-context` | ✅ 简单字段已泛型（`setComponentField`）；只有运行态命令才要 |
| `client/.../Protocol.cs` | `ComponentType`（**已生成**） | ✅ 已生成 |
| `client/.../SceneParser.cs` | `case` 解析 | ✅ 新组件走**泛型读取器**，通常不用加 |
| `client/...`（行为） | MonoBehaviour / 窗口 | ❌ **行为**，收不掉 |

**规律：能变查询型的都是「登记」；收不掉的全是「行为」。**

---

## 4. 目标态（Definition of Done）

1. **组件清单只在 1 处枚举**：`components.ts` 的注册表（其余全部按 `type` / `slot` 查，或生成）；
2. **登记处数**：加一个组件时，「纯注册」从 **15 处 / 9 文件** → **≤3 处 / ≤2 文件**；
3. **加一个字段**：从 5–7 个文件 → **1 处**（唯一 schema）+ 行为；
4. **版本仪式归零**：加字段 / 加可选组件**不再**抬 `DOCUMENT_FORMAT_VERSION` / `PROTOCOL_VERSION`，不再写迁移；
5. **可测量**：下面第 6 节的基线数字全部下降，且**既有测试零改动**通过。

---

## 5. 阶段划分（低风险优先）

### 阶段 0（✅ 已完成，见 `PLAN-单一数据源与codegen.md`）

- 组件名 / 命令名 / e2e 常量 / C# 常量 → **生成**；
- `check:contract`：9 组复刻 schema 结构比对 + refine 探针。

### 阶段 1：合并「槽位 / 缺省承载」登记（❌ 核查后不做）

**核查结论：收益接近零。** `DEFAULT_SLOT_COMPONENT`（槽位→缺省组件）与 `COMPONENT_TYPES.slot`
（组件自报槽位）**不是同一件事**：`image` 槽位有两个组件（`ImageLayer` / `SpriteLayer`），
谁当缺省无法从自报推导——「合并」等于新增一个 `defaultForSlot` 标记，**信息量不变、只是搬家**；
`OBJECT_PRESETS.slots`（kind 允许哪些槽位）更是另一回事。**这不叫重复，叫不同关注点。**

### 阶段 2：schema 单源（✅ 已完成，2026-09-29）

- 新增中性包 **`@dts/contract`**（只有 zod）：**共享数据形状与常量的唯一来源**；
- `document` 从「基类 + `guid`」派生磁盘变体，`protocol` 从「基类 + `spriteGrid`」派生 wire 变体——
  **一个字段只写一遍**，差异只有这两处；
- 图片引用被嵌在「图片层 / 放大镜状态 / 放大镜数据」里，所以 contract 提供三处**参数化构造器**
  （`imageLayerDataSchemaWith` / `magnifierStateSchemaWith` / `magnifierDataSchemaWith`），两边各传自己的图片引用变体；
- 常量（层级 / 视频开关 / 雾缺省显示顺序 / 三档音量 / 图集上限 / 动画预设）也搬进 contract，
  `types.ts` / `presets.ts` / `sprites.ts` / `schema.ts` 转出口（既有 `from "@dts/document"` 用法不变）；
- 架构测试：`contract` 进 `PURE_PACKAGES`；`ALLOWED` 改为 `protocol: ["contract"]`、`document: ["grid","contract"]`。
- **验收**：`pnpm check:contract` 保持绿（9 组结构逐路径一致 + refine 探针）、`typecheck` 全过、
  单测 1343 passed（2 条 ffmpeg 环境用例无关）、`lint` / `check:docs` 绿、编辑器构建通过、桌面冒烟 E2E 通过。

> 这一阶段之后，`PLAN-单一数据源与codegen` 的「阶段 3（收集 protocol 复刻）」**不再需要**——
> 没有复刻可收了。

### 阶段 3：编辑器「归类 / 面板」数据驱动（❌ 核查后不做）

**核查结论：不该合并。** `object-kinds.ts` 是**编辑器侧的 UI 归类**（种类 / 标签 / 可创建 /
瓦片 id / `withGrid`），与文档注册表是**不同关注点**；硬合并会把 UI 概念塞进文档包。
「简单字段自动出行」已经由 `component-specs` + `DescriptorRows` 做掉了，这条不再需要。

### 阶段 4：版本 / 迁移仪式归零（✅ 已完成，2026-09-29）

- 新增 `docs/SPEC-版本与迁移判据.md`：把「什么时候抬 `DOCUMENT_FORMAT_VERSION` / `PROTOCOL_VERSION`」
  写成一条可执行判据——**唯一理由是「旧读者会把新数据读错」**；纯新增（可选字段 + 默认值、
  新组件、老前端会忽略的消息）**不抬**。
- 在两个版本号旁边加了指路注释（`types.ts` / `messages.ts`）。
- 本阶段**不改任何版本号、无迁移、无行为变化**——它约束的是**以后**。

### 阶段 5（可选）：新建特性脚手架

- `pnpm new:component <名>` 生成竖切骨架（spec / slice 占位 / 面板组 / e2e 占位 / C# 空实现）。
- 目标：不是「少打字」，而是**不用记住那 40 个位置**——从可跑的竖切起步。

---

## 6. 验收指标（可复测）

复测方法照 BASELINE 第 7 节（选名字唯一的探针组件，按包 grep，逐处阅读）。

| 指标 | 现在 | 阶段 1–4 目标 |
|---|---|---|
| 加一个**组件**：触碰文件 | ~30 | ~24（行为占大头） |
| 其中**纯注册**处数 / 文件数 | 15 处 / 9 文件 | **≤3 处 / ≤2 文件** |
| 加一个**字段**：触碰文件 | 5–7 | **1（schema）+ 行为** |
| 加一个**字段**：抬版本 | 两个版本号 | **不抬** |
| 需要记住的清单长度 | ~40 位置 | **~20 → ~8** |

> 行数几乎不会降（行为代码是主体）；降的是**清单长度**与**语言 / 包切换次数**——那才是「半天」的来源。

---

## 7. 明确不做

1. **不收行为代码**：校验规则、命令语义、Unity 表现、面板交互——这些是功能本身；
2. **不为了减依赖而拆 hub**：访问器收口是对的，拆散只会把查询型也变成枚举型；
3. **不一次全做**：每阶段独立可交付、独立回滚；
4. **不缺测试换速度**：既有测试零改动是每阶段的硬约束。

---

## 8. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `BASELINE-加一个组件要碰哪些文件.md` | 提供本方案的**起点数字**与复测方法 |
| `PLAN-单一数据源与codegen.md` | 它的**阶段 0** 是本方案的已完成部分；它的**阶段 3**（收 schema 复刻）并入本方案阶段 2 |
| `AUDIT-后端代码审核报告-2026-09-26.md` | 提供「同一事实两处实现」的具体条目（S5/S6/S8 等），多数正是本方案要收的枚举点 |
| `CODE-STRUCTURE.md` | 改完同步其依赖表 / 图与 §0 计数（`check:docs` 会盯） |

---

## 9. 诚实结论

- 这套东西的最大收益**不是**「少写代码」，而是**「加新东西时不用记住那么多地方」**；
- 收益集中在**小改动频繁**的场景（加字段、加开关、加可选组件）；**大改动（新交互 / 新表现）收益有限**，因为主体是行为；
- 若只能做一件：**阶段 2（schema 单源）** 收益最高——它一次消掉「同一形状 4 种表示」里最贵的那几处。
