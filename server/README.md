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

## 资源：统一资源根

所有资源集中在 `resources/`，**代码不硬编码任何路径**：

```
resources/
├─ config/     app.json（端口、资源目录名）/ editor.json（编辑器默认值）/ export.json（导出目标）
├─ maps/       地图数据：<名字>.json（网格 RLE + 出生点 + 对象 + 动作）、<名字>.bytes（Unity 兼容二进制）
├─ images/     images/maps/<名字>.png（地图贴图）、icons/、textures/
├─ audio/      音频
├─ video/      视频
├─ items/      items.json（道具库，形状与 DiceTale 一致）
└─ projects/   *.dtproj.json（编辑项目）
```

- 资源用**逻辑 ID** 寻址：`map:Map001.json`、`image:maps/Map001.png`、`config:app.json`、`project:demo.dtproj.json`。
- 目录名由 `config/app.json` 的 `dirs` 声明，改目录只改配置。
- 逻辑 ID → 真实路径的解析只发生在 `ResourceProvider` 实现里（后端 `FsResourceProvider`、编辑器 `HTTP`、测试 `Memory`）。
- 地图数据与贴图靠**同名约定**关联，该约定集中在 `packages/resources/src/ids.ts`。
- `images/`、`audio/`、`video/` 下的大体积二进制默认不入库（见仓库根 `.gitignore`），需要时 `git add -f` 或启用 Git LFS。

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
