# 方案：单一数据源与 codegen（把「一份形状」从 4 份收到 1 份）

> 起因：「每改一个需求要半天」。本方案只治**机械税**（同一份事实被手抄多份），不治业务本身。
> 相关文档：`docs/BASELINE-加一个组件要碰哪些文件.md`（触点实测）、`docs/AUDIT-后端代码审核报告-2026-09-26.md`（B5 schema 漂移）、
> `docs/CODE-STRUCTURE.md`（现行结构）。
>
> 状态：**阶段 1 执行中**。执行进度见文末「执行记录」。

---

## 1. 问题：同一份事实有几份手抄

| # | 副本 | 位置 | 内容 | 消费者 |
|---|---|---|---|---|
| 1 | **源**（模型） | `packages/document/src/{types.ts, schema.ts, components.ts, presets.ts}` | 组件名、字段、默认值、zod 约束、迁移 | document / editor / backend |
| 2 | **wire 复刻** | `packages/protocol/src/messages.ts`（787 行） | `COMPONENT_TYPE`（9）、9 个 data schema、`commandRequestSchema`（18 条命令） | editor / backend |
| 3 | **e2e 复刻** | `e2e/helpers/editor.ts` | `COMPONENT`（9 个键）、`FOG_DEFAULT_SORTING_ORDER` | Playwright |
| 4 | **C# 镜像** | `client/.../Network/Protocol.cs`、`Data/SceneModel.cs`、`Data/SceneParser.cs` | `ComponentType`（9 个别名）、18 个 `Command*` 常量、镜像字段 + 解析行 | Unity |

保险丝：#1↔#2 的一致性由 `apps/backend/test/protocol-document-contract.test.ts`（303 行）盯住——
**它存在本身就说明这两份会漂**：2026-09-26 审计的 B5 已经漂过一次（`rleRunSchema` 收负掩码、`mapFogSchema.regions` 缺默认值）。

**结论：一个组件名要改 4 处，一条命令名要改 2 处，一个字段要改 2 份 schema（+ 可能 1 份 C# 镜像）。**

---

## 2. 目标 / 非目标

**目标**

- 加一个**组件**：C# / e2e 的手改 = 0。
- 加一条**命令**：C# 的手改 = 0。
- 加一个**字段**：protocol 与 document 的字段名 / 默认值不一致时，`pnpm check` 直接失败（而不是靠 303 行抽样测试）。
- 保留既有硬约束：**既有测试零改动**；`PROTOCOL_VERSION` / `DOCUMENT_FORMAT_VERSION` 不因本方案变更。

**非目标**

- 不用 `component-specs` 派生 zod schema（`BASELINE` §#1 已论证：6 个组件没一个「描述符完全可表达」）。
- 不改后端「一条协议 / 一条消息一个函数」的路由分发（审计已确认）。
- 不为减行数而减测试。
- 不在本方案内抬协议 / 文档版本。

---

## 3. 三条路线对比

| | A. `protocol → document` | B. 中性契约包 `@dts/contract` | C. codegen（**选定**） |
|---|---|---|---|
| 做法 | protocol 直接复用 document 的 schema，删复刻 | 新建最底层包放纯形状，两边依赖它 | 维护生成器，从源产出 3/4 号副本 |
| 消除 | #2 全部 | #2 大部分 | #3、#4（并可用清单覆盖 #2） |
| 跨语言（C#） | ❌ | ❌ | ✅ **唯一能帮 C#** |
| 工作量 | 0.5 天 | 2–3 天 | 阶段化：1 → 3 → 5 天 |
| 风险 | 中高：wire 校验会继承 disk 默认值 / refine（B5 漂移的成因）；protocol 被迫拖上 immer + 迁移链；「最底层包」破功 | 中：搬 schema、改 3 个包，收益仍只在 TS 内 | 低→中：生成物入库 + 一个 check 脚本 |
| 结论 | 只作「一晚止血」 | 阶段 3 备选 | **主路线** |

判断依据：痛点横跨 C#，而 **C# 那一趟（编译 + 无 asmdef 测试）才是半天里最贵的一段**；A/B 都省不掉它。

---

## 4. 分阶段路线

### 阶段 1：常量 codegen（本阶段，零逻辑风险）

**唯一来源**

- 组件类型：`packages/document/src/components.ts` 的 `COMPONENT_TYPES`（9 条，`type` 字段）。
- 命令种类：`packages/protocol/src/messages.ts` 的 `commandRequestSchema`（18 条，`discriminatedUnion` → 运行时用 `.options[].shape.kind.value` 取，**不新增手写清单**）。

**生成物**

| 生成物 | 内容 | 说明 |
|---|---|---|
| `e2e/helpers/generated/contract.ts` | `COMPONENT`（键 = 类型名首字母小写：`gridMap` …） | 取代 `e2e/helpers/editor.ts` 里的手写块 |
| `client/Assets/DiceTale/Scripts/Generated/GeneratedContract.g.cs` | `Protocol.ComponentType.*`（9）+ `Protocol.Command*`（18） | 以 `partial` 拆分，**不新增 / 不重命名任何 C# 引用点** |

