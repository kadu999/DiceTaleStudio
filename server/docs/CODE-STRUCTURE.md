# DiceTaleStudio / server 代码结构文档

> 范围：`server/` 目录下的**全部代码**（Web 编辑器 + 服务端 + 6 个内部包 + 测试 + 构建脚本 + 运行期资源）。
> 不在范围内：`client/`（Unity 前端，见 `client/README.md`）、`tools/`（仓库根下的两个探针脚本）。
> 本文是**结构性参考**，描述「哪块代码在哪、负责什么、彼此怎么连」；业务规则与操作手感写在
> `server/README.md`，前后端契约写在 `docs/specs/` 下的两份规格文档里。

## 0. 速查

| 项 | 值 |
|---|---|
| 语言 / 运行时 | TypeScript 5.9 + ESM，Node 22+（后端跑在 `tsx` 上，无编译产物） |
| 包管理 | pnpm workspace（`apps/*` + `packages/*`，共 8 个包） |
| 文档格式版本 | `DOCUMENT_FORMAT_VERSION = 30`（`packages/document/src/types.ts`；v30 加「放大镜」动作对象：新 kind `Magnifier` + 必需组件 `Magnifier`，纯加法、没有迁移函数） |
| 协议版本 | `PROTOCOL_VERSION = 21`（`packages/protocol/src/messages.ts`；v17 新增视频混合组件 `VideoBlend` 与命令 `erase_video_mask`，v18 加 `autoPlay`，v19 把两路收成「一个素材（图片 / 视频）」，v20 加 `fill_video_mask`（整张填 1 / 0），v21 加放大镜组件与 `open_magnifier` / `close_magnifier`，见 §6.1） |
| 后端默认地址 | `0.0.0.0:1420`（`resources/config/app.json`，可被 `HOST` / `PORT` 覆盖） |
| 编辑器开发地址 | `http://localhost:5173`（Vite，`/api`、`/editor`、`/client` 反代到 1420） |
| 编辑器生产地址 | `http://localhost:1420`（后端同源托管 `apps/editor/dist`） |
| 源码规模（不含测试） | 175 个文件 / 39,949 行（packages 13,560 · backend 3,721 · editor 22,668） |
| 测试规模 | 35,717 行（单测 25,612 · E2E 9,822 · 架构测试 283） |

> 上表两行与 §0.1 表格里加粗的文件行数、§3.x 节标题里的包规模由
> `scripts/check-code-structure-stats.mjs` **机器校验**（`pnpm check` 的一环）：
> 改了代码就更新这里，改了计数口径先改脚本。

### 0.1 本次重构（解耦 + 实体/组件）留下了什么

同一批改动做了三件事，互相独立又可分开回滚：

| 改动 | 之前 | 之后 | 加一个功能要改几处 |
|---|---|---|---|
| **HTTP 一条协议一个函数** | `http/server.ts` 633 行、一条 `switch` | 13 个文件，`server.ts` **73 行** + `routes/*` | 加一个接口 = 加一个函数 + 路由表一行 |
| **WS 一条消息一个函数** | `ws/hub.ts` 621 行、两条 `switch` | 8 个文件，`hub.ts` **475 行**（只管传输）+ `handlers/*` | 加一条消息 = 加一个函数（表的键完整性由类型保证） |
| **Unity 式实体+组件（GameObject + Component）** | 对象上 5 个特性扁平字段 + 各处 `kind === "…"` | `components[]`（模拟 Unity GameObject 挂组件）+ 能力槽位（slot）/访问器；文档 v19 / 协议 v9 / Unity 客户端同步（子图改动后为 **v20 / v10**，见 §0） | 加一个特性 = 加一个组件 + 注册表一行 + 预设表一行（见 §1.6） |
| **文档命令分模块** | `commands.ts` 2,069 行 | `commands/` 10 个文件（按特性） | 加一个特性的命令 = 加一个文件 |
| **编辑器 store 分片** | `editor-store.ts` 4,493 行 | 组装点 **94 行** + 17 个切片 + 上下文（见 §5.2） | 加一个功能 = 加一个 `slices/<功能>-slice.ts` + 组装点一行（**简单字段连切片都不用加**：`setComponentField` 已经在 `component-slice.ts` 里） |
| **属性面板注册表** | `InspectorPanel.tsx` 1,195 行的 JSX 分支 | `InspectorPanel.tsx` **591 行** + `registry.tsx` + `object-fields.tsx` | 加一个特性分组 = 注册表一行 + 一个字段组件 |

**代价是诚实的**：源码从 28,810 行长到 31,002 行（+7.6%；子图、kind、素材 meta 三次改动后全仓 34,624 行，见 §0）——多出来的是文件头注释、import/export
与「显式列出 action 名」的类型。换来的是「改一个功能不必碰整个项目」。
外部可见的**行为**只在两处收紧：`/api/{health,config,state}` 现在只认 GET（调用方本来就都是 GET）；
协议 +1 到 v9（老前端会被握手拒绝，见 §6.4）。

---

## 1. 总览

### 1.1 这个仓库在做什么

DiceTaleStudio 是跑团（TRPG）用的编辑工具：**数据在后端，前端只做显示**。

- `server/apps/backend` 拥有数据：静态托管编辑器网页 + 资源 REST 接口 + 运行态 WebSocket 中枢；
- `server/apps/editor` 是 React 写的 Web 编辑器（PC + 平板），唯一会写文档的地方；
- `client/`（Unity）只做镜像与播放——后台有什么对象，前端就有什么对象；命令（播声音、放视频、擦雾）由后台下发；
- 所有素材（图片 / 音频 / 视频 / 项目文件）归口在 `server/resources/`，**代码里不出现资源路径字面量**，一律走逻辑 ID（`project:<项目名>/Assets/...`）。

### 1.2 顶层目录

```
server/
├─ apps/
│  ├─ backend/                 # Node/TS 服务端（3,181 行）
│  │  └─ src/
│  │     ├─ index.ts           # 进程入口：装配 config + provider + hub + http
│  │     ├─ config.ts          # 资源根与 app.json 引导（全项目唯一允许出现资源根字面量的地方）
│  │     ├─ net.ts             # 局域网地址探测与筛选
│  │     ├─ open-folder.ts     # 调系统文件管理器打开/定位（唯一 spawn 的地方）
│  │     ├─ values.ts          # 后端共用小工具：messageOf / stamp / toArrayBuffer
│  │     ├─ http/              # ★ 一条协议一个函数：server.ts(73) + router/context/responses/requests/mime/static
│  │     │  └─ routes/         #   health / config / state / projects / resources + index(路由表)
│  │     ├─ resources/         # FsResourceProvider（唯一碰磁盘的地方）、zip 打包器、资源包缓存
│  │     ├─ ws/                # hub（传输层）+ hub-context + types + handlers/（一条消息一个函数）
│  │     └─ mock-client/       # 假 Unity 前端（联调用）
│  └─ editor/                  # React 编辑器（20,225 行）
│     └─ src/{app,panels,services,state,hooks,styles}/   # state/ 是切片式 store（见 §5.2）
├─ packages/                   # 5 个可独立测试的内部模块
│  ├─ grid/                    # 位掩码、坐标换算、RLE、.bytes 编解码（零依赖）
│  ├─ document/                # 文档模型 + 对象预设表（kind + 能力槽位）+ 访问器 + zod 校验 + 组件注册表 + 补丁式撤销
│  ├─ protocol/                # WS 消息契约（编辑器 / 服务端 / 前端共用）
│  ├─ resources/               # 逻辑 ID 规则 + ResourceProvider 抽象 + 内存实现
│  └─ renderer/                # Canvas 2D 渲染器、视口变换、变换手柄几何（不依赖 React）
├─ resources/                  # ★ 全部运行期资源
│  ├─ config/{app,editor,export}.json
│  └─ projects/<项目名>/{project.json, Assets/{config,scenes,images,audio,video}/}
├─ e2e/                        # Playwright 用例（8,866 行）
├─ test/architecture.test.ts   # 架构边界测试（依赖方向 / 禁止模块 / 资源路径字面量）
├─ docs/specs/                 # 前后端契约与运行态镜像协议
├─ command-*.bat               # Windows 一键脚本（GBK + CRLF）
├─ vitest.config.ts            # 两个 vitest project：node / jsdom
├─ playwright.config.ts        # 三条档位线 + 临时资源根
├─ eslint.config.js
├─ tsconfig.base.json
├─ pnpm-workspace.yaml
└─ package.json                # workspace 根脚本
```

### 1.3 分层与依赖方向

```
                       ┌──────────────────────────────┐
                       │  apps/editor (React)         │
                       │  四区布局 · 画布 · 面板 · 运行态 UI │
                       └───┬─────────────────┬────────┘
                           │                 │
        ┌──────────────────┘                 └──────────────────┐
        ▼                                                       ▼
┌───────────────┐                                     ┌───────────────┐
│ @dts/renderer │                                     │ @dts/document │
│ Canvas 2D     │                                     │ 文档模型/命令   │
└───────┬───────┘                                     └───────┬───────┘
        │                                                     │
        │                                                     │
        ▼                                                     ▼
┌───────────────┐                                     ┌───────────────┐
│  @dts/grid    │◀────────────────────────────────────│  @dts/grid    │
│  位掩码/坐标   │                                     └───────────────┘
└───────────────┘

┌──────────────────────┐        ┌──────────────────────┐
│  apps/backend (Node) │───────▶│ @dts/protocol        │  ← 编辑器也依赖它
│  HTTP + WS + FS      │───────▶│ @dts/resources       │  ← 编辑器也依赖它
└──────────────────────┘        └──────────────────────┘
```

**允许的包间依赖（由 `test/architecture.test.ts` 强制，且必须写进各自 `package.json`）**：

| 包 | 允许依赖 |
|---|---|
| `grid` | — |
| `protocol` | — |
| `resources` | — |
| `document` | `grid` |
| `renderer` | `grid`、`document` |

应用层的实际依赖：

- `apps/editor` → `document`、`protocol`、`resources`、`renderer`、`grid`（`package.json` 里全部声明）；
- `apps/backend` → `document`（仅用 `createEmptyProject`）、`protocol`、`resources`。

### 1.4 代码与资源分离

- **逻辑 ID 寻址**：`config:<名>` / `project:<项目名>/<项目内路径>`；解析与越权校验在 `packages/resources/src/ids.ts`；
- **唯一允许出现资源根字面量的地方**是 `apps/backend/src/config.ts` 的引导路径（`defaultResourceRoot()`），
  其余代码一律通过 `ResourceProvider` 访问；
- **唯一允许碰文件系统的地方**是 `apps/backend/src/resources/fs-provider.ts`（架构测试反查 `node:fs` 导入）；
- 编辑器的资源访问走 HTTP（`apps/editor/src/services/project-api.ts`）与场景图像服务（`scene-image.ts`），
  `packages/resources` 里注释提到的 `HttpResourceProvider` **当前并不存在**——浏览器侧没有实现该接口。

### 1.5 两条数据流

**编辑态（项目 → 场景文件）**

```
菜单/面板操作
   → editor-store 动作
   → @dts/document 命令（immer recipe，产出 patches）
   → DocumentHistory.apply()（撤销栈 / 重做栈）
   → 状态变化触发：800ms 去抖自动存 / Ctrl+S 立即存
   → project-api.putText(projectSceneFileId(...))
   → PUT /api/resources/text?id=project:<项目>/Assets/scenes/<场景>.json
   → FsResourceProvider.writeText → 原子写（临时文件 + rename）
```

**运行态（后台 → 前端镜像）**

```
编辑器点「运行」 → WS /editor: runtime_start → RuntimeHub 开闸（RuntimeSession.active = true）
编辑器推场景     → scene_push(整份 ScenePayload) → 缓存进 session + 转发 /client
前端连接         → WS /client（未开闸时握手即 503 拒绝）
                  ← server_hello → resources_prepare{project} → project_settings → scene_sync
前端拉资源包     → GET /api/resources/bundle?project=..&v=<指纹>（304 或整包 zip）
                  → 回 resources_ready → 广播 editor_state 给编辑器
DM 点命令        → editor_command{requestId, command} → 校验开闸 + 前端在线
                  → 转发 command 给前端；15s 未回执则回 editor_error
前端回执         → command_result → 广播 editor_command_result + 清 pending
```

### 1.6 实体 + 组件（GameObject + Component，v19 起）

场景对象（对应 Unity 的 **GameObject**）现在由两半组成：

```
GameObjectDoc（= GameObject）
├─ GameObject 自身（所有对象都有）：id / name / kind / active / locked
│                                 position / rotation / scale / scaleX? / scaleY?
│                                 （显示顺序 sortingOrder v26 起搬进渲染组件，见下）
└─ components: ComponentDoc[]   ← 「对象是什么、画成什么样、运行时能做什么」全在这里
   （= Unity Component；type 就是前端 C# 组件类名，同类型一个对象最多挂一个）
   └─ 对象能力组件（同类型一个对象最多挂一个；type 就是前端 C# 组件类名）：
      · v19 从对象特性提升上来的 6 种（v19 前是扁平字段）：
      GridMap(←map) / PlaySound(←sound) / Teleport(←teleport) / VideoOverlay(←video)
      / ImageLayer(←image，贴图对象) / SpriteLayer(←image，精灵对象)
      —— `image` 这个字段有**两种组件**（v21）：贴图整张铺满、精灵会取图集里的一格
      · v25 从 `GridMap` 拆出来的 `FogOfWar`（战争雾：v27 起挂在独立的 `Fog` 对象上 = 引用带网格的贴图 + 总开关 + 雾区）
      · v28 起 `GridMap`（网格）是**贴图上的可选组件**：加在 `Image` 上 = 「网格地图」，
        贴图与显示顺序住 `ImageLayer`（`MapDataDoc` 只剩 `grid` / `rowOrder` / `cells`）
      · v30 加的 `Magnifier`（放大镜，动作对象的数据本体 = 图片列表 + 当前展示的那一张）
```

> 这是 Unity 的 GameObject + Component 模式，**不是 ECS 框架**：没有 system / 调度循环，
> 组件的「行为」在 Unity 前端的 C# 组件类里，server/编辑器这一侧只做数据与校验。

**对象类型是一张扁平的预设表**（`packages/document/src/presets.ts`）：`kind` 只是**预设 id**，
不再有 parent 层级（v22 及更早的层级已移除）。**组件是唯一功能载体**：组件定义自报
`slot`（能力槽位，住在 `components.ts`），访问器按 slot 在对象的组件列表上查找，不看 kind；
预设表只回答「这个 kind **允许**哪些槽位、缺省由哪个组件承载」。
详见 §3.2.3。

**关键约定**（改这块代码前必须知道）：

| 约定 | 在哪实现 |
|---|---|
| 「哪个组件承担对象哪种能力」只有**一处**归属地 | `packages/document/src/components.ts` 的 `ComponentTypeDef.slot`（组件自报；访问器 `componentOfSlot` 按它查找） |
| 「哪个 kind 允许哪些槽位、缺省由谁承载」只有**一处**归属地 | `packages/document/src/presets.ts` 的 `OBJECT_PRESETS`（`presetOf` / `componentForSlot` / `carriesComponent`；未知 kind 一律落 `DEFAULT_SLOT_COMPONENT` 兜底） |
| 特性数据怎么读 / 怎么写只有**一处**归属地 | `packages/document/src/access.ts`（`mapDataOf` / `ensureSoundData` / `writeFeature` …）。**禁止**在调用处 `object.components.find(...)` |
| 组件类型名与元数据只有**一处**归属地 | `packages/document/src/components.ts` 的 `COMPONENT_TYPES`（6 条，全部是从对象特性提升上来的；`legacyField` 记着 v18 的字段名） |
| 组件实例 id 是**确定性**的 | `componentId(objectId, type)` = `<对象id>__<组件类型>`，所以迁移与新建重复执行都不会多出实例 |
| 同一个对象上**同一类型最多一个**实例 | 新建、迁移、`writeFeature` 都按这个前提写 |
| `kind` **不再决定行为** | 只是「创建原型」标签：新建弹框归类、列表过滤、占位色（`SceneObjectView.NeedsView(MirrorObject)` 也改看组件） |
| 协议与文档的组件口径必须一致 | 两套 schema 是刻意复刻的（`protocol` 不能依赖 `document`），由 `apps/backend/test/protocol-document-contract.test.ts` 断言 |

**加一个对象特性（v20 起该怎么做）**：

1. `presets.ts`：给 `ComponentSlot` 加一个槽位名、给 `DEFAULT_SLOT_COMPONENT` 加一个缺省承载组件名、往 `OBJECT_PRESETS` 里相关预设的 `slots` 加一行；
2. `components.ts`：加一条 `COMPONENT_TYPES`（自报 `slot`；`legacyField` 留空——新特性没有历史字段）；
3. **`component-specs/<你的特性>.ts`（新建）**：用 `defineComponent` 声明**能被描述符表达的简单字段**（布尔 / 数字 / 枚举 / 字符串）与 `defaultData`，并在 `component-specs/index.ts` 的 `COMPONENT_SPECS` 里登记一行。**登记之后属性面板会自动出行（`DescriptorRows.tsx`）、泛型写入（`setComponentField`）自动接管——那两处都不必再改代码**；
4. `schema.ts`：加这个组件数据的 zod schema，并给 `sceneComponentSchema` 加一个 `componentSchemaOf(...)` 分支。**schema 仍然手写在这一个文件里**（`packages/document/src/` 下**没有** `components/` 子目录，四个数据 schema 都在 `schema.ts`）；
5. `access.ts`：加 `xxxOf` / `ensureXxx`（**只在这一个文件里碰 `components`**）；`ensureXxx` 的默认数据直接取 `defaultDataOf(type)`，**不要在别处再抄一份形状**；
6. `commands/`：加它的写命令——**简单字段不必写**（`setComponentField` 已覆盖）；只有列表 / 引用 / 有副作用的开关才需要专用命令，且全部经访问器；
7. `validation.ts`：加它的语义校验；
8. `protocol/src/messages.ts`：`COMPONENT_TYPE` 加一项、`sceneComponentSchema` 加一个分支（契约测试会盯着你别漏）；
9. 编辑器 `panels/inspector/`：**简单字段不用动**；有列表选择 / 播放按钮 / 对话框这类自定义交互时，加一个字段组件并在 `registry.tsx` 的 `COMPONENT_EDITORS` 里登记（一个组件一个组）；
10. `client/.../SceneParser.cs`：加一个 `case`（不加也不会崩——未知组件会被安静地留下）。

也就是说：**特性本身的代码是新增文件，而不是去十几处 `kind === "…"` 里插分支**。

**三条「别再各写一遍」的规矩（v25 起）**：

- **简单字段走组件规格**：给已有组件加一个布尔 / 数字 / 枚举 / 字符串，只碰
  `component-specs/<组件>.ts` 一行 + `types.ts` + `schema.ts`（+ 协议那一行）。
  store 的 action 声明、切片实现、属性面板控件**都不必动**——v25 之前这三处各要写一遍
  （实测：一个布尔值过去要碰 6 个这样的文件，见 `docs/BASELINE-加一个组件要碰哪些文件.md` 的附录）；
- **对象自身的简单字段同理**（`object-spec.ts` 的 `OBJECT_SPEC` + `setObjectField`）：加一行描述符，
  面板的「基础」组会自动多一行。**v26 起这张表是空的**：显示顺序搬进了渲染组件
  （`setRenderSortingOrder`），对象身上不再有「无专属语义的标量字段」。其余基础字段各有一件
  描述符表达不了的语义（改名联动贴图 / 写运行日志 / 等比折叠 / 弧度↔度换算 / `position: null` 落位），
  **进去就会绕过那些语义**，所以各自留在手写路径上。加新基础字段时先问「它是不是一个普通标量」；
- **规格不驱动 schema**：`schema.ts` 的手写 zod 仍是解析期的唯一权威。默认值语义
  （例如 `video.enabled` 默认 `true`，补成 `false` 会把已有视频静默关掉）写在长注释里，
  从描述符派生有静默改语义的风险。派生留作后续，且只对「描述符完全可表达」的组件做，
  判据是**既有文档测试零改动**。**核对过 6 个组件，目前没有一个合格**（规格是有意的部分集），
  所以这一条现在是「等到有合格对象再做」，理由与核对表见 BASELINE 文档的「#1」一节。

**子图（v20）刻意没有做成第 6 个特性组件，它是一项数据**：精灵本来就是「纹理 + 一块矩形」
（Unity 也是这么定义 `Sprite` 的），矩形由图片自己的切分算出来，所以它住在图片组件的
`image` 字段（`ImageRef.sprite`）与**那张图自己的 `.meta`**（`sprite.sheet`）里——
v23 起切分搬出了工程文件（v22 及更早才是 `ProjectDoc.spriteSheets`）。
全部知识住在 `packages/document/src/sprites.ts`（新增文件），数据形状见 §3.2.6。

**v21 把「显示一张图」拆成了两个组件**（`ImageLayer` / `SpriteLayer`），这**不是**在拆子图那项数据，
而是给「哪一类对象」各配一个组件：两者的 `data` 形状一模一样，差别是**名字**——
`supportsSpriteSheet` 就靠它回答「这个对象的图能不能取一格」（选择图片弹框给不给切分面板、
属性面板显不显示子图那一行，都跟这一条走）。为什么这次不怕「谁赢」：一个对象**只会带其中一种**
（`OBJECT_PRESETS` 里每个预设的 `image` 槽位只声明一个承载组件，迁移也按预设改名），
不像「两个显示组件同时挂着」那种歧义。

**v22 曾给对象类型立过层级**（精灵 `Sprite` 与贴图 `Image` 继承抽象基类 `GameObject`），
架构统一后层级已移除：**kind 只是预设 id**，能力直接声明在每个预设的 `slots` 上。
`image` 槽位只登记在支持贴图的具体预设上
（`Sprite` / `Image` / `Player` / `Item` / `Event`），避免把显示图能力泛化到动作或地图；
`video` 那个槽位也只给地图与贴图（给了精灵会继承到视频）；精灵的图仍由 `Sprite` 预设自己的
`slots.image: SpriteLayer` 单独路由（预设管「允许什么」，组件自报的 `slot` 管「实际找到了谁」）。

---

## 2. 工程与工具链

### 2.1 workspace 与包清单

`pnpm-workspace.yaml` 声明 `apps/*` 与 `packages/*`；`allowBuilds` 只放行 `esbuild`（Vite/tsx 的平台二进制），
其余依赖不执行安装脚本（供应链收敛）。

| 包 | 名称 | 入口 | 依赖 |
|---|---|---|---|
| `packages/grid` | `@dts/grid` | `./src/index.ts` | 无 |
| `packages/document` | `@dts/document` | `./src/index.ts` | `@dts/grid`、`immer`、`zod` |
| `packages/protocol` | `@dts/protocol` | `./src/index.ts` | `zod` |
| `packages/resources` | `@dts/resources` | `./src/index.ts` | `zod` |
| `packages/renderer` | `@dts/renderer` | `./src/index.ts` | `@dts/grid` |
| `apps/backend` | `@dts/backend` | `src/index.ts` | `@dts/{document,protocol,resources}`、`ws` |
| `apps/editor` | `@dts/editor` | `index.html` → `src/main.tsx` | 全部 `@dts/*`、React 19、zustand、Radix UI、react-resizable-panels、@tanstack/react-virtual |

所有包都是 `"type": "module"`、`private`、`version: 0.0.0`，导出直接指向 `src/*.ts`（无构建步骤，靠 Vite/tsx 转译）。
另外：**5 个 `packages/*` 都没有 `test` 脚本**——单测从根 `vitest run` 统一跑（各包只有 `typecheck`）。

### 2.2 脚本

**workspace 根（`server/package.json`）**

| 脚本 | 命令 | 说明 |
|---|---|---|
| `dev` | `pnpm --parallel --filter @dts/editor --filter @dts/backend dev` | 后端 + Vite 一起起 |
| `dev:editor` / `dev:backend` | 单包 `dev` | 分开起 |
| `build` | `pnpm --filter @dts/editor build` | 构建编辑器到 `apps/editor/dist` |
| `typecheck` | `pnpm -r typecheck` | 8 个包逐个 `tsc --noEmit` |
| `test` / `test:watch` | `vitest run` / `vitest` | 单测 + 架构测试 |
| `lint` | `eslint .` | ESLint flat config |
| `e2e:smoke` | 先 build，再跑桌面 `smoke.spec.ts`（排除 `@runtime`） | 快速冒烟 |
| `e2e:tablet-smoke` | 先 build，再跑两个平板档的 `smoke.spec.ts`（排除 `@runtime`） | 平板布局冒烟 |
| `e2e` / `e2e:fast` | 先 build，再跑桌面全套 + 运行态串行 | 快速回归 |
| `e2e:full` | 先 build，再跑三档完整矩阵 + 运行态串行 | 合并前完整验证 |
| `progress-reporter.cjs` | 每项开始即打印名称，完成打印耗时；超过 10 秒每 10 秒报告仍在运行 | 卡顿定位 |
| `check` | `typecheck && test && lint` | 提交前一把过 |

**各包**

- `@dts/backend`：`dev` = `tsx watch src/index.ts`、`start` = `tsx src/index.ts`、`mock` = `tsx src/mock-client/index.ts`、`typecheck`；
- `@dts/editor`：`dev` = `vite`、`build` = `vite build`、`preview`、`typecheck`；
- 6 个 `packages/*`：只有 `typecheck`。

### 2.3 TypeScript

