# client/ 代码冗余审查报告（2026-09-22）

审查范围：`client/Assets/DiceTale` 下全部 41 个 C# 文件（运行时 39 + 编辑器 2），并做了全工程交叉引用验证（方法名 grep、GUID 反查 `*.unity` / `*.prefab` / `*.mat`）。上下文参考：`docs/2026-09-19-unused-code-removal.md`（上一轮大清理）。本轮发现的是清理之后新长出/当时登记保留的冗余。

**总体评价：冗余程度中等偏低，但有两块明显的"腐烂区"。** 活跃链路（Network 4 件套、SceneMirror/SceneObjectView/FogOfWar/VideoOverlay 镜像渲染链、CommandRouter）质量不错，几乎没有拷贝粘贴。问题集中在"旧系统残留"和"死 API 毛边"。

## 高严重度

### 1. `SmartVideoPlayer` 整类已死

`Scripts/Presentation/SmartVideoPlayer.cs:14`（475 行）+ `Resources/Shaders/VideoFade.shader`

全工程零代码引用；GUID 反查 Demo.unity / RealMap.prefab 均为 0。视频实际走 `VideoOverlay`，`SmartVideoPlayer` 是"老项目搬来的按 Inspector VideoClip[] 播放"的旧路（README「当前状态」第 277 行承认"没有任何 prefab/scene 引用它"）。VideoFade shader 仅被它按名加载。

**处理建议**：删除类 + shader（git 历史可捞回）。

### 2. 旧格子系统整链无宿主

`Scripts/Presentation/GridMap.cs`（489 行）、`Scripts/Logic/DynamicObstacle.cs`（90 行）、`Scripts/Data/GridCellType.cs`（21 行）

GUID 反查场景/预制体为 0——没有任何地方挂 `GridMap`。连带后果：`InputSource.cs:134` 的 `PointerWorldConversion.ScreenToPlane` 每帧 `FindFirstObjectByType<GridMap>()` 恒为 null、永远走 y=0 兜底平面。`FindPath`/`Heuristic`（GridMap.cs:283-365）、`IsWalkable`、`RefreshDynamicObstacles`（231）、`SetCellType`/`CellGrid`、`DynamicObstacle` 全部无调用方。README 第 259 行承认它"只服务 .bytes 那套旧资产"，`map.cells` 现在由 FogOfWar 直接消费。

**处理建议**：约 600 行可整体删除（或至少删 A* 寻路与 DynamicObstacle；README 已说"以后用时再改坐标口径"，但目前连宿主都没有）。

### 3. `DevicePipeInputSource2` 是空壳 + 大段注释代码

`Scripts/Logic/DevicePipeInputSource2.cs:31-126`

`Sample()` 方法体整段被注释（约 94 行）；因此 `SampleMultiTouch`（130-160）成为无调用方的活死代码，`WarnOnce`（162-171）、`LogDiagnostics` 同理只在被注释代码里被引用。`InputManager.CreateSource`（InputManager.cs:94-99）仍会安装这个源——装了等于输入静默消失。README 标注"已停用"。

**处理建议**：要么整个类删掉（连同 `InputSourceKind.PipeSource` 分支、`InputConfigPrefs`、Game.cs:11 的 tooltip 文案），要么把注释代码移出仓库存档。留着半注释类是最差状态。

### 4. 取图与取音频是两个近乎逐字相同的类

`Scripts/Presentation/ResourceImageLoader.cs` vs `Scripts/Presentation/AudioClipLoader.cs`

`cache`/`pending`/`failed` 三件套、`Attach`/`OnBundleVersionChanged`/`OnDestroy` 订退、`Clear`、`Load` 的缓存→失败→排队三分支、`Fetch` 的"本地优先 + `/api/resources/raw` 兜底 + 失败不拉黑本地"、`Complete` 广播——两文件约 150 行各一份，结构 90% 相同，只有 `UnityWebRequestTexture` vs `GetAudioClip` 和扩展名嗅探不同。

**处理建议**：提取 `ResourceLoader<T>` 基类（或泛型组件），各自只留 Fetch 差异部分。

## 中严重度

### 5. 一批无调用方的 public 成员（均已逐一 grep 验证为 0 命中）

