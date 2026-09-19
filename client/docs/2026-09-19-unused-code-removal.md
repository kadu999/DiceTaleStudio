# 客户端无用代码删除清单（2026-09-19）

> 状态：**已执行（2026-09-19）**。本文件只做「删什么、怎么删、怎么验」，不含新功能设计。
> 执行结果、验证证据与遗留状态见第 14 节；D1（场景数据载体）按推荐**未动**，7 个旧场景预置体
> 因此留着 Missing Script，清单在第 14.3 节。
> 数据方向已反转：以前是**前端把数据上报给后台**（对象 / 玩家 / 位置 / 输入配置，
> 后台再按 `objectId` 下发 `set_option` 这类命令）；现在是**后台给前端数据，前端只做显示与播放效果**。
> 因此「前端拥有数据、动作与条件」的那一整层、以及**整个旧协议层**都没有存在意义了。
> 已确认：**协议整层删掉，后面按新方向重新定义**（客户端只留 WebSocket 传输骨架）。

## 0. 怎么用这份文档

每条结论只有四种，读完就照着做：

| 结论 | 含义 |
|---|---|
| **A 删除** | 与数据方向直接冲突，或零引用的死代码；按第 10 节的批次直接删 |
| **B 保留** | 显示 / 播放 / 传输 / 工具，原地不动 |
| **C 保留但必须改** | 它引用了 A 类，不改就编译不过；第 6 节逐条写了改法 |
| **D 待拍板** | 依赖新方向的设计选择（场景载体、角色 UI、输入是否上行…），第 7 节给了推荐 |

**A / C 做完、D 拍完，客户端就该是「编译 0 错误、旧模型零残留」的干净状态**，之后才开发新功能。

## 1. 判定规则

1. 只要一个东西的**存在目的是「让前端把数据交给后台」**（上报、注册、按 id 寻址、本地动作条件链），
   它就是 A 类——新方向里后台才是数据的主人。
2. 只做**渲染 / 播放 / 采样 / 窗口管理**的，是 B 类；即使它现在没有调用方（新的协议来了才会有），
   也保留（例如 `AudioPlayerManager` 的四层声道正好对应将来的分层声音命令）。
3. **协议层整体算 A 类**（消息类 + 命令分派），不做「留一半」——新协议一步到位重新定义，
   半留半删只会让下一个读代码的人分不清哪条还用。
4. 测试文件跟着被测对象走：被测对象进 A，测试就进 A；测例断言的是已被注释掉的生产行为，也进 A。
5. 资源（prefab / `.bytes` / shader / 材质）单独处理：它们**不随脚本一起无脑删**，
   见第 7 节 D1 / D2 / D5。

## 2. 已核对的事实（证据）

以下都是在仓库里现查的，不是推断：

| 事实 | 证据 |
|---|---|
| 新方向在客户端**一行都没实现** | 全 `client/Assets` 搜 `play_sound\|stop_sound\|command_result\|invoke_action\|register_actions` → 0 命中 |
| 旧模型确实是「前端拥有数据 + 上报 + 后台按 id 寻址」 | `BackendRegistry.ReportAll()` 发 `register_map_objects` / `register_players` / `report_input_config`；`BackendObject.ReportPosition()` 发 `report_*_position`；`ServerObjectInfo.componentData` 由各组件 `AppendToInfo()` 填；`ServerCommandDispatcher` 收下行命令后按 `ObjectId` 找枢纽再路由给组件 |
| 服务端自己已经把旧路判为「待收敛」 | `server/README.md`：`register_*` / `invoke_action` / `action_result` 属老模型，后续协议重构会收敛掉；声音那套（数据在后台）留下 |
| 录制/回放的后端**不存在** | `ReplayClient` 请求 `/replay/sessions*`；新后端 `server/apps/backend/src/http/server.ts` 的 route switch 只有 `/api/*`，没有 `/replay` |
| 网格编辑**已经搬到服务端 Web 编辑器** | `server/apps/editor` + `server/packages/grid`（RLE、位掩码、.bytes 编解码齐备）；客户端 `Editor/GridMapEditor*.cs` 仍在写 `Assets/DiceTale/Resources/Scenes/*.bytes` |
| `client/` **完全没有进 git** | `git status` → `?? client/`（`client/.gitignore` 已忽略 `Library/Temp/Logs/UserSettings/*.csproj/*.sln`）。**删除不可回滚**，见第 9 节 |
| Unity **此刻正在运行**（3 个 `Unity` 进程） | 项目版本 `6000.3.19f1`（`client/ProjectSettings/ProjectVersion.txt`），本机有同版本 Editor：`C:\Program Files\Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe` |
| 已经存在的死代码 | `Core/IInteractable.cs` 全工程零引用；`Effects/BurningRoom.cs` 无任何脚本/资产引用；`Core/DevicePipeInputSource.cs`（压板 v1）只被单测引用（生产走 `DevicePipeInputSource2`） |
| 已经烂掉的东西 | `Map/SceneState.cs` 是**双重编码**（UTF-8 文件里又套了一层 GBK 误读；逐字节验证过，`E9 8D A6` 解出来是 `鍦`）。恢复办法：按 UTF-8 读成字符串 → 按 GB18030 取回字节 → 再按 UTF-8 解码。它属 A5，本来就要删，不必修；`DevicePipeInputSourceTests.HostedGame_ReplacesSimulatedInputAndDisablesKeyboardDebugUi` 断言 `DiceTaleHostedGame.ConfigureInput` 生效，而该方法体早被整段注释——测试早就不是真的了 |
| 两个模块与本层无关 | `client/Assets/ProjectionAlignment/**` 搜 `DiceTale\.` → 0 命中（依赖是单向的：DiceTale → ProjectionAlignment）；`client/Assets/DMGameLibrary/**` 只有一个 `InputManager.PointerSuspended` 依赖 |

规模基线：`client/Assets/DiceTale/Scripts` 共 **93 个 .cs / 约 13738 行**。

## 3. 结论总览

| 组 | 内容 | 文件 | 行数 |
|---|---|---|---|
| A1 | 协议整层 | 2 | 390 |
| A2 | 旧上行注册层（Backend 枢纽） | 4 | 446 |
| A3 | 旧「客户端拥有数据/动作/条件」模型 | 23 | 1926 |
| A4 | 依赖旧模型的触发链与动作编辑器 | 7 | 1005 |
| A5 | 旧客户端场景 / 角色权威逻辑 | 11 | 1048 |
| A6 | Unity 侧网格编辑工具 | 5 | 977 |
| A7 | 录制 / 回放（后端接口不存在） | 5 | 821 |
| A8 | 纯死代码 | 3 | 782 |
| A9 | 旧协议单测 | 1 | 136 |
| **A 合计** | **删除** | **61** | **7531** |
| C | 保留但必须改到能编译 | 7 | — |
| B | 保留（其中 4 个需按 C 改） | 27 | — |
| D | 待拍板（D1 场景载体 / D2 角色 UI 与预置体 / D3 输入与指挥光圈 / D4 录制回放 / D5 shader 材质） | — | — |

## 4. A 类：删除清单（61 个文件 / 7531 行）