`tsconfig.base.json`（各包 `tsconfig.json` 通过 `extends` 继承）：`target ES2023`、`module ESNext`、
`moduleResolution Bundler`、`noEmit`，并且**全开严格档**：
`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、
`noUnusedLocals`、`noUnusedParameters`、`verbatimModuleSyntax`、`isolatedModules`。

`verbatimModuleSyntax` 是「类型导入必须写 `import type`」的来源，也是架构测试能靠正则扫 import 的前提。

8 个包的 `tsconfig.json` 全部 `extends: "../../tsconfig.base.json"` + `include: ["src", "test"]`，
只有三处覆写：

| 包 | 覆写 |
|---|---|
| `apps/backend` | `"types": ["node"]` |
| `apps/editor` | `"lib": ["ES2023","DOM","DOM.Iterable"]`、`"jsx": "react-jsx"`、`"types": ["vite/client"]` |
| `packages/renderer` | `"lib": ["ES2023","DOM","DOM.Iterable"]` —— 唯一有覆写的内部包（它要碰 Canvas） |
| 其余 5 个 `packages/*` | 无覆写 |

### 2.4 Vitest（`vitest.config.ts`）

两个 project，共用一个配置文件：

| project | environment | include |
|---|---|---|
| `node` | `node` | `test/**/*.test.ts`、`packages/*/test/**/*.test.ts`、`apps/backend/test/**/*.test.ts` |
| `editor` | `jsdom` | `apps/editor/test/**/*.test.ts(x)`，`setupFiles: apps/editor/test/setup.ts` |

`apps/editor/test/setup.ts` 补 jsdom 缺的浏览器 API（Canvas / matchMedia 之类），并挂 `@testing-library/jest-dom`。

### 2.5 ESLint（`eslint.config.js`）

flat config，文件头注释明确分工：**模块边界由 `test/architecture.test.ts` 强制**（比 lint 更严格也更可读），
这里只做通用代码质量检查。

- **ignores**：`**/dist/**`、`**/node_modules/**`、`**/coverage/**`、`**/playwright-report/**`、
  `**/test-results/**`、`**/*.d.ts`；
- **继承**：`js.configs.recommended` + `...tseslint.configs.recommended`；
- **`**/*.{ts,tsx}`**：`globals = { ...globals.node, ...globals.browser }`（两端全局都放开）；
  规则只有三条：`no-console: off`、
  `@typescript-eslint/no-unused-vars: ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]`、
  `@typescript-eslint/no-explicit-any: "warn"`（注释说明：迁就既有代码风格，显式 any 在测试与协议解析里偶有使用）；
- **测试与 e2e 放宽**：`**/test/**/*.{ts,tsx}`、`**/*.test.{ts,tsx}`、`e2e/**/*.ts` 关掉
  `@typescript-eslint/no-non-null-assertion`。

### 2.6 Vite（`apps/editor/vite.config.ts`）

```ts
plugins: [react(), tailwindcss()],
server: {
  host: true,          // 监听所有网卡：手机 / 平板可用本机局域网 IP 打开 http://<本机IP>:5173
  port: 5173,
  strictPort: false,
  proxy: {
    "/api":    { target: backendTarget, changeOrigin: true },
    "/editor": { target: backendTarget, ws: true, changeOrigin: true },
    "/client": { target: backendTarget, ws: true, changeOrigin: true },
  },
},
build: { outDir: "dist", sourcemap: true },
```

- `backendTarget = process.env.DTS_BACKEND ?? "http://127.0.0.1:1420"`；
- `/api` 是普通 HTTP 反代，`/editor` 与 `/client` 带 **`ws: true`**（两条 WebSocket 通道）；
- 因此**开发时编辑器页面与后端同源**，运行态 WS 不需要额外配置（`defaultEditorSocketUrl()` 用
  `window.location.host` 推导）；
- 构建产物在 `apps/editor/dist`，**带 sourcemap**。

### 2.7 Playwright（`playwright.config.ts`）

- `testDir: ./e2e`、`timeout 30s`、`expect.timeout 7s`、`fullyParallel: true`、`workers = E2E_WORKERS ?? 4`；
- 三条档位线：`desktop-chrome`(1440×900)、`tablet-touch-portrait`(820×1180, hasTouch, dpr2)、`tablet-touch-landscape`(1180×820, hasTouch, dpr2)；
- `webServer`：`pnpm --filter @dts/backend start`，健康检查 `/api/health`，端口 `E2E_PORT ?? 1421`，
  环境 `DTS_RESOURCES_DIR = <tmpdir>/dts-e2e-<pid>-<time>`（**临时资源根**，用例自建自删项目，不污染仓库 `resources/`）；
- `globalTeardown: ./e2e/global-teardown.ts`（按 `DTS_E2E_RESOURCES` 清掉临时根）；
- 运行态是**服务端全局单例**，所以带 `@runtime` 的用例必须串行跑（脚本层面已拆成两趟）。

### 2.8 Windows 批处理（`server/*.bat`，GBK + CRLF）

| 文件 | 作用 | 参数 / 环境变量 |
|---|---|---|
| `command-install.bat` | 检查 `node` / `pnpm` 后 `pnpm install`；失败时提示设置 `HTTP_PROXY` / `HTTPS_PROXY` | — |
| `command-build.bat` | `pnpm -r typecheck` → `pnpm build`；类型检查失败即中止 | — |
| `command-start.bat` | 单端口启动后端（同源托管编辑器）；缺产物时先 `pnpm build`；有端口占用预检（`netstat` + PID 提示） | `[--open]`（默认不弹浏览器）；`PORT` 默认 1420、`HOST` 默认 `0.0.0.0` |
| `command-open-port.bat` | 放行 Windows 防火墙入站 TCP 端口（先删同名规则再建，幂等）；非管理员自动 UAC 提权 | `[端口] [--print]`；默认 1420，`--print` 只打印 `netsh` 命令 |

---

## 3. 内部包 `packages/*`

### 3.1 `@dts/grid` — 网格几何与编解码（707 行，零依赖）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `mask.ts` | 232 | 格子类型位掩码、显示标签与颜色 | `CellMask`（`Empty:0 / Obstacle:1 / Difficult:2 / Water:4 / Fog1:8 … Fog5:128`）、`PAINTABLE_MASKS`、`FOG_MASK`、`ALL_MASK`、`hasMask`、`addMask`、`removeMask`、`isEmptyMask`、`isFogMask`、`isBlocked`、`maskToLabel`（→ `区域1+区域4`）、`normalizeRegions`、`regionsToMask`、`defaultCellMaskStyle`、`defaultCellMaskColors`、`cellMaskRgba`、`cellMaskCss`、`isHexColor`、`visibleMaskBits`、`isValidMask`；类型 `CellMaskStyle{hex,alpha}` |
| `coords.ts` | 60 | 坐标契约：世界 ↔ 网格 ↔ 贴图像素 | `isInsideGrid`、`cellPixelSize`、`gridSizeFromImage`；类型 `GridSize`、`ImageSize`、`WorldPoint`、`GridPoint` |
| `world.ts` | 122 | 世界矩形与格子换算 | `worldRectOf`、`worldRectLeft`、`worldRectBottom`、`worldRectTopLeft`、`unionWorldRects`、`gridToWorld`、`worldToGridPoint`（不夹取）、`worldToGrid`（夹取）、`gridCornerToWorld`；类型 `WorldRect{center,size}` |
| `bytes.ts` | 77 | DiceTale `.bytes` 网格二进制的读写（与 Unity 位精确兼容） | `BYTES_HEADER_SIZE`(8)、`BYTES_CELL_SIZE`(4)、`gridBytesLength`、`encodeGridBytes`、`decodeGridBytes`；类型 `GridData{size,cells}` |
| `rle.ts` | 64 | 行程编码 | `encodeRle`、`decodeRle`（传 `expectedCount` 时格数不符即抛错）；类型 `RleRun = readonly [mask, count]` |
| `brush.ts` | 146 | 画笔尺寸 / 半径 / 覆盖格子 / 轨迹补格 | `MIN_BRUSH_SIZE`(1)、`MAX_BRUSH_SIZE`(5)、`clampBrushSize`、`brushRadius`、`brushEffectiveSize`、`brushCells`、`strokeCenters`（Bresenham，含两端）、`applyBrush`、`applyBrushStroke`；类型 `BrushOptions{mask,brushSize,erase?,eraseMask?}` |
| `index.ts` | 6 | barrel 汇总导出 | — |

要点：

- 掩码数值与 Unity `DiceTale.GridCellType` **严格一致**（枚举值即掩码，可直接 `(int)` 转换）；一格可多位并存；
- 编辑器**不给位起业务名**，界面上按可绘制顺序叫「区域1–区域8」；`PAINTABLE_MASKS` 的顺序也与 Unity `GridMapEditorState.PaintableTypes` 一致；
- `visibleMaskBits` 从高位到低位遍历（低位后画、显示在最上层）；`hiddenMask` 只是显示开关，不改数据；
- 默认颜色（`MASK_STYLES`：Obstacle `#ff0000`/0.6、Difficult `#ff8000`/0.6、Water `#0080ff`/0.6、Fog1 `#d9d9d9`/0.55、Fog2 `#4dcce6`/0.6、Fog3 `#a666e6`/0.65、Fog4 `#ffa626`/0.7、Fog5 `#f24d4d`/0.75）与 Unity 的 `GetDefaultColor` 一致：RGB 可改、**透明度跟类型绑定**；
- RLE 按行主序展开、跨行同掩码合并；`.bytes` = 小端 `int32 width` + `int32 height` + `w*h` 个小端 `int32 mask`；
- 画笔半径 `floor((brushSize-1)/2)`（1/2→1×1、3/4→3×3、5→5×5，含偶数尺寸的刻意保真），与 Unity `ApplyBrush` 完全一致；
- 坐标系只有一个：**世界坐标**（x 右、y 上、像素、无限大）；`grid(0,0)` 在地图矩形左下角 = 图片最下面一行，grid.y 与世界 y 同向、不翻转；唯一的翻转发生在贴图绘制（`worldRectTopLeft`）。

### 3.2 `@dts/document` — 文档模型、命令与历史（8,704 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `types.ts` | 718 | 全部文档类型与格式版本常量（**`ObjectKind` 不在这里：v22 起住在 `presets.ts`，层级已移除、kind 只是预设 id**） | `DOCUMENT_FORMAT_VERSION`(=30)、`ProjectDoc`、`SceneDoc`、`SceneFileDoc`、`GameObjectDoc`、`ComponentDoc`、`MapDataDoc`（含 v26 的 `sortingOrder`）、`ImageLayerDataDoc`（`ImageRef & { sortingOrder }`）、`FogOfWarDataDoc`（v27：`mapId` + `enabled` + `regions`）、`SoundDataDoc`、`TeleportDataDoc`、`MagnifierDataDoc`（v30：图片列表 `images` + `picked` 下标）、`VideoDataDoc`、`VideoBlendDataDoc`（v17 / v19：两路 `{ kind, id? }` + `loop` / `autoPlay` / `audio`）、`ImageRef`、`GridSpec`、`CellRuns`、`ItemLibraryDoc`、`AudioTagTableDoc`、`SOUND_LAYERS`、`OBJECT_SOUND_LAYERS`、`ImageSpriteRef`、`SpriteSheetDoc`、`SpriteImportSettingsDoc`、`ResolvedSprite`、`SOUND_LAYER_LABELS` |
| `presets.ts` | 313 | **对象预设表 + 能力槽位**（kinds.ts / features.ts 合并而来）：kind 只是预设 id，`GameObject` 仍是抽象基类（不落进文档）；每个预设声明允许的能力槽位 → 承载组件 + 缺省承载兜底 + 特性缺省值 | `ComponentSlot`、`OBJECT_KINDS`、`ObjectKind`、`GameObjectPreset`、`OBJECT_PRESETS`、`DEFAULT_SLOT_COMPONENT`、`SPRITE_COMPONENT`、`presetOf`、`isAbstractKind`、`CONCRETE_KINDS`、`componentForSlot`、`carriesComponent`、`supportsVideo`、`supportsFog`、`supportsMagnifier`、`supportsSpriteSheet`、`displayImageField`、`DEFAULT_SOUND_LAYER`、`DEFAULT_VIDEO_*` |
| `access.ts` | 429 | **对象特性的唯一访问路径**（数据存在哪只有这里知道；v22 层级移除后一律按组件自报的 slot 查找） | 读：`componentOf`、`componentOfSlot`、`componentDataOf`、`componentDataOfSlot`、`mapDataOf`、`fogOf`、`imageOf`（按 slot 直接找，**只挑回 `ImageRef` 那几个字段**）、`imageLayerDataOf`、`objectImage`、`sortingOrderOf`（v26：地图 → 图片层 → 0）、`soundDataOf`、`teleportDataOf`、`videoDataOf`、`isFogEnabled`、`isVideoEnabled`；写：`mapDraftOf`、`writeFeature`、`removeFeature`、`ensureSoundData`、`ensureTeleportData`、`ensureVideoData`、`ensureFogData`、`withFeature` |
| `schema.ts` | 1,487 | zod schema + **版本迁移链**（v23 / v24 的素材 meta 迁移、v25 的 `migrateMapFogToComponent`、v26 的 `migrateSortingOrderToRenderComponents` 也在这一段里）+ 文件解析 | `sceneFileSchema`、`projectDocSchema`、`imageSpriteRefSchema`、`mapDataSchema`、`imageLayerDataSchema`、`upgradeRawDocument`、`migrateProjectDoc`、`parseProjectFile`、`parseProjectDoc`、`parseSceneFile`、`defaultProjectSettings`、`defaultAudioSettings`、`defaultBgmSettings`、`DEFAULT_BGM_VOLUME`(0.6)、`DEFAULT_SFX_VOLUME`(0.8)、`DEFAULT_VOICE_VOLUME`(1)；类型 `SceneSizeHint`、`ProjectFileLoad`、`SceneFileLoad` |
| `commands/` | 1,858 | **65 个文档变换命令**（`commands/*.ts` 里 `export function` 的条数；分组表里另有 3 个读/判据由 `access.ts` / `presets.ts` 提供），按特性拆成 9 个模块 | 见 §3.2.2 |
| `validation.ts` | 567 | 文档语义校验（跨字段、跨场景 + **子图的越界格子**（切分按素材 meta 查）+ **视频只给地图与贴图** + **素材 meta 里的标签引用**（顶层 `tags` 与音频旧段同一套规矩）） | `IssueLevel`、`ValidationIssue`、`SceneValidationOptions`、`hasErrors`、`formatIssues`、`validateScene`、`validateAssetMetas`、`validateProject` |
| `sprites.ts` | 350 | **精灵（子图）的全部知识**（v20 新增）：一张图怎么切、对象取哪一格、那一格在图片里的哪块矩形、画多大；「地图贴图不支持子图」的**唯一判据**也在这里。切分从 v23 起**按素材 meta 查**（参数是 `AssetMetas` 索引，**guid 优先、路径兜底**） | `SPRITE_SHEET_MAX`(64)、`DEFAULT_SPRITE_SHEET`(1×1)、`normalizeSpriteSheet`、`isTrivialSpriteSheet`、`spriteSheetOf`（meta 里没 `sheet` = 整图）、`clampSpriteCell`、`resolvedSpriteOf`、`displaySpriteOf`、`spriteUvRectOf`、`spritePixelRectOf`、`spriteCellSizeOf`、`spriteCellAtFraction`、`resolveSceneSprites`（推送用的解析：夹格子 + 摘掉地图上的误写 + **把 guid 换算回当前路径 ID** + 保留 `sortingOrder`） |
| `asset-meta.ts` | 629 | **素材 meta 的全部知识**（v23 新增；v24 起覆盖**每一种素材**）：`<素材>.meta` 的形状（GUID + 导入器 + 精灵设置 / 切分 + 音频标注 + **顶层 `name` / `tags`**）、schema、解析、序列化、GUID 生成，以及「meta ↔ 文档词汇」的访问器与纯函数写入。显示名与标签**任何素材**都能写：一律落顶层，音频旧数据（`audio.name` / `audio.tags`）由 `assetNameOfMeta` / `assetTagsOfMeta` 兼容读、写入时一并摘掉（不需要迁移） | `ASSET_META_FORMAT_VERSION`(1)、`ASSET_IMPORTERS`、`AssetImporter`、`AssetMetaDoc`、`AssetMetaSpriteDoc`、`AssetMetaAudioDoc`、`AssetMetaFileLoad`、`assetMetaSchema`、`newAssetGuid`、`createAssetMeta`、`parseAssetMetaFile`（只容错"缺 guid"，补上并 `needsRewrite`）、`serializeAssetMetaFile`、`isSpriteMeta`、`spriteSettingsOfMeta`、`spriteSheetOfMeta`、`withMetaSpriteSettings`、`withMetaSpriteSheet`、`audioNameOfMeta`（旧段）、`assetNameOfMeta`（统一读）、`withMetaAudioName`（旧段）、`withMetaAssetName`（统一写）、`audioTagsOfMeta`（旧段）、`assetTagsOfMeta`（统一读）、`withMetaAudioTags`（旧段）、`withMetaAssetTags`（统一写）、`withoutMetaAudioTag`（两处都摘）、`AssetMetas`（guid ↔ 路径双向索引）、`emptyAssetMetas`、`createAssetMetas`、`metaOfImage` |
| `history.ts` | 222 | 补丁式撤销 / 重做容器 | `DocumentHistory`、`HistoryEntry`、`DEFAULT_HISTORY_LIMIT`(=200)、`DEFAULT_COALESCE_WINDOW_MS`(=700)、`SceneListDraft` |
| `factory.ts` | 178 | 新建对象的工厂函数（默认值；地图的显示顺序 v26 起写进 `GridMap` 的 data） | `createEmptyProject`、`createEmptyScene`、`createEmptySceneFile`、`createGridMapObject`、`createSoundObject`、`createTeleportObject` |
| `components.ts` | 234 | 组件注册表（**9 种**：v19 从对象特性提升上来的 6 种 + v25 从 `GridMap` 拆出来的 `FogOfWar` + v17 加的 `VideoBlend` + v30 加的 `Magnifier`——`image` 那一个字段有 `ImageLayer` / `SpriteLayer` 两种，各自自报 `slot`）。**只登记「注册」信息**（type / displayName / gmEditable / slot / legacyField / tooltip）：字段的形状归 `component-specs/`，默认数据归 `defaultDataOf`——那条老的 `fields` + `defaultComponentData` 已删除 | `ComponentType`、`ComponentTypeDef`、`COMPONENT_TYPES`、`SLOT_COMPONENT_TYPES`、`FEATURE_COMPONENT_TYPES`、`hasLegacyFeatureField`、`findComponentType`、`componentId`、`featureComponent`、`isKnownComponentType` |
| `scale.ts` | 118 | 对象缩放语义（等比 + v11 单轴覆盖） | `DEFAULT_OBJECT_SCALE`(1)、`MIN_OBJECT_SCALE`(0.01)、`MAX_OBJECT_SCALE`(100)、`clampObjectScale`、`effectiveScaleX`、`effectiveScaleY`、`isUniformScale`、`collapseScale` |
| `fields.ts` | 144 | 字段**描述符**（纯数据、不含 React）：`key` / `label` / `kind` / 取值约束 / 默认值 / 面板 testid 与行序 / 撤销合并，以及默认值推导与「键必须真在这份数据上」的约束类型 `TypedFieldDef` | `FieldDef`、`TypedFieldDef`、`FieldKind`、`FieldOption`、`defaultValueFor`、`defaultDataFromFields` |
| `component-spec.ts` | 122 | **组件规格**的形状与声明助手：一个组件「有哪些简单字段」的唯一声明处；值收窄规则也在这里 | `ComponentSpec`、`defineComponent`、`REJECT`、`coerceFieldValue` |
| `component-specs/` | 110 | **一组件一个文件**的规格（`video.ts` = `VideoOverlay`、`video-blend.ts` = `VideoBlend`）+ 注册表 + `defaultDataOf`（默认数据的唯一归属地） | `videoSpec`、`videoBlendSpec`、`COMPONENT_SPECS`、`componentSpecOf`、`defaultDataOf` |
| `object-spec.ts` | 65 | **对象自身字段的规格**（「基础」那一组）：**v26 起为空**（显示顺序搬进渲染组件）；表里逐条写明其余七个字段为什么留在手写路径 | `ObjectSpec`、`defineObjectSpec`、`OBJECT_SPEC`、`objectFieldOf` |
| `commands/field.ts` | 98 | **规格驱动的泛型写入**：组件字段与对象字段两条（取代「一个字段写一条命令」） | `setComponentField`、`setObjectField` |
| `index.ts` | 19 | barrel | — |

#### 3.2.1 数据模型

```
project.json（ProjectDoc）        ← v23 起**只剩项目级数据**（素材级数据跟着素材走）
├─ formatVersion: 28
├─ name
├─ items: ItemLibraryDoc            ← 道具库（source/updatedAt/count/items[]）
├─ settings: ProjectSettingsDoc     ← v15 起；audio: { bgm, sfx, voice } 各只有 volume
└─ audioTags?: (string|null)[]      ← v18 起，可选；下标 = tag ID，null = 已删的洞
   （v17 的 `audioMeta` 在 v24 删掉、v20 的 `spriteSheets` 在 v23 删掉：都搬进**各自素材的 `.meta`**，见下）

Assets/<素材>.<ext>.meta（AssetMetaDoc）   ← v23 起，**每个素材一份**（图片 / 音频 / 视频 / 场景）
├─ formatVersion: 1
├─ guid                             ← 素材的稳定身份（素材与 .meta 成对改名 / 移动都靠它认）
├─ importer: "texture" | "audio" | "video" | "scene"
├─ sprite?: { mode?, sheet?: { columns, rows } }   ← 图片：导入设置 + 切分（1×1 = 整图，不写）
└─ audio?: { name?, tags?: number[] }              ← 音频（v24）：显示名 + 标签 ID 列表（ID = audioTags 下标）

Assets/scenes/<场景名>.json（SceneFileDoc）   ← 场景名不进文件内容，它就是文件名
├─ formatVersion: 28
└─ objects: GameObjectDoc[]
   ├─ id / name / kind / active / locked / rotation / scale / scaleX? / scaleY?
   ├─ position: { x, y } | null      ← 世界坐标，原点 = 场景中心，y 向上
   └─ components: ComponentDoc[]     ← { id, type, displayName?, data }
      ├─ GridMap          ← 网格数据（原 map；v28 起是**贴图上的可选组件**）：grid + rowOrder + cells(RLE)
      ├─ FogOfWar         ← 战争雾的数据（v27：挂在独立的 `Fog` 对象上）：mapId + enabled + regions
      ├─ ImageLayer       ← 对象自己显示的图（原 image），**贴图对象与网格地图**用：整张铺满 + sortingOrder(v26)
      ├─ SpriteLayer      ← 对象自己显示的图（原 image），**精灵对象**用：+ `sprite?: {column, row}`（v20：取图集里哪一格）+ sortingOrder(v26)
      ├─ PlaySound        ← 音频列表 + 选中 + 层级（原 sound）
      ├─ Teleport         ← 候选场景 + 选中（原 teleport）
      └─ VideoOverlay     ← 视频列表 + 开关（原 video）
```

**v19 起对象特性住在 `components[]` 里**（v18 及更早是 `map` / `image` / `sound` / `teleport` / `video`
五个扁平字段，由 `migrateFeaturesToComponents` 搬一次）。读它们一律走 `access.ts` 的访问器。

```
ObjectKind（`presets.ts` 的 `OBJECT_KINDS`；schema 的枚举就是它，加一个类型只动一处。
kind 只是预设 id，没有层级——「允许哪些能力槽位」看 `OBJECT_PRESETS`）
├─ GameObject                 ← **抽象基类**：不落进文档（老文件里的由 v22 迁移改成 Sprite）
├─ Sprite                     ← 精灵：图会取图集里的一格（image 槽位 = 组件 SpriteLayer）
├─ Image                      ← 贴图（v21 时叫 Texture）：整张铺满（image 槽位 = 组件 ImageLayer）
│                                + map（网格，**可选**，v28 起）与 video 两个可选槽位
├─ Fog                        ← 战争雾（v27 起）：引用带网格的贴图（fog 槽位 = 组件 FogOfWar）
├─ Player / Item / Event      ← 前端 BackendObjectKind 就有的实体（image 槽位）
└─ PlaySound / Teleport / Magnifier ← 动作对象（sound / teleport / magnifier 槽位；前端不建可见物）
```

**没有 `Map` 类型**（v28 起）：「网格地图」= 一张贴图 + `GridMap` 组件（`Image` 预设声明了
`map` 槽位，但组件本身是可选的）。`image` 那个槽位登记在支持贴图的具体预设上
（`Sprite` / `Image` / `Player` / `Item` / `Event`）；`video` 与 `map` 两个槽位**刻意只给贴图**
（`Image`）。判据一律走预设表（`presetOf(kind)?.slots.<槽位>`），**别写 `kind === "Sprite"` 这种字面量判断**。

**单位口径**：`position` 与世界坐标（像素）一致；`rotation` **在文档里存弧度**（面板按度编辑，
写盘前归一到 `(-180°, 180°]`，见 `normalizeDegrees`）；`scale` 与 `scaleX`/`scaleY` 是倍数（0.01 ~ 100）。

**组件注册表（`components.ts`，8 种；全部 `gmEditable: true`）**：

8 种 = v19 从对象特性提升上来的 6 种（`GridMap` / `ImageLayer` / `SpriteLayer` / `PlaySound` /
`Teleport` / `VideoOverlay`）+ v25 从 `GridMap` 拆出来的 `FogOfWar` + v17 加的 `VideoBlend`
（两条视频用 Mask 混合；**与 `VideoOverlay` 互斥**——准入层直接拒绝同时挂，见 `access.ts` 的
`EXCLUSIVE_SLOTS`），
`fields: []`（数据形状由各自的 zod schema 把关），
完整定义见 `components.ts` 与 §3.2.6 / §6.2。

> **历史**：注册表原来还有 7 种「前端组件体系」组件（`OptionValue` / `Backpack` /
> `ItemExchange` / `MaskImage` / `FloatValue` / `IntValue` / `BoolValue`），条件与动作
> 挂在它们上面；那套旧模型下线时一起删了。

**可选字段的取舍**（贯穿全库的一条规矩）：
`map.fog`(v10)、`scaleX/scaleY`(v11)、`video`(v14)、`audioTags`(v18)、
`image.sprite`(v20)、`ImageRef.guid`(v23)、meta 里的 `sprite` / `audio` 段(v23 / v24) 一律**不补空壳**——
「字段不存在」本身就是有意义的事实（`sprite` 缺省 = `Default` 普通图片、`audio` 缺省 = 这个文件还没整理过）；
而 `active`(v7)、`scale`(v8)、`locked`(v9)、
`settings`(v15) 是**补默认值**的（老文件读出来就有可用值）；显示顺序自 v26 起住渲染组件的 data，
缺项由 schema 默认 0。

#### 3.2.2 文档命令（`commands/`，65 个）

`commands/` 是个目录（原来是一个 2,069 行的 `commands.ts`），**按特性分模块**——
加一个特性的命令 = 加一个文件，而不是往一个巨型文件里插一段：

| 文件 | 行数 | 内容 |
|---|---|---|
| `index.ts` | 27 | barrel（`export *` 11 个模块）+ 模块级说明 |
| `shared.ts` | 208 | 命令共用的常量、查找工具与媒体列表骨架（声音 / 视频 / 传送阵同一套「列表 + 选中」的公共部分）：`DEFAULT_SORTING_ORDER` / `MAP_DEFAULT_SORTING_ORDER` / `SORTING_ORDER_LIMIT` / `createId` / `findObject` / `findMapObject` / `listMapObjects` / `withObject` / `withMediaData` / `dedupeItems` / `sameItemList` / `syncMediaSideData` / `setMediaList` / `setMediaPicked` |
| `object.ts` | 546 | 对象增删改 + 变换 + 排序（`setRenderSortingOrder`，v26 起按「先地图、后图片层」路由）+ 缩放 + `setObjectImage`（**换 id 丢掉旧的子图引用**，v20）+ `setObjectSprite`（取图集里哪一格，`null` = 整图） |
| `scene.ts` | 52 | 场景名校验 / 查找 / 重名判定（纯函数） |
| `grid-map.ts` | 238 | 地图数据 + 网格与标注（`clearMapFog` 也在这里：它动的是格子数据，只从 `fogMaskOf` 读绑定） |
| `fog.ts` | 151 | 战争雾（v27 起是独立的 `Fog` 对象的数据）：`setFogMap` / 总开关 / 指定雾区 / `fogMaskOf` / `fogMapOf`——组件总在，雾引用一张地图 |
| `play-sound.ts` | 63 | 声音对象（音频列表 / 选中 / 层级） |
| `teleport.ts` | 48 | 传送阵（候选场景 / 选中） |
| `magnifier.ts` | 157 | 放大镜（v30）：图片列表的「加一条 / 移出一条 / 换展示第几张」——列表项是完整的图片引用（可带格子），所以**选中是下标**（`picked: number`），移出一条要顺手调它 |
| `video.ts` | 133 | 视频（开关 / 列表 / 选中 / 移除组件；循环 / 声音 / 自动播放走泛型 `setComponentField`） |
| `video-blend.ts` | 112 | 视频混合（两路素材的「种类 + 素材」；换种类顺手清素材；循环 / 声音 / 自动播放走泛型 `setComponentField`） |
| `component.ts` | 47 | 可选组件的**添加 / 移除统一入口**（属性面板底部的 Add Component 与组件头的移除）：按组件类型分派到 `object` / `video` 的初始化命令；加第三种可选组件只在这里加一条 `case` |
| `project.ts` | 247 | **只剩项目级数据**：三档音量 + 音频**标签表**（`addAudioTag` / `renameAudioTag` / `setAudioTagName` / `deleteAudioTag`）。音频文件的显示名 / 标签（旧的 `setAudioMetaName` / `setAudioMetaTags`）v24 已删、图片切分（旧的 `setSpriteSheet` / `setSpriteImportSettings`）v23 已删——它们现在写在各自素材的 `.meta` 里，写入口径是 `asset-meta.ts` 的纯函数 |

**依赖方向严格单向**：`shared` → `../presets`/`../types`（不 import 任何命令模块）；
`object`/`scene` → `./shared`；`grid-map`/`fog`/`play-sound`/`teleport`/`magnifier`/`video` → `./shared` + `../access` + `../presets`；
`component` → `./object` + `./video`（只分派，不碰数据）；
`project` → `../schema`/`../types`。**没有任何模块 import barrel**（barrel 只做 re-export），所以不存在环。

命令分组一览（名字与语义都没变）：

| 分组 | 函数 |
|---|---|
| 查找 | `findObject`、`findMapObject`、`listMapObjects`、`findScene` |
| 媒体列表骨架（声音 / 视频 / 传送共用） | `withObject`、`withMediaData`、`dedupeItems`、`sameItemList`、`syncMediaSideData`、`setMediaList`、`setMediaPicked`、`setMediaClipName` |
| 对象增删改 | `createGameObject`、`addObject`、`removeObject`、`renameObject`、`nextObjectName`、`setObjectPosition`、`setObjectActive`、`setObjectLocked`、`setRenderSortingOrder`、`setObjectRotation`、`setObjectImage`、`setObjectSprite`、`objectImage` |
| 缩放 | `setObjectScale`、`setObjectScaleAxes`、`normalizeDegrees`、`objectsInDrawOrder` |
| 地图网格 | `setMapCells`、`clearMapCells`、`paintMapCells`、`setMapGrid` |
| 战争雾 | `fogMaskOf`、`fogMapOf`、`setFogMap`、`setFogEnabled`、`setFogRegions`、`clearMapFog`（后者在 `grid-map.ts`：按雾对象 → 被引用地图，动格子数据） |
| 声音对象 | `setSoundClips`、`setSoundPicked`、`setSoundLayer` |
| 传送阵 | `setTeleportTargets`、`setTeleportPicked` |
| 放大镜（v30） | `addMagnifierImage`、`removeMagnifierImage`、`setMagnifierPicked`（列表项是图片引用，所以选中是下标） |
| 视频 | `supportsVideo`、`isVideoEnabled`、`setVideoEnabled`、`removeObjectVideo`、`setVideoClips`、`setVideoPicked`（循环 / 声音 / 自动播放走泛型 `setComponentField`） |
| 组件（可选能力） | `addObjectComponent`、`removeObjectComponent`（网格 / 视频的统一添加 / 移除入口，属性面板底部的 Add Component） |
| 全局设置 | `setBgmVolume`、`setSfxVolume`、`setVoiceVolume` |
| 音频标签表（项目级） | `addAudioTag`、`renameAudioTag`、`setAudioTagName`、`deleteAudioTag`（**只动工程文件里那张表**；「哪个文件用了哪个标签」v24 起住各素材的 `.meta`，删标签摘引用是 `withoutMetaAudioTag`，见 §3.2.6 与 §5.3.2） |
| 场景 | `isSceneNameTaken`、`validateSceneName`、`createId` |
| 常量 | `DEFAULT_SORTING_ORDER`(0)、`MAP_DEFAULT_SORTING_ORDER`(-10)、`SORTING_ORDER_LIMIT`(9999)、`DEFAULT_SOUND_LAYER`("sfx")、`DEFAULT_VIDEO_ENABLED`(true)、`DEFAULT_VIDEO_LOOP`(false)、`DEFAULT_VIDEO_AUDIO`(false) |

所有命令签名形如 `(draft, ...args) => boolean`：返回 `false` 表示**没有产生变更**（`DocumentHistory.apply` 据此不入栈）。

#### 3.2.3 历史（`history.ts`）

- 基于 immer `produceWithPatches` 记录正向 / 逆向补丁，命令本身**不写反向逻辑**；
- `apply(label, recipe, { coalesceKey })`：同一 `coalesceKey` 且在 700ms 窗口内、且重做栈为空 → 合并成一条
  （合并时正补丁追加、逆补丁**前插**，撤销按相反顺序回放）；`endCoalescing()` 在松手/落笔时断开合并；
- 栈上限 200（超出丢最老）；`apply` 产生变更时会清空重做栈；`clearRedo()` 供「两套历史共用一个撤销入口」的场景用；
- `reset(next)` 整体替换文档并清空历史（打开/新建项目）；
- `snapshot()` 返回当前值 + 栈的深拷贝（测试与调试用）；
- 场景是独立文件、不进工程文件，所以**场景/对象编辑的历史挂在「场景列表」上**（`SceneListDraft`），
  项目级数据（道具库、设置、标签表）挂在 `DocumentHistory<ProjectDoc>` 上（`store-core.ts` 的
  `projectHistory`），**素材级数据（切分 / 导入设置 / 音频标注）挂在 `AssetMetaTable` 上**——三条轨道（编辑器侧怎么用见 §5.3）。

#### 3.2.4 迁移与解析（`schema.ts`）

- `upgradeRawDocument(raw)`：把任意旧版原始 JSON 抬到当前版本（v1/v2 的内联场景拆成独立文件、
  v5 位置换算成世界坐标、v6 删掉网格里的 `cellSize`、v7 补 `active`、v8 补 `scale`、
  v9 补 `locked`、v13 给 `map.fog` 补 `enabled`、v15 补 `settings`、v18 把字符串标签
  `migrateAudioTags` 建成 `audioTags` 表并换成整数 ID）；
- **v20（子图）没有迁移函数**：`image.sprite`（取哪一格）与当时还在工程文件里的 `spriteSheets`（怎么切）
  都是**可选**字段，靠「版本号 +1 → `needsRewrite` 回写一次」让老文件自描述（v17 的 `audioMeta` 是同一个先例）；
- **v22 的 `renameObjectKinds` 必须跑在其它迁移前面**：它把 `Texture` → `Image`、
  `SceneObject` → `Sprite`，而 v19 的 `migrateFeaturesToComponents` 与 v21 的
  `renameSpriteImageComponent` 都**按 kind 选图片组件名**——kind 没先落到具体类型，
  老精灵就会被搬进贴图的 `ImageLayer`（子图能力静默消失）；
- **v23 / v24 把「按文件记」的数据搬出工程文件**：`migrateSpriteMetas`（图片的切分 / 导入设置，v23）与
  `migrateAudioMetas`（音频的显示名 + 标签 ID，v24）按**路径**各生成一份 `<素材>.meta` 的内容，
  再由 `mergeMigratedMetas` 合成 `migratedMetas` 交给调用方落盘（文档包不碰文件系统）；
  两条都**不判断素材还在不在**——孤儿键由编辑器按资源树丢弃并报 warning；`audioTags`（项目级标签表）
  **留在工程文件里**，文件那一侧只记整数 ID，迁移时按那张表归一化；
- `parseProjectFile(raw)` → `ProjectFileLoad`（`doc` / `migratedScenes` / `migratedMetas` / `needsRewrite`）；
- `parseSceneFile(raw, size?)` → `SceneFileLoad`；`SceneSizeHint` 用于给缺 `grid` 的老地图补尺寸；
- `migrateProjectDoc` 做「已解析文档」的补齐（与原始 JSON 的 upgrade 分开）；
- 迁移**只做一次**：打开项目时升级并回写，之后文件自描述。

#### 3.2.5 校验（`validation.ts`）

校验分三层，职责不重叠：

| 层 | 位置 | 性质 |
|---|---|---|
| 解析期 | `schema.ts` 的 zod | **硬拒**（结构不合法直接抛错，文件打不开） |
| 结构/语义 | `document/src/validation.ts` | `ValidationIssue[]` |

`ValidationIssue = { level: "error" | "warning"; path: string; message: string }`（`path` 形如
`scenes/Map001/objects/door_01`）；`hasErrors(issues)` 判断能不能进运行态；`formatIssues(issues)`
输出 `✗ path: message` / `! path: message` 多行文本（进运行态被阻止时展示给用户）。

`validateScene` 覆盖：场景名非空、对象 id 唯一、位置必须是有限数（**刻意不设坐标上下限**——
越界对象在画布上看得见比静默拒绝更有用）、`scale`/`scaleX`/`scaleY` 必须有限且 > 0、
有 `GridMap` 时 RLE 解码失败（error）/带网格的贴图写了子图（warning）、雾区位非法或
「开着没雾区」「关着有雾区」（warning）、`PlaySound` 缺 `sound`（error）/`layer:"bgm"`（warning）/
`picked` 越界（warning）、`Teleport` 缺 `teleport`（error）/候选空 / 没选 / 选中的不在候选里 /
自己传自己（均 warning）、`video` 只允许 Map 与 Image（贴图）携带、动作对象挂 `image`（warning）、
**子图格子越出切分（warning，渲染与推送都按最后一格显示）**、**地图贴图带了 `sprite`（warning，两边都忽略）**、
组件 id 唯一、未知组件类型（warning，数据原样保留）。

`validateProject` 覆盖：`items.count` 与 `items.items.length` 不符、三档音量越界、标签重名
（**全是 warning**——不拦工程文件打开）。场景不在 `validateProject` 里（各自成文件，由 `validateScene`
逐个校验）；**音频文件的标注 v24 起也不在这里**：它跟着数据搬进了各素材的 `.meta`，由下一条查。

`validateAssetMetas(entries, tags)`（v24 接手音频标签引用检查）：`entries` 是「素材路径 ID + 它那一份 meta」，
`tags` 是工程文件里的标签表（`audioTags`）。逐份查：显示名是空白（会退回素材文件名）、
`tags` 写成空数组（会被忽略）、tagId 越界 / 指向已删的洞（`null`）/ 重复（界面上忽略）——**全是 warning**；
guid 的重复与悬空引用暂不在这里查（那要看整份 meta 表，见 §9.3）。

v23 起 `validateScene` 多了第二个参数：`validateScene(scene, { metas })`（`SceneValidationOptions`）——
「格子越界」要拿**那个素材自己的 `.meta`** 里的切分对照，而文档包不读全局，所以索引是从外面传进来的（纯函数）。

#### 3.2.6 精灵（子图，v20）

**「精灵 = 纹理 + 一块矩形」**，而这个仓库里**切分只有一份、矩形一像素都不存**。三份数据各存什么：

| 数据 | 住在哪 | 存什么 |
|---|---|---|
| 场景文件（对象身上） | **图片组件的 `data`**（类型 `ImageRef`）：精灵在 `SpriteLayer`、贴图在 `ImageLayer` | **只存引用**：`{ id, width, height, sprite?: { column, row } }`——哪张图 + 第几格；`width/height` 是**那一格的声明尺寸**（整图 = 图宽）。**贴图（`ImageLayer`）不带 `sprite`**（界面不给切图入口），但文档层不拦——手写文件里写了也会照常渲染 |
| 素材 meta（v23 起） | `<素材>.meta` 的 `sprite.sheet`（`AssetMetaDoc`；路径 ID 就是它旁边那个素材） | **唯一一份切分**（这张图几列几行）。`1×1` = 整图，**不写这一项**（`sheet` 摘掉；整个 `sprite` 节点空了 = `Default` 普通图片）。v22 及更早它住在工程文件的 `spriteSheets` 里 |
| 运行态载荷（协议） | 推送时由编辑器解析出来 | **多一项** `spriteGrid: { columns, rows }`——前端手上没有 `.meta`，「几行几列」必须随载荷走 |

三条口径：

- **「文档 → 线上形状」的唯一转换点**是 `resolveSceneSprites(scene, metas)`（`sprites.ts`，
  v23 起第二个参数是素材 meta 索引 `AssetMetas`）：
  它把越界的格子**夹到最后一格**、把**地图贴图上误写的** `sprite` 摘掉、把引用的 `guid`
  **换算回当前路径 ID**（协议只认路径，见 `docs/specs/2026-09-23-asset-meta.md`），
  返回**新对象**（不改输入文档——推送路径同时要做文本比对，按值比较才不会产生假变更）；
- `row` **从最上面数**（`row: 0` = 第一行、`column: 0` = 最左列，对齐 Unity 的 Sprite Editor），
  与 `GridMap` 的 `rowOrder: "bottom-up"` **无关**——那是「网格坐标系锚在哪」，这里是「第几个格子」；
- **不存像素、不存归一化 UV**：矩形 = 格子 ÷ **加载到的**纹理尺寸（`spriteUvRectOf` / `spritePixelRectOf`），
  与「`GridSpec` 不存 `cellSize`」同一条规矩；图片尺寸不是行列整数倍时（100px 切 3 列）编辑器画布与前端
  算出来的是同一块，不会各差一像素。`spriteCellSizeOf` 只在**挑图那一刻**算一次并写进 `ImageRef.width/height`。

**地图贴图不支持子图**：判据只有 `displaySpriteOf` 一处（地图对象一律返回 `undefined`），
于是编辑器不给入口（选择窗口右侧没有切分面板）、`validateScene` 给 warning、推送时把误写的引用摘掉——
三处行为一致，不会出现「编辑器画裁过的一块、前端铺整张」这种对不上的半套状态。

**越界格子**（切分被改小之后）：对象数据**不改**（那是用户自己挑的格），推送与渲染两处统一夹到最后一格，
画布上照常有东西可看（不是空白、也不越出图外），属性面板另挂一条「格子越界」提示让人自己重选一格。

> **历史**：`@dts/actions`（动作类型注册表、条件求值、动作图校验）曾是独立的一个包，
> 随「动作挂在组件上」那套旧模型一起整包删除了；动作编辑的数据面落地时重新设计。

### 3.3 `@dts/protocol` — WS 消息契约（1,034 行）

单文件 `src/messages.ts`（874 行）+ `index.ts` barrel（1 行）。
**编辑器、服务端、Unity 前端共用同一份 zod schema。**

> **刻意不依赖 `@dts/document`**：`protocol` 是被三端共用的最底层包，不能反过来依赖文档包，
> 所以这里**复刻一份只读 schema**（文档加字段时两处同步补）。见 §6.3 的差异清单。

常量：

| 名称 | 值 | 用途 |
|---|---|---|
| `PROTOCOL_VERSION` | `21` | 握手校验；不一致则关闭连接（`4002`）。最近一次改动是**新增「放大镜」对象**（第 9 种组件 `Magnifier` + `open_magnifier` / `close_magnifier` 两条命令）：老前端（v20）不认这个组件、也不认那两条命令，靠握手把它挡在连上的那一刻 |
| `SPRITE_SHEET_MAX` | `64` | 子图切分的**列 / 行上限**（与 `@dts/document` 的 `SPRITE_SHEET_MAX` 同值，契约测试盯着） |
| `RUNTIME_INACTIVE_STATUS` | `503` | 未开闸时拒绝 `/client` 升级的 HTTP 状态 |
| `RUNTIME_INACTIVE_REASON` | `"runtime-inactive"` | 写在 `x-dts-reason` 头里 |
| `RUNTIME_STOPPED_CODE` | `4003` | WS 关闭码：退出运行态 / 被顶替 / 心跳超时 |
| `PROTOCOL_MISMATCH_CODE` | `4002` | WS 关闭码：协议版本不一致 |

四条通道（均为 `discriminatedUnion("type")` / `("kind")`）：

| 通道 | 成员 |
|---|---|
| `editorToServerSchema` | `editor_hello{protocolVersion}`、`runtime_start`、`runtime_stop`、`scene_push{scene\|null}`、`settings_push{settings\|null}`、`editor_command{requestId,command}`、`editor_refresh` |
| `serverToEditorSchema` | `editor_state{runtimeActive,client,scene,resources,settings,serverTime}`、`editor_command_result{requestId,ok,reason?,effects?}`、`editor_log{level,message,time}`、`editor_error{requestId?,reason}` |
| `clientToServerSchema` | `client_hello{protocolVersion,name,version}`、`command_result{...}`、`pong{seq}`、`resources_ready{project,fingerprint,fileCount,bytes,ok,reason?}` |
| `serverToClientSchema` | `server_hello{protocolVersion,sessionId,serverTime}`、`scene_sync{scene\|null}`、`resources_prepare{project\|null}`、`project_settings{settings\|null}`、`command{requestId,command}`、`ping{seq}` |

`CommandRequest`（`commandRequestSchema`，16 个变体）——**核心设计：命令只是触发器，载荷里不带数据**：

| kind | 字段 | 数据从哪来 |
|---|---|---|
| `play_sound` | `objectId`, `layer` | 前端从镜像对象的 `sound.picked` 读 |
| `stop_sound` / `pause_sound` / `resume_sound` | `layer` | 按**声道层**管（同层只响一条） |
| `play_video` / `pause_video` / `resume_video` / `stop_video` | `objectId` | 对象的 `video.picked` / `loop` / `audio` |
| `play_bgm` | **`clip`** | 唯一带路径的命令（歌单不在任何对象上，就是项目 `Assets/audio/`） |
| `pause_bgm` / `resume_bgm` / `stop_bgm` | — | — |
| `erase_mask` | `objectId`, `stroke{points[],radius,softness}` | 只发**轨迹**，`objectId` = **雾对象 id**，雾层在推下去的雾对象里 |
| `erase_video_mask` | `objectId`, `stroke{points[],radius,softness}` | 只发**轨迹**，`objectId` = **贴图对象 id**，遮罩在推下去的那个对象的 `VideoBlend` 里（纯运行态，不随场景回来） |
| `fill_video_mask` | `objectId`, `covered` | 视频混合：整张遮罩填成 1 / 0（`covered: true` = 整张盖住、`false` = 整张擦开）。与 `erase_video_mask` 共用**同一条有序操作序列**（后到的按后到的算，盖住会抹掉它之前擦开的） |
| `reveal_fog_region` | `objectId`, `region`, `revealed` | `objectId` = **雾对象 id**；区域位取自它 `FogOfWar` 组件的 `regions`（v27 起；之前是地图） |
| `open_magnifier` | `objectId` | 放大镜：让前端**弹一扇窗**显示这个对象 `images[picked]` 那一张。那扇窗**没有按钮**（没有选择、也没有关闭），只能后端开、后端关 |
| `close_magnifier` | `objectId` | 放大镜：关掉那扇窗；带 `objectId` 是**认领**（只关正为它开着的那一扇，迟到的关闭不该关掉新开的那扇） |

载荷 schema（与 `@dts/document` **有意重复**，两处同步维护）：
`worldPositionSchema`、`imageRefSchema`、`spriteRefSchema`、`spriteGridSchema`、`gridSpecSchema`、`cellRunsSchema`、
`mapFogSchema`、`mapDataSchema`、`soundDataSchema`、`videoDataSchema`、`teleportDataSchema`、
`magnifierDataSchema`（v21：图片列表 + `picked` 下标）、
`projectSettingsSchema`、`gameObjectSchema`、`sceneSchema`。
协议侧是**下发子集**：不含 `components` / `actions` / `items` / `audioTags` / **素材的 `<素材>.meta`**（切分、导入设置、音频显示名与标签）等纯编辑器数据
（`gameObjectSchema` 只保留前端渲染与播放需要的字段）。

**唯一的例外——协议比文档多一项**：`imageRefSchema` 多了 `spriteGrid{columns, rows}`（v10）。
切分在编辑器那边**只有一份**（那个素材自己的 `.meta`），前端没有 `.meta`，所以编辑器推送时用
`resolveSceneSprites` 把「几行几列」解析进载荷（§3.2.6）。`refine` 只卡**一条**：两项都在时
`sprite.column < spriteGrid.columns && sprite.row < spriteGrid.rows`——**越界在协议侧是坏载荷**
（推送前已经夹过，收到越界值说明对面没按规矩来）；只带 `sprite` 不带 `spriteGrid` 仍然收下
（缺省 = 1×1 = 整图，前端算不出 UV 就按整图铺，不必为一条手写载荷判整条消息非法）。
`resourceIdsOfObject` **不因此改动**：子图不带来新的资源 ID。

公共摘要类型：`clientInfoSchema{name,version,connectedAt}`、`sceneInfoSchema{name,objectCount,updatedAt}`、
`resourcesInfoSchema{project,fingerprint,fileCount,bytes,ok,at,reason?}`、`projectSettingsInfoSchema{updatedAt}`。

解析助手：`parseClientToServer`、`parseServerToClient`、`parseEditorToServer`、`parseServerToEditor`
（失败信息形如 `"<通道> 消息校验失败: <path>: <message>"`）、`parseJsonMessage`、`createRequestId(prefix)`。

### 3.4 `@dts/resources` — 资源 ID 与 Provider 抽象（1,182 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `ids.ts` | 262 | **目录约定的唯一归属地** + 逻辑 ID 编解码（含 `<素材>.meta` 的路径 / ID 换算） | `ResourceKind`、`RESOURCE_KINDS`、`PROJECT_FOLDERS`、`DEFAULT_PROJECT_FOLDERS`、`PROJECT_FILE_NAME`、`PROJECT_SPECIAL_FILES`、`PROJECT_SCENE_FILE_EXTENSION`、`ASSET_META_SUFFIX`、`isAssetMetaPath`、`assetMetaPathOf`、`assetMetaIdOf`、`assetIdOfMetaId`、`formatResourceId`、`parseResourceId`、`projectPath`、`projectFileId`、`projectAssetId`、`projectFolderId`、`projectSceneBytesId`、`projectSceneImageId`、`projectSceneFileId`、`projectNameFromId`、`projectRelativePathFromId`、`projectNameFromFileId`、`configId`、`normalizePath` |
| `provider.ts` | 49 | 资源访问抽象（接口 + 内存 / 文件系统两实现共用） | `ResourceEntry`、`ResourceProvider`、`ResourceDirs`、`DEFAULT_RESOURCE_DIRS` |
| `project.ts` | 370 | 项目级业务操作（与宿主无关） | `ProjectSummary`、`ResourceTreeNode`、`validateProjectName`、`validateProjectRelativePath`、`listProjects`、`projectExists`、`readProjectEntries`、`buildResourceTree`、`createProject`、`deleteProject`、`readProjectFile`、`belongsToProject`、`CreateProjectOptions` |
| `memory.ts` | 238 | 内存实现（测试与联调） | `MemoryResourceProvider`、`createMemoryResourceProvider` |
| `meta.ts` | 178 | `<素材>.meta` 的路径换算、导入器判定与缺省 meta 文本；rename 校验（`assertRenameAllowed`）与「确保有 meta」（`ensureAssetMetaCore`）的公共纯函数——内存 / 文件系统两个 provider 同一套口径，错误消息只有这一份 | `ownsAssetMeta`、`assetMetaPathFor`、`assetFolderPathsFor`、`AssetImporter`、`assetImporterForPath`、`assetMetaIdFor`、`assertRenameAllowed`、`ensureAssetMetaCore`、`newAssetMetaText`、`guidFromAssetMetaText` |
| `config.ts` | 63 | `app.json` 的 zod schema 与默认值 | `appConfigSchema`、`AppConfig`、`defaultAppConfig`、`parseAppConfig` |
| `index.ts` | 5 | barrel | — |

**逻辑 ID 布局**

```
resources/
├─ config/app.json                       → config:app.json
└─ projects/我的项目/
   ├─ project.json                       → project:我的项目/project.json
   └─ Assets/{config,scenes,images,audio,video}/...
                                         → project:我的项目/Assets/...
```

- `parseResourceId` 拒绝：缺类别前缀、未知类别、空路径、`../` 与绝对路径（**不猜测，避免把错误 ID 静默映射到错误文件**）；
- `validateProjectName`：非空、无首尾空白、≤64 字符、拒绝 `\ / : * ? " < > |`、拒绝 `.` / `..`、拒绝 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）；
- `validateProjectRelativePath`：在上一项基础上**逐段**拒绝 `.` 与 `..`（`a/..` 这类会绕过 `/../` 检查）；
- `listProjects`：**判定标准只有一条——项目文件夹里有 `project.json`**；按 `zh-Hans-CN` 排序；
- `buildResourceTree`：先按配置里的 `folders` 建出空目录节点（刚建的项目也能看到标准子目录），再挂文件；
  `PROJECT_SPECIAL_FILES`（`project.json`）不进树；文件夹排前面，同类型按中文排序。
- **`<素材>.meta` 是元数据、不是资源**（v23 起）：与 `project.json` 一个待遇——不进资源树、也不进素材清单
  （`FsResourceProvider.list` 滤掉它）；编辑器要一次拿全项目的 meta 走 `GET /api/projects/meta?name=`
  （见 §4.4），写则用 `assetMetaIdOf(素材 ID)` 算出 `<素材>.meta` 的 ID 走普通文本接口。

`ResourceProvider` 接口（9 个方法）：`list(kind?)`、`exists`、`readText`、`readBinary`、`writeText`、
`writeBinary`、`ensureFolder`、`remove`、`rename`。`rename` 的契约：两端类别必须一致、源必须存在、
目标必须不存在（**绝不覆盖用户数据**）。

### 3.5 `@dts/renderer` — Canvas 2D 渲染与手柄几何（1,933 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `viewport.ts` | 154 | 视口（缩放 + 平移）与坐标变换 | `Viewport`、`Point`、`MIN_SCALE`(0.05)、`MAX_SCALE`(16)、`createViewport`、`createCenteredViewport`、`clampScale`、`worldToScreen`、`screenToWorld`、`panBy`、`zoomAt`、`fitViewport`、`visibleWorldRect` |
| `gizmo.ts` | 416 | 变换手柄（移动 / 旋转 / 缩放）的**世界几何 + 屏幕几何 + 命中判定** | `TransformTool`、`toolHasGizmo`、`GizmoHandle`、`SCALE_HANDLES`、尺寸常量（`GIZMO_HANDLE_SIZE` 9、`GIZMO_HANDLE_HIT_SIZE` 10、`GIZMO_AXIS_GAP` 45、`GIZMO_AXIS_LENGTH` 40、`GIZMO_RING_GAP` 22、`GIZMO_AXIS_HIT_WIDTH` 9、`GIZMO_RING_HIT_WIDTH` 10）、`isDrawableFrame`、`rectCorners`、`rotatePointAround`、`angleAround`、`scaleHandlePoints`、`scaleAnchorFor`、`isCornerScaleHandle`、`scaleAxisOf`、`gizmoScreenGeometry`、`hitTestGizmoHandles`、私有 `moveAxisEnd`（轴条根 / 末端同一条公式） |
| `scene-renderer.ts` | 1,275 | 场景绘制主循环 + 命中测试 + 音频徽标动画 + 子图的九参数 `drawImage` | `SceneLayer`（含 `sprite?`：**图片像素、左上角原点、y 向下**）、`SceneRenderInput`、`SceneToolHandles`、`SceneRenderer`、`createCanvasSceneRenderer`、`kindMarkerColor`、`hitTestRect`、`AudioPulseRing`、`AudioBadgeAnimation`、`audioBadgeAnimation` |
| `index.ts` | 3 | barrel | — |

两条关键不变量：

1. **手柄的绘制与命中共用同一份屏幕几何**（`gizmoScreenGeometry`）——因此不存在「看得见的柄点不中」；
   世界几何 / 屏幕几何 / 命中测试三件事刻意分开，几何只在 `gizmo.ts` 算一次；
2. 手柄尺寸是**屏幕像素**且贴着对象外框往外量（旋转环半径 = `hypot(halfWidth, halfHeight) + GIZMO_RING_GAP`，
   取矩形自己的半尺寸而非旋转后极值，避免旋转时环半径呼吸）；对象矩形在屏幕上边长 < 27px
   （`GIZMO_HANDLE_SIZE * 3`）时只画框、不画手柄，命中返回 `undefined`。
   命中优先级：八个缩放手柄（四角在四边前）→ 旋转环 → 移动轴；`tool === "none"` 不给任何命中。

渲染细节：`setTransform(dpr)` + `clearRect` → 背景纯色（`#14161a`）→ 棋盘底纹（可关；格边长夹在 6..48 屏幕像素，
超 `MAX_CHECKER_TILES`(8192) 退回纯色；相位由 `checkerOrigin` 决定并锚在世界坐标上）→ 逐 layer
（底纹 → 贴图 → 格子着色 → 网格线；旋转绕矩形中心、在裁剪之前施加；整块视口外早退用旋转后外接框）→
选中框（画在所有图层之后；有工具在用时只留虚线框、不画 8 个装饰方块）→ 手柄（压在最后）→ 原点十字（可选）。
`drawGridLines` 间距 < 4px 跳过、条数上限 4000。内置徽标（`icon: "audio" | "teleport" | "fog"`）**不裁剪**
（正在播的声波要扩到矩形外）、全部用路径画（不占资产、不依赖字体）。
`audioBadgeAnimation` 是**纯函数**（周期 1200ms、两圈错开半周期），因此可以脱离画布单测。

**子图（v20）只改「贴哪里」**：`SceneLayer.sprite` 有值时走九参数 `drawImage`（源矩形 + 目标矩形），
源矩形由调用方用 `spritePixelRectOf` 算好（口在 `@dts/document`，与前端是同一套除法）。
**裁剪、命中、选中框、手柄仍按对象矩形算**——渲染器不认识「子图」这个概念，它只拿到一块源矩形。

---

## 4. 后端 `apps/backend`（3,181 行）

### 4.1 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/index.ts` | 82 | 进程入口：装配依赖、监听端口、打印局域网地址；`startServer(): Promise<RunningServer>` |
| `src/config.ts` | 90 | 资源根引导 + `app.json` 加载 + 地址解析 + 日志文案 |
| `src/net.ts` | 72 | 局域网 IPv4 地址筛选与排序（纯函数 `pickLanAddresses`） |
| `src/open-folder.ts` | 123 | 跨平台「打开目录 / 定位文件」命令构造与 spawn |
| `src/values.ts` | 26 | 后端共用小工具：`messageOf`（异常 → 文本）/ `stamp`（日志时间戳）/ `toArrayBuffer`（Buffer 切片） |
| `src/http/server.ts` | 73 | **只剩三件事**：装配上下文、按 `/api/` 前缀二分、把失败翻成响应；外加一条保命规则——给 `response` 接空的 `error` 监听、给每个连接（`server.on("connection")`）的 socket 接一份：客户端中途断开（取消下载 / 关页面）时写响应会异步冒 `error`（Windows 上是 UV_EOF），没人接就把整个进程打崩。挂在 `connection` 上天然**每连接一次**，不需要 WeakSet 去重 |
| `src/http/router.ts` | 64 | 路由表编译与分派（路径精确匹配 + 动词；404 `未知接口` / 405 `不支持的方法`） |
| `src/http/context.ts` | 64 | `HttpContext`（config + provider + hub + log + openFolder + 资源包缓存 + 缩略图缓存）；`HttpServerOptions = Omit<HttpContext, "bundles" | "thumbnails" | "openFolder"> & { openFolder?: … }`——字段清单只此一处 |
| `src/http/responses.ts` | 98 | `HttpError`（唯一的「提前返回状态码」手段）+ `sendJson`/`sendText`/`sendBytes`/`sendEmpty` + `rethrowProviderError`（业务错误 → 400、系统错误冒泡 → 500） |
| `src/http/requests.ts` | 106 | 请求体 / 查询参数读取助手（`readBody`/`readJsonBody` 带 `maxBytes`，超限抛 413；`queryRaw`/`queryTrimmed`/`bodyString`/`bodyTrimmed`） |
| `src/http/mime.ts` | 35 | 扩展名 → Content-Type |
| `src/http/static.ts` | 92 | 编辑器产物托管 + SPA 回退 + 目录穿越防护（畸形百分号编码回 400） |
| `src/http/routes/*.ts` | 774 | **一条协议一个函数**：health(17) / config(20) / state(12) / projects(299, **7 个**：项目生命周期 + `/tree` + **`/meta`**（一次拿全项目的素材 meta，连读不出来的那几个也报出来）) / resources(360, 9 个；缩略图交给 `ThumbnailStore` 做**内存 + 磁盘**两级缓存，视频走 ffmpeg 抽首帧——**先落临时文件再让 ffmpeg 读文件**：管道不可 seek，`moov` 在文件尾的 mp4 会整批抽不出首帧；失败原因只进服务端日志、不回显给客户端) / index(66, 路由表) |
| `src/resources/fs-provider.ts` | 327 | `FsResourceProvider`（唯一碰磁盘的地方）+ 原子写 |
| `src/resources/bundle.ts` | — | 资源清单 / 指纹 / ZIP 组装与缓存；编码委托给 `fflate`（STORED） |
| `src/resources/thumbnail-store.ts` | 199 | 缩略图**两级缓存**（内存热点 + 磁盘跨重启）：条目**按内容寻址**（文件名 = 源素材 md5 + 源宽高）→ 内容没变永远命中、变了自动换名，不用另写失效逻辑；写盘原子（临时文件 + rename）、失败只记日志（缓存只是加速，绝不拖垮请求）；内存 96 条 / 磁盘 512 条（超了按 mtime 淘汰） |
| `src/ws/hub.ts` | 475 | `RuntimeHub`：连接、心跳、命令回执、消息分发与序列化发送 |
| `src/ws/hub-context.ts` | — | `HubContext` 与 WS logger 类型：handler 可用能力契约 |
| `src/ws/handlers/{editor,client,types}.ts` | — | **一条消息一个函数**：按方向划分的消息处理器与类型安全注册表 |
| `src/ws/runtime-session.ts` | 187 | `RuntimeSession`：运行态内存状态（开闸 / 前端 / 场景 / 设置 / 资源包） |
| `src/mock-client/index.ts` | 199 | 假 Unity 前端（联调与手测） |

### 4.2 启动流程（`index.ts`）

```
startServer()
 ├─ loadConfig()                     → { app, resourceRoot, dirs, usingDefaults }
 ├─ createLogger()                   → `HH:MM:SS [level] message`
 ├─ new FsResourceProvider(root,dirs) → 构造时即校验目录配置不越出资源根
 ├─ new RuntimeHub(log)
 ├─ createHttpServer({config,provider,hub,log})
 ├─ hub.attach(server)               → 监听 upgrade，按路径分流 /client、/editor
 ├─ resolveServerAddress(app)        → HOST/PORT 环境变量优先
 ├─ server.listen(port, host)
 ├─ 打印 URL、配置来源、WS 路径
 └─ host 是 0.0.0.0 / :: 时打印局域网可用地址（逐个列出网卡名）
```

`RunningServer` = `{ server, hub, config, url, close() }`；`close()` 先 `hub.close()`（清定时器、关前端与全部编辑器、关 WSS）再关 HTTP。
文件结尾有「是否作为入口直接运行」的判断（`import.meta.url === pathToFileURL(process.argv[1])`），
所以测试可以 `import { startServer }` 而不触发监听。

### 4.3 配置加载（`config.ts`）

三层优先级（从高到低）：

1. `loadConfig(explicitRoot)` 的显式参数（测试传入）；
2. 环境变量 `DTS_RESOURCES_DIR`；
3. `defaultResourceRoot()`——**基于模块位置**解析（`apps/backend/src/` → `../../../resources`），
   **不是** `process.cwd()`。原因写在注释里：pnpm 执行 workspace 脚本时 cwd 是包目录，按 cwd 解析会静默退回默认配置。

拿到资源根后读取 `<root>/config/app.json`（路径由 `DEFAULT_RESOURCE_DIRS.config` + `configId("app")` 拼出，
不写字面量），`ENOENT` 时用内置默认值并把 `usingDefaults` 置 true，其它错误直接抛。

- `resolveServerAddress`：`HOST` / `PORT` 环境变量优先于 `app.json`；端口非法（非整数 / ≤0 / >65535）抛错；
- `describeConfig`：只输出资源根与配置来源，不泄露其它信息；
- `dirs = { ...DEFAULT_RESOURCE_DIRS, ...app.dirs }`。

`resources/config/app.json` 的实际取值：

| 键 | 值 |
|---|---|
| `resourceRoot` | `"resources"` |
| `dirs` | `{ config: "config", project: "projects" }` |
| `projectFolders` | `Assets/config`、`Assets/scenes`、`Assets/images`、`Assets/audio`、`Assets/video` |
| `server` | `{ host: "0.0.0.0", port: 1420 }` |
| `defaultCellPixels` | `30` |
| `bundle.maxTotalBytes` | `268435456`（256 MB） |

> 注意：`appConfigSchema` 里 `resourceRoot` 虽然可配，但后端只把资源根当作**定位 app.json 的起点**，
> 真正生效的根始终是 `loadConfig` 解析出来的那个值。

### 4.4 HTTP 接口

`createHttpServer(options)` 返回 Node `http.Server`；请求分发：`path.startsWith("/api/")` → `handleApi`，否则 → `serveStatic`。
所有 `handle` 异常由最外层捕获，未发头则回 `500 {error:"内部错误"}`。

| 路径 | 方法 | 请求 | 成功响应 | 错误 |
|---|---|---|---|---|
| `/api/health` | 任意 | — | `{ok:true, runtimeActive, clientConnected, editorConnections}` | — |
| `/api/config` | 任意 | — | `{resourceRoot, dirs, projectFolders, defaultCellPixels, usingDefaults}` | — |
| `/api/projects` | GET | — | `{projects: ProjectSummary[]}` | — |
| `/api/projects` | POST | `{name}` | `201 {ok:true, name}` | `400 {error}` |
| `/api/projects` | DELETE | `?name=` | `{ok:true, name, removed}` | `400 {error}` |
| `/api/projects` | 其它 | — | — | `405` |
| `/api/projects/tree` | GET | `?name=` | `{name, exists, tree: ResourceTreeNode[]}` | `400`（缺 name） |
| `/api/projects/meta` | GET | `?name=` | `{name, metas: { <素材逻辑ID>: <meta 原文> }, unreadable: [素材逻辑ID]}`（**一次拿全**；坏 JSON 的那几个进 `unreadable` 并记日志——调用方据此**不给它们补新 meta**） | `400`（缺 name） |
| `/api/projects/folder` | POST | `{project, path}` | `201 {ok:true, id}` | `400`（路径非法）/`405` |
| `/api/projects/reveal` | POST | `{name, path?, selectFile?}` | `{ok:true, path}` | `400`/`404`/`405`/`500` |
| `/api/resources/index` | GET | `?kind=` | `{entries: ResourceEntry[]}` | — |
| `/api/resources/raw` | GET | `?id=` | 二进制（Content-Type 按扩展名，`no-store`） | `400`（缺 id）/`404` |
| `/api/resources/thumbnail` | GET | `?id=`；`info=1` 时只回原尺寸（**图片与视频都支持**：视频走 ffmpeg 抽首帧探测） | 缩小的 WebP（含原图宽高头）或 JSON 尺寸；视频（mp4/webm）= ffmpeg 抽首帧再走同一条 sharp 管线。**缓存是内存 + 磁盘两级**（`ThumbnailStore`，磁盘在 `<资源根>/.cache/thumbnails/`、按源素材 md5 命名）：后端重启不用重算，素材一改自动失效。**抽帧先落一个临时文件**：ffmpeg 从 `pipe:0` 读时不可 seek，`moov` 在文件尾的 mp4（非 faststart，手机 / 剪辑软件的默认导出）整批抽不出来 | `400`（无效图片 / 视频抽帧失败——需 ffmpeg 在 PATH，或这条视频解不出来；**原因只进日志**）/`404` |
| `/api/resources/raw` | PUT/POST | `?id=` + 原始字节 | `{ok:true, id, size}` | — |
| `/api/resources/raw` | DELETE | `?id=` | `{ok:true, id}` | — |
| `/api/resources/text` | GET | `?id=` | `text/plain`（`no-store`） | `400`/`404` |
| `/api/resources/text` | PUT/POST | `?id=` + UTF-8 文本 | `{ok:true, id}` | — |
| `/api/resources/manifest` | GET | `?project=` | `{project, fingerprint, bytes, fileCount, files}` | `400`/`404`（项目不存在） |
| `/api/resources/bundle` | GET | `?project=&v=<指纹>` | `application/zip` + `x-dts-*` 头；指纹一致时 **304** | `400`/`404`/`413`（超上限） |
| `/api/resources/rename` | POST | `{from, to}` | `{ok:true, id: to}` | `400`/`405` |
| `/api/state` | 任意 | — | `RuntimeSnapshot` + `serverTime` | — |
| `/api/*`（未匹配） | — | — | — | `404 {error:"未知接口: …"}` |

细节与安全边界：

- **`/api/projects/tree`** 对不存在的项目返回**空树 + `exists:false`**，而不是错误——否则会把「标准子目录」
  凭空画出来，让人以为项目还在；
- **`/api/projects/reveal`** 是本仓库唯一的「服务端执行系统命令」入口，三道约束：
  (1) 客户端只能给**项目内相对路径**，且必须过 `validateProjectRelativePath`；
  (2) 绝对路径**由服务端自己拼**（`资源根/项目目录/相对路径`），拼完再确认 `target` 落在项目目录内；
  (3) `selectFile` 只对**真实存在的文件**生效（目录会退化成「打开并选中它自己」），文件不存在直接 `404`；
  测试通过 `options.openFolder` 注入假实现（真的调系统命令会在测试机上弹一堆窗口）；
- **`/api/resources/raw` 的 PUT** 直接收原始 body（不解析 JSON），转成 `ArrayBuffer` 交 provider 原子写；
- **`/api/resources/bundle`** 的 `v` 参数是客户端「我本地已经是这一版」的声明：
  与当前指纹一致则回 `304`（省掉几十 MB 传输），不一致才重新打包。缓存策略见 §4.6；
- MIME 表覆盖 html/js/mjs/css/json/svg/png/jpg/jpeg/webp/gif/ico/mp3/ogg/wav/mp4/webm/woff2/txt/bytes，
  未命中回 `application/octet-stream`。

### 4.5 静态托管（`serveStatic`）

托管目录 `apps/editor/dist`（由 `import.meta.url` 解析，不依赖 cwd）。

| 情形 | 行为 |
|---|---|
| `/` | 回 `index.html`（`no-store`） |
| 命中 `dist` 下的真实文件 | 回文件；`index.html` 用 `no-store`，其余 `public, max-age=60` |
| 路径越出 `dist` | `403 {error:"非法路径"}` |
| **缺失且「像产物文件」**（`assets/` 前缀 或 带扩展名） | **`404`**——绝不能回 `index.html` |
| 缺失且「像前端路由」（无扩展名） | SPA 回退到 `index.html`；若 `index.html` 也不存在，回一段 HTML 提示「编辑器尚未构建」并给出 `pnpm build` 指引 |

「缺失产物必须 404」这条是硬约束：构建产物带内容哈希，`pnpm build` 之后旧文件名立刻不存在，
而**构建前打开的页面**手里还攥着旧名字；此时若回 `text/html` 的 index.html（还带 200），
浏览器会把 HTML 当 ES 模块解析，页面直接白屏卡死（`Unexpected token '<'`）。

### 4.6 资源包：清单、指纹与 zip（`resources/bundle.ts`）

用途：前端连上后**一次拉完**当前项目的 `Assets/`，之后离线可跑、切图不等网络。

| 导出 | 说明 |
|---|---|
| `BUNDLE_MANIFEST_NAME` | `"dts-bundle.json"`（包内清单文件名） |
| `BundleEntry` | `{ id（逻辑 ID）, path（项目根相对路径 = zip 条目名）, size, mtimeMs }` |
| `ProjectManifest` | `{ project, fingerprint, entries[], bytes }` |
| `BuiltBundle` | `{ manifest, zip, headers }` |
| `ProjectNotFoundError` | HTTP 层据此回 `404`（不靠字符串匹配） |
| `BundleTooLargeError` | HTTP 层据此回 `413` |
| `readProjectManifest(provider, project)` | 列出进包文件 + 算指纹 |
| `buildBundle(provider, project, {maxTotalBytes})` | 打包（含清单文件） |
| `fingerprintOf(entries)` | `path:size:mtimeMs` 排序拼接后的 **sha1 前 16 位** |

- **入包范围**：只收 `Assets/` 下的文件；排除 `project.json`（元数据）、`.gitkeep`；条目按 `path` 排序保证指纹稳定；
- **压缩方式刻意选 STORED（不压缩）**：通过 `fflate` 的 `level: 0` 使用标准 ZIP 编码；
  且素材（png/mp4/mp3/wav）本身已压缩，deflate 省不下体积；代价是传输量 = 字节总和，由 `maxTotalBytes` 兜住；
- `fflate` 写 UTF-8 条目名和文件修改时间；早于 ZIP 时间戳下限的条目按 1980-01-01 写入；
- **响应头**：`x-dts-project`（URL 编码）、`x-dts-fingerprint`、`x-dts-file-count`、`x-dts-bytes`；
- **包内还写一份 `dts-bundle.json`**（项目名 + 指纹 + 字节数 + 文件列表），前端解压后可自行核对，不必再问服务端；
- **缓存**（在 `resources/bundle.ts` 里）：`BundleCache` 按项目保存 `{fingerprint, zip, headers}`，**每个项目只留最近一份**；
  每次请求先重算指纹（成本 = 一次 `list`），内容变了就重打——不需要文件监听，也不会发出发霉的包。

### 4.7 文件系统资源实现（`resources/fs-provider.ts`）

`class FsResourceProvider implements ResourceProvider`，构造时 `assertDirsInsideRoot()`：
配置里的目录名必须是相对路径、且解析后仍落在资源根内，否则**拒绝启动**。

- `pathFor(id)`：`parseResourceId` 之后再确认解析结果落在类别目录内（**二次校验**），越权抛
  `资源路径越出类别目录: <id>`；
- `list(kind)`：`readdir({recursive:true})`，跳过 `.gitkeep` 与写入用的 `.dts-tmp` 临时文件，
  **目录也列出来**（刚建的空目录必须可见），结果按 `id` 排序；
- `exists` 只认**文件**（重命名目录时用内部的 `existsAt`，它按「路径是否存在」判断）；
- `rename`：类别一致 → 源存在 → 目标不存在（**绝不覆盖用户数据**），然后 `mkdir -p` + `rename`。

**原子写（`writeAtomically`）**：同目录临时文件 + `rename`。

- 为什么：`writeFile` 是「先截断、再写」，并发读的人会看到空文件或半截 JSON；而场景文件是「随时随地自动存」的，
  编辑器、E2E、外部工具都可能在写的同时读它。`rename` 是原子的，读的人要么看到旧内容、要么看到新内容；
- 临时文件名**每次都不一样**（`<path>.<pid36>-<seq>-<random>.dts-tmp`）：同一文件可能被并发写
  （自动存与手动保存撞在一起），共用临时名会让先写的那次 `rename` 找不到文件；
- `renameWithRetry`：Windows 上替换正被读取方打开的文件会 `EPERM`/`EACCES`/`EBUSY`，
  最多重试 5 次、每次间隔 5ms；
- 失败时删掉临时文件；`.dts-tmp` 不会被列进资源树。

### 4.8 运行态 WebSocket 中枢（`ws/hub.ts`）

`RuntimeHub` 是**中继 + 缓存**，本身不拥有数据。`attach(server)` 监听 HTTP `upgrade` 事件：

| 路径 | 条件 | 行为 |
|---|---|---|
| `/client` | `session.runtimeActive === false` | 手写 `HTTP/1.1 503` + `x-dts-reason: runtime-inactive`，**握手即失败**（前端从没「连上过」），并只记一次日志（避免前端每 3 秒重试刷屏） |
| `/client` | 已开闸 | `handleUpgrade` → `acceptClient` |
| `/editor` | 总是 | `handleUpgrade` → `acceptEditor` |
| 其它 | — | 记 `warn` 日志并 `socket.destroy()` |

**前端会话（单客户端架构）**

- 新连接**顶掉旧的**（`kickClient("被新的前端连接顶替")`）；
- 连上立刻按顺序发：`server_hello` → **`resources_prepare{project}`** → **`project_settings`** → **`scene_sync`**；
  顺序有语义：项目名必须在场景之前到（否则成了「场景先到、资源后下」），设置（音量）必须在起播之前到；
- 占位信息先写 `session.setClient({name:"未标识的前端", ...})`（编辑器立刻能看到「已连接」），
  `client_hello` 到了再补名字与版本；
- 心跳：每 15s 发 `ping{seq}`；**连续 2 拍没收到 `pong`** 判为半开连接，踢掉并写日志；
- 入站消息（`parseClientToServer`）：`client_hello`（版本不符 → `close(4002)`）、`command_result`、`pong`、`resources_ready`；
- 断开：清心跳、`session.setClient(null)`、广播 `editor_state`、给编辑器写一条 `warn` 日志。

**编辑器会话**

- 多编辑器并存（`Set<WebSocket>`）；连上即发一份 `editor_state`；
- `editor_hello`：版本不符 → `close(4002)`；一致则回 `editor_state`；
- `runtime_start` → `session.start()`（**幂等**，重复点不会重置场景缓存），并复位「未开闸被敲门」日志开关；
- `runtime_stop` → `session.stop()` + `kickClient("编辑器已退出运行态")`；
- `editor_refresh` → 单独回一份 `editor_state`；
- `scene_push` → 比对项目名是否变化：变了就先 `prepareClientResources` 再发 `scene_sync`；随后广播 `editor_state`
  （推送频繁，**只更新状态、不写日志**）；
- `settings_push` → 缓存 + 转发 `project_settings` + 广播状态；
- `editor_command` → 三级校验：未开闸 → `editor_error{requestId, reason:"未进入运行态，无法下发命令"}`；
  前端未连 → `"前端未连接，无法下发命令"`；转发失败 → `"下发失败：前端连接不可用"`。
  成功则 `trackCommand(requestId, editor, command.kind)`；
- **编辑器断开不影响运行态**：运行态是**服务端状态**，刷新页面 / 关掉编辑器都不会退出运行，只有
  `runtime_stop` 或服务端重启才会关闸；
- 校验失败的消息会**尽力取出 `requestId`**（`requestIdOf`）并挂到 `editor_error` 上：
  JSON 合法但字段/判别值不认识时（例如服务端进程还是旧的、不认识新增的命令种类），
  那条命令的失败才有主、编辑器侧的 pending 才收得掉。

**命令回执与超时**：`pending: Map<requestId, {timer}>`；`command_result` 到达时清计时器并广播
`editor_command_result{requestId, ok, reason?, effects?}`；**15 秒**未回执则回
`editor_error{requestId, reason:"命令回执超时（15000ms）：前端可能未实现 <kind>"}`——**不静默失败**。

**对编辑器的下行消息**：`editor_state`（运行态摘要：开闸 / 前端 / 场景 / 资源包 / 设置 / 服务器时间）、
`editor_command_result`、`editor_log{level,message,time}`（服务端把关键事件以日志形式推给编辑器运行面板）、
`editor_error{requestId?,reason}`。

公开只读属性：`clientConnected`、`runtimeActive`、`editorCount`、`session`；
公开方法：`attach`、`close`、`broadcastToEditors`。

### 4.9 运行态会话（`ws/runtime-session.ts`）

**内存态，不持久化**。`RuntimeSession` 只记五件事：

| 字段 | 语义 |
|---|---|
| `active` | 开没开闸（只有 `runtime_start` / `runtime_stop` 能改） |
| `clientInfo` | 前端是谁（名字 / 版本 / 连接时间 / 地址） |
| `sceneDoc` + `sceneUpdatedAt` | **最近一份场景**（`scene_push` 推来的整份文档）——也是「后连上的前端立刻拿到全量」的依据 |
| `settingsDoc` + `settingsUpdatedAt` | 最近一份项目级设置（与场景同命：一连上就补发，退出运行一起清） |
| `resourcesInfo` | 前端本地资源包的状态（成功 / 失败都记，没回执时 `null`） |

其他成员：`sessionId = createRequestId("sess")`（前端在 `server_hello` 里看到它，排查用）；
`snapshot` getter 产出 `RuntimeSnapshot`（`/api/state` 与 `editor_state` 共用）；
`projectNameOfScene(scene)` **从场景里的资源逻辑 ID 反推项目名**（取第一个 `project:` 前缀 ID 的第一段），
推不出来返回 `null`（前端退回「等场景到了再自己推」）。

`stop()` 清空全部字段——**旧运行态不留痕**。

### 4.10 局域网探测与文件管理器（`net.ts` / `open-folder.ts`）

`net.ts`：`pickLanAddresses(interfaces)` 是纯函数（便于测试）——过滤 `internal`、非 IPv4、APIPA
`169.254.x.x`、以及明显虚拟的网卡（VMware / VirtualBox / Hyper-V / WSL / Docker / ZeroTier / Tailscale /
Radmin / Hamachi / Bluetooth）；真实网卡（Wi-Fi / WLAN / Wireless / Ethernet / 以太网 / 无线）排在前面。
`listLanAddresses()` 是对 `os.networkInterfaces()` 的封装。

`open-folder.ts`：三条硬约定写在文件头——(1) 路径由服务端自己拼；(2) **命令名与参数分开传**（不拼 shell 字符串，
所以空格、`&`、中文都不会被当成命令解析）；(3) 只可能是三个平台各一条固定命令。

| 平台 | 打开目录 | 定位文件 |
|---|---|---|
| Windows | `explorer.exe <path>` | `explorer.exe /select,<path>`（**`/select,` 与路径必须同一参数、逗号后无空格**） |
| macOS | `open <path>` | `open -R <path>` |
| Linux/BSD | `xdg-open <path>` | 退回打开父目录（`reveal: false`，函数明说这一点） |
| 其它 | `undefined`（调用方给可读错误） | 同左 |

`spawnDetached`：**等 `spawn` 事件**再返回（命令不存在时走 `error` 事件，失败能如实报给调用方，
而不是「点了没反应」），**不等进程结束**，`detached + unref()` 让子进程与编辑器脱钩。

### 4.11 Mock 前端（`src/mock-client/index.ts`）

假 Unity 客户端，**什么都不上报**，只做四件事：连上（带 3s 重试，未开闸时 503 是预期）、
打印 `scene_sync` 镜像（场景名 + 每个对象的 id/kind/active/position/scale/order/image/sound/video）、
打印 `project_settings`（三档音量）、收到 `command` 回 `command_result`。

- 回执**故意回 `ok:false`**，理由按命令种类分别写清（「mock 前端不放视频（真实播放器是 Unity）」等）——
  这样编辑器运行日志会出现「命令执行失败：mock 前端不出声…」，**证明链路通了、回执回来了**；
- 用法：`pnpm --filter @dts/backend mock`；`PORT`（默认 1420）与 `DTS_SERVER_URL` 可覆盖连接地址；
- 自动回 `pong`。

---

## 5. 编辑器 `apps/editor`（20,225 行 / 84 个文件）

### 5.1 分层总览

`src` 是「入口 → 外壳 → 面板/对话框 → store → services」的单向漏斗，依赖方向严格自上而下，没有回环：

| 层 | 目录 | 规则 |
|---|---|---|
| 入口 | `main.tsx`、`App.tsx` | `main.tsx` 是唯一 import 全局样式的地方；`App.tsx` 只有 5 行，只包一层 `EditorShell` |
| 外壳 | `app/` | `EditorShell.tsx` 是唯一的布局与总装点，也是**全局快捷键的唯一注册处**；把 11 个对话框按 store 开关挂在末尾 |
| 面板 | `panels/` | 只做「读 store 窄选择器 + 画 UI + 调 store action」，本身不持有文档数据 |
| 状态 | `state/editor-store.ts` | zustand 单 store；**唯一的真源** |
| 服务 | `services/` | 只依赖 `@dts/*` 与同层服务，**不 import store、不 import React**，因此全部可单测 |
| 样式 | `styles/index.css` | Tailwind v4 `@theme` + `@utility`，只被 `main.tsx` 引入 |

两条容易被忽略的约定：

- **`panels/` 下混着两类文件**：组件（`*Panel.tsx` / `*Fields.tsx`）与**纯逻辑模块**
  （`scene/transform.ts`、`scene/display.ts`、`scene/grid-paint.ts`、`asset-info.ts`、`asset-picker.ts`、
  `audio-catalog.ts`、`object-kinds.ts`）。纯逻辑模块不 import store、不 import React，因此**可以被 store 反向引用**；
  store 要算「适配视口」「对象显示矩形」却不能让 store 依赖面板组件——这就是那些文件待在 `panels/` 下的原因。
- **store 从不 import 任何面板组件或对话框组件**。它 import `services/*` 与 `panels/scene/{transform,display}`。

数据流：store 持有**三份** `DocumentHistory`（场景轨 = `SceneDoc[]`、工程轨 = `ProjectDoc`、素材 meta 轨 = `AssetMetaTable`）共用一个撤销入口；
运行态（`runtime` / `soundPlayback` / `videoPlayback` / `bgmPlayback` / `fogReveal`）与文档**物理隔离**，
只经 `runtime-client` 走 WebSocket 下行。

### 5.2 文件清单

> 本节按目录分组，**含 `styles/index.css`**（160 行）——§0 的源码规模只数 `.ts` / `.tsx`，
> 所以那里的「84 个文件 / 20,225 行」不含它（下表合计是 85 个文件 / 20,385 行）。

#### 根目录（2）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `App.tsx` | 5 | 应用根组件，只包一层 `EditorShell`。 | `App` |
| `main.tsx` | 15 | 浏览器入口：取 `#root`（取不到抛「找不到 #root 挂载点」），`createRoot` + `StrictMode` 渲染 `App`，引入全局样式。 | — |

#### `hooks/`（1）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `useMediaQuery.ts` | 38 | 订阅 `window.matchMedia`；`useCompactLayout` 把「窄屏（max-width:1023px）」与「粗指针（pointer:coarse）」合成「紧凑/平板布局」判定，供外壳切三栏/抽屉。 | `useMediaQuery`、`useCompactLayout` |

#### `styles/`（1）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `index.css` | 160 | Tailwind v4 主题：`--color-editor-*` 调色板（bg/panel/panel-alt/border/bar/bar-hover/text/text-dim/accent/accent-dim/danger/ok/warn）与字体；`@utility panel / panel-header / toolbar-button / toolbar-button-hover`；粗指针下 `button,[role=button]{min-height:32px}` 及例外 `.asset-row-button{min-height:0!important}`；`.editor-sound-bars` + `@keyframes editor-sound-wave`（`prefers-reduced-motion` 下关闭）。 | —（CSS） |

#### `state/`（21）

store 用 **zustand 切片**模式拆开了：原来是一个 4,493 行的 `editor-store.ts`，
现在是「组装点 + 类型 + 模块级工具 + 上下文 + 初始状态 + 16 个功能切片」。

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `editor-store.ts` | **94** | **只剩组装与再导出**：`create<EditorStoreState>()` 里展开初始状态与 17 个切片，再导出只保留真正从这里取的名字（逐名核对过消费方） | `useEditorStore`、`sceneHistory`、`projectHistory`、`fitSceneViewport`、`serializeSceneFile`、`compareSceneNames`、`findResourceNode`、`withRenamedSceneImage`；类型 `EditorMode`、`ProjectDialogMode`、`SceneDialogMode`、`SceneSaveState` |
| `store-types.ts` | 789 | 全部状态类型 + `EditorStoreState`（**129 个 action + 44 个状态字段**）+ `StoreSet` / `StoreGet` / `EditorStoreData`（由「全部 action 名」算出来的状态部分）；素材 meta 的 `AssetMetaTable`（真源表）、`AssetMetaDraft`（`applyMetas` 拿到的那份可写草稿）与 `assetMetas`（派生索引）也在这里 | 上表那些类型 |
| `store-core.ts` | 394 | **模块级**工具与状态：**三份** `DocumentHistory`（`sceneHistory` / `projectHistory` / `metaHistory`）、撤销轨（`lastEditTrack` / `activeTrack` / `historyOf` / `EDIT_TRACKS` = `scenes` / `project` / `metas`）、常量、`fitSceneViewport`、`serializeSceneFile` / `serializeProjectFile`、`withRenamedSceneImage`、`compareSceneNames`、`findResourceNode`、`makeLog` | 同 `editor-store` 的值导出 |
| `store-context.ts` | 1,320 | **闭包状态与局部工具**（原 `create()` 里那段）：`StoreContext` 53 个成员——40 个函数（`pushLog` / `switchScene` / `deliverSoundPlay` / `applyActiveScene` / `scheduleSceneSave` / `scheduleMetaSave` / `metaDirtyIds` / `fogTargetOf` / `currentSceneDoc` / `findObjectById` …）、8 个稳定引用（`runtimeClient` / 两个 `ScenePushScheduler` / `savedScenes` / **`savedMetas`** / `sceneViewports` / `quietCommandIds` / `storedGridPaint`）、5 个可变标量走 get/set（`lastPushedSceneText` / `pendingRunRequest` / `viewportAdjusted` / `bootstrapping` / `savedProjectText`）；**`metaHistory.subscribe` 在这里重建 `assetMetas` 索引并安排 meta 落盘** | `StoreContext`、`createStoreContext` |
| `initialState.ts` | 84 | 初始状态（返回类型是 `EditorStoreData`，所以**少一个状态字段就编译报错**；素材 meta 两份初始为空） | `createInitialState` |
| `slices/history-slice.ts` | 148 | `applyScenes` `applyProject` `applyMetas` `undo` `redo` `resetDoc`（三条轨道各一个写入口，且**真的产生改动时**才 `setLastEditTrack`——撤销才会作用在「最近改过的那条」上；`resetDoc` 连 `metaHistory` 一起清） | — |
| `slices/save-slice.ts` | 198 | `saveSceneNow` `flushSceneSave` `saveProjectNow` `saveMetasNow` `flushMetaSave`（meta 只写内容变过的那几份）；工程文件**没有 flush**——没有「关闭前 flush」的调用方，改动全走去抖定时器 | — |
| `slices/project-slice.ts` | 513 | 项目 CRUD、资源树、建目录、打开目录、上传、删资源，以及**素材 meta 的装配与迁移**：`loadAssetMetas` 读回全部 `.meta`、给缺的素材补一份（`assetImporterKind` 定导入器；**盘上有但读不出来的那份不补**——`readMetas` 的 `unreadable` 就是给它留的，补一份新 GUID 会盖掉盘上那份）、把 `migratedMetas` 落盘、迁移新建了场景文件时**重取一次资源树**、重建索引 | — |
| `slices/scene-slice.ts` | 316 | 场景增删改、切换、排序、载入（打开场景时的校验带 `{ metas }`） | — |
| `slices/object-slice.ts` | 445 | 对象增删改、选区、变换属性、网格规格（换图走 `sprite-slice` 的 `setObjectImageSprite`；组件的添加 / 移除走 `component-slice`） | — |
| `slices/component-slice.ts` | 77 | **泛型组件写入**：`setComponentField`（字段，标签与撤销合并都从组件规格读）、`repairObjectComponent`（缺必需组件的修复）、`addObjectComponent` / `removeObjectComponent`（可选组件，属性面板底部的 Add Component）。加一个简单字段仍不必碰这个文件 | — |
| `game-object-factory.ts` | — | 按 `ObjectKind` 注册新对象工厂；地图补同名贴图与网格，声音 / 传送阵使用文档专属工厂。 | `createGameObjectForKind` |
| `slices/transform-slice.ts` | 160 | 变换工具与手柄拖拽（`begin/apply/end/cancelObjectTransform`） | — |
| `slices/viewport-slice.ts` | 70 | 视口缩放 / 平移 / 适配 / 尺寸 | — |
| `slices/runtime-slice.ts` | 67 | `setMode` / `connectRuntime` / 推场景 / 清日志 | — |
| `slices/sound-slice.ts` | 276 | 声音对象：选中、层级、名字、播放下发（列表的加 / 删在窗口里完成，不经 store 整体替换） | — |
| `slices/video-slice.ts` | 228 | 视频：列表、选中、循环、播放下发（组件的添加 / 移除在 `component-slice`；声音 / 自动播放开关走组件规格的 `setComponentField`） | — |
| `slices/video-blend-slice.ts` | 343 | 视频混合：两路素材的「种类 + 素材」（组件添加 / 移除在 `component-slice`）、播放三键的记账与补发、Mask 窗口的**擦一笔 + 整张填 1 / 0**（都记进同一条有序操作序列并尽力下发；编辑态只预览） | — |
| `slices/bgm-slice.ts` | 83 | 全局背景音乐（播放 / 暂停 / 继续 / 停止 / 补发） | — |
| `slices/audio-meta-slice.ts` | 169 | 素材**显示名与标签**（任何素材：图 / 声 / 视频；写在**素材 meta 那条轨道**上：走 `applyMetas` + `withMetaAssetName` / `withMetaAssetTags`）+ 项目级标签表（`applyProject`）+ 三档音量 | — |
| `slices/teleport-slice.ts` | 89 | 传送阵：候选、选中、触发换台 | — |
| `slices/magnifier-slice.ts` | 133 | 放大镜（v30）：图片列表的加 / 移出 / 换展示第几张（**文档数据**），以及前端那扇窗的开 / 关记账与补发（**运行态**；编辑态只开编辑器那扇窗的预览） | — |
| `slices/grid-paint-slice.ts` | 134 | 网格标注：画笔偏好、涂抹、清空 | — |
| `slices/fog-slice.ts` | 208 | 战争雾：开关、雾区、擦除记账、补发 | — |
| `slices/sprite-slice.ts` | 199 | 精灵（子图）：`setObjectImageSprite`（图 + 格子**一条撤销记录**；对象取哪一格只有这一条写入路径）、`setSpriteSheet` / `setSpriteImportSettings`（切分与导入设置落在**素材 meta**那条轨道：走 `applyMetas`）、`ensureAssetMeta`（挑图那一刻把 guid 定下来） | — |

**切片的写法**（加一个功能照着抄）：

```ts
export function createSoundSlice(
  set: StoreSet, get: StoreGet, ctx: StoreContext,
): Pick<EditorStoreState, "playSound" | "stopSound" | /* 显式列出 */> {
  // 共享的闭包状态与局部工具都在 ctx 里：顶部解构一次，方法体与拆分前逐字一致
  const { pushLog, requireSoundObject, deliverSoundPlay, deliverSoundControl, frontendReady } = ctx;
  return { playSound(objectId) { /* … */ } };
}
```

两条约定：**返回类型显式列出 action**（漏搬 / 写错名字立刻编译报错）；
**切片之间互调走 `get().xxx()`**，store action 一个都不进 `ctx`（只有那 5 个可变标量必须用 `ctx.xxx`，
因为解构会读到过期值）。于是**加一个功能 = 加一个 `slices/<功能>-slice.ts` + 在组装点加一行**。

依赖：`services/{runtime-client,runtime-push,bgm-playback,project-api,session,local-prefs,grid-paint-prefs,editor-prefs,scene-image,sound-playback,video-playback,fog-reveal,mask-math}`、
`panels/scene/{transform,display}`，以及 `@dts/{document,grid,resources,renderer,protocol}`。

#### `services/`（13）

| 文件 | 行数 | 职责 | 对外导出 | 后端交互 |
|---|---|---|---|---|
| `project-api.ts` | 187 | 项目 HTTP 客户端；统一把非 2xx 的 `{error}` 转成 `Error`，204 返回 `undefined`；`readMetas` 一次拿全项目的素材 meta 原文，并把「盘上有、但读不出来」的那几个 ID 单独报回来（`unreadable`）。 | `projectApi`（含 `readMetas`）、`contentTypeFor`；类型 `ProjectSummary`、`ResourceTreeNode` | 见 §5.4.1 |
| `runtime-client.ts` | 328 | 编辑器↔服务端的 WS 运行态连接：只负责协议与连接，不含编辑态数据；含重连退避、稳定连接判定、close-code 翻译。 | `RuntimeClient`、`defaultEditorSocketUrl`、`reconnectDelayMs`、`describeSocketClose`、`CLOSE_PROTOCOL_MISMATCH`(4002)；类型 `RuntimeStatus`、`RuntimeLogEntry`、`RuntimeStateSnapshot`、`RuntimeHandlers` | `WS /editor` |
| `runtime-push.ts` | 115 | 运行态推送的**纯判定 + 去抖**：只在 run 且 WS open 且内容变了才推；子图的切分在解析时随载荷走（读 `AssetMetas` 索引，缺省空索引）。 | `RUNTIME_PUSH_DEBOUNCE_MS`(200)、`shouldPushScene`、`scenePayloadText(scene, metas?)`、`scenePayloadOf(scene, metas?)`、`projectSettingsPayloadText`、`ScenePushScheduler`；类型 `ScenePushDecision` | —（纯逻辑） |
| `sound-playback.ts` | 97 | 声音的**期望播放记账**（按层级，同层顶替）：不写文档、不进撤销。 | `emptySoundPlayback`、`withPlaying`、`withSoundPaused`、`withStopped`、`soundPlaybackResendPlan`；类型 `SoundPlaybackEntry`、`SoundPlaybackState` | — |
| `video-playback.ts` | 92 | 视频的期望播放记账（按对象，每个对象一条）。 | `emptyVideoPlayback`、`withVideoPlaying`、`withVideoPaused`、`withVideoStopped`、`videoPlaybackResendPlan`；类型 `VideoPlaybackEntry`、`VideoPlaybackState` | — |
| `video-blend-playback.ts` | 40 | 视频混合的期望播放记账（按对象；比视频多一项**两路素材快照**与声音来源 `none/a/b`）。 | `emptyVideoBlendPlayback`、`withVideoBlendPlaying`、`withVideoBlendPaused`、`withVideoBlendStopped`、`videoBlendPlaybackResendPlan`；类型 `VideoBlendPlaybackEntry`、`VideoBlendPlaybackState` | — |
| `bgm-playback.ts` | 99 | 全局背景音乐记账（全局一条；v16 起不属于项目设置），状态只有 `{clip, paused}`。 | `emptyBgmPlayback`、`withBgmPlaying`、`withBgmPaused`、`withBgmStopped`、`bgmResendPlan`、`bgmResendActions`；类型 `BgmPlaybackState`、`BgmAction`、`BgmResend` | — |
| `magnifier-window.ts` | 30 | 放大镜那扇前端窗的**记账**（全局一个对象 id；开 / 关各一条命令），只提供「前端刚连上时补发哪些」的判定——换图**不在**这里（那是文档数据，靠整份 `scene_push` 同步）。 | `magnifierWindowResendPlan` | — |
| `fog-reveal.ts` | 210 | 战争雾的**揭示记账**：记有序操作（擦除笔画 / 整区开合）而不是位图；提供分批下发判定、批次切分、补发计划、按当前文档剪枝。**视频混合借的是同一份**（操作那一档换成 `fill`：整张填 1 / 0，见 `video-blend-reveal.ts`）。 | `FOG_ERASE_BATCH_POINTS`(4)、`FOG_ERASE_BATCH_MS`(150)、`emptyFogReveal`、`entryOf`、`withEraseBatch`、`withRegion`、`shouldFlushBatch`、`splitStrokeBatch`、`fogRevealResendPlan`、`pruneFogReveal`；类型 `FogRevealPoint`、`FogRevealStroke`、`FogRevealOp`（`stroke` / `region` / `fill` 三档）、`FogRevealEntry`、`FogRevealState` | — |
| `video-blend-reveal.ts` | 46 | 视频混合的**擦除记账**：状态与批处理从 `fog-reveal.ts` **原样借**（同一套有序操作），自己只多一个「整张填」的构造器。 | `withVideoBlendFill`；并转出 `VideoBlendRevealPoint`、`VideoBlendRevealState`、`emptyVideoBlendReveal`、`withVideoBlendEraseBatch`、`videoBlendRevealResendPlan`、`pruneVideoBlendReveal` | — |
| `mask-math.ts` | 416 | 遮罩擦除的**像素运算**，逐字对齐 Unity 侧（`FogOfWar.cs` / `VideoBlend.cs` / `MaskImage.ApplyEraseStroke` / `MaskEraseStamp.shader`）。 | `MASK_PREVIEW_WIDTH`(960)、`MASK_BRUSH_RADIUS`(48)、`MASK_BRUSH_SOFTNESS`(1)、`MASK_BRUSH_RATIO`(0.05)、`VIDEO_BLEND_MASK_SOFTNESS`(0.5，视频混合要实心核才能真的擦到 0)、`previewMaskSizeFor`、`brushRadiusFor`、`applyEraseToPixels`、`strokeStampCenters`、`fillOpaqueMaskPixels`、`fillMaskAlpha`（整张填 1 / 0）、`fillFogMaskPixels`、`paintRegionPixels`；类型 `MaskPoint`、`MaskPixelColor`、`MaskColorOf` | — |
| `grid-paint-prefs.ts` | 104 | 网格标注偏好持久化（画笔类型/大小、每类显示开关与颜色、两个总开关）；逐项规范化。 | `defaultGridPaintPrefs`、`readGridPaintPrefs`、`writeGridPaintPrefs`、`parseGridPaintPrefs`；类型 `GridPaintPrefs` | localStorage `dts.editor.gridPaint` |
| `editor-prefs.ts` | 74 | 界面偏好持久化：当前变换工具 + BGM 弹框是否显示路径；认不出的工具名退回 `"none"`。 | `defaultEditorPrefs`、`readEditorPrefs`、`writeEditorPrefs`、`parseEditorPrefs`、`isTransformTool`；类型 `EditorPrefs` | localStorage `dts.editor.ui` |
| `local-prefs.ts` | 30 | 浏览器本地偏好读写的公共骨架（读：没有记录 / 内容损坏 / 存储不可用一律退回默认值；写：吞异常）——上面两份 prefs 的读写薄壳共用这一份。 | `readPrefs`、`writePrefs` | localStorage |
| `session.ts` | 39 | 只记「上次打开的项目名」，读写一律吞异常（隐私模式不能让编辑器打不开）。 | `readLastProject`、`writeLastProject`、`clearLastProject` | localStorage `dts.editor.lastProject` |
| `scene-image.ts` | 118 | 场景贴图加载器：按逻辑 ID 缓存 `HTMLImageElement`（绘制是 rAF 循环，不能在循环里发请求）；失败**不缓存**并给出原因；提供完成订阅与 `clearSceneImageCache()`（切项目释放）。 | `sceneImage`、`subscribeSceneImage`、`sceneImageError`、`clearSceneImageCache` | `GET /api/resources/raw?id=` |

#### `app/`（22）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `EditorShell.tsx` | 358 | 四区外壳（桌面三栏 / 紧凑抽屉）、启动引导 `bootstrapEditor`、**全局快捷键注册**、跨断点重置面板开合、按 store 开关渲染 11 个对话框；内部 `Drawer`。 | `EditorShell` |
| `MenuBar.tsx` | 385 | 顶部菜单（工程/场景/编辑/视图/运行）+ 顶栏右侧（紧凑开关、`BgmControl`、`ModeSwitch`、`ClientBadge`）。原则：**所有命令都必须能从菜单触发**。 | `MenuBar` |
| `StatusBar.tsx` | 98 | 底栏八个状态格：工程名、场景数、场景保存状态、工程保存状态、当前场景、已选数、当前工具、运行态与连接状态点；内部 `SAVE_STATE_LABELS`（含 `runtime: "运行中（不保存）"`）、`TOOL_LABELS`。 | `StatusBar` |
| `dialog-size.ts` | 138 | 弹窗尺寸计算（比例 0.8×0.86，夹 720×520 ~ 1680×1200，且不超过窗口 92%）与「按长宽比等比装进可用区域」（`fitBox` 的 React 版 `useFittedBox`：量实测尺寸、挂 ResizeObserver，三扇 Mask / 放大镜窗口共用）；`useViewportSize` 订阅 resize。 | `dialogSizeFor`、`fitBox`、`useFittedBox`、`useViewportSize`、`useDialogSize` |
| `ProjectDialog.tsx` | 177 | 新建/打开项目：列表带「N 个文件」与删除（`confirm`），创建成功即关闭，失败把 `project.error` 摆在框里。 | `ProjectDialog` |
| `SceneDialog.tsx` | 104 | 新建/重命名场景：场景名 = 文件名，失败原因就地显示。 | `SceneDialog` |
| `ObjectDialog.tsx` | 206 | 「新建对象」弹框：先选种类（实体/动作/事件）再选类型（正方形瓦片 + `kindMarkerColor` 色点），名字用 `nextObjectName` 预填去重。 | `ObjectDialog` |
| `ResourcePickerDialog.tsx` | 810 | 「从项目已有素材里挑一个」的**通用选择弹框**：三种 `kind` **同一套布局**（左 38% 文件列表 + 搜索 + 标签过滤行、右预览、底部状态栏 + 按钮），内容按 kind 换——`image` = 选贴图 / 精灵（选中 + 确认，预览里带精灵格网，`allowSprite` 控制切分面板，`onPick(image, sprite)` 图 + 格子一次交出；确认是因为写回要带宽高，尺寸是选中后异步读的）；`audio` / `video` = **选中一条 → 点「添加」加入并关闭（一次一条，重复添加由 store 去重兜底）**，选中即进右边预览、原生 controls 可直接**播放**（`<audio>` / `<video>`，选择器内试听 / 试看）。行上**不加徽标、不显示标签**（标签只留在搜索 / 过滤里用）；行首图标：音频 = 公用音符 `AudioIcon`，视频 = 后端首帧缩略图 `VideoThumb`（挂了兜底 `VideoFallbackIcon`）。统一从资源树取清单（音频多一层 `audioCatalog`），**搜索栏下都有标签过滤行**（AND，三种 kind 共用 `TagFilterRow`）；testid 全部由 `kind` 派生；内部 `ImagePickerBody` / `MediaPickerBody` / `mediaPickerRows` / `MEDIA_TEXTS` / `TagFilterRow` / `AudioIcon` / `VideoThumb` / `VideoFallbackIcon`。 | `ResourcePickerDialog`、`ResourcePickerKind` |
| `SpriteEditorDialog.tsx` | 179 | 独立的**精灵编辑器**（v23 新增）：列 / 行（1..64）、缩放、预览图上点格，草稿只在弹窗内变化，点「应用」才落到**素材 meta** 那条轨道（`setSpriteSheet`，1×1 按「恢复整图」处理）。 | `SpriteEditorDialog` |
| `AudioTagDialog.tsx` | 157 | 「选择标签」：给**任何素材文件**勾/去标签（`taggableAssets` + `allTagsOf` + `setAssetTags`，「N 个文件在用」跨图 / 声 / 视频全部计数），只勾选不新建；目标已经不在资源树里时什么都不做（不凭空造 orphan meta）。 | `AudioTagDialog` |
| `AudioTagEditorDialog.tsx` | 197 | 「标签」窗口：整数序号 `#0…#N` 预铺（`SLOTS_PER_PAGE` 16、`MAX_SLOTS` 32），只填名字，洞不画。 | `AudioTagEditorDialog` |
| `TeleportEditDialog.tsx` | 117 | 「传送目标」窗口：把项目场景勾成候选（整份新清单交 `setTeleportTargets`）；已失效的目标照列并标「已失效」。 | `TeleportEditDialog` |
| `GlobalSettingsDialog.tsx` | 110 | 「全局设置」：三档音量滑杆（`doc.settings.audio.*`，0..1 step 0.05）。 | `GlobalSettingsDialog` |
| `BgmControl.tsx` | 79 | 顶栏「音乐」按钮：显示当前在放什么/暂停标记/播放中高亮；导出 `bgmDeliveryHint`（与声音/视频**同一套措辞**的「已记录，等连上补发」提示）。 | `BgmControl`、`bgmDeliveryHint` |
| `BgmDialog.tsx` | 353 | 「背景音乐」弹框：项目音频清单（按显示名排序）+ 只搜名字/路径 + 标签勾选（AND）+ 路径显示开关 + 行选中跟随播放态 + 打开时滚到当前曲 + 底部播放/暂停·继续/停止。 | `BgmDialog` |
| `FogMaskDialog.tsx` | 435 | 「战争雾 Mask 窗口」：贴图底 + canvas 遮罩（960 宽、按贴图比例定高），软边圆刷擦除，右侧「整区开关」（雾区绑定 v25 起读独立的 `FogOfWar` 组件）；运行态下按批下发 `erase_mask` 轨迹、整区开关下发 `reveal_fog_region`；编辑态纯预览、不写文档不落盘。 | `FogMaskDialog` |
| `VideoBlendMaskDialog.tsx` | 384 | 「视频混合 Mask 窗口」：底图是 B 的缩略图（编辑器不解码视频）+ canvas 遮罩（同一张 960 宽、按素材像素尺寸定高），软边圆刷擦除（软边 0.5 有实心核）；右侧两个**「整张盖住（1）/ 整张擦开（0）」**按钮（走播放键那一档的样式：常态就有边框与底、hover 描强调色边框；按钮里那个**实心 / 空心小方块**是遮罩状态的提示）一次填满或清空；运行态下按批下发 `erase_video_mask`、整张按钮下发 `fill_video_mask`；编辑态纯预览、不写文档不落盘。 | `VideoBlendMaskDialog` |
| `GridEditDialog.tsx` | 459 | 「网格编辑窗口」：**唯一**的格子涂/擦入口，用同一渲染器 + `fitViewport` 把地图铺满窗口；指针捕获 + 补齐两事件点之间的格子（不断线）；「全部清除」可撤销。 | `GridEditDialog` |
| `MagnifierDialog.tsx` | 182 | 「放大镜窗口」：中间一张大图（`useFittedBox` 等比装进可视区）+ 下面一排**可以选的图**（点一张 = 换成展示它，写文档、可撤销）+ 底栏「在画面上打开 / 关闭画面」（只在运行态可用）；与前端那扇窗长得一样，差别就是「多这排小图 / 多这两个按钮」。关掉这扇窗**不**连带关前端那扇。 | `MagnifierDialog` |

