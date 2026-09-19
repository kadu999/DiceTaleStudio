# DiceTaleStudio / client

Unity 客户端（Unity **6000.3.19f1**）。方向已反转：**数据在后端，前端只做显示与播放效果**。
旧模型（前端上报对象 / 玩家 / 位置，后端按 id 寻址动作与组件）已整层删除，现在客户端只剩
「显示层 + 输入采集 + WebSocket 传输骨架」，**新协议在功能落地时重新定义**。
删除依据、逐文件清单与遗留说明见 [`docs/2026-09-19-unused-code-removal.md`](docs/2026-09-19-unused-code-removal.md)。

## 目录结构

```
Assets/
├─ DiceTale/                        ← 本客户端唯一的游戏模块
│  ├─ Scripts/                      ← 运行时代码（DiceTale.asmdef）
│  │  ├─ Core/        Game.cs                   游戏宿主：装配各管理器 + 交互锁
│  │  ├─ Networking/  ServerConnection.cs       WebSocket 连接（接收队列 / 重连，不认识协议）
│  │  │               BackendManager.cs         连接装配
│  │  │               JsonParser.cs             JSON 解析工具（新协议用）
│  │  ├─ Input/       InputManager.cs           输入帧消费 + 对外统一状态快照
│  │  │               InputSource.cs            输入源抽象 / PointerId / InputFrame
│  │  │               SimulatedTouchInputSource.cs  开发用模拟触摸源（鼠标 + 数字键）
│  │  │               DevicePipeInputSource2.cs  压板源（**已停用**：body 整段注释，见「当前状态」）
│  │  │               InputConfigPrefs.cs       CommandId 的 PlayerPrefs 持久化
│  │  │               SimulatedTouchDebugUI.cs  触点调试圆点（Demo 场景在用）
│  │  ├─ Scene/       GameSceneManager.cs       场景加载 / 卸载 / 淡入淡出
│  │  ├─ Map/         GridMap.cs / GridCellType.cs / MapMarker.cs
│  │  │               DynamicObstacle.cs / FogOfWar.cs / BirdWanderer.cs
│  │  ├─ Media/       AudioPlayerManager.cs     分层音频（4 层，同层顶替）+ 字幕
│  │  │               SmartVideoPlayer.cs       视频播放 / 播完回调 / 淡入淡出
│  │  ├─ Rendering/   GroundSpriteRenderer.cs   贴地面的纹理面片
│  │  ├─ Effects/     PhotoClickGlow.cs         拍照指针点地时的点光
│  │  └─ UI/          UIManager.cs / UIWindow.cs / SceneFadeUI.cs / SubtitleWindow.cs
│  ├─ Editor/                       ← 编辑器工具（DiceTale.Editor.asmdef）
│  │  ├─ GroundSpriteRendererMenu.cs            菜单入口：建 GroundSpriteRenderer
│  │  └─ SetupMaps.cs                           一次性脚本：把 Demo 场景重建成「只有 Game 宿主」
│  ├─ Resources/                    ← **运行时按名加载的资产必须留在这里**
│  │  ├─ Shaders/                               DiceTale/*.shader（FogBlur / GroundSprite / VideoFade 在用）
│  │  └─ RealMap.prefab
│  ├─ Materials/                    ← 材质（原 `Res/Materials`，`Res/` 这个含混名字已去掉）
│  └─ Scenes/Demo.unity
└─ Settings/                        URP 管线 / 质量 / Volume 设置（被 ProjectSettings 引用）
```

## 约定

1. **模块 = 目录 + asmdef**。本模块两个程序集：
   `Scripts/DiceTale.asmdef`（`rootNamespace: DiceTale`）、`Editor/DiceTale.Editor.asmdef`
   （`includePlatforms: [Editor]`，引用 `DiceTale`）。**加脚本只往子目录里放，不要再建 asmdef。**
2. **namespace 与模块同名**：运行时代码一律 `namespace DiceTale`（子目录**不再**细分命名空间），
   编辑器代码 `DiceTale.Editor`。这与本仓库原有的 `ProjectionAlignment` 模块（`NuLight.ProjectionAlignment`）
   是同一套写法。
3. **运行时按名加载的资产放 `Resources/`**：`Shader.Find("DiceTale/X")` 与
   `Resources.Load<Shader>("Shaders/X")` 都依赖它，挪出去打包后会失效（编辑器里看着正常，是假象）。
4. **测试**（现在还没有）：按模块规范放 `Assets/DiceTale/Tests/EditMode/` +
   `DiceTale.Tests.asmdef`（引用 `DiceTale` + `UnityEngine.TestRunner` / `UnityEditor.TestRunner`）。
5. `docs/` 放本客户端的说明文档（设计、清理清单等），文件名用「日期 + ASCII」，与 `server/docs/specs/` 一致。

## 编译与验证

- 正常路径：用 Unity Hub 打开 `client/`（版本 6000.3.19f1），Console 要求 **0 个 error CS**。
- 不想开 Unity（或它正开着、不能 `-batchmode` 抢工程）时，可以拿 Unity 生成的 `.csproj` 复制到临时目录，
  只保留仍存在的 `Compile` 项、补 `FrameworkPathOverride`（指 Unity 的 `unity-4.8-api`），
  再用 `dotnet msbuild` 编译（做法写在清理文档第 14.4 节）。本轮就是用它验的：
  `DiceTale` 与 `DiceTale.Editor` 都是 **0 error CS**。

## 当前状态（2026-09-19）

- **27 个脚本 / 4138 行**，旧模型零残留；`DiceTale` 与 `DiceTale.Editor` 编译 0 错误。
- **新协议还没实现**：连上后端后收到的消息目前无人处理（刻意的），也没有任何上行消息。
- **场景载体待定**：旧的 `Resources/Scenes/*.prefab` 与 `*.bytes` 已删（D1 由用户拍板为「不要了」），
  `GameSceneManager` 现在按名加载 `Resources` 预置体的那条路径**没有资产可加载**；
  新方向（后台下发场景数据）落地时，这里要改成「按后台数据搭场景」。
- **已停用但未删**（用户要求先不动）：
  `DevicePipeInputSource2`（整段注释、`Sample` 不工作——若在 Game 里把输入方案选成 `PipeSource`，
  输入会静默失效），以及 `InputConfigPrefs`、14 个无人引用的 shader、6 个孤儿材质、
  `Resources/RealMap.prefab`、`Assets/Readme.asset`。要清的时候按清理文档的口径来（都能从 git 取回）。
- **待办（关掉 Unity 后再改，否则会被编辑器内存里的旧值覆盖）**：
  `ProjectSettings/EditorBuildSettings.asset` 里还挂着 6 个**已不存在**的场景
  （`Assets/Scenes/DMGameLibrary.unity`、`SampleScene.unity`、`DarkwaterM0.unity`、
  `Assets/TableBand/Scenes/TableBandGamePlay.unity`、`Assets/ProjectionAlignment/Scenes/*.unity`），
  构建列表应当只留 `Assets/DiceTale/Scenes/Demo.unity`。
