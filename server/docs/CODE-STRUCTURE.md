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
| 文档格式版本 | `DOCUMENT_FORMAT_VERSION = 19`（`packages/document/src/types.ts`） |
| 协议版本 | `PROTOCOL_VERSION = 9`（`packages/protocol/src/messages.ts`） |
| 后端默认地址 | `0.0.0.0:1420`（`resources/config/app.json`，可被 `HOST` / `PORT` 覆盖） |
| 编辑器开发地址 | `http://localhost:5173`（Vite，`/api`、`/editor`、`/client` 反代到 1420） |
| 编辑器生产地址 | `http://localhost:1420`（后端同源托管 `apps/editor/dist`） |
| 源码规模（不含测试） | 152 个文件 / 31,002 行（packages 9,918 · backend 3,123 · editor 17,961） |
| 测试规模 | 25,831 行（单测 17,472 · E2E 8,127 · 架构测试 232） |

### 0.1 本次重构（解耦 + 实体/组件）留下了什么同一批改动做了三件事，互相独立又可分开回滚：

| 改动 | 之前 | 之后 | 加一个功能要改几处 |
|---|---|---|---|
| **HTTP 一条协议一个函数** | `http/server.ts` 633 行、一条 `switch` | 13 个文件，`server.ts` **59 行** + `routes/*` | 加一个接口 = 加一个函数 + 路由表一行 |
| **WS 一条消息一个函数** | `ws/hub.ts` 621 行、两条 `switch` | 8 个文件，`hub.ts` **465 行**（只管传输）+ `handlers/*` | 加一条消息 = 加一个函数（表的键完整性由类型保证） |
| **实体 + 组件（真 ECS）** | 对象上 5 个特性扁平字段 + 各处 `kind === "…"` | `components[]` + 特性表/访问器；文档 v19 / 协议 v9 / Unity 客户端同步 | 加一个特性 = 加一个组件 + 注册表一行（见 §1.6） |
| **文档命令分模块** | `commands.ts` 2,069 行 | `commands/` 10 个文件（按特性） | 加一个特性的命令 = 加一个文件 |
| **编辑器 store 分片** | `editor-store.ts` 4,493 行 | 组装点 **96 行** + 15 个切片 + 上下文（见 §5.2） | 加一个功能 = 加一个 `slices/<功能>-slice.ts` + 组装点一行 |
| **属性面板注册表** | `InspectorPanel.tsx` 1,195 行的 JSX 分支 | `InspectorPanel.tsx` **343 行** + `registry.tsx` + `object-fields.tsx` | 加一个特性分组 = 注册表一行 + 一个字段组件 |

**代价是诚实的**：源码从 28,810 行长到 31,002 行（+7.6%）——多出来的是文件头注释、import/export
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
│  ├─ backend/                 # Node/TS 服务端（3,123 行）
│  │  └─ src/
│  │     ├─ index.ts           # 进程入口：装配 config + provider + hub + http
│  │     ├─ config.ts          # 资源根与 app.json 引导（全项目唯一允许出现资源根字面量的地方）
│  │     ├─ net.ts             # 局域网地址探测与筛选
│  │     ├─ open-folder.ts     # 调系统文件管理器打开/定位（唯一 spawn 的地方）
│  │     ├─ http/              # ★ 一条协议一个函数：server.ts(59) + router/context/responses/requests/mime/static
│  │     │  └─ routes/         #   health / config / state / projects / resources + index(路由表)
│  │     ├─ resources/         # FsResourceProvider（唯一碰磁盘的地方）、zip 打包器、资源包缓存
│  │     ├─ ws/                # hub（传输层）+ hub-context + types + handlers/（一条消息一个函数）
│  │     └─ mock-client/       # 假 Unity 前端（联调用）
│  └─ editor/                  # React 编辑器（17,961 行）
│     └─ src/{app,panels,services,state,hooks,styles}/   # state/ 是切片式 store（见 §5.2）
├─ packages/                   # 6 个可独立测试的内部模块（9,918 行）
│  ├─ grid/                    # 位掩码、坐标换算、RLE、.bytes 编解码（零依赖）
│  ├─ document/                # 文档模型 + 特性表 + 访问器 + zod 校验 + 组件注册表 + 补丁式撤销
│  ├─ actions/                 # 动作类型注册表 + 条件求值 + 动作图校验
│  ├─ protocol/                # WS 消息契约（编辑器 / 服务端 / 前端共用）
│  ├─ resources/               # 逻辑 ID 规则 + ResourceProvider 抽象 + 内存实现
│  └─ renderer/                # Canvas 2D 渲染器、视口变换、变换手柄几何（不依赖 React）
├─ resources/                  # ★ 全部运行期资源
│  ├─ config/{app,editor,export}.json
│  └─ projects/<项目名>/{project.json, Assets/{config,scenes,images,audio,video}/}
├─ e2e/                        # Playwright 用例（8,127 行）
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
                       └───┬────────┬────────┬────────┘
                           │        │        │
        ┌──────────────────┘        │        └──────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐          ┌───────────────┐          ┌───────────────┐
│ @dts/renderer │          │ @dts/actions  │          │ @dts/document │
│ Canvas 2D     │          │ 动作注册表/条件 │          │ 文档模型/命令   │
└───────┬───────┘          └───────┬───────┘          └───┬───────┬───┘
        │                          │                      │       │
        │                          └──────────────────────┘       │
        ▼                                                         ▼
┌───────────────┐                                        ┌───────────────┐
│  @dts/grid    │◀───────────────────────────────────────│  @dts/grid    │
│  位掩码/坐标   │                                        └───────────────┘
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
| `actions` | `document`、`grid` |
| `renderer` | `grid`、`document` |

应用层的实际依赖：

- `apps/editor` → `document`、`actions`、`protocol`、`resources`、`renderer`、`grid`（`package.json` 里全部声明）；
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

### 1.6 实体 + 组件（v19 起）

场景对象现在由两半组成：

```
SceneObjectDoc
├─ 实体自身（所有对象都有）：id / name / kind / active / locked / sortingOrder
│                            position / rotation / scale / scaleX? / scaleY?
└─ components: ComponentDoc[]   ← 「对象是什么、画成什么样、运行时能做什么」全在这里
   ├─ 前端组件体系那 7 种：OptionValue / Backpack / ItemExchange / MaskImage / FloatValue / IntValue / BoolValue
   └─ 从对象特性提升上来的 5 种（v19 前是扁平字段）：
      GridMap(←map) / TextureRenderer(←image) / PlaySound(←sound) / Teleport(←teleport) / VideoOverlay(←video)
```

**关键约定**（改这块代码前必须知道）：

| 约定 | 在哪实现 |
|---|---|
| 「哪个 kind 能带哪个特性」只有**一处**归属地 | `packages/document/src/features.ts` 的 `OBJECT_FEATURES`（`kindsCarrying` / `carriesKind`） |
| 特性数据怎么读 / 怎么写只有**一处**归属地 | `packages/document/src/access.ts`（`mapDataOf` / `ensureSoundData` / `writeFeature` …）。**禁止**在调用处 `object.components.find(...)` |
| 组件类型名与元数据只有**一处**归属地 | `packages/document/src/components.ts` 的 `COMPONENT_TYPES`（12 条；`kinds` 从 `OBJECT_FEATURES` 取回，`legacyField` 记着 v18 的字段名） |
| 组件实例 id 是**确定性**的 | `componentId(objectId, type)` = `<对象id>__<组件类型>`，所以迁移与新建重复执行都不会多出实例 |
| 同一个对象上**同一类型最多一个**实例 | 新建、迁移、`writeFeature` 都按这个前提写 |
| `kind` **不再决定行为** | 只是「创建原型」标签：新建弹框归类、列表过滤、占位色（`SceneObjectView.NeedsView(MirrorObject)` 也改看组件） |
| 协议与文档的组件口径必须一致 | 两套 schema 是刻意复刻的（`protocol` 不能依赖 `document`），由 `apps/backend/test/protocol-document-contract.test.ts` 断言 |

**加一个对象特性（v20 起该怎么做）**：

1. `features.ts`：给 `ObjectFeatureField` 加一个字段名、给 `FEATURE_COMPONENT` 加一个组件类型名、往 `OBJECT_FEATURES` 加一行（写清 `kinds`）；
2. `components.ts`：加一条 `COMPONENT_TYPES`（`legacyField` 留空——新特性没有历史字段）；
3. 新建一个 `components/<你的特性>.ts` 放它的 zod schema；`schema.ts` 的 `sceneComponentSchema` 加一个 `componentSchemaOf(...)`；
4. `access.ts`：加 `xxxOf` / `ensureXxx`（**只在这一个文件里碰 `components`**）；
5. `commands/`（或 `commands.ts`）：加它的写命令，全部经访问器；
6. `validation.ts`：加它的语义校验；
7. `protocol/src/messages.ts`：`COMPONENT_TYPE` 加一项、`sceneComponentSchema` 加一个分支（契约测试会盯着你别漏）；
8. 编辑器 `panels/inspector/`：加一个分组视图组件；
9. `client/.../SceneParser.cs`：加一个 `case`（不加也不会崩——未知组件会被安静地留下）。

也就是说：**特性本身的代码是新增文件，而不是去十几处 `kind === "…"` 里插分支**。

---

## 2. 工程与工具链

### 2.1 workspace 与包清单

`pnpm-workspace.yaml` 声明 `apps/*` 与 `packages/*`；`allowBuilds` 只放行 `esbuild`（Vite/tsx 的平台二进制），
其余依赖不执行安装脚本（供应链收敛）。

| 包 | 名称 | 入口 | 依赖 |
|---|---|---|---|
| `packages/grid` | `@dts/grid` | `./src/index.ts` | 无 |
| `packages/document` | `@dts/document` | `./src/index.ts` | `@dts/grid`、`immer`、`zod` |
| `packages/actions` | `@dts/actions` | `./src/index.ts` | `@dts/document` |
| `packages/protocol` | `@dts/protocol` | `./src/index.ts` | `zod` |
| `packages/resources` | `@dts/resources` | `./src/index.ts` | `zod` |
| `packages/renderer` | `@dts/renderer` | `./src/index.ts` | `@dts/grid` |
| `apps/backend` | `@dts/backend` | `src/index.ts` | `@dts/{document,protocol,resources}`、`ws` |
| `apps/editor` | `@dts/editor` | `index.html` → `src/main.tsx` | 全部 `@dts/*`、React 19、zustand、Radix UI、react-resizable-panels、@tanstack/react-virtual |

所有包都是 `"type": "module"`、`private`、`version: 0.0.0`，导出直接指向 `src/*.ts`（无构建步骤，靠 Vite/tsx 转译）。
另外：**6 个 `packages/*` 都没有 `test` 脚本**——单测从根 `vitest run` 统一跑（各包只有 `typecheck`）。

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
| `e2e` | `playwright test --grep-invert @runtime && playwright test --grep @runtime --workers=1` | 两趟：并行 + 运行态串行 |
| `e2e:fast` | 同上但 `--project=desktop-chrome` | 只跑桌面档位 |
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

### 3.1 `@dts/grid` — 网格几何与编解码（734 行，零依赖）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `mask.ts` | 232 | 格子类型位掩码、显示标签与颜色 | `CellMask`（`Empty:0 / Obstacle:1 / Difficult:2 / Water:4 / Fog1:8 … Fog5:128`）、`PAINTABLE_MASKS`、`FOG_MASK`、`ALL_MASK`、`hasMask`、`addMask`、`removeMask`、`isEmptyMask`、`isFogMask`、`isBlocked`、`maskToLabel`（→ `区域1+区域4`）、`normalizeRegions`、`regionsToMask`、`defaultCellMaskStyle`、`defaultCellMaskColors`、`cellMaskRgba`、`cellMaskCss`、`isHexColor`、`visibleMaskBits`、`isValidMask`；类型 `CellMaskStyle{hex,alpha}` |
| `coords.ts` | 60 | 坐标契约：世界 ↔ 网格 ↔ 贴图像素 | `isInsideGrid`、`cellPixelSize`、`gridSizeFromImage`；类型 `GridSize`、`ImageSize`、`WorldPoint`、`GridPoint` |
| `world.ts` | 122 | 世界矩形与格子换算 | `worldRectOf`、`worldRectLeft`、`worldRectBottom`、`worldRectTopLeft`、`unionWorldRects`、`gridToWorld`、`worldToGridPoint`（不夹取）、`worldToGrid`（夹取）、`gridCornerToWorld`；类型 `WorldRect{center,size}` |
| `bytes.ts` | 104 | DiceTale `.bytes` 网格二进制的读写（与 Unity 位精确兼容） | `BYTES_HEADER_SIZE`(8)、`BYTES_CELL_SIZE`(4)、`gridBytesLength`、`createGridData`、`encodeGridBytes`、`decodeGridBytes`、`encodeGridBytesToBase64`、`decodeGridBytesFromBase64`；类型 `GridData{size,cells}` |
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

### 3.2 `@dts/document` — 文档模型、命令与历史（4,785 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `types.ts` | 531 | 全部文档类型与格式版本常量 | `DOCUMENT_FORMAT_VERSION`(=19)、`ProjectDoc`、`SceneDoc`、`SceneFileDoc`、`SceneObjectDoc`、`ComponentDoc`、`MapDataDoc`、`MapFogDoc`、`SoundDataDoc`、`TeleportDataDoc`、`VideoDataDoc`、`ActionInstanceDoc`、`ConditionDoc`、`ImageRef`、`GridSpec`、`CellRuns`、`ItemLibraryDoc`、`AudioMetaDoc`、`AudioTagTableDoc`、`SOUND_LAYERS`、`OBJECT_SOUND_LAYERS`、`SOUND_LAYER_LABELS` |
| `features.ts` | 165 | **「哪个 kind 带哪个特性」的唯一归属地** + 组件类型名映射 + 特性缺省值 | `ObjectFeatureField`、`FEATURE_COMPONENT`、`OBJECT_FEATURES`、`featureOfField`、`featureOfComponent`、`kindsCarrying`、`carriesKind`、`supportsVideo`、`displayImageField`、`DEFAULT_SOUND_LAYER`、`DEFAULT_VIDEO_*` |
| `access.ts` | 250 | **对象特性的唯一访问路径**（数据存在哪只有这里知道） | 读：`componentOf`、`componentDataOf`、`hasFeature`、`mapDataOf`、`imageOf`、`objectImage`、`soundDataOf`、`teleportDataOf`、`videoDataOf`、`isVideoEnabled`；写：`mapDraftOf`、`writeFeature`、`removeFeature`、`ensureSoundData`、`ensureTeleportData`、`ensureVideoData`、`withFeature`、`withoutFeature` |
| `schema.ts` | 832 | zod schema + **版本迁移链** + 文件解析 | `sceneFileSchema`、`projectDocSchema`、`upgradeRawDocument`、`migrateProjectDoc`、`parseProjectFile`、`parseProjectDoc`、`parseSceneFile`、`defaultProjectSettings`、`defaultAudioSettings`、`defaultBgmSettings`、`DEFAULT_BGM_VOLUME`(0.6)、`DEFAULT_SFX_VOLUME`(0.8)、`DEFAULT_VOICE_VOLUME`(1)；类型 `SceneSizeHint`、`ProjectFileLoad`、`SceneFileLoad` |
| `commands/` | 2,019 | **67 个文档变换命令**，按特性拆成 9 个模块（纯搬运，行为不变） | 见 §3.2.2 |
| `validation.ts` | 619 | 文档语义校验（跨字段、跨场景） | `IssueLevel`、`ValidationIssue`、`hasErrors`、`formatIssues`、`validateScene`、`validateProject` |
| `history.ts` | 229 | 补丁式撤销 / 重做容器 | `DocumentHistory`、`HistoryEntry`、`DEFAULT_HISTORY_LIMIT`(=200)、`DEFAULT_COALESCE_WINDOW_MS`(=700)、`ProjectDraft`、`SceneListDraft` |
| `factory.ts` | 171 | 新建对象的工厂函数（默认值） | `createEmptyProject`、`createEmptyScene`、`createEmptySceneFile`、`createMapObject`、`createSoundObject`、`createTeleportObject` |
| `components.ts` | 250 | 组件注册表（**12 种**：7 种前端组件 + 5 种从对象特性提升上来的） | `ComponentType`、`ComponentTypeDef`、`COMPONENT_TYPES`、`FEATURE_COMPONENT_TYPES`、`findComponentType`、`findComponentTypeByLegacyField`、`componentId`、`featureComponent`、`defaultComponentData`、`isKnownComponentType`、`conditionValueTypesFor` |
| `scale.ts` | 118 | 对象缩放语义（等比 + v11 单轴覆盖） | `DEFAULT_OBJECT_SCALE`(1)、`MIN_OBJECT_SCALE`(0.01)、`MAX_OBJECT_SCALE`(100)、`clampObjectScale`、`effectiveScaleX`、`effectiveScaleY`、`isUniformScale`、`collapseScale` |
| `fields.ts` | 90 | 组件字段定义与默认值推导 | `FieldDef`、`FieldKind`、`FieldOption`、`defaultValueFor`、`defaultDataFromFields` |
| `index.ts` | 9 | barrel | — |

