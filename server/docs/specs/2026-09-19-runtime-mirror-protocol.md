# 运行态镜像协议（编辑器 → 服务端 → 前端）

> 状态：**已实现**（2026-09-19；2026-09-20 升到 **协议 v2**：新增 `resources_prepare`，让前端
> **先下资源包、再载入场景**；2026-09-21 升到 **协议 v3**：新增战争雾的 `erase_mask` /
> `reveal_fog_region`——对前端是加法，但**老服务端的入站 schema 会把新命令判成非法消息丢掉**，
> 所以照样 +1，靠版本握手把「新旧混着跑」挡在连上的那一刻；同一天升到 **协议 v4**：战争雾多了
> **总开关** `map.fog.enabled`——老前端不认这个字段会静默丢掉，「编辑器里关掉了、前端照样有雾」，
> 所以同样靠版本握手拦住；同日再升到 **协议 v5**：地图 / 精灵多了**视频**
> （`video` + `play_video` / `pause_video` / `resume_video` / `stop_video`），理由与 v3 完全相同；
> 再升到 **协议 v6**：声音补齐 `pause_sound` / `resume_sound`（编辑器里「播放声音对象」与「视频」
> 两组 UI 的控件行完全一致），同样是新增命令；2026-09-21 再升到 **协议 v7**：**全局背景音乐**
> （项目级设置）落地——新增 `settings_push` / `project_settings` 两条消息与 `play_bgm` / `pause_bgm` /
> `resume_bgm` / `stop_bgm` 四条命令，声音层级从四档收成三档；2026-09-22 升到 **协议 v8**：
> **背景音乐与项目设置解耦**——`project_settings.audio.bgm` 只剩音量（歌单 / 默认曲 / 循环不再下发），
> 曲目清单**就是项目 `Assets/audio/` 下的音频**，由编辑器弹框点一首、发一条 `play_bgm{clip}`；
> 命令那一组不变，但载荷形状变了，所以照旧 +1）。
> 2026-09-22 再升到 **协议 v9**：**对象特性搬进组件**——场景对象上的 `map` / `image` / `sound` /
> `teleport` / `video` 这 5 个扁平字段没了，改成 `components[]` 里的组件实例
> （`GridMap` / `TextureRenderer` / `PlaySound` / `Teleport` / `VideoOverlay`，与文档格式 v19 同一批）。
> 老前端按扁平字段读，迁移后的场景在它眼里会变成「一个什么都不带的空对象」，所以必须 +1。
> **命令那一组一个字节都没动。**
> 同一天再升到 **协议 v10**：**精灵（子图）**——贴图引用多了 `sprite`（取第几格）与 `spriteGrid`
> （这张图几列几行）两项（与文档格式 v20 同一批），前端据此只画那一块矩形。两项都是可选的，
> 老前端（v9）会静默把整张图集铺出来——不是崩，是画面错，所以照旧 +1：服务端与前端必须同批更新。
> **命令那一组仍然一个字节都没动**（子图是数据，不是新动作）。
> 其后 **v11–v16** 的每一次都是**与文档格式同一批**的不兼容改动（kind 改名、显示顺序搬进渲染组件、
> 战争雾拆组件 / 变成独立对象、取消 `Map` 类型把网格变成贴图上的可选组件等），照旧靠版本握手挡住；
> 逐条见 `CODE-STRUCTURE.md` §6.1 与 `packages/protocol/src/messages.ts` 的版本注释。
> 取代 [`2026-09-18-frontend-integration-contract.md`](2026-09-18-frontend-integration-contract.md)
> （那份写的是「前端上报数据、后台按 id 寻址动作」的老模型，已整层删除）。

## 一句话

**后台（编辑器文档）是唯一真源，前端只是它的镜像 + 播放器**：
编辑器把当前场景整份推给服务端（项目级的全局设置另外一条消息），服务端缓存并转发给前端，
前端按对象 `id` 建 / 改 / 删自己的对象。
命令（如播放声音）只是**触发器**——数据在场景里，命令里基本不带数据
（唯一的例外是 `play_bgm{clip}`：曲目清单不在任何对象上、也不在项目设置里——它就是项目
`Assets/audio/` 下的音频，DM 在弹框里点哪一首，命令就说哪一首）。

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

## 运行中的改动：不保存、退出运行即还原（对齐 Unity 的播放模式）

**运行态下照样能编辑**——隐藏对象、拖位置、涂格子都立刻（去抖 200ms）推给前端看效果。
但这些改动是**临时的**：

