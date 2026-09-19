# DiceTaleStudio / client

Unity 客户端（Unity **6000.3.19f1**）。方向已反转：**数据在后端，前端只做显示与播放效果**。
旧模型（前端上报对象 / 玩家 / 位置，后端按 id 寻址动作与组件）已整层删除，现在客户端只剩
「显示层 + 输入采集 + WebSocket 传输骨架」，**新协议在功能落地时重新定义**。
删除依据、逐文件清单与遗留说明见 [`docs/2026-09-19-unused-code-removal.md`](docs/2026-09-19-unused-code-removal.md)。

## 目录结构：数据层 / 逻辑层 / 表现层

```
Assets/
├─ DiceTale/                          ← 本客户端唯一的游戏模块
│  ├─ Scripts/                        DiceTale.asmdef（rootNamespace: DiceTale）
│  │  ├─ Data/          （2）         数据层：纯数据结构 / 枚举
│  │  │                 GridCellType.cs          网格类型位掩码（区域 / 障碍 / 雾位）
│  │  │                 MapMarker.cs             场景标记点（id + 世界坐标，落点用）
│  │  ├─ Network/       （3）         网络层：与后端通信的一切（不认识游戏逻辑，也不碰显示）
│  │  │                 ServerConnection.cs      WebSocket 连接（接收队列 / 重连，不认识协议）
│  │  │                 BackendManager.cs        连接装配
│  │  │                 JsonParser.cs            报文 JSON 解析（新协议用）
│  │  ├─ Logic/         （8）         逻辑层：输入 / 流程 / 状态，不直接画东西
│  │  │                 Game.cs                  宿主 + 组合根：装配全部管理器、交互锁
│  │  │                 InputManager.cs          消费输入帧 + 对外统一状态快照
│  │  │                 InputSource.cs           输入源抽象 / PointerId / InputFrame
│  │  │                 SimulatedTouchInputSource.cs  开发用模拟触摸源（鼠标 + 数字键）
│  │  │                 DevicePipeInputSource2.cs     压板源（**已停用**，见「当前状态」）
│  │  │                 InputConfigPrefs.cs      CommandId 的 PlayerPrefs 持久化
│  │  │                 GameSceneManager.cs      场景加载 / 卸载 / 淡入淡出
│  │  │                 DynamicObstacle.cs       运行时把物体占据的格子标成动态阻挡
│  │  └─ Presentation/  （12）        表现层：直接画 / 播 / 显示
│  │                    GridMap.cs               地图格子数据 + 网格渲染（+ .bytes 读取）
│  │                    FogOfWar.cs              战争雾（GPU 羽化 + 右键擦除）
│  │                    BirdWanderer.cs          装饰物区域随机游荡
│  │                    GroundSpriteRenderer.cs  贴地面的纹理面片
│  │                    PhotoClickGlow.cs        拍照指针点地时的点光
│  │                    AudioPlayerManager.cs    分层音频（4 层，同层顶替）+ 字幕
│  │                    SmartVideoPlayer.cs      视频播放 / 播完回调 / 淡入淡出
│  │                    UIManager.cs             唯一 Canvas + 窗口注册/开关
│  │                    UIWindow.cs              窗口基类
│  │                    SceneFadeUI.cs           全屏淡入淡出遮罩
│  │                    SubtitleWindow.cs        字幕窗口
│  │                    SimulatedTouchDebugUI.cs 触点调试圆点
│  ├─ Editor/           （2）         编辑器工具（DiceTale.Editor.asmdef）
│  │                    GroundSpriteRendererMenu.cs   菜单入口：建 GroundSpriteRenderer
│  │                    SetupMaps.cs                  一次性脚本：把 Demo 场景重建成「只有 Game 宿主」
│  ├─ Resources/                      ← **运行时按名加载的资产必须留在这里**
│  │  ├─ Shaders/                     DiceTale/*.shader（FogBlur / GroundSprite / VideoFade 在用）
│  │  └─ RealMap.prefab
│  ├─ Materials/                      材质（原 `Res/Materials`）
│  └─ Scenes/Demo.unity               唯一的场景
└─ Settings/                          URP 管线 / 质量 / Volume 设置（被 ProjectSettings 引用）
```

## 分层约定

**依赖方向：表现 → 逻辑（→ 网络）；数据不依赖任何层，各层都可以用。**

| 层 | 放什么 | 不放什么 |
|---|---|---|
| **Data** | 数据结构、枚举、可序列化模型 | 不引用另外三层（当前 Data 零外部引用） |
| **Network** | 与后端通信的一切：连接、连接装配、报文解析 | 不认识游戏逻辑、不碰显示（当前 Network 零外部代码依赖，注释里提到 `Game` 不算） |
| **Logic** | 输入消费、流程与状态驱动、运行时改数据 | 不直接操作渲染器 / Canvas / AudioSource |
| **Presentation** | 直接画 / 播 / 显示：MeshRenderer、Texture、Canvas、AudioSource、VideoPlayer、Light | 不做协议、不拥有业务状态（数据在后端） |

