# DiceTaleStudio / server

跑团（TRPG）**Web 编辑器 + 服务端**。用于编辑地图网格、场景对象与对象上的动作，
并可在**运行状态**下连接前端（Unity 客户端）实时镜像状态、触发对象上的动作。

本仓库是 DiceTale 的下一代：`server/` 是编辑器与服务端，`client/`（Unity 前端）后续并入。

---

## 快速开始

```bash
cd server
pnpm install

pnpm dev            # 同时起后端（1420）与编辑器 Vite（5173）
# 或者分开：
pnpm dev:backend
pnpm dev:editor

pnpm --filter @dts/backend mock   # 另开一个终端：启动 Mock 前端
```

- 编辑器（开发）：<http://localhost:5173>（`/api` 与 `/editor`、`/client` 由 Vite 代理到后端）
- 编辑器（生产）：`pnpm build` 后由后端同源托管 <http://localhost:1420>
- 后端接口：`/api/health`、`/api/config`、`/api/resources/index`、`/api/resources/raw?id=...`、`/api/state`
- WebSocket：`/client`（前端）、`/editor`（编辑器）

## 常用脚本（在 `server/` 下执行）

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 后端 + 编辑器开发服务器 |
| `pnpm build` | 构建编辑器产物到 `apps/editor/dist`（E2E 前必须先跑） |
| `pnpm typecheck` | 全部包类型检查 |
| `pnpm test` | 单元测试 + 架构边界测试 |
| `pnpm lint` | ESLint |
| `pnpm e2e` | Playwright（桌面 + 两个平板档位） |

Windows 下也可以直接双击批处理（`server/` 目录内，GBK + CRLF，中文提示）：

| 批处理 | 说明 |
|---|---|
| `command-install.bat` | 检查 node/pnpm 后安装依赖；失败时提示设置代理 |
| `command-build.bat` | 全包类型检查 + 构建编辑器产物 |
| `command-start.bat` | 单端口启动服务端并托管编辑器；默认不弹浏览器（`--open` 可开）；默认监听 `0.0.0.0` 供同一 WiFi 的手机/平板访问；带端口占用预检 |
| `command-open-port.bat` | 放行 Windows 防火墙入站端口（自动 UAC 提权；`--print` 只看命令不改系统） |

---

## 目录结构

```
server/
├─ apps/
│  ├─ editor/          # React 编辑器（四区布局、画布、属性面板、运行态 UI）
│  └─ backend/         # Node/TS：静态托管 + 资源 REST + 运行态 WS 中枢 + Mock 前端
├─ packages/           # 可独立测试的内部模块
│  ├─ grid/            # 网格位掩码、坐标转换、RLE、.bytes 编解码（零依赖）
│  ├─ document/        # 文档模型、zod 校验、组件注册表、补丁式撤销重做
│  ├─ actions/         # 动作注册表、条件求值、动作图校验
│  ├─ protocol/        # WS 消息契约（编辑器与后端共用同一份 zod schema）
│  ├─ resources/       # 资源逻辑 ID 规则、ResourceProvider 抽象、内存实现
│  └─ renderer/        # Canvas 2D 渲染器与视口变换（不依赖 React）
├─ resources/          # ★ 全部资源（见下）
├─ e2e/                # Playwright 用例
├─ test/               # 架构边界测试
└─ docs/specs/         # 设计文档
```

### 模块依赖规则（由测试强制）

```
editor  → document, actions, protocol, resources, renderer, grid
backend → protocol, resources
renderer→ grid
actions → document
document→ grid
protocol, resources, grid → （无）
```

约束写在 `test/architecture.test.ts` 里，破坏即测试失败：

1. `grid / document / actions / protocol / resources` **不得** import React、Node 内置模块或 DOM 全局；
2. `renderer` 可以用 DOM/Canvas，但**不得**依赖 React；
3. 包之间只允许上面声明的依赖方向，且必须写进各自 `package.json`；
4. 除 `resources` 包外，源码里**不得出现资源路径字面量**（一律用逻辑 ID）；
5. 只有后端 `FsResourceProvider` 能碰文件系统。

---

## 资源：一个跑团 = 一个工程 = 一个文件夹

**每个跑团是唯一的文件夹，里面放这个跑团的配置和资源**，以及一个单独存在的工程文件
（形态类似 UE 的 `MyGame.uproject` 放在 `MyGame/` 根下）：

```
resources/
├─ config/                            编辑器全局配置（不属于任何跑团）
│  ├─ app.json                        端口、资源目录名、跑团标准子目录
│  ├─ editor.json                     编辑器默认值
│  └─ export.json                     导出目标
└─ campaigns/                         ★ 所有跑团工程
   └─ 我的跑团/                        ★ 一个跑团一个唯一文件夹
      ├─ 我的跑团.dtproj.json          ★ 工程文件（单独的文件；打开/保存的就是它）
      ├─ config/                       该跑团自己的配置
      ├─ maps/                         地图数据：<地图>.json、<地图>.bytes（Unity 兼容）
      ├─ images/maps/                  地图贴图：<地图>.png（与地图数据同名）
      ├─ audio/
      ├─ video/
      └─ items/                        道具库 items.json
```

