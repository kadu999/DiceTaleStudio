# 后台服务器模块地图

> 范围：`server/apps/backend/`。本文解释后台每个模块的职责、它与相邻模块的边界，以及新增 / 修改功能时应该从哪里入手。
> 本文按当前源码整理；更完整的字段、接口与内部规则仍以源码注释、测试和 `CODE-STRUCTURE.md` 为准。

## 1. 后台负责什么

后台是一个 **Node.js + TypeScript** 应用，提供三类能力：

1. 通过 HTTP 提供项目、资源、配置和编辑器静态文件；
2. 通过 WebSocket 在编辑器与 Unity 前端之间转发运行态消息，并缓存前端重连所需的最近场景 / 设置；
3. 管理资源文件、缩略图和运行态资源包，并承载 AI 生图的服务端调用。

要区分**编辑器拥有的数据**和**后台的运行态缓存**：场景文档由 Web 编辑器通过 `@dts/document` 编辑、保存；后台 `RuntimeSession` 只暂存编辑器推来的最近场景、设置及前端状态，以便转发、让迟连的 Unity 前端拿到全量状态。后台不持有一份独立的场景编辑数据库。

## 2. 一眼看懂目录

```text
apps/backend/src/
├─ index.ts                     # 组合根：加载配置、创建依赖、启动 HTTP/WS
├─ config.ts                    # 资源根、app.json、HOST/PORT 配置
├─ net.ts                       # 挑选要展示给手机 / 平板的局域网地址
├─ open-folder.ts               # 跨平台打开目录 / 定位文件
├─ values.ts                    # 少量无业务依赖的后端通用值工具
├─ http/
│  ├─ server.ts                 # HTTP 入口、/api 分流、统一异常响应
│  ├─ router.ts                 # 方法 + 路径精确路由分派
│  ├─ context.ts                # 给 handler 的依赖上下文与缓存装配
│  ├─ requests.ts               # 请求体 / 查询参数解析
│  ├─ responses.ts              # HTTP 错误和响应助手
│  ├─ static.ts / mime.ts       # 编辑器静态文件托管与 MIME 类型
│  └─ routes/                   # 按接口域组织的 HTTP handlers
├─ ws/
│  ├─ hub.ts                    # WebSocket 连接、心跳、发送与回执跟踪
│  ├─ hub-context.ts            # 消息 handler 可使用的能力接口
│  ├─ runtime-session.ts        # 运行态内存状态
│  └─ handlers/                 # 按消息方向 / 消息类型处理业务
├─ resources/
│  ├─ fs-provider.ts            # 逻辑资源 ID 到磁盘的唯一适配点
│  ├─ bundle.ts                 # 项目资源清单、指纹、ZIP 与缓存
│  └─ thumbnail-store.ts        # 缩略图内存 / 磁盘两级缓存
├─ image-gen/
│  ├─ platform.ts               # 生图平台选择、出网、PNG 后处理
│  └─ providers/                 # 每个平台的协议适配器
└─ mock-client/index.ts         # 用于联调的假 Unity WebSocket 客户端
```

## 3. 启动与装配

### `src/index.ts` — 应用入口 / 组合根

`startServer()` 按顺序装配：

1. `loadConfig()` 取得 app 配置、资源根和目录约定；
2. 创建统一日志函数；
3. 创建 `FsResourceProvider`，作为资源接口访问项目文件；
4. 创建 `RuntimeHub`；
5. 创建 Node HTTP server，并把同一个 server 交给 `hub.attach()` 处理 WebSocket upgrade；
6. 解析监听地址并调用 `listen()`；
7. 返回 `RunningServer`，供测试或宿主调用 `close()`。

这里是**装配处**，不是 HTTP 业务逻辑所在地。加接口不需要把 handler 塞进 `index.ts`。

### `src/config.ts` — 配置加载

- 决定资源根：显式传参 → `DTS_RESOURCES_DIR` → 基于模块位置的默认目录；
- 读取并校验 `resources/config/app.json`，合并资源类别目录缺省值；
- 解析监听地址，`HOST` / `PORT` 环境变量优先于配置文件；
- 提供缩略图缓存目录等配置派生值。

**资源根路径的唯一引导入口在这里。** 业务代码不要自行拼项目根路径或从当前目录猜资源目录。

### `src/net.ts` — 局域网地址展示

筛掉回环、APIPA 和常见虚拟网卡，优先展示 Wi-Fi / 以太网 IPv4 地址，帮助手机或平板连接开发电脑。它只影响启动日志里展示的地址，不参与 HTTP 路由或连接校验。

### `src/open-folder.ts` — 服务端文件管理器操作