#### 3.2.1 数据模型

```
project.json（ProjectDoc）
├─ formatVersion: 18
├─ name
├─ items: ItemLibraryDoc            ← 道具库（source/updatedAt/count/items[]）
├─ settings: ProjectSettingsDoc     ← v15 起；audio: { bgm, sfx, voice } 各只有 volume
├─ audioMeta?: { [资源逻辑ID]: { name?, tags?: number[] } }   ← v17 起，可选，纯编辑器数据
└─ audioTags?: (string|null)[]      ← v18 起，可选；下标 = tag ID，null = 已删的洞

Assets/scenes/<场景名>.json（SceneFileDoc）   ← 场景名不进文件内容，它就是文件名
├─ formatVersion: 19
└─ objects: SceneObjectDoc[]
   ├─ id / name / kind / active / locked / sortingOrder / rotation / scale / scaleX? / scaleY?
   ├─ position: { x, y } | null      ← 世界坐标，原点 = 场景中心，y 向上
   └─ components: ComponentDoc[]     ← { id, type, displayName?, data, actions[] }
      ├─ GridMap          ← 贴图 + 网格 + 战争雾（原 map）    : image + grid + rowOrder + cells(RLE) + fog?
      ├─ TextureRenderer  ← 对象自己显示的图（原 image）
      ├─ PlaySound        ← 音频列表 + 选中 + 层级（原 sound）
      ├─ Teleport         ← 候选场景 + 选中（原 teleport）
      ├─ VideoOverlay     ← 视频列表 + 开关（原 video）
      └─ 前端组件体系那 7 种（OptionValue / Backpack / …）——动作挂在它们上面
```

**v19 起对象特性住在 `components[]` 里**（v18 及更早是 `map` / `image` / `sound` / `teleport` / `video`
五个扁平字段，由 `migrateFeaturesToComponents` 搬一次）。读它们一律走 `access.ts` 的访问器。

`ObjectKind = "Map" | "SceneObject" | "Player" | "Item" | "Event" | "PlaySound" | "Teleport"`
（前四种对齐 Unity 的 `BackendObjectKind`，后三种是编辑器侧新增的）。

**单位口径**：`position` 与世界坐标（像素）一致；`rotation` **在文档里存弧度**（面板按度编辑，
写盘前归一到 `(-180°, 180°]`，见 `normalizeDegrees`）；`scale` 与 `scaleX`/`scaleY` 是倍数（0.01 ~ 100）。

**组件注册表（`components.ts`，7 种，全部 `gmEditable: true`）**：

| type | 中文名 | 条件值类型 | 关联命令 | 字段 |
|---|---|---|---|---|
| `OptionValue` | 选项值 | String / Integer | `set_option` | `options`(字符串列表, 必填)、`current`(string) |
| `Backpack` | 背包 | — | `set_object_items` | `items`(字符串列表) |
| `ItemExchange` | 道具货源 | — | — | `itemName`(必填)、`quantity`(integer, min 0) |
| `MaskImage` | 遮罩图 | — | `set_mask_image`、`erase_mask` | `image`(资源引用)、`base64`(text) |
| `FloatValue` | — | Number | `set_float` | `value`(number, step 0.1) |
| `IntValue` | — | Integer | `set_int` | `value`(integer) |
| `BoolValue` | — | Bool | `set_bool` | `value`(boolean) |

组件的 `actions[]` 是**执行顺序即数组顺序**（`moveAction` 用 `delta` 调序）；`ActionInstanceDoc.condition`
缺省表示恒满足。

**可选字段的取舍**（贯穿全库的一条规矩）：
`map.fog`(v10)、`scaleX/scaleY`(v11)、`video`(v14)、`audioMeta`(v17)、`audioTags`(v18) 一律**不补空壳**——
「字段不存在」本身就是有意义的事实；而 `active`/`sortingOrder`(v7)、`scale`(v8)、`locked`(v9)、
`settings`(v15) 是**补默认值**的（老文件读出来就有可用值）。

#### 3.2.2 文档命令（`commands/`，67 个）

`commands/` 是个目录（原来是一个 2,069 行的 `commands.ts`），**按特性分模块**——
加一个特性的命令 = 加一个文件，而不是往一个巨型文件里插一段：

| 文件 | 行数 | 内容 |
|---|---|---|
| `index.ts` | 24 | barrel（`export *` 9 个模块）+ 模块级说明 |
| `shared.ts` | 74 | 命令共用的常量与查找工具：`DEFAULT_SORTING_ORDER` / `MAP_DEFAULT_SORTING_ORDER` / 角度区间 / `createId` / `findObject` / `findComponent` / `findMapObject` / `listMapObjects` / `collectActionIds` |
| `object.ts` | 345 | 对象增删改 + 变换 + 排序 + 缩放 + `setObjectImage`（`SORTING_ORDER_LIMIT` 是这里的**私有**常量） |
| `component.ts` | 201 | 组件与动作的增删改（通用，不认具体类型） |
| `scene.ts` | 52 | 场景名校验 / 查找 / 重名判定（纯函数） |
| `grid-map.ts` | 356 | 地图数据 + 战争雾 + 网格与标注 |
| `play-sound.ts` | 195 | 声音对象（音频列表 / 选中 / 层级 / 名字） |
| `teleport.ts` | 116 | 传送阵（候选场景 / 选中） |
| `video.ts` | 287 | 视频（开关 / 列表 / 选中 / 循环 / 声音） |
| `project.ts` | 370 | 三档音量 + 音频标注 + 标签表 |

**依赖方向严格单向**：`shared` → `../features`/`../types`（不 import 任何命令模块）；
`object`/`component`/`scene` → `./shared`；`grid-map`/`play-sound`/`teleport`/`video` → `./shared` + `../access` + `../features`；
`project` → `../schema`/`../types`。**没有任何模块 import barrel**（barrel 只做 re-export），所以不存在环。

命令分组一览（名字与语义都没变）：

| 分组 | 函数 |
|---|---|
| 查找 | `findObject`、`findComponent`、`findMapObject`、`listMapObjects`、`findScene`、`collectActionIds` |
| 对象增删改 | `createSceneObject`、`addObject`、`removeObject`、`renameObject`、`nextObjectName`、`setObjectPosition`、`setObjectKind`、`setObjectActive`、`setObjectLocked`、`setObjectSortingOrder`、`setObjectRotation`、`setObjectImage`、`objectImage` |
| 缩放 | `setObjectScale`、`setObjectScaleAxes`、`normalizeDegrees`、`objectsInDrawOrder` |
| 组件 / 动作 | `addComponent`、`removeComponent`、`updateComponentData`、`setComponentDisplayName`、`addAction`、`removeAction`、`updateAction`、`moveAction` |
| 地图网格 | `setMapCells`、`clearMapCells`、`paintMapCells`、`setMapGrid`、`setMapData` |
| 战争雾 | `isMapFogEnabled`、`mapFogMask`、`setMapFogEnabled`、`setMapFogRegions`、`clearMapFog` |
| 声音对象 | `setSoundClips`、`setSoundPicked`、`setSoundLayer`、`setSoundClipName` |
| 传送阵 | `setTeleportTargets`、`setTeleportPicked` |
| 视频 | `supportsVideo`、`isVideoEnabled`、`setVideoEnabled`、`setVideoClips`、`setVideoPicked`、`setVideoClipName`、`setVideoLoop`、`setVideoAudio` |
| 全局设置 | `setBgmVolume`、`setSfxVolume`、`setVoiceVolume` |
| 音频标注 | `setAudioMetaName`、`setAudioMetaTags`、`addAudioTag`、`renameAudioTag`、`setAudioTagName`、`deleteAudioTag` |
| 场景 | `isSceneNameTaken`、`validateSceneName`、`createId` |
| 常量 | `DEFAULT_SORTING_ORDER`(0)、`MAP_DEFAULT_SORTING_ORDER`(-10)、`DEFAULT_SOUND_LAYER`("sfx")、`DEFAULT_VIDEO_ENABLED`(true)、`DEFAULT_VIDEO_LOOP`(false)、`DEFAULT_VIDEO_AUDIO`(false) |

所有命令签名形如 `(draft, ...args) => boolean`：返回 `false` 表示**没有产生变更**（`DocumentHistory.apply` 据此不入栈）。

#### 3.2.3 历史（`history.ts`）

- 基于 immer `produceWithPatches` 记录正向 / 逆向补丁，命令本身**不写反向逻辑**；
- `apply(label, recipe, { coalesceKey })`：同一 `coalesceKey` 且在 700ms 窗口内、且重做栈为空 → 合并成一条
  （合并时正补丁追加、逆补丁**前插**，撤销按相反顺序回放）；`endCoalescing()` 在松手/落笔时断开合并；
- 栈上限 200（超出丢最老）；`apply` 产生变更时会清空重做栈；`clearRedo()` 供「两套历史共用一个撤销入口」的场景用；
- `reset(next)` 整体替换文档并清空历史（打开/新建项目）；
- `snapshot()` 返回当前值 + 栈的深拷贝（测试与调试用）；
- 场景是独立文件、不进工程文件，所以**场景/对象编辑的历史挂在「场景列表」上**（`SceneListDraft`），项目级数据（道具库、设置、音频标注）挂在 `ProjectDraft` 上，两条轨道。

#### 3.2.4 迁移与解析（`schema.ts`）

- `upgradeRawDocument(raw)`：把任意旧版原始 JSON 抬到当前版本（v1/v2 的内联场景拆成独立文件、
  v5 位置换算成世界坐标、v6 删掉网格里的 `cellSize`、v7 补 `active`/`sortingOrder`、v8 补 `scale`、
  v9 补 `locked`、v13 给 `map.fog` 补 `enabled`、v15 补 `settings`、v18 把字符串标签
  `migrateAudioTags` 建成 `audioTags` 表并换成整数 ID）；
- `parseProjectFile(raw)` → `ProjectFileLoad`（含 `upgraded: boolean` 之类的加载信息）；
- `parseSceneFile(raw, size?)` → `SceneFileLoad`；`SceneSizeHint` 用于给缺 `grid` 的老地图补尺寸；
- `migrateProjectDoc` 做「已解析文档」的补齐（与原始 JSON 的 upgrade 分开）；
- 迁移**只做一次**：打开项目时升级并回写，之后文件自描述。

#### 3.2.5 校验（`validation.ts`）

校验分三层，职责不重叠：

| 层 | 位置 | 性质 |
|---|---|---|
| 解析期 | `schema.ts` 的 zod | **硬拒**（结构不合法直接抛错，文件打不开） |
| 结构/语义 | `document/src/validation.ts` | `ValidationIssue[]`，不依赖动作注册表 |
| 动作图 | `actions/src/validation.ts` | 依赖动作注册表，因此单独成包 |

`ValidationIssue = { level: "error" | "warning"; path: string; message: string }`（`path` 形如
`scenes/Map001/objects/door_01`）；`hasErrors(issues)` 判断能不能进运行态；`formatIssues(issues)`
输出 `✗ path: message` / `! path: message` 多行文本（进运行态被阻止时展示给用户）。

`validateScene` 覆盖：场景名非空、对象 id 唯一、位置必须是有限数（**刻意不设坐标上下限**——
越界对象在画布上看得见比静默拒绝更有用）、`scale`/`scaleX`/`scaleY` 必须有限且 > 0、
`Map` 缺 `map`（error）/RLE 解码失败（error）/`map.image.id` 空白（warning）/雾区位非法或
「开着没雾区」「关着有雾区」（warning）、`PlaySound` 缺 `sound`（error）/`layer:"bgm"`（warning）/
`picked` 越界（warning）、`Teleport` 缺 `teleport`（error）/候选空 / 没选 / 选中的不在候选里 /
自己传自己（均 warning）、`video` 只允许 Map 与 SceneObject 携带、动作对象挂 `image`（warning）、
组件 id 唯一、未知组件类型（warning，数据原样保留）、`OptionValue.current` 不在 `options` 里（error）、
字段类型与 `FieldDef.kind` 不符（error）、条件 `target` 类型与 `valueType` 不符（error）、
全场景动作 id 唯一（error）。

`validateProject` 覆盖：`items.count` 与 `items.items.length` 不符、三档音量越界、
标签重名、`audioMeta` 里空显示名 / 空标签数组 / tagId 越界或指向已删的洞。
**全是 warning**——不拦工程文件打开。场景不在 `validateProject` 里（各自成文件，由 `validateScene` 逐个校验）。

### 3.3 `@dts/actions` — 动作注册表与条件求值（425 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `registry.ts` | 126 | 动作类型注册表（对齐前端 `BackendChangeAction` 体系） | `ActionTypeDef`、`ACTION_TYPES`、`findActionType`、`isKnownActionType`、`isActionImplemented` |
| `condition.ts` | 171 | 条件求值与文案 | `ConditionValue`、`conditionAlwaysMet`、`compareCondition`、`actualValueFor`、`evaluateCondition`、`describeCondition` |
| `validation.ts` | 125 | 动作图校验（跨场景引用、缺失参数） | `validateActionGraph` |
| `index.ts` | 3 | barrel | — |

**5 种动作类型**（`type` / `conditional` / `implemented`）：

| type | 中文名 | 条件 | 已实现 | 主要参数 |
|---|---|---|---|---|
| `ShowHide` | 显示/隐藏 | ✓ | ✓ | `targetObjectId`（对象引用） |
| `Teleport` | 传送（范围内玩家） | ✓ | ✓ | `range`、`teleportAllPlayers`、`targetMapName`(必填)、`targetMarkerId`(必填) |
| `TeleportZone` | 传送区域 | ✓ | ✓ | `targetMapName`、`targetMarkerId` |
| `PlayVideo` | 播放视频 | ✓ | ✓ | `targetObjectId`(必填)、`index`、`isLooping`、`speed` |
| `PlayAudio` | 播放音频 | ✓ | **✗（前端空壳）** | `targetObjectId`、`clip`、`loop`、`volume`(0..1) |

条件语义（与前端 `ComponentCondition.Compare` 逐条对齐）：缺省 = 恒满足；
`Bool` / `String` 只支持 `Equal` / `NotEqual`，`Number` / `Integer` 支持四种运算；
字符串比较**忽略大小写**（`toLowerCase()`，非区域化折叠）；`actual` 与 `condition.target` 类型不符一律 false；
`Integer` 还要求 `Number.isInteger(actual)`。`actualValueFor` 的映射：
`BoolValue→Bool`、`IntValue→Integer`、`FloatValue→Number`、
`OptionValue→String`（当前选项名）/ `Integer`（当前选项下标 `options.indexOf(current)`），其余返回 `undefined`。

`validateActionGraph` 检查：同组件内动作 id 唯一、未知动作类型（error）、`implemented === false`（warning）、
必填参数为空（error）、条件形态必须是组件支持的类型（否则 error）、
`Teleport`/`TeleportZone` 的 `targetMapName` 必须是已有场景（error）、
`ShowHide`/`PlayVideo` 的 `targetObjectId` 必须在本场景内（error）；`targetMarkerId` 只透传，编辑态不校验。