**C# 别名表（生成器里唯一手工表）**

C# 的常量名与组件类型名不同名，必须有一张对照表；它是本方案新增的**唯一**手写事实源，写进生成器顶部：

```
GridMap → Map      FogOfWar → FogOfWar   ImageLayer → Image    SpriteLayer → Sprite
PlaySound → Sound  Teleport → Teleport   Magnifier → Magnifier
VideoOverlay → Video  VideoBlend → VideoBlend
```

命令常量名 = `Command` + `PascalCase(kind)`，与现有 18 个完全一致（`play_sound` → `CommandPlaySound` …）。

**边界（不做的事）**

- 不生成 protocol 的 schema / `COMPONENT_TYPE`（那要动 wire 语义，留给阶段 3）。
- 不生成 C# 的 `MirrorXxx` / `SceneParser` 解析行（C# 已有泛型读取，留给阶段 4 再评估）。

**CI**

- `pnpm gen:contract`：写生成物。
- `pnpm check:contract`：重新生成并与磁盘逐字比对，不一致退出 1（仿 `scripts/check-code-structure-stats.mjs` 的风格）。
- `pnpm check` 末尾追加 `check:contract`。

**验收**

| 标准 | 目标 |
|---|---|
| 生成物可用 | `pnpm typecheck` / `pnpm test` 全绿 |
| 一致性 | 手改生成物 → `pnpm check:contract` 立即失败 |
| 既有测试零改动 | `git status` 不含既有测试文件 |
| C# 编译 | Unity 控制台 0 error（本环境经 Unity MCP 验证；不可用时如实标注待验） |
| 加一个组件 | e2e / C# 手改 = 0（改完源跑一次 `gen:contract` 即可） |

### 阶段 2：穷举结构一致性检查（✅ 已完成，2026-09-29）

- **不新增手写清单**：改用 `z.toJSONSchema`（zod 4）把两套复刻 schema 摊平成 JSON Schema，
  在 `check:contract` 里**逐路径比对**（字段名 / 可选性 / 默认值 / 约束全都在 JSON Schema 里）。
  ——原计划的 `contract/fields.ts` 清单因此**不需要了**：清单本身就是 schema，第二份清单反而会再漂。
- **有意的差异**写进两张小表（各 1 项）：文档专有 `guid`（磁盘身份，推送时剥掉）、
  载荷专有 `spriteGrid`（推送时解析出来，落盘不写）；比对时各自剥掉。
- 覆盖 9 组：GridMap / FogOfWar / ImageLayer·SpriteLayer / PlaySound / Teleport / Magnifier /
  Magnifier 状态 / VideoOverlay / VideoBlend。
- 效果：B5 那类「约束/默认值漂移」现在由 `pnpm check` 明确报出**具体路径**
  （实测：把协议侧 `layer` 默认值改成 `voice`，`check:contract` 立刻报 `[PlaySound] properties.layer.default: doc="sfx" proto="voice"`）。

### 阶段 3：删掉 #2 复刻（待决策）

- 走 B（中性契约包）或 A（依赖方向），二选一；阶段 2 的清单即现成 schema 骨架。
- 这一阶段才动 schema 语义，需要单独拍板。

### 阶段 4：C# DTO / 解析 codegen（条件触发）

- 前置：阶段 1–3 完成后，实测「新字段是否真能全靠泛型读取（`ComponentBool/String/Number`）」。能，则本阶段取消。

---

## 5. 阶段 1 执行清单（按序）

| # | 步骤 | 产物 | 状态 |
|---|---|---|---|
| 1 | 新增生成器 `scripts/gen-contract.ts` | 生成器 | ☑ |
| 2 | 生成 e2e 契约常量，替换 `e2e/helpers/editor.ts` 手写块 | `e2e/helpers/generated/contract.ts` + 改 `editor.ts` | ☑ |
| 3 | 生成 C# 契约常量（`partial Protocol` / `partial Protocol.ComponentType`） | `GeneratedContract.g.cs` + `Protocol.cs` 改 `partial` | ☑ |
| 4 | 加 `gen:contract` / `check:contract` 脚本并挂进 `check` | `package.json` | ☑ |
| 5 | 跑 `pnpm check`（typecheck + test + lint + docs + contract） | — | ☑ |
| 6 | Unity 编译验证（Unity MCP；不可用则标注待验） | — | ☑（见执行记录） |
| 7 | 更新 `CODE-STRUCTURE.md`（新增文件登记） | 文档 | ☑ |