在**运行服务端的电脑**上打开目录，或在支持的平台定位某个文件。命令与参数分开传给 `spawn`，不拼 shell 命令。调用前的项目内路径校验在 `http/routes/projects.ts`；这个模块负责平台命令和进程生命周期。

### `src/values.ts` — 轻量共用工具

- `messageOf`：将未知异常规范化为可读文本；
- `stamp`：日志用的 `HH:MM:SS`；
- `toArrayBuffer`：将 Buffer 的实际视图区间复制成独立 `ArrayBuffer`。

这里不承载业务规则；遇到多个位置完全相同的小型通用操作时才考虑收敛到此处。

## 4. HTTP 子系统

### 请求是怎样走的

```text
浏览器 / HTTP 客户端
  → http/server.ts
      ├─ 路径以 /api/ 开头 → router.ts → routes/index.ts → 一个 route handler
      └─ 其它路径          → static.ts → apps/editor/dist
  → 成功响应由 handler 写出
  → HttpError / 未处理异常由 server.ts 统一翻译为 HTTP 响应
```

HTTP 设计习惯是**一条方法 + 路径对应一个函数**：handler 成功时写响应，失败时抛 `HttpError` 或让异常继续冒泡，由服务器统一处理。

### HTTP 基础模块

| 模块 | 用途 | 修改时机 |
|---|---|---|
| `http/server.ts` | 创建 Node HTTP server、构造请求上下文、区分 `/api/` 与静态文件、统一处理错误；也处理客户端断开时的 socket/response 错误 | 修改全局 HTTP 生命周期或错误策略时 |
| `http/router.ts` | 用精确路径 + HTTP method 找到 handler；负责统一产生未知路径 404、错误方法 405 | 修改分派规则时。通常加接口不需要改它 |
| `http/context.ts` | 将配置、资源 provider、WS hub、日志、缓存和文件管理器能力提供给 handler；测试可注入假依赖 | handler 需要新增全局依赖时 |
| `http/requests.ts` | 有大小上限地读取原始 / JSON body，以及提取 query/body 字段 | 新接口需要新的一般性参数读取方式时 |
| `http/responses.ts` | `HttpError`、400/404/405 等错误构造、JSON/文本/二进制/空响应 helper、资源 provider 错误映射 | 修改 HTTP 状态码或统一响应格式时 |
| `http/mime.ts` | 文件扩展名到 `Content-Type` 的映射 | 新资源类型需要 HTTP MIME 时 |
| `http/static.ts` | 托管编辑器构建产物、SPA 回退、静态路径越界防护 | 修改生产模式编辑器静态托管时 |

### `http/routes/` — HTTP 业务接口

| 文件 | 负责什么 | 常见改动 |
|---|---|---|
| `routes/index.ts` | 唯一 HTTP 路由表；把方法、路径关联到 handler | 新增 handler 后在这里登记 |
| `routes/health.ts` | `/api/health` 就绪 / 健康摘要 | 服务健康探测信息 |
| `routes/config.ts` | `/api/config` 给编辑器返回可公开的配置摘要；不会把生图密钥或平台地址下发 | 编辑器启动需要显示新的安全配置摘要 |
| `routes/state.ts` | `/api/state` 返回当前运行态快照摘要 | 扩展排查或状态面板要读取的摘要 |
| `routes/projects.ts` | 项目创建、删除、列表、目录树、素材 meta / GUID 查询、在服务端打开项目目录 | 项目本身生命周期或项目级查询 |
| `routes/resources.ts` | 通用资源列表、读写、删除、改名、文本、缩略图、manifest 与资源 ZIP 接口 | 素材或项目文件读写、前端资源包下载 |
| `routes/tools.ts` | AI 生图 HTTP 入口：校验输入、读取项目素材、调用平台层、保存生成的 PNG 和 meta | 修改生图接口语义或落盘流程 |

新增 HTTP 接口通常只需：**在对应 `routes/*.ts` 写 handler → 在 `routes/index.ts` 注册 → 在相应 backend test 补覆盖**。接口对编辑器公开时，还要检查 `apps/editor/src/services/` 中对应客户端与 README 接口清单。

## 5. 资源存储与派生缓存

### `resources/fs-provider.ts` — 磁盘资源适配器

实现 `@dts/resources` 定义的 `ResourceProvider`：接收 `project:<项目>/<路径>`、`config:<路径>` 等逻辑 ID，将它们解析到真实磁盘路径，并在读写、删除、重命名、建目录时实施路径边界保护。写文件使用同目录临时文件 + rename，避免读者看到半截文件；也维护素材旁的 `.meta`。