**客户端几乎没有自己的数据**（数据都在后端），所以 Data 现在只有「网格类型枚举 + 场景标记」两个文件
——这是对的，不是没写完。以后从后端收到的场景 / 对象 / 声音等模型，都放 `Data/`。
**网络层也一样薄**：旧协议整层删除后，它只剩「连接 + 装配 + 报文解析」，新协议落地时
报文类型与分发也放这里（`Logic/Game` 只负责把它装配起来）。

**已知的「逻辑层碰表现层」4 处**（不是随手写的，是现状：真要让方向绝对干净，得先把 `GridMap` 拆成
「格子数据 + 渲染」两个东西，那是新功能落地时的事）：

| 位置 | 碰了什么 | 说明 |
|---|---|---|
| `Logic/Game.cs` | 网络层 + 全部表现层管理器 | **组合根**：装配入口本来就得认识所有管理器，这处是允许的 |
| `Logic/GameSceneManager.cs` | `UIManager` → `SceneFadeUI` | 切场景的淡入淡出属于流程的一部分 |
| `Logic/InputManager.cs` | uGUI 命中判定 + `PhotoClickGlow` | UI 点击豁免与拍照点光 |
| `Logic/DynamicObstacle.cs` | `GridMap` | 它只跟 `GridMap` 打交道，而 `GridMap` 目前同时持有格子数据与渲染 |

## 模块约定

1. **模块 = 目录 + asmdef**：`Scripts/DiceTale.asmdef`（`rootNamespace: DiceTale`）、
   `Editor/DiceTale.Editor.asmdef`（`includePlatforms: [Editor]`，引用 `DiceTale`）。
   **加脚本只往 Data / Network / Logic / Presentation 里放，不要再建 asmdef、也不要再往下切子目录**
   （真觉得某一层太挤时再谈：比如表现层的 UI 窗口可能值得 `Presentation/UI/`）。
2. **namespace 与模块同名**：运行时代码一律 `namespace DiceTale`（子目录不细分），编辑器代码
   `DiceTale.Editor` —— 与（已删除的）`ProjectionAlignment` 模块同一套写法。
3. **运行时按名加载的资产放 `Resources/`**：`Shader.Find("DiceTale/X")` 与
   `Resources.Load<Shader>("Shaders/X")` 都依赖它，挪出去打包后会失效（编辑器里看着正常，是假象）。
4. **测试**（现在还没有）：放 `Assets/DiceTale/Tests/EditMode/` + `DiceTale.Tests.asmdef`
   （引用 `DiceTale` + `UnityEngine.TestRunner` / `UnityEditor.TestRunner`）。
5. `docs/` 放本客户端的说明文档，文件名用「日期 + ASCII」，与 `server/docs/specs/` 一致。

## 编译与验证

- 正常路径：用 Unity Hub 打开 `client/`（6000.3.19f1），Console 要求 **0 个 error CS**。
- 不想开 Unity（或它正开着、不能 `-batchmode` 抢工程）时：把 Unity 生成的 `.csproj` 复制到临时目录，
  只保留仍存在的 `Compile` 项、补 `FrameworkPathOverride`（指 Unity 的 `unity-4.8-api`），
  再 `dotnet msbuild` 编译（做法见清理文档第 14.4 节）。本次就是这样验的：
  `DiceTale`（25 个脚本）与 `DiceTale.Editor`（2 个）都是 **0 error CS**。

## 当前状态（2026-09-19）

- **25 个运行时脚本 + 2 个编辑器脚本**；旧模型零残留；两个程序集编译 0 错误；`.meta` 齐全。
- **新协议还没实现**：连上后端后收到的消息目前无人处理（刻意的），也没有任何上行消息。
- **场景载体待定**：旧 `Resources/Scenes/*.prefab` 与 `*.bytes` 已删，`GameSceneManager` 现在
  按名加载 `Resources` 预置体那条路径**没有资产可加载**；新方向落地时改成「按后台数据搭场景」。
- **已停用但未删**（你要求先不动）：`DevicePipeInputSource2`（`Sample` 整段注释——若在 Game 里把
  输入方案选成 `PipeSource`，输入会**静默失效**）、`InputConfigPrefs`、14 个无人引用的 shader、
  6 个孤儿材质、`Resources/RealMap.prefab`、`Assets/Readme.asset`。要清时按清理文档的口径来
  （都能从 git 取回）。
- **待办（关掉 Unity 后再改，否则会被编辑器内存里的旧值覆盖）**：
  `ProjectSettings/EditorBuildSettings.asset` 里还挂着 6 个**已不存在**的场景
  （`DMGameLibrary` / `SampleScene` / `DarkwaterM0` / `TableBand` / 两个 `ProjectionAlignment` 场景），
  构建列表应当只留 `Assets/DiceTale/Scenes/Demo.unity`。