#### `panels/`（6）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `LeftPanel.tsx` | 69 | 左栏两个页签（场景对象 / 资源）共用一栏，默认停「场景对象」。 | `LeftPanel` |
| `EmptyState.tsx` | 39 | 空状态占位：没项目时指路菜单；没场景时**占位本身是入口**（点一下弹新建场景）。 | `EmptyState` |
| `object-kinds.ts` | 133 | 对象类型表（实体/动作/事件）+ 可创建标记 + 中文展示名 + 「画内置徽标」判定；`kind` 是前端也认的字段，不造新值（v22 起精灵写 `Sprite`、贴图写 `Image`，基类 `GameObject` 只作**不可创建**的归类项留在表里，保证每个 kind 都有归属）。 | `OBJECT_CATEGORIES`、`DEFAULT_CATEGORY`、`KIND_LABELS`、`creatableObjects`、`categoryOfKind`、`badgeIconOf`；类型 `ObjectTypeDef`、`ObjectCategoryDef` |
| `asset-info.ts` | 149 | 按扩展名判断资源怎么显示：图标种类、可预览种类、人类可读类型名、去扩展名的显示名、字节可读化；**扩展名判断只此一处**；还给素材定 `<素材>.meta` 的导入器（`assetImporterKind`：图片 / 音频 / 视频 / 场景，`Assets/scenes/` 之外的 `.json` 不算素材）。 | `assetSuffix`、`assetIconKind`、`assetImporterKind`、`assetPreviewKind`、`assetKindLabel`、`assetDisplayName`、`formatSize`；类型 `AssetIconKind` |
| `asset-picker.ts` | 169 | 资源显示路径（剥掉 `project:`/项目名/`Assets/`）、按 id 查资源、按类别收图片/音频/视频、原始 / 缩略图 URL、（图集里某一格的 CSS `background-position`）。 | `assetDisplayPath`、`findAssetById`、`listImageAssets`、`listAudioAssets`、`listVideoAssets`、`assetRawUrl`、`assetThumbnailUrl`、`assetImageInfoUrl`、`spriteCellBackgroundPosition`、`spriteAssetId`、`parseSpriteAssetId` |
| `asset-image.tsx` | 53 | `<AssetImage image>`：把一份**图片引用**画出来——整张图（`background-size: contain`）或它图集里的**一格**（按几行几列放大 + `background-position` 挪过去）；长宽比取引用里声明的宽高，所以不必先加载图片量像素。与素材面板的精灵预览同一套算式。 | `AssetImage` |
| `audio-catalog.ts` | 289 | 音频清单 + 标注 + 标签表的**纯函数层**（BGM 弹框 / 选择音频 / 选择标签三处共用）：tag 是整数、名字住工程文件的表里，**显示名与标签 ID 从各素材自己的 `.meta`（`assetMetaTable`）读**（统一走 `assetNameOfMeta` / `assetTagsOfMeta`，任何素材都能起名打标签）；`taggableAssets` = 全部可打标签素材（图 / 声 / 视频）带解析好的标签，给「选择标签」框的跨类用量计数用；名字兜底链（文件显示名 → 文件名）、搜索、按标签 AND 筛、按名排序、标签用量与勾选项。 | `tagEntriesOf`、`tagNameOf`、`tagsOfClip`、`audioCatalog`、`taggableAssets`、`audioNameOf`、`audioDisplayName`、`matchesAudioQuery`、`filterAudioRows`、`sortAudioRowsByName`、`allTagsOf`、`tagOptionsOf`；类型 `AudioTagRef`、`AudioTagEntry`、`AudioCatalogRow`、`TaggableAssetRow` |