| 位置 | 内容 |
|---|---|
| `Scripts/Logic/Game.cs:69-88` | `LockInteraction`/`UnlockInteractionAfter`：无调用方，`CanInteract` 恒 true，互动锁机制空转 |
| `Scripts/Logic/InputManager.cs:42,69,108,114` | `IsRightMouseHeld`、`CurrentInputSource`、`InstallDevicePipeSource`、`TryGetRightMouseWorldPosition` 均无读者（右键擦除已改命令驱动，注释里自己也这么说） |
| `Scripts/Logic/InputSource.cs:62` | `PointerIdExtensions.ToPlayerIndex`：无调用方 |
| `Scripts/Logic/SimulatedTouchInputSource.cs:55-67` | `ActiveFinger`/`IsFingerDown`/`FingerScreenPosition`：无调用方（注释说"供调试显示"，调试 UI 实际读的是 InputManager 静态快照） |
| `Scripts/Logic/InputConfigPrefs.cs:28` | `SaveCommandId`：只有 Load 没有 Save，持久化是单向的 |
| `Scripts/Presentation/AudioPlayerManager.cs:114,121` | `IsPlaying`/`IsPlayingClip`：无调用方 |
| `Scripts/Presentation/VideoOverlay.cs:52-54` | `IsPlaying`/`IsPaused`：无外部读者 |
| `Scripts/Presentation/UIManager.cs:33,91-106,156-163,190,200` | `Windows`、`DestroyWindow`、`CloseAllWindows` 无调用方；`OpenWindow(resourcesPath)` 的两个调用方都不传路径 → `LoadUI`/`InstantiateUI`/资源加载分支（约 25 行）是死分支 |
| `Scripts/Presentation/UIWindow.cs:20` | `WindowId`：无调用方 |
| `Scripts/Network/ResourceBundleCache.cs:298,667` | `Retry()` 无调用方；`Outcome.Bytes` 字段声明后从未赋值/读取 |
| `Scripts/Network/BackendManager.cs:38` | `Settings` 属性：设置只进播放器，无人读这个属性 |
| `Scripts/Network/Protocol.cs:56-60` | `TypeClientHello`/`TypeCommandResult`/`TypePong`/`TypeResourcesReady` 四个常量无人用（消息类里写的是字面量） |
| `Scripts/Network/ClientSession.cs:23` | `ClientSessionState.Closed` 枚举值从未置位 |
| `Scripts/Data/ZipStoredReader.cs:122-125` | `ExtractAll` 两参重载无调用方 |
| `Scripts/Data/LocalResourceStore.cs:162` | `Exists` 无调用方 |
| `Scripts/Presentation/SceneFadeUI.cs:140` | `SetAlpha` 声明 public 但只被类内调用，可降为 private |

### 6. 字幕链路休眠

`AudioPlayerManager.Play` 的 `subtitle` 参数（AudioPlayerManager.cs:128）两个调用方（CommandRouter.cs:230,339）都不传 → `SubtitleWindow` 整套（含 enableText、subtitleShown 维护、Update 轮询）实际走不到有文本的分支。要么接数据（协议里 voice 对象加文本），要么删。

### 7. `PressedPressures` 压力快照无人消费

`InputManager.PressedPressures`（InputManager.cs:30）每帧维护，但压板源停用后没有任何读者（模拟源压力恒 1）。`InputFrame.PressedPressures` 同理。

### 8. 重复模式（建议提取公共方法）

- **FNV-1a 哈希两份**：`ResourceBundleCache.ServerKeyOf`（ResourceBundleCache.cs:159-191）与 `FogOfWar.HashCells`（FogOfWar.cs:599-611）→ 提一个 `Fnv1a` 工具。
- **"运行时用 Destroy / 编辑器 DestroyImmediate"三份拷贝**：`SceneObjectView.DestroyOwned`（380-390）、`FogOfWar.Release`（740-750）、`TextureRenderer.Release`（192-202）→ 提公共静态方法。
- **`CommandRouter` 声音处理器样板**：`HandleStopSound`/`HandlePauseSound`/`HandleResumeSound`（CommandRouter.cs:236-319）各重复 `IsKnownLayer` + `bgm` 拒斥检查约 8 行 ×3；bgm 四处理器与 sound 四处理器完全同构 → 用一个"解析目标通道"助手收敛。
- **`ResourceBundleCache.Run` 的失败收尾块**（326-346 与 356-371）逐字重复约 20 行 → 提取本地函数。
- **`ServerConnection.CloseAsync`（319-340）与 `CloseSocketAsync`（343-363）** 仅差"是否碰字段"，可合并。
- **`SceneParser` 的 clips 解析循环两份**：`ParseSound`（SceneParser.cs:157-167）与 `ParseVideo`（193-203）逐字重复 → 提 `ParseStringList`。
- **`ClientSession.OnConnectFailed`（101-107）与 `OnDisconnected`（109-114）** 方法体相同。
- **`LocalResourceStore` 的 `catch(IOException)+catch(UnauthorizedAccessException)` 样板 5 份**（176-188、209-228、246-257、317-329、378-390）→ 可共用一个 `TryIo` 助手。
- **三档音量缺省值 0.6/0.8/1 三处重复硬编码**：SettingsParser.cs:36,42,48、SceneModel.cs:161,164、AudioPlayerManager.cs:101。

