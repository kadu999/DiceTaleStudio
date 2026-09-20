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
4. 编辑器点 **编辑**（或服务端重启）→ 关闸、前端被踢下线并回到「等待运行态」。
   **运行中的改动不会保存**：编辑器在退出运行时把文档**整体还原**到进入运行前的样子（对齐 Unity 的
   播放模式），所以下次运行推下来的还是原样——前端不需要为此做任何事。
   **刷新编辑器网页不会退出运行**：运行态记在服务端，前端照旧连着。

## 目录结构：数据层 / 逻辑层 / 表现层

```
Assets/
├─ DiceTale/                          ← 本客户端唯一的游戏模块
│  ├─ Scripts/                        DiceTale.asmdef（rootNamespace: DiceTale）
│  │  ├─ Data/          （7）         数据层：镜像模型 / 解析 / 枚举 / 本地资源包路径
│  │  │                 SceneModel.cs            镜像的场景与对象（与后端 `SceneDoc` 同构）
│  │  │                 SceneParser.cs           场景 JSON → 镜像模型（JsonUtility 读不了嵌套数组）
│  │  │                 JsonParser.cs            通用 JSON 解析（协议报文用）
│  │  │                 GridRle.cs               网格 RLE 解码（掩码值与 `@dts/grid` 一致）
│  │  │                 GridCellType.cs          网格类型位掩码（区域 / 障碍 / 雾位）
│  │  │                 MapMarker.cs             场景标记点（id + 世界坐标，落点用）
│  │  │                 LocalResourceStore.cs    本地资源包的路径约定（逻辑 ID ↔ 本地文件 / 版本清理）
│  │  │                 ZipStoredReader.cs       读 STORED zip（Unity 没有 System.IO.Compression）
│  │  ├─ Network/       （5）         网络层：与后端通信的一切（不认识游戏逻辑，也不碰显示）
│  │  │                 Protocol.cs              协议常量 / 出站 DTO / ws→http 推导
│  │  │                 ServerConnection.cs      WebSocket 连接（未开闸被拒 = 正常，自动重试）
│  │  │                 ClientSession.cs         握手 / 心跳 / 把消息变成事件
│  │  │                 ResourceBundleCache.cs   当前项目的资源包：清单 → 按需下整包 → 解压到本地
│  │  │                 BackendManager.cs        装配：连接 + 会话 + 资源包 + 镜像 + 命令 + 取图
│  │  ├─ Logic/         （9）         逻辑层：输入 / 流程 / 状态，不直接画东西
│  │  │                 SceneMirror.cs           **按 id 增 / 改 / 删视图**（镜像落地的地方）│  │  │                 CommandRouter.cs         命令 → 动作 → 回执（成败都回）
│  │  │                 Game.cs                  宿主 + 组合根：装配全部管理器、交互锁
│  │  │                 InputManager.cs          消费输入帧 + 对外统一状态快照
│  │  │                 InputSource.cs           输入源抽象 / PointerId / InputFrame
│  │  │                 SimulatedTouchInputSource.cs  开发用模拟触摸源（鼠标 + 数字键）
│  │  │                 DevicePipeInputSource2.cs     压板源（**已停用**，见「当前状态」）
│  │  │                 InputConfigPrefs.cs      CommandId 的 PlayerPrefs 持久化
│  │  │                 DynamicObstacle.cs       运行时把物体占据的格子标成动态阻挡
│  │  └─ Presentation/  （14）        表现层：直接画 / 播 / 显示
│  │                    SceneObjectView.cs       **一个镜像对象 = 一块贴地面片**（位置/缩放/激活/顺序/取图）
│  │                    ResourceImageLoader.cs   按资源逻辑 ID 取图（缓存 / 去重 / 失败记忆）
│  │                    GridMap.cs               地图格子数据 + 网格渲染（+ .bytes 读取）
│  │                    FogOfWar.cs              战争雾（按 map.fog.regions/cells 建遮罩、GPU 羽化、按后台轨迹揭示）
│  │                    BirdWanderer.cs          装饰物区域随机游荡
│  │                    GroundTextureRenderer.cs 贴地面的纹理面片（**只认运行时纹理**）
│  │                    PhotoClickGlow.cs        拍照指针点地时的点光
│  │                    AudioPlayerManager.cs    分层音频（4 层，同层顶替）+ 字幕
│  │                    SmartVideoPlayer.cs      视频播放 / 播完回调 / 淡入淡出
│  │                    UIManager.cs             唯一 Canvas + 窗口注册/开关
│  │                    UIWindow.cs              窗口基类
│  │                    SceneFadeUI.cs           全屏淡入淡出遮罩（**当前无调用方**）
│  │                    SubtitleWindow.cs        字幕窗口
│  │                    SimulatedTouchDebugUI.cs 触点调试圆点
│  ├─ Editor/           （2）         编辑器工具（DiceTale.Editor.asmdef）
│  │                    SetupMaps.cs                  一次性脚本：把 Demo 场景重建成「只有 Game 宿主」
│  │                    GroundTextureRendererEditor.cs 只读 Inspector：面片实际生效的 sortingOrder / 长宽
│  ├─ Resources/                      ← **运行时按名加载的资产必须留在这里**
│  │  ├─ Shaders/                     DiceTale/*.shader（GroundSprite / VideoFade / FogBlur 在用）
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

**已知的「逻辑层碰表现层」5 处**（不是随手写的，是现状：真要让方向绝对干净，得先把 `GridMap` 拆成
「格子数据 + 渲染」两个东西，那是新功能落地时的事）：

| 位置 | 碰了什么 | 说明 |
|---|---|---|
| `Logic/Game.cs` | 网络层 + 全部表现层管理器 | **组合根**：装配入口本来就得认识所有管理器，这处是允许的 |
| `Logic/SceneMirror.cs` | `Presentation/SceneObjectView` | 镜像落地就是「建视图」，这是它的本职；层级按场景分（`场景/<场景名>/对象`） |
| `Logic/CommandRouter.cs` | 镜像 + 回执（下一步接音频） | 命令要作用到表现上，回执要经会话发出去 |
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
  再 `dotnet msbuild` 编译（做法见清理文档第 14.4 节）。
- 本次（2026-09-20，加资源包那两个脚本）用的办法：临时工程**引用真实的 Unity 程序集**
  （`Editor/Data/Managed/UnityEngine/*.dll` + `Library/ScriptAssemblies/*.dll`，排除 `DiceTale.dll`），
  直接编译 `Assets/DiceTale/Scripts/**/*.cs` → **0 error CS**（仅 2 个既有警告，都在 `GridMap.cs`）。
  这样即使 Unity 开着、MCP 桥接掉了也能离线确认编译通过。

## 资源从哪来：**先把资源包下完，再载入场景**

顺序是硬要求：**先下载、后载入**。

```
服务端                                前端
  │ server_hello
  │ resources_prepare{project}  ────►  开始下资源包（manifest → 按需下整包 → 解压）
  │ scene_sync{scene}           ────►  场景**挂起**（不建视图），等资源包处理完
  │                                    …资源包处理完（成功或失败）…
  │                                    载入场景 → 按 id 建 / 改 / 删对象，贴图走本地文件