### 3.4 `@dts/protocol` — WS 消息契约（约 700 行）

单文件 `src/messages.ts`（634 行）+ `index.ts` barrel（1 行）。
**编辑器、服务端、Unity 前端共用同一份 zod schema。**

> **刻意不依赖 `@dts/document`**：`protocol` 是被三端共用的最底层包，不能反过来依赖文档包，
> 所以这里**复刻一份只读 schema**（文档加字段时两处同步补）。见 §6.3 的差异清单。

常量：

| 名称 | 值 | 用途 |
|---|---|---|
| `PROTOCOL_VERSION` | `8` | 握手校验；不一致则关闭连接 |
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

`CommandRequest`（`commandRequestSchema`，14 个变体）——**核心设计：命令只是触发器，载荷里不带数据**：

| kind | 字段 | 数据从哪来 |
|---|---|---|
| `play_sound` | `objectId`, `layer` | 前端从镜像对象的 `sound.picked` 读 |
| `stop_sound` / `pause_sound` / `resume_sound` | `layer` | 按**声道层**管（同层只响一条） |
| `play_video` / `pause_video` / `resume_video` / `stop_video` | `objectId` | 对象的 `video.picked` / `loop` / `audio` |
| `play_bgm` | **`clip`** | 唯一带路径的命令（歌单不在任何对象上，就是项目 `Assets/audio/`） |
| `pause_bgm` / `resume_bgm` / `stop_bgm` | — | — |
| `erase_mask` | `objectId`, `stroke{points[],radius,softness}` | 只发**轨迹**，雾层在推下去的地图对象里 |
| `reveal_fog_region` | `objectId`, `region`, `revealed` | 区域位取自 `map.fog.regions` |

载荷 schema（与 `@dts/document` **有意重复**，两处同步维护）：
`worldPositionSchema`、`imageRefSchema`、`gridSpecSchema`、`cellRunsSchema`、`mapFogSchema`、`mapDataSchema`、
`soundDataSchema`、`videoDataSchema`、`teleportDataSchema`、`projectSettingsSchema`、`sceneObjectSchema`、`sceneSchema`。
协议侧是**下发子集**：不含 `components` / `actions` / `items` / `audioMeta` / `audioTags` 等纯编辑器数据
（`sceneObjectSchema` 只保留前端渲染与播放需要的字段）。

公共摘要类型：`clientInfoSchema{name,version,connectedAt}`、`sceneInfoSchema{name,objectCount,updatedAt}`、
`resourcesInfoSchema{project,fingerprint,fileCount,bytes,ok,at,reason?}`、`projectSettingsInfoSchema{updatedAt}`。

解析助手：`parseClientToServer`、`parseServerToClient`、`parseEditorToServer`、`parseServerToEditor`
（失败信息形如 `"<通道> 消息校验失败: <path>: <message>"`）、`parseJsonMessage`、`createRequestId(prefix)`。

### 3.5 `@dts/resources` — 资源 ID 与 Provider 抽象（908 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `ids.ts` | 227 | **目录约定的唯一归属地** + 逻辑 ID 编解码 | `ResourceKind`、`RESOURCE_KINDS`、`PROJECT_FOLDERS`、`DEFAULT_PROJECT_FOLDERS`、`PROJECT_FILE_NAME`、`PROJECT_SPECIAL_FILES`、`PROJECT_SCENE_FILE_EXTENSION`、`formatResourceId`、`parseResourceId`、`projectPath`、`projectFileId`、`projectAssetId`、`projectFolderId`、`projectSceneBytesId`、`projectSceneImageId`、`projectSceneFileId`、`projectNameFromId`、`projectRelativePathFromId`、`projectNameFromFileId`、`configId`、`normalizePath` |
| `provider.ts` | 60 | 资源访问抽象（浏览器 / Node / 测试三实现共用） | `ResourceEntry`、`ResourceProvider`、`ResourceDirs`、`DEFAULT_RESOURCE_DIRS`、`assertCompleteDirs` |
| `project.ts` | 370 | 项目级业务操作（与宿主无关） | `ProjectSummary`、`ResourceTreeNode`、`validateProjectName`、`validateProjectRelativePath`、`listProjects`、`projectExists`、`readProjectEntries`、`buildResourceTree`、`createProject`、`deleteProject`、`readProjectFile`、`belongsToProject`、`CreateProjectOptions` |
| `memory.ts` | 183 | 内存实现（测试与联调） | `MemoryResourceProvider`、`createMemoryResourceProvider` |
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

`ResourceProvider` 接口（9 个方法）：`list(kind?)`、`exists`、`readText`、`readBinary`、`writeText`、
`writeBinary`、`ensureFolder`、`remove`、`rename`。`rename` 的契约：两端类别必须一致、源必须存在、
目标必须不存在（**绝不覆盖用户数据**）。

### 3.6 `@dts/renderer` — Canvas 2D 渲染与手柄几何（1,743 行）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `viewport.ts` | 154 | 视口（缩放 + 平移）与坐标变换 | `Viewport`、`Point`、`MIN_SCALE`(0.05)、`MAX_SCALE`(16)、`createViewport`、`createCenteredViewport`、`clampScale`、`worldToScreen`、`screenToWorld`、`panBy`、`zoomAt`、`fitViewport`、`visibleWorldRect` |
| `gizmo.ts` | 422 | 变换手柄（移动 / 旋转 / 缩放）的**世界几何 + 屏幕几何 + 命中判定** | `TransformTool`、`toolHasGizmo`、`GizmoHandle`、`SCALE_HANDLES`、尺寸常量（`GIZMO_HANDLE_SIZE` 9、`GIZMO_HANDLE_HIT_SIZE` 10、`GIZMO_AXIS_GAP` 45、`GIZMO_AXIS_LENGTH` 40、`GIZMO_RING_GAP` 22、`GIZMO_AXIS_HIT_WIDTH` 9、`GIZMO_RING_HIT_WIDTH` 10）、`isDrawableFrame`、`rectCorners`、`rotatePointAround`、`angleAround`、`scaleHandlePoints`、`scaleAnchorFor`、`isCornerScaleHandle`、`scaleAxisOf`、`gizmoScreenGeometry`、`hitTestGizmoHandles`、`moveTipOf`、`moveRootOf` |
| `scene-renderer.ts` | 1,164 | 场景绘制主循环 + 命中测试 + 音频徽标动画 | `SceneLayer`、`SceneRenderInput`、`SceneToolHandles`、`SceneRenderer`、`createCanvasSceneRenderer`、`kindMarkerColor`、`hitTestRect`、`AudioPulseRing`、`AudioBadgeAnimation`、`audioBadgeAnimation` |
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
`drawGridLines` 间距 < 4px 跳过、条数上限 4000。内置徽标（`icon: "audio" | "teleport"`）**不裁剪**
（正在播的声波要扩到矩形外）、全部用路径画（不占资产、不依赖字体）。
`audioBadgeAnimation` 是**纯函数**（周期 1200ms、两圈错开半周期），因此可以脱离画布单测。

---

## 4. 后端 `apps/backend`（3,123 行）

### 4.1 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/index.ts` | 81 | 进程入口：装配依赖、监听端口、打印局域网地址；`startServer(): Promise<RunningServer>` |
| `src/config.ts` | 92 | 资源根引导 + `app.json` 加载 + 地址解析 + 日志文案 |
| `src/net.ts` | 72 | 局域网 IPv4 地址筛选与排序（纯函数 `pickLanAddresses`） |
| `src/open-folder.ts` | 123 | 跨平台「打开目录 / 定位文件」命令构造与 spawn |
| `src/http/server.ts` | 59 | **只剩三件事**：装配上下文、按 `/api/` 前缀二分、把失败翻成响应 |
| `src/http/router.ts` | 64 | 路由表编译与分派（路径精确匹配 + 动词；404 `未知接口` / 405 `不支持的方法`） |
| `src/http/context.ts` | 56 | `HttpServerOptions` / `HttpContext`（config + provider + hub + log + openFolder + 资源包缓存） |
| `src/http/responses.ts` | 81 | `HttpError`（唯一的「提前返回状态码」手段）+ `sendJson`/`sendText`/`sendBytes`/`sendEmpty` |
| `src/http/requests.ts` | 58 | 请求体 / 查询参数读取助手（`readBody`/`readJsonBody`/`queryRaw`/`queryTrimmed`/`bodyString`/`bodyTrimmed`） |
| `src/http/mime.ts` | 35 | 扩展名 → Content-Type |
| `src/http/static.ts` | 86 | 编辑器产物托管 + SPA 回退 + 目录穿越防护 |
| `src/http/routes/*.ts` | 463 | **一条协议一个函数**：health(17) / config(20) / state(12) / projects(174, 6 个) / resources(180, 9 个) / index(60, 路由表) |
| `src/resources/fs-provider.ts` | 270 | `FsResourceProvider`（唯一碰磁盘的地方）+ 原子写 |
| `src/resources/bundle.ts` | 324 | 资源清单 / 指纹 / 自研 STORED zip writer |
| `src/resources/bundle-cache.ts` | 60 | 资源包缓存（每个项目留最近一份，指纹变了才重打）——从 `http/server.ts` 搬出来的跨请求状态 |
| `src/ws/hub.ts` | 465 | `RuntimeHub`：**只管传输**——升级分流、连接表、心跳、命令等待表、序列化发送 |
| `src/ws/hub-context.ts` | 61 | `HubContext`：处理器能用的全部能力（读运行态 / 发消息 / 记日志），`RuntimeHub implements` 它 |
| `src/ws/types.ts` | 5 | `LogLevel` / `HubLogger`（从 `hub.ts` 拆出，避免处理器与中枢循环引用） |
| `src/ws/handlers/*.ts` | 294 | **一条消息一个函数**：editor(137, 7 条) / client(95, 4 条) / types(58, 表类型与 `defineXxxHandlers`) / index(4) |
| `src/ws/runtime-session.ts` | 184 | `RuntimeSession`：运行态内存状态（开闸 / 前端 / 场景 / 设置 / 资源包） |
| `src/ws/runtime-session.ts` | 184 | `RuntimeSession`：运行态内存状态（开闸 / 前端 / 场景 / 设置 / 资源包） |
| `src/mock-client/index.ts` | 177 | 假 Unity 前端（联调与手测） |

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
| `/api/projects/folder` | POST | `{project, path}` | `201 {ok:true, id}` | `400`（路径非法）/`405` |
| `/api/projects/reveal` | POST | `{name, path?, selectFile?}` | `{ok:true, path}` | `400`/`404`/`405`/`500` |
| `/api/resources/index` | GET | `?kind=` | `{entries: ResourceEntry[]}` | — |
| `/api/resources/raw` | GET | `?id=` | 二进制（Content-Type 按扩展名，`no-store`） | `400`（缺 id）/`404` |
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
- **压缩方式刻意选 STORED（不压缩）**：后端不引 zip 依赖，自研 writer 用 STORED 才不必实现 deflate；
  且素材（png/mp4/mp3/wav）本身已压缩，deflate 省不下体积；代价是传输量 = 字节总和，由 `maxTotalBytes` 兜住；
- **自研 zip writer**（`writeZipStored`）：本地文件头 + 数据 + 中央目录 + EOCD，**不使用数据描述符**
  （CRC 与大小写头之前已知，无需流式回填）；通用位标记 `0x0800` 声明文件名 UTF-8（条目名含中文）；
  自带 CRC32 查表实现（不依赖 Node 版本是否带 `zlib.crc32`）；时间转 MS-DOS 格式（1980 年下限）；
- **响应头**：`x-dts-project`（URL 编码）、`x-dts-fingerprint`、`x-dts-file-count`、`x-dts-bytes`；
- **包内还写一份 `dts-bundle.json`**（项目名 + 指纹 + 字节数 + 文件列表），前端解压后可自行核对，不必再问服务端；
- **缓存**（在 `http/server.ts` 里）：`bundleCache: Map<项目名, {fingerprint, zip, headers}>`，**每个项目只留最近一份**；
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
公开方法：`attach`、`close`、`broadcastToEditors`、`newRequestId()`（生成 `cmd-…`）。

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

## 5. 编辑器 `apps/editor`（17,961 行 / 79 个文件）

### 5.1 分层总览

`src` 是「入口 → 外壳 → 面板/对话框 → store → services」的单向漏斗，依赖方向严格自上而下，没有回环：

| 层 | 目录 | 规则 |
|---|---|---|
| 入口 | `main.tsx`、`App.tsx` | `main.tsx` 是唯一 import 全局样式的地方；`App.tsx` 只有 5 行，只包一层 `EditorShell` |
| 外壳 | `app/` | `EditorShell.tsx` 是唯一的布局与总装点，也是**全局快捷键的唯一注册处**；把 12 个对话框按 store 开关挂在末尾 |
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

数据流：store 持有两份 `DocumentHistory`（场景轨 = `SceneDoc[]`、工程轨 = `ProjectDoc`）共用一个撤销入口；
运行态（`runtime` / `soundPlayback` / `videoPlayback` / `bgmPlayback` / `fogReveal`）与文档**物理隔离**，
只经 `runtime-client` 走 WebSocket 下行。

### 5.2 文件清单

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
现在是「组装点 + 类型 + 模块级工具 + 上下文 + 初始状态 + 15 个功能切片」。

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `editor-store.ts` | **85** | **只剩组装与再导出**：`create<EditorStoreState>()` 里展开初始状态与 15 个切片，然后把公开 API 原样再导出（仓库里 30+ 处从这里导入） | `useEditorStore`、`sceneHistory`、`projectHistory`、`fitSceneViewport`、`serializeSceneFile`、`serializeProjectFile`、`compareSceneNames`、`findResourceNode`、`withRenamedSceneImage`；类型 `EditorMode`、`EditorUiState`、`RuntimeUiState`、`ProjectUiState`、`ProjectDialogMode`、`SceneDialogMode`、`SceneSaveState`、`GridPaintState`、`EditorStoreState` |
| `store-types.ts` | 692 | 全部状态类型 + `EditorStoreState`（**126 个 action + 44 个状态字段**）+ `StoreSet` / `StoreGet` / `EditorStoreData`（由「全部 action 名」算出来的状态部分） | 上表那些类型 |
| `store-core.ts` | 350 | **模块级**工具与状态：两份 `DocumentHistory`、撤销轨（`lastEditTrack` / `activeTrack` / `historyOf`）、常量、`fitSceneViewport`、`serializeSceneFile` / `serializeProjectFile`、`withRenamedSceneImage`、`compareSceneNames`、`findResourceNode`、`makeLog` / `nextLogId` | 同 `editor-store` 的值导出 |
| `store-context.ts` | 1,174 | **闭包状态与局部工具**（原 `create()` 里 1157-2050 行那段）：`StoreContext` 49 个成员——37 个函数（`pushLog` / `switchScene` / `deliverSoundPlay` / `scheduleSceneSave` / `fogTargetOf` …）、7 个稳定引用（`runtimeClient` / 两个 `ScenePushScheduler` / `savedScenes` / `sceneViewports` / `quietCommandIds` / `storedGridPaint`）、5 个可变标量走 get/set（`lastPushedSceneText` / `pendingRunRequest` / `viewportAdjusted` / `bootstrapping` / `savedProjectText`） | `StoreContext`、`createStoreContext` |
| `initialState.ts` | 80 | 初始状态（返回类型是 `EditorStoreData`，所以**少一个状态字段就编译报错**） | `createInitialState` |
| `slices/history-slice.ts` | 116 | `applyScenes` `applyProject` `undo` `redo` `resetDoc` | — |
| `slices/save-slice.ts` | 143 | `saveSceneNow` `flushSceneSave` `saveProjectNow` `flushProjectSave` | — |
| `slices/project-slice.ts` | 291 | 项目 CRUD、资源树、建目录、打开目录、上传、删资源 | — |
| `slices/scene-slice.ts` | 306 | 场景增删改、切换、排序、载入 | — |
| `slices/object-slice.ts` | 467 | 对象增删改、选区、变换属性、贴图、网格规格 | — |
| `slices/transform-slice.ts` | 175 | 变换工具与手柄拖拽（`begin/apply/end/cancelObjectTransform`） | — |
| `slices/viewport-slice.ts` | 76 | 视口缩放 / 平移 / 适配 / 尺寸 | — |
| `slices/runtime-slice.ts` | 67 | `setMode` / `connectRuntime` / 推场景 / 清日志 | — |
| `slices/sound-slice.ts` | 332 | 声音对象：列表、选中、层级、名字、播放下发 | — |
| `slices/video-slice.ts` | 315 | 视频：开关、列表、选中、循环 / 声音、播放下发 | — |
| `slices/bgm-slice.ts` | 83 | 全局背景音乐（播放 / 暂停 / 继续 / 停止 / 补发） | — |
| `slices/audio-meta-slice.ts` | 112 | 音频显示名 / 标签表 + 三档音量 | — |
| `slices/teleport-slice.ts` | 105 | 传送阵：候选、选中、触发换台 | — |
| `slices/grid-paint-slice.ts` | 150 | 网格标注：画笔偏好、涂抹、清空 | — |
| `slices/fog-slice.ts` | 224 | 战争雾：开关、雾区、擦除记账、补发 | — |

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