| 规则 | 说明 |
|---|---|
| **不写盘** | 运行期间的任何改动都不落盘：自动保存被拦下，手动「保存」也拦下（`saveSceneNow` 直接返回 false，底栏显示「运行中（不保存）」） |
| **不进撤销栈** | 运行期间的历史不入档；退出运行后撤销栈是空的 |
| **退出时整体还原** | 进入运行时给整份文档拍一张**基线快照**；关闸（`editor_state.runtimeActive=false`）时整体还原，运行期间试出来的样子全部丢弃 |
| **文件操作直接挡住** | 场景的新建 / 改名 / 删除是**文件操作**（还原不回来），运行态下拒绝执行并提示先点「编辑」 |
| **断线不等于关闸** | 编辑器与服务端断线时只丢「前端在不在 / 推的是哪份场景」，**运行态本身保留**——否则运行期间的改动会被当成编辑态的改动写进文件 |
| **基线跟着文档走** | 编辑器可能在服务端已经开着运行态时才拿到文档（刷新后接回去、开第二个窗口、运行中装载项目）：文档整份被换掉时基线跟着换，否则退出运行会还原成别的项目或一片空白 |

前端不需要为这件事做任何事：关闸时它已经被踢下线（close **4003**），下次运行推下来的是**还原后**的场景。

## `/editor`（编辑器 ↔ 服务端）

| 方向 | type | 字段 | 说明 |
|---|---|---|---|
| E→S | `editor_hello` | `protocolVersion` | 连上即发；版本不符 → close 4002 |
| E→S | `runtime_start` | — | 点「运行」；幂等 |
| E→S | `runtime_stop` | — | 点「编辑」；关闸 |
| E→S | `scene_push` | `scene: SceneDoc \| null` | 推当前场景（整份）；`null` = 没打开场景 |
| E→S | `settings_push` | `settings: ProjectSettings \| null` | 推**项目级全局设置**（v7 起；v8 起只有三档音量）；`null` = 没打开项目。与场景分开一条消息，因为**它跨场景有效** |
| E→S | `editor_command` | `requestId`, `command` | 下发一条命令给前端 |
| E→S | `editor_refresh` | — | 要一份当前运行态 |
| S→E | `editor_state` | `runtimeActive`, `client`, `scene`, `resources`, `settings`, `serverTime` | 连接 / 断开 / 场景或设置更新 / 开关闸时推 |
| S→E | `editor_command_result` | `requestId`, `ok`, `reason?`, `effects?` | 前端回执（15s 不回 → `editor_error`） |
| S→E | `editor_log` | `level`, `message`, `time` | 服务端日志（「前端已连接」等直接进运行日志） |
| S→E | `editor_error` | `requestId?`, `reason` | 明确失败：前端未连接 / 未进入运行态 / 超时 |

- `client = { name, version, connectedAt } | null`
- `scene = { name, objectCount, updatedAt } | null`（前端镜像到哪了）
- `resources = { project, fingerprint, fileCount, bytes, ok, at, reason? } | null`（前端本地资源包到哪了，见下）
- `settings = { updatedAt } | null`（已推下去的全局设置摘要；v8 起设置里只有音量，所以不报内容）

**推送时机**：进运行态时推一次；之后文档一变就推（编辑器去抖 **200ms** + 内容去重，
撤销回原样 / 画布重绘不会空推）；**切场景立刻推**（不等去抖——对 DM 而言这就是「换台」，
投影晚一秒都比不换更让人困惑；payload 里带场景名，所以切场景必然算一次变更）；
**工程文件里的图片切分表（v20）一变也重推一次场景**——子图的「几行几列」随载荷走，
改切分等于改了解析结果（文本比对保证「改的是别的项目级数据」时一个字节都不发）。
**全量推送**，不做增量 patch——这个量级下最省心、永不失同步。

## `/client`（服务端 ↔ 前端）