```

为什么需要服务端提前告知项目名：前端原本只能从镜像里的逻辑 ID 推项目名，而镜像是 `scene_sync`
带来的——那就必然「场景先到、资源后下」。`resources_prepare` 把项目名提前给出来，顺序才反过来。

- **挂起是客户端强制的**：就算服务端没发 `resources_prepare`（或先发了场景），
  `SceneMirror` 也会自己从场景推项目名并挂起（`SceneWaitTimeoutSeconds = 30` 秒兜底：
  等太久就照常载入，图片回落逐文件远程取，不让画面空着）。
- **失败也放行**：资源包下不下来不该让场景一直不显示。
- 挂起期间来了更新的一份场景，就替换掉挂起的那份（只应用最新）。

```
镜像里的逻辑 ID（project:测试项目/Assets/images/Map001.png）
        │
        ├─ 资源包就绪且本地有这一版 ──→ file://<persistentDataPath>/dts-bundles/<服务端标识>/测试项目/<指纹>/images/Map001.png
        │                                （同一条 UnityWebRequestTexture 链路，纹理解码逻辑与远程完全一致）
        └─ 资源包没就绪 / 本地没有 ───→ GET {http}/api/resources/raw?id=…（逐文件，行为与以前一致）
```

### 下载的东西存在哪：**运行时目录，绝不进 Unity 工程的 `Assets/`**

- 落盘位置 = **`Application.persistentDataPath`**（本机是 `AppData/LocalLow/DefaultCompany/LLMNPC_NEWLIGHT`）。
  **绝不写 `Application.dataPath` / 工程的 `Assets/`**：往那儿写会在编辑器里触发资产导入 + 域重载
  （每下载一次就重编译一次），而且下载物会被打进包体、污染 git。工程 `Assets/` 只放随包发布的源素材。
- 目录形如 `persistentDataPath/dts-bundles/<服务端标识>/<项目名>/<指纹>/…`：
  - **服务端标识**（`127.0.0.1-1420-bac2a79d`）= 地址末段 + 地址的 FNV-1a 哈希。`persistentDataPath` 是 Unity 按
    **工程路径**哈希算的，同一台机器上路径不同但**同名**的工程会共用它；只按项目名分目录挡不住串扰，
    所以标识必须把完整地址算进去。用自算哈希而不是 `string.GetHashCode`——后者在 .NET Core 上每进程都变。
  - **指纹即版本目录名**，切素材 = 切目录，不存在「读一半新一半旧」。
- **本地不保留 `Assets/` 这一层**（磁盘上是 `…/images/Map001.png` 而不是 `…/Assets/images/Map001.png`）：
  `Assets/` 只是**服务端项目内**的目录名（zip 条目名仍是它，解压时由
  `LocalResourceStore.LocalRelativePathOfZipEntry` 剥掉）。客户端磁盘上再出现一个叫 `Assets` 的目录，
  只会和 Unity 工程的 `Assets/` 混淆——这正是要避免的。

- **`ResourceBundleCache`**（Network）：`manifest?project=` 拿指纹 → 本地已有同指纹版本就**一个字节都不下**；
  否则 `bundle?project=&v=<本地指纹>`（服务端指纹没变回 304）→ zip 落到临时文件 →
  **后台线程**解压到 `<指纹>.partial` → 写指纹标记 → 改名成正式目录。全部成功才算这一版可用，
  读方永远不会看到「解了一半」的版本。失败**不清旧版本**，图片继续用旧的并回落远程。
- **`ZipStoredReader`**（Data）：读 STORED zip 的最小实现，**这是必需的不是可选**——
  Unity 里没有 `System.IO.Compression` 程序集（`ZipArchive` 被类型转发到它，用了会 `error CS1069`，
  我已实测运行时该程序集确实不存在），而服务端的包本来就**不压缩**（素材已是压缩格式），
  所以「解压」只是按中央目录偏移搬字节 + 逐条 CRC32 校验，纯 C# 无依赖。
- **`LocalResourceStore`**（Data）：纯路径约定（逻辑 ID ↔ 本地文件、版本列表、清理旧版本），
  脱离 Unity 可单测（36 项断言，覆盖无标记版本不算可用、`.partial` 不进列表、清理保留当前+上一版）。
- **`ResourceImageLoader`**（Presentation）：本地优先，本地读不出来时**不把 ID 拉黑**，远程还有一份；
  新增 `Clear()` 释放纹理缓存（以前纹理只增不减）。
- 拉完（或失败）前端回一条 `resources_ready`，编辑器运行面板显示「资源包：已就绪 / 失败 + 项目 + 文件数 + 指纹」。
- 更新时机：**指纹比对**。素材被外部工具改了（size 或 mtime 变）指纹就变，下次连上自动重下；
  没变就不传。本地目录布局与清理规则见 `LocalResourceStore` 的注释。

**音频 / 视频**：字节现在也会被一起下到本地（整包包含 `Assets/` 全部文件），但**播放链路还没接**——
`AudioPlayerManager` 只吃 `AudioClip`、`SmartVideoPlayer` 只认 Inspector 里的 `VideoClip`，
本地包落地后这两条只差最后一步。

## 当前状态（2026-09-20）

- **36 个运行时脚本 + 2 个编辑器脚本**（Data 8 / Logic 9 / Network 5 / Presentation 14）；旧模型零残留；`.meta` 齐全。
- **多场景同时存在，切场景只隐藏不销毁（2026-09-20）**：层级按场景分——
  `Game / 场景（容器）/ <场景名>/ 对象视图…`，**场景节点直接用场景名命名**。
  切换场景只是把别的场景 `SetActive(false)` 藏起来，对象、贴图、状态全部留着；
  切回去直接显示，不重建。一次运行里可以同时有多个场景（玩家可能在场景1 做完事再切到场景2）。
  `Find(objectId)` 会在**所有场景**里找，所以隐藏场景里的对象照样能被命令寻址。
  **没有任何「丢弃场景」的入口**——只隐藏；真要回收内存时再加（不预置一个没人调的销毁 API，
  免得被误用成「切场景就销毁」）。
- **对象用局部坐标，根节点可以自由变换（2026-09-20）**：`SceneObjectView` 写的是
  `localPosition` / `localRotation`（不再是世界坐标），尺寸烘在网格里、`localScale` 恒为 1。
  容器与场景根节点都是单位变换起步，所以**想整场景平移 / 旋转 / 缩放，直接改容器或场景根节点的
  Transform**——里面的对象跟着一起变，不用逐个改世界坐标。实测把场景根节点设成 `scale=0.5`：
  对象 `localPosition` 不变、世界位置与世界缩放都减半。
- **`SceneObjectView.GlobalScale`：文档像素 → 世界单位的那根指针（2026-09-20）**。
  文档里的尺寸与坐标都是**像素**（地图 1920×1080、精灵 256×256、位置像 `(-108.74, -56.60)`），
  直接当世界单位会大得离谱，所以统一乘这个系数：**尺寸与位置都乘它**（两者必须同系数，
  否则对象会被摆到远超自身尺寸的地方）。
  默认 `0.01` → 地图 19.2×10.8 单位、精灵 2.56×2.56 单位；改成 `0.02` → 全部翻倍（实测确认）。
  想连格子、连雾一起缩放请改**场景根节点**的 Transform（那是另一层，`localPosition` 会跟着走）。
- **战争雾已实现（2026-09-21）**：地图上绑了雾区（`map.fog.regions`）就多一层 `FogOverlay`
  （`Presentation/FogOfWar.cs`）——它**与地图同级**挂在场景根节点下（不是地图的子物体，
  位置与角度按地图同一份数值各摆一遍），显示顺序取**最前面**（`short.MaxValue`）：
  未探索的地方连地图上的对象一起盖住，揭示过的部分雾是透明的、照常看得见。
  雾按 `map.cells` 里含这些区域位的格子生成一张像素遮罩
  （**与编辑器 Mask 窗口同一张尺寸**：960 宽、高按贴图比例推）；后台发来的
  `erase_mask`（**只发鼠标轨迹**）+ `reveal_fog_region`（整区开合）把它揭示掉。
  擦除公式与编辑器逐字对齐（归一化半径 × 遮罩宽、沿线段按半径一半补点、按纹素中心算软边、
  `min` 幂等），所以**同一笔在两边擦出的是同一片纹素**；雾色统一（默认黑不透明）。
  **雾的边缘会羽化**：遮罩是按格子填的方块，直接画出来就是一个个方格，所以显示前先过一条
  GPU 模糊链（`DiceTale/FogBlur`，模糊纹理每格 4 个纹素、跑 4 遍 ≈ 羽化一格；做法照参考实现
  `LLMNPC_NEWLIGHT_EX` 的 `FogOfWar` + `FogBlur.shader`）。遮罩本身不写回羽化结果——
  擦除与重放都按没羽化的真状态算。
  揭示状态**只在前端**（不写文档）：切场景 / 重连（视图不销毁）都保留，Unity 重启回到未探索；
  地图数据一变（换绑定 / 涂格子）就「重填初始态 + 按顺序重放操作」，已揭示的部分不丢。
  Unity 里选中地图或 `FogOverlay`，Inspector 上就能看到这一层**实际生效的 `sortingOrder`
  与长宽**（只读，见 `Editor/GroundTextureRendererEditor.cs`）——层叠关系不对时先看那里。
  ⚠️ **`GridMap` / `DynamicObstacle` 仍按世界坐标算格子**，而且运行时不建 `GridMap`
  （它只服务 `.bytes` 那套旧资产，`map.cells` 现在由战争雾那层消费）；
  以后要用「缩放后的场景」做格子交互时，这两处得改成按场景根节点换算。
- **缩放：`scale` 是等比，单轴字段可选（2026-09-20）**：文档 v11 起，对象上可能多出
  **可选**的 `scaleX` / `scaleY`（编辑器里拖缩放手柄的**边**、或关掉属性面板的等比锁后改单轴时会写）。
  客户端目前**按 `scale` 等比渲染**——`SceneObjectView` 把它们忽略掉是**正确**的（协议里它们是可选字段，
  老前端本来就不认）。要看到非等比，是独立的一次改动：读这两个字段后传给
  `GroundTextureRenderer.Apply(w, h)`（渲染器本来就吃两个尺寸参数，尺寸仍烘进网格顶点）。
  规格与折叠规则见 `server/README.md` 的 v11 迁移一节。
- **角度与编辑器同一套口径（2026-09-20）**：文档里的 `SceneObject.rotation` 存**弧度**，
  Unity 侧必须 `Rad2Deg` 再喂给 `Quaternion.Euler`（**不能直接把弧度当度用**，否则 30° 变成 0.52°），
  且**符号不取反**——编辑器面板里填 `30`，Unity 里就是正的 30° Y 轴旋转。
  实测：文档 30° / -60° → Unity `localRotation.eulerAngles.y` = 30.00° / -60.00°。
  编辑器画布也按同一个值旋转绘制（贴图 / 格子 / 网格线 / 选中框一起转），
  与拾取 `hitTestRect(point, rect, rotation)` 共用同一个角度，所以「看到的」与「点得到的」始终一致。
- **贴图真正画上去了（2026-09-20 修）**：`SceneObjectView` 原来只在收到场景推送时才重画面片，
  而取图是**异步**的——首帧必然拿占位色，且命中缓存的那次推送根本不回调这个视图，于是出现
  「纹理已经在 `ResourceImageLoader` 缓存里、`MeshRenderer` 上却还是占位色」（地图对象最明显）。
  现在取图回调里会自己调一次 `ApplyVisual()` 重画。
- **`GroundSpriteRenderer` → `GroundTextureRenderer`（2026-09-20）**：前者是给 Inspector 用的
  （`Sprite` 字段 + `OnValidate` 预览 + 序列化资源管理），而镜像的图来自后台推下来的资源 ID、
  运行时才拿到，根本没有「拖图」这回事。新类**只认 `Texture2D`**，没有 `Sprite` 字段、
  没有序列化字段、没有编辑器预览；连同它的菜单入口 `GroundSpriteRendererMenu` 一起删掉
  （Shader `DiceTale/GroundSprite` 保留，新类继续用）。
- **尺寸烘进网格顶点，不再靠 Transform 缩放（2026-09-20）**：`Apply(texture, width, height, tint, order, lift)`
  收的是世界单位下的宽高，顶点摆在 `±宽/2` / `±高/2`，`transform.localScale` 由渲染器校正为
  `(1,1,1)`（`SceneObjectView` 不再设 `localScale`）。这样「对象多大」只有一处来源——网格自己，
  不会出现「网格比例 × 缩放」两处都能改大小、改错一个就变形。实测：地图声明 1920×1080 → 
  网格 bounds 1920×1080、scale (1,1,1)；精灵声明 256×256 → 网格 256×256、scale (1,1,1)。
- **镜像协议已实现**（**协议 v3**，见 `server/docs/specs/2026-09-19-runtime-mirror-protocol.md`）：
  编辑器点「运行」→ 服务端开闸 → 前端连上 → **先下资源包** → 再整份推场景 → 按 `id` 建 / 改 / 删对象
  （位置 / 缩放 / 旋转 / **激活** / 显示顺序 / 取图都同步）。
- **资源包已实现**（见上一节）：连上即按项目拉整包到本地，之后图片从本地读；
  指纹变了才重下。服务端侧见 `server/README.md` 的「运行态资源包」。
  Unity 内实测：真实 37 MB 包解压 **15 个文件 / 120 ms**，逐条 CRC 通过，
  解出的 png / mp4 / wav / mp3 / json 与仓库源文件 **SHA256 逐字节一致**；
  顺序实测为「场景先挂起 → 资源包就绪 → 场景才载入」。
- **下一步**：`play_sound` 的真出声（取音频 + 按层播放）。现在命令链路已通（转发 / 回执 / 超时 / 日志），
  但前端如实回 `ok:false` 并说明「镜像里该播哪一条」——不假装成功；音频字节已经在本地了。
- **场景载体（D1 已落地）**：旧 `Resources/Scenes/*.prefab` 与 `*.bytes` 已删，场景内容由后台推下来、
  由 `SceneMirror` 搭出来。`GameSceneManager`（按名加载 Resources 预置体 + 淡入淡出）**已于 2026-09-20
  整个删除**——它唯一的动作就是 `Start()` 里加载早已不存在的 `Scene000` 预设，每次进播放模式都报
  `Scene prefab not found`。**`SceneFadeUI` 保留**（它不依赖那个类，是自包含的全屏遮罩），
  但**目前没有调用方**——等真正需要黑屏过渡的功能来调，或确认用不上就删。
- **已停用但未删**（你要求先不动）：`DevicePipeInputSource2`（`Sample` 整段注释——若在 Game 里把
  输入方案选成 `PipeSource`，输入会**静默失效**）、`InputConfigPrefs`、14 个无人引用的 shader
  （`MaskEraseStamp` / `FogOfWar` / `FogOfWarAccumulate` / `FogCombine` 等——战争雾走 CPU 擦除 +
  `FogBlur` 羽化，这几个都没接）、6 个孤儿材质、`Resources/RealMap.prefab`、`Assets/Readme.asset`。
  要清时按清理文档的口径来（都能从 git 取回）。
- **待办（关掉 Unity 后再改，否则会被编辑器内存里的旧值覆盖）**：
  `ProjectSettings/EditorBuildSettings.asset` 里还挂着 6 个**已不存在**的场景
  （`DMGameLibrary` / `SampleScene` / `DarkwaterM0` / `TableBand` / 两个 `ProjectionAlignment` 场景），
  构建列表应当只留 `Assets/DiceTale/Scenes/Demo.unity`。