依赖：`services/{runtime-client,runtime-push,bgm-playback,project-api,session,grid-paint-prefs,editor-prefs,scene-image,sound-playback,video-playback,fog-reveal,mask-math}`、
`panels/scene/{transform,display}`，以及 `@dts/{document,grid,resources,renderer,protocol}`。

#### `services/`（12）

| 文件 | 行数 | 职责 | 对外导出 | 后端交互 |
|---|---|---|---|---|
| `project-api.ts` | 167 | 项目 HTTP 客户端；统一把非 2xx 的 `{error}` 转成 `Error`，204 返回 `undefined`。 | `projectApi`、`contentTypeFor`；类型 `ProjectSummary`、`ResourceTreeNode` | 见 §5.4.1 |
| `runtime-client.ts` | 328 | 编辑器↔服务端的 WS 运行态连接：只负责协议与连接，不含编辑态数据；含重连退避、稳定连接判定、close-code 翻译。 | `RuntimeClient`、`defaultEditorSocketUrl`、`reconnectDelayMs`、`describeSocketClose`、`CLOSE_PROTOCOL_MISMATCH`(4002)；类型 `RuntimeStatus`、`RuntimeLogEntry`、`RuntimeStateSnapshot`、`RuntimeHandlers` | `WS /editor` |
| `runtime-push.ts` | 100 | 运行态推送的**纯判定 + 去抖**：只在 run 且 WS open 且内容变了才推。 | `RUNTIME_PUSH_DEBOUNCE_MS`(200)、`shouldPushScene`、`scenePayloadText`、`projectSettingsPayloadText`、`ScenePushScheduler`；类型 `ScenePushDecision` | —（纯逻辑） |
| `sound-playback.ts` | 97 | 声音的**期望播放记账**（按层级，同层顶替）：不写文档、不进撤销。 | `emptySoundPlayback`、`withPlaying`、`withSoundPaused`、`withStopped`、`soundPlaybackResendPlan`；类型 `SoundPlaybackEntry`、`SoundPlaybackState` | — |
| `video-playback.ts` | 92 | 视频的期望播放记账（按对象，每个对象一条）。 | `emptyVideoPlayback`、`withVideoPlaying`、`withVideoPaused`、`withVideoStopped`、`videoPlaybackResendPlan`；类型 `VideoPlaybackEntry`、`VideoPlaybackState` | — |
| `bgm-playback.ts` | 99 | 全局背景音乐记账（全局一条；v16 起不属于项目设置），状态只有 `{clip, paused}`。 | `emptyBgmPlayback`、`withBgmPlaying`、`withBgmPaused`、`withBgmStopped`、`bgmResendPlan`、`bgmResendActions`；类型 `BgmPlaybackState`、`BgmAction`、`BgmResend` | — |
| `fog-reveal.ts` | 204 | 战争雾的**揭示记账**：记有序操作（擦除笔画 / 整区开合）而不是位图；提供分批下发判定、批次切分、补发计划、按当前文档剪枝。 | `FOG_ERASE_BATCH_POINTS`(4)、`FOG_ERASE_BATCH_MS`(150)、`emptyFogReveal`、`entryOf`、`withEraseBatch`、`withRegion`、`shouldFlushBatch`、`splitStrokeBatch`、`fogRevealResendPlan`、`pruneFogReveal`；类型 `FogRevealPoint`、`FogRevealStroke`、`FogRevealOp`、`FogRevealEntry`、`FogRevealState` | — |
| `mask-math.ts` | 360 | 遮罩擦除的**像素运算**，逐字对齐 Unity 侧（`FogOfWar.cs` / `MaskImage.ApplyEraseStroke` / `MaskEraseStamp.shader`）。 | `MASK_PREVIEW_WIDTH`(960)、`MASK_BRUSH_RADIUS`(48)、`MASK_BRUSH_SOFTNESS`(1)、`MASK_BRUSH_RATIO`(0.05)、`previewMaskSizeFor`、`brushRadiusFor`、`applyEraseToPixels`、`strokeStampCenters`、`fillFogMaskPixels`、`paintRegionPixels`；类型 `MaskPoint`、`MaskPixelColor`、`MaskColorOf` | — |
| `grid-paint-prefs.ts` | 116 | 网格标注偏好持久化（画笔类型/大小、每类显示开关与颜色、两个总开关）；逐项规范化。 | `defaultGridPaintPrefs`、`readGridPaintPrefs`、`writeGridPaintPrefs`、`parseGridPaintPrefs`；类型 `GridPaintPrefs` | localStorage `dts.editor.gridPaint` |
| `editor-prefs.ts` | 86 | 界面偏好持久化：当前变换工具 + BGM 弹框是否显示路径；认不出的工具名退回 `"none"`。 | `defaultEditorPrefs`、`readEditorPrefs`、`writeEditorPrefs`、`parseEditorPrefs`、`isTransformTool`；类型 `EditorPrefs` | localStorage `dts.editor.ui` |
| `session.ts` | 39 | 只记「上次打开的项目名」，读写一律吞异常（隐私模式不能让编辑器打不开）。 | `readLastProject`、`writeLastProject`、`clearLastProject` | localStorage `dts.editor.lastProject` |
| `scene-image.ts` | 118 | 场景贴图加载器：按逻辑 ID 缓存 `HTMLImageElement`（绘制是 rAF 循环，不能在循环里发请求）；失败**不缓存**并给出原因；提供完成订阅与 `clearSceneImageCache()`（切项目释放）。 | `sceneImage`、`subscribeSceneImage`、`sceneImageError`、`clearSceneImageCache` | `GET /api/resources/raw?id=` |

#### `app/`（20）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `EditorShell.tsx` | 370 | 四区外壳（桌面三栏 / 紧凑抽屉）、启动引导 `bootstrapEditor`、**全局快捷键注册**、跨断点重置面板开合、按 store 开关渲染 12 个对话框；内部 `Drawer`。 | `EditorShell` |
| `MenuBar.tsx` | 385 | 顶部菜单（工程/场景/编辑/视图/运行）+ 顶栏右侧（紧凑开关、`BgmControl`、`ModeSwitch`、`ClientBadge`）。原则：**所有命令都必须能从菜单触发**。 | `MenuBar` |
| `StatusBar.tsx` | 98 | 底栏八个状态格：工程名、场景数、场景保存状态、工程保存状态、当前场景、已选数、当前工具、运行态与连接状态点；内部 `SAVE_STATE_LABELS`（含 `runtime: "运行中（不保存）"`）、`TOOL_LABELS`。 | `StatusBar` |
| `dialog-size.ts` | 96 | 弹窗尺寸计算（比例 0.8×0.86，夹 720×520 ~ 1680×1200，且不超过窗口 92%）与「按长宽比等比装进可用区域」；`useViewportSize` 订阅 resize。 | `dialogSizeFor`、`fitBox`、`useViewportSize`、`useDialogSize` |
| `ProjectDialog.tsx` | 177 | 新建/打开项目：列表带「N 个文件」与删除（`confirm`），创建成功即关闭，失败把 `project.error` 摆在框里。 | `ProjectDialog` |
| `SceneDialog.tsx` | 104 | 新建/重命名场景：场景名 = 文件名，失败原因就地显示。 | `SceneDialog` |
| `ObjectDialog.tsx` | 203 | 「新建对象」弹框：先选种类（实体/动作/事件）再选类型（正方形瓦片 + `kindMarkerColor` 色点），名字用 `nextObjectName` 预填去重。 | `ObjectDialog` |
| `ImagePickerDialog.tsx` | 151 | 「选择贴图」：列项目全部图片，缩略图 `onLoad` 读真实像素尺寸，双击 = 直接确定。 | `ImagePickerDialog` |
| `AudioPickerDialog.tsx` | 151 | 「选择音频」：`audioCatalog` 过滤 `missing`，带搜索框；点一条就 `addSoundClip`，已加入的禁用。 | `AudioPickerDialog` |
| `VideoPickerDialog.tsx` | 128 | 「选择视频」：列 `listVideoAssets`，已加入的标「已加入」；`.webm` 行给「Windows 多半解不了」提醒。 | `VideoPickerDialog` |
| `AudioTagDialog.tsx` | 153 | 「选择标签」：给一个音频文件勾/去标签（`allTagsOf` + `setAudioTags`），只勾选不新建。 | `AudioTagDialog` |
| `AudioTagEditorDialog.tsx` | 197 | 「标签」窗口：整数序号 `#0…#N` 预铺（`SLOTS_PER_PAGE` 16、`MAX_SLOTS` 32），只填名字，洞不画。 | `AudioTagEditorDialog` |
| `SoundEditDialog.tsx` | 264 | 「编辑声音」窗口：加/删音频、看路径、给每条起显示名（`sound.names`）；内嵌 `AudioPickerDialog`。 | `SoundEditDialog` |
| `VideoEditDialog.tsx` | 272 | 「编辑视频」窗口：加/删视频、看路径、起名字（`video.names`）；内嵌 `VideoPickerDialog`。 | `VideoEditDialog` |
| `TeleportEditDialog.tsx` | 116 | 「传送目标」窗口：把项目场景勾成候选（整份新清单交 `setTeleportTargets`）；已失效的目标照列并标「已失效」。 | `TeleportEditDialog` |
| `GlobalSettingsDialog.tsx` | 110 | 「全局设置」：三档音量滑杆（`doc.settings.audio.*`，0..1 step 0.05）。 | `GlobalSettingsDialog` |
| `BgmControl.tsx` | 79 | 顶栏「音乐」按钮：显示当前在放什么/暂停标记/播放中高亮；导出 `bgmDeliveryHint`（与声音/视频**同一套措辞**的「已记录，等连上补发」提示）。 | `BgmControl`、`bgmDeliveryHint` |
| `BgmDialog.tsx` | 355 | 「背景音乐」弹框：项目音频清单（按显示名排序）+ 只搜名字/路径 + 标签勾选（AND）+ 路径显示开关 + 行选中跟随播放态 + 打开时滚到当前曲 + 底部播放/暂停·继续/停止。 | `BgmDialog` |
| `FogMaskDialog.tsx` | 461 | 「战争雾 Mask 窗口」：贴图底 + canvas 遮罩（960 宽、按贴图比例定高），软边圆刷擦除，右侧「整区开关」；运行态下按批下发 `erase_mask` 轨迹、整区开关下发 `reveal_fog_region`；编辑态纯预览、不写文档不落盘。 | `FogMaskDialog` |
| `GridEditDialog.tsx` | 458 | 「网格编辑窗口」：**唯一**的格子涂/擦入口，用同一渲染器 + `fitViewport` 把地图铺满窗口；指针捕获 + 补齐两事件点之间的格子（不断线）；「全部清除」可撤销。 | `GridEditDialog` |

#### `panels/`（6）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `LeftPanel.tsx` | 69 | 左栏两个页签（场景对象 / 资源）共用一栏，默认停「场景对象」。 | `LeftPanel` |
| `EmptyState.tsx` | 39 | 空状态占位：没项目时指路菜单；没场景时**占位本身是入口**（点一下弹新建场景）。 | `EmptyState` |
| `object-kinds.ts` | 105 | 对象类型表（实体/动作/事件）+ 可创建标记 + 中文展示名 + 「画内置徽标」判定；`kind` 是前端也认的字段，不造新值（精灵复用 `SceneObject`）。 | `OBJECT_CATEGORIES`、`DEFAULT_CATEGORY`、`KIND_LABELS`、`creatableObjects`、`categoryOfKind`、`badgeIconOf`；类型 `ObjectTypeDef`、`ObjectCategoryDef` |
| `asset-info.ts` | 121 | 按扩展名判断资源怎么显示：图标种类、可预览种类、人类可读类型名、去扩展名的显示名、字节可读化；**扩展名判断只此一处**。 | `assetSuffix`、`assetIconKind`、`assetPreviewKind`、`assetKindLabel`、`assetDisplayName`、`formatSize`；类型 `AssetIconKind` |
| `asset-picker.ts` | 83 | 资源显示路径（剥掉 `project:`/项目名/`Assets/`）、按 id 查资源、按类别收图片/音频/视频、原始字节 URL。 | `assetDisplayPath`、`findAssetById`、`listImageAssets`、`listAudioAssets`、`listVideoAssets`、`assetRawUrl` |
| `audio-catalog.ts` | 273 | 音频清单 + 标注 + 标签表的**纯函数层**（BGM 弹框 / 选择音频 / 选择标签三处共用）：tag 是整数、名字住表里；名字兜底链、搜索、按标签 AND 筛、按名排序、标签用量与勾选项。 | `tagEntriesOf`、`tagNameOf`、`tagsOfClip`、`audioCatalog`、`audioNameOf`、`audioDisplayName`、`matchesAudioQuery`、`filterAudioRows`、`sortAudioRowsByName`、`allTagsOf`、`tagOptionsOf`；类型 `AudioTagRef`、`AudioTagEntry`、`AudioCatalogRow` |

#### `panels/assets/`（2）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `AssetIcon.tsx` | 121 | 资源面板图标：内联 SVG（不用 emoji，跨设备一致）、`currentColor` 描边、一律 `aria-hidden`；文件夹开/合两种画法。 | `AssetChevron`、`FolderIcon`、`AssetFileIcon` |
| `AssetsPanel.tsx` | 634 | 资源面板（对齐 Unity Project）：根 = `Assets`，左目录树 + 右列当前目录直属内容；只读、不导入素材；场景文件点一下 = 打开场景；「打开目录」按选中项调后端；展开集合用 ref 做真源 + 懒滚动/定位。 | `AssetsPanel` |

#### `panels/hierarchy/`（1）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `HierarchyPanel.tsx` | 354 | 场景对象列表：种类过滤 + 关键字过滤、复制/删除、保存按钮与保存错误条；行内改名（双击）、激活/锁定切换、行尾提示（地图网格尺寸 / 声音层级 / 传送目标）。 | `HierarchyPanel` |