**这是 backend 唯一允许直接触碰项目资源文件系统的模块。** HTTP handler 应通过 `ctx.provider` 操作资源，不要直接 `readFile` / 拼 `resources/projects/...`。

逻辑 ID 解析和 provider 抽象位于 `server/packages/resources/`；磁盘实现位于本 backend 模块。内存实现主要供测试使用。

### `resources/bundle.ts` — 运行态项目资源包

- 从项目 `Assets/` 收集要下发的文件，排除项目元数据和占位文件；
- 根据路径、大小、修改时间生成稳定指纹；
- 将资源和清单组成 ZIP；
- `BundleCache` 按项目保留最新指纹对应的压缩包。

前端先请求 manifest：指纹未变则避免下载；变化时取 ZIP。它服务于 Unity 的本地资源包，不是项目备份或场景存档机制。

### `resources/thumbnail-store.ts` — 缩略图缓存

给资源选择器复用缩略图处理结果：内存热点缓存 + 磁盘缓存，按源素材内容 MD5 寻址，并合并相同内容的并发生成工作。缓存失效或落盘失败只影响性能，不应阻止原请求。

实际生成缩略图的 HTTP 入口在 `http/routes/resources.ts`：图片由 `sharp` 缩放成 WebP；视频先用 ffmpeg 抽帧，再走图片管线。

## 6. WebSocket 运行态

### 消息是怎样走的

```text
编辑器 ── /editor ──┐
                    ├─ ws/hub.ts（连接 / 校验 / 状态缓存 / 转发 / 心跳）
Unity 前端 ─ /client ┘       ↕
                       handlers/editor.ts
                       handlers/client.ts
                       @dts/protocol（消息 schema 与类型）
```

- `/editor` 是编辑器控制面：开关运行态、推送场景与设置、向 Unity 下发命令；
- `/client` 是 Unity 前端连接：只有编辑器开闸运行后才接受连接；
- 消息来自前端时只回报握手、命令结果、pong 和资源包状态，不上报场景数据；
- 消息体必须通过 `@dts/protocol` 校验后才交给 handler。

### WebSocket 模块

| 模块 | 用途 |
|---|---|
| `ws/hub.ts` | WebSocket 传输与连接生命周期：监听 upgrade、路由 `/editor` / `/client`、校验入站 JSON/schema、维护编辑器集合和单个 Unity 客户端、心跳、消息发送/广播、命令回执超时 |
| `ws/hub-context.ts` | Hub 与 handler 之间的接口边界。handler 通过它读 session、发送消息、记日志、踢客户端或管理回执，不需要直接操作 socket 集合和定时器 |
| `ws/handlers/types.ts` | 为消息 handler 提供按消息 `type` 精确收窄的函数签名和完整性检查；消息类型增减时，类型会要求 handler 表保持完整 |
| `ws/handlers/editor.ts` | 编辑器到服务端的业务行为：版本握手、开/关运行态、scene/settings 推送、运行命令转发 |
| `ws/handlers/client.ts` | Unity 到服务端的业务行为：版本握手、命令回执、pong、资源包就绪状态 |
| `ws/runtime-session.ts` | 不落盘的运行态缓存：是否开闸、前端信息、最近场景 / 设置、资源包状态，以及供状态接口展示的摘要 |

**修改消息协议时，HTTP handler 与 WebSocket handler 不是同一层。** WS 报文 schema 在 `server/packages/protocol/src/messages.ts`；改 schema / 命令时还要评估生成物、协议版本判据、编辑器和 Unity 消费方，以及对应测试。不要把场景业务逻辑塞进 `hub.ts`：连接与传输留在 hub，单条消息的行为留在对应 handler。

## 7. AI 生图

```text
POST /api/tools/generate-image
  → routes/tools.ts（校验项目、提示词、尺寸、输入素材）
  → image-gen/platform.ts（选平台、带服务端密钥出网、统一转 PNG / 可选抠背景）
  → provider adapter（按供应商组装请求与解析响应）
  → ResourceProvider 写入项目素材 + meta
```

| 模块 | 用途 |
|---|---|
| `image-gen/platform.ts` | 按配置 / 环境变量选择平台，组合 URL / 模型 / 密钥 / 尺寸 / 超时；负责出网、取回图片、统一转 PNG 和可选纯色背景处理。密钥只留在服务端 |
| `image-gen/providers/types.ts` | `ImageProvider` 接口与 OpenAI 兼容平台工厂；封装 JSON / multipart、输入图、蒙版等请求差异 |
| `image-gen/providers/index.ts` | 扫描 provider 目录并自动发现导出 `provider` 的平台模块 |
| `image-gen/providers/openai.ts` | OpenAI 请求形状的具体声明 |
| `image-gen/providers/volcengine.ts` | 火山 Seedream 请求形状的具体声明 |