#### `panels/assets/`（2）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `AssetIcon.tsx` | 149 | 资源面板图标：内联 SVG（不用 emoji，跨设备一致）、`currentColor` 描边、一律 `aria-hidden`；文件夹开/合两种画法。 | `AssetChevron`、`FolderIcon`、`AssetFileIcon` |
| `AssetsPanel.tsx` | 759 | 资源面板（对齐 Unity Project）：根 = `Assets`，左目录树 + 右列当前目录直属内容；只读、不导入素材；场景文件点一下 = 打开场景；「打开目录」按选中项调后端；展开集合用 ref 做真源 + 懒滚动/定位。 | `AssetsPanel` |

#### `panels/hierarchy/`（1）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `HierarchyPanel.tsx` | 362 | 场景对象列表：种类过滤 + 关键字过滤、复制/删除、保存按钮与保存错误条；行内改名（双击）、激活/锁定切换、行尾提示（地图网格尺寸 / 声音层级 / 传送目标）。 | `HierarchyPanel` |

#### `panels/inspector/`（9）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `InspectorPanel.tsx` | 591 | 右侧属性面板**只剩「显示哪一屏」**：按「资源 > 对象 > 场景 > 项目」的优先级选择视图，对象那一屏按注册表渲染分组，并渲染底部的「添加组件」（`AddComponentMenu`）；资源那一屏顺手显示该素材的 `.meta` 摘要（导入设置、切分几格） | `InspectorPanel` |
| `registry.tsx` | 267 | **组件编辑器的注册表**：**一个组件一个组**（组 slug 跟着组件走、标题 = 组件 displayName），各组件的 `render` 与 `removable`（**可选组件**才在组头给「移除组件」，必需组件摘掉会把对象弄坏）；**数组顺序就是界面顺序**（e2e 断言它）。「基础」组（`OBJECT_EDITOR`）是实体属性组，另外声明；`componentEditorsFor` 只收「已挂上的组件 + 缺**必需**组件时的修复入口」——可选的（网格 / 视频）没挂上时**不出组**，由 `addableComponentsFor` 供面板底部的「添加组件」（Unity 式） | `EditorPanelDef`、`ComponentEditorDef`、`AddableComponentDef`、`OBJECT_EDITOR`、`COMPONENT_EDITORS`、`componentEditorsFor`、`addableComponentsFor` |
| `object-fields.tsx` | 789 | 对象字段的控件本体（从 `InspectorPanel.tsx` 拆出，纯搬运）：名称 / 激活 / 锁定 / **位置** / 缩放 / 单轴缩放 / 旋转 / 贴图（含**子图那一行**：`子图 第2行第3列（4×4）` + 「改回整图」，越界时挂「格子越界」提示；testid `texture-sprite` / `texture-sprite-out-of-range` / `clear-sprite`）/ 网格规格 / 每格像素 / 网格显示开关 + 它们的格式化与解析助手。**「显示顺序」已搬去描述符**（`object-spec.ts`），所以这里没有它 | `NameField`、`ActiveField`、`LockedField`、`PositionFields`、`ScaleField`、`ScaleAxisField`、`RotationField`、`TextureField`、`GridFields`、`CellSizeField`、`GridDisplayField`、`WORLD_ORIGIN_FALLBACK` 等 |
| `fields.tsx` | 252 | 属性面板的行/分组外壳与**播放类控件**：可折叠 `FieldGroup`（`data-group` 英文 slug；可选能力组件在组头多一枚「移除组件」= `onRemove`）、只读 `Field`、`FieldRow`（标签定宽 `w-20`，必须是行内第一个子元素）、`PlaybackRow`、`PlaybackStatus`、`PLAYBACK_BUTTON_CLASS` / `PLAYBACK_BUTTON_ACTIVE_CLASS`（高 34px、13px 字）。 | `FieldGroup`、`Field`、`FieldRow`、`PlaybackRow`、`PlaybackStatus`、`PLAYBACK_BUTTON_CLASS`、`PLAYBACK_BUTTON_ACTIVE_CLASS`；类型 `PlaybackState` |
| `SoundFields.tsx` | 360 | 声音对象的「声音」组：层级下拉（对象只给 `OBJECT_SOUND_LAYERS`，老文件的 `bgm` 照显并提示改）、音频小方块单选（每个带 `×` 移出）+ `＋` 添加（弹 `ResourcePickerDialog kind="audio"`：选中一条 → 点「添加」加入，一次一条）+ 「清空」、播放三键 + 状态行（多一档 `busy` = 本层被别的对象占着）；每条音频的显示名经 `audioDisplayName` 读（素材 `.meta` 顶层 `name`，唯一入口在文件属性）。 | `SoundFields`、`soundPlayBlockedReason`、`soundDeliveryHint` |
| `VideoFields.tsx` | 305 | 地图/贴图的「视频」组（**组件已挂上时才渲染**；没挂上时入口在面板底部的「添加组件」、移除在组头）、**循环 / 声音 / 自动播放三行由组件规格自动出行**（`descriptorRows(object, videoSpec, componentFields(...))`，见 `DescriptorRows.tsx`）、视频小方块单选（每个带 `×` 移出）+ `＋` 添加（弹 `ResourcePickerDialog kind="video"`：选中 → 「添加」，一次一条）+ 「清空」、播放三键 + 状态行；小方块的显示名同样读素材 `.meta` 顶层 `name`。 | `VideoFields`、`videoPlayBlockedReason`、`videoDeliveryHint` |
| `VideoBlendFields.tsx` | 317 | 贴图的「视频混合」组（同样**挂上才渲染**）：循环 / 声音 / 自动播放走规格自动出行；每路一行 = **「图片 / 视频」种类开关 + 「选择图片… / 选择视频…」（弹 `ResourcePickerDialog` 的 `image` / `video`）+ 当前素材 + `×` 清除**（换种类会清掉这一路已选的素材）；再加 Mask 入口与播放三键。 | `VideoBlendFields`、`blendPlayBlockedReason`、`blendDeliveryHint` |
| `registry.tsx` | 267 | **组件编辑器的注册表**：**一个组件一个组**（组 slug 跟着组件走、标题 = 组件 displayName），各组件的 `render` 与 `removable`（**可选组件**才在组头给「移除组件」，必需组件摘掉会把对象弄坏）；**数组顺序就是界面顺序**（e2e 断言它）。「基础」组（`OBJECT_EDITOR`）是实体属性组，另外声明；`componentEditorsFor` 只收「已挂上的组件 + 缺**必需**组件时的修复入口」——可选的（网格 / 视频）没挂上时**不出组**，由 `addableComponentsFor` 供面板底部的「添加组件」（Unity 式） | `EditorPanelDef`、`ComponentEditorDef`、`AddableComponentDef`、`OBJECT_EDITOR`、`COMPONENT_EDITORS`、`componentEditorsFor`、`addableComponentsFor` |
| `DescriptorRows.tsx` | 316 | **规格驱动的行渲染器**：按 `FieldDef.kind` 出行（布尔 / 数字 / 整数 / 字符串 / 多行文本 / 枚举），`FieldTarget` 抽象把「写哪份数据」与「这一行长什么样」分开——`componentFields(type)` 写组件 `data`、`objectFields` 写对象自身，**两种规格共用同一个渲染器**。`order` 排序、`testId` 直取描述符、`FieldRow` 外壳与「不被 store 回灌 / 非法值退回 / Esc 还原」三条约定与手写控件逐字一致。加一个简单字段 = 规格里加一行，这里不用动。 | `InspectorRow`、`FieldTarget`、`componentFields`、`objectFields`、`descriptorRows`、`sortInspectorRows` |
| `TeleportFields.tsx` | 105 | 传送阵的「传送」组：候选目标小方块 + `＋` 开「传送目标」窗口 + 「传送」按钮（不能传时按钮上写原因）。 | `TeleportFields` |
| `FogFields.tsx` | 150 | 战争雾编辑区（挂在独立的 `Fog` 对象上）：读写在它 `FogOfWar` 组件（`fogOf(object)`），第一行「引用地图」选择器，接着总开关（闸住整组），打开后给「指定雾区」小方块与「雾格子 → 编辑」入口。 | `FogFields` |
| `GridAnnotationFields.tsx` | 36 | 「区域」组里的一行入口：只留一个按钮打开 `GridEditDialog`。 | `GridAnnotationFields` |
| `MagnifierFields.tsx` | 184 | 放大镜的「放大镜」组：**图片**那一行（小方块单选 + 每个带 `×` 移出 + `＋` 弹 `ResourcePickerDialog kind="image" allowSprite`：只列精灵素材、可整张也可取一格）+ **窗口**那一行（「打开窗口」= 开编辑器那扇、运行态下同时投到前端；「关闭画面」只在这个对象正被投影时出现——前端那扇窗没有关闭按钮）。 | `MagnifierFields` |