#### `panels/inspector/`（9）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `InspectorPanel.tsx` | 341 | 右侧属性面板**只剩「显示哪一屏」**：按「资源 > 对象 > 场景 > 项目」的优先级选择视图，对象那一屏按注册表渲染分组 | `InspectorPanel` |
| `registry.tsx` | 150 | **对象分组的注册表**：7 组（基础 / 渲染 / 声音 / 传送 / 区域 / 战争雾 / 视频）各自的 `applies`（判据走特性表与访问器，不看 `kind` 字面量）与 `render`；**数组顺序就是界面顺序**（e2e 断言它） | `ObjectGroupDef`、`OBJECT_GROUPS` |
| `object-fields.tsx` | 795 | 对象字段的控件本体（从 `InspectorPanel.tsx` 拆出，纯搬运）：名称 / 激活 / 锁定 / 显示顺序 / 位置 / 缩放 / 单轴缩放 / 旋转 / 贴图 / 网格规格 / 每格像素 / 网格显示开关 + 它们的格式化与解析助手 | `NameField`、`ActiveField`、`LockedField`、`SortingOrderField`、`PositionFields`、`ScaleField`、`ScaleAxisField`、`RotationField`、`TextureField`、`GridFields`、`CellSizeField`、`GridDisplayField`、`WORLD_ORIGIN_FALLBACK` 等 |
| `fields.tsx` | 204 | 属性面板的行/分组外壳与**播放类控件**：可折叠 `FieldGroup`（`data-group` 英文 slug）、只读 `Field`、`FieldRow`（标签定宽 `w-20`，必须是行内第一个子元素）、`PlaybackRow`、`PlaybackStatus`、`PLAYBACK_BUTTON_CLASS` / `PLAYBACK_BUTTON_ACTIVE_CLASS`（高 34px、13px 字）。 | `FieldGroup`、`Field`、`FieldRow`、`PlaybackRow`、`PlaybackStatus`、`PLAYBACK_BUTTON_CLASS`、`PLAYBACK_BUTTON_ACTIVE_CLASS`；类型 `PlaybackState` |
| `SoundFields.tsx` | 315 | 声音对象的「声音」组：层级下拉（对象只给 `OBJECT_SOUND_LAYERS`，老文件的 `bgm` 照显并提示改）、音频小方块单选、`编辑音频…` 入口、播放三键 + 状态行（多一档 `busy` = 本层被别的对象占着）。 | `SoundFields`、`soundPlayBlockedReason`、`soundDeliveryHint` |
| `VideoFields.tsx` | 313 | 地图/精灵的「视频」组：启用闸门（关着只留开关）、循环/声音开关、视频小方块单选、`编辑视频…` 入口、播放三键 + 状态行。 | `VideoFields`、`videoPlayBlockedReason`、`videoDeliveryHint` |
| `TeleportFields.tsx` | 105 | 传送阵的「传送」组：候选目标小方块 + `＋` 开「传送目标」窗口 + 「传送」按钮（不能传时按钮上写原因）。 | `TeleportFields` |
| `FogFields.tsx` | 126 | 战争雾编辑区：第一行总开关（`map.fog.enabled`，文档数据）闸住整组；打开后给「指定雾区」小方块与「雾格子 → 编辑」入口。 | `FogFields` |
| `GridAnnotationFields.tsx` | 36 | 「区域」组里的一行入口：只留一个按钮打开 `GridEditDialog`。 | `GridAnnotationFields` |

> **加一个对象特性 = 在 `registry.tsx` 加一行 + 写一个字段组件**，不必回到面板 JSX 里插
> `kind === …` 判断。`InspectorPanel.tsx` 从 1,195 行降到 341 行就是这么来的。

#### `panels/runtime/`（1）与 `panels/scene/`（4）

| 文件 | 行数 | 职责 | 对外导出 |
|---|---|---|---|
| `RuntimePanel.tsx` | 336 | 运行态面板：连接状态、开闸状态、前端镜像（谁连上/镜像哪个场景/对象数/同步时间 + 重新同步）、设置推送状态、资源包状态（文件数/字节/指纹/失败原因），以及可复制的日志列表。 | `RuntimePanel` |
| `ScenePanel.tsx` | 1,300 | 场景画布：rAF 绘制循环（每帧 `getState()` 直读）、指针手势（拖拽平移、滚轮/双指缩放、点空白取消选中并带 `CLICK_SLOP` 4px 抖动阈值、中键只平移）、拾取（按显示顺序从后往前）、手柄几何（绘制与命中**共用** `gizmoGeometryOf`）、手柄/本体拖拽、双击传送徽标 = 传送；画布左上工具开关、场景切换条（1-9 序号 + `[`/`]`）、视口变换暴露为 `data-viewport-*` 供 E2E。 | `ScenePanel`、`checkerOriginOf`、`TOOL_OPTIONS` |
| `display.ts` | 112 | 对象在画布上占的世界矩形（显示/拾取/选中框/适配视图共用一份口径）：尺寸 = 贴图尺寸（无图用 `COLLIDER_SIZE` 64×64）× 该轴有效缩放；返回**未旋转**矩形，由消费方带 rotation。 | `COLLIDER_SIZE`、`displayRectOf`、`displaySizeOf`、`displayImageOf`、`sceneVisibleRects` |
| `grid-paint.ts` | 87 | 网格标注**绘制侧**纯工具：掩码 + 偏好 → 一串 CSS 颜色；RLE 按 `runs` 引用缓存的解码（坏数据返回空数组，绝不让绘制循环抛错）。 | `cellColorsOf`、`decodeCellsCached`、`countCellsWithMask` |
| `transform.ts` | 230 | 一次变换拖拽的纯计算：以「按下时的快照」为基准（不做逐帧累加）；Shift 吸附 15°。 | `resolveTransform`、`rotateIntoLocal`、`rotateOutOfLocal`、`angleAround`、`ROTATION_SNAP_DEGREES`(15)；类型 `TransformStart`、`TransformResult` |

### 5.3 `state/` 详解（切片拆分后）

> 拆分前的 `editor-store.ts` 是 4,493 行；现在组装点 85 行 + 15 个切片（见 §5.2 的表）。
> 下面的状态与 action 清单**名字与拆分前完全一致**（契约检查：126 个 action + 44 个状态字段，
> missing 0 / extra 0），只是各自住在哪个文件变了。

#### 5.3.1 状态切片

| 分组 | 字段 |
|---|---|
| 模式 / 文档 | `mode`（`"edit" ｜ "run"`）、`doc`（`ProjectDoc`，镜像 `projectHistory.current`）、`scenes`（`readonly SceneDoc[]`，镜像 `sceneHistory.current`）、`activeSceneName` |
| 历史 | `canUndo`、`canRedo`、`undoLabel`、`redoLabel` |
| 选区 | `selectedObjectIds: readonly string[]`、`selectedAssetId: string ｜ null`（两者互斥） |
| 视口 | `viewport: Viewport`、`viewportSize: {width,height}` |
| UI 偏好 | `ui: EditorUiState` = `{ leftOpen, rightOpen, runtimeOpen, tool, bgmPaths }`、`bootstrapped` |
| 运行态镜像 | `runtime: RuntimeUiState` = `{ status, statusDetail, runtimeActive, client, scene, resources, settings, logs, lastError }` |
| 项目 | `project: ProjectUiState` = `{ list, current, tree, busy, error }` |
| 对话框 / 窗口 | `projectDialog`、`sceneDialog`、`objectDialog`、`imagePicker`+`imagePickerTarget`、`soundEditor`+`soundEditorTarget`、`teleportEditor`+`teleportEditorTarget`、`videoEditor`+`videoEditorTarget`、`globalSettings`、`bgmDialog`、`audioTags`、`fogMask`+`fogMaskTarget`、`gridEditor`+`gridEditorTarget` |
| 落盘状态 | `sceneSaveState`+`sceneSaveError`、`projectSaveState`+`projectSaveError`（`SceneSaveState = "saved" ｜ "pending" ｜ "saving" ｜ "error" ｜ "runtime"`） |
| 网格偏好 | `gridPaint: GridPaintState` = `{ mask, brushSize, hiddenMask, colors, showGridLines, showAnnotations }` |
| 运行态记账 | `soundPlayback`、`videoPlayback`、`bgmPlayback`、`fogReveal`（**都不写文档、不进撤销栈**） |
| 拖拽快照 | `transformStart: TransformStart ｜ null` |

#### 5.3.2 action 按功能分组

**通用编辑 / 历史**：`applyScenes(label, recipe, {coalesceKey})`、`applyProject(label, recipe, {coalesceKey})`（两条历史轨的唯一写入口）、
`undo()` / `redo()`（作用在「最近改过的轨道」，跨轨时清对方 redo 栈）、`resetDoc(doc)`。

**场景**：`setActiveScene`、`openScene`、`openSceneByIndex`、`openAdjacentScene`（到端点返回 false，**不循环**）、
`loadScenes`（重扫 `Assets/scenes/`、`compareSceneNames` 排序、旧格式回写一次）、`openSceneDialog`、
`createScene`、`renameScene`（只改文件名 + 同步**同名贴图**引用 `map.image`，不动精灵）、`deleteScene`（至少保留一个）、
`saveSceneNow`、`flushSceneSave`；`switchScene(name, {clearAssetSelection?, log?})` 是切场景的**唯一路径**。

**工程文件**：`saveProjectNow`、`flushProjectSave`。

**项目**：`bootstrapEditor`（幂等 + `bootstrapping` 同步占位挡 StrictMode 双跑）、`openProjectDialog`、
`refreshProjects`、`createProject`、`openProject`（读 `project.json` → `clearSceneImageCache()` → `resetDoc` →
旧格式迁移（内联场景落文件 / 缺 `settings` 回写）→ `refreshTree` → `loadScenes` → `writeLastProject`）、
`closeProject`、`deleteProject`、`refreshTree`、`createFolder`、`openProjectFolder`、`uploadFiles`、`deleteResource`。

**对象**：`setSelection`、`selectAsset`、`createObject(kind, name, position?)`（Map 按同名约定取
`Assets/images/<场景名>.png` 并 `gridSizeFromImage`）、`renameObject`、`setObjectActive`/`toggleObjectActive`、
`setObjectLocked`/`toggleObjectLocked`、`setObjectSortingOrder`、`setObjectScale`、`setObjectScaleAxes`、
`setObjectRotation`（收弧度，面板按度）、`deleteObjects`（顺手关掉指向被删地图的窗口）、
`duplicateObjects`（「副本」后缀 + `COPY_OFFSET` 24 递增偏移）、`moveObject`（**全项目唯一移动入口**，锁定直接拒）、
`endObjectDrag`、`setObjectImage`、`setMapGrid`、`openObjectDialog`、`openImagePicker`。

**变换（手柄 / 本体拖拽）**：`setTool`、`setBgmPaths`、`beginObjectTransform`（`tool==="none"`、未落位、锁定都返回 `undefined`）、
`applyObjectTransform`（pos/rot/scale 一次写完，`coalesceKey: transform:<id>`）、`endObjectTransform`、
`cancelObjectTransform`（用快照写回 + 收尾）。

**视口**：`setViewport`、`zoomAtScreen`、`panByScreen`、`fitToViewport`、`setViewportSize`（未被用户调过视口时自动适配）、`setUi`。

**运行态 / 连接**：`connectRuntime`、`setMode`（run：展开运行面板 + 未连上则记 `pendingRunRequest` 并踢一次连接；
edit：取消去抖、`lastPushedSceneText=null`、发 `runtime_stop`）、`pushRuntimeScene`、`clearRuntimeLogs`。

**声音**：`playSound`、`stopSound`、`pauseSound`、`resumeSound`、`flushSoundPlayback`、`setSoundClips`、
`addSoundClip`（已在列表就不抢选中）、`removeSoundClip`、`selectSoundClip`、`setSoundClipName`、
`openSoundEditor`、`setSoundLayer`。

**视频**：`playVideo`、`pauseVideo`、`resumeVideo`、`stopVideo`（停止**不要求**仍选中）、`flushVideoPlayback`、
`openVideoEditor`、`setVideoEnabled`、`addVideoClip`、`removeVideoClip`、`selectVideoClip`、`setVideoClipName`、
`setVideoLoop`、`setVideoAudio`。

**背景音乐**：`playBgm`（再点同一首 = 让前端从头重播）、`pauseBgm`、`resumeBgm`、`stopBgm`、
`flushBgmPlayback`、`openBgmDialog`、`openGlobalSettings`。

**音频标注 / 标签（项目级数据）**：`setAudioName`（`coalesceKey: audio-name:<id>`）、`setAudioTags`（离散、不合并）、
`renameAudioTag`、`setAudioTagName`、`openAudioTags`。

**全局音量**：`setBgmVolume`、`setSfxVolume`、`setVoiceVolume`（各自 `coalesceKey`）。

**传送**：`setTeleportTargets`、`setTeleportPicked`、`openTeleportEditor`、`teleport(objectId)`
（四种拒绝理由写运行日志；成功则 `switchScene(target, …)` + 一条带来源的日志；**不改文档、不进撤销栈**）。

**网格标注**：`setGridBrush`、`setGridBrushSize`（夹 1..5）、`toggleGridTypeVisible`、`setGridTypeColor`、
`setGridLinesVisible`、`setGridAnnotationsVisible`（以上六项同步写本地偏好）、`paintGridStroke`（`coalesceKey: paint:<id>`）、
`endGridStroke`、`clearGrid`。

**战争雾**：`openFogMask` / `openGridEditor`（两者**互斥**）、`setFogRegions`、`setFogEnabled`、
`eraseFogMask`、`setFogRegionRevealed`、`flushFogReveal`（先 `pruneFogReveal` 按当前文档剪枝，再逐步重放）。

#### 5.3.3 文件级导出的辅助函数

| 导出 | 说明 |
|---|---|
| `sceneHistory` / `projectHistory` | 两份 `DocumentHistory`（limit 200） |
| `fitSceneViewport(scenes, activeSceneName, size)` | 只缩不放（`max: 1`）、四周 24px 边距；「复位 / 视图→适配视口 / 首次量到尺寸」三处**唯一**的视野算法 |
| `serializeSceneFile(scene)` | `collapseScale` 后两空格缩进 + 末尾换行；按对象引用 `WeakMap` 缓存；**场景名不进文件** |
| `serializeProjectFile(doc)` | 写 `formatVersion: DOCUMENT_FORMAT_VERSION`，同缩进/换行 |
| `compareSceneNames(a, b)` | `localeCompare(…, "zh-Hans-CN", { numeric: true })`（`第10幕` 排在 `第2幕` 之后） |
| `findResourceNode(nodes, match)` | 资源树递归查找 |

#### 5.3.4 持久化与自动落盘

- **localStorage 只有 3 个 key，全经 services**：`dts.editor.lastProject`、`dts.editor.ui`、`dts.editor.gridPaint`。
  **运行态与文档一律不落 localStorage。**
- **防抖自动落盘**：`SCENE_SAVE_DEBOUNCE_MS = 800`，场景与工程文件各一个计时器。
  两条历史的 `subscribe` 每次变更做四件事：① 同步 `scenes`/`doc`/撤销标记；② `scheduleRuntimePush()` /
  `scheduleSettingsPush()`（仅 run + WS open）；③ **运行态下把保存状态设为 `"runtime"` 并直接返回（不写盘）**；
  ④ 否则与 `savedScenes` / `savedProjectText` 比内容，脏才置 `pending` 并在 800ms 后写。
- **落盘状态机**：`saved → pending → saving → saved / error`；`saveSceneNow` 只写真正脏的场景；
  失败写 `sceneSaveError` 并进运行日志。
- **运行基线**：`runBaseline` 存 `{scenes, activeSceneName, doc}` **引用**（immer 不可变，存引用即可）；
  `rememberRunBaseline` / `snapshotRunBaseline` / `refreshRunBaseline`（文档整份换掉时跟随）/
  `restoreRunBaseline`（两条历史 `reset` + 清掉已不存在的选中 id + 一条日志）。
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
| `projectApi.createFolder(project, path)` | `POST /api/projects/folder` |
| `projectApi.reveal(name, target = "", selectFile = false)` | `POST /api/projects/reveal` |
| `projectApi.listResources()` | `GET /api/resources/index` |
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
    否则会出现「连上 → 立刻被踢 → 500ms 再连」的死循环。`clearStableTimer()` 在断开/手动关闭/重连时都要清。
  - `manualClose` 由 `disconnect()` 置真，阻断重连。
  - `connect()` 幂等（OPEN/CONNECTING 直接返回）；`new WebSocket` 抛错 → `onStatus("error")` + 排重连。
  - `describeSocketClose(code, reason)` 把断开翻成人话（4002 → 「服务端要重启」；1006 → 「多半是服务端没在跑」；
    1005 → 「服务端关闭了连接」），**store 会把它整句写进运行日志**。
  - `onOpen()` 在 WS 建立（含重连）后调一次，store 据此补发「用户点过运行但当时没连上」的 `runtime_start`。

#### 5.4.3 运行态推送（`runtime-push.ts`）

