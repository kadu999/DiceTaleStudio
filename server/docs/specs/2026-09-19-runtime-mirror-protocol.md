# 运行态镜像协议（编辑器 → 服务端 → 前端）

> 状态：**已实现**（2026-09-19）。取代 [`2026-09-18-frontend-integration-contract.md`](2026-09-18-frontend-integration-contract.md)
> （那份写的是「前端上报数据、后台按 id 寻址动作」的老模型，已整层删除）。

## 一句话

**后台（编辑器文档）是唯一真源，前端只是它的镜像 + 播放器**：
编辑器把当前场景整份推给服务端，服务端缓存并转发给前端，前端按对象 `id` 建 / 改 / 删自己的对象。
命令（如播放声音）只是**触发器**——数据在场景里，命令里不带数据。

## 门控：没点「运行」，前端连不上

**运行态是服务端状态**（`RuntimeSession.runtimeActive`），由编辑器点击驱动，**不跟着编辑器那只 WebSocket 活**：

| 时机 | 服务端行为 |
|---|---|
| 编辑器未声明运行态 | `/client` 的 WS 升级以 **HTTP 503** 拒绝（响应头 `x-dts-reason: runtime-inactive`），不建立连接 |
| `runtime_start` | **开闸**：此后 `/client` 可连接；幂等（重复点不会重置场景缓存） |
| `runtime_stop` | **关闸**：踢掉已连前端（close **4003**）、清场景缓存 |
| **编辑器刷新页面 / 关掉页面 / 掉线** | **什么都不做**：运行态还在，前端**不被踢**、镜像也还在 |
| 服务端重启 | 运行态清空（内存态，不持久化）→ 要重新点一次「运行」 |

所以「刷新一下网页就退出运行、前端被踢」不会发生；编辑器页面加载时会连上服务端要一份状态，
如果服务端还记着在运行，界面就自动回到运行态（并且把当前场景再推一份，因为浏览器里的文档是重新读盘的）。

## `/editor`（编辑器 ↔ 服务端）

| 方向 | type | 字段 | 说明 |
|---|---|---|---|
| E→S | `editor_hello` | `protocolVersion` | 连上即发；版本不符 → close 4002 |
| E→S | `runtime_start` | — | 点「运行」；幂等 |
| E→S | `runtime_stop` | — | 点「编辑」；关闸 |
| E→S | `scene_push` | `scene: SceneDoc \| null` | 推当前场景（整份）；`null` = 没打开场景 |
| E→S | `editor_command` | `requestId`, `command` | 下发一条命令给前端 |
| E→S | `editor_refresh` | — | 要一份当前运行态 |
| S→E | `editor_state` | `runtimeActive`, `client`, `scene`, `serverTime` | 连接 / 断开 / 场景更新 / 开关闸时推 |
| S→E | `editor_command_result` | `requestId`, `ok`, `reason?`, `effects?` | 前端回执（5s 不回 → `editor_error`） |
| S→E | `editor_log` | `level`, `message`, `time` | 服务端日志（「前端已连接」等直接进运行日志） |
| S→E | `editor_error` | `requestId?`, `reason` | 明确失败：前端未连接 / 未进入运行态 / 超时 |

- `client = { name, version, connectedAt } | null`
- `scene = { name, objectCount, updatedAt } | null`（前端镜像到哪了）

**推送时机**：进运行态时推一次；之后文档一变就推（编辑器去抖 **200ms** + 内容去重，
撤销回原样 / 画布重绘不会空推）。**全量推送**，不做增量 patch——这个量级下最省心、永不失同步。

## `/client`（服务端 ↔ 前端）

| 方向 | type | 字段 |
|---|---|---|
| S→C | `server_hello` | `protocolVersion`, `sessionId`, `serverTime` |
| S→C | `scene_sync` | `scene: SceneDoc \| null`（**全量**：连上立刻给缓存那份，之后每次推送转发） |
| S→C | `command` | `requestId`, `command` |
| S→C | `ping` | `seq`（15s 一拍；连续两拍没有 pong 判死并清理） |
| C→S | `client_hello` | `protocolVersion`, `name`, `version`（版本不符 → close 4002） |
| C→S | `command_result` | `requestId`, `ok`, `reason?`, `effects?`（**必须回**） |
| C→S | `pong` | `seq` |

