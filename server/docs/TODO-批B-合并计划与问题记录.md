# 批 B：重复代码合并计划与问题记录

> 状态：**批 B 进行中**（2025-06 记录；2026-01 复验处置台账 #1，#7/#8/#10 已收官，剩 #9）。批 A（死代码清除 + 低中风险合并，净减约 1900 行）已完成并提交（`ed8d34b`，其上为架构统一 `128714a`）。
> 本文档两项用途：① 批 B 的执行清单与风险注记；② 具体问题台账（每条带现象/位置/处置建议，执行批 B 时新发现的追加到第二节）。
> 做完一项就把状态打勾并补实际净减行数。

## 第一节：批 B 任务清单

预估合计 40–60 分钟（含逐步跑测试验证），净减约 300–350 行。建议拆两趟：先做 #7/#8/#10（低风险，~30 分钟），#9 单独一趟。

| # | 状态 | 任务 | 位置 | 净减 | 风险与注记 |
|---|---|---|---|---|---|
| 7 | ✅ | playback ledger 泛型：`sound-playback.ts`(97 行) ↔ `video-playback.ts`(92 行) 核心 41 行逐字同构（empty/withPlaying/withPaused/withStopped/resendPlan），抽 `createPlaybackLedger<K, E extends {paused:boolean}>(keyOf)` 工厂；bgm 是单槽退化形**不动**；两个文件保留同名 re-export 薄壳（测试直接 import 函数名） | `apps/editor/src/services/` | ~~-55~~ **-9**（97+92 → 44+38+98；注释 dense 风格下合并后的设计说明集中进了工厂文件，结构去重优先于行数） | 状态键名进入 `set()` 的局部状态形状，泛型返回值要让 TS 满意 |
| 8 | ✅ | deliver* 离线守卫统一：`deliverSoundPlay`/`deliverSoundControl`/`deliverVideo`/`deliverBgm` 四份 `!connected`/`client===null` 双分支守卫抽公共助手 | `apps/editor/src/state/store-context.ts:486-774` | ~0（33 行守卫 ↔ 33 行助手；四份双分支收敛为一处） | **日志文案逐字保留**：`sound-object.test.tsx:598-669` 有 6 条断言精确匹配 `已记录播放：层级 音效` 等格式。注意四份文案模板本来就不一致（sound/video/bgm 格式不同），调用方传完整模板，只合并守卫结构 → 助手收 `(reason) => 完整文案`，两种离线原因串逐字内联在助手里 |
| 10 | ✅ | Fog/Grid 对话框外壳：画布内部**不同构**（像素擦除 vs 格子渲染），只抽外壳——对象查找 7 行抽 `useSceneObject(objectId)` hook；Root/Portal/Overlay/Content+Title+missing 分支 ~25 行抽 `MapDialogShell`（footer 用插槽：Grid 有"全部清除"、Fog 是 running 提示） | `apps/editor/src/app/map-dialog-shell.tsx`（新）+ `FogMaskDialog.tsx`/`GridEditDialog.tsx` | ~~-35~~ **+31**（462+459 → 434+423+95；testid 三枚由 `prefix` 派生，fog-mask.spec / grid-annotate.spec 9 条用例验证通过） | data-testid 原样保留；footer 差异走插槽；Fog 窗口 children 需要收窄后的 map/imageRef/grid → 用「早退 + found=false」外壳渲染占位 |
| 9 | ⬜ | Sound/VideoEditDialog 参数化：两文件剥注释归一化后 242 vs 252 行、**~85% 相同**，合并为 `MediaClipListDialog`（dataOf/listAssets/Picker/store actions/名词/testid 前缀参数化）；真实差异只有 video 的 `formatHint`、sound 的 `fallbackName`、徽标顺序 | `apps/editor/src/app/SoundEditDialog.tsx` ↔ `VideoEditDialog.tsx` | ~180-220 | **风险最高项**：data-testid（sound-edit-*、video-add…）被 dialog 测试大量钉住，需参数化并同步测试；placeholder 语义差异保留。可先做小步：抽 `InlineRenameInput`（~20 行，AudioTagEditorDialog 也受益）再决定是否全量参数化 |

**验证口径**：每项完成后 `pnpm typecheck` 0 错误、`pnpm test` 全绿、`pnpm lint` 干净；e2e 免跑（存在 3 个预存失败，见问题 1）。

## 第二节：具体问题台账

### 1. 三个 e2e 用例预存失败（~~优先级最高，建议先于批 B 排查~~ **已处置**，2026-01 复验）

- **结论先行**：记录里的「两套素材 id 口径」问题**已不复存在**——落盘 GUID 断言的用例（`video-object.spec.ts` 的 clips/picked、`sound-object.spec.ts` 的 allGuids）现今通过，`object-edit.spec.ts` 的精灵落盘也断言 32 位 GUID + guid 字段。疑似在记录之后、本次复验之前的某次提交里已修掉（素材 id 方案统一为「内存路径 id / 落盘 GUID」）。
- 本次复验（干净工作区全量 `pnpm e2e`）只剩**两类**真实失败，均已修 / 已定性：
  1. `object-edit.spec.ts` 两条用例断言属性面板显示「（无贴图）」/ 不含「组件」字样——v24 起「图片组件缺失」修复提示（`TextureField`）**有意改了这个文案**，属**测试没跟上新设计**而非产品缺陷。已改测试：空态断言换成「图片组件缺失」+ 按钮「选择图片并添加」；「不显示内部字段」改为钉「数字+组件」计数格式（`/\d+\s*个?\s*组件/`），不再误伤用户可见的修复提示。
  2. 全量跑中零星超时（如「画布拾取」105s、「启动引导刷新」22.5s）：**单机高负载偶发**（本机同时开着 Unity / 常驻后端 / 4 workers），单跑均秒过。与素材 id 无关。