| 方向 | type | 字段 |
|---|---|---|
| S→C | `server_hello` | `protocolVersion`, `sessionId`, `serverTime` |
| S→C | `resources_prepare` | `project: string \| null`（**在 `scene_sync` 之前**：让前端先下资源包，前端会挂起场景直到资源就绪） |
| S→C | `scene_sync` | `scene: SceneDoc \| null`（**全量**：连上立刻给缓存那份，之后每次推送转发） |
| S→C | `command` | `requestId`, `command` |
| S→C | `ping` | `seq`（15s 一拍；连续两拍没有 pong 判死并清理） |
| C→S | `client_hello` | `protocolVersion`, `name`, `version`（版本不符 → close 4002） |
| C→S | `command_result` | `requestId`, `ok`, `reason?`, `effects?`（**必须回**） |
| C→S | `resources_ready` | `project`, `fingerprint`, `fileCount`, `bytes`, `ok`, `reason?`（本地资源包结果，成功失败都报） |
| C→S | `pong` | `seq` |

前端**不上报任何游戏数据**（旧协议里的 `register_*` / `report_*` / `request_join` / `heartbeat` 全没了）。
`resources_ready` 不是游戏数据，它是**资源包拉到哪了**的回执：编辑器运行面板据此显示进度，
不影响寻址、也不参与门控。

## 场景数据（`SceneDoc`）与前端映射

`SceneDoc = { name, objects: SceneObjectDoc[] }`，字段口径取自 `@dts/document`（协议包内复刻只读 schema，
不反向依赖文档包）。

**v9 起对象是「实体 + 组件」**：`id` / `name` / `kind` / `active` / `locked` /
`position` / `rotation` / `scale`（+ 可选 `scaleX` / `scaleY`）留在对象上，**其余全在 `components[]` 里**
（`{ id, type, data }`）。`kind` 只是**创建原型**标签，**行为看组件**：
前端按 `type` 分派，不认识的类型安静忽略即可（数据留在镜像里）。
**显示顺序 `sortingOrder`（v14 起）住在渲染组件的 data 里**（图片层；v16 起带网格的贴图也在图片层），
对象上不再有这一项；客户端解析时取出来填进 `MirrorObject.sortingOrder` 供表现层使用。

| 组件 `type` | 前端行为 |
|---|---|
| `GridMap` | **网格数据**（v16 起是贴图上的可选组件）：`data` = `{grid, rowOrder, cells}`。贴图在对象的 `ImageLayer` 里，网格线以后画在这里 |
| `FogOfWar` | **战争雾**（v15 起挂在独立的 `Fog` 对象上）：`data` = `{ mapId, enabled, regions }`。`mapId` 引用被罩住的**带网格的贴图**；`enabled` 总开关（缺省算开）；`regions` 哪几个「区域位」算雾区。**只有 `mapId` 有效、`enabled && regions.length > 0` 前端才建那一层雾**；**哪里被揭示了不在数据里**——那是运行态，由 `erase_mask` / `reveal_fog_region` 驱动，不写文档、也不随 `scene_sync` 回来 |
| `ImageLayer` | **贴图对象 / 网格地图**自己那张图（`data` = `{id, width, height, sortingOrder}`——整张铺满） |
| `SpriteLayer` | **精灵对象**自己那张图（`data` = `{id, width, height, sprite?, spriteGrid?, sortingOrder}`；后两项是 **v10 的子图**） |
| `PlaySound` | **不建可见物**：数据留在镜像里（`play_sound` 时从 `data.picked` 取播哪一条） |
| `Teleport` | **不建可见物**：数据留在镜像里（触发传送 = 编辑器换场景，整份 `scene_push`） |
| `VideoOverlay` | 运行时在**对象自己的矩形**上建视频层（见下） |
| 其余（未知类型 / 将来的新组件） | 忽略 |

**精灵（子图，v10）**：一张图可以按「行 × 列」切成格子，对象只显示其中一格。

- `sprite = { column, row }`：取第几格。**`column` 从左数（0 起）、`row` 从最上面数（0 起）**
  （对齐 Unity 的 Sprite Editor 的格子编号；与 `GridMap.rowOrder: "bottom-up"` 无关）。
- `spriteGrid = { columns, rows }`：**这一项是协议比文档多的**。切分在编辑器那边只有一份
  （工程文件的 `spriteSheets`），而前端手上没有工程文件——所以编辑器推送时把它解析进载荷
  （`resolveSceneSprites`）。前端据此算 UV，不必知道「工程文件」这个概念：
  `u0 = column / columns`、`u1 = (column + 1) / columns`、`v1 = 1 - row / rows`、
  `v0 = 1 - (row + 1) / rows`（**全链路唯一一次 y 翻转**，在 `SpriteLayer.UvRectOf`）。
- **不存像素**：矩形是上面那套**归一化除法**，图片尺寸不是行列的整数倍时两端算出来仍是同一块；
  前端把 UV 烘进面片网格的顶点（换格子 = 重建网格），面片尺寸仍由 `width/height × scale` 决定。