编辑器里：「工程 → 新建项目」起个名字即创建出上述结构；「工程 → 打开项目」列出所有跑团。
左栏「项目资源」页签就是这套目录的浏览器（类似 Unity 的 Project 窗口），可**新建文件夹 / 导入资源 / 删除资源**。

- 资源用**逻辑 ID** 寻址，只有两个类别：`config:`（编辑器全局）与 `campaign:`（跑团内容）。
  例如 `campaign:我的跑团/我的跑团.dtproj.json`、`campaign:我的跑团/images/maps/Map001.png`。
- 跑团文件夹名、标准子目录名集中在 `packages/resources/src/ids.ts`（`CAMPAIGN_FOLDERS`）；
  资源根与 `campaigns` 目录名由 `config/app.json` 的 `dirs` 声明。
- 逻辑 ID → 真实路径的解析只发生在 `ResourceProvider` 实现里（后端 `FsResourceProvider`、编辑器 `HTTP`、测试 `Memory`）。
- 跑团名会直接成为文件夹名，因此会挡掉路径分隔符、Windows 非法字符与 `CON`/`NUL` 等保留名。
- 大体积二进制（地图贴图、音视频）默认不入库，需要时 `git add -f` 或启用 Git LFS。

---

## 编辑态 / 运行态

- **编辑态**：编辑地图、对象、组件与动作；全程可撤销/重做（补丁式历史，连续拖拽/绘制合并为一条记录）。
- **运行态**：连接服务端，实时镜像前端状态（当前地图、玩家、对象、可触发动作），并可一键触发动作。

**运行态数据与编辑文档物理隔离**：镜像放在独立的 `runtime` 状态里，永不写回文档，也不进撤销栈。

## 告诉前端执行一个动作：三级降级

| 场景 | 下发 | 前端行为 | 依赖 |
|---|---|---|---|
| 触发前端已配置好的动作（**主路径**） | `invoke_action{objectId, actionId}` | 按 id 找动作 → 评估条件 → 执行效果 | 需前端实现下方契约 |
| 动作只在编辑器里编排（v2 服务端权威） | 服务端求值后下发原子命令序列 | 执行 `set_option` 等，本地动作链产生副作用 | 待实现 |
| 只想改某个值 | `set_option` / `set_bool` / `set_int` / `set_float` … | 组件改值 → 本地动作链 | **现在就能用** |

前端（Unity）当前未开放，因此运行态用 **Mock 前端**（`apps/backend/src/mock-client`）先行验证：
它实现同一套 `/client` 协议，上报对象与动作清单，并对 `invoke_action` 回执。
端到端链路已有测试锁定（`apps/backend/test/runtime-hub.test.ts`）。

## 前端（Unity 客户端）需要配合的最小契约

待前端开放后实施，详见 `docs/specs/`：

1. `BackendChangeAction` 增加可序列化稳定 `actionId`（跨会话稳定，用于远程寻址动作）。
2. 注册上报增加动作清单：`{ type: "register_actions", objectId, componentId, actions: [{ actionId, type, displayName, paramSummary, conditionSummary }] }`。
3. `ServerCommandDispatcher` 增加 `invoke_action` 分支：定位对象 → 按 `actionId` 找动作 → 执行 → 回 `action_result`。
   注意动作挂在组件上，需要一条**按动作 id 定位的旁路**，不改动现有「按命令类型路由组件」的语义。
4. 条件求值保持现状（客户端本地 `Satisfies`）；服务端权威求值作为后续可选项。

协议定义以 `packages/protocol` 为唯一来源（编辑器与后端共用，入站消息全部经过 zod 校验）。

---

## 坐标契约（务必遵守）

三套坐标系并存，历史上这里反复出错：

| 坐标系 | 方向 |
|---|---|
| 图像像素 | 原点左上，x 向右，**y 向下** |
| 归一化（协议/GM 面板） | `[0,1]`，**y 向下** |
| 网格（与 Unity `GridMap` 一致） | x 向右，**y 向上**；`y = 0` 是图片**最下面**一行 |

换算恒等式：`gridY = height - 1 - imageRow`。
所有换算必须走 `packages/grid/src/coords.ts`，**不要在别处再写一遍**。
`.bytes` 的行序固定为 `bottom-up`（文档里显式声明 `rowOrder`），`Map001` 实测：1920×1080 图 / 64×36 格 / 每格 30px。

---

## 已知限制与下一步

- 编辑器目前只完成了骨架（四区布局、画布视口、运行态面板）；网格绘制、对象/组件编辑、动作编辑、项目持久化与导出按里程碑推进。
- Playwright 目前用 Chromium 覆盖桌面与平板（触摸模拟）；真实 iPad/Safari（WebKit）档位需额外下载 WebKit 浏览器后补充。
- 服务端权威动作求值（多步序列、服务端条件判定）尚未实现。