- `RUNTIME_PUSH_DEBOUNCE_MS = 200`；
- `shouldPushScene({mode, connected, lastPushed, next})`：**只在 `run && connected && lastPushed !== next` 时推**；
- `scenePayloadText(scene)` = `JSON.stringify({name, objects})`——用 stringify 而不是 `serializeSceneFile`：
  后者是文件格式、**不含场景名**，而运行态切场景也要算一次变更；
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
| `SoundFields` / `VideoFields` / `TeleportFields` / `FogFields` / `GridAnnotationFields` | `soundPlayback`/`videoPlayback` + 各自字段动作 | 属性面板内的分组内容（声音、视频、传送、战争雾、网格标注入口） |
| `RuntimePanel` | `mode`、`runtime`、`scenes`/`activeSceneName` → `pushRuntimeScene`、`clearRuntimeLogs` | 运行态四行状态 + 可复制日志 |
| `ScenePanel` | `activeSceneName`、`viewport`、`viewportSize`、`scenes`、`selectedObjectIds`、`gridPaint`、`soundPlayback`、`ui.tool`；动作见 §5.3.2 | 画布：绘制/拾取/多选/手柄变换/缩放平移/双击传送/工具开关/场景切换条 |
| `MenuBar` / `StatusBar` | 见 §5.2 各行 | 全部命令的菜单入口（平板无键盘）/ 底栏八个状态格 |
| `EmptyState` | `project.current`、`openSceneDialog` | 没项目 / 没场景的占位；没场景时占位可点 |

对话框绑定：`ProjectDialog` → `project`/`projectDialog`；`SceneDialog` → `activeSceneName`/`sceneDialog`；
`ObjectDialog` → `objectDialog`；`ImagePickerDialog` → `imagePickerTarget`；
`SoundEditDialog`+`AudioPickerDialog` → `soundEditor(Target)`；`VideoEditDialog`+`VideoPickerDialog` → `videoEditor(Target)`；
`TeleportEditDialog` → `teleportEditor(Target)`；`GlobalSettingsDialog` → `doc.settings.audio`；
`BgmControl`+`BgmDialog` → `bgmDialog`/`bgmPlayback`/`ui.bgmPaths`；
`AudioTagEditorDialog`+`AudioTagDialog` → `audioTags`/`doc.audioTags`；
`FogMaskDialog` → `fogMask(Target)`/`eraseFogMask`/`setFogRegionRevealed`；
`GridEditDialog` → `gridEditor(Target)`/`gridPaint` 系列。

### 5.6 UI 约定与跨文件不变量

**`data-testid` 约定**：全小写 kebab-case；`data-testid` 给「区域/容器」，`data-*` 给「状态与标识」。

- 作用域锚点：`menu-bar`（菜单栏与属性面板可能同名，测试必须按区域找）、`object-properties`、`asset-properties`、
  `project-properties`、`field-group`/`field-group-header`/`field-group-body` + `data-group`
  （英文 slug：`basic`/`render`/`sound`/`teleport`/`edit`/`fog`/`video`/`scene`/`asset`/`project`）、
  `runtime-*`、`scene-viewport`、`scene-bar`、`object-tree`、`folder-tree`/`folder-contents`/`folder-breadcrumb`；
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

**「运行态不落盘」规则（最硬的一条，六个落点）**：

1. `scheduleSceneSave` / `scheduleProjectSave`：运行态下把状态设成 `"runtime"` 并**直接 return**，不排计时器；
2. `saveSceneNow` / `saveProjectNow`：运行态下清计时器、置 `"runtime"`、写一条说明日志、返回 `false`；
3. 状态文案唯一来源 `StatusBar.SAVE_STATE_LABELS.runtime = "运行中（不保存）"`；菜单项同步禁用；
4. 场景的**文件级**操作（`createScene` / `renameScene` / `deleteScene`）运行态一律拒绝并给理由；
5. 运行期间的文档改动**不入历史**：`restoreRunBaseline()` 用两条历史 `reset` 整体还原；
6. `refreshRunBaseline()` 在文档整份被换掉（打开/关闭项目、`loadScenes`）时重拍基线。

**其它可验证的不变量**：

- **单一入口**：`switchScene` 是切场景的唯一路径；`moveObject` 是唯一移动入口（锁定护栏只放这一处）；
  `applyScenes` / `applyProject` 是两条历史轨的唯一写入口；
- **两份文件、一个撤销入口**：`lastEditTrack` + `activeTrack(action)` 决定撤销作用在哪条轨，跨轨时清对方 redo 栈；
- **中文只在三处集中**：`panels/object-kinds.KIND_LABELS`、`StatusBar` 的 `SAVE_STATE_LABELS`/`TOOL_LABELS`、
  `@dts/document` 的 `SOUND_LAYER_LABELS`；
- **扩展名判断只有一处**：`panels/asset-info.ts`；
- **标签 / 显示名兜底链只有一处**：`panels/audio-catalog.ts`（对象自己的名字 → 全局显示名 → 素材文件名）；
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
  `SLOTS_PER_PAGE` 16、`MAX_SLOTS` 32、历史 `limit` 200；
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

`DOCUMENT_FORMAT_VERSION = 19`，`PROTOCOL_VERSION = 9`。两者**独立编号**（文档 v19 ↔ 协议 v9 是同一批改动）。
规则：文档格式**任何结构不兼容的改动 +1**；协议**任何不兼容改动 +1**。

| 文档版本 | 内容 | 迁移方式 |
|---|---|---|
| v1 | 地图就是场景（`maps[]` 内联） | `upgradeV1Document` 拆成「场景容器 + `kind:"Map"` 对象」 |
| v2 | 场景是容器、地图降级为对象 | 拆分 `Assets/scenes/*.json` |
| v4 | 场景 = 独立文件（场景名 = 文件名） | — |
| v5 | 位置从归一化 `[0,1]`(y 向下) 换成世界坐标(x 右、y 上) | `migrateScenePositions`（**只认 v5 这条线**） |
| v6 | 网格里删掉恒为 1 的 `cellSize` | schema 顺手丢掉 |
| v7 | 每个对象补 `active` / `sortingOrder` | `withFilledObjectFields`（补默认值） |
| v8 | 补 `scale` | 同上 |
| v9 | 补 `locked` | 同上 |
| v10 | `map.fog`（**可选，不补空壳**） | 无需函数（可选字段 + 版本号触发回写） |
| v11 | `scaleX` / `scaleY`（**可选，绝不补默认值**） | 刻意不补——补成 1 会把等比对象悄悄变成非等比 |
| v12 | `teleport` 从 `{target}` 变成 `{targets, picked}` | `migrateTeleportTarget` |
| v13 | `map.fog.enabled` 总开关（`.default(true)`） | 无需函数（默认值 + 回写） |
| v14 | `video`（可选） | 无需函数（可选字段 + 回写） |
| v15 | `settings`（**给默认值**）；声音层级 `ambient` 并入 `bgm` | `settingsFilled` 触发回写；`migrateSoundLayers` |
| v16 | `settings.audio.bgm` 收敛成只有 `volume` | `migrateBgmSettings`（**显式删**`clips`/`picked`/`names`/`loop`） |
| v17 | `audioMeta`（可选，不补空壳） | 无需函数 |
| v18 | 标签从字符串改成**整数 ID + `audioTags` 表** | `migrateAudioTags`（按出现顺序建表） |
| **v19** | **对象特性搬进 `components[]`**：`map`/`image`/`sound`/`teleport`/`video` → `GridMap`/`TextureRenderer`/`PlaySound`/`Teleport`/`VideoOverlay` 组件实例 | `migrateFeaturesToComponents`（只搬键、不解释内容；幂等） |

**版本判断纪律**（`schema.ts` 里专门写了注释）：**不能拿文件里的 `formatVersion` 跟 `DOCUMENT_FORMAT_VERSION` 比**
来判断「要不要做位置换算」——版本号一涨，所有旧文件都会被判成「需要换算」，那会把已经是世界坐标的 v5 文件
再换算一次（`(0,0)` 变成 `(-960, …)`）。每一步迁移只认它自己那条版本线（如 `WORLD_POSITION_VERSION = 5`）。

### 6.2 加载一条项目 / 场景时到底发生了什么

**`parseProjectFile(raw)` → `{ doc, migratedScenes, needsRewrite }`**

```
upgradeRawDocument           # v1 → v2（把内联 maps 拆成 Map 对象）
 → migrateBgmSettings        # v16：删掉 bgm 上的 clips/picked/names/loop，只留 volume
 → migrateAudioTags          # v18：字符串标签 → 整数 ID + audioTags 表（按出现顺序）
 → projectDocSchema.safeParse# 失败抛「项目文档校验失败: …」
 → 拆出内联 scenes，逐个 parseSceneFile() 得到 migratedScenes
 → needsRewrite = 有内联场景 || settingsFilled || bgm.changed || tags.changed || version < 18
 → migrateProjectDoc         # formatVersion > 18 → 抛错（拒绝用旧编辑器打开新文件）
```

**`parseSceneFile(raw, size?)` → `{ file, needsRewrite }`**

```
upgradeRawDocument
 → version > 18 则抛错
 → version < 5  → migrateScenePositions（越界旧值原样保留，不夹到边界）
 → withFilledObjectFields（补 active/sortingOrder/scale/locked；Map 缺位置补 (0,0)）
 → migrateTeleportTarget（{target} → {targets,picked}）
 → migrateSoundLayers（ambient → bgm）
 → sceneFileSchema.safeParse
```

两条共同约定：**迁移只做一次**（返回 `needsRewrite`，由调用方回写磁盘，之后文件自描述）；
**能读回来但形状变了才写迁移函数**，纯粹新增可选字段只靠「版本号 +1 触发一次回写」。

### 6.3 `@dts/protocol` 与 `@dts/document`：刻意重复的精确差异

协议侧**复刻一份只读 schema** 而不 import `@dts/document`（理由：`protocol` 是被三端共用的最底层包，
不该反过来依赖文档包），并要求「字段口径与文档严格一致，文档加字段时这里同步补」。

**协议有、文档没有**：无。

**文档有、协议没有**：

| 文档字段 | 协议侧处理 |
|---|---|
| `SceneObjectDoc.components[].displayName` | 协议把 `components` 整个当 `z.array(z.unknown()).optional()` 透传，不做结构校验 |
| `formatVersion`（场景 / 工程） | 协议**不传**（`sceneSchema = { name, objects }`，无 `formatVersion`） |
| `ProjectDoc.name` / `items`（道具库） | 协议完全没有项目级道具库 |
| `ProjectDoc.audioMeta` / `audioTags` | 纯编辑器标注（v17/v18），**不进协议、不下发 Unity** |
| `sound.names` / `video.names` | 只是编辑器里给人看的标签，**刻意不进协议** |

**同名字段但默认值 / 约束不同**：

| 字段 | 文档 | 协议 |
|---|---|---|
| `active` / `sortingOrder` | 有 `.default` | 必填、无默认 |
| `locked` | `.default(false)` | `.optional()`，**不设默认** |
| `scaleX` / `scaleY` | `.optional()` | `.optional()`，**刻意不设默认**（老编辑器不发、老前端不认，属无害的额外信息，不必升版本号） |
| `map.fog.enabled` | `.default(true)` | `.default(true)` |
| `map.fog.regions` | `.int().min(1).max(255)` + `.default([])` | `.int()`，**无默认、无范围**（越界位留给前端与校验处理） |
| `rleRun` | `[int 0..255, int ≥0]` | `[int, int]`，无范围 |
| `sound.clips` | `z.array(z.string().min(1))` | `z.array(z.string())` |

**协议额外携带的运行态语义**：`map.fog` 的注释说明「**哪个格子被揭示了不在数据里**」——
那是运行态，由 `erase_mask` / `reveal_fog_region` 驱动，不写文档、也不随 `scene_sync` 走。
`eraseStrokeSchema` 则明确「逐字对齐 `apps/editor/src/services/mask-math.ts`」。

### 6.4 组件与动作注册表（跨包对照）

| 概念 | 位置 | 与前端的关系 |
|---|---|---|
| 对象类型 `ObjectKind`（7 种） | `@dts/document` | 前 4 种对齐 Unity `BackendObjectKind`；后 3 种（`Map`/`PlaySound`/`Teleport`）编辑器侧新增。**v19 起 `kind` 只是创建原型标签**，前端「建不建可见物」看组件（见下） |
| 组件类型（12 种，`components.ts`） | `@dts/document` | 5 种对象特性（`GridMap` / `TextureRenderer` / `PlaySound` / `Teleport` / `VideoOverlay`）**逐字对齐客户端 `Protocol.ComponentType`**，由 `apps/backend/test/protocol-document-contract.test.ts` 断言；另外 7 种是编辑器侧组件（前端忽略，数据留在镜像里） |
| 前端可见性判据 | `SceneObjectView.NeedsView(MirrorObject)`（客户端） | 有 `map`（GridMap）或 `image`（TextureRenderer）**组件** → 建视图；都没有时**只有带 `PlaySound` / `Teleport` 组件的不建**（动作对象），其余（玩家 / 道具 / 事件 / 还没挑图的精灵）仍要一块占位色面片。**判据只此一处** |
| 动作类型（5 种，`registry.ts`） | `@dts/actions` | `implemented: false` 的动作（当前是 `PlayAudio`，前端为空壳）在编辑器里可编辑但会报 warning、且导出后不产生效果 |

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
| `地图（map_…）` | `GridMap` | `SceneObjectView` + `TextureRenderer`（地图面片 + 网格） |
| `FogOverlay` | （由 `GridMap.fog` 生成） | `FogOfWar` + `TextureRenderer` |
| `精灵（obj_…）` | `TextureRenderer` | `SceneObjectView` + `TextureRenderer` |
| `sound_…` | `PlaySound` | **一个 GameObject 都不建**（数据留在镜像里） |
| `teleport_…` | `Teleport` | **一个 GameObject 都不建** |

**这次联调抓到一个真 bug（已修）**：`SceneMirror.ResourceIdOf` 里
`foreach (var clip in obj.sound != null ? obj.sound.clips : null)`——`obj.sound == null` 时那句三元
返回 `null`，`foreach (null)` 抛 `NullReferenceException`。它在 `ProjectOf`（推项目名的兜底路径）里
**对每个对象**调用，所以任何「既没有贴图也没有声音」的对象（传送阵、没挑图的精灵、以及**协议版本
不一致时收到的空对象**）都会把整份场景的载入打断。改成先取 `clips` 判空再遍历。
联调时的触发场景正是「协议 9 的客户端连上了协议 8 的旧服务端」——那条报错值得记住：
`4002 协议版本不一致`。

---

## 7. 测试体系（25,831 行）

### 7.1 三层测试与运行方式