- **处置建议（原记录）**：~~单独排查，先定哪套口径是对的~~ 口径问题既已消解，e2e 恢复为每次重构可全量兜底的常态。`@runtime` 的播放命令用例（sound / video 各一条）本次也一并验证通过。

### 2. `fs.rename` 校验顺序变化（批 A 引入，已知情接受）

- **现象**：`apps/backend/src/resources/fs-provider.ts` 的 rename 校验中，`pathFor`（路径越权检查）现在先于类别一致性检查执行。对"类别不符 + 路径越权"的双重非法输入，抛出的错误消息与旧版可能不同。
- **影响面**：仅错误消息选择，两者都发生在任何写盘之前，无数据风险；测试只钉单重非法的消息，全绿。
- **处置建议**：可接受现状；若在意，给 `assertRenameAllowed` 加一条"类别优先"的参数或恢复旧顺序。

### 3. resources rename 校验抽取是净增项（批 A 引入）

- **现象**：`packages/resources/src/meta.ts` 新增 `assertRenameAllowed`/`ensureAssetMetaCore`（+67 行），消除 memory/fs 两份拷贝的漂移风险，但按本仓中文 doc 风格代码量略增。
- **处置建议**：要么接受（买的是不再漂移），要么削 doc 换净减——批 B 不动它。

### 4. `docs/CODE-STRUCTURE.md` 统计漂移（系统性问题）

- **现象**：文档含大量手工维护的逐文件行数/导出清单（如 §0 速查表、§3.2 文件表、§5.2、§7 测试清单），**没有生成脚本**，每次重构都漂移。批 A 已按 `wc` 实测修正触及处，但仍有 5 处在基线（`128714a` 之前）就已过时：
  - `provider.ts` 文档写 60 行，实测 49
  - `store-types.ts` 文档写 793，实测 796
  - `store-core.ts` 文档写 379，实测 400
  - §3.1 grid 节标题写 734，实测 707
  - §3.3 protocol 节标题写 824，实测 820
- **处置建议**：三选一——① 修这 5 处数字（10 分钟）；② 给 §0 速查表写个 `wc` 校验脚本挂到 `pnpm check`；③ 把易漂移的数字从文档撤掉，只留稳定描述。推荐 ②。

### 5. 协议 schema 复刻 + 契约测试（分析报告遗留项，架构决策）

- **现象**：`packages/protocol/src/messages.ts:102-401` 刻意复刻了 `@dts/document` 的约 200 行 zod schema（依赖方向：protocol 是最底层包，不能依赖 document），靠 `apps/backend/test/protocol-document-contract.test.ts`（约 240 行）逐字断言两份不漂移。
- **处置建议**：要消掉复刻，需接受 `protocol → document` 依赖方向，或把纯类型抽进第三个底层包。属架构决策，批 B 不动；若做，连带消掉整个契约测试文件。

### 6. `mock-client` 无测试覆盖

- **现象**：`apps/backend/src/mock-client/`（192 行，`pnpm --filter @dts/backend mock` 启动的假 Unity 客户端）没有任何自动化测试，e2e 的 @runtime 用例也不走它。
- **处置建议**：保留（联调工具有意存在）；若哪天改动 ws 协议，考虑给它加一条"能握手、能收场景"的冒烟测试。

### 7. 构建警告两条未修（决定已做，未落文档）

- **现象**：`pnpm build` 固定输出两条警告：eruda 的 direct eval（`node_modules/eruda/eruda.js`，eruda 仅在 `?debug=1` 时动态加载，独立 491 kB chunk）；`@tailwindcss/vite` 的 SOURCEMAP_BROKEN（上游插件不在 generate:build 阶段产 sourcemap，JS map 照常生成）。chunk 超 500 kB 的警告已用 `chunkSizeWarningLimit: 600` 消除。
- **处置建议**：不修（都来自第三方）；如嫌吵可在 vite config 用 `onLog` 过滤这两条。

### 8. `imageOf` 对病态手写文件的语义变化（统一架构时引入，已知情）

- **现象**：对象同时挂 `ImageLayer` + `SpriteLayer` 且数据不同时，旧实现固定返回 ImageLayer（遍历序在前），现实现按组件数组顺序取第一个。schema 允许两者并存、校验不拦——属手写脏数据。
- **处置建议**：可接受；若在意，给 validateScene 加一条"同槽位多组件"的 warning（顺手还能覆盖 map/sound 等其它槽位）。

### 9. e2e 不在 `pnpm typecheck` 覆盖内

- **现象**：workspace 9 个项目只有 8 个跑 typecheck（`pnpm -r typecheck` 输出 "8 of 9"），e2e 目录没有 typecheck script；e2e 的类型错误只能等 playwright 运行或 IDE 发现。
- **处置建议**：给 e2e 加一条 `tsc --noEmit` script（挂进根 typecheck 或独立），10 分钟活。

### 10. 提交时大量 CRLF 警告（git 配置层面）

- **现象**：每次 `git add` 都有十几条 `CRLF will be replaced by LF` warning（Windows 工作区 + 混合行尾文件）。
- **处置建议**：在 `server/.gitattributes` 加 `* text=auto`（或统一现有 `.gitattributes` 规则），一次性归一化；纯卫生项。

### 执行批 B 时新发现（待填）