前端**不上报任何游戏数据**（旧协议里的 `register_*` / `report_*` / `request_join` / `heartbeat` 全没了）。

## 场景数据（`SceneDoc`）与前端映射

`SceneDoc = { name, objects: SceneObjectDoc[] }`，字段口径取自 `@dts/document`（协议包内复刻只读 schema，
不反向依赖文档包）。前端按需取用，`components` / `locked` 这类编辑器侧字段忽略。

| `SceneObjectDoc` | 前端 |
|---|---|
| `id` | 镜像字典的 key：新 id 建对象、老 id 更新、名单里没有的销毁；场景名变了则整场景换 |
| `name` | GameObject 名字 |
| `kind` | `Map` / `SceneObject` / `Player` / `Item` / `Event` → 一块贴地面片；`PlaySound` → 不建可见物（数据只留在镜像里） |
| `position {x,y}` | `(x, 0, y)`：文档 y 向上 → 客户端 +Z（与 `GridMap.WorldToGrid` 同口径）；`null` = 未落位 → 不建视图 |
| `active` | 是否显示（编辑器那个勾选框一改，前端就出现 / 消失） |
| `scale` | 面片尺寸 = 声明尺寸（`image` / `map.image`）× `scale` |
| `rotation` | 绕 +Y（按 `-rotation`） |
| `sortingOrder` | `MeshRenderer.sortingOrder` + 按序微小离地（避免共面闪烁） |
| `image` / `map.image` | 资源逻辑 ID → `GET /api/resources/raw?id=…` 取纹理；没图时按 `kind` 上色占位 |
| `map.cells` | RLE（`[[掩码, 格数], …]`）——掩码值与 `@dts/grid` 的 `CellMask` / Unity 的 `GridCellType` 完全一致 |
| `sound` | `{ clips, picked, layer }`：前端播的就是 `picked` 那条；`layer` ∈ `bgm/ambient/sfx/voice`，同层同时只响一条 |

## 命令

| kind | 载荷 | 前端行为 |
|---|---|---|
| `play_sound` | `{ objectId, layer }` | 从**镜像里的那个对象**读 `sound.picked`，在该层播放（同层顶替） |
| `stop_sound` | `{ layer }` | 停掉该层 |

**实现进度**：命令链路（转发 / 回执 / 超时 / 日志）已通；前端 `play_sound` 的**真出声**
（取音频 + 按层播放）是下一步——现在它如实回 `ok:false` 并说明「镜像里该播哪一条」，
编辑器日志里看得见失败原因，不会假装成功、也不会超时。

## 客户端实现位置（`client/`）

| 文件 | 职责 |
|---|---|
| `Data/SceneModel.cs` | 镜像模型（与 `SceneDoc` 同构） |
| `Data/SceneParser.cs` + `Data/JsonParser.cs` + `Data/GridRle.cs` | 解析场景 / RLE 解码（JsonUtility 读不了嵌套数组） |
| `Network/Protocol.cs` | 协议常量、出站 DTO、`ws://…/client` → `http://…` 推导 |
| `Network/ServerConnection.cs` | WS 连接（未开闸时握手被拒 = 正常现象，只提示一次并重试） |
| `Network/ClientSession.cs` | 握手 / 心跳 / 把消息变成事件 |
| `Logic/SceneMirror.cs` | 按 id 增 / 改 / 删视图 |
| `Logic/CommandRouter.cs` | 命令 → 动作 → 回执 |
| `Presentation/SceneObjectView.cs` | 一个对象一块贴地面片（位置 / 缩放 / 激活 / 显示顺序 / 取图） |
| `Presentation/ResourceImageLoader.cs` | 按逻辑 ID 取图（带缓存 / 去重 / 失败记忆） |
