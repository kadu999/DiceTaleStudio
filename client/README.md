# DiceTaleStudio / client

Unity 客户端（Unity **6000.3.19f1**）。方向已反转：**后台（编辑器文档）是唯一真源，前端只是它的镜像 + 播放器**——
后台有什么对象，前端就有什么对象（同场景名、同对象 `id`、同属性）。旧模型（前端上报对象 / 玩家 / 位置，
后端按 id 寻址动作与组件）已整层删除。
协议与字段口径见 [`server/docs/specs/2026-09-19-runtime-mirror-protocol.md`](../server/docs/specs/2026-09-19-runtime-mirror-protocol.md)；
逐文件删除清单与遗留见 [`docs/2026-09-19-unused-code-removal.md`](docs/2026-09-19-unused-code-removal.md)。

## 运行态怎么跑起来

1. 编辑器（`server/`）点 **运行** → 服务端**开闸**并把当前场景推下去；
2. 前端连上（**没点运行之前连不上**：`/client` 升级会被 HTTP 503 拒绝，这是正常现象）——
   连接默认每 3s 重试，控制台只提示一次；
3. 编辑器里改对象（激活 / 位置 / 缩放 / 显示顺序 / 增删）→ 前端 ≤0.5s 跟进；
4. 编辑器点 **编辑**（或刷新页面）→ 关闸、前端被踢下线并回到「等待运行态」。

## 目录结构：数据层 / 逻辑层 / 表现层

