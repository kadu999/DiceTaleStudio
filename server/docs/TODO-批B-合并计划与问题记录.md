# 批 B：重复代码合并计划与问题记录

> 状态：**批 B 已全部收官**（2025-06 记录；2026-01 复验处置台账 #1，#7/#8/#9/#10 完成并提交，实际净减行数见表内——注释 dense 风格下以结构去重为主）。批 A（死代码清除 + 低中风险合并，净减约 1900 行）已完成并提交（`ed8d34b`，其上为架构统一 `128714a`）。
> 本文档两项用途：① 批 B 的执行清单与风险注记；② 具体问题台账（每条带现象/位置/处置建议，执行批 B 时新发现的追加到第二节）。
> 做完一项就把状态打勾并补实际净减行数。

## 第一节：批 B 任务清单

预估合计 40–60 分钟（含逐步跑测试验证），净减约 300–350 行。建议拆两趟：先做 #7/#8/#10（低风险，~30 分钟），#9 单独一趟。

| # | 状态 | 任务 | 位置 | 净减 | 风险与注记 |
|---|---|---|---|---|---|
| 7 | ✅ | playback ledger 泛型：`sound-playback.ts`(97 行) ↔ `video-playback.ts`(92 行) 核心 41 行逐字同构（empty/withPlaying/withPaused/withStopped/resendPlan），抽 `createPlaybackLedger<K, E extends {paused:boolean}>(keyOf)` 工厂；bgm 是单槽退化形**不动**；两个文件保留同名 re-export 薄壳（测试直接 import 函数名） | `apps/editor/src/services/` | ~~-55~~ **-9**（97+92 → 44+38+98；注释 dense 风格下合并后的设计说明集中进了工厂文件，结构去重优先于行数） | 状态键名进入 `set()` 的局部状态形状，泛型返回值要让 TS 满意 |
| 8 | ✅ | deliver* 离线守卫统一：`deliverSoundPlay`/`deliverSoundControl`/`deliverVideo`/`deliverBgm` 四份 `!connected`/`client===null` 双分支守卫抽公共助手 | `apps/editor/src/state/store-context.ts:486-774` | ~0（33 行守卫 ↔ 33 行助手；四份双分支收敛为一处） | **日志文案逐字保留**：`sound-object.test.tsx:598-669` 有 6 条断言精确匹配 `已记录播放：层级 音效` 等格式。注意四份文案模板本来就不一致（sound/video/bgm 格式不同），调用方传完整模板，只合并守卫结构 → 助手收 `(reason) => 完整文案`，两种离线原因串逐字内联在助手里 |
| 10 | ✅ | Fog/Grid 对话框外壳：画布内部**不同构**（像素擦除 vs 格子渲染），只抽外壳——对象查找 7 行抽 `useSceneObject(objectId)` hook；Root/Portal/Overlay/Content+Title+missing 分支 ~25 行抽 `MapDialogShell`（footer 用插槽：Grid 有"全部清除"、Fog 是 running 提示） | `apps/editor/src/app/map-dialog-shell.tsx`（新）+ `FogMaskDialog.tsx`/`GridEditDialog.tsx` | ~~-35~~ **+31**（462+459 → 434+423+95；testid 三枚由 `prefix` 派生，fog-mask.spec / grid-annotate.spec 9 条用例验证通过） | data-testid 原样保留；footer 差异走插槽；Fog 窗口 children 需要收窄后的 map/imageRef/grid → 用「早退 + found=false」外壳渲染占位 |
| 9 | ✅ | Sound/VideoEditDialog 参数化：两文件剥注释归一化后 242 vs 252 行、**~85% 相同**，合并为 `MediaClipListDialog`（dataOf/listAssets/Picker/store actions/名词/testid 前缀参数化）；真实差异只有 video 的 `formatHint`、sound 的 `fallbackName`、徽标顺序 | `apps/editor/src/app/MediaClipListDialog.tsx`（新）+ `SoundEditDialog.tsx` ↔ `VideoEditDialog.tsx` 薄壳 | ~~-180~~ **-70**（265+273=538 → 326+70+72=468；注释 dense 风格 + labels/buildRow 配置面） | ~~data-testid（sound-edit-*、video-add…）被 dialog 测试大量钉住，需参数化并同步测试~~ → testid 由 `prefix` 派生，**一枚不改**；sound / video e2e 共 7 条用例原样通过。placeholder 语义差异保留在 buildRow 里。曾设想的 InlineRenameInput 小步被全量参数化覆盖（改名行留在通用件内部，AudioTagEditorDialog 不共享） |

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

### 4. `docs/CODE-STRUCTURE.md` 统计漂移（系统性问题）（**已处置**，2026-01，处置②）

- **处置**：`scripts/check-code-structure-stats.mjs` 已落地并挂进 `pnpm check`（`check:docs`）——重算 §0 速查两行（源码/测试规模含分桶）、§0.1 加粗锚点（`server.ts` / `hub.ts` / `InspectorPanel.tsx`）与 §3.x 节标题包规模，逐字比对、漂移即失败。§0 表尾加了指向脚本的说明。
- **数字已按实测修正**：§0 两行（163 文件 / 35,469 行；测试 31,967 行）、§3.1 grid 734→**707**、§3.2 document 6,506→**7,105**、§3.3 protocol 824→**820**、§0.1 `hub.ts` 465→**476** / `InspectorPanel.tsx` 343→**498**、§3.4 表 `provider.ts` 60→**49**、§5.2 表 `store-types.ts` 817→**819** / `store-core.ts` 379→**400**。
- **未覆盖**（仍靠手工）：§1.2 目录树注释、§4/§5/§7 节标题、§3.x 内部逐文件表（provider 等三处是顺手修的）。语义不唯一的（§4 的 3,181 vs §0 backend 桶 3,283）没强拧一致，留给后续若觉得吵再统一口径。

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

### 9. e2e 不在 `pnpm typecheck` 覆盖内（**已处置**，2026-01）

- **处置**：`e2e/tsconfig.json` 落地（extends `tsconfig.base`），根 `typecheck` 串上 `typecheck:e2e`（`tsc --noEmit -p e2e/tsconfig.json`），随 `pnpm check` 每次跑。首跑零错误。`.cjs` reporter 不算在内（`include: **/*.ts`）。

### 10. 提交时大量 CRLF 警告（git 配置层面）（**已处置 / 实为已自愈**，2026-01 核验）

- **核验**：顶层 `.gitattributes`（2025-09 落地）已有 `* text=auto eol=lf`，`git add` 不再刷 CRLF 警告。全仓 `git ls-files --eol` 只剩 4 个工作区 CRLF 文件，全是 `command-*.bat`——那是 `.gitattributes` 里**故意**的 `*.bat text eol=crlf`（cmd.exe 对 LF 的 .bat 支持不可靠），属正确状态、无警告。无需再动。

### 执行批 B 时新发现（待填）

- **Playwright 浏览器二进制要装**：仓库升级后首次 `pnpm e2e` 会报 `Executable doesn't exist at …\chromium_headless_shell-NNNN`（用例 0.1s 全灭、看起来像系统性故障）。一次性 `npx playwright install chromium` 即可；Playwright 版本一升就要重装。与代码无关。
- **全量 e2e 在单机高负载下偶发超时**：本机同时开着 Unity / 常驻后端 / 4 workers 时，零星用例 26~105s 超时（单跑秒过）。已知现象（playwright.config 注释里写过 8 workers 的同类问题），重跑即可，不是代码回归。