- 越界的格子（切分被改小之后）**在推送前已经被夹到最后一格**（协议 schema 的 `refine` 也会拒
  越界值）——所以前端拿到的 `sprite` 一定落在 `spriteGrid` 里，不必自己防。
- **地图贴图不支持子图**：编辑器不给入口，手写文件里带了也会在推送时被**摘掉**
  （`GridMap.data.image` 上不会出现这两项）。
- 老前端（协议 v9）不认这两项，会把整张图集铺出来——**画面错**，所以协议 +1，靠握手挡住。

**贴图对象 + 两种图片组件（v11，2026-09-23）**：实体下多一个「贴图」（那时 `kind: "Texture"`，
v12 起叫 `Image`）——**只显示整张图**，与精灵的差别只有「不取图集里的一格」。数据上分成两个组件：

- `ImageLayer`（**贴图**用，`data` = `{id, width, height}`）与 `SpriteLayer`（**精灵**用，
  `data` 多可选的 `sprite` + `spriteGrid`）——**形状一样、名字不同**，名字就是那条判据
  （编辑器据此决定给不给切图入口）；
- v10 及更早两者共用一个 `TextureRenderer`，老文件里精灵的那一份会被编辑器改名成 `SpriteLayer`
  （`renameSpriteImageComponent`）；
- **视频那一组换了宿主**：只有 `Map` 与 `Image`（贴图）会带 `VideoOverlay`（精灵不再带）。
  旧文件里精灵身上的 `VideoOverlay` **不会被删**（不静默改用户数据），只是编辑器不再认它；
- 老前端（v10）不认这两个新组件名 → 图取不到、对象只画一块占位色，所以协议 +1。
  `kind` 是自由字符串，`Texture` 这个新值本身不破坏兼容。

**kind 改名 + 对象类型层级（v12，2026-09-23）**：贴图 `Texture` → `Image`、精灵 `SceneObject` → `Sprite`。
后台那边 `SceneObject` 从此是**抽象基类**（精灵与贴图继承它，它自己不落进数据），
但**协议这一侧完全看不见层级**——`kind` 只是自由字符串，前端拿它取占位色：

- 载荷形状**一个字节都没动**（图片组件仍是 `SpriteLayer` / `ImageLayer`，视频仍只挂 `Map` / `Image`）；
- 老前端（v11）不认这两个值，`KindColor` 匹配不上会退回灰色占位色——**图照常显示**
  （显示走组件名），属于「不是崩，是画面错」，所以协议 +1，照旧靠握手挡住。

前端按需取用：

| `SceneObjectDoc` | 前端 |
|---|---|
| `id` | 镜像字典的 key：新 id 建对象、老 id 更新、名单里没有的销毁；场景名变了则整场景换 |
| `name` | GameObject 名字 |
| `kind` | **只用来取占位色 / 排查**（不再决定建不建可见物）。v12 起具体值是 `Sprite` / `Image` / `Map` / `Player` / `Item` / `Event` / `PlaySound` / `Teleport`；`SceneObject` 是后台的抽象基类，不会出现在载荷里 |
| `components` | **决定这个对象有什么**：`map` / `image` 这两个强类型字段由 `GridMap` / `ImageLayer` / `SpriteLayer` 填（后两个都是「对象自己那张图」，v11 起按对象类型分开）；`sound` / `video` 由 `PlaySound` / `VideoOverlay` 填 |
| `position {x,y}` | `(x, 0, y)`：文档 y 向上 → 客户端 +Z（与 `GridMap.WorldToGrid` 同口径）；`null` = 未落位 → 不建视图 |
| `active` | 是否显示（编辑器那个勾选框一改，前端就出现 / 消失） |
| `scale` | 面片尺寸 = 声明尺寸（对象自己的 `image`）× `scale` |
| `rotation` | 绕 +Y（按 `-rotation`） |
| `sortingOrder` | v14 起在渲染组件的 data 里（图片层；v16 起带网格的贴图也一样）；客户端解析时填进 `MirrorObject.sortingOrder`，再映射到 `MeshRenderer.sortingOrder` + 按序微小离地（避免共面闪烁） |
| `ImageLayer.data.id` | 资源逻辑 ID → `GET /api/resources/raw?id=…` 取纹理；没图时按 `kind` 上色占位 |
| `GridMap.data.cells` | RLE（`[[掩码, 格数], …]`）——掩码值与 `@dts/grid` 的 `CellMask` / Unity 的 `GridCellType` 完全一致 |
| `GridMap.data.fog`（v15 起改为独立的 `FogOfWar` 组件） | **战争雾**已从网格 data 拆出：v13 拆成组件、v15 又搬成独立的 `Fog` 对象（见上表 `FogOfWar`）。**老版本网格 data 里的 `fog` 前端已不再认识**；`mapId` 无效或没指定雾区时**不建那一层雾** |
| `PlaySound.data` | `{ clips, picked, layer }`：前端播的就是 `picked` 那条；`layer` ∈ `bgm/sfx/voice`（三档），同层同时只响一条。`layer: "bgm"` 的老对象前端会**明确拒掉**（背景音乐走 `play_bgm` 那一组） |
| `VideoOverlay.data` | `{ enabled, clips, picked, loop, audio }`——总开关、加进来的视频、放哪一条、循不循环、出不出视频自带的声音。收到 `play_video` 时前端在**这个对象自己的矩形**上建一层视频（`Presentation/VideoOverlay.cs`）；**关掉 `enabled` 时连那一层都不建**。`names`（显示名）**不进协议** |
| `Teleport.data` | `{ targets, picked }`。**前端不用它**：触发传送阵 = 编辑器切换当前场景 → 整份 `scene_push` 下来，前端只管换镜像 |
| `project_settings` | **项目级全局设置**（v7 起，**不在场景里**）。v8 起只有三档音量：`{ audio: { bgm: { volume }, sfx: { volume }, voice: { volume } } }`。前端**收到即生效**，不需要命令；背景音乐**恒循环** |