## 低严重度（冗余资源 / 过时工具）

### 9. `Materials/` 全部 6 个材质是孤儿

Map001/2/3、Bridge、CharacterCreation、BirdWanderer 的 GUID 在全部场景/预制体中 0 引用（旧 Map 预制体在 `bbf0eb6` 已删）。其中 Map002.mat 是唯一引用 `BoxComposite.shader` 的资产。

### 10. `Resources/Shaders/` 16 个中 13 个零引用

代码按名加载的只有 `FogBlur`（FogOfWar）和 `TextureRenderer`；`VideoFade` 随 SmartVideoPlayer 一起死。`EmberFloor`/`FlameStrip`/`ScorchFloor`/`FireNoise`/`SoftParticle`（BurningRoom 遗留）、`FogOfWar`/`FogOfWarAccumulate`/`FogCombine`/`WipeMask`/`RectMask`（旧雾实现）、`SelectionRing`、`BoxComposite` 均无任何引用。例外：`MaskEraseStamp` 是清理文档 D5 明确拍板保留的（将来遮罩擦除效果），FogBlur/TextureRenderer 在用。

### 11. `Resources/RealMap.prefab` 是孤儿

内容 = RealMap 根 + 4 个 Cube、零脚本、零引用（GUID 全库反查为 0），旧地图占位残留。

### 12. `Editor/SetupMaps.cs:15` 路径已失效

硬编码 `Assets/Scenes/Demo.unity`，实际场景在 `Assets/DiceTale/Scenes/Demo.unity`——现在跑这个菜单会另建一个错误位置的新场景，且重建内容（只有 Game 物体）与现有 Demo.unity（UICanvas/EventSystem/相机/Global Volume）不符。EditorBuildSettings 倒是已修正（指向正确路径）。

## 输入链路专项（InputSource / InputManager 深审）

对输入层 5 个文件（`InputSource.cs`、`InputManager.cs`、`SimulatedTouchInputSource.cs`、`DevicePipeInputSource2.cs`、`InputConfigPrefs.cs`，共 ~720 行）逐行审查 + 全库交叉引用验证后的补充发现：

### A. 世界坐标/压力/右键整条管道无消费者（新发现，比报告第 5 条更严重）

`InputManager` 对外的 4 个并行快照中，只有屏幕坐标和 Id 有读者（`SimulatedTouchDebugUI` 画调试圆点）：

- **`PressedWorldPositions`（世界坐标快照）全库零读者**——除定义和 `AddRange` 外无任何读取。注释里说"将来要做多点同时按住类玩法就拿它当统一输入接口"，纯属预留。
- **`PressedPressures` 零读者**（模拟源恒为 1），每帧维护纯空转。
- **右键链整体无消费者**：`IsRightMouseHeld`（InputManager.cs:42）、`TryGetRightMouseWorldPosition`（114）、静态字段 `rightMouseHeld`/`rightMouseWorldPosition`、`InputFrame.RightMouseHeld`/`RightMouseWorldPosition`（InputSource.cs:99-102）、模拟源的右键透传块（SimulatedTouchInputSource.cs:147-156）+ `RightMousePassThrough` 开关——全链没有任何读取方。右键擦除已改命令驱动，这是整条被遗忘的管道（约 40 行）。

**处理建议**：要么明确"新协议落地后上报后台要世界坐标"的路线图并保留，要么删掉世界/压力/右键三组，InputFrame 只留屏幕坐标 + Id + NewlyPressed。当前状态是 4 条管道 2 条半死。

### B. `DevicePipeInputSource2.Sample()` 空方法体有实际危害（新发现）