路径均相对 `client/Assets/DiceTale/Scripts/`。每行的「依据」列就是判定理由
（数据方向反了 / 零引用 / 后端不存在 / 随被测对象删除），四类理由互不重叠。

### A1 协议整层（2 个 / 390 行）——**本轮确认整删**

| 文件 | 行 | 用途 | 引用者 | 依据 |
|---|---|---|---|---|
| `Server/NetworkMessage.cs` | 139 | 客户端→服务端消息类：`RequestJoinMessage`、`HeartbeatMessage`、`RegisterMapObjectsMessage`、`SpawnInfo`、`SceneStateInfo`、`ServerObjectInfo`、`ComponentData`、`RegisterPlayersMessage`、`PlayerInfo`、`ReportPlayerPositionMessage`、`ReportObjectPositionMessage`、`RequestTeleportMessage`、`ReportInputConfigMessage`、`RequestCharacterCardsMessage`、`SetSceneStateMessage`、`Position` | `ServerConnection.SendJoin/心跳`、`BackendRegistry`、`BackendObject`、`BackendComponent`、`ServerCommandDispatcher`、`Editor/Tests/ServerConnectionTests` | 协议整层重定义（已拍板），不做「留 join/heartbeat」 |
| `Server/ServerCommandDispatcher.cs` | 251 | 解析下行命令（`set_option`/`set_object_items`/`set_mask_image`/`erase_mask`/`set_float`/`set_int`/`set_bool`/`set_scene_state`/`start_recording`/`stop_recording`/`set_input_config`/`teleport_player`/`set_map`/`sync_state`/`character_cards`）并按 `ObjectId` 找枢纽路由 | `BackendManager.Awake`（`connection.OnMessage += dispatcher.Dispatch`） | 命令分派就是旧协议本体 |

### A2 旧上行注册层（4 个 / 446 行）

| 文件 | 行 | 用途 | 引用者 | 依据 |
|---|---|---|---|---|
| `Backend/BackendRegistry.cs` | 125 | 收集场景里所有 `BackendObject`，连上/切图/增删时全量上报（物体、玩家、输入配置、位置） | `GameSceneManager.Start/OnDisable/SwitchSceneCore`、`BackendObject.OnEnable/OnDisable`、`ItemExchange.RefreshAllQuantities` | 纯上行汇总器 |
| `Backend/BackendObject.cs` | 268 | 对象枢纽：对象 ID、显示名、类型、组件聚合上报、命令路由、世界→归一化坐标、`ReportPosition` | `GameSceneManager`、`CharacterManager`、`FogOfWar`、`PlayerSwitcherUI`、`GameScene`、各组件与动作 | 前端拥有对象身份并上报 |
| `Backend/BackendObjectKind.cs` | 18 | 对象类型枚举（`SceneObject`/`Player`/`Item`/`Event`），只为 GM 页面分类与上报 | `BackendObject`、`CharacterManager` | 随上报层一起消失；新对象类型等新模型再定义 |
| `Backend/BackendCapabilities.cs` | 35 | `IBackendComponentData`（数据上报）+ `IBackendCommandHandler`（命令处理）两个接口 | `BackendComponent` 基类 | 旧组件契约 |

### A3 旧「客户端拥有数据 / 动作 / 条件」模型（23 个 / 1926 行）

`Backend/Actions/`（13 个 / 724 行）——客户端本地动作链，全部挂在 `BackendComponent.actions` 上、
由组件 `NotifyChanged()` 触发（脚本 `Scene000/002/003`、`Map001/002/003` 的 prefab 里挂了一堆）：

| 文件 | 行 | 用途 |
|---|---|---|
| `Actions/BackendChangeAction.cs` | 36 | 变更动作抽象基类（`triggerOnce`、`Execute`） |
| `Actions/ConditionalBackendChangeAction.cs` | 57 | 带条件的动作基类（`ExecuteIgnoringCondition`） |
| `Actions/ComponentCondition.cs` | 124 | 组件条件（Bool/String/Number/Integer + Equal/NotEqual/AtLeast/AtMost） |
| `Actions/CallbackAction.cs` | 32 | 触发时执行 Inspector 里配的 UnityEvent 回调 |
| `Actions/ShowAction.cs` | 25 | 显示目标 |
| `Actions/HideAction.cs` | 25 | 隐藏目标 |
| `Actions/ShowHideAction.cs` | 36 | 按条件显隐 |
| `Actions/FlashAction.cs` | 39 | 闪烁 |
| `Actions/PlayAudioAction.cs` | 98 | 播放音频 |
| `Actions/PlayDialogueAction.cs` | 36 | 播放对白（带字幕） |
| `Actions/PlayVideoAction.cs` | 75 | 播放视频 |
| `Actions/TeleportAction.cs` | 78 | 传送玩家到标记 |
| `Actions/TeleportZoneAction.cs` | 63 | 区域进入即传送 |

`Backend/Components/`（10 个 / 1202 行）——客户端本地“组件数据”，上报给后台并被后台命令修改：

| 文件 | 行 | 用途 |
|---|---|---|
| `Components/BackendComponent.cs` | 155 | 能力组件基类（`ComponentId`/上报/命令/`Changed`/`Satisfies`） |
| `Components/OptionValue.cs` | 146 | 选项值（`set_option` 目标） |
| `Components/Backpack.cs` | 110 | 背包（`set_object_items` 目标） |
| `Components/AttributeList.cs` | 182 | 属性表（`set_int` 带 key 时走它） |
| `Components/ItemExchange.cs` | 92 | 场景道具货源（剩余数联动玩家背包） |
| `Components/MaskImage.cs` | 302 | 遮罩纹理（`set_mask_image` / `erase_mask` 目标，`MaskEraseStamp` shader） |
| `Components/BoolValue.cs` | 49 | 布尔值 |
| `Components/IntValue.cs` | 70 | 整数值 |
| `Components/FloatValue.cs` | 64 | 浮点值 |
| `Components/ActionButton.cs` | 32 | GM 页面「触发」按钮（`trigger_button`） |

> 注意：`MaskImage` 的**渲染资产**（`MaskEraseStamp.shader` + `DiceTale_MaskEraseStamp.mat`）留在 D5，
> 只删脚本胶水——遮罩擦除是将来还要用的效果。

### A4 依赖旧模型的触发链与动作编辑器（7 个 / 1005 行）

| 文件 | 行 | 用途 | 依据 |
|---|---|---|---|
| `Map/ClickRegion.cs` | 130 | 点击区域：指针按下时执行挂载的 `BackendChangeAction[]` | 触发的是被删动作；且「点击→本地触发」在新方向里应由后台决定 |
| `Map/MultiPointRegion.cs` | 198 | 多点同时按下才触发 `BackendChangeAction[]` | 同上 |
| `Map/SurroundRegion.cs` | 376 | 目标被包围时触发 `BackendChangeAction[]`（含 `BirdWanderer` 游荡逻辑参考） | 同上 |
| `Effects/MaskObjectDisplay.cs` | 58 | 把 `MaskImage.MaskTexture` 推进渲染器材质槽 | 唯一数据源 `MaskImage` 被删 |
| `Editor/ConditionalBackendChangeActionEditor.cs` | 105 | 条件动作的 CustomEditor | 只服务于被删动作 |
| `Editor/PlayAudioActionEditor.cs` | 60 | `PlayAudioAction` 的 CustomEditor | 同上 |
| `Editor/PlayVideoActionEditor.cs` | 78 | `PlayVideoAction` 的 CustomEditor | 同上 |