## 命令

| kind | 载荷 | 前端行为 |
|---|---|---|
| `play_sound` | `{ objectId, layer }` | 从**镜像里的那个对象**读 `sound.picked`，在该层播放（同层顶替）；`layer` 只能是音效 / 旁白 |
| `stop_sound` | `{ layer }` | 停掉该层 |
| `pause_sound` | `{ layer }` | **暂停**该层（v6 起；同层只响一条，所以「暂停这一层」= 暂停当前那条） |
| `resume_sound` | `{ layer }` | 从暂停处**继续**放该层（v6 起） |
| `play_bgm` | `{ clip }` | **放 / 切换到指定的那一首**（v7 起）。唯一带数据的一条命令：曲目清单不在任何对象上、也不在项目设置里——它就是项目 `Assets/audio/` 下的音频，编辑器弹框里点哪一首就说哪一首。重复放同一首 = 从头重播 |
| `pause_bgm` / `resume_bgm` / `stop_bgm` | — | 背景音乐的暂停 / 继续 / 停止（v7 起）。`pause_bgm` 赶在取音频完成之前到时，前端记下意图、加载落地后立刻补一次暂停（编辑器补发暂停态是「先放再暂停」两条连发） |
| `erase_mask` | `{ objectId, stroke: { points, radius, softness } }` | 在**镜像里那张地图**的雾层上，沿这笔**轨迹**擦出一条软边（见下） |
| `reveal_fog_region` | `{ objectId, region, revealed }`（**`objectId` = 雾对象 id**） | 含该区域位的格子**整片揭示**（`true`）/ **整片盖回**（`false`） |
| `play_video` | `{ objectId }` | 在这个对象自己的矩形上放它 `video.picked` 那一条（**命令里不带数据**：放哪条 / 循环 / 声音都从镜像里读） |
| `pause_video` | `{ objectId }` | 暂停在当前帧 |
| `resume_video` | `{ objectId }` | 从暂停处续播 |
| `stop_video` | `{ objectId }` | 停止并**拆掉那一层**（露出对象原来的贴图） |

**战争雾发的是轨迹，不是整张遮罩**（照参考实现 `backend_diceTale` 的 `erase_mask` / `EraseStroke`）：
- `points`：鼠标拖过的归一化轨迹点（`[0,1]`、**y 向下**）。前端把它翻成纹理的自下而上（`(1 - y) × 高`），
  沿线段按 `step = max(1, 半径 / 2)` 补点、两端各打一个软边擦除圆，`min` 幂等（同一处擦 N 次 = 一次）；