```
Assets/
├─ DiceTale/                          ← 本客户端唯一的游戏模块
│  ├─ Scripts/                        DiceTale.asmdef（rootNamespace: DiceTale）
│  │  ├─ Data/          （6）         数据层：镜像模型 / 解析 / 枚举
│  │  │                 SceneModel.cs            镜像的场景与对象（与后端 `SceneDoc` 同构）
│  │  │                 SceneParser.cs           场景 JSON → 镜像模型（JsonUtility 读不了嵌套数组）
│  │  │                 JsonParser.cs            通用 JSON 解析（协议报文用）
│  │  │                 GridRle.cs               网格 RLE 解码（掩码值与 `@dts/grid` 一致）
│  │  │                 GridCellType.cs          网格类型位掩码（区域 / 障碍 / 雾位）
│  │  │                 MapMarker.cs             场景标记点（id + 世界坐标，落点用）
│  │  ├─ Network/       （4）         网络层：与后端通信的一切（不认识游戏逻辑，也不碰显示）
│  │  │                 Protocol.cs              协议常量 / 出站 DTO / ws→http 推导
│  │  │                 ServerConnection.cs      WebSocket 连接（未开闸被拒 = 正常，自动重试）
│  │  │                 ClientSession.cs         握手 / 心跳 / 把消息变成事件
│  │  │                 BackendManager.cs        装配：连接 + 会话 + 镜像 + 命令 + 取图
│  │  ├─ Logic/         （11）        逻辑层：输入 / 流程 / 状态，不直接画东西
│  │  │                 SceneMirror.cs           **按 id 增 / 改 / 删视图**（镜像落地的地方）
│  │  │                 CommandRouter.cs         命令 → 动作 → 回执（成败都回）
│  │  │                 Game.cs                  宿主 + 组合根：装配全部管理器、交互锁
│  │  │                 InputManager.cs          消费输入帧 + 对外统一状态快照
│  │  │                 InputSource.cs           输入源抽象 / PointerId / InputFrame
│  │  │                 SimulatedTouchInputSource.cs  开发用模拟触摸源（鼠标 + 数字键）
│  │  │                 DevicePipeInputSource2.cs     压板源（**已停用**，见「当前状态」）
│  │  │                 InputConfigPrefs.cs      CommandId 的 PlayerPrefs 持久化
│  │  │                 GameSceneManager.cs      场景加载 / 卸载 / 淡入淡出
│  │  │                 DynamicObstacle.cs       运行时把物体占据的格子标成动态阻挡
│  │  └─ Presentation/  （13）        表现层：直接画 / 播 / 显示
│  │                    SceneObjectView.cs       **一个镜像对象 = 一块贴地面片**（位置/缩放/激活/顺序/取图）
│  │                    ResourceImageLoader.cs   按资源逻辑 ID 取图（缓存 / 去重 / 失败记忆）
│  │                    GridMap.cs               地图格子数据 + 网格渲染（+ .bytes 读取）
│  │                    FogOfWar.cs              战争雾（GPU 羽化 + 右键擦除）
│  │                    BirdWanderer.cs          装饰物区域随机游荡
│  │                    GroundSpriteRenderer.cs  贴地面的纹理面片（含运行时纹理入口）
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
| **Data** | 数据结构、枚举、可序列化模型、解析（场景 / JSON / RLE） | 不引用另外三层（当前 Data 零外部引用） |
| **Network** | 与后端通信的一切：连接、会话、协议 DTO、连接装配 | 只依赖数据层；不认识游戏逻辑、不碰显示 |
| **Logic** | 输入消费、流程与状态驱动、**镜像落地**、命令路由 | 不直接操作渲染器 / Canvas / AudioSource |
| **Presentation** | 直接画 / 播 / 显示：MeshRenderer、Texture、Canvas、AudioSource、VideoPlayer、Light | 不做协议 |

**客户端不拥有数据**（数据都在后端），所以 Data 里是「镜像模型 + 解析」，不是业务数据：
`SceneModel` 就是后端 `SceneDoc` 的同构副本，`SceneMirror` 负责把它变成 Unity 对象。
**网络层**同理只做「连接 + 会话 + 协议」，一行游戏逻辑都没有。

**已知的「逻辑层碰表现层」6 处**（不是随手写的，是现状：真要让方向绝对干净，得先把 `GridMap` 拆成
「格子数据 + 渲染」两个东西，那是新功能落地时的事）：

| 位置 | 碰了什么 | 说明 |
|---|---|---|
| `Logic/Game.cs` | 网络层 + 全部表现层管理器 | **组合根**：装配入口本来就得认识所有管理器，这处是允许的 |
| `Logic/SceneMirror.cs` | `Presentation/SceneObjectView` | 镜像落地就是「建视图」，这是它的本职 |
| `Logic/CommandRouter.cs` | 镜像 + 回执（下一步接音频） | 命令要作用到表现上，回执要经会话发出去 |
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
  `DiceTale`（34 个脚本）与 `DiceTale.Editor`（2 个）都是 **0 error CS**。

## 当前状态（2026-09-19）

- **34 个运行时脚本 + 2 个编辑器脚本**；旧模型零残留；两个程序集编译 0 错误；`.meta` 齐全。
- **镜像协议已实现**（见 `server/docs/specs/2026-09-19-runtime-mirror-protocol.md`）：
  编辑器点「运行」→ 服务端开闸 → 前端连上 → 场景整份推下来 → 按 `id` 建 / 改 / 删对象
  （位置 / 缩放 / 旋转 / **激活** / 显示顺序 / 取图都同步）。
- **下一步**：`play_sound` 的真出声（取音频 + 按层播放）。现在命令链路已通（转发 / 回执 / 超时 / 日志），
  但前端如实回 `ok:false` 并说明「镜像里该播哪一条」——不假装成功。
- **场景载体**：旧 `Resources/Scenes/*.prefab` 与 `*.bytes` 已删；现在场景内容由后台推下来，
  `GameSceneManager` 的「按名加载 Resources 预置体」那条路径暂时没有资产可加载（等场景加载命令）。
- **已停用但未删**（你要求先不动）：`DevicePipeInputSource2`（`Sample` 整段注释——若在 Game 里把
  输入方案选成 `PipeSource`，输入会**静默失效**）、`InputConfigPrefs`、14 个无人引用的 shader、
  6 个孤儿材质、`Resources/RealMap.prefab`、`Assets/Readme.asset`。要清时按清理文档的口径来
  （都能从 git 取回）。
- **待办（关掉 Unity 后再改，否则会被编辑器内存里的旧值覆盖）**：
  `ProjectSettings/EditorBuildSettings.asset` 里还挂着 6 个**已不存在**的场景
  （`DMGameLibrary` / `SampleScene` / `DarkwaterM0` / `TableBand` / 两个 `ProjectionAlignment` 场景），
  构建列表应当只留 `Assets/DiceTale/Scenes/Demo.unity`。