> **加一个对象特性 = 在 `registry.tsx` 加一行 + 写一个字段组件**，不必回到面板 JSX 里插
> `kind === …` 判断。`InspectorPanel.tsx` 从 1,195 行降到 341 行就是这么来的。

#### `panels/runtime/`（1）与 `panels/scene/`（4）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `RuntimePanel.tsx` | 336 | 运行态面板：连接状态、开闸状态、前端镜像（谁连上/镜像哪个场景/对象数/同步时间 + 重新同步）、设置推送状态、资源包状态（文件数/字节/指纹/失败原因），以及可复制的日志列表。 | `RuntimePanel` |
| `ScenePanel.tsx` | 1,317 | 场景画布：rAF 绘制循环（每帧 `getState()` 直读）、指针手势（拖拽平移、滚轮/双指缩放、点空白取消选中并带 `CLICK_SLOP` 4px 抖动阈值、中键只平移）、拾取（按显示顺序从后往前）、手柄几何（绘制与命中**共用** `gizmoGeometryOf`）、手柄/本体拖拽、双击传送徽标 = 传送；建层时按 `displaySpriteOf(object, state.assetMetas)` + 图片**自然尺寸**算源矩形（子图只画那一块）；画布左上工具开关、场景切换条（1-9 序号 + `[`/`]`）、视口变换暴露为 `data-viewport-*` 供 E2E。 | `ScenePanel`、`checkerOriginOf`、`TOOL_OPTIONS` |
| `display.ts` | 112 | 对象在画布上占的世界矩形（显示/拾取/选中框/适配视图共用一份口径）：尺寸 = 贴图尺寸（无图用 `COLLIDER_SIZE` 64×64）× 该轴有效缩放；返回**未旋转**矩形，由消费方带 rotation。 | `COLLIDER_SIZE`、`displayRectOf`、`displaySizeOf`、`displayImageOf`、`sceneVisibleRects` |
| `grid-paint.ts` | 87 | 网格标注**绘制侧**纯工具：掩码 + 偏好 → 一串 CSS 颜色；RLE 按 `runs` 引用缓存的解码（坏数据返回空数组，绝不让绘制循环抛错）。 | `cellColorsOf`、`decodeCellsCached`、`countCellsWithMask` |
| `transform.ts` | 222 | 一次变换拖拽的纯计算：以「按下时的快照」为基准（不做逐帧累加）；Shift 吸附 15°。 | `resolveTransform`、`rotateIntoLocal`、`rotateOutOfLocal`、`ROTATION_SNAP_DEGREES`(15)；类型 `TransformStart`、`TransformResult` |

### 5.3 `state/` 详解（切片拆分后）

> 拆分前的 `editor-store.ts` 是 4,493 行；现在组装点 100 行 + 17 个切片（见 §5.2 的表）。
> 下面的状态与 action 清单**名字与拆分前完全一致**（契约检查：136 个 action + 48 个状态字段，
> missing 0 / extra 0），只是各自住在哪个文件变了；相对拆分那会儿多出来的 5 + 4 个，
> 全是 v23 / v24 的**素材 meta 那条轨道**（`assetMetas` / `assetMetaTable` / `metaSaveState` / `metaSaveError`
> 与 `applyMetas` / `saveMetasNow` / `flushMetaSave` / `ensureAssetMeta` / `setSpriteImportSettings`）。

#### 5.3.1 状态切片

| 分组 | 字段 |
|---|---|
| 模式 / 文档 | `mode`（`"edit" ｜ "run"`）、`doc`（`ProjectDoc`，镜像 `projectHistory.current`）、`scenes`（`readonly SceneDoc[]`，镜像 `sceneHistory.current`）、`activeSceneName` |
| 素材 meta（v23 起） | `assetMetaTable`（**真源表**：素材路径 ID → `<素材>.meta` 的内容，镜像 `metaHistory.current`）、`assetMetas`（**派生索引**：guid ↔ 路径两个方向，由 `metaHistory` 的订阅重建，读的地方一律用它） |
| 历史 | `canUndo`、`canRedo`、`undoLabel`、`redoLabel` |
| 选区 | `selectedObjectIds: readonly string[]`、`selectedAssetId: string ｜ null`（两者互斥） |
| 视口 | `viewport: Viewport`、`viewportSize: {width,height}` |
| UI 偏好 | `ui: EditorUiState` = `{ leftOpen, rightOpen, runtimeOpen, tool, bgmPaths }`、`bootstrapped` |
| 运行态镜像 | `runtime: RuntimeUiState` = `{ status, runtimeActive, client, scene, resources, settings, logs, lastError }` |
| 项目 | `project: ProjectUiState` = `{ list, current, tree, busy, error }` |
| 对话框 / 窗口 | `projectDialog`、`sceneDialog`、`objectDialog`、`imagePicker`+`imagePickerTarget`、`soundEditor`+`soundEditorTarget`、`teleportEditor`+`teleportEditorTarget`、`videoEditor`+`videoEditorTarget`、`globalSettings`、`bgmDialog`、`audioTags`、`fogMask`+`fogMaskTarget`、`gridEditor`+`gridEditorTarget` |
| 落盘状态 | `sceneSaveState`+`sceneSaveError`、`projectSaveState`+`projectSaveError`、**`metaSaveState`+`metaSaveError`**（v23 起；三份文件各一套，`SceneSaveState = "saved" ｜ "pending" ｜ "saving" ｜ "error" ｜ "runtime"`） |
| 网格偏好 | `gridPaint: GridPaintState` = `{ mask, brushSize, hiddenMask, colors, showGridLines, showAnnotations }` |
| 运行态记账 | `soundPlayback`、`videoPlayback`、`bgmPlayback`、`fogReveal`（**都不写文档、不进撤销栈**） |
| 拖拽快照 | `transformStart: TransformStart ｜ null` |

#### 5.3.2 action 按功能分组

**通用编辑 / 历史**：`applyScenes(label, recipe, {coalesceKey})`、`applyProject(label, recipe, {coalesceKey})`、`applyMetas(label, recipe, {coalesceKey})`（**三条轨道各一个唯一写入口**；每次都把「最近改过哪条轨」记下来，撤销才作用得对）、
`undo()` / `redo()`（作用在「最近改过的轨道」，**三条轨道**跨轨时清对方 redo 栈）、`resetDoc(doc)`（三份历史一起重置）。

**场景**：`setActiveScene`、`openScene`、`openSceneByIndex`、`openAdjacentScene`（到端点返回 false，**不循环**）、
`loadScenes`（重扫 `Assets/scenes/`、`compareSceneNames` 排序、旧格式回写一次）、`openSceneDialog`、
`createScene`、`renameScene`（只改文件名 + 同步**同名贴图**引用（网格地图的 `ImageLayer`），不动精灵）、`deleteScene`（至少保留一个）、
`saveSceneNow`、`flushSceneSave`；`switchScene(name, {clearAssetSelection?, log?})` 是切场景的**唯一路径**。

**工程文件**：`saveProjectNow`（没有 flush：改动全走去抖定时器，见 `save-slice.ts` 头注）。

**项目**：`bootstrapEditor`（幂等 + `bootstrapping` 同步占位挡 StrictMode 双跑）、`openProjectDialog`、
`refreshProjects`、`createProject`、`openProject`（读 `project.json` → `clearSceneImageCache()` → `resetDoc` →
旧格式迁移（内联场景落文件 / 缺 `settings` 回写）→ `refreshTree` → `loadScenes` → `writeLastProject`）、
`closeProject`、`deleteProject`、`refreshTree`、`createFolder`、`openProjectFolder`、`uploadFiles`、`deleteResource`。

**对象**：`setSelection`、`selectAsset`、`createObject(kind, name, position?)`（对象数据由 `game-object-factory.ts`
按 `ObjectKind` 选择工厂；地图按同名约定取
`Assets/images/<场景名>.png` 并 `gridSizeFromImage`）、`renameObject`、`setObjectActive`/`toggleObjectActive`、
`setObjectLocked`/`toggleObjectLocked`、`setRenderSortingOrder`、`setObjectScale`、`setObjectScaleAxes`、
`setObjectRotation`（收弧度，面板按度）、`deleteObjects`（顺手关掉指向被删地图的窗口）、
`duplicateObjects`（「副本」后缀 + `COPY_OFFSET` 24 递增偏移）、`moveObject`（**全项目唯一移动入口**，锁定直接拒）、
`setMapGrid`、`openObjectDialog`、`openImagePicker`。

**精灵（子图）**：`setObjectImageSprite(objectId, image, sprite)`（「选择贴图 / 精灵」窗口确定那一下：
**图 + 格子一次写进去 = 一条撤销记录**；对象取哪一格只有这一条写入路径）、`setSpriteSheet(imageId, sheet)` / `setSpriteImportSettings(imageId, settings)`
（改的是**那个素材自己的 `.meta`** 那条轨道——v23 起，`coalesceKey: sprite-sheet:<图片 ID>` 合并连续输入；
**不动任何对象**——「改切分，引用它的对象一起变」是解析出来的，见 §3.2.6）、`ensureAssetMeta(imageId)`
（挑图 / 引用图片时拿身份：没有 meta 就现建一份，把新 guid 写进 `ImageRef`）。

**变换（手柄 / 本体拖拽）**：`setTool`、`setBgmPaths`、`beginObjectTransform`（`tool==="none"`、未落位、锁定都返回 `undefined`）、
`applyObjectTransform`（pos/rot/scale 一次写完，`coalesceKey: transform:<id>`）、`endObjectTransform`、
`cancelObjectTransform`（用快照写回 + 收尾）。

**视口**：`zoomAtScreen`、`panByScreen`、`fitToViewport`、`setViewportSize`（未被用户调过视口时自动适配）、`setUi`。

**运行态 / 连接**：`connectRuntime`、`setMode`（run：展开运行面板 + 未连上则记 `pendingRunRequest` 并踢一次连接；
edit：取消去抖、`lastPushedSceneText=null`、发 `runtime_stop`）、`pushRuntimeScene`、`clearRuntimeLogs`。

**声音**：`playSound`、`stopSound`、`pauseSound`、`resumeSound`、`flushSoundPlayback`、
`addSoundClip`（已在列表就不抢选中）、`removeSoundClip`、`selectSoundClip`、`clearSoundClips`、
`setSoundLayer`。

**视频**：`playVideo`、`pauseVideo`、`resumeVideo`、`stopVideo`（停止**不要求**仍选中）、`flushVideoPlayback`、
`addVideoClip`、`removeVideoClip`、`selectVideoClip`、`clearVideoClips`、`setVideoLoop`。

**组件（可选能力的添加 / 移除）**：`addObjectComponent`、`removeObjectComponent`（面板底部的 Add Component
与组件头的移除；按组件类型分派，网格 / 视频共用这一对）。

**背景音乐**：`playBgm`（再点同一首 = 让前端从头重播）、`pauseBgm`、`resumeBgm`、`stopBgm`、
`flushBgmPlayback`、`openBgmDialog`、`openGlobalSettings`。

**素材文件标注（素材级数据，走 meta 轨）**：`setAssetName`（任何素材：写 `<素材>.meta` 顶层 `name`，
`coalesceKey: asset-name:<id>`）、`setAssetTags`（整份替换顶层 `tags`，按工程文件里的标签表归一化；离散、不合并）。

**标签表（项目级数据，仍在工程轨）**：`setAudioTagName`、`openAudioTags`
（「哪个文件用了这个标签」在 meta 轨那边：删标签要两条轨道各做一次——命令层的 `deleteAudioTag` 只动表，
摘引用那一半是 `withoutMetaAudioTag`）。

**全局音量**：`setBgmVolume`、`setSfxVolume`、`setVoiceVolume`（各自 `coalesceKey`）。

**传送**：`setTeleportTargets`、`setTeleportPicked`、`openTeleportEditor`、`teleport(objectId)`
（四种拒绝理由写运行日志；成功则 `switchScene(target, …)` + 一条带来源的日志；**不改文档、不进撤销栈**）。

**网格标注**：`setGridBrush`、`setGridBrushSize`（夹 1..5）、`toggleGridTypeVisible`、`setGridTypeColor`、
`setGridLinesVisible`、`setGridAnnotationsVisible`（以上六项同步写本地偏好）、`paintGridStroke`（`coalesceKey: paint:<id>`）、
`endGridStroke`、`clearGrid`。

**战争雾**：`openFogMask` / `openGridEditor`（两者**互斥**）、`setFogMap`、`setFogRegions`、`setFogEnabled`、
`eraseFogMask`、`setFogRegionRevealed`、`flushFogReveal`（先 `pruneFogReveal` 按当前文档剪枝，再逐步重放）。

#### 5.3.3 文件级导出的辅助函数

| 导出 | 说明 |
|---|---|
| `sceneHistory` / `projectHistory` / `metaHistory` | 三份 `DocumentHistory`（limit 200）：场景列表 / 工程文件 / 素材 meta（v23 起；键 = 素材的路径 ID） |
| `fitSceneViewport(scenes, activeSceneName, size)` | 只缩不放（`max: 1`）、四周 24px 边距；「复位 / 视图→适配视口 / 首次量到尺寸」三处**唯一**的视野算法 |
| `serializeSceneFile(scene)` | `collapseScale` 后两空格缩进 + 末尾换行；按对象引用 `WeakMap` 缓存；**场景名不进文件** |
| `serializeProjectFile(doc)` | 写 `formatVersion: DOCUMENT_FORMAT_VERSION`，同缩进/换行 |
| `compareSceneNames(a, b)` | `localeCompare(…, "zh-Hans-CN", { numeric: true })`（`第10幕` 排在 `第2幕` 之后） |
| `findResourceNode(nodes, match)` | 资源树递归查找 |

#### 5.3.4 持久化与自动落盘

- **localStorage 只有 3 个 key，全经 services**：`dts.editor.lastProject`、`dts.editor.ui`、`dts.editor.gridPaint`。
  **运行态与文档一律不落 localStorage。**
- **防抖自动落盘**：`SCENE_SAVE_DEBOUNCE_MS = 800`，场景、工程文件、素材 meta 各一个计时器。
  三条历史的 `subscribe` 每次变更做四件事：① 同步 `scenes`/`doc`/`assetMetaTable`/撤销标记（meta 轨那一条还顺手重建 `assetMetas` 索引）；
  ② `scheduleRuntimePush()` / `scheduleSettingsPush()`（仅 run + WS open）；③ **运行态下把保存状态设为 `"runtime"` 并直接返回（不写盘）**；
  ④ 否则与 `savedScenes` / `savedProjectText` / `savedMetas` 比内容，脏才置 `pending` 并在 800ms 后写。
  **工程轨与 meta 轨的 `subscribe` 里也各调了一次 `scheduleRuntimePush()`**（工程轨 v20、meta 轨 v23）：
  设置与切分都参与场景载荷的解析，它们一变场景就该重推（§5.4.3）；文本比对保证
  「改的是别的项目级 / 素材级数据」时一个字节都不发。
- **落盘状态机**：`saved → pending → saving → saved / error`；`saveSceneNow` 只写真正脏的场景；
  `saveMetasNow` 只写内容变过的那几份 meta（一个素材一个文件，切一张图不该碰别的素材的盘）；
  失败写 `sceneSaveError` / `metaSaveError` 并进运行日志。
- **运行基线**：`runBaseline` 存 `{scenes, activeSceneName, doc, metas}` **引用**（immer 不可变，存引用即可）；
  `rememberRunBaseline` / `snapshotRunBaseline` / `refreshRunBaseline`（文档整份换掉时跟随）/
  `restoreRunBaseline`（三份历史 `reset` + 清掉已不存在的选中 id + 一条日志）。
- **运行态镜像保护**：WS 非 open 时清 `client`/`scene`（避免过期「已连接」），但**不动 `runtimeActive`**
  （它是服务端门控状态）；`editor_state` 回来时以服务端为准切 `mode`，`false→true` 跳变时补推场景与设置，
  `true→false` 时还原基线并清 `fogReveal`/`videoPlayback`/`bgmPlayback`。
  四份记账都在「前端刚连上（`wasClientConnected=false → true`）」那一刻补发。
- **日志**：`MAX_LOGS = 200`，`makeLog` 用模块级 `logSeq` 生成 `log_<n>`，时间 `toLocaleTimeString("zh-CN", {hour12:false})`。
- **静默命令**：`quietCommandIds` 登记战争雾拖动批次的 requestId，**成功回执不写日志**（失败照写）。

### 5.4 `services/` 详解

#### 5.4.1 HTTP（`project-api.ts`）

`request<T>(input, init)` 统一处理：网络异常 → `无法连接服务端：<msg>`；非 2xx → 优先取 body 的 `{error}`，
否则 `status statusText`；204 → `undefined`。

| 方法 | HTTP |
|---|---|
| `projectApi.list()` | `GET /api/projects` |
| `projectApi.create(name)` | `POST /api/projects` |
| `projectApi.remove(name)` | `DELETE /api/projects?name=` |
| `projectApi.tree(name)` | `GET /api/projects/tree?name=` |
| `projectApi.readMetas(name)` | `GET /api/projects/meta?name=`（一个项目**全部素材的 `.meta` 原文**，键是素材逻辑 ID；坏 JSON 的进 `unreadable`，两者都交回调用方） |
| `projectApi.createFolder(project, path)` | `POST /api/projects/folder` |
| `projectApi.reveal(name, target = "", selectFile = false)` | `POST /api/projects/reveal` |
| `projectApi.readText(id)` | `GET /api/resources/text?id=` |
| `projectApi.writeText(id, text)` | `PUT /api/resources/text?id=` |
| `projectApi.uploadBinary(id, data, contentType)` | `PUT /api/resources/raw?id=` |
| `projectApi.deleteResource(id)` | `DELETE /api/resources/raw?id=` |
| `projectApi.renameResource(from, to)` | `POST /api/resources/rename` |

`contentTypeFor(fileName)` 映射 png/jpg/jpeg/webp/gif/json/txt+md/mp3/ogg/wav/mp4/webm，兜底 `application/octet-stream`。
贴图/预览另有两处直接用 `GET /api/resources/raw?id=`：`scene-image.ts` 与 `assetRawUrl`。

#### 5.4.2 WebSocket（`runtime-client.ts`）

- **URL**：`defaultEditorSocketUrl()` = `ws(s)://${window.location.host}/editor`（同源；开发期由 Vite 代理）。
- **发送**：`editor_hello{protocolVersion}` → `editor_refresh`（open 时各一次）→ `runtime_start` / `runtime_stop` /
  `scene_push{scene ｜ null}` / `settings_push{settings ｜ null}` / `editor_command{requestId, command}`。
  `sendCommand` 的 requestId 由 `createRequestId(kind === "play_sound" ? "snd" : "cmd")` 生成；
  socket 非 OPEN 时 `onError("编辑器未连接到服务端")`。
- **接收**：`editor_state` → `onState`；`editor_command_result` → `onCommandResult`；`editor_log` → `onServerLog`；
  `editor_error` → `onError`；解析失败也走 `onError`。
- **重连与退避（核心行为）**：
  - `reconnectDelayMs(attempt, jumpToMax?)`：`500 * 2**attempt`，**封顶 10 000ms**；
    `jumpToMax` 只在 `close.code === 4002`（协议版本不一致）时给——「别拿 500ms 去捶一个注定拒绝你的服务端」。
  - **稳定连接判定**：`open` 时起 `STABLE_CONNECTION_MS = 3000` 定时器，**活满 3s 才把 `reconnectAttempt` 清零**；
    否则会出现「连上 → 立刻被踢 → 500ms 再连」的死循环。`clearStableTimer()` 在断开 / 重连时都要清。
  - `connect()` 幂等（OPEN/CONNECTING 直接返回）；`new WebSocket` 抛错 → `onStatus("error")` + 排重连。
  - `describeSocketClose(code, reason)` 把断开翻成人话（4002 → 「服务端要重启」；1006 → 「多半是服务端没在跑」；
    1005 → 「服务端关闭了连接」），**store 会把它整句写进运行日志**。
  - `onOpen()` 在 WS 建立（含重连）后调一次，store 据此补发「用户点过运行但当时没连上」的 `runtime_start`。

#### 5.4.3 运行态推送（`runtime-push.ts`）

- `RUNTIME_PUSH_DEBOUNCE_MS = 200`；
- `shouldPushScene({mode, connected, lastPushed, next})`：**只在 `run && connected && lastPushed !== next` 时推**；
- `scenePayloadText(scene, metas?)` = `JSON.stringify(resolveSceneSprites(scene, metas))`——
  用 stringify 而不是 `serializeSceneFile`：后者是文件格式、**不含场景名**，而运行态切场景也要算一次变更；
- `scenePayloadOf(scene, metas?)` = 同一份解析的**对象**（`scene_push` 发的是它），
  所以「发出去的」与「比过的」不可能是两份不同的数据；`metas` 是**素材 meta 索引**（`AssetMetas`，缺省空索引）：
  子图引用上只写着「第几格」，「几行几列」必须解析进载荷（前端没有 `.meta`），见 §3.2.6；
- `ScenePushScheduler` 提供 `schedule` / `flush` / `cancel`；store 里实例化**两个**调度器
  （场景 + 全局设置），回调在触发时**重新读一次当前文档**（比排队时更新）再决定推不推；
  进运行态/重连时用 `flush` 补全量。

#### 5.4.4 播放记账（sound / video / bgm）

三者同一套骨架：**运行态记账 + 尽力下发 + 前端刚连上补发**，差别只在「归属」。

| 服务 | 记账归属 | 关键语义 |
|---|---|---|
| `sound-playback` | **按层级**（`layers: Record<layerSlug, {...}>`） | 没有某个 key = 该层应当停着；同层顶替；`withSoundPaused` 对不在记账里的层原样返回（调用方据此判断「这一下有没有意义」） |
| `video-playback` | **按对象** | 同一个对象再点别的就顶替；暂停是记账里的一档状态 |
| `bgm-playback` | **全局一条** | 状态只有 `{clip, paused}`；再点同一首 = 重置为 `{clip, paused:false}`（从头重播） |

- `*ResendPlan({wasClientConnected, isClientConnected, playback})` **只在 `false→true` 那一刻**返回要补发的条目
  （已连着不重发，因为 `editor_state` 快照到得很频繁）；
- 补发时暂停态都是「**先 play 再 pause**」（否则前端从头响）；
- **切场景 / 换项目时的清理规则（不变量）**：`switchScene` 清 `soundPlayback` + `videoPlayback`
  （并在真正换场景时**先逐条静默 `stop_video`**——客户端把上一场景整棵子树 `SetActive(false)` 后，
  开了声音的视频还会继续响）；`fogReveal` 与 `bgmPlayback` 切场景**不清**（雾按地图对象记、BGM 是全局）；
  关闸清 `fogReveal` + `videoPlayback` + `bgmPlayback`；`resetDoc` 四份全清；
- **未连上时的记账语义**：下发前先判「编辑器没连服务端」再判「前端没连」，两种都只写日志不发命令，
  并在 tooltip 里说清「连上后自动补发」。

### 5.5 面板与对话框的绑定关系