> `BirdWanderer.cs` 里对 `SurroundRegion` 只有注释引用，它本身保留（见 B）。

### A5 旧客户端场景 / 角色权威逻辑（11 个 / 1048 行）

| 文件 | 行 | 用途 | 依据 |
|---|---|---|---|
| `Map/GameScene.cs` | 200 | 场景脚本基类：场景 id、默认出生点、`NextTarget`、状态列表、落位点解析、背景音乐 | 场景配置与流程是客户端权威数据 |
| `Map/SceneState.cs` | 14 | 场景状态标记（GM 页状态按钮） | 只为上报状态列表；文件是双重编码（UTF-8 套 GBK 误读），本来就要删、不必修 |
| `Map/Game000.cs` | 271 | Scene000 角色创建流程（人数选择 UI → 创建玩家 → 视频播完 → 进下一场景） | 客户端权威流程 |
| `Map/Game001.cs` | 15 | Scene001 场景脚本（下一目标 Scene002） | 同上 |
| `Map/Game002.cs` | 15 | Scene002 场景脚本 | 同上 |
| `Map/Game003.cs` | 13 | Scene003 场景脚本（终点） | 同上 |
| `Core/SceneFlowCommandList.cs` | 83 | 流程命令列表（`CreatePlayersCommand` / `LoadSceneCommand`，`[SerializeReference]` 配在场景里） | 客户端权威流程，且 `CreatePlayersCommand` 依赖被删的 `CharacterManager` |
| `Characters/CharacterManager.cs` | 250 | 角色卡缓存 + 玩家主体管理（`Players`/`CurrentPlayer`/`CreatePlayers`/取色板） | 玩家是客户端创建的本地实体 |
| `Characters/PlayerStats.cs` | 33 | 玩家显示名 / 职称 | 被 `BackendObject.GmDisplayName` 上报使用 |
| `Characters/PlayerMover.cs` | 84 | 单个玩家的移动/路径执行 | 本地移动落点来自点击 |
| `Characters/PlayerMoveManager.cs` | 70 | 玩家移动管理（`MovePlayerTo`，由 `InputManager` 调用） | 本地输入直接驱动游戏逻辑 |

### A6 Unity 侧网格编辑工具（5 个 / 977 行）

| 文件 | 行 | 用途 | 依据 |
|---|---|---|---|
| `Editor/GridMapEditorWindow.cs` | 126 | `DiceTale/GridMap Editor` 窗口 | 网格编辑已是服务端 Web 编辑器的职责 |
| `Editor/GridMapEditorState.cs` | 405 | 编辑器状态 + `.bytes` 读写 + 撤销 | 同上；它写的是 `Resources/Scenes/*.bytes` |
| `Editor/GridMapEditorRenderer.cs` | 178 | 编辑器画布渲染 | 同上 |
| `Editor/GridMapEditorConstants.cs` | 12 | 常量（`DataDirectory = Assets/DiceTale/Resources/Scenes`） | 同上 |
| `Editor/Tests/GridMapEditorStateTests.cs` | 256 | 上面的单测（还会往仓库写 `TestMap/OverlapTestMap`） | 随被测对象删除 |

### A7 录制 / 回放（5 个 / 821 行）

| 文件 | 行 | 用途 | 依据 |
|---|---|---|---|
| `Core/RecordingManager.cs` | 321 | GM `start_recording`/`stop_recording` 驱动录音，一段一个 WAV；内含 `WavEncoder` | 命令来自被删协议；音频要传给不存在的 `/replay` |
| `Core/ReplayClient.cs` | 251 | POST `/replay/sessions`、上传分段、触发小说生成、拿 `replay.html` | 后端没有 `/replay` 路由 |
| `Editor/Tests/WavEncoderTests.cs` | 98 | `WavEncoder` 单测 | 随 `RecordingManager` 删除 |
| `Editor/Tests/RecordingFormatTests.cs` | 82 | 录音格式（16k/单声道/16bit）单测 | 同上 |
| `Editor/Tests/RecordingLayoutTests.cs` | 69 | 录音目录/命名单测 | 同上 |

配套资源 `Assets/DiceTale/Resources/Replay/游戏剧本.md`（17.9 KB）同属这条链路，去留见第 7 节 D4。

### A8 纯死代码（3 个 / 782 行）

| 文件 | 行 | 用途 | 依据 |
|---|---|---|---|
| `Core/IInteractable.cs` | 7 | 一个空接口 | 全工程零引用（仅自身声明） |
| `Core/DevicePipeInputSource.cs` | 88 | 压板输入源 **v1**（全触点顺序编号） | 生产走 `DevicePipeInputSource2`（`InputManager.CreateSource` 只造 v1 之外的两种）；只有单测用它 |
| `Effects/BurningRoom.cs` | 687 | 房间燃烧特效（自建 mesh/材质/粒子；焦痕贴图先找 `Assets/DiceTale/Resources/BurningRoom_Char.png`，该文件不存在，代码会回退到程序化生成） | 无任何脚本或 prefab/scene 引用（GUID 扫描为 0） |

> `BurningRoom` 是**特效**，逻辑上属 B；但它零引用（焦痕贴图本来就有程序化回退），删掉最省事。
> 若将来要用这套燃烧效果，从快照提交里捞回来即可。

### A9 旧协议单测（1 个 / 136 行）

| 文件 | 行 | 用途 | 依据 |
|---|---|---|---|
| `Editor/Tests/ServerConnectionTests.cs` | 136 | 断言 `RegisterMapObjectsMessage` / `ServerObjectInfo` / `ComponentData` 的 JSON 形状 | 被测的消息类整层删除 |

## 5. B 类：保留（27 个 .cs，其中 4 个另需按第 6 节改；`ProjectionAlignment/**` 整体不动）

> 下表标了「（需按 Cx）」的 4 个文件是保留但要改的，其余属「原地不动」。