新增兼容平台通常在 `providers/` 新建一个短文件并导出 `provider`；平台地址、模型和 key 放 `resources/config/app.json` 或环境变量，不写进适配器。测试入口主要是 `apps/backend/test/image-gen-providers.test.ts` 和 `image-gen-api.test.ts`。

## 8. Mock 客户端与测试

### `mock-client/index.ts`

一个轻量假 Unity WebSocket 前端，可重试连接、打印收到的场景 / 设置、对命令回失败回执、响应心跳。运行：

```bash
pnpm --filter @dts/backend mock
```

它用于确认握手、消息转发和命令回执链路，不会真实绘制场景、播放音视频，也不能代替 Unity 验收。

### `apps/backend/test/`

Backend 单测按被测模块命名，例如：

- `runtime-hub.test.ts` / `runtime-session.test.ts`：WS 中枢和会话状态；
- `resources-api.test.ts` / `resources-bundle*.test.ts` / `thumbnail-store.test.ts`：资源 HTTP、资源包、缩略图缓存；
- `fs-provider.test.ts` / `atomic-write.test.ts`：磁盘资源安全与原子写；
- `project-api.test.ts` / `requests.test.ts` / `static-serving.test.ts`：项目 API、请求和静态文件；
- `image-gen-*.test.ts`：平台适配与生图路由。

新增或修复 backend 行为时，优先在最近的模块测试旁补定向用例，然后按改动范围运行 `pnpm --filter @dts/backend typecheck`、根目录 `pnpm test` 或 `pnpm check`。涉及真实 Unity / 外部服务的部分要单独说明是否进行了实机 / 实网验证。

## 9. 按需求快速定位

| 想做的事 | 先看这里 | 通常还要检查 |
|---|---|---|
| 加 HTTP API | `http/routes/<domain>.ts` | `http/routes/index.ts`、backend API 测试、编辑器 service、`server/README.md` |
| 改 HTTP 参数 / 错误码 | `http/requests.ts` / `http/responses.ts` | 对应 route 与 API 测试 |
| 改项目文件 / 素材读写 | 对应 `http/routes/*.ts` | `resources/fs-provider.ts`（只有 provider 层能碰磁盘）、`@dts/resources` 逻辑 ID |
| 改缩略图 | `http/routes/resources.ts` | `resources/thumbnail-store.ts`、`thumbnail-store.test.ts` / resources API 测试 |
| 改 Unity 下载资源流程 | `http/routes/resources.ts` manifest / bundle handlers | `resources/bundle.ts`、WS 的 `prepareClientResources`、客户端资源包实现 |
| 改 WS 消息行为 | `ws/handlers/editor.ts` 或 `client.ts` | `@dts/protocol` schema、`hub.ts` 分发、runtime-hub 测试、编辑器 / Unity 接收方 |
| 改 WS 连接 / 心跳 / 超时 | `ws/hub.ts` | `runtime-hub.test.ts`、`pending-commands.test.ts` |
| 加 AI 生图平台 | `image-gen/providers/` | `app.json` 平台配置、provider 测试；一般不改平台发现注册表 |
| 改生图存盘或校验 | `http/routes/tools.ts` | `image-gen/platform.ts`、`image-gen-api.test.ts`、资源 meta 行为 |
| 改服务端启动 / 监听配置 | `index.ts` / `config.ts` | `config.test.ts`、启动脚本 / README |
| 改生产版网页托管 | `http/static.ts` / `http/mime.ts` | `static-serving.test.ts`、编辑器 build 行为 |
| 调试客户端协议链路 | `mock-client/index.ts` | 真实协议与 Unity 客户端限制；Mock 不是真实 Unity |

## 10. 本地运行与检查

在 `server/` 目录执行：

```bash
pnpm dev                                  # 后端 + Vite 编辑器
pnpm dev:backend                          # 只启动后端
pnpm --filter @dts/backend mock           # 启动假 Unity 客户端（编辑器先点「运行」）
pnpm --filter @dts/backend typecheck      # 后端 TypeScript 类型检查
pnpm exec vitest run apps/backend/test/runtime-hub.test.ts  # 示例：只跑一个后端测试文件
pnpm test                                 # 全部 Vitest 单测
pnpm check                                # typecheck + test + lint + docs + contract
```

E2E 与运行态测试的分趟 / 串行约定见 [`server/README.md`](../README.md)；完整目录和依赖边界见 [`CODE-STRUCTURE.md`](CODE-STRUCTURE.md) 的「后端 `apps/backend`」一节。