| 面板 | 绑定的 store 状态 / 动作 | 用户可见功能 |
|---|---|---|
| `LeftPanel` | 局部 state `tab`（默认 `hierarchy`） | 左栏两个页签，顺序「场景对象在前、资源在后」 |
| `HierarchyPanel` | `scenes`/`activeSceneName`/`selectedObjectIds`/`sceneSaveState`/`sceneSaveError` → `setSelection`、`renameObject`、`deleteObjects`、`duplicateObjects`、`toggleObjectActive`、`toggleObjectLocked`、`saveSceneNow` | 对象列表：种类过滤 + 关键字过滤、行内改名、眼睛/锁、删除、保存按钮与失败条 |
| `AssetsPanel` | `project`(current/tree/error/busy)、`selectedAssetId`、`activeSceneName` → `refreshTree`、`openProjectFolder`、`selectAsset`、`openScene` | Unity Project 式只读浏览器；点场景文件即打开场景；「打开目录」在**服务端机器**上开文件管理器 |
| `InspectorPanel` | 见 §5.3.2 的字段动作 + `doc`/`project`/`scenes`/选区 | 一个窗口回答四种对象：资源 / 对象 / 场景 / 项目 |
| `SoundFields` / `TeleportFields` / `FogFields` / `GridAnnotationFields` | `soundPlayback` + 各自字段动作 | 属性面板内的分组内容（声音、传送、战争雾、网格标注入口） |
| `VideoFields` + `DescriptorRows` + `AddComponentMenu` | `videoPlayback` + 播放三键走各自的字段动作；**添加 / 移除组件走 `addObjectComponent` / `removeObjectComponent`**（底部 Add Component + 组头移除）；**循环 / 声音 / 自动播放走 `setComponentField`**（键与 testid 来自 `component-specs/video.ts`） | 视频组：自定义行 + 规格自动出行混排（按 `order`）；底部「添加组件」入口 |
| `RuntimePanel` | `mode`、`runtime`、`scenes`/`activeSceneName` → `pushRuntimeScene`、`clearRuntimeLogs` | 运行态四行状态 + 可复制日志 |
| `ScenePanel` | `activeSceneName`、`viewport`、`viewportSize`、`scenes`、`selectedObjectIds`、`gridPaint`、`soundPlayback`、`ui.tool`；动作见 §5.3.2 | 画布：绘制/拾取/多选/手柄变换/缩放平移/双击传送/工具开关/场景切换条 |
| `MenuBar` / `StatusBar` | 见 §5.2 各行 | 全部命令的菜单入口（平板无键盘）/ 底栏八个状态格 |
| `EmptyState` | `project.current`、`openSceneDialog` | 没项目 / 没场景的占位；没场景时占位可点 |

对话框绑定：`ProjectDialog` → `project`/`projectDialog`；`SceneDialog` → `activeSceneName`/`sceneDialog`；
`ObjectDialog` → `objectDialog`；`ResourcePickerDialog`（kind=image 挑图 + 取一格）/ `SpriteEditorDialog`（精灵切分）→
`imagePickerTarget`/**`assetMetas`（读切分与导入设置）**/`setSpriteSheet`；
声音 / 视频的 `ResourcePickerDialog`（kind=audio / video，添加素材）由**属性面板**各自挂本地开关（`SoundFields` / `VideoFields`），
清单管理（单选 / `×` 移出 / `clearSoundClips` / `clearVideoClips`）也在面板里，没有编辑窗口；
`TeleportEditDialog` → `teleportEditor(Target)`；`GlobalSettingsDialog` → `doc.settings.audio`；
`BgmControl`+`BgmDialog` → `bgmDialog`/`bgmPlayback`/`ui.bgmPaths`/`assetMetaTable`（清单的显示名与标签）；
`AudioTagEditorDialog`+`AudioTagDialog` → `audioTags`/`doc.audioTags`（标签表）+ **各素材的 `assetMetaTable`**（勾了哪些标签，任何素材都能打）；
`FogMaskDialog` → `fogMask(Target)`/`eraseFogMask`/`setFogRegionRevealed`；
`GridEditDialog` → `gridEditor(Target)`/`gridPaint` 系列。

### 5.6 UI 约定与跨文件不变量

**`data-testid` 约定**：全小写 kebab-case；`data-testid` 给「区域/容器」，`data-*` 给「状态与标识」。

- 作用域锚点：`menu-bar`（菜单栏与属性面板可能同名，测试必须按区域找）、`object-properties`、`asset-properties`、
  `project-properties`、`field-group`/`field-group-header`/`field-group-body` + `data-group`
  （英文 slug：`basic`/`render`/`sound`/`teleport`/`edit`/`fog`/`video`/`scene`/`asset`/`project`）、
  `runtime-*`、`sprite-*`（切分面板与预览格）、`scene-viewport`、`scene-bar`、`object-tree`、`folder-tree`/`folder-contents`/`folder-breadcrumb`；
- 行级 `data-*`：`data-name`/`data-kind`/`data-selected`/`data-active`/`data-locked`/`data-clip`/`data-tag`/
  `data-id`/`data-path`/`data-type`/`data-icon`/`data-added`/`data-checked`/`data-missing`/`data-bound`/
  `data-shown`/`data-paused`/`data-playing`/`data-state`/`data-mode`/`data-index`/`data-scene`/`data-tool`/
  `data-group`/`data-open`/`data-blocked`/`data-warning`/`data-count`；
- 切换类控件统一 `aria-pressed` + `data-selected`/`data-active`；`FieldGroup` 表头用 `aria-expanded`。

**共享 CSS 类常量（改一处即全站变）**：

- `styles/index.css` 的 `@utility panel / panel-header / toolbar-button / toolbar-button-hover`；
  颜色一律 `var(--color-editor-*)`；
- `.asset-row-button`（`min-height: 0 !important`）专治「粗指针 32px 规则把资源面板行撑成大按钮」；
- `.editor-sound-bars` + `@keyframes editor-sound-wave`：纯 CSS 播放指示（无 JS 定时器），
  `prefers-reduced-motion` 下不动；
- `panels/inspector/fields.tsx` 的 `PLAYBACK_BUTTON_CLASS` / `PLAYBACK_BUTTON_ACTIVE_CLASS`
  被 `SoundFields`、`VideoFields`、`BgmDialog` **三处共用**。

**「运行态不落盘」规则（最硬的一条，七个落点）**：

1. `scheduleSceneSave` / `scheduleProjectSave` / `scheduleMetaSave`：运行态下把状态设成 `"runtime"` 并**直接 return**，不排计时器；
2. `saveSceneNow` / `saveProjectNow` / `saveMetasNow`：运行态下清计时器、置 `"runtime"`、写一条说明日志、返回 `false`；
3. 状态文案唯一来源 `StatusBar.SAVE_STATE_LABELS.runtime = "运行中（不保存）"`；菜单项同步禁用；
4. 场景的**文件级**操作（`createScene` / `renameScene` / `deleteScene`）运行态一律拒绝并给理由；
5. 运行期间的文档改动**不入历史**：`restoreRunBaseline()` 用**三份历史** `reset` 整体还原；
6. `refreshRunBaseline()` 在文档整份被换掉（打开/关闭项目、`loadScenes`）时重拍基线；
7. 素材 meta（切分 / 导入设置 / 音频标注）与场景、工程文件同一套：运行态下 `metaSaveState = "runtime"`，退出运行由基线整体还原。

**其它可验证的不变量**：

- **单一入口**：`switchScene` 是切场景的唯一路径；`moveObject` 是唯一移动入口（锁定护栏只放这一处）；
  `applyScenes` / `applyProject` / `applyMetas` 分别是场景轨、工程轨与素材 meta 轨的唯一写入口；
- **三份文件、一个撤销入口**：`lastEditTrack` + `activeTrack(action)` 决定撤销作用在哪条轨（`scenes` / `project` / `metas`），跨轨时清对方 redo 栈；
- **中文只在三处集中**：`panels/object-kinds.KIND_LABELS`、`StatusBar` 的 `SAVE_STATE_LABELS`/`TOOL_LABELS`、
  `@dts/document` 的 `SOUND_LAYER_LABELS`；
- **扩展名判断只有一处**：`panels/asset-info.ts`（`assetImporterKind` 也共用它这张表）；
- **标签 / 显示名兜底链只有一处**：`panels/audio-catalog.ts`（对象自己的名字 → 素材 `.meta` 里的显示名 → 素材文件名）；
- **几何只有一份**：`display.displayRectOf`（显示/拾取/选中框/适配视图）、`ScenePanel.gizmoGeometryOf`（绘制与命中）；
- **就地编辑输入框统一模式**：`draft` state + `useEffect` 同步（用 `document.activeElement !== inputRef.current`
  判「正在输入的框不被 store 回灌」）+ Enter/失焦提交 + Esc 还原 + 提交后回填文档实际采用的值；
- **弹窗尺寸与层级**：`dialogSizeFor` / `useDialogSize` 只被 `FogMaskDialog` 与 `GridEditDialog` 使用；
  嵌套模态固定两层（内层遮罩 `z-[60]`、内容 `z-[70]`），普通对话框 `z-40`/`z-50`；
  `AudioTagDialog` 与 `AudioTagEditorDialog` 在 `onEscapeKeyDown` 里判断焦点在 `INPUT` 上时只还原那一格、不关窗口；
- **视口记忆规则**：`sceneViewports: Map<string, Viewport>` **只在本次会话内有效、不落盘**；
  `viewportAdjusted` 记录用户是否手动调过视口——未调过时 `setViewportSize` 会重新 `fitSceneViewport`；
- **快捷键注册位置**：唯一在 `EditorShell.tsx` 的一个 `window.addEventListener("keydown")` effect 里。
  键位：`Ctrl/⌘+S` 保存场景（输入框里也生效）、`Ctrl/⌘+Shift+N` 新建对象、`Q/W/E/R` 切变换工具、
  `Escape` 取消变换、`1`-`9` 直选场景、`[`/`]` 上下场、`Ctrl/⌘+D` 复制、`Ctrl/⌘+Z` 撤销、
  `Ctrl/⌘+Shift+Z` 与 `Ctrl/⌘+Y` 重做、`Delete`/`Backspace` 删除。**每一项都必须同时能从菜单触发**；
  不用 `Ctrl+数字`（浏览器标签页占用）；
- **数值常量**：`SCENE_SAVE_DEBOUNCE_MS` 800、`RUNTIME_PUSH_DEBOUNCE_MS` 200、`FOG_ERASE_BATCH_POINTS` 4、
  `FOG_ERASE_BATCH_MS` 150、`ROTATION_SNAP_DEGREES` 15、`COPY_OFFSET` 24、`CLICK_SLOP` 4、`MAX_DPR` 2、
  `VIEW_PADDING` 12、`MAX_LOGS` 200、`STABLE_CONNECTION_MS` 3000、`MAX_RECONNECT_DELAY_MS` 10000、
  `CLOSE_PROTOCOL_MISMATCH` 4002、`MASK_PREVIEW_WIDTH` 960、`MASK_BRUSH_RADIUS` 48、`MASK_BRUSH_RATIO` 0.05、
  `VIDEO_BLEND_MASK_SOFTNESS` 0.5、`SLOTS_PER_PAGE` 16、`MAX_SLOTS` 32、`SPRITE_SHEET_MAX` 64、历史 `limit` 200；
- **编辑器不导入素材**：`src` 下没有任何 `<input type="file">`；素材由外部提交到 `Assets/`，编辑器只读、只引用；
  `uploadFiles` 是唯一写入资源的入口且只在 store 里（当前无 UI 调用点）；
- **E2E 可见性契约**：`data-viewport-scale/-tx/-ty` 暴露在 `scene-viewport` 上（用例要精确点手柄就必须知道
  世界原点落在屏幕哪儿——「画布中心 = 世界原点」是错的，面板会挤窄画布）；
  `FieldRow` 的标签必须是本行第一个子元素（用例按 `xpath=../../../span[1]` 取）；
  资源图标各带 `data-icon`（`chevron` / `folder` / 文件类型名）——一行里可能同时有展开三角与类型图标，
  用例**按 `data-icon` 断言而不是按 `svg` 条数**（后者每加一枚装饰图标就会假红）；
- **日志可带走**：`#root` 全局 `user-select: none`，但运行日志区显式 `select-text` 并提供「复制」按钮；
- **运行态与文档物理隔离**：`runtime`、`soundPlayback`、`videoPlayback`、`bgmPlayback`、`fogReveal`、
  `transformStart` 都不在 `doc`/`scenes` 里，也都不进撤销栈。唯一例外是被**显式声明为文档数据**的
  `map.fog.enabled/regions`、`video.enabled/loop/audio`、`sound.layer`、`settings.audio.*`
  ——它们决定前端行为，不能只记在浏览器本地。

---

## 6. 文档版本、迁移与两套 schema 的差异

### 6.1 版本演进

`DOCUMENT_FORMAT_VERSION = 30`，`PROTOCOL_VERSION = 21`。两者**独立编号**，只有不兼容的 wire 改动才会让协议 +1：
文档 v22 ↔ 协议 v12 是**最后一次配套发布**（`kind` 改名：贴图 `Texture`→`Image`、精灵 `SceneObject`→`Sprite`，
协议 v11 的老客户端不认这两个值——占位色退回灰色（图照常显示，显示走组件名），
按「不是崩、是画面错」的同一条纪律靠握手 `4002` 挡住）。
**v23 与 v24 都只动编辑器侧的存储位置**（素材级数据搬进 `<素材>.meta`），wire 上一个字节都没变，协议因此停在 v12。
**v25 ↔ v13 是又一次配套发布**：战争雾从 `GridMap` 的 data 拆成独立组件 `FogOfWar`（形状不变、位置变了）。
老前端（v12）按 `map.fog` 读——新场景在它眼里「雾整个没了」（不是崩，是雾层丢了），
按同一条纪律靠握手 `4002` 挡住；命令那一组一个字节都没动。
**v27 ↔ v15 是再一次配套发布**：战争雾从地图上的组件变成**独立的 `Fog` 对象**（`FogOfWar.data` 多 `mapId`）。
老前端（v14）按地图 id 找雾组件 → 找不到，且不认 `Fog` 对象——雾层整个不工作，按同一条纪律靠握手挡住；
命令那一组结构没变，只是 `erase_mask` / `reveal_fog_region` 的 `objectId` 从地图 id 变成**雾对象 id**。
**v26 ↔ v14 是再一次配套发布**：显示顺序从对象级搬进渲染组件（`GridMap` / 图片层的 data）。
老前端（v13）读不到对象级那一项 → 所有渲染层挤在同一层（不是崩，是遮挡顺序错乱），
按同一条纪律靠握手 `4002` 挡住；命令那一组仍然一个字节都没动。
**v28 ↔ v16 是又一次配套发布**：取消 `Map` 类型，`GridMap` 的 data 去掉 `image` / `sortingOrder`
（改由对象的 `ImageLayer` 承载）。老前端（v15）按 `map.image` 取图 → 取不到，网格地图退成占位色
（不是崩，是画面错），按同一条纪律靠握手挡住；命令那一组仍然一个字节都没动。
**v28 ↔ v17 / v18 是协议侧的两次追加**（文档格式当时停在 v28，没有配套的文档改动）：v17 新增视频混合组件
`VideoBlend` + 命令 `erase_video_mask`（老前端 v16 不认 → 混合层不建、命令回「不认识」）；v18 给
`VideoBlend` 的 data 加 `autoPlay`（老前端 v17 不认 → 不会自动播）。都属于「行为丢」，按同一条纪律
靠握手 `4002` 挡住；命令那一组 v18 一个字节都没动。
**v29 ↔ v19 是一次配套发布**：视频混合的两路从「列表 + 选中」收成**一个素材**（`{ kind, id? }`），
且每路多了 `kind`（`image` / `video`）——这一路可以是图片也可以视频。老前端（v18）按 `clips` / `picked`
读 → 两路都读不到（混合层放不出来），协议照旧 +1；文档侧靠迁移函数读得回来（见下）。命令那一组仍旧没动。
**v20 是又一次协议侧的追加**（文档格式不动）：视频混合多一条命令 `fill_video_mask`（把整张遮罩
填成 1 / 0，Mask 窗口右边那两个「整张」按钮用）。老前端（v19）不认它 → 回一条未知命令（按钮点了没
反应），同样靠握手 `4002` 挡住；组件 data 一个字节都没动。
**v30 ↔ v21 是一次配套发布**：新增「放大镜」动作对象（第 9 种组件 `Magnifier` = 图片列表 + 当前展示
的那一张）与两条命令 `open_magnifier` / `close_magnifier`。老前端（v20）不认这个组件 → 那扇窗永远
弹不出来（不是崩，是功能丢），也不认那两条命令 → 同样靠握手 `4002` 挡住。**没有迁移函数**（纯加法：
老文件里既没有这个 kind、也没有这个组件），文档格式 +1 是为了让老编辑器撞上
`kind: z.enum(OBJECT_KINDS)` 时拿到一句明确的「请升级编辑器」（与 `Fog`（v27）同一条老规矩）。
规则：文档格式**任何结构不兼容的改动 +1**；协议**任何不兼容改动 +1**。

| 文档版本 | 内容 | 迁移方式 |
|---|---|---|
| v1 | 地图就是场景（`maps[]` 内联） | `upgradeV1Document` 拆成「场景容器 + `kind:"Map"` 对象」 |
| v2 | 场景是容器、地图降级为对象 | 拆分 `Assets/scenes/*.json` |
| v4 | 场景 = 独立文件（场景名 = 文件名） | — |
| v5 | 位置从归一化 `[0,1]`(y 向下) 换成世界坐标(x 右、y 上) | `migrateScenePositions`（**只认 v5 这条线**） |
| v6 | 网格里删掉恒为 1 的 `cellSize` | schema 顺手丢掉 |
| v7 | 每个对象补 `active` | `withFilledObjectFields`（补默认值） |
| v8 | 补 `scale` | 同上 |
| v9 | 补 `locked` | 同上 |
| v10 | `map.fog`（**可选，不补空壳**） | 无需函数（可选字段 + 版本号触发回写） |
| v11 | `scaleX` / `scaleY`（**可选，绝不补默认值**） | 刻意不补——补成 1 会把等比对象悄悄变成非等比 |
| v12 | `teleport` 从 `{target}` 变成 `{targets, picked}` | `migrateTeleportTarget` |
| v13 | `map.fog.enabled` 总开关（`.default(true)`） | 无需函数（默认值 + 回写） |
| v14 | `video`（可选） | 无需函数（可选字段 + 回写） |
| v15 | `settings`（**给默认值**）；声音层级 `ambient` 并入 `bgm` | `settingsFilled` 触发回写；`migrateSoundLayers` |
| v16 | `settings.audio.bgm` 收敛成只有 `volume` | `migrateBgmSettings`（**显式删**`clips`/`picked`/`names`/`loop`） |
| v17 | `audioMeta`（可选，不补空壳；**v24 起搬进各音频素材的 `.meta`**，见下） | 无需函数 |
| v18 | 标签从字符串改成**整数 ID + `audioTags` 表**（表是项目级的，v24 后**仍留在工程文件里**） | `migrateAudioTags`（按出现顺序建表） |
| **v19** | **对象特性搬进 `components[]`**：`map`/`image`/`sound`/`teleport`/`video` → `GridMap`/`ImageLayer`/`SpriteLayer`/`PlaySound`/`Teleport`/`VideoOverlay` 组件实例（v20 及更早 `image` 那一种是 `TextureRenderer`，v21 拆开） | `migrateFeaturesToComponents`（只搬键、不解释内容；幂等；**组件名按 kind 取**） |
| **v20** | **精灵（子图）**：图片引用多了可选的 `sprite`（取图集里哪一格），工程文件多了可选的 `spriteSheets`（`图片逻辑 ID → 列×行`，**切分只有这一份**）。格序数**从左上数**（与 `rowOrder: "bottom-up"` 无关）；不存像素 / 不存 UV；越界格子在**推送与渲染两处**统一夹到最后一格；**地图贴图不支持子图** | **无需函数**——两项都是可选字段，靠「版本号 +1 → `needsRewrite` 回写一次」让老文件自描述（同 v17 `audioMeta`）。协议同批 +1 到 **v10**：切分随载荷走（`spriteGrid`，协议比文档多一项），老客户端会把整张图集铺出来，靠握手 `4002` 挡住 |
| **v21** | **「贴图」对象（kind `Texture`）+ 图片组件拆成两种**：精灵 `SpriteLayer`、贴图 `ImageLayer`（v20 及更早共用 `TextureRenderer`）；`video` 的宿主从精灵换成贴图 | `renameSpriteImageComponent`（旧 `TextureRenderer` **按 kind 路由**改名：`SceneObject` → `SpriteLayer`，Player / Item / Event → `ImageLayer`——v19 的 `image` kinds 含它们，组件 id 同步换 `<对象 id>__<新类型>`；幂等）＋ `migrateFeaturesToComponents` 新增**按 kind 路由组件名**。**精灵身上旧的 `VideoOverlay` 不删**（只由 `validateScene` 报 warning）。协议同批 +1 到 **v11**：老前端不认这两个组件名 → 图取不到只画占位色，靠握手挡住 |
| **v22** | **对象类型立层级 + 两个 kind 改名**：`SceneObject` 变成**抽象基类**（精灵与贴图继承它，自己不落进文档）；贴图 `Texture` → `Image`、精灵 `SceneObject` → `Sprite`。数据形状一个字没动 | `renameObjectKinds`（`LEGACY_KINDS` 表改名，**必须排在其它迁移前面**——后面两条都按 kind 选图片组件名）；判据从 `kinds.includes` 改成 `carriesKind`（按层级）。协议同批 +1 到 **v12**：老前端不认这两个值 → 占位色退回灰色（图照常显示），靠握手挡住 |
| **v23** | **图片的导入设置与切分搬进素材自己的 `.meta`**：工程文件删掉 `spriteSheets` / `spriteSettings`；`ImageRef` 多一项可选的 `guid`（**有 guid 就以 guid 为准**，`id` 留给显示、老文件兜底与下发前端的换算）。素材从此「身份 = GUID，路径只是它现在在哪」 | `migrateSpriteMetas`（按路径把工程文件里那两张表合成各自的 `.meta` 内容，经 `migratedMetas` 交给编辑器落盘；素材还在不在由调用方按资源树判断——孤儿键丢弃并报 warning）。**协议不变**：wire 上仍只有路径 ID，推送时由 `resolveSceneSprites` 把 guid 换算回路径 |
| **v24** | **素材 meta 覆盖到每一种素材，工程文件里不再有任何「按文件记」的数据**：每个素材（图片 / 音频 / 视频 / 场景）旁边一份 `<素材>.meta`，缺的由编辑器打开项目 / 刷新资源树时现建（`importer` 按项目内相对路径判定）；工程文件的 `audioMeta` **删掉**，音频的显示名 + 标签 ID 搬进各自 `.meta` 的 `audio` 段；`audioTags`（标签表）**留在工程文件里**——它是项目级数据。口径收敛成一句：**项目级数据在 `project.json`，素材级数据跟着素材走** | `migrateAudioMetas`（按路径把 `audioMeta` 搬进各自 `.meta` 的 `audio` 段，标签 ID 按工程文件那张表归一化；空壳不搬）＋ `mergeMigratedMetas` 与 v23 的结果合成一份 `migratedMetas`。**协议不变**（音频引用一直是资源逻辑 ID） |
| **v25** | **战争雾拆成独立组件 `FogOfWar`**：原来住在 `GridMap` 的 data 里的 `fog`（总开关 + 雾区，形状不变）搬成 `components[]` 里的实例 | `migrateMapFogToComponent`（组件 id 确定性 `<对象 id>__FogOfWar`；已有实例不覆盖；幂等）。协议同批 +1 到 **v13** |
| **v26** | **显示顺序搬进渲染组件**：对象级 `sortingOrder` 删除——网格地图进 `MapDataDoc`、图片层（`ImageLayer` / `SpriteLayer`）进各自的 data（`ImageRef & { sortingOrder }`）；动作对象与没有渲染层的实体不再有这个参数 | `migrateSortingOrderToRenderComponents`（先 `GridMap`、后图片层；都没有就丢弃；幂等）。协议同批 +1 到 **v14** |
| **v27** | **战争雾变成独立的场景对象**：地图上的 `FogOfWar` 组件搬到新的 `Fog` 对象（可摆放，摆位复制原地图），组件 data 多 `mapId`（引用哪张地图）；一张地图最多一个雾对象 | `migrateFogToSceneObject`（id 确定性 `<地图 id>__Fog`；复制 position/rotation/scale；幂等）。协议同批 +1 到 **v15**：`erase_mask` / `reveal_fog_region` 改按**雾对象 id** 寻址 |
| **v28** | **取消 `Map` 类型，网格变成贴图上的可选组件**：`Map` → `Image`；`MapDataDoc` 去掉 `image` / `sortingOrder`（改由 `ImageLayer` 承载），`GridMap` 只剩 `grid` / `rowOrder` / `cells`；`GridMap` 组件改为可选能力（`optionalKinds: ["Image"]`） | `renameObjectKinds`（Map → Image）+ `migrateGridMapImageToLayer`（GridMap 的 image/sortingOrder → `ImageLayer`，幂等）。协议同批 +1 到 **v16**：`mapDataSchema` 去掉这两项，地图对象改为下发 `ImageLayer` 组件 |
| **v29** | **视频混合的两路从「列表 + 选中」收成单个素材**：`VideoBlendChannelDoc` 由 `{ clips, picked? }` 变成 `{ kind, id? }`——每路只放一个素材，且可以是**图片**或**视频**（`kind`） | `migrateVideoBlendChannels`（取 `picked`，没选取 `clips[0]`，`kind` 记 `video`；幂等）。协议同批 +1 到 **v19** |
| **v30** | **新增「放大镜」动作对象**：`OBJECT_KINDS` 多一个 `Magnifier` + 第 9 种组件 `Magnifier`（图片列表 `images` + `picked` 下标）。**纯加法**：老文件里既没有这个 kind、也没有这个组件 | **没有迁移函数**——格式 +1 只是为了让老编辑器撞上 `kind: z.enum(OBJECT_KINDS)` 时拿到一句明确的「请升级编辑器」（与 `Fog`（v27）同一条老规矩）。协议同批 +1 到 **v21** |

**版本判断纪律**（`schema.ts` 里专门写了注释）：**不能拿文件里的 `formatVersion` 跟 `DOCUMENT_FORMAT_VERSION` 比**
来判断「要不要做位置换算」——版本号一涨，所有旧文件都会被判成「需要换算」，那会把已经是世界坐标的 v5 文件
再换算一次（`(0,0)` 变成 `(-960, …)`）。每一步迁移只认它自己那条版本线（如 `WORLD_POSITION_VERSION = 5`）。

### 6.2 加载一条项目 / 场景时到底发生了什么

**`parseProjectFile(raw)` → `{ doc, migratedScenes, needsRewrite }`**

```
upgradeRawDocument           # v1 → v2（把内联 maps 拆成 Map 对象）
 → migrateBgmSettings        # v16：删掉 bgm 上的 clips/picked/names/loop，只留 volume
 → migrateAudioTags          # v18：字符串标签 → 整数 ID + audioTags 表（按出现顺序）
 → migrateSpriteMetas        # v23：spriteSheets/spriteSettings → 各图片素材的 .meta 内容
 → migrateAudioMetas         # v24：audioMeta → 各音频素材 .meta 的 audio 段（按 audioTags 归一化）
 → projectDocSchema.safeParse# 失败抛「项目文档校验失败: …」
 → 拆出内联 scenes，逐个 parseSceneFile() 得到 migratedScenes
 → needsRewrite = 有内联场景 || settingsFilled || bgm.changed || tags.changed
                || spriteMetas.changed || audioMetas.changed || formatVersion < DOCUMENT_FORMAT_VERSION
 → migratedMetas = mergeMigratedMetas(spriteMetas, audioMetas)   # 同一个键先到的赢
 → migrateProjectDoc         # formatVersion > 26 → 抛错（拒绝用旧编辑器打开新文件）
```

**`parseSceneFile(raw, size?)` → `{ file, needsRewrite }`**

```
upgradeRawDocument
 → version > 28 则抛错
 → version < 5  → migrateScenePositions（越界旧值原样保留，不夹到边界）
 → withFilledObjectFields（补 active/scale/locked；老 `Map` 缺位置补 (0,0)）
 → migrateTeleportTarget（{target} → {targets,picked}）
 → migrateSoundLayers（ambient → bgm）
 → renameObjectKinds           # v22：Texture → Image、SceneObject → Sprite
                               # v28：Map → Image（「网格地图」= 贴图 + GridMap 组件）
                               #      **必须最先**：后面几条都按 kind 选图片组件名
 → renameSpriteImageComponent  # v21：TextureRenderer 按 kind 改名（先改名、再搬字段）
 → migrateFeaturesToComponents # v19：扁平特性字段搬进组件（组件名按 kind 路由）
 → migrateMapFogToComponent    # v25：GridMap.data.fog → 独立 FogOfWar 组件
 → migrateSortingOrderToRenderComponents  # v26：对象级 sortingOrder → 渲染组件 data（无渲染层丢弃）
 → migrateFogToSceneObject     # v27：地图上的 FogOfWar 组件 → 独立 Fog 对象（引用地图）
 → migrateGridMapImageToLayer  # v28：GridMap 的 image/sortingOrder → ImageLayer 组件
 → migrateVideoBlendChannels   # v29：VideoBlend 两路的「列表 + 选中」→ 单个素材（{kind, id}）
 → sceneFileSchema.safeParse
```

两条共同约定：**迁移只做一次**（返回 `needsRewrite`，由调用方回写磁盘，之后文件自描述）；
**能读回来但形状变了才写迁移函数**，纯粹新增可选字段只靠「版本号 +1 触发一次回写」。

### 6.3 `@dts/protocol` 与 `@dts/document`：刻意重复的精确差异

协议侧**复刻一份只读 schema** 而不 import `@dts/document`（理由：`protocol` 是被三端共用的最底层包，
不该反过来依赖文档包），并要求「字段口径与文档严格一致，文档加字段时这里同步补」。

**协议有、文档没有**：

| 协议字段 | 说明 |
|---|---|
| `image.spriteGrid{columns, rows}` | **唯一的例外**（v10）。切分在编辑器那边只有一份（**那个素材自己的 `.meta`**，v23 起），前端没有 `.meta`，所以编辑器推送时用 `resolveSceneSprites` 把「几行几列」解析进载荷（§3.2.6）。它是**载荷专有的字段**：文档 schema 静默丢掉它（zod 不认识的键会被丢掉），契约测试盯着这一点——落盘时留在场景文件里等于没写 |

**文档有、协议没有**：

| 文档字段 | 协议侧处理 |
|---|---|
| `GameObjectDoc.components[].displayName` | 协议把 `components` 整个当 `z.array(z.unknown()).optional()` 透传，不做结构校验 |
| `formatVersion`（场景 / 工程） | 协议**不传**（`sceneSchema = { name, objects }`，无 `formatVersion`） |
| `ProjectDoc.name` / `items`（道具库） | 协议完全没有项目级道具库 |
| `ProjectDoc.audioTags`（标签表） | 纯编辑器数据（v18），**不进协议、不下发 Unity**；音频文件的显示名与标签 ID v24 起在 `<素材>.meta` 的 `audio` 段里（同样不下发，音频引用一直是资源逻辑 ID） |
| **素材的 `<素材>.meta`**（切分 / 导入设置 / 音频标注） | 纯编辑器数据（v23 / v24，`asset-meta.ts`），**整份不下发**——编辑器推送时把每个引用解析成 `sprite` + `spriteGrid`（见上表），音频那一侧的标注不参与播放 |
| `sound.names` / `video.names` | 只是编辑器里给人看的标签，**刻意不进协议** |

**同名字段但默认值 / 约束不同**：

| 字段 | 文档 | 协议 |
|---|---|---|
| `active` | 有 `.default(true)` | 必填、无默认 |
| `sortingOrder`（图片层的 data，v26 起；v28 起地图也不再例外） | `.default(0)` | `.default(0)` |
| `locked` | `.default(false)` | `.optional()`，**不设默认** |
| `scaleX` / `scaleY` | `.optional()` | `.optional()`，**刻意不设默认**（老编辑器不发、老前端不认，属无害的额外信息，不必升版本号） |
| `FogOfWar.mapId` | `.default("")`（v27，引用地图 id） | `.default("")` |
| `FogOfWar.enabled` / `FogOfWar.regions` | `.default(true)` / `.int().min(1).max(255)` + `.default([])` | `.default(true)` / `.int()`（无默认、无范围） |
| `rleRun` | `[int 0..255, int ≥0]` | `[int, int]`，无范围 |
| `sound.clips` | `z.array(z.string().min(1))` | `z.array(z.string())` |
| `image.sprite` | `.optional()`，只要求**非负整数**（越界合法：切分被改小之后老对象的格子会暂时越界，夹取交给解析） | `.optional()`，另有 `refine`：与 `spriteGrid` **同时出现**时必须落在切分范围内（越界 = 坏载荷）；缺 `spriteGrid` 时按 1×1 收下 |
| `spriteGrid`（`SPRITE_SHEET_MAX`） | 文档侧不存在（切分住在**素材的 `.meta`** 里，不在文档 schema 里，值域 `1..64`） | `columns` / `rows` 各 `1..64`；常量与文档包**同值**，由契约测试断言 |

**协议额外携带的运行态语义**：`map.fog` 的注释说明「**哪个格子被揭示了不在数据里**」——
那是运行态，由 `erase_mask` / `reveal_fog_region` 驱动，不写文档、也不随 `scene_sync` 走。
`eraseStrokeSchema` 则明确「逐字对齐 `apps/editor/src/services/mask-math.ts`」。

### 6.4 组件注册表（跨包对照）