| 分组 | 文件 | 保留理由 |
|---|---|---|
| 传输骨架 | `Server/ServerConnection.cs`（**需按 C1 剥协议**） | WebSocket 连接 / 重连 / 接收队列 / 单帧限额分发 / `Send<T>` / `OnMessage`；连接与字节收发跟数据方向无关 |
| 传输工具 | `Server/JsonParser.cs` | 通用 JSON 解析（新协议要复用；暂零调用方是**刻意的**）。若新协议改用 `JsonUtility`/Newtonsoft，可连同删除 |
| 连接装配 | `Backend/BackendManager.cs`（**需按 C2 精简**） | `useServer`/`serverUrl` 与 `ServerConnection` 的创建；删掉 dispatcher 装配 |
| 声音 | `Core/AudioPlayerManager.cs` | 分层播放（默认 4 层，每层顶替）正是将来分层声音命令要的效果层；`SubtitleWindow` 联动 |
| 视频 | `Core/SmartVideoPlayer.cs` | 播放/结束回调/淡入淡出；对 `StartSceneUI` 只有注释提及，无代码依赖 |
| 贴地面片 | `Core/GroundSpriteRenderer.cs` | `DiceTale/GroundSprite` 地面渲染；对 `FogOfWar`/`PlayerSelectionRing` 只有注释提及 |
| 地图与雾 | `Map/GridMap.cs`、`Map/GridCellType.cs`、`Map/FogOfWar.cs`（**需按 C6 摘玩家揭示**）、`Map/DynamicObstacle.cs` | 网格/位掩码/雾渲染/动态阻挡是显示层；`.bytes` 载体的存废见 D1 |
| 标记与装饰 | `Map/MapMarker.cs`、`Map/BirdWanderer.cs` | 位置标记（传送落点）与装饰游荡动画 |
| 拍照点光 | `Effects/PhotoClickGlow.cs` | 拍照指针点地时的点光；触发点在 `InputManager` 的按下循环里，C5 保留该调用 |
| 输入 | `Core/InputSource.cs`、`Core/DevicePipeInputSource2.cs`、`Core/SimulatedTouchInputSource.cs`、`Core/InputManager.cs`（**需按 C5 摘游戏逻辑**）、`Core/InputConfigPrefs.cs`、`Core/SimulatedTouchDebugUI.cs` | 设备采样（压板 / 模拟触摸）与输入帧抽象跟数据方向无关；`CommandId` 的本地持久化保留 |
| UI 外壳 | `UI/UIManager.cs`、`UI/UIWindow.cs`、`UI/SceneFadeUI.cs`、`UI/SubtitleWindow.cs` | 窗口管理 / 注册 / 淡入淡出 / 字幕；新 UI 还建在它们上面 |
| 编辑器小工具 | `Editor/GroundSpriteRendererMenu.cs`、`Editor/SetupMaps.cs` | 前者给 `GroundSpriteRenderer` 加菜单入口，后者一次性建 `Demo.unity` 的宿主物体 |
| 宿主接口 | `DMGameLibrary/Scripts/IDMHostedGame.cs`、`DMGameLibrary/Scripts/Hosting/DiceTaleHostedGame.cs` | 投影装置托管约定（只用 `InputManager.PointerSuspended`） |
| 独立模块 | `ProjectionAlignment/**`（含 Editor 与 Tests） | 与本层零耦合，**整体不在清理范围** |

## 6. C 类：保留但必须改到「还能编译」（7 个文件）

按依赖顺序改，否则编译错误会互相掩盖。

| # | 文件 | 改什么 | 为什么必须改 |
|---|---|---|---|
| C1 | `Server/ServerConnection.cs` | 删 `SendJoin()`、它在 `Connect()` 里的调用、`HeartbeatCoroutine()`、`HeartbeatInterval` 常量、`StartCoroutine(HeartbeatCoroutine(gen))`；类注释改成「纯传输骨架」。**保留**：`Connect/Close`、`ReceiveLoop`/`ReceiveOneMessage`、`pendingMessages`、`Update` 的单帧 64 条限额、`Send<T>`、`OnMessage`、代次（generation）防串台、自动重连 | 消息类整层删除；`Send<T>` 暂时没有调用方，这是刻意的 |
| C2 | `Backend/BackendManager.cs` | 删 `dispatcher` 字段、`AddComponent<Server.ServerCommandDispatcher>()`、`connection.OnMessage += dispatcher.Dispatch` 与 `OnDestroy` 里的退订；只留 `useServer`/`serverUrl` 与连接创建 | `ServerCommandDispatcher` 删除 |
| C3 | `Core/Game.cs` | 删 `CharacterManager`、`BackendRegistry`、`PlayerMoveManager`、`RecordingManager`、`ReplayClient` 的属性与 `Awake` 初始化；**保留** `InputManager`、`GameSceneManager`、`BackendManager`、`UIManager`、`AudioPlayerManager`、`PhotoClickGlow`、`ServerConnection` 入口 | 被删的管理器不再存在 |
| C4 | `Map/GameSceneManager.cs` | 删 `Start()` 里三个 `OnConnected` 订阅与 `OnDisable` 退订、`ReportPlayerPositions()`、`SwitchSceneCore()` 里的 `BackendRegistry.ReportAll()`、`ApplyPendingTeleports()`/`MovePlayersToSpawn()`/`TeleportPlayerToPosition()` 里的 `ReportPosition()`、`GetNormalizedPosition()`（返回 `Server.Position`）、`FillSpawnPoints()`、`FillSceneStates()`、`IsFromOtherScene()`；`PendingTeleport.Player` 从 `BackendObject` 改成 `Transform`（或随传送逻辑一起简化）。**保留**：加载/卸载/淡入淡出/落位骨架（场景载体形态见 D1） | 它引用了 `BackendRegistry`/`BackendObject`/`Server.Position`/`GameScene`/`SceneState` |
| C5 | `Core/InputManager.cs` | 删 `Update()` 里 `ClickRegion.HandleClick(pressWorld, pointerPress.Id)`、`pointerPress.Id.ToPlayerIndex()` 与 `game.PlayerMoveManager.MovePlayerTo(...)` 分支；**保留**采样、UI 豁免（`IsPointerOverUI`）、`game.PhotoClickGlow.ShowAt(pressWorld)`（纯显示）、静态快照（`PressedWorldPositions`/`PressedPressures`/`PressedScreenPositions`/`PressedIds`/`IsRightMouseHeld`）——`FogOfWar` 等还要读 | `ClickRegion`/`PlayerMoveManager` 删除 |
| C6 | `Map/FogOfWar.cs` | 删 `TickPlayerReveal()`、`CheckPlayerFogArea()`、`GetPlayerGridType(BackendObject)` 与 `Update()` 里的调用，以及只服务于它们的 `checkInterval`/`checkTimer`/`revealedAreas`；**保留** `BuildFog`/模糊链/右键擦除（右键擦除是自包含的本地调试工具） | 它读 `Game.Instance.CharacterManager.Players`（删除）与 `BackendObject` 参数 |
| C7 | `Editor/Tests/DevicePipeInputSourceTests.cs` | `SetUp()` 里的 `new DevicePipeInputSource { … }` 改成 `new DevicePipeInputSource2 { … }`（字段 `ProjectionTouchscreen`/`LogDiagnostics` 同名兼容）；删掉 `HostedGame_ReplacesSimulatedInputAndDisablesKeyboardDebugUi`（断言的是已被注释掉的生产行为）；其余用例保留 | v1 删除；且该测例早已失效 |

> 顺带记录（**不改**）：`Editor/GroundSpriteRendererMenu.cs`、`Editor/SetupMaps.cs`、
> `UI/*`、`DMGameLibrary/Hosting/DiceTaleHostedGame.cs` 都对被删类型只有注释级引用或没有引用，编译不受影响。

## 7. 序列化资产影响 + 待拍板事项（D）

### 7.1 会被删脚本打到 Missing Script 的资产（GUID 扫描结果）