`InputManager` 整个生命周期复用同一个 `InputFrame` 实例，靠输入源在 `Sample()` 开头调 `frame.Reset()` 清帧（见 SimulatedTouchInputSource.cs:71）。`DevicePipeInputSource2.Sample()` 的方法体**整段被注释、什么都不做**，导致：

- 切到 `PipeSource` 后，`frame` 永久冻结在上一个源留下的状态——若之前是模拟源，所有"按住"的触点会永远留在快照里，调试圆点冻结不消失；
- `NewlyPressed` 永不清空、`ScreenPositionsAvailable` 保持 true，InputManager 的 UI 豁免/按下处理逻辑拿到的是陈旧的伪事件。

这比死代码更糟：装了等于输入态 poison。连同 `SampleMultiTouch`（130-160，~30 行不可达活代码）、`WarnOnce`/`lastWarning`（162-171）、`LogDiagnostics`（27）一起，构成高严重度第 3 条所说的"半注释类"，建议优先处理。

### C. 已登记输入毛边复核确认（补充细节）

- `SimulatedTouchInputSource.ActiveFinger`/`IsFingerDown`/`FingerScreenPosition`（55-67，~14 行）：确认零调用方，调试显示走 InputManager 静态快照。注释"也可读 IsFingerDown 等状态自行绘制"过时。
- `PointerIdExtensions.ToPlayerIndex`（InputSource.cs:62）：确认零调用方。
- `InputConfigPrefs.SaveCommandId`（28）：确认零调用方——`LoadCommandId` 在 `CreateSource` 里仍会被执行（恢复一个无行为源的 CommandId，无害但无意义）。
- `InputSourceKind.PipeSource` 是唯一一个装了会让输入变哑的方案，`Game.cs` 的 tooltip（10-12 行）却把它列成正常可选方案之一，还残留第三种 "PipeSource2" 的文案（枚举里已不存在）。`InstallDevicePipeSource()` 兼容入口（InputManager.cs:108）亦无调用方。

### D. 输入层的小质量问题（非冗余，顺带记录）

- `PointerWorldConversion.ScreenToPlane`（InputSource.cs:134）**每帧每个触点** `FindFirstObjectByType<GridMap>()`：模拟源 6 指全按下时每帧 6+ 次全场景查找，且因 GridMap 无宿主恒走 y=0 兜底（见高严重度第 2 条）。删 GridMap 后这里应改为直接平面求交。
- `IsPointerOverUI`（InputManager.cs:201）每次按压 `new PointerEventData`：真机高频点击下有少量 GC 分配，可池化。
- 按压被 UI 豁免时 `Debug.Log`（InputManager.cs:170）无开关、真机每按一条，日志噪音。

## 建议处理顺序

1. **先做**（收益大、风险小）：删 `SmartVideoPlayer` + 空壳压板源 `DevicePipeInputSource2`、合并两个 Loader。
2. **跟随拍板一起做**：GridMap 整链（~600 行）、孤儿材质/shader/prefab 清理。
3. **顺手清**：死 API 毛边（~200-300 行）、重复模式提取。

## 处理记录

- **2026-09-22 已删 `PhotoClickGlow`**：删除 `Scripts/Presentation/PhotoClickGlow.cs`（72 行），同步移除 `Game.cs` 的管理器持有与 `InputManager.Update` 里拍照指针触发点光的分支（含按下→世界坐标换算）。删除后 InputManager 的按下处理只剩 UI 豁免诊断，类/方法注释已同步更新。`dotnet build` 两个工程均 0 错误通过。
- **2026-09-22 已删整个输入层**（用户拍板）：删除 6 个文件共 ~950 行——`InputManager.cs`（216）、`InputSource.cs`（145，含 PointerId/InputFrame/PointerWorldConversion）、`SimulatedTouchInputSource.cs`（159）、`DevicePipeInputSource2.cs`（172）、`InputConfigPrefs.cs`（34）、`SimulatedTouchDebugUI.cs`（220），各 `.meta` 一并删除。连带清理：`Game.cs`（inputSourceKind 开关字段、InputManager 管理器、InitializeInputSource）、`Demo.unity`（Game 物体上的 SimulatedTouchDebugUI 组件 + Game 组件的 inputSourceKind 序列化字段）、两个 `.csproj` 的 Compile 条目。输入专项章节 A–D 登记的问题随删除一并消掉（含 B 的空 Sample 毒化隐患）。README 的输入相关章节（模拟源/压板源说明）待同步。`dotnet build` 两个工程 0 错误通过。