---

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 生成物与源脱节（有人手改生成物） | `check:contract` 进 `pnpm check` |
| C# `partial` 嵌套类不被 Unity 接受 | 退化为「`Protocol.cs` 里常量指向生成类的值」；最坏直接回滚 C# 那一步（TS 侧独立可用） |
| 生成器依赖 tsx / Node 版本 | 生成器只读 TS 源（经 tsx 转译），不引入新依赖；CI 与本地同命令 |
| 误改既有 C# 引用 | 别名表保证常量名不变；`git diff` 只应看到 `partial` 关键字与整块常量的删除 |

**回滚**：本方案全部是新增文件 + 局部替换，`git revert` 对应提交即可；不改协议 / 文档版本，无迁移。

---

## 7. 明确不做

1. 不用 `component-specs` 派生 zod；
2. 不一次全做（阶段 1 即可独立交付）；
3. 不缺测试换行数；
4. 不动后端路由 / `StoreContext`。

---

## 8. 执行记录

### 阶段 1（2026-09-28）

- 新增 `scripts/gen-contract.ts`：读 `@dts/document` 的 `COMPONENT_TYPES` 与 `@dts/protocol` 的 `commandRequestSchema`（`.options`），产出两份生成物；`--check` 模式只比对不写。
- 新增 `e2e/helpers/generated/contract.ts`（`COMPONENT` / `COMMAND`）；`e2e/helpers/editor.ts` 改为 re-export 生成物，删掉手写块。
- 新增 `client/Assets/DiceTale/Scripts/Generated/GeneratedContract.g.cs`；`Protocol.cs` 改为 `static partial class Protocol`，`ComponentType` 改为 `static partial class ComponentType`，删掉手写常量。
- `package.json`：加 `gen:contract` / `check:contract`，`check` 挂上 `check:contract`。
- 验证：见下方「本轮验证」。

### 本轮验证

| 项 | 结果 |
|---|---|
| `pnpm check:contract` | ✅ 一致：组件 9 种 / 命令 18 条；**守卫实测**：手改生成物后立即失败（exit 1），`gen:contract` 可还原 |
| `pnpm typecheck`（含 e2e） | ✅ 8 包 + e2e 全过 |
| `pnpm test` | ⚠️ **1343 passed / 2 failed**——两条都是 `project-api.test.ts` 的「视频缩略图 ffmpeg 抽帧」，**本机 `ffmpeg` 不在 PATH**（环境问题，与本改动无关） |
| `pnpm lint` | ✅ exit 0 |
| `pnpm check:docs` | ✅ 一致（E2E 行数随之从 9,929 → 9,915，已同步文档） |
| Unity 编译（MCP） | ✅ 控制台 **0 error / 0 warning**；新文件已导入（生成 `GeneratedContract.g.cs.meta`） |
| 既有测试零改动 | ✅ 未改任何既有测试文件 |

**比文档多做的一点（都是同一类「复述」）**：`CURRENT_SCENE_FORMAT_VERSION`（每次抬格式版本都要手改 e2e）与 `FOG_DEFAULT_SORTING_ORDER` 也一并改成生成；C# 侧 `Protocol.ComponentType`（9）与 `Protocol.Command*`（18）全部改为生成。

**诚实记录两处代价 / 偏差**：

1. **C# 成员级 XML 文档收拢了**：原来 `Protocol.cs` 里每个组件 / 命令常量都带 `/// <summary>`（含版本历史），改成生成后，成员级文档改由生成器从 `COMPONENT_TYPES` 的 `displayName` / `tooltip` 产出；更长的历史说明以 `//` 注释块留在 `Protocol.cs` 指向生成文件。**知识没丢，但不再挂在成员上**（IDE 悬浮文本会短一些）。
2. **C# 别名表进了生成器**：`Map` / `Image` / `Video` … 与组件类型名不同名，所以生成器里保留一张 9 行的对照表——这是本阶段**唯一**新增的手工表；加组件时若沿用默认名（类型名本身）则连这张表都不用改。

### 阶段 2（2026-09-29）：复刻 schema 的穷举结构一致性

- `scripts/gen-contract.ts` 增加结构比对段：用 `z.toJSONSchema` 把两套复刻 schema 摊平后**逐路径比较**，
  剔除两张有意差异表（文档专有 `guid`、载荷专有 `spriteGrid`）；在 `check:contract` 里跑，失败报**具体 JSON 路径**。
- 复刻 schema 从「抽样断言」升级为「9 组结构穷举」；原计划的 `contract/fields.ts` 手写清单**取消**
  （清单本身会再漂，直接以 schema 为源）。
- 验证：`pnpm check:contract` / `lint` / `check:docs` / `typecheck:e2e` 全过。
- **漂移实测**：把协议侧 `soundDataSchema.layer` 的默认值改成 `voice` → `check:contract` 立即报
  `[PlaySound] properties.layer.default: doc="sfx" proto="voice"`；改回即恢复。

### 尚未做

- 阶段 3（删掉 protocol 复刻，走 `@dts/contract` 或 `protocol→document`）：动 schema 语义，待单独拍板。
- 阶段 4（C# DTO / 解析 codegen）：前置是实测「新字段能否全靠泛型读取」，未评估。