| 资产 | 挂在它上面的脚本（标「(留)」的是保留的，其余随 A 类删除；「+ 保留的若干」= 还有一批保留脚本没逐一列出） |
|---|---|
| `Resources/Scenes/Map001.prefab` | `OptionValue`×2、`BackendObject`×3、`ShowHideAction`×2、`TeleportAction`、`DynamicObstacle`(留)、`GridMap`(留)、`FogOfWar`(留)、`SmartVideoPlayer`(留)、`GroundSpriteRenderer`(留)、`MapMarker`(留) |
| `Resources/Scenes/Map002.prefab` | `OptionValue`×2、`BackendObject`×3、`ShowHideAction`、`TeleportAction`、`PlayAudioAction`、`MaskImage`、`MaskObjectDisplay`（+ 保留的若干） |
| `Resources/Scenes/Map003.prefab` | `OptionValue`、`BackendObject`×2、`PlayVideoAction`×6（+ 保留的若干） |
| `Resources/Scenes/Scene000.prefab` | `BackendObject`×2、`PlayDialogueAction`、`CallbackAction`、`PlayVideoAction`、`Game000`（+ 保留的若干） |
| `Resources/Scenes/Scene001.prefab` | `Game001` |
| `Resources/Scenes/Scene002.prefab` | `OptionValue`×2、`BackendObject`×5、`BoolValue`、`ShowAction`×2、`HideAction`、`ShowHideAction`、`PlayDialogueAction`×10、`FlashAction`×4、`ClickRegion`×4、`Game002`、`SurroundRegion`、`MultiPointRegion`（+ 保留的若干） |
| `Resources/Scenes/Scene003.prefab` | `OptionValue`、`BackendObject`、`PlayDialogueAction`×2、`Game003`（+ 保留的若干） |
| `Resources/Player.prefab` | `BackendObject`、`PlayerStats`、`AttributeList`、`Backpack`、`PlayerSelectionRing`(二选一文件) |
| `Resources/PlayerPanel.prefab` | `PlayerSwitcherUI` |
| `Resources/StartSceneUI.prefab` | `StartSceneUI` |
| `DiceTale/Scenes/Demo.unity` | 只挂了 `Game`（保留）与 `SimulatedTouchDebugUI`（保留）→ **安全** |
| `Resources/Scenes/{Map001,Map002,Map003}.bytes` | 旧网格数据：运行时由 `GridMap.LoadData()`（`Resources.Load<TextAsset>("Scenes/<地图名>")`）读取，编辑由被删的 Unity 编辑器工具写入 → 存废见 D1 |
| `Resources/Scenes/{TestMap,OverlapTestMap}.bytes` | 被删的 `GridMapEditorStateTests` 留下的测试数据（孤儿，可删；注意别把测试跑出来的新文件又提交进去） |
| `Resources/Scenes/scenes.json` | 旧场景注册表：**全工程（客户端 + 服务端）没有任何代码读它**（`.cs` 里只有 `Resources.Load("Scenes/" + 场景名)` 的 prefab/.bytes 路径）→ 孤儿资产，可直接删 |
| `Resources/Replay/游戏剧本.md` | `ReplayClient` 的剧本注入源 |

### 7.2 D 待拍板（每条都给了推荐；**D2 / D3 / D4 / D5 已按推荐执行，D1 仍未决**——见第 14 节）

| # | 问题 | 推荐 | 影响面 |
|---|---|---|---|
| **D1** | 场景数据载体：继续「`Resources/Scenes/*.prefab` + `.bytes`」（`server/README.md` 说 `.bytes` 导出是后续里程碑），还是改成「后台下发场景 JSON、客户端运行时搭场景」？ | **先只决定渲染侧**：保留 `GridMap`/`FogOfWar`/`GroundSpriteRenderer`/`DynamicObstacle`，删掉旧场景脚本；载体等新功能设计时再定 | `Resources/Scenes/*.prefab`、`Resources/Scenes/*.bytes`、`GameSceneManager.CreateSceneGameObject`、`GridMap.LoadData` |
| **D2** | 旧角色/面板 UI 与预置体：`UI/PlayerSwitcherUI.cs`、`UI/StartSceneUI.cs`、`Editor/PlayerPanelStructureBuilder.cs`、`PlayerPanel.prefab`、`StartSceneUI.prefab`、`Player.prefab`、`RealMap.prefab`、`Resources/Characters/*.prefab` —— 它们的数据全部来自被删组件 | **脚本 + 预置体一起删**（先做第 9 节的快照提交，需要时 `git show` 捞回）。只留预置体会变成一堆 Missing Script，比删掉更脏 | 这 2 个脚本是「保留就得重写」的，属**执行前必须解决**的二选一 |
| **D3** | 本地输入是否上报后台：`Core/InputManager.cs` 只留采样（C5），那 `Characters/PlayerSelectionRing.cs`（指挥光圈，读 `CharacterManager.Players` + `DevicePipeInputSource2.CommandId`）怎么办？ | **先删**（同样从快照恢复）。它是显示件，但「哪个棋子是当前玩家」的数据来源属于新方向要定义的东西 | `Characters/PlayerSelectionRing.cs` 也是**执行前必须解决**的二选一（不删就得写 stub） |
| **D4** | 录制/回放是否保留？ | **先删**（后端没有 `/replay`，留着只会继续腐烂）。新服务端补了回放接口后按新接口重写 | `RecordingManager`/`ReplayClient` + 3 个测试 + `Resources/Replay/游戏剧本.md` |
| **D5** | 配套 shader / 材质 | **保留** `MaskEraseStamp.shader` + `DiceTale_MaskEraseStamp.mat`（遮罩擦除是将来要用的效果）、`BoxComposite`、`RectMask`、`SelectionRing` 等；只删脚本胶水 | 只影响「删得干不干净」，不影响编译 |

> 提醒：**D2 / D3 里的两个文件必须在执行删除前给出结论**（删，或改到能编译），
> 否则第 11 节的「编译 0 错误」验收过不去。

## 8. 服务端侧同一批旧协议（**本次不删**，登记待重新定义）

客户端新协议定下来时，服务端这些位置要一起收敛（现在**一行都不动**）：

| 位置 | 里面对应的旧东西 |
|---|---|
| `server/packages/protocol/src/messages.ts`（唯一来源） | 上行：`registerMapObjectsSchema`、`register_players`、`register_actions`、`request_teleport`、`report_player_position`、`report_object_position`；下行：`invokeActionSchema`/`actionResultSchema`、`atomicCommandSchema`（`set_option`/`set_bool`/`set_int`/`set_float`/`set_object_items`/`teleport_player`）、`sync_state`、`set_map`、`set_mask_image`、`erase_mask`；快照形状：`objectStateSchema`/`playerStateSchema`/`gameStateSchema`/`componentDataSchema`/`actionSummarySchema` |
| `server/apps/backend/src/ws/hub.ts` | 上面这些消息的路由与回执关联（`register_*`、`report_*`、`invoke_action`、`action_result`、`command_result`、`request_teleport`、`sync_state`） |
| `server/apps/backend/src/ws/run-state.ts` | 运行态快照（对象 / 玩家 / 动作清单） |
| `server/apps/backend/src/mock-client/index.ts` | 假前端：上报上述消息、回 `action_result`/`command_result` |
| `server/apps/backend/test/runtime-hub.test.ts` | 锁定上述链路的端到端测试 |
| `server/apps/editor/src/services/runtime-client.ts`、`services/sound-playback.ts`、`panels/runtime/RuntimePanel.tsx`、`state/editor-store.ts`、`services/mask-math.ts`（注释提到 `erase_mask`） | 编辑器运行态面板：镜像、触发动作、声音播放记账 |
| `play_sound`/`stop_sound`/`command_result` | 按 `server/README.md` 属**新方向**（数据在后台、前端只是播放效果），本清单**不预判去留**，等新协议一起定 |