- `radius`：**半径 / 遮罩宽**（编辑器固定 `48/960 = 0.05`）。前端收到后乘**它自己**的遮罩宽——
  两端的遮罩是**同一张尺寸**（`apps/editor/src/services/mask-math.ts` 的 `previewMaskSizeFor`：
  960 宽、高按贴图比例推、长边超 2048 等比缩），所以两边擦出的是同一片纹素；
- `softness`：软边带比例（0 = 硬边、1 = 全程衰减），编辑器固定 `1`；
- 拖动中是**分批**发的（编辑器攒够几个点或过一会儿发一批），每批都是同一笔轨迹的一段。

**传送阵不在这里**：它没有自己的命令。触发传送阵 = 编辑器**切换当前场景** → 走上面那条 `scene_push`
（全量、立刻推）→ 前端按新场景名换整份镜像。少一条命令不是遗漏，而是「后台是唯一真源」的直接结果。

**实现进度**：命令链路（转发 / 回执 / 超时 / 日志）已通，战争雾两条命令**前后端都已实现**
（编辑器 Mask 窗口擦除 / 整区开关 → 前端雾层；前端进程不重启的话揭示状态会留着，重开 Unity 回到未探索，
编辑器在同一次运行里会把记下的轨迹补发一遍）。
**声音（v7 起）也真的出声了**：前端按逻辑 ID 取音频（本地资源包优先、回落 `/api/resources/raw`），
三条通道（背景音乐 / 音效 / 旁白）各一个 `AudioSource`，音量来自全局设置、背景音乐恒循环；
取音频是异步的，所以回执在**加载完成后**发（成功报「正在播放 X」、失败报拿不到的原因）。
**视频四条命令也已经实现**（v5）：前端按 URL 放本地资源包 / 服务端里的那份视频，画面盖在对象
自己的矩形上；解码失败只在 Unity 控制台报（回执是同步的，协议里没有「晚到的失败」这条通道）。

## 客户端实现位置（`client/`）

| 文件 | 职责 |
|---|---|
| `Data/SceneModel.cs` | 镜像模型（与 `SceneDoc` 同构）+ `MirrorSettings`（项目级全局设置） |
| `Data/SceneParser.cs` + `Data/SettingsParser.cs` + `Data/JsonParser.cs` + `Data/GridRle.cs` | 解析场景 / 设置 / RLE 解码（JsonUtility 读不了嵌套数组） |
| `Network/Protocol.cs` | 协议常量、出站 DTO、`ws://…/client` → `http://…` 推导 |
| `Network/ServerConnection.cs` | WS 连接（未开闸时握手被拒 = 正常现象，只提示一次并重试） |
| `Network/ClientSession.cs` | 握手 / 心跳 / 把消息变成事件 |
| `Logic/SceneMirror.cs` | 按 id 增 / 改 / 删视图 |
| `Logic/CommandRouter.cs` | 命令 → 动作 → 回执（声音类命令的回执在音频加载完成后发） |
| `Presentation/AudioPlayerManager.cs` | 三条音频通道（背景音乐恒循环 / 音效一次性 / 旁白+字幕），音量来自全局设置；`StopAll` 在会话结束时停掉一切 |
| `Presentation/AudioClipLoader.cs` | 按逻辑 ID 取音频（本地资源包优先、回落服务端；带缓存 / 去重 / 失败记忆） |
| `Presentation/SceneObjectView.cs` | 一个对象一块贴地面片（位置 / 缩放 / 激活 / 显示顺序 / 取图）；**战争雾对象（v15）不建面片**，只挂 `FogOfWar`（它的雾面片是 `FogOverlay` 子物体） |
| `Presentation/GridMapView.cs` | `GridMap` 组件的数据座位（v28 起网格是贴图上的可选组件）：只存 `MirrorMap`，网格线以后画在这里 |
| `Presentation/FogOfWar.cs` | 战争雾层：挂在**独立的雾对象**上，按 `mapId` 找到被引用的**带网格的贴图**，用它 `regions` + 那个对象的 `cells` 生成像素遮罩（与编辑器预览同一张尺寸），按 `erase_mask` / `reveal_fog_region` 揭示；揭示状态留在组件里，数据变了「重填 + 重放」 |
| `Presentation/VideoOverlay.cs` | 视频层：按 URL 放（本地资源包优先、否则服务端原始字节），与宿主对象共享位置 / 尺寸 / sortingOrder；首帧就绪后隐藏宿主 Renderer，停止或解码失败时恢复 |
| `Presentation/ResourceImageLoader.cs` | 按逻辑 ID 取图（带缓存 / 去重 / 失败记忆） |