| 层 | 位置 | 运行器 / 环境 | 数量 | 行数 |
|---|---|---|---|---|
| 架构边界 | `test/architecture.test.ts` | vitest `node` | 1 文件 / 3 describe / 6 用例 | 232 |
| 单元测试 | `packages/*/test`、`apps/backend/test`、`apps/editor/test` | vitest（`node` / `jsdom` 两个 project） | 66 个测试文件（另 2 个 helper + 1 个 setup） | 17,472 |
| 端到端 | `e2e/*.spec.ts` | Playwright（三条档位线） | 19 个 spec（6,987）+ 2 helper（1,125）+ 1 teardown | 8,127 |

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
| 1 | 纯逻辑包不 import React、Node 内置模块或 DOM | 扫 `grid`/`document`/`actions`/`protocol`/`resources` 的 `src`：禁止模块 `react`、`react-dom`、`react/jsx-runtime`、`node:fs`、`node:path`、`node:http`、`node:child_process`、`fs`、`path`、`http`、`child_process`（匹配 `specifier === bad \|\| specifier.startsWith(bad + "/")`，所以 `node:fs/promises` 也被挡住）；另做**裸子串**检查禁止 `window.`、`document.`、`localStorage`、`sessionStorage`、`navigator.`、`HTMLElement`、`requestAnimationFrame`（注释里出现也算） |
| 2 | `renderer` 可以用 DOM，但不得依赖 React | 扫 `renderer/src`：禁止 React 家族；**禁止任何 `node:` 前缀**模块（比规则 1 的显式清单更宽）。不做 DOM 全局扫描——这是它与规则 1 的唯一区别 |
| 3 | 只允许声明的依赖方向（且必须写进 `package.json`） | `ALLOWED = { grid: [], protocol: [], resources: [], document: ["grid"], actions: ["document","grid"], renderer: ["grid","document"] }`。**双向检查**：`package.json` 里 `@dts/*` 依赖必须在允许表内；`src` 里出现的 `@dts/*` import 也必须在允许表内。矩阵外的包（`apps/*`）不受约束，因此编辑器与后端可自由依赖 `@dts/*` |
| 4 | 除 `resources` 包外，源码不出现资源路径字面量 | 扫 `grid`/`document`/`actions`/`protocol`/`renderer`：先 `stripComments()` 去掉块注释与行注释（`(^\|[^:])//` 避免误伤 `http://`），再匹配 `/["'`][^"'`]*resources\//` 与 `/["'`]Map\d+\.(png\|bytes)["'`]/`。用 `test()`，所以每个文件每种模式最多记一条 |
| 5 | `resources` 包是唯一持有目录约定的地方 | 反向断言 `resources/src/provider.ts` 必须包含 `DEFAULT_RESOURCE_DIRS` |
| 6 | 磁盘访问只出现在后端 | 所有包的 `src` 里不得出现 `/from\s+["']node:fs/`（只抓 `import … from "node:fs…"` 这一种写法） |

这 6 条**不是软约定**：例如给 `@dts/document` 加一个 `node:path` import、把某个包改成依赖 `@dts/actions`、
或在 `@dts/grid` 里写 `"Map001.png"`，`pnpm test` 立刻失败。

### 7.3 单元测试清单

#### 7.3.1 `apps/backend/test`（14 文件 / 2,569 行）

| 文件 | 行数 | 覆盖的行为 |
|---|---|---|
| `runtime-hub.test.ts` | 905 | **最大的一份**。门控（没点运行 → 握手 503 / 点运行后能连 / 退出运行 4003 踢下线）；先推场景后开前端拿到全量；运行中改场景整份转发；命令转发 + 回执 + 日志；不认识的命令回带 `requestId` 的 `editor_error`（不静默丢弃）；战争雾轨迹转发；前端不在 / 未进运行态的明确报错；编辑器刷新/断开不影响运行态；协议版本不一致 4002；**顺序断言**（`resources_prepare` → `project_settings` → `scene_sync`）；换项目重发 `resources_prepare`；前端上报资源包结果并在关闸后清掉；一组 HTTP 接口用例（`/api/health`、`/api/config`、`/api/resources/index`、`/api/resources/raw`、`/api/state`、未构建时的根路径提示） |
| `project-api.test.ts` | 374 | 项目 CRUD（创建 `project.json` + 标准子目录、没有 `project.json` 的目录不算项目、项目文件可被编辑器直接打开、重名 400、非法名 400 且不落盘）；资源树与建目录（含目录穿越 400）；上传 → 出现 → 删除；删项目连资源一起清；**`/api/projects/reveal` 的 10 条用例**（路径由服务端拼、项目不存在 404、非法名 400、非 POST 405、系统打不开时如实报错、带 `path` 打开项目内那一层、`selectFile` 指向存在文件 / 指向目录 / 指向不存在文件、`path` 越界 400） |
| `runtime-session.test.ts` | 234 | 会话初始态；开闸幂等不清场景；快照是摘要（名字 + 对象数 + 时间）；关闸清空全部字段；推 `null`；`sessionId` 稳定可读；资源包状态；设置摘要只报时间；`projectNameOfScene`（含推不出项目名的情形、换项目跟着变） |
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
| `protocol-document-contract.test.ts` | 122 | **跨包契约**（v19 新增）：协议与文档的组件类型名逐字一致；每个特性组件两边都能解析；已知组件的坏 data 两边都拒（不能掉进「未知类型」的宽松分支）；7 种前端组件在协议侧仍是宽松分支。放在这里是因为只有后端同时依赖两个包，而架构测试只扫各包 `src` |

#### 7.3.2 `packages/*/test`（23 文件 / 7,196 行）

| 文件 | 行数 | 覆盖的行为 |
|---|---|---|
| `document/document.test.ts` | 1,704 | 文档工厂（场景是容器、对象挂在场景上）；组件注册表；对象命令（改名/位置/锁定/激活/显示顺序/缩放/贴图/网格/组件/动作…）；**战争雾手动指定雾区**；文档校验；工程文件 schema 与版本迁移；场景文件 schema |
| `protocol/protocol.test.ts` | 827 | 场景载荷（地图/精灵/声音/战争雾总开关/视频/传送阵/`position: null`/单轴缩放/额外字段不报错/网格尺寸约束）；四条通道的逐条成员；命令只带触发器（含战争雾只发轨迹、声音按层、BGM 带 clip、视频只带 objectId）；畸形结构被拒（缺 objectId、空轨迹、非有限数）；**拒绝旧模型消息**（`register_*`/`report_*`/`invoke_action`/`sync_state`）；三端 schema 都是判别式联合；JSON 解析与请求 id |
| `document/video.test.ts` | 447 | 哪些对象能带视频；列表命令（去空去重、清空不删字段、移出的视频收拾干净、重复写不算变更）；选中与名字；循环与声音开关；总开关；文档校验；格式版本 |
| `document/audio-meta.test.ts` | 426 | 显示名；标签表新建/改名；按序号命名（序号预先定好只填名字）；删除（留洞 + 摘引用）；文件上的标签 ID 列表；读写工程文件与 **v17 → v18 迁移**；校验 |
| `document/teleport.test.ts` | 395 | 传送阵工厂；`setTeleportTargets`（加/移候选）；`setTeleportPicked`；解析与版本（含 `{target}` 老形状迁移）；校验 |
| `document/sound.test.ts` | 379 | 声音对象工厂；声音命令（列表/选中/层级/名字）；场景文件 schema；校验 |
| `renderer/gizmo.test.ts` | 363 | 矩形四角；绕枢轴旋转；八个缩放手柄与**边中点 = 相邻两角平均**；锚点对侧且随旋转转；角=等比 / 边=单轴；屏幕几何（中心点=平移量、柄落在角与边中点、太小不可绘制、移动轴贴着对象长、旋转环包住整个对象、**间距与环半径用矩形自己的半尺寸所以转过角度不「呼吸」**、转 45° 后绘制与命中仍是同一份坐标）；`toolHasGizmo` 与命中的口径一致；命中测试（容差是一条带子、旋转环内外都不命中、移动轴只认自己的轴、**拖动模式一个手柄都点不到**、太小一律不给命中） |
| `document/bgm-settings.test.ts` | 299 | 全局设置缺省值；**v16 迁移**（歌单从工程文件里拿掉）；三档音量；校验；**场景格式 v15**（环境音并进背景音乐） |
| `document/scale.test.ts` | 294 | 有效缩放（读路径）；写法归一（写路径）；`setObjectScaleAxes`；**v10 → v11 迁移**；坏数据校验 |
| `resources/project.test.ts` | 249 | 项目名校验（接受中文/空格/点/连字符；拒绝空、首尾空白、路径分隔符、Windows 非法字符、`.`/`..`、保留名、超长）；项目内相对路径校验（**逐段拒绝 `.` 与 `..`**）；创建/打开/删除项目（人类可读 JSON、重名拒绝、只有含 `project.json` 的目录才算项目、删除连资源清掉）；资源树（顶层只有 `Assets`、目录排在文件前、空目录也显示、目录来自真实条目而非凭空补、项目文件是特殊文件、只隐藏项目根那一个）；归属校验 |
| `document/history.test.ts` | 226 | 补丁式撤销/重做；连续操作合并（含窗口与 `endCoalescing`）；上限与 `reset` |
| `actions/actions.test.ts` | 238 | 动作注册表（覆盖前端全部类型、字段名与前端序列化一致、`PlayAudio` 标记未实现、所有动作都带条件、摘要可读）；条件求值（缺省恒满足、Bool/String 只支持等于不等于、字符串忽略大小写、Number/Integer 四种比较、类型不符返回 false、`OptionValue` 双形态、组件不提供该形态时不满足、可读描述）；动作图校验（合法无问题、未知类型 error、未实现 warning、缺必填 error、目标场景不存在 error、目标对象不存在 error、条件形态不匹配 error） |
| `resources/resources.test.ts` | 221 | 逻辑 ID（只有两类、反斜杠规范化、缺前缀/路径抛错、旧类别已移除、拒绝越界、项目文件固定名、`Assets/` 约定集中在此、反推项目名与相对路径、`configId`）；内存实现（文本/二进制往返、按类别过滤、`ensureFolder` 幂等、读不存在抛错、非法 ID 不落盘、rename 文件/绝不覆盖/源不存在/类别不同/目录前缀替换）；应用配置（缺省默认值、自定义目录生效、非法配置抛带路径的错误） |
| `grid/brush.test.ts` | 205 | 画笔尺寸（与 Unity 整除语义一致，1/2→1×1、3/4→3×3）；覆盖格子；写入语义（按位或、橡皮清零、`eraseMask` 只清指定位）；`strokeCenters`（Bresenham 含两端）；`applyBrushStroke` 一整笔只拷贝一次 |
| `grid/world.test.ts` | 144 | 世界坐标 ↔ 网格（同向不翻转、角点与格心、最上行 y 最大、越界钳制）；`worldToGridPoint` 不夹取（网格外返回越界坐标而不是边缘格、边界归属）；地图挪了格子跟着走、同一世界点在不同地图上落不同格、世界可以很大；`unionWorldRects`（单张、两张错开、无地图返回 `undefined`） |
| `grid/mask-rle.test.ts` | 143 | 掩码位运算（数值与 Unity `GridCellType` 严格一致、可绘制类型 8 类顺序一致、`addMask` 不越界、`removeMask` 只清指定位、`hasMask`/`isEmptyMask`/`isBlocked`/`isFogMask`、`isValidMask` 拒绝越界与非整数、`maskToLabel`、区域显示名按可绘制顺序编号、`normalizeRegions`/`regionsToMask`）；RLE 往返（含跨行合并）、全空编码为单游程、空输入、格数不符抛错、游程非法抛错、64×36 真实尺寸往返 |
| `renderer/viewport.test.ts` | 127 | 世界↔屏幕（原点落在 `(tx,ty)`、y 翻转、往返一致）；平移与缩放（锚点下的世界坐标不动、夹上下限、到上限返回原视口不漂移）；`fitViewport`（单张居中、宽高比不同按较小比例、地图不在原点时居中挪的是地图外框、多张按并集、无地图退回原点居中、视口尺寸 0 不产生 NaN）；`visibleWorldRect`（top 是 y 最大值） |
| `grid/mask-style.test.ts` | 110 | 默认颜色与 Unity `GetDefaultColor` 严格一致（每类 `#rrggbb` + 固定透明度、覆盖全部可绘制类型、未知位退回不透明白、**RGB 可改但透明度不给改**）；`cellMaskCss`/`isHexColor`（大小写不敏感、脏数据退回白色）；`visibleMaskBits`（高位→低位、顺序恒为 `PaintableTypes` 倒序、隐藏位跳过、整格隐藏返回空） |
| `grid/bytes.test.ts` | 88 | `.bytes` 编解码**对照 Unity 真实产物 `test/fixtures/Map001.bytes`**；合成数据与错误处理 |
| `renderer/audio-badge.test.ts` | 81 | 声音徽标动画：不播时静止；正在播两圈错开半周期；同一圈越扩越淡；周期性重复（含负时刻）；喇叭呼吸（四分之一周期最胀、四分之三最缩）；对象类型色（动作对象各有颜色、两个传送阵/声音分得开） |
| `grid/coords.test.ts` | 51 | 坐标契约只有世界坐标一套（y 向上）；网格范围判定；图片与网格的比例（`cellPixelSize`/`gridSizeFromImage`） |
| `renderer/hit-test.test.ts` | 52 | 矩形碰撞：内部命中、边界含在内、中心不在原点的矩形按自己中心判、**旋转 90° 后长边转到竖直方向**（不是轴对齐包围盒） |
| `editor/test/setup.ts` | 31 | jsdom 缺的浏览器 API 补齐 + `@testing-library/jest-dom` |

> 上表按行数降序混排了各包；编辑器的 31 个测试文件见 §7.3.3。
> `setup.ts` 只补两件「jsdom 缺、浏览器有」的 API：`window.matchMedia`（store 在**模块求值期**就用它判断
> 紧凑布局，不补的话任何 import 了 store 的用例在收集阶段就炸；`matches` 恒为 `false` = 桌面布局）与
> `Element.prototype.scrollIntoView`（资源面板把左树滚到当前层时用；补空实现，**刻意不在组件里加特性判断**）。

#### 7.3.3 `apps/editor/test`（32 文件 / 7,707 行，jsdom）

| 文件 | 行数 | 覆盖的行为 |
|---|---|---|
| `sound-object.test.tsx` | 686 | 种类表里动作下的「播放声音」；创建声音对象；属性面板声音组；编辑声音窗口（store 侧加/删/起名字）；播放/停止能不能点；面板上看得见的状态；store 的记账与日志 |
| `video-object.test.tsx` | 566 | 属性面板视频组；播放/暂停/停止的可用性与状态显示；失败原因都在运行日志里写明；store 的加/删/改名 |
| `bgm-dialog.test.tsx` | 535 | 顶栏「音乐」按钮；「背景音乐」弹框（清单、搜索、标签勾选、路径开关、选中跟随播放、自动滚到当前曲、底部三键）；**与项目设置分离** |
| `run-mode.test.ts` | 497 | **运行中的改动不保存、退出即还原**；切场景 = 换台（运行态下立刻推）；运行基线跟着文档走；运行中的文件操作与断线 |
| `bgm-settings.test.ts` | 438 | 推设置只剩三档音量；播放命令与补发；退出运行态音量还原、记账清零；音量编辑与场景编辑**共用一个撤销入口** |
| `grid-annotate.test.tsx` | 391 | 属性面板编辑窗口入口；画笔偏好写进 store 也写进浏览器本地；涂抹写进 RLE 且**整笔可撤销**；网格线与网格标注两个总开关；格子颜色只画可见位且按低位在上叠加 |
| `mask-math.test.ts` | 369 | `strokeStampCenters`；`applyEraseToPixels`（与 `MaskEraseStamp.shader` 同式）；`paintRegionPixels`（整区开/关）；`previewMaskSizeFor`/`brushRadiusFor`；`fillFogMaskPixels` |
| `teleport-object.test.tsx` | 319 | 种类表；创建；属性面板（候选小方块 + ＋ + 传送）；「传送目标」窗口勾选；触发传送（**不改文档**） |
| `audio-catalog.test.ts` | 311 | 清单 = 项目音频 + 标注；标签表与文件上的标签；名字兜底链；搜索与标签筛选 |
| `transform.test.ts` | 305 | 移动（相对按下时的指针）；旋转（相对按下时的方位角，**屏幕上跟手**）；缩放（相对按下时的指针偏移） |
| `fog-mask.test.tsx` | 300 | 属性面板战争雾开关与雾区；揭示记账（**运行态才下发**给前端） |
| `assets-panel.test.tsx` | 288 | 资源面板图标；展开三角；定位选中的文件 |
| `audio-tag-editor.test.tsx` | 240 | 列出标签表；只填名字（没有新建/删除）；改名只改表；关闭 |
| `inspector-groups.test.tsx` | 224 | 属性分组：基础/渲染/区域/战争雾/视频 |
| `audio-tag-dialog.test.tsx` | 220 | 列标签/勾选；只从已有标签里挑（没有新建入口）；目标与关闭 |
| `scene-switch.test.ts` | 218 | 切场景视口跟着场景走；**场景顺序（中文拼音序 + 数字按数值比）** |
| `asset-audio-meta.test.tsx` | 212 | 显示名；标签；只对音频出现 |
| `object-scale.test.tsx` | 161 | 缩放字段（所有对象都有）；`displayRectOf`（显示/拾取/选中框共用矩形） |
| `fog-reveal.test.ts` | 176 | 战争雾记账：擦除轨迹、整区开关、拖动中的分批、前端连上补发 |
| `runtime-push.test.ts` | 130 | `shouldPushScene`；`scenePayloadText`；`ScenePushScheduler`（schedule/flush/cancel） |
| `object-lock.test.tsx` | 132 | 列表里的锁按钮；锁住 = 不能移动；属性面板里的锁定 |
| `video-playback.test.ts` | 125 | 记账：哪个对象该放什么；前端刚连上时的补发计划 |
| `open-project-folder.test.ts` | 120 | 「打开目录」 |
| `sound-playback.test.ts` | 119 | 记账：哪一层该播什么；前端刚连上时的补发计划 |
| `bgm-playback.test.ts` | 112 | 记账：现在该放哪一首；补发计划 |
| `asset-picker.test.ts` | 111 | 资源显示路径；图片/音频/视频素材列表 |
| `object-visibility.test.tsx` | 106 | 场景对象列表的激活按钮；棋盘底纹的锚点 |
| `editor-prefs.test.ts` | 88 | 默认值；解析；读写 |
| `scene-serialize.test.ts` | 65 | `serializeSceneFile` 按场景对象引用缓存 |
| `scene-rename-image.test.ts` | 88 | **回归护栏（v19 新增）**：重命名场景时同名贴图跟着改指——地图的贴图引用必须写进 `GridMap` 组件、**不能留下扁平 `map` 字段**（那会被 schema 丢掉 = 贴图丢失，而且类型检查抓不到）；精灵的图片不动、手工指定的贴图不动 |
| `runtime-client.test.ts` | 57 | 断开原因（close code / reason → 一句人话）；**重连退避**（别拿 500ms 去捶一个注定拒绝你的服务端） |
| `dialog-size.test.ts` | 55 | `dialogSizeFor`；`fitBox` |
| `setup.ts` | 31 | jsdom 环境补齐 |

### 7.4 E2E 清单（19 spec + 2 helper + 1 teardown / 8,127 行）

| spec | 行数 | 覆盖的用户流程 | `@runtime` |
|---|---|---|---|
| `object-edit.spec.ts` | 1,186 | 创建与编辑场景对象（最大的一份：对象弹框、属性面板各组、改名/位置/贴图/网格、复制删除） | 否 |
| `scene-transform.spec.ts` | 877 | 场景变换手柄（移动/旋转/缩放的精确指针手势）+ 画布上的其它拖动 | 否 |
| `sound-object.spec.ts` | 664 | 动作对象「播放声音」（创建、属性面板、编辑窗口）+ 声音命令下发给前端 | **是**（第二部分） |
| `scene-menu.spec.ts` | 462 | 场景菜单（新建/改名/删除/上下场）+ 场景切换（切换条与快捷键 `1`-`9`、`[`/`]`） | 否 |
| `global-bgm.spec.ts` | 422 | 背景音乐：清单来自项目音频、与项目设置分离 + 背景音乐命令下发给前端 | **是**（第二部分） |
| `hierarchy.spec.ts` | 353 | 场景数据（对象列表、种类/关键字过滤）+ 场景对象行操作；**含 4 条迁移用例**：旧版工程文件 v2、旧版场景文件 v3 / v4、以及 **v18 扁平字段 → v19 组件**（断言 `formatVersion` 19、组件 id/type/data 精确、5 个扁平字段消失、网格与声音层级仍然渲染出来） | 否 |
| `smoke.spec.ts` | 351 | 编辑器外壳、画布视口交互、**平板紧凑布局**、编辑态/运行态 | **是**（第四部分） |
| `video-object.spec.ts` | 347 | 地图/精灵的视频列表 + 视频命令下发给前端 | **是**（第二部分） |
| `fog-mask.spec.ts` | 301 | 战争雾 Mask 窗口 | 否 |
| `teleport.spec.ts` | 282 | 动作对象「传送阵」（候选、窗口、按一下换台） | 否 |
| `audio-meta.spec.ts` | 241 | 音频标注在属性面板里改（显示名 + 标签） | 否 |
| `fog-reveal.spec.ts` | 238 | 战争雾：轨迹下发给前端 | **是** |
| `grid-annotate.spec.ts` | 225 | 网格标注在画布上的显示（显示开关、颜色、叠加顺序） | 否 |
| `grid-edit-window.spec.ts` | 219 | 网格编辑窗口（落笔即格子、画笔、全部清除） | 否 |
| `inspector-groups.spec.ts` | 209 | 属性分组 | 否 |
| `project.spec.ts` | 195 | 项目（新建/打开/删除、资源树） | 否 |
| `object-lock.spec.ts` | 182 | 对象锁定 | 否 |
| `object-scale.spec.ts` | 120 | 对象缩放 | 否 |
| `startup.spec.ts` | 113 | 编辑器启动引导 | 否 |
| `helpers/editor.ts` | 1,039 | 用例级助手：建/删项目、打开编辑器、按 `data-testid` 定位、断言状态；**v19 起还有一组组件读取助手**：`COMPONENT`（5 个组件名常量）、`componentId`、`findSceneObject`、`componentInstanceOf`、`objectComponentData`、`componentDataOf(file, {objectId?\|kind?}, component)`、`withComponent`、`readSceneFile`、`readSceneMap`、`readSceneFog`、`readSceneSound`、`readSceneTeleport`、`readSceneVideo`（spec 里**不再直接摸 `components`**，也不再有扁平字段读取） | — |
| `helpers/canvas.ts` | 391 | 画布助手：世界↔屏幕换算、精确点/拖手柄、读取 `data-viewport-*` | — |
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
- `E2E_WORKERS` 默认 **4**（实测 4 → 约 46s 稳定；8 → 约 40s 但偶尔因抢资源超时；14 以上开始真实失败）；
  `E2E_WORKERS=1` 用来复现「串行才出现的时序问题」；
- 端口 `E2E_PORT` 默认 1421（**不是**后端默认的 1420）；`reuseExistingServer: true`；失败保留 trace；
- `globalTeardown` 只能是**文件路径**，所以临时根经环境变量 `DTS_E2E_RESOURCES` 传给 teardown。

**helper 的两处「复述常量」**（升级时必须同步改，注释里都写明了）：
`e2e/helpers/editor.ts` 的 `CURRENT_SCENE_FORMAT_VERSION = 18` 复述 `@dts/document` 的
`DOCUMENT_FORMAT_VERSION`；`fog-reveal.spec.ts` / `global-bgm.spec.ts` / `video-object.spec.ts` /
`sound-object.spec.ts` 里写死的 `protocolVersion: 8` 复述 `@dts/protocol` 的 `PROTOCOL_VERSION`。
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
         ├─ scenes/场景1.json 场景2.json 场景3.json
         ├─ images/Bridge.png Map001.png Map002.png Map003.png
         ├─ audio/act-2/*、act-2-to-act-3/*、character-creation/*、environment/*
         └─ video/Map001.mp4 Map002.mp4 Map003.mp4 Map003_1..3.mp4
```

- **一个项目 = 一个文件夹 + `project.json`**；一切内容在 `Assets/` 下（`config`/`scenes`/`images`/`audio`/`video`）；
- 场景名 = 文件名；地图贴图约定与场景同名（`Assets/images/<场景名>.png`）；
- 每个标准目录里都有一个 `.gitkeep`：后端 `list()` **刻意跳过**它（空目录要能在资源面板里显示，
  但 `.gitkeep` 本身不是资源）；
- `.gitignore` **默认忽略** `resources/projects/*/Assets/{audio,video,images}/*`（大体积二进制不入库），
  但对 `测试项目` 显式加回（`!`）——它是手测与联调的固定数据，缺一张图就会看起来像 bug；
- 后端不依赖资源根存在：`loadConfig` 读不到 `config/app.json` 就用内置默认值，目录由首次写入时按需创建
  （E2E 依赖这一点）。

**`测试项目` 的实际内容**（`formatVersion: 18`）：

| 文件 | 内容 |
|---|---|
| `project.json` | `items = { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] }`；`settings.audio` = `bgm 0.6 / sfx 0.8 / voice 1`（**只有音量**）；`audioMeta` 两条（`06-altar-transition.mp3 → {tags:[0,2]}`、`01-bird-capture-part-1.mp3 → {name:"声音1", tags:[0,1,2]}`）；`audioTags = ["场景1","场景2","场景3"]` |
| `Assets/scenes/场景1.json` | 4 个对象：① `Map`「地图」（`sortingOrder -1`、`locked`、`Map001.png` 1920×1080、`grid 64×36`、RLE 71 段、`map.fog {enabled:true, regions:[1,2,4]}`）；② `SceneObject`「精灵」（`Bridge.png` 256×256、`rotation ≈ -15°`）；③ `PlaySound`「播放声音」（3 条 clips、`picked` = `06-altar-transition.mp3`、`layer:"voice"`）；④ `Teleport`「传送阵」（`targets:["场景2","场景3"]`、`picked:"场景3"`） |
| `Assets/scenes/场景2.json` | 1 个 `Map`「网格地图」（`Map002.png`、`cells` 单个游程 `[[0, 2304]]` 即全空） |
| `Assets/scenes/场景3.json` | 1 个 `Map`「网格地图」（`Map003.png`）+ `video { enabled:false, clips:[Map003_1..3.mp4], picked:"Map003_1.mp4", loop:false, audio:false }` |

这份数据是**四个大特性各一份样例**（战争雾 + 传送阵 + 声音对象 + 视频），改文档格式时它是最直接的回归样本。

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
               → restoreRunBaseline()（两条历史 reset，运行期间的改动全部丢弃）
               → 保存状态恢复正常，之后照常落盘
```

### 9.2 变更指引：要动哪几个文件

| 想做的事 | 需要改的地方 |
|---|---|
| **给场景对象加一个字段** | `@dts/document`：`types.ts`（类型）+ `schema.ts`（schema、默认值取舍、必要时迁移函数）+ `validation.ts`（校验）+ `commands.ts`（setter）+ `factory.ts`（新建默认值）；若前端要用：`@dts/protocol` 的 `messages.ts`（**同步复刻字段**，并判断是否要升 `PROTOCOL_VERSION`）；`apps/editor`：`InspectorPanel` + 对应 `*Fields` + store action；`apps/backend/src/mock-client`（打印出来便于联调）；三处测试；`server/README.md` |
| **加一条协议命令** | `@dts/protocol`：`commandRequestSchema` 加变体 + `PROTOCOL_VERSION + 1`；`hub.ts`（**无需改动**，转发是通用的）；`mock-client`（回执文案）；`apps/editor`：`services/runtime-client` 发送 + 对应记账服务 + store action；`client/`（Unity `CommandRouter`）；E2E 加一个 `@runtime` 用例；两份 spec / README |
| **加一个 HTTP 接口** | `apps/backend/src/http/server.ts` 的 `handleApi` switch；`apps/editor/src/services/project-api.ts`；`apps/backend/test` 加用例；`README` 的接口清单 |
| **加一个项目子目录 / 资源类别** | `@dts/resources/src/ids.ts` 的 `PROJECT_FOLDERS` / `DEFAULT_PROJECT_FOLDERS`（**唯一约定来源**）+ `resources/config/app.json` 的 `projectFolders`；若新增的是**资源类别**（`ResourceKind`），还要改 `provider.ts` 的 `DEFAULT_RESOURCE_DIRS` 与 `config.ts` 的 `dirsSchema`（`satisfies` 会强制你补全） |
| **加一个内部包** | `pnpm-workspace.yaml`（已是 `packages/*`，无需改）+ 新包 `package.json`/`tsconfig.json`；`test/architecture.test.ts` 的 `PURE_PACKAGES` 或 `DOM_OK_PACKAGES` 与 `ALLOWED` 表；`tsconfig` 继承 |
| **加一个变换工具** | `@dts/renderer`：`gizmo.ts` 的 `TransformTool` + `toolHasGizmo` + `gizmoScreenGeometry` + `hitTestGizmoHandles` + `scene-renderer` 的 `drawGizmo`；`apps/editor`：`panels/scene/transform.ts` 的 `resolveTransform` + `ScenePanel` + `store.setTool` + `services/editor-prefs` + `MenuBar` 的「视图」菜单；`gizmo.test.ts` |
| **加一个校验项** | `document/src/validation.ts`（结构性）或 `actions/src/validation.ts`（依赖动作注册表）；对应 `*.test.ts`；若会影响进运行态，注意 `hasErrors` 的语义 |
| **加一个文档版本迁移** | `document/src/schema.ts`：`upgradeRawDocument`（若改的是原始 JSON 形状）或 `withFilledObjectFields` / 新增 `migrateXxx`；`DOCUMENT_FORMAT_VERSION + 1`；`needsRewrite` 条件；`document.test.ts` 的迁移用例 |

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
5. **`PlayAudio` 动作 `implemented: false`**（前端是空壳）：编辑器里能编辑、校验只给 warning，
   导出后不产生效果。
6. **`audioMeta` 指向已删音频文件后没有界面能清理**：会留一条看不见的记录，标签表的「在用」计数仍算它。
7. **场景改名不会自动跟随传送目标**（`teleport.targets` 存场景名），会变成「已失效」；
   但**地图贴图会自动跟随**（`renameScene` 同步指向旧场景名的那张 `map.image`）。**精灵的图片不动**。
8. **Linux 上「定位文件」退化为「打开父目录」**（`fileRevealCommand` 返回 `reveal: false`）；
   不认识的平台直接给可读错误。
9. **`uploadFiles` 在 store 里实现但没有 UI 调用点**——编辑器不导入素材（`src` 下没有任何 `<input type="file">`），
   素材由外部工具提交到 `Assets/`。
10. **`@dts/protocol` 与 `@dts/document` 是两套手工同步的 schema**（§6.3）。改了文档字段却忘了改协议侧，
    类型检查不会报错，只会在运行时被 zod 丢掉或拒掉。
11. **`@dts/renderer` 的 `package.json` 只声明 `@dts/grid`**，架构测试允许它依赖 `document`，
    但当前代码不依赖（`SceneLayer` 是渲染器自己的投影类型）；要加依赖时记得同时改 `package.json` 与 `ALLOWED`。
12. **E2E 的 `@runtime` 用例操作全局单例**：`pnpm e2e` 的两趟分法（`--grep-invert @runtime` 并行
    + `--grep @runtime --workers=1`）不能改，手工敲 `npx playwright test` 时也要照抄。
13. **构建产物带内容哈希**：`pnpm build` 之后，构建前打开的页面必须刷新；后端对缺失产物回 404
    （不回 `index.html`）正是为了这一点。
14. **`resources/config/app.json` 的 `dirs` 与 `projectFolders` 会被 `FsResourceProvider` 构造时校验**
    （必须相对且不越出资源根），写错会**直接拒绝启动**而不是静默降级。
15. **README 与 `playwright.config.ts` 对 E2E worker 数的说法不一致**：`server/README.md` 写「worker 数默认按核数
    一半、封顶 8」，而配置里是固定的 `Number(process.env.E2E_WORKERS ?? 4)`。**以配置文件为准**。
16. **E2E 里有几处「复述常量」不会被类型检查兜住**（见 §7.4 末）：`CURRENT_SCENE_FORMAT_VERSION = 18`、
    各 spec 里写死的 `protocolVersion: 8`，以及 `scene-transform.spec.ts` 顶部复述的手柄几何常量
    （`GIZMO_AXIS_GAP` 45 / `GIZMO_AXIS_LENGTH` 40 / `GIZMO_RING_GAP` 22）。改这些常量时要一起改。
17. **`resources/projects/` 里唯一的项目是「测试项目」**（含 3 个场景、4 张图片、6 个视频、13 个音频），
    它是仓库里唯一「有 `project.json` 因此被接口认成项目」的目录——所以 `e2e/startup.spec.ts` 必须把
    `/api/projects` 打桩成空，才能稳定断言「一个项目都没有」。

---

> 本文由代码实际内容整理（源码 + 测试 + 配置 + 设计文档），行数取自 `ReadAllLines().Count`
> （**含空行**）。若要核对某个数字，用 `[System.IO.File]::ReadAllLines($path).Count`；
> PowerShell 的 `Measure-Object -Line` **不计空行**，会得到偏小的值。