> 为什么本轮服务端一动不动：编辑器现在靠 Mock 前端把这条链路跑通并有测试锁定
> （`pnpm test` / `pnpm e2e`）。先删服务端会把「编辑器可用」换成「两端都不能跑」，
> 而客户端的新协议还没定义。

## 9. 前置动作与风险（执行删除前先做）

1. **`client/` 先提交为快照**（当前完全未入库，删了不可回滚）：
   ```powershell
   git -C E:\WorkSpace\DiceTaleStudio add client
   git -C E:\WorkSpace\DiceTaleStudio commit -m "chore(client): 清理前快照（Unity 客户端现状）"
   ```
   `client/.gitignore` 已忽略 `Library/`（2.1 GB）、`Temp/`、`Logs/`、`UserSettings/`、`*.csproj`、`*.sln`，
   入库的只有 `Assets/`（约 14 MB）+ `Packages/` + `ProjectSettings/`。
2. **删之前关掉 Unity 编辑器**（现在有 3 个 `Unity` 进程在跑）。开着编辑器删脚本，Unity 会立刻
   在已加载的场景/预置体上留下 Missing Script，并可能把改动写回资产；同时 `Library` 锁会让
   批处理编译跑不起来。
3. **分批删、每批编译一次**（第 10 节），别一次删完再看错误——中间态无法定位。
4. **不要顺手删 `.bytes` / 预置体**：先按 D1/D2 拍板，再决定它们跟不跟着走。
5. 已知的历史遗留（**只在文档记录，不属本轮**）：
   - `client/ProjectSettings/EditorBuildSettings.asset` 里指向不存在的 `Assets/Scenes/DMGameLibrary.unity`、
     `SampleScene.unity`、`DarkwaterM0.unity`、`TableBand/...`；
   - `ProjectionAlignment/Scenes/DMGameLibraryProjection.unity` 里有一个缺失脚本
     `DMGameLibrary.Hosting.DiceTaleProjectionAdapter`（工程里没有这个类）。

## 10. 分批删除顺序 + 每批验证

| 批次 | 内容 | 删完后立刻做的检查 |
|---|---|---|
| 1 | A8 纯死代码（`IInteractable`、`DevicePipeInputSource`、`BurningRoom`） | C7 改完 `DevicePipeInputSourceTests` 的 fixture；编译 |
| 2 | A4 触发链与动作编辑器（`ClickRegion`、`MultiPointRegion`、`SurroundRegion`、`MaskObjectDisplay`、3 个 Editor） | 搜 `ClickRegion\|MultiPointRegion\|SurroundRegion\|MaskObjectDisplay` → 0；同步做 C5（`InputManager`） |
| 3 | A3 `Backend/Actions` + `Backend/Components` | 搜 `BackendChangeAction\|ComponentCondition\|BackendComponent\|OptionValue\|Backpack\|ItemExchange\|MaskImage\|AttributeList` → 只剩本文件与 D 决定保留的 |
| 4 | A2 旧上行层 + A1 协议整层（`BackendObject`/`BackendRegistry`/`BackendObjectKind`/`BackendCapabilities`/`NetworkMessage`/`ServerCommandDispatcher`） | 同步做 C1/C2/C3/C4/C6；搜 `register_map_objects\|report_player_position\|BackendRegistry\|ServerObjectInfo` → 0 |
| 5 | A5 旧场景/角色逻辑（`GameScene`、`SceneState`、`Game000..003`、`SceneFlowCommandList`、`Characters/*`） | 搜 `GameScene\|SceneState\|CharacterManager\|SceneFlowCommandList` → 0（`GameSceneManager` 的 `CurrentSceneScript` 等要在 C4 里一并摘掉） |
| 6 | A6 Unity 网格编辑工具 + A7 录制/回放 + A9 旧协议单测 | 搜 `GridMapEditor\|RecordingManager\|ReplayClient\|WavEncoder\|RegisterMapObjects` → 0 |
| 7 | 资产：D1 的 `Resources/Scenes/*.prefab` 与 `*.bytes`（存废见 D1）、孤儿资产 `Resources/Scenes/scenes.json`（无代码读取，直接删）、D2 的 UI 与角色预置体、D4 的 `Resources/Replay` | 用被删脚本的 `.cs.meta` GUID 反查 `*.prefab`/`*.unity` → 只应剩 D 明确保留的 |
| 8 | 清场：删空的 `Characters/`、`Backend/Actions/`、`Backend/Components/`、`Editor/Tests/`（若已空）目录与 `.meta`；确认没有孤儿 `.meta` | 编译 + EditMode 测试 |

每批的通用验证：

```powershell
# 1) 旧模型符号应为 0（把被删类型名逐个加进来搜）
rg -n "BackendObject|BackendChangeAction|ComponentCondition|BackendRegistry|ServerObjectInfo|RegisterMapObjects|ReportPlayerPosition|RequestJoinMessage|ServerCommandDispatcher|MaskImage|OptionValue|Backpack|ItemExchange|AttributeList" client/Assets --glob '*.cs'

# 2) 被删脚本的 GUID 不应再出现在任何资产里
#    （对每个 .cs.meta 的 guid 跑一遍，D 决定保留的资产除外）

# 3) 编译（Unity 必须已关闭）
& "C:\Program Files\Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe" -batchmode -quit `
  -projectPath "E:\WorkSpace\DiceTaleStudio\client" `
  -logFile "E:\WorkSpace\DiceTaleStudio\client\Logs\compile-check.log"
Select-String -Path "E:\WorkSpace\DiceTaleStudio\client\Logs\compile-check.log" -Pattern "error CS"

# 4) 服务端一行没动
git -C E:\WorkSpace\DiceTaleStudio status --short server
```

> 本机已确认：`rg` = `C:\Users\kadu\.kimi-code\bin\rg.exe`、`git` = 2.45.0（若 `rg` 不在 PATH 上，
> 用 `Select-String -Path (Get-ChildItem -Recurse client/Assets -Include *.cs).FullName -Pattern '...'` 等价替代）。
>
> **读中文文件务必带编码**：Windows PowerShell 5.1 里 `Get-Content 文件` 不带 `-Encoding UTF8` 会把正常 UTF-8
> 中文显示成乱码（本文档核对时就踩过一次，误判了 `scenes.json`）。判断一个文件是否真的坏了，用
> `[System.IO.File]::ReadAllBytes()` 看字节，别靠终端显示。

## 11. 验收标准