| 概念 | 位置 | 与前端的关系 |
|---|---|---|
| 对象类型 `ObjectKind`（10 种，含抽象基类） | `@dts/document` 的 `presets.ts` | `GameObject` 是**抽象基类**（不落进文档），其余是具体预设；kind 只是预设 id、没有层级，能力槽位声明在 `OBJECT_PRESETS` 上。**v19 起 `kind` 只是创建原型标签**（前端拿它取占位色），「建不建可见物」看组件（见下） |
| 组件类型（8 种，`components.ts`） | `@dts/document` | 全部 8 种对象能力组件（`GridMap` / `FogOfWar` / `ImageLayer` / `SpriteLayer` / `PlaySound` / `Teleport` / `VideoOverlay` / `VideoBlend`）**逐字对齐客户端 `Protocol.ComponentType`**（`VideoOverlay` 与 `VideoBlend` **互斥**，准入层拒绝同时挂）。，由 `apps/backend/test/protocol-document-contract.test.ts` 断言。**`image` 一个槽位两种组件**（每个预设的 `slots.image` 声明各自用哪种）；`FogOfWar` 自 v27 起挂在独立的 `Fog` 对象上（只有 `Fog` 预设声明 `fog` 槽位）；`GridMap` 自 v28 起是**贴图上的可选组件**（`Image` 预设声明 `map` 槽位，`optionalKinds: ["Image"]`） |
| 前端可见性判据 | `SceneObjectView.NeedsView(MirrorObject)`（客户端） | 有 `map`（GridMap）或 `image`（`ImageLayer` / `SpriteLayer`）**组件** → 建视图；都没有时**只有带 `PlaySound` / `Teleport` / `Magnifier` 组件的不建**（动作对象），其余（玩家 / 道具 / 事件 / 还没挑图的精灵）仍要一块占位色面片。**判据只此一处** |
| **子图（v10）** | `@dts/document` 的 `ImageRef.sprite` + **图片素材自己的 `.meta`**（`sprite.sheet`，v23 起；见 §3.2.6） | 就是「纹理 + 一块矩形」（组件是 `SpriteLayer` / `ImageLayer`，见 v21 那一条）。载荷里 `sprite` + `spriteGrid` 一起下发（编辑器推送时解析出来）；Unity 侧：`Protocol.Version = 12` → `SceneParser.ParseSprite` 把两项合成一份 `MirrorSprite`（缺 `spriteGrid` 按 1×1，越界夹到最后一格）存进 `MirrorImage.sprite` → `SpriteLayer.UvRectOf`（**全链路唯一一次 y 翻转**）+ `InsetUv`（子图内缩半纹素，躲开双线性渗色）→ `Apply(..., uvRect)` 把 UV **烘进网格顶点**；`SceneObjectView.currentUvRect` 记着当前那一块；`ResourceImageLoader` 取到纹理后 `wrapMode = Clamp`（整图也无副作用）；`Editor/LayerInspector.cs` 把网格上的实际 UV 显示出来 |
| **两种图片组件（v21）** | `@dts/document` 的 `DEFAULT_SLOT_COMPONENT.image`（`ImageLayer`）+ `SPRITE_COMPONENT`（`SpriteLayer`）；每个预设的 `slots.image` 声明各自用哪种 | 同一个 `image` 槽位，**按预设取组件名**（唯一入口 `componentForSlot`，缺省承载兜底）。文档侧「这个对象的图能不能取一格」= `supportsSpriteSheet`（编辑器据此决定选择图片弹框给不给切分面板）；客户端读**两种都认**，`MirrorObject.hasSpriteLayer` 记下是哪一种（占位色 `KindColor` 靠 `kind` 分：精灵蓝、贴图紫，只认具体类型）。迁移：`renameSpriteImageComponent` 把老文件里的 `TextureRenderer` **按预设**改名（精灵 → `SpriteLayer`，Player / Item / Event → `ImageLayer`），组件 id 同步换 |

### 6.5 客户端联调（真 Unity 验证，2026-09-22）

协议 v9 / 文档 v19 这一批改动**在真的 Unity 客户端上端到端跑过**，做法是：起后端 → Unity 打开
`Assets/DiceTale/Scenes/Demo.unity` 进 Play（它会连 `ws://localhost:1420/client`）→ 用一个临时的
「假编辑器」WS 脚本（扮演编辑器那一侧，见 §6.4 的 `editorToServerSchema`）推真实场景 + 下发命令。

观测到的客户端日志（`kind` → 组件 → 行为三条链路都通）：

```
[镜像] 场景「场景1」：4 个对象
[战争雾] FogOverlay：雾区 区域1+区域2+区域3，雾格 654 个，遮罩 960×540，羽化 256×144×4 遍
[命令] 「播放声音」在 voice 层播放：project:测试项目/Assets/audio/…/06-altar-transition.mp3
[视频] 开始播放：project:测试项目/Assets/video/Map003_1.mp4（循环=False）
[命令] 战争雾：map_mu6uln3x1l7fg 区域位 1 这一区整片揭示
[镜像] 场景「场景3」：1 个对象（镜像里共 2 个场景，隐藏的不销毁）
```

层级侧的证据（`Game/场景/场景1` 下只有 3 个可见物）：

| 对象 | 组件 | 客户端建了什么 |
|---|---|---|
| `网格地图（map_…）` | `ImageLayer` + `GridMap` | `SceneObjectView` + `ImageLayer`（面片）+ `GridMapView`（网格数据，v28） |
| `战争雾（fog_…）` | `FogOfWar` | `FogOfWar`（自己的 `FogOverlay` 子物体是 `ImageLayer`，v27 起独立对象） |
| `精灵（obj_…）` | `SpriteLayer` | `SceneObjectView` + `ImageLayer`（面片是 `ImageLayer`，取哪一块由 `SpriteLayer.UvRectOf` 算） |
| `贴图（obj_…）` | `ImageLayer` | `SceneObjectView` + `ImageLayer`（整张铺满） |
| `sound_…` | `PlaySound` | **一个 GameObject 都不建**（数据留在镜像里） |
| `teleport_…` | `Teleport` | **一个 GameObject 都不建** |

> **2026-09-26 组件袋重构后**（表现层组件一对一，见 `docs/TASKS-表现层组件一对一.md`）：
> 运行时层级变成「**组件袋**」——实体对象的 GameObject 上每个实体协议组件对应一个表现组件
> （`GridMap` → `GridMapView`、`ImageLayer` / `SpriteLayer` → 同名渲染层、`FogOfWar` → 同名组件），
> `SceneObjectView` 退化为只管对象本体（transform / 激活 / 顺序 / 占位色 / 取图分派）的协调器。
> `FogOverlay` 从「场景根节点同级」改为**地图对象的子物体**，由 `FogOfWar` 组件按
> 「开关开 + 雾区非空 + 有 GridMapView」自己建/拆；上表是 2026-09-22 联调时的历史形态。

**这次联调抓到一个真 bug（已修）**：`SceneMirror.ResourceIdOf` 里
`foreach (var clip in obj.sound != null ? obj.sound.clips : null)`——`obj.sound == null` 时那句三元
返回 `null`，`foreach (null)` 抛 `NullReferenceException`。它在 `ProjectOf`（推项目名的兜底路径）里
**对每个对象**调用，所以任何「既没有贴图也没有声音」的对象（传送阵、没挑图的精灵、以及**协议版本
不一致时收到的空对象**）都会把整份场景的载入打断。改成先取 `clips` 判空再遍历。
联调时的触发场景正是「协议 9 的客户端连上了协议 8 的旧服务端」——那条报错值得记住：
`4002 协议版本不一致`。

---

## 7. 测试体系（30,472 行）

### 7.1 三层测试与运行方式

| 层 | 位置 | 运行器 / 环境 | 数量 | 行数 |
|---|---|---|---|---|
| 架构边界 | `test/architecture.test.ts` | vitest `node` | 1 文件 / 3 describe / 6 用例 | 231 |
| 单元测试 | `packages/*/test`、`apps/backend/test`、`apps/editor/test` | vitest（`node` / `jsdom` 两个 project） | 77 个测试文件（另 3 个 helper + 1 个 setup + 1 个 fixtures，共 82 个文件） | 21,760 |
| 端到端 | `e2e/*.spec.ts` | Playwright（三条档位线） | 20 个 spec（7,401）+ 2 helper（1,450）+ 1 teardown（15） | 8,866 |

- `pnpm test` = `vitest run`（两个 project 一起跑，README 说约 1.5s）；
- `apps/editor/test` 跑在 **jsdom**，`setup.ts` 补 jsdom 缺的浏览器 API 并挂 `@testing-library/jest-dom`；
- E2E 前**必须先 `pnpm build`**（托管的是已构建产物）；`pnpm e2e:fast` 只跑桌面档位；
- 带 `@runtime` 标记的 E2E 用例操作**服务端全局单例**，所以脚本层面拆成两趟（并行 + 串行）。

### 7.2 架构边界测试（`test/architecture.test.ts`）

它把「分模块解耦合」与「代码资源分离」写成可执行断言。机制：`listSourceFiles()` 递归收集
`packages/<包>/src` 下的 `.ts` / `.tsx`，用三条正则提取 import specifier
（`import … from "x"`、动态 `import("x")`、`require("x")`），再逐条比对。
**每条规则都是先收集 `violations[]`、最后一次 `expect(violations).toEqual([])`**，
所以失败时能一次看到全部违规点而不是第一条就停。共 3 个 describe / 6 条规则：

