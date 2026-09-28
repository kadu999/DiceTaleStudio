# 对象类型（`kind`）：现状速查

> **定位**：一页速查——`kind` 是什么、和「组件 / 槽位」什么关系、什么时候该用谁。
> - **决策历史与逐组件退役结论**（权威，议程已冻结）：[`PLAN-组件驱动与kind退役.md`](PLAN-组件驱动与kind退役.md)
> - **现行结构**：[`CODE-STRUCTURE.md`](CODE-STRUCTURE.md) §3.2
> - 本页**不重复**这两处，只把散落的判据收成一页。

## 0. 一句话

`kind` = 对象的**预设 id / 创建原型**：只说明「当初按哪种模板建的」，**不决定行为**。
行为全在 `components`；`kind` 管的是**身份 + 关于组件的规则**。

## 1. 四个词，别混

| 词 | 类型 | 回答的问题 | 例 |
|---|---|---|---|
| `kind` | `ObjectKind`（10 种，含 1 个抽象基类） | 这个对象**是哪种原型** | `Sprite` / `Image` / `Fog` / `PlaySound` |
| `component.type` | `ComponentType`（9 种） | 这块**能力是什么** | `ImageLayer` / `SpriteLayer` / `GridMap` / `FogOfWar` |
| `ComponentSlot` | — | 这个能力**归哪一类** | `image` / `map` / `fog` / `sound` |
| 组件实例 | `ComponentDoc` | 对象**实际挂了什么** | `{ id, type: "ImageLayer", data: {…} }` |

> ⚠️ `kind` 一词在本仓至少 4 义：对象 kind、命令判别式（`command.kind === "play_sound"`）、
> 视频每路（`kind: "image" | "video"`）、素材 kind（`"image" | "audio" | "video"`）。
> grep 前先分清是哪一个——§6 的架构约束正是用「**首字母大写 = 对象 kind**」把前两者分开的。

## 2. `kind` 现在扛的 4 个角色

1. **抽象基类标记**：`GameObject`（`abstract: true`，**永不落盘**；手写文件里出现的会被 `LEGACY_KINDS` 规范成 `Sprite`）。
2. **持久化类型 id**：磁盘是 `z.enum(OBJECT_KINDS)`（枚举）；wire 是**自由字符串**（`kind: z.string()`，所以**加一种对象类型不动协议**）。
3. **能力准入 / 修复许可**：见 §4 的「两张半表」。
4. **归类 / 标签 / 创建 / 占位色**：编辑器 `object-kinds.ts`（类别 / 标签 / `creatable` / `withGrid`）、`state/game-object-factory.ts`、C# `SceneObjectView.KindColor`。

## 3. 唯一判据：组件在 → 用组件；组件不在 → 用 kind

| 时刻 | 组件在？ | 判据 | 例 |
|---|---|---|---|
| 读 / 渲染 / 命令路由 / 互斥 | ✅ 在 | **组件**（含 slot） | `componentOfSlot`；wire `components[].type` 分派；`EXCLUSIVE_SLOTS`（视频 ⊥ 视频混合） |
| 准入「能不能加 / 补」 | ❌ 不在 | **kind** | `optionalKinds` / `repairKinds` |
| 创建（`components: []`） | ❌ 不在 | **kind** | `OBJECT_PRESETS` + `GAME_OBJECT_FACTORIES` |
| 历史迁移（老文件无组件） | ❌ 不在 | **kind** | `componentForSlot("image", kind)` |
| 语义分类（组件等价时） | — | **kind** | 只有 kind 能区分 |

> 一句话：**运行 / 编辑已有组件时一律按组件**（`access.ts` 注释原文「按 slot 找……**不看 kind**」）；
> **只有「组件不在」的时刻才回落到 kind**。这与 `PLAN-组件驱动与kind退役.md` 阶段 2 / 3 的口径一致。

## 4. 「两张半表」：准入被劈成两个方向

| 方向 | 在哪 | 内容 |
|---|---|---|
| 正向 | `packages/document/src/presets.ts` 的 `OBJECT_PRESETS[kind].slots` | kind → 槽位 → 承载组件 |
| 反向 | `packages/document/src/components.ts` 的 `templateKinds` / `repairKinds` / `optionalKinds` | 组件 → kind（创建模板 / 缺失修复 / 可选准入） |

两者是**同一事实的两个方向**；`componentKindMismatchOf()` 做交叉校验，`presets.test.ts` 逐条断言一致。

> **已知结构债**：加一个组件 / kind 要同时改这两处。收敛方向见 §7（暂不做）。

## 5. 哪些 kind 不能被组件替代

- `Sprite` vs `Image`：**缺图片组件**时该给 `SpriteLayer` 还是 `ImageLayer`，组件判不了；
- `Fog` / `PlaySound` / `Teleport` / `Magnifier`：独立对象 / 动作对象，**创建与「缺失修复」**要 kind；
- `Image` / `Player` / `Item` / `Event`：**组件完全等价**（都只挂 `ImageLayer`），只有 kind 能区分（名字 / 占位色 / 归类）；
- 创建起点（`components: []`）与历史迁移锚点。

> 反过来说：`Player` / `Item` / `Event` 是**纯语义标签**（`creatable: false`、组件无差别）——
> 若产品不需要它们，这是唯一可以考虑合并 / 砍掉的 kind 组（属**产品决策**，不是重构）。

## 6. 纪律（机器强制）

- 调用处**不写** `kind === "Sprite"` 判行为：走 `componentOfSlot` / `supportsX` / `presetOf`。
- `test/architecture.test.ts` 有**可搜索约束**：`BEHAVIOR_BRANCH = /\.kind\s*={2,3}\s*["'][A-Z]/`，
  唯一例外是 `schema.ts`（历史迁移），命中即失败；并有反向断言「例外确实还在」。
- 组件准入表里的 kind 值已是 **`ObjectKind[]`**（编译期受控——写错 / 改名 TS 当场报）。

### 改动面（机械清单）

- **加一种对象类型（kind）**：`OBJECT_KINDS` + `OBJECT_PRESETS`（document）＋（若带新能力）`components.ts` 的 `*Kinds`
  ＋编辑器 `GAME_OBJECT_FACTORIES` + `KIND_LABELS` + `OBJECT_CATEGORIES`（＋ C# `KindColor` 若要占位色）。
- **加一个组件**：`components.ts` + `OBJECT_PRESETS` 对应槽位 + 编辑器组件规格 / 注册表 + C# 读取器。
  实测数字见 [`BASELINE-加一个组件要碰哪些文件.md`](BASELINE-加一个组件要碰哪些文件.md)。

## 7. 遗留值 / 退役状态 / backlog

- **历史 kind 值**（`Texture` / `SceneObject` / `GameObject` / `Map`）只由 `LEGACY_KINDS` + schema 迁移识别；
  `schema.ts` 里另有一处裸 `"Map"`（同样是历史迁移职责）。
- **退役状态：冻结**。逐组件决策与「为什么不能整体删」见 `PLAN-组件驱动与kind退役.md` 阶段 4；
  `kind` 字段保留、文档格式版本不动。
- **backlog（暂无触发条件）**：**准入单向化**——以组件表为准反演 `OBJECT_PRESETS[*].slots`，删掉 `componentKindMismatchOf` 对账。
  收益（加组件少写一处）≤ 代价（动核心注册表 + 迁移 + 一片测试），故不做。