1. `client/Assets` 下搜第 10 节第 1 条里的所有符号 → **0 命中**（D2/D3 选择保留的那些除外，且必须是改过能编译的版本）。
2. Unity 编译 **0 个 `error CS`**（批处理日志，或编辑器 Console）。
3. 每个被删脚本的 GUID 在 `*.prefab`/`*.unity` 里都查不到；若有 D 决定保留的资产仍引用被删脚本，**必须在文档里登记为已知的 Missing Script 并说明处理计划**。
4. 保留的 EditMode 测试能跑（`DevicePipeInputSourceTests` 已切到 v2 并通过）；`A` 类测试文件已随被测对象删除。
5. `git status` 里 `server/` **无新增改动**（第 8 节清单本轮只登记）。
6. 目录里没有残留的空文件夹与孤儿 `.meta`。

## 12. 不在本轮范围

- 新功能：新协议定义、`play_sound`/`stop_sound`/`command_result`、场景数据下发、输入上行、玩家/角色 UI 重建、
  遮罩擦除命令接线 —— 全部留到「代码干净」之后。
- `server/` 的一切改动（第 8 节只登记）。
- `client/Assets/ProjectionAlignment/**`、`client/Assets/DMGameLibrary/**`。
- `client/Assets/Settings/**`、URP 配置、Input Actions、`Packages/manifest.json`。

## 13. 假设

1. 「协议都可以删除，后面重新再定义」= 客户端 `Server/` 下的**消息类与命令分派整体删除**，
   只留 WebSocket 传输骨架（连接、收发、重连、接收队列）。
2. 服务端旧协议本轮只登记、不执行；等客户端新协议定下来一起收敛。
3. 删除执行是**下一步**（本文件确认之后）；本文件只描述要删什么。
4. 判定以「数据方向」为准，不以「代码能不能跑」为准：能跑但方向反了的，照样删。
5. 本文件所有路径与引用关系均于 **2026-09-19** 在仓库里实查过（grep + `.cs.meta` GUID 反查）；
   执行删除时若与事实不符，以实查为准并回来改这份文档。

## 14. 执行记录（2026-09-19）

### 14.1 做了什么

| 批次 | 动作 | 备注 |
|---|---|---|
| 0 | `client/` 快照提交 | `22407c4 chore(client): 清理前快照（Unity 客户端现状）`（717 个文件）——**回滚点** |
| 1 | A8 死代码（`IInteractable`、压板 v1、`BurningRoom`）+ C7 | fixture 切到 `DevicePipeInputSource2`；删掉已失效的 `HostedGame_...` 测例与 `using DMGameLibrary.Hosting` |
| 2 | A4 触发链与动作编辑器（7 个）+ C5 | `InputManager` 只留采样 / UI 豁免 / 拍照点光 |
| 3 | A3 `Backend/Actions`（13）+ `Backend/Components`（10） | 目录清空并删除（含 `.meta`） |
| 4 | A2 旧上行层（4）+ A1 协议整层（2）+ C1/C2/C3/C4/C6 | `ServerConnection` 剥成纯传输骨架；`BackendManager` 只留连接装配；`Game` / `GameSceneManager` / `FogOfWar` 同步收敛 |
| 5 | A5 旧场景/角色逻辑（11）+ D2/D3（`PlayerSwitcherUI`、`StartSceneUI`、`PlayerPanelStructureBuilder`、`PlayerSelectionRing`） | 按 D2/D3 推荐执行（可从快照恢复） |
| 6 | A6 网格编辑工具（5）+ A7 录制/回放（5）+ A9 旧协议单测（1） | — |
| 7 | 资产：D2 的 3 个预置体、D4 的 `Resources/Replay`、孤儿 `scenes.json` / `TestMap.bytes` / `OverlapTestMap.bytes` | D1 的 `Resources/Scenes/*.prefab` 与 `Map00x.bytes` 按推荐**保留** |
| 8 | 清空目录（`Backend/Actions`、`Backend/Components`、`Characters`、`Resources/Replay`）与 4 个目录 `.meta`；清理保留下来的注释级残留引用（`UIWindow`/`UIManager`/`InputSource`/`InputManager`/`DevicePipeInputSource2`/`SimulatedTouchInputSource`/`BirdWanderer`/`GroundSpriteRenderer`/`SmartVideoPlayer`/`Game`） | — |

净结果：`DiceTale/Scripts` 从 **93 个 .cs / 13738 行** → **28 个 .cs / 4382 行**；
工作区 **148 个删除 + 15 个修改**。

### 14.2 验证

1. **符号归零**：`client/Assets/DiceTale` 下搜被删类型名 → 只剩 4 处**明确写着「已删除」的历史说明**
   （`BackendManager` / `GameSceneManager` / `FogOfWar` / `Game`），没有任何一处代码引用。
2. **编译 0 错误**：用 Unity 自己生成的工程 + .NET SDK，在同一套引用（Unity 的 `unity-4.8-api`
   + Unity/包程序集 + `NuLight.ProjectionAlignment.dll`）下编译：
   - `Assembly-CSharp`（27 个运行时脚本 + `DMGameLibrary`）→ 退出码 0，**error CS = 0**；
   - `Assembly-CSharp-Editor`（3 个编辑器脚本，含改过的 `DevicePipeInputSourceTests`）→ 退出码 0，**error CS = 0**。

   这**不等价于** Unity 自己的批处理编译；Unity 关掉后仍建议按第 10 节第 3 条跑一遍（见 14.5）。
3. **资产引用**：被删脚本的 65 个 GUID 反查 `*.prefab` / `*.unity` / `*.asset` / `*.mat`
   → 只剩 7 个旧场景预置体（见 14.3），与 7.1 表一致。

### 14.3 已知遗留（**已由用户自己解决**，见下方「后续变化」）

`Resources/Scenes/{Map001,Map002,Map003,Scene000,Scene001,Scene002,Scene003}.prefab`
当时仍挂着被删组件（Unity 会在 Inspector 里显示 Missing Script），留给 D1 拍板后二选一处理。

> **后续变化（2026-09-19，用户自己提交）**：`bbf0eb6 删除没用资源` 把这批预置体连同
> `Map001/Map002.bytes`、`Scenes.meta` 一起删了——**D1 的实际选择是「不要旧载体」**，
> 本条遗留因此清零。同一批提交里还删掉了 `Assets/ProjectionAlignment/**`（295 个文件）、
> `Assets/DMGameLibrary/**`、`Assets/DiceTale/Res/**`（音频/贴图/视频，含 Map00x.png）
> 以及 `Resources/Characters/*.prefab`；代码侧把 `DevicePipeInputSource2.Sample` 整段注释掉、
> 删掉了 `Editor/Tests/DevicePipeInputSourceTests.cs`，让工程重新可编译。
> 详情与新的目录规范见 [`client/README.md`](../../README.md) 与本文第 15 节。

与 7.1 / D2 的两处**有依据的偏差**：

- `Resources/Characters/Character001..004.prefab` 保留（7.1 表原把它列在 D2 里）：它们是纯美术的
  嵌套预置体（PrefabInstance，零脚本、零 Missing Script）——**后由用户在 `bbf0eb6` 中删除**。