| # | 用例 | 规则 |
|---|---|---|
| 1 | 纯逻辑包不 import React、Node 内置模块或 DOM | 扫 `grid`/`document`/`protocol`/`resources` 的 `src`：禁止模块 `react`、`react-dom`、`react/jsx-runtime`、`node:fs`、`node:path`、`node:http`、`node:child_process`、`fs`、`path`、`http`、`child_process`（匹配 `specifier === bad \|\| specifier.startsWith(bad + "/")`，所以 `node:fs/promises` 也被挡住）；另做**裸子串**检查禁止 `window.`、`document.`、`localStorage`、`sessionStorage`、`navigator.`、`HTMLElement`、`requestAnimationFrame`（注释里出现也算） |
| 2 | `renderer` 可以用 DOM，但不得依赖 React | 扫 `renderer/src`：禁止 React 家族；**禁止任何 `node:` 前缀**模块（比规则 1 的显式清单更宽）。不做 DOM 全局扫描——这是它与规则 1 的唯一区别 |
| 3 | 只允许声明的依赖方向（且必须写进 `package.json`） | `ALLOWED = { grid: [], protocol: [], resources: [], document: ["grid"], renderer: ["grid","document"] }`。**双向检查**：`package.json` 里 `@dts/*` 依赖必须在允许表内；`src` 里出现的 `@dts/*` import 也必须在允许表内。矩阵外的包（`apps/*`）不受约束，因此编辑器与后端可自由依赖 `@dts/*` |
| 4 | 除 `resources` 包外，源码不出现资源路径字面量 | 扫 `grid`/`document`/`protocol`/`renderer`：先 `stripComments()` 去掉块注释与行注释（`(^\|[^:])//` 避免误伤 `http://`），再匹配 `/["'`][^"'`]*resources\//` 与 `/["'`]Map\d+\.(png\|bytes)["'`]/`。用 `test()`，所以每个文件每种模式最多记一条 |
| 5 | `resources` 包是唯一持有目录约定的地方 | 反向断言 `resources/src/provider.ts` 必须包含 `DEFAULT_RESOURCE_DIRS` |
| 6 | 磁盘访问只出现在后端 | 所有包的 `src` 里不得出现 `/from\s+["']node:fs/`（只抓 `import … from "node:fs…"` 这一种写法） |

这 6 条**不是软约定**：例如给 `@dts/document` 加一个 `node:path` import、让 `document` 依赖
`@dts/protocol`、或在 `@dts/grid` 里写 `"Map001.png"`，`pnpm test` 立刻失败。

### 7.3 单元测试清单

#### 7.3.1 `apps/backend/test`（15 文件 / 2,970 行）

| 文件 | 行数 | 覆盖的行为 |
|---|---|---|
| `runtime-hub.test.ts` | 919 | **最大的一份**。门控（没点运行 → 握手 503 / 点运行后能连 / 退出运行 4003 踢下线）；先推场景后开前端拿到全量；运行中改场景整份转发；命令转发 + 回执 + 日志；不认识的命令回带 `requestId` 的 `editor_error`（不静默丢弃）；战争雾轨迹转发；前端不在 / 未进运行态的明确报错；编辑器刷新/断开不影响运行态；协议版本不一致 4002；**顺序断言**（`resources_prepare` → `project_settings` → `scene_sync`）；换项目重发 `resources_prepare`；前端上报资源包结果并在关闸后清掉；一组 HTTP 接口用例（`/api/health`、`/api/config`、`/api/resources/index`、`/api/resources/raw`、`/api/state`、未构建时的根路径提示） |
| `project-api.test.ts` | 669 | 项目 CRUD（创建 `project.json` + 标准子目录、没有 `project.json` 的目录不算项目、项目文件可被编辑器直接打开、重名 400、非法名 400 且不落盘）；资源树与建目录（含目录穿越 400）；上传 → 出现 → 删除；删项目连资源一起清；**缩略图四条**（图片 = 缩小 WebP + 尺寸头 + md5 缓存失效 + **落盘断言**：生成结果进 `<资源根>/.cache/thumbnails/<源素材 md5>-<源宽>x<源高>.webp`；**视频 = ffmpeg 抽首帧**走同一管线，夹具 `fixtures/clip.mp4` 64×48，`info=1` 也认视频；**`moov` 在文件尾（非 faststart）+ 撑过 ffmpeg 的 32KB IO 缓冲**的 mp4 也要出图——拿夹具垫一个 `free` 盒复现真视频形态，改回不可 seek 的管道这条就红；**坏视频：如实回 400、不打崩进程、响应体不回显临时目录路径**——vitest 自己的兜底不一定让用例变红，用进程级 `uncaughtException` 记录显式钉住；同理「客户端中途断开大文件下载」也不得打崩；**keep-alive 单连接 15 连请求不得累积 error 监听**——挂 `MaxListenersExceededWarning` 红钉，error 兜底须每 socket 一次）；**`/api/projects/reveal` 的 10 条用例**（路径由服务端拼、项目不存在 404、非法名 400、非 POST 405、系统打不开时如实报错、带 `path` 打开项目内那一层、`selectFile` 指向存在文件 / 指向目录 / 指向不存在文件、`path` 越界 400） |
| `thumbnail-store.test.ts` | 170 | 缩略图缓存**本身**（HTTP 那一层在 `project-api.test.ts`）：同 ID 同内容只生成一次、md5 一变就重新生成、同一份内容并发只生成一次；**换个实例（= 后端重启）仍命中磁盘、不再跑生成**；同一份内容换个 ID / 换个项目也命中；内存层挤掉之后由磁盘兜底；磁盘写不进去（目录位置被文件占了）照常返回结果、只记日志；条目超上限按 mtime 删最旧的 |
| `runtime-session.test.ts` | 263 | 会话初始态；开闸幂等不清场景；快照是摘要（名字 + 对象数 + 时间）；关闸清空全部字段；推 `null`；`sessionId` 稳定可读；资源包状态；设置摘要只报时间；`projectNameOfScene`（含推不出项目名的情形、换项目跟着变） |
| `resources-bundle.test.ts` | 229 | 清单范围（只收 `Assets/`、排除 `project.json` 与 `.gitkeep`）；`bytes` 与排序稳定；指纹随内容变、内容不变则稳定、**把 mtime 算进去**；`ProjectNotFoundError` / `BundleTooLargeError`；zip 结构（条目名 = 项目根相对路径、另有清单文件、字节与源文件逐字节一致、中文名 UTF-8 位标记、响应头、空项目也能打包） |
| `resources-bundle-api.test.ts` | 157 | 清单 API（只列 `Assets/`、给指纹与字节数）；整包下载（zip + 响应头 + 包内条目一致）；**指纹没变 → 304**；素材改了 → 缓存失效重下拿到新内容；超上限 413；项目不存在 404 / 缺参数 400 |
| `resources-api.test.ts` | 145 | 资源重命名的 7 条：文件重命名后新 ID 可读、旧 ID 404；目标已存在 400 **且不覆盖**；源不存在 400；缺参数 400；非法 ID 400；方法不对 405；**目录重命名连其下资源一起搬** |
| `fs-provider.test.ts` | 118 | 按配置解析资源根、跳过 `.gitkeep`、目录也列出、文本/二进制读写往返、删除连目录清掉；**三条越权拒绝**（越出资源根、绝对路径目录、相对逃逸目录） |
| `net.test.ts` | 98 | `pickLanAddresses` 纯函数：排除虚拟网卡（VMware/VirtualBox/Hyper-V/WSL/Docker）、排除回环与 APIPA、排除非 IPv4、真实网卡优先、多网卡都列、无可用地址返回空数组 |
| `static-serving.test.ts` | 66 | **不存在的 `/assets/x.js` 返回 404 而不是 `index.html`**（白屏卡死那个坑）；其它带扩展名缺失同样 404；不带扩展名仍走 SPA 回退；根路径给编辑器；目录穿越被挡 |
| `atomic-write.test.ts` | 66 | 读写交错时每次读到的都是完整旧内容或新内容；`.dts-tmp` 不出现在资源列表里 |
| `open-folder.test.ts` | 64 | Windows `explorer.exe`（目录作为单独一个参数）、macOS `open`、Linux `xdg-open`；**路径带空格 / `&` 时原样放进参数**（不在 shell 里解析）；Windows 定位文件用 `/select,` 且与路径同一参数；macOS `open -R`；Linux 退回打开父目录；不认识的平台返回 `undefined` |
| `config.test.ts` | 46 | 默认资源根由**模块位置**决定（不受启动目录影响）；`defaultResourceRoot` 是纯函数；默认配置能真正读到 `config/app.json`（不是静默退回内置默认值）；显式绝对路径生效 |
| `helpers/http-server.ts` | 39 | 起一个临时资源根的测试用后端（供上面各 API 用例复用） |
| `helpers/temp-root.ts` | 28 | 建/清临时资源根（临时根里没有 `app.json`，因此走内置默认值） |
| `protocol-document-contract.test.ts` | 230 | **跨包契约**（v19 新增、v20 加了两条）：协议与文档的组件类型名逐字一致；每个特性组件两边都能解析；已知组件的坏 data 两边都拒（不能掉进「未知类型」的宽松分支）；未知组件类型在协议侧仍是宽松分支；**子图**：切分上限两边同值（`SPRITE_SHEET_MAX`）、「文档 + 工程表 → `resolveSceneSprites` → `sceneSchema` 收得下」整条链跑得通、文档 schema 不认 `spriteGrid`（落盘时留在场景文件里等于没写）。放在这里是因为只有后端同时依赖两个包，而架构测试只扫各包 `src` |

#### 7.3.2 `packages/*/test`（25 文件 / 9,259 行）

| 文件 | 行数 | 覆盖的行为 |
|---|---|---|
| `document/document.test.ts` | 1,670 | 文档工厂（场景是容器、对象挂在场景上）；组件注册表；对象命令（改名/位置/锁定/激活/显示顺序/缩放/贴图/网格/组件…）；**战争雾手动指定雾区**；文档校验；工程文件 schema 与版本迁移；场景文件 schema |
| `protocol/protocol.test.ts` | 987 | 场景载荷（地图/精灵/声音/战争雾总开关/视频/传送阵/`position: null`/单轴缩放/额外字段不报错/网格尺寸约束/**子图：`sprite` + `spriteGrid` 原样传给前端、越界被拒、只有整图时两项都不在**）；四条通道的逐条成员；命令只带触发器（含战争雾只发轨迹、声音按层、BGM 带 clip、视频只带 objectId）；畸形结构被拒（缺 objectId、空轨迹、非有限数）；**拒绝旧模型消息**（`register_*`/`report_*`/`invoke_action`/`sync_state`）；三端 schema 都是判别式联合；JSON 解析与请求 id |
| `document/component-field.test.ts` | 216 | **泛型组件字段写入**（v25）：组件规格只接管三个无副作用的开关（`enabled` / `clips` / `picked` 都不在里面）；能改的（改布尔、缺实例按规格补壳并补出**完整**形状）；不改的（值没变、字段不归规格管、未知组件、kind 不允许该槽位、对象身上有组件但 kind 不允许的脏数据、对象不存在、类型不对的值——一律 `false` 且文档不动）；`coerceFieldValue` 按 kind 收窄（布尔只认布尔、整数取整并夹取、number 夹取、enum 命中候选、字符串只认字符串、列表 / 引用 / 颜色一律 `REJECT`） |
| `document/video.test.ts` | 467 | 哪些对象能带视频；列表命令（去空去重、清空不删字段、移出的视频收拾干净、重复写不算变更）；选中与名字；循环与声音开关；总开关；文档校验；格式版本 |
| `document/sprite.test.ts` | 762 | **v20 新增**。切分只有一份：没有表项 = 整图、写进去/改回来/删掉这一串「值没变」不算变更、只删一张时字段留着、坏数字取整并夹到 1..64；对象引用哪一格（换图丢掉旧格子、同一 id 再挑保留格子、地图对象选格返回 `false`、坏格子收成非负整数）；解析（归一化矩形每格恰好 1/列 1/行、像素矩形按**加载到的**尺寸算、越界夹到最后一格、没有 `sprite` = 整图、地图一律没有子图、一格声明尺寸、预览图上点哪一格）；落盘（场景/工程文件往返 + v19 升 v20 需要回写、负数/小数格子被 schema 拒）；**推送解析**（补 `spriteGrid`、越界夹取、摘掉地图上的误写、不改输入文档）；校验（越界格 warning、地图带 sprite warning、`1×1` 多余项与空图片 ID warning）。**v21 加**：`TextureRenderer` 按 kind 改名（精灵 → `SpriteLayer`、Player / Item / Event → `ImageLayer`，组件 id 同步换、幂等、非 image 特性的 kind 不碰）。**v22 加**：kind 改名（`SceneObject`→`Sprite`、`Texture`→`Image`，回写一次、幂等、怪值原样留着让 schema 报错、只换 kind 一个字段） |
| `document/presets.test.ts` | 165 | 对象预设表（kinds.test.ts 重写而来，v22 层级移除后）。预设表本身（每个 kind 有预设且顺序同 `OBJECT_KINDS`、槽位路由：Sprite 的 image 是 `SpriteLayer`、其余可贴图预设是 `ImageLayer`、video 槽位只给地图与贴图、承载组件都注册在组件表里）；查询语义（`componentForSlot` 对未知 kind / 无槽位预设落缺省承载、`carriesComponent` 未知 kind → false、`supportsSpriteSheet` / `supportsVideo` / `displayImageField`）；抽象基类不在 `CONCRETE_KINDS`；文档 schema 的枚举就是 `OBJECT_KINDS`（每个值都读得开、`GameObject` 一读出来就是 `Sprite` 并要回写、表外的值仍被挡住） |
| `document/asset-meta.test.ts` | 869 | **素材 meta 本身**（v23 新增、v24 扩到音频）：`<素材>.meta` 的 schema 与解析（缺 guid 补一个并 `needsRewrite`、高版本拒读、坏形状拒读）、GUID 生成与「只认小写」、导入设置与切分两个纯函数写入（`Default` 摘节点、`1×1` 摘 sheet、值没变返回原对象）、**音频那一段**（`audioNameOfMeta` / `audioTagsOfMeta` / `withMetaAudioName` / `withMetaAudioTags` / `withoutMetaAudioTag`：归一化去重升序、越界与洞丢弃、跨字段不互相覆盖）、`AssetMetas` 索引（guid ↔ 路径、重复 guid 先到先得、`metaOfImage` 先 guid 再 id）、以及 `validateAssetMetas` 的每一条 warning |
| `document/audio-meta.test.ts` | 472 | **素材轨**：显示名（旧 `setAudioMetaName` 的口径，写进 `.meta` 的 `audio.name`）、文件上的标签 ID 列表（旧 `setAudioMetaTags` 的口径，按工程文件的表归一化）、`withoutMetaAudioTag`（删标签的后半截）；**项目轨**：标签表新建/改名/按序号命名/删除（留洞）；读写工程文件与 **v17 → v18 → v24 迁移**（`audioMeta` 搬进 `migratedMetas`，表留在工程文件）；校验（`validateProject` 不再报 `audioMeta/...` 路径，那几条搬去了 `validateAssetMetas`） |
| `document/teleport.test.ts` | 370 | 传送阵工厂；`setTeleportTargets`（加/移候选）；`setTeleportPicked`；解析与版本（含 `{target}` 老形状迁移）；校验 |
| `document/magnifier.test.ts` | 492 | 放大镜工厂；`addMagnifierImage` / `removeMagnifierImage` / `setMagnifierPicked`（重复项、`picked` 跟着走、越界）；解析与版本（格式 30）；校验；存盘（GUID 换算）与推送（`spriteGrid` + 夹格） |
| `document/sound.test.ts` | 406 | 声音对象工厂；声音命令（列表/选中/层级/名字）；场景文件 schema；校验 |
| `renderer/gizmo.test.ts` | 363 | 矩形四角；绕枢轴旋转；八个缩放手柄与**边中点 = 相邻两角平均**；锚点对侧且随旋转转；角=等比 / 边=单轴；屏幕几何（中心点=平移量、柄落在角与边中点、太小不可绘制、移动轴贴着对象长、旋转环包住整个对象、**间距与环半径用矩形自己的半尺寸所以转过角度不「呼吸」**、转 45° 后绘制与命中仍是同一份坐标）；`toolHasGizmo` 与命中的口径一致；命中测试（容差是一条带子、旋转环内外都不命中、移动轴只认自己的轴、**拖动模式一个手柄都点不到**、太小一律不给命中） |
| `document/bgm-settings.test.ts` | 312 | 全局设置缺省值；**v16 迁移**（歌单从工程文件里拿掉）；三档音量；校验；**场景格式 v15**（环境音并进背景音乐） |
| `document/scale.test.ts` | 294 | 有效缩放（读路径）；写法归一（写路径）；`setObjectScaleAxes`；**v10 → v11 迁移**；坏数据校验 |
| `resources/project.test.ts` | 249 | 项目名校验（接受中文/空格/点/连字符；拒绝空、首尾空白、路径分隔符、Windows 非法字符、`.`/`..`、保留名、超长）；项目内相对路径校验（**逐段拒绝 `.` 与 `..`**）；创建/打开/删除项目（人类可读 JSON、重名拒绝、只有含 `project.json` 的目录才算项目、删除连资源清掉）；资源树（顶层只有 `Assets`、目录排在文件前、空目录也显示、目录来自真实条目而非凭空补、项目文件是特殊文件、只隐藏项目根那一个）；归属校验 |
| `document/history.test.ts` | 226 | 补丁式撤销/重做；连续操作合并（含窗口与 `endCoalescing`）；上限与 `reset` |
| `resources/resources.test.ts` | 221 | 逻辑 ID（只有两类、反斜杠规范化、缺前缀/路径抛错、旧类别已移除、拒绝越界、项目文件固定名、`Assets/` 约定集中在此、反推项目名与相对路径、`configId`）；内存实现（文本/二进制往返、按类别过滤、`ensureFolder` 幂等、读不存在抛错、非法 ID 不落盘、rename 文件/绝不覆盖/源不存在/类别不同/目录前缀替换）；应用配置（缺省默认值、自定义目录生效、非法配置抛带路径的错误） |
| `grid/brush.test.ts` | 205 | 画笔尺寸（与 Unity 整除语义一致，1/2→1×1、3/4→3×3）；覆盖格子；写入语义（按位或、橡皮清零、`eraseMask` 只清指定位）；`strokeCenters`（Bresenham 含两端）；`applyBrushStroke` 一整笔只拷贝一次 |
| `grid/world.test.ts` | 144 | 世界坐标 ↔ 网格（同向不翻转、角点与格心、最上行 y 最大、越界钳制）；`worldToGridPoint` 不夹取（网格外返回越界坐标而不是边缘格、边界归属）；地图挪了格子跟着走、同一世界点在不同地图上落不同格、世界可以很大；`unionWorldRects`（单张、两张错开、无地图返回 `undefined`） |
| `grid/mask-rle.test.ts` | 143 | 掩码位运算（数值与 Unity `GridCellType` 严格一致、可绘制类型 8 类顺序一致、`addMask` 不越界、`removeMask` 只清指定位、`hasMask`/`isEmptyMask`/`isBlocked`/`isFogMask`、`isValidMask` 拒绝越界与非整数、`maskToLabel`、区域显示名按可绘制顺序编号、`normalizeRegions`/`regionsToMask`）；RLE 往返（含跨行合并）、全空编码为单游程、空输入、格数不符抛错、游程非法抛错、64×36 真实尺寸往返 |
| `document/scenes.test.ts` | 129 | 场景名校验（接受正常名字；拒绝空名、超长与非法字符——场景名会直接成为文件名）；场景查找与重名判定（大小写不敏感、可排除自身）；场景内容命令（新建场景是空场景、对象可以独立于地图添加、地图也可以后加）；对象命名（连续创建与复制共用：没被占用用原名、被占用依次递增、trim + 大小写不敏感） |
| `renderer/viewport.test.ts` | 127 | 世界↔屏幕（原点落在 `(tx,ty)`、y 翻转、往返一致）；平移与缩放（锚点下的世界坐标不动、夹上下限、到上限返回原视口不漂移）；`fitViewport`（单张居中、宽高比不同按较小比例、地图不在原点时居中挪的是地图外框、多张按并集、无地图退回原点居中、视口尺寸 0 不产生 NaN）；`visibleWorldRect`（top 是 y 最大值） |
| `grid/mask-style.test.ts` | 110 | 默认颜色与 Unity `GetDefaultColor` 严格一致（每类 `#rrggbb` + 固定透明度、覆盖全部可绘制类型、未知位退回不透明白、**RGB 可改但透明度不给改**）；`cellMaskCss`/`isHexColor`（大小写不敏感、脏数据退回白色）；`visibleMaskBits`（高位→低位、顺序恒为 `PaintableTypes` 倒序、隐藏位跳过、整格隐藏返回空） |
| `grid/bytes.test.ts` | 88 | `.bytes` 编解码**对照 Unity 真实产物 `test/fixtures/Map001.bytes`**；合成数据与错误处理 |
| `renderer/audio-badge.test.ts` | 81 | 声音徽标动画：不播时静止；正在播两圈错开半周期；同一圈越扩越淡；周期性重复（含负时刻）；喇叭呼吸（四分之一周期最胀、四分之三最缩）；对象类型色（动作对象各有颜色、两个传送阵/声音分得开） |
| `grid/coords.test.ts` | 51 | 坐标契约只有世界坐标一套（y 向上）；网格范围判定；图片与网格的比例（`cellPixelSize`/`gridSizeFromImage`） |
| `renderer/hit-test.test.ts` | 52 | 矩形碰撞：内部命中、边界含在内、中心不在原点的矩形按自己中心判、**旋转 90° 后长边转到竖直方向**（不是轴对齐包围盒） |
| `editor/test/setup.ts` | 31 | jsdom 缺的浏览器 API 补齐 + `@testing-library/jest-dom` |

> 上表按行数降序混排了各包（表里的 `editor/test/setup.ts` 是搭头，**不算**在「25 文件 / 9,259 行」里）；
> 编辑器的 39 个文件（含 `setup.ts`、`asset-meta-fixtures.ts` 与 `helpers/fake-socket.ts`）见 §7.3.3。
> `setup.ts` 只补两件「jsdom 缺、浏览器有」的 API：`window.matchMedia`（store 在**模块求值期**就用它判断
> 紧凑布局，不补的话任何 import 了 store 的用例在收集阶段就炸；`matches` 恒为 `false` = 桌面布局）与
> `Element.prototype.scrollIntoView`（资源面板把左树滚到当前层时用；补空实现，**刻意不在组件里加特性判断**）。

#### 7.3.3 `apps/editor/test`（39 文件 / 9,146 行，jsdom）

| 文件 | 行数 | 覆盖的行为 |
|---|---|---|
| `sound-object.test.tsx` | 720 | 种类表里动作下的「播放声音」；创建声音对象；属性面板声音组（小方块单选/× 移出/清空/＋ 添加）；**选择器：点行只是选中（右侧原生 `<audio>` 试听），点「添加」才加入并关闭（一次一条），重复添加由 store 去重、行上无徽标**；播放/停止能不能点；面板上看得见的状态；store 的记账与日志 |
| `video-object.test.tsx` | 627 | 属性面板视频组（闸门/小方块单选/× 移出/清空/＋ 添加）；**选择器：行首首帧缩略图（挂了兜底公用图标）、点行选中右侧原生 `<video>` 预览（webm 带解码提醒）、「添加」一次一条**；播放/暂停/停止的可用性与状态显示；失败原因都在运行日志里写明；store 的加/删 |
| `descriptor-rows.test.tsx` | 169 | **描述符行的等价性契约**（v25）：三个开关的 testid 与行序与手写版逐字一致、tooltip 仍在、勾选走泛型入口且是一次可撤销编辑（撤销说明取规格标签）、三个开关互不干扰、组件缺失时按规格补壳再写。**这一份红 = 重构改了行为；这一份绿 + 既有测试零改动 = 只是换了实现** |
| `bgm-dialog.test.tsx` | 544 | 顶栏「音乐」按钮；「背景音乐」弹框（清单、搜索、标签勾选、路径开关、选中跟随播放、自动滚到当前曲、底部三键；显示名与标签来自各音频的 `.meta`）；**与项目设置分离** |
| `run-mode.test.ts` | 440 | **运行中的改动不保存、退出即还原**；切场景 = 换台（运行态下立刻推）；运行基线跟着文档走；运行中的文件操作与断线 |
| `bgm-settings.test.ts` | 340 | 推设置只剩三档音量；播放命令与补发；退出运行态音量还原、记账清零；音量编辑与场景编辑**共用一个撤销入口** |
| `grid-annotate.test.tsx` | 392 | 属性面板编辑窗口入口；画笔偏好写进 store 也写进浏览器本地；涂抹写进 RLE 且**整笔可撤销**；网格线与网格标注两个总开关；格子颜色只画可见位且按低位在上叠加 |
| `mask-math.test.ts` | 433 | `strokeStampCenters`；`applyEraseToPixels`（与 `MaskEraseStamp.shader` 同式，含「视频混合 0.5 有实心核 / 雾 1 擦不到 0」）；`paintRegionPixels`（整区开/关）；`fillMaskAlpha`（整张填 1 / 0，只动 alpha、越界值收敛）；`previewMaskSizeFor`/`brushRadiusFor`；`fillFogMaskPixels` |
| `teleport-object.test.tsx` | 324 | 种类表；创建；属性面板（候选小方块 + ＋ + 传送）；「传送目标」窗口勾选；触发传送（**不改文档**） |
| `magnifier-object.test.tsx` | 308 | 放大镜（v30）：种类表；创建（固定徽标 64×64）；属性面板（图片小方块单选 / `×` 移出 / 空列表提示 / 缺组件修复 / 编辑态只预览、运行态记账）；窗口（中间舞台 + 下面那排选图、底栏两个按钮的可用状态、对象被删的兜底）；`magnifierImageOf`（下标越界按没选处理） |
| `audio-catalog.test.ts` | 321 | 清单 = 项目音频 + 标注（名字与标签 ID 经**素材 meta 表**读）；标签表与文件上的标签；名字兜底链；搜索与标签筛选 |
| `transform.test.ts` | 305 | 移动（相对按下时的指针）；旋转（相对按下时的方位角，**屏幕上跟手**）；缩放（相对按下时的指针偏移） |
| `fog-mask.test.tsx` | 313 | 属性面板战争雾开关与雾区；揭示记账（**运行态才下发**给前端） |
| `video-blend-object.test.tsx` | 412 | 视频混合：准入（只有贴图、与「视频」互斥）、两路素材（种类开关 / 选择 / 清除）、循环 / 声音 / 自动播放、播放记账、Mask 窗口（编辑态只预览；运行态把擦一笔与**整张填 1 / 0** 记进同一条有序序列、幂等、不能挂的对象被拒） |
| `assets-panel.test.tsx` | 389 | 资源面板图标；展开三角；定位选中的文件 |
| `sprite-sheet.test.tsx` | 407 | **v20 新增**。属性面板那一行：整图时不显示子图信息、有子图时写清「第X行第Y列（列×行）」、切分改小后越界格有提示、「改回整图」清掉引用（切分留着——别的对象还在用）；选择窗口：改行 / 列落进**那个素材的 `.meta`**、点预览选一格、确定时图 + 格子一起写进对象、「使用整图」报 `null`、地图对象没有切分面板；**两条轨道**：窗口确定那一下 = **一条撤销记录**（整件事一起退回去），撤销切分**不动**场景里的对象 |
| `audio-tag-editor.test.tsx` | 254 | 列出标签表；只填名字（没有新建/删除）；改名只改表（文件上的引用一个字节不动）；关闭 |
| `inspector-groups.test.tsx` | 242 | 属性分组：基础/渲染/区域/战争雾/视频 |
| `audio-tag-dialog.test.tsx` | 237 | 列标签/勾选（勾的是**那个音频 `.meta` 里的 ID 列表**，表在工程文件）；只从已有标签里挑（没有新建入口）；目标与关闭 |
| `scene-switch.test.ts` | 218 | 切场景视口跟着场景走；**场景顺序（中文拼音序 + 数字按数值比）** |
| `asset-audio-meta.test.tsx` | 235 | 音频的**显示名与标签**：属性面板里改名字 / 勾标签（v24 起写进那个音频自己的 `.meta`，工程文件一个字节不动）；只对音频出现 |
| `asset-meta-generation.test.ts` | 305 | **「每个素材一份 meta」的补建**（v24 新增）：打开项目 / 刷新资源树时给缺 meta 的素材按种类现建（`assetImporterKind`：图片 / 音频 / 视频 / 场景，`Assets/scenes/` 之外的 `.json` 不配）、已经有的一份不改、写盘失败只报 warning 且算「有未保存改动」由去抖再试 |
| `asset-meta-fixtures.ts` | 58 | 素材 meta 用例共用的夹具与断言助手（造 `<素材>.meta` / 读回它），供上面两份用例复用 |
| `helpers/fake-socket.ts` | 117 | 假的 WebSocket 与连接 / 广播助手（`FakeSocket` / `connect` / `editorState` / `parsedSent` / `sentTypes`），供 run-mode 与 bgm-settings 两组用例走真链路 |
| `object-scale.test.tsx` | 174 | 缩放字段（所有对象都有）；`displayRectOf`（显示/拾取/选中框共用矩形） |
| `fog-reveal.test.ts` | 176 | 战争雾记账：擦除轨迹、整区开关、拖动中的分批、前端连上补发 |
| `runtime-push.test.ts` | 222 | `shouldPushScene`；`scenePayloadText`；**子图：切分随载荷走、改切分文本就变、越界夹到最后一格**；`ScenePushScheduler`（schedule/flush/cancel） |
| `object-lock.test.tsx` | 132 | 列表里的锁按钮；锁住 = 不能移动；属性面板里的锁定 |
| `video-playback.test.ts` | 125 | 记账：哪个对象该放什么；前端刚连上时的补发计划 |
| `open-project-folder.test.ts` | 120 | 「打开目录」 |
| `sound-playback.test.ts` | 119 | 记账：哪一层该播什么；前端刚连上时的补发计划 |
| `bgm-playback.test.ts` | 112 | 记账：现在该放哪一首；补发计划 |
| `asset-picker.test.ts` | 111 | 资源显示路径；图片/音频/视频素材列表 |
| `object-visibility.test.tsx` | 106 | 场景对象列表的激活按钮；棋盘底纹的锚点 |
| `editor-prefs.test.ts` | 88 | 默认值；解析；读写 |
| `scene-serialize.test.ts` | 65 | `serializeSceneFile` 按场景对象引用缓存 |
| `scene-rename-image.test.ts` | 84 | **回归护栏（v19 新增）**：重命名场景时同名贴图跟着改指——地图的贴图引用必须写进 `GridMap` 组件、**不能留下扁平 `map` 字段**（那会被 schema 丢掉 = 贴图丢失，而且类型检查抓不到）；精灵的图片不动、手工指定的贴图不动 |
| `runtime-client.test.ts` | 57 | 断开原因（close code / reason → 一句人话）；**重连退避**（别拿 500ms 去捶一个注定拒绝你的服务端） |
| `dialog-size.test.ts` | 55 | `dialogSizeFor`；`fitBox` |
| `object-kinds.test.ts` | 77 | **v22 新增**。类型表的**表级不变量**：每个 `ObjectKind` 都有且只有一个种类归属（面板按种类过滤，漏一个那种对象就凭空消失）；表里每个类型都有展示名、`id` 不重复；抽象基类 `GameObject` 只作归类项（不可创建、也不在弹框候选里，但仍归「实体」，手写文件里出现它时面板不会漏）；实体下可创建的就是 网格地图 / 精灵 / 贴图 三个具体类型 |
| `setup.ts` | 31 | jsdom 环境补齐 |

### 7.4 E2E 清单（20 spec + 2 helper + 1 teardown / 8,866 行）

| spec | 行数 | 覆盖的用户流程 | `@runtime` |
|---|---|---|---|
| `object-edit.spec.ts` | 1,195 | 创建与编辑场景对象（最大的一份：对象弹框、属性面板各组、改名/位置/贴图/网格、复制删除） | 否 |
| `scene-transform.spec.ts` | 881 | 场景变换手柄（移动/旋转/缩放的精确指针手势）+ 画布上的其它拖动 | 否 |
| `sound-object.spec.ts` | 634 | 动作对象「播放声音」（创建、属性面板、编辑窗口）+ 声音命令下发给前端 | **是**（第二部分） |
| `scene-menu.spec.ts` | 456 | 场景菜单（新建/改名/删除/上下场）+ 场景切换（切换条与快捷键 `1`-`9`、`[`/`]`） | 否 |
| `global-bgm.spec.ts` | 423 | 背景音乐：清单来自项目音频、与项目设置分离 + 背景音乐命令下发给前端 | **是**（第二部分） |
| `hierarchy.spec.ts` | 498 | 场景数据（对象列表、种类/关键字过滤）+ 场景对象行操作；**含 4 条迁移用例**：旧版工程文件 v2、旧版场景文件 v3 / v4、以及 **v18 扁平字段 → v19 组件**（断言 `formatVersion` 19、组件 id/type/data 精确、5 个扁平字段消失、网格与声音层级仍然渲染出来） | 否 |
| `smoke.spec.ts` | 354 | 编辑器外壳、画布视口交互、**平板紧凑布局**、编辑态/运行态 | **是**（第四部分） |
| `video-object.spec.ts` | 367 | 地图/贴图（`kind: "Image"`）的视频列表 + 视频命令下发给前端 | **是**（第二部分） |
| `video-blend.spec.ts` | 397 | 贴图的视频混合：两路素材（种类开关 / 选择）/ 循环 / 声音 / 自动播放落进场景文件，Mask 窗口擦了与**整张填 1 / 0** 都不落盘；命令下发 `play_video` / `stop_video` / `erase_video_mask` / `fill_video_mask` | **是** |
| `magnifier.spec.ts` | 398 | 放大镜（v30）：＋ 挑一张精灵（取一格）落盘成「GUID + 第几格」并自动选中；窗口里换图写文档、可撤销；画布双击徽标开路；运行态「打开窗口 / 关闭画面」下发 `open_magnifier` / `close_magnifier`，**换图不是命令**（假前端那边 `picked` 跟着整份场景变） | **是** |
| `fog-mask.spec.ts` | 307 | 战争雾 Mask 窗口 | 否 |
| `teleport.spec.ts` | 261 | 动作对象「传送阵」（候选、窗口、按一下换台） | 否 |
| `sprite-sheet.spec.ts` | 261 | **v20 新增**（三条）：① 选一格 → 只画那一格（画布采样四象限都成了那一格的颜色），并落进**两份文件**（场景文件只记「第几格」、切分在那个图的 `.meta` 里）；② 改切分 → 同一份引用换一块像素（对象侧一个字节都不改）；③ 地图对象的选择窗口**没有**切分面板（贴图不支持子图） | 否 |
| `audio-meta.spec.ts` | 250 | 音频标注在属性面板里改（显示名 + 标签）；**断言写进的是那个音频自己的 `<素材>.meta`**，工程文件里的标签表一个字节不动 | 否 |
| `fog-reveal.spec.ts` | 242 | 战争雾：轨迹下发给前端 | **是** |
| `grid-annotate.spec.ts` | 229 | 网格标注在画布上的显示（显示开关、颜色、叠加顺序） | 否 |
| `grid-edit-window.spec.ts` | 219 | 网格编辑窗口（落笔即格子、画笔、全部清除） | 否 |
| `inspector-groups.spec.ts` | 219 | 属性分组 | 否 |
| `project.spec.ts` | 200 | 项目（新建/打开/删除、资源树） | 否 |
| `object-lock.spec.ts` | 175 | 对象锁定 | 否 |
| `object-scale.spec.ts` | 124 | 对象缩放 | 否 |
| `startup.spec.ts` | 113 | 编辑器启动引导 | 否 |
| `helpers/editor.ts` | 1,094 | 用例级助手：建/删项目、打开编辑器、按 `data-testid` 定位、断言状态；**v19 起还有一组组件读取助手**：`COMPONENT`（**6 个**组件名常量：`gridMap` / `imageLayer` / `spriteLayer` / `playSound` / `teleport` / `videoOverlay`）、`componentId`、`findGameObject`、`componentInstanceOf`、`objectComponentData`、`componentDataOf(file, {objectId?\|kind?}, component)`、`withComponent`、`readSceneFile`、`readSceneMap`、`readSceneFog`、`readSceneSound`、`readSceneTeleport`、`readSceneVideo`（缺省找 `Map`，贴图要显式传 `"Image"`；spec 里**不再直接摸 `components`**，也不再有扁平字段读取）；**v20 起补子图助手**：`CURRENT_SCENE_FORMAT_VERSION = 24`、`colorGridPng(columns, rows, colors, cell)`（**每格一色的自编码 PNG**，用例靠它断言「画的是哪一格」）、`readObjectSprite`（读 `SpriteLayer` 的 `sprite`），`seedProjectDoc` 多了第四参 `projectPatch`；**v23 / v24 起补素材 meta 助手**：`readAssetMeta`（读某个素材自己的 `<素材>.meta` 原文）、`readSpriteSheet`（读 `sprite.sheet`）、`readAudioMeta`（读 `audio` 段）、`readProjectAudioTags`、`seedProjectAudioMeta`（种标签表 + 各音频的 `.meta`，缺的 meta 由编辑器打开时补齐） | — |
| `helpers/canvas.ts` | 344 | 画布助手：世界↔屏幕换算、精确点/拖手柄、读取 `data-viewport-*` | — |
| `global-teardown.ts` | 15 | 按 `DTS_E2E_RESOURCES` 清掉临时资源根 | — |

**并行与隔离**：

- `fullyParallel: true` + 多 worker；两条纪律不能破：**每个用例自建自删项目**（`newProject()` 带时间戳 + 随机后缀）、
  **每个用例用自己的 page**（不共享 localStorage / 视口状态）——破了就会出现「偶发失败」；
- `@runtime` 的额外三层保护：spec 内 `test.describe(..., { tag: "@runtime" })` +
  `test.describe.configure({ mode: "serial" })`（档位内串行）、`skipOutsideDesktop(testInfo)`（只在桌面档位跑，
  因为 `serial` 只管得住同一档位内部），以及**脚本层面的两趟跑法**；
- 跑在**临时资源根**（`<tmpdir>/dts-e2e-<pid>-<time>`，通过 `DTS_RESOURCES_DIR` 传给后端），
  既不往仓库 `resources/` 留垃圾，也不受仓库里现成项目影响；临时根里没有 `config/app.json`，
  所以后端用内置默认值（目录名与生产一致）；teardown 负责清掉；
  配置里**刻意不建目录**——worker 进程也会重新求值配置文件，任何副作用都会按 worker 数量翻倍；
- `E2E_WORKERS` 默认 **4**；完整三档矩阵约数分钟，桌面回归与冒烟命令用于更快的本地反馈；
  `E2E_WORKERS=1` 用来复现「串行才出现的时序问题」；
- 端口 `E2E_PORT` 默认 1421（**不是**后端默认的 1420）；`reuseExistingServer: true`；失败保留 trace；
- `globalTeardown` 只能是**文件路径**，所以临时根经环境变量 `DTS_E2E_RESOURCES` 传给 teardown。

**helper 的两处「复述常量」**（升级时必须同步改，注释里都写明了）：
`e2e/helpers/editor.ts` 的 `CURRENT_SCENE_FORMAT_VERSION = 24` 复述 `@dts/document` 的
`DOCUMENT_FORMAT_VERSION`；`fog-reveal.spec.ts` / `global-bgm.spec.ts` / `video-object.spec.ts` /
`video-blend.spec.ts` / `sound-object.spec.ts` / `magnifier.spec.ts` 里写死的 `protocolVersion: 21`
复述 `@dts/protocol` 的 `PROTOCOL_VERSION`。
E2E **不引用内部包**（根上没有 workspace 链接），所以这些常量不会被类型检查兜住。

---

## 8. 运行期资源与设计文档

### 8.1 `resources/` 布局

```
resources/
├─ config/
│  ├─ app.json        ← 唯一被后端读取的配置（resourceRoot / dirs / projectFolders / server / bundle）
│  ├─ editor.json     ← ⚠ 当前没有任何代码读取（见 §9.3）
│  └─ export.json     ← ⚠ 当前没有任何代码读取（见 §9.3）
└─ projects/
   ├─ .gitkeep
   └─ 测试项目/                       ← 手动测试与联调用的固定数据（整库入库，含图片/音频/视频）
      ├─ project.json
      └─ Assets/
         ├─ config/                  （空，只有 .gitkeep）
         ├─ scenes/场景1.json 场景2.json 场景3.json（各配一份 `.json.meta`）
         ├─ images/A.png B.png C.png D.png Bridge.png Map001..3.png（**每个素材旁边一份 `<素材>.meta`**）
         ├─ audio/act-2/*、act-2-to-act-3/*、character-creation/*、environment/*（同样成对带 `.meta`）
         └─ video/Map001.mp4 Map002.mp4 Map003.mp4 Map003_1..3.mp4
```

> **每个素材旁边一份 `<素材>.meta`**（v24 口径）：`.meta` 不进资源树、也不进素材清单
> （`FsResourceProvider.list` 滤掉它，见 §3.4），它跟着素材一起改名 / 移动。

- **一个项目 = 一个文件夹 + `project.json`**；一切内容在 `Assets/` 下（`config`/`scenes`/`images`/`audio`/`video`）；
- 场景名 = 文件名；地图贴图约定与场景同名（`Assets/images/<场景名>.png`）；
- 每个标准目录里都有一个 `.gitkeep`：后端 `list()` **刻意跳过**它（空目录要能在资源面板里显示，
  但 `.gitkeep` 本身不是资源）；
- `.gitignore` **默认忽略** `resources/projects/*/Assets/{audio,video,images}/*`（大体积二进制不入库），
  但对 `测试项目` 显式加回（`!`）——它是手测与联调的固定数据，缺一张图就会看起来像 bug；
- 后端不依赖资源根存在：`loadConfig` 读不到 `config/app.json` 就用内置默认值，目录由首次写入时按需创建
  （E2E 依赖这一点）。

**`测试项目` 的实际内容**（磁盘上已经是 `formatVersion: 29`——v22 改了 kind 的名字，v23 / v24 把图片切分与
音频标注搬进各素材的 `.meta`，v25 拆出 `FogOfWar`，v26 把显示顺序搬进渲染组件，v27 战争雾变成独立对象，v28 取消 `Map` 类型（网格变成贴图上的可选组件），v29 视频混合的两路收成单个素材（图片 / 视频）；历史文件由**编辑器打开时自动迁移并回写一次**，见 §6.2；下表按**迁移后**的样子写）：

| 文件 | 内容 |
|---|---|
| `project.json` | `formatVersion: 28`；`items = { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] }`；`settings.audio` = `bgm 0.6 / sfx 0.8 / voice 1`（**只有音量**）；`audioTags = ["场景1","场景2","场景3"]`——**v24 起工程文件里没有 `audioMeta`**：两条标注住在各自音频的 `.meta` 里（`act-2-to-act-3/06-altar-transition.mp3.meta → {tags:[0,2]}`、`act-2/01-bird-capture-part-1.mp3.meta → {name:"声音1", tags:[0,1,2]}`） |
| `Assets/scenes/场景1.json` | **5 个对象**：① `Map`「地图」（`GridMap` data 的 `sortingOrder -1`、`locked`、`Map001.png` 1920×1080、`grid 64×36`、RLE 72 段、独立 `FogOfWar {enabled:true, regions:[1,2,4]}`，另带一个 `VideoOverlay`：`Map001.mp4`、`loop` 与 `audio` 都 true）；② `Sprite`「精灵」（`scale 0.1`，`SpriteLayer` 带 `sortingOrder 1` 与 `sprite {column:0, row:1}`；引用上写的还是改名前的路径，而真正的图集是 `B.png`——它的 `.meta` 里 `sprite.mode:"Multiple"`、`sheet 2×2`）；③ `PlaySound`「播放声音」（3 条 clips、`picked` = `06-altar-transition.mp3`、`layer:"voice"`）；④ `Teleport`「传送阵」（`targets:["场景2","场景3"]`、`picked:"场景3"`）；⑤ `Image`「贴图」（`ImageLayer` data 的 `sortingOrder 1`、`Bridge.png` 256×256、`rotation ≈ -15°`、`locked`） |
| `Assets/scenes/场景2.json` | 1 个 `Map`「网格地图」（`Map002.png`、`cells` 单个游程 `[[0, 2304]]` 即全空） |
| `Assets/scenes/场景3.json` | 1 个 `Map`「网格地图」（`Map003.png`）+ `VideoOverlay { enabled:true, clips:[Map003_1..3.mp4], picked:"Map003_1.mp4", loop:false, audio:false }` |

这份数据是**四个大特性各一份样例**（战争雾 + 传送阵 + 声音对象 + 视频）外加一条子图引用，改文档格式时它是最直接的回归样本。
**子图在这份数据里只占一条引用**（场景1 的「精灵」取 `B.png` 的 `{column:0, row:1}`，而「怎么切」在那个素材自己的 `.meta` 里）；
要断言「画的是哪一格」仍然靠 `e2e/sprite-sheet.spec.ts` 在临时资源根里现造「每格一色的图集」
（`colorGridPng` + `seedProjectDoc(..., projectPatch)`）。
v23 / v24 之后，**素材级数据（切分 / 导入设置 / 音频标注）都不在工程文件里**：工程文件只剩 `audioTags` 这张项目级表。

### 8.2 `resources/config/*.json` 的键

`app.json`（**生效**，见 §4.3）：`resourceRoot`、`dirs{config,project}`、`projectFolders[]`、
`server{host,port}`、`defaultCellPixels`、`bundle.maxTotalBytes`。

`editor.json`（**未生效**）：`theme`、`viewport{background,gridColor,maxDevicePixelRatio}`、
`grid{defaultWidth,defaultHeight,defaultCellSize}`、`brush{defaultSize,defaultMask}`、
`snapToGrid`、`autosaveMs`。这些值在代码里另有真源（如自动存去抖是 `SCENE_SAVE_DEBOUNCE_MS = 800`、
视口底色在 `@dts/renderer` 的 `DEFAULT_BACKGROUND`），**改这个文件不会改变行为**。

`export.json`（**未生效**）：`description` + `gridBytes`/`mapImage`/`placement`/`items` 四组
`{enabled, directory, fileNamePattern}`——导出目标映射，属早期设计残留。

### 8.3 `docs/specs/` 两份设计文档

| 文档 | 状态 | 内容 |
|---|---|---|
| `2026-09-19-runtime-mirror-protocol.md`（181 行） | **现行** | 运行态镜像协议：门控表（未开闸 503 / `runtime_start` 开闸 / `runtime_stop` 关闸 4003 / 编辑器掉线**什么都不做** / 服务端重启清空）；「运行中的改动不保存、退出即还原」六条规则；`/editor` 与 `/client` 的完整消息表；`SceneDoc` → Unity 的字段映射表（`position{y}` → `(x,0,y)`、`rotation` 绕 +Y 取 `-rotation`、`sortingOrder` + 微小离地、`PlaySound`/`Teleport` **不建可见物**、`map.fog` 只有 `enabled && regions.length>0` 才建那一层雾）；战争雾「发轨迹不发遮罩」的算法（`points` 归一化 y 向下、前端翻 y、`step = max(1, 半径/2)` 补点、`min` 幂等）；客户端实现位置表（`client/Assets/...` 各文件职责） |
| `2026-09-18-frontend-integration-contract.md`（198 行） | **已废弃**（文件头明确标注） | 老模型：前端上报对象/动作、后台按 id 寻址（`register_actions` / `invoke_action` / `action_result`）。**不要照它实现**，留作追溯 |

---

## 9. 附录

### 9.1 端到端时序（一次完整的运行态回合）

```
① 启动        pnpm dev → 后端 1420 + Vite 5173
② 编辑器启动  main.tsx → EditorShell → bootstrapEditor()
               → connectRuntime()（WS /editor）→ editor_hello
               → 列项目（GET /api/projects）→ 有记录且还在就 openProject()
               → loadScenes()（GET /api/projects/tree）→ 打开上次的场景
③ 点「运行」  setMode("run") → runtime_start
               → hub.session.start()（开闸，幂等）
               → pushRuntimeScene()（去抖 200ms 或立刻）→ scene_push
               → hub 缓存 scene + 广播 editor_state
④ 前端连接    WS /client（未开闸则握手 503 + x-dts-reason，自动 3s 重试）
               ← server_hello                 （协议版本握手）
               ← resources_prepare{project}   （先知道是哪个项目）
               ← project_settings{settings}   （音量先于场景到）
               ← scene_sync{scene}            （全量镜像）
               → client_hello{name,version}   （补上「前端是谁」）
⑤ 拉资源包    GET /api/resources/bundle?project=..&v=<本地指纹>
               → 304（没变）或整包 zip（含 dts-bundle.json）
               → resources_ready → hub 记状态 + 广播 editor_state
⑥ 播放命令    DM 点 ▶ → editor_command{requestId, command{kind:"play_sound",…}}
               → hub 校验：开闸 ✓ 前端在线 ✓ → 转发 command
               → trackCommand（15s 超时计时器）
               ← command_result{requestId, ok} → 清计时器
               → editor_command_result + editor_log → 编辑器运行面板显示
⑦ 运行中编辑  改对象 → sceneHistory.apply → 去抖 800ms 触发「运行态不落盘」分支
               → 只置 sceneSaveState="runtime" 并 scheduleRuntimePush()
               → 200ms 后内容有变则 scene_push → 前端镜像跟着变
⑧ 关闸        DM 点「编辑」→ runtime_stop
               → hub.session.stop() + kickClient(4003)
               → restoreRunBaseline()（三份历史 reset，运行期间的改动全部丢弃）
               → 保存状态恢复正常，之后照常落盘
```

### 9.2 变更指引：要动哪几个文件

| 想做的事 | 需要改的地方 |
|---|---|
| **给场景对象加一个字段** | `@dts/document`：`types.ts`（类型）+ `schema.ts`（schema、默认值取舍、必要时迁移函数）+ `validation.ts`（校验）+ `commands/`（setter）+ `factory.ts`（新建默认值）；若前端要用：`@dts/protocol` 的 `messages.ts`（**同步复刻字段**，并判断是否要升 `PROTOCOL_VERSION`）；`apps/editor`：`panels/inspector/` 的注册表 + 字段组件 + store action；`apps/backend/src/mock-client`（打印出来便于联调）；三处测试；`server/README.md` |
| **加一种素材级数据**（跟着文件走：切分 / 导入设置 / 音频标注） | `@dts/document` 的 `asset-meta.ts`（形状 + schema + **纯函数写入，唯一口径**）+ `schema.ts`（若要从工程文件搬过来：加一个 `migrateXxxMetas` 并并进 `migratedMetas`）+ `validation.ts`（`validateAssetMetas` 那一类检查）；`@dts/resources` 的 `assetMetaIdOf` 已有 `<素材>.meta` 的 ID 换算；`apps/editor`：切片里走 `applyMetas`（第三条轨道）、`store-types.ts` 补状态字段、`panels/asset-info.ts` 的导入器判定、`project-slice.ts` 的 `loadAssetMetas` 补建缺的那几份；单测 + E2E（`readAssetMeta` 之类的助手） |
| **加一条协议命令** | `@dts/protocol`：`commandRequestSchema` 加变体 + `PROTOCOL_VERSION + 1`；`hub.ts`（**无需改动**，转发是通用的）；`mock-client`（回执文案）；`apps/editor`：`services/runtime-client` 发送 + 对应记账服务 + store action；`client/`（Unity `CommandRouter`）；E2E 加一个 `@runtime` 用例；两份 spec / README |
| **加一个 HTTP 接口** | `apps/backend/src/http/routes/<domain>.ts` 加 handler 并在 `routes/index.ts` 注册；`apps/editor/src/services/project-api.ts`；`apps/backend/test` 加用例；`README` 的接口清单 |
| **加一个项目子目录 / 资源类别** | `@dts/resources/src/ids.ts` 的 `PROJECT_FOLDERS` / `DEFAULT_PROJECT_FOLDERS`（**唯一约定来源**）+ `resources/config/app.json` 的 `projectFolders`；若新增的是**资源类别**（`ResourceKind`），还要改 `provider.ts` 的 `DEFAULT_RESOURCE_DIRS` 与 `config.ts` 的 `dirsSchema`（`satisfies` 会强制你补全） |
| **加一个内部包** | `pnpm-workspace.yaml`（已是 `packages/*`，无需改）+ 新包 `package.json`/`tsconfig.json`；`test/architecture.test.ts` 的 `PURE_PACKAGES` 或 `DOM_OK_PACKAGES` 与 `ALLOWED` 表；`tsconfig` 继承 |
| **加一个变换工具** | `@dts/renderer`：`gizmo.ts` 的 `TransformTool` + `toolHasGizmo` + `gizmoScreenGeometry` + `hitTestGizmoHandles` + `scene-renderer` 的 `drawGizmo`；`apps/editor`：`panels/scene/transform.ts` 的 `resolveTransform` + `ScenePanel` + `store.setTool` + `services/editor-prefs` + `MenuBar` 的「视图」菜单；`gizmo.test.ts` |
| **加一个校验项** | `document/src/validation.ts`；对应 `*.test.ts`；若会影响进运行态，注意 `hasErrors` 的语义 |
| **加一个文档版本迁移** | `document/src/schema.ts`：`upgradeRawDocument`（若改的是原始 JSON 形状）或 `withFilledObjectFields` / 新增 `migrateXxx`；`DOCUMENT_FORMAT_VERSION + 1`；`needsRewrite` 条件；`document.test.ts` 的迁移用例 |
| **加一个「对象画成什么样」的渲染选项** | **先判断它是「数据」还是「新组件」**——子图（v20）就是数据：住在图片组件的 `image` 数据上（精灵 `SpriteLayer` / 贴图 `ImageLayer`，见 v21）而不是新组件里（理由见 §1.6）。数据式的加法：`@dts/document` 的 `sprites.ts`（口径与解析的**唯一归属地**）+ `types.ts` + `schema.ts` + `validation.ts`；`@dts/protocol` 的 `messages.ts`（前端也要用就 `+1`，并想清**老客户端会怎么错**——子图是「铺错整张图」，那必须靠握手挡住）；`@dts/renderer` 的 `SceneLayer`；编辑器：入口对话框 + 属性面板字段 + `slices/<功能>-slice.ts`；`client/`（解析 + UV）；跨包契约测试 + 单测 + E2E |

### 9.3 已知不一致与注意点（读代码时会踩到的）

1. **`HttpResourceProvider` 并不存在**。`packages/resources/src/provider.ts` 的注释把它列为「三种实现」之一
   （`MemoryResourceProvider` / `FsResourceProvider` / `HttpResourceProvider`），但编辑器侧实际用的是
   `apps/editor/src/services/project-api.ts` 里的 fetch 封装，**没有实现 `ResourceProvider` 接口**。
2. **`resources/config/editor.json` 与 `export.json` 没有任何代码读取**（`config.ts` 只读 `app.json`）。
   `editor.json` 里的 `autosaveMs: 1500` 与代码里的 `SCENE_SAVE_DEBOUNCE_MS = 800` **不一致**——
   别把这两个文件当成真源。
3. **`app.json` 的 `resourceRoot` 改了不会改变资源根**：后端只把它当作「定位 app.json 的起点」，
   真正生效的根由 `loadConfig` 决定（模块位置 `../../../resources`，或环境变量 `DTS_RESOURCES_DIR`，或显式参数）。
4. **注释里的版本号有一处含糊**：`types.ts` 里 `ProjectDoc.settings` 标注「v15 起」，
   而同一文件 `BgmSettingsDoc` 段写「v15 起……只剩音量」——`bgm` 收敛成只有音量实际是 **v16**
   （迁移函数 `migrateBgmSettings` 标的是 v16）。代码行为不受影响。
5. **素材旁边的孤儿 `<素材>.meta` 没人清**（v23 / v24）：`.meta` 是元数据、不进资源树，所以素材在编辑器外面被删 / 改名而没带上 `.meta` 时，盘上会留一份谁也不读的旧 `<素材>.meta`（`readMetas` 按素材找 meta，孤儿那份连读都不读）。反过来，v24 之前那种「工程文件里指向已删音频、界面上看不见的记录」（旧 `audioMeta`）已经不存在了——标注跟着素材走。
6. **场景改名不会自动跟随传送目标**（`teleport.targets` 存场景名），会变成「已失效」；
   但**网格地图贴图会自动跟随**（`renameScene` 同步指向旧场景名的那张图，v28 起在 `ImageLayer` 里）。**精灵的图片不动**。
7. **Linux 上「定位文件」退化为「打开父目录」**（`fileRevealCommand` 返回 `reveal: false`）；
   不认识的平台直接给可读错误。
8. **`uploadFiles` 在 store 里实现但没有 UI 调用点**——编辑器不导入素材（`src` 下没有任何 `<input type="file">`），
   素材由外部工具提交到 `Assets/`。
9. **`@dts/protocol` 与 `@dts/document` 是两套手工同步的 schema**（§6.3）。改了文档字段却忘了改协议侧，
    类型检查不会报错，只会在运行时被 zod 丢掉或拒掉。
10. **`@dts/renderer` 的 `package.json` 只声明 `@dts/grid`**，架构测试允许它依赖 `document`，
    但当前代码不依赖（`SceneLayer` 是渲染器自己的投影类型）；要加依赖时记得同时改 `package.json` 与 `ALLOWED`。
11. **E2E 的 `@runtime` 用例操作全局单例**：`pnpm e2e` 的两趟分法（`--grep-invert @runtime` 并行
    + `--grep @runtime --workers=1`）不能改，手工敲 `npx playwright test` 时也要照抄。
12. **构建产物带内容哈希**：`pnpm build` 之后，构建前打开的页面必须刷新；后端对缺失产物回 404
    （不回 `index.html`）正是为了这一点。
13. **`resources/config/app.json` 的 `dirs` 与 `projectFolders` 会被 `FsResourceProvider` 构造时校验**
    （必须相对且不越出资源根），写错会**直接拒绝启动**而不是静默降级。
14. **README 与 `playwright.config.ts` 对 E2E worker 数的说法不一致**：`server/README.md` 写「worker 数默认按核数
    一半、封顶 8」，而配置里是固定的 `Number(process.env.E2E_WORKERS ?? 4)`。**以配置文件为准**。
15. **E2E 里有几处「复述常量」不会被类型检查兜住**（见 §7.4 末）：`CURRENT_SCENE_FORMAT_VERSION = 24`、
    各 spec 里写死的 `protocolVersion: 12`，以及 `scene-transform.spec.ts` 顶部复述的手柄几何常量
    （`GIZMO_AXIS_GAP` 45 / `GIZMO_AXIS_LENGTH` 40 / `GIZMO_RING_GAP` 22）。改这些常量时要一起改。
16. **`resources/projects/` 里唯一的项目是「测试项目」**（含 3 个场景、8 张图片、6 个视频、18 个音频，
    每个素材旁边还有一份 `.meta`），
    它是仓库里唯一「有 `project.json` 因此被接口认成项目」的目录——所以 `e2e/startup.spec.ts` 必须把
    `/api/projects` 打桩成空，才能稳定断言「一个项目都没有」。
17. **孤儿 `.meta` 没有清理入口**（v23 / v24）：素材被删 / 改名而 `.meta` 没跟着走时，盘上会留一份
    `<旧名>.meta`（与第 5 条同一个缺口——`.meta` 是元数据，不进资源树，所以没人提醒你）。
    工程文件那边已经没有「对不上的素材级键」了（切分与音频标注都搬走了）。能做的只有：在选择窗口里对
    **当前挑中的那张图**点「清除切分」（`sprite-clear-sheet`）把 `sheet` 从它的 `.meta` 里摘掉——而且
    **还有对象在用这张图的格子时它是禁用的**（提示先让那些对象「改回整图」）：删掉切分等于让它们的引用失去意义。
18. **重切不会回头改对象在场景里的尺寸**（v20）：`ImageRef.width / height` 是**选格那一刻**声明出来的
    （整图 = 图宽；子图 = 那一格的宽高，`spriteCellSizeOf`），改切分只改「画哪一块」，**不会**重算已放好的
    对象的尺寸——要改大小请用缩放，或重新挑一格（那会写一条新的场景撤销记录）。这样做的理由是
    「一次操作不跨两条撤销轨道」：改切分在**素材 meta 轨**、改尺寸在场景轨，混在一起会让撤销说不清退回了哪一半。

---

> 本文由代码实际内容整理（源码 + 测试 + 配置 + 设计文档），行数取自 `ReadAllLines().Count`
> （**含空行**）。若要核对某个数字，用 `[System.IO.File]::ReadAllLines($path).Count`；
> PowerShell 的 `Measure-Object -Line` **不计空行**，会得到偏小的值。