- `Resources/RealMap.prefab` 保留（不含被删脚本引用）；现在位于 `DiceTale/Resources/RealMap.prefab`。
- `Server/JsonParser.cs` 保留但**暂时零调用方**（新协议要复用的通用 JSON 工具，刻意的）；
  现在位于 `DiceTale/Scripts/Networking/JsonParser.cs`。

### 14.4 复现编译验证的做法

Unity 开着、不能 `-batchmode` 抢工程目录时，可以复制 Unity 生成的工程文件到临时目录，只保留仍存在的
`Compile` 项，补上 `FrameworkPathOverride`（指 Unity 的 `unity-4.8-api`）与
`NuLight.ProjectionAlignment.dll` 引用，再 `dotnet msbuild check.csproj`：

- 运行时：`Assembly-CSharp.csproj`（保留 27 / 丢弃 52 个已删文件项）；
- 编辑器：`Assembly-CSharp-Editor.csproj`（保留 3 / 丢弃 13），并把它对 `Assembly-CSharp.dll` 的引用
  换成刚编出来的那一份（否则会拿 Unity 的旧产物，**掩盖错误**）。

### 14.5 还没做的

- **Unity 自己的批处理编译**（第 10 节第 3 条）：需要先关掉正在运行的 Unity（本机 3 个 `Unity` 进程）。
- 服务端旧协议收敛（第 8 节，只登记）。
- 死资源与停用代码的清理（用户 2026-09-19 明确要求「先不动」，见 `client/README.md` 的「当前状态」）。

## 15. 目录整理（2026-09-19，清理之后做的）

清理把「旧模型」删干净了，但目录本身还是混乱的（`Backend/` 与 `Server/` 只各剩一两个文件、
`Core/` 是个大杂烩、`Res/` 与 `Resources/` 两个名字含混、`Scripts/Editor/` 混在运行时目录里，
而且整个模块没有 asmdef）。整理分两轮，**最终形态是「数据层 / 逻辑层 / 表现层」**：

```
Assets/DiceTale/
├─ Scripts/                     DiceTale.asmdef（rootNamespace: DiceTale）
│  ├─ Data/         （3）        GridCellType · MapMarker · JsonParser
│  ├─ Logic/        （10）       Game · ServerConnection · BackendManager · InputManager ·
│  │                            InputSource · SimulatedTouchInputSource · DevicePipeInputSource2 ·
│  │                            InputConfigPrefs · GameSceneManager · DynamicObstacle
│  └─ Presentation/ （12）       GridMap · FogOfWar · BirdWanderer · GroundSpriteRenderer ·
│                               PhotoClickGlow · AudioPlayerManager · SmartVideoPlayer ·
│                               UIManager · UIWindow · SceneFadeUI · SubtitleWindow ·
│                               SimulatedTouchDebugUI
├─ Editor/                      DiceTale.Editor.asmdef（includePlatforms: [Editor]，引用 DiceTale）
├─ Resources/Shaders/           运行时按名加载，必须留在 Resources 下
├─ Resources/RealMap.prefab
├─ Materials/                   原 Res/Materials
└─ Scenes/Demo.unity
```

- **第 1 轮**：按模块规范把文件从「一个类一个目录」里解放出来（当时是
  `Core / Networking / Input / Scene / Map / Media / Rendering / Effects / UI` 九个目录），
  同时加 asmdef、把 `Scripts/Editor/` 提到模块根、`Res/Materials` 改名 `Materials`。
- **第 2 轮**（用户反馈「Media / Networking / Rendering / Map / Effects 很多是重复功能」）：
  改成 **数据层 / 逻辑层 / 表现层** 三层。9 个目录 → 3 个；
  `Map` 被拆到三层（`GridCellType`/`MapMarker` → Data，`DynamicObstacle` → Logic，
  `GridMap`/`FogOfWar`/`BirdWanderer` → Presentation），
  `Media` + `Rendering` + `Effects` + `Scene` + `UI` 全部并进 Presentation。
  分层规则、依赖方向与 4 处「逻辑层碰表现层」的既成事实，见 [`client/README.md`](../../README.md)。

### 15.1 路径对照（本文第 4~7 节里的旧写法 → 最终位置）

| 本文旧路径（相对 `client/Assets/DiceTale/`） | 最终位置 |
|---|---|
| `Scripts/Backend/BackendManager.cs` | `Scripts/Logic/BackendManager.cs` |
| `Scripts/Server/ServerConnection.cs` | `Scripts/Logic/ServerConnection.cs` |
| `Scripts/Server/JsonParser.cs` | `Scripts/Data/JsonParser.cs` |
| `Scripts/Core/Game.cs` | `Scripts/Logic/Game.cs` |
| `Scripts/Core/InputManager.cs`、`InputSource.cs`、`SimulatedTouchInputSource.cs`、`DevicePipeInputSource2.cs`、`InputConfigPrefs.cs` | `Scripts/Logic/…` |
| `Scripts/Core/SimulatedTouchDebugUI.cs` | `Scripts/Presentation/SimulatedTouchDebugUI.cs` |
| `Scripts/Core/AudioPlayerManager.cs`、`SmartVideoPlayer.cs` | `Scripts/Presentation/…` |
| `Scripts/Core/GroundSpriteRenderer.cs` | `Scripts/Presentation/GroundSpriteRenderer.cs` |
| `Scripts/Map/GameSceneManager.cs` | `Scripts/Logic/GameSceneManager.cs` |
| `Scripts/Map/GridCellType.cs`、`MapMarker.cs` | `Scripts/Data/…` |
| `Scripts/Map/DynamicObstacle.cs` | `Scripts/Logic/DynamicObstacle.cs` |
| `Scripts/Map/GridMap.cs`、`FogOfWar.cs`、`BirdWanderer.cs` | `Scripts/Presentation/…` |
| `Scripts/Effects/PhotoClickGlow.cs`、`Scripts/UI/*` | `Scripts/Presentation/…` |
| `Scripts/Editor/GroundSpriteRendererMenu.cs`、`SetupMaps.cs` | `Editor/…`（移出 `Scripts/`） |
| `Res/Materials/*.mat` | `Materials/*.mat` |
| `Resources/Shaders/*`、`Resources/RealMap.prefab` | 不变（保留 `Resources/` 一层） |
| `Scripts/Backend/`、`Scripts/Server/` 等 9 个子目录 | 删除（合并成 Data / Logic / Presentation） |

同时做掉的：`namespace DiceTale.Server` → `namespace DiceTale`（模块内单一命名空间，与 `ProjectionAlignment`
一致；`BackendManager` / `Game` 里的 `Server.ServerConnection` 一并改成 `ServerConnection`），
新增 `Scripts/DiceTale.asmdef` 与 `Editor/DiceTale.Editor.asmdef`。
**整理过程没删任何东西**（用户要求死资源与停用代码先留着）。

验证：每次重排后用 14.4 的做法重新编译，`DiceTale`（25 个运行时脚本）与 `DiceTale.Editor`（2 个）
都是 **0 error CS**；目录/文件 `.meta` 齐全、无孤儿 `.meta`；Data 层对另外两层零引用。
