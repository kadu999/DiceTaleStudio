# TASKS：视频混合组件（用 Mask 混合两条视频）

日期：2026-09-26
状态：**已完成**（D1–D7；`pnpm check` 全绿 + 桌面 `@runtime` e2e 10 条全过 + Unity MCP 断言通过）
前置：[[TASKS-战争雾独立对象]]（遮罩擦除的像素运算 / 窗口形态）、[[TASKS-视频变成可选组件]]（视频是可选组件）、
[[TASKS-属性面板添加组件]]（底部 Add Component + 组头移除）

## 目标（用户原话与拍板）

用户原话：「加一个组件，可以用 Mask 来把两个视频输出混合，通过类似战争雾 Mask 这样窗口来擦除控制 Mask 贴图」。

逐条拍板（本次会话问答的结论）：

1. **两条视频引用住在组件里**：两条通道各有自己的 `clips + picked`，像现在的视频组那样「加列表 + 选一条」；
2. **混合语义 = 盖住 A、擦开露 B**：Mask 初始整张不透明（只看见视频 A），窗口里用软边圆刷擦开，擦到的地方露出底下的视频 B；
3. **遮罩纯运行态、不落盘**：与战争雾完全同构——编辑器窗口只是预览，擦除轨迹经新命令下发给 Unity，Unity 在内存里擦；重开 Unity / 重置回到初始（全 A）；
4. **遮罩尺寸按视频自身的像素尺寸**（编辑器与 Unity 同一个 `previewMaskSizeFor` 口径，笔刷两边不变形）；
5. **组件挂在贴图对象（`Image`）上**，是与 `VideoOverlay` 同级的**可选组件**（属性面板底部 Add Component 添加、组头移除）；
6. **端到端**：document + protocol + 编辑器窗口 / store + Unity（双 `VideoPlayer` → 双 `RenderTexture` + 混合 shader）。

## 设计决策

- 组件名 **`VideoBlend`**（显示名「视频混合」）。它走**能力组件**那条老路（自报 `slot: "videoBlend"`），
  因为「可选组件准入 / Add Component 入口 / `ensureSlotData` 闸门」现在都要求 `slot !== undefined`
  （`access.ts` 的 `canAddOptionalObjectComponent`）——不新增机制，照 `VideoOverlay` 的形状克隆一份最省。
  - 新增一个 `ComponentSlot`：`videoBlend`；`DEFAULT_SLOT_COMPONENT.videoBlend = "VideoBlend"`；
    `OBJECT_PRESETS.Image.slots.videoBlend = "VideoBlend"`。
- **`VideoOverlay` 与 `VideoBlend` 互斥**：一个对象最多挂二者之一。**准入层直接拒绝**——
  挂了一个之后，另一个既不能加（Add Component 菜单里不列、`canAddOptionalObjectComponent` 为假），
  也不能补建（`componentTypeForObjectSlot` / `ensureSlotData`）——判据只有 `access.ts` 的
  `EXCLUSIVE_SLOTS` 一处。手写文件里两个都写的属于损坏数据：读取不拦，`validateScene` 报一条 **error**。
- 遮罩的初始形态**不是**「格子区域位」（视频没有网格），就是**整张不透明**：所以没有 `regions`、
  没有 `reveal_fog_region` 那种整区开关，组件数据里也不存任何遮罩状态。
- 编辑器窗口的底图**不能是视频**（编辑器不解码、不预览，见 `VideoOverlay.cs` 头注）：用两条视频的
  **首帧缩略图**拼出预览——B 的缩略图铺底、A 的缩略图按遮罩盖在上面，「擦开露出 B」在窗口里肉眼可见。
  缩略图走既有 `GET /api/resources/thumbnail?id=`（视频走 ffmpeg 抽首帧）。
- 遮罩尺寸依据**视频像素尺寸**：后端 `?info=1` 现在对视频是明确拒绝的（「视频不支持 info=1」），
  **扩成支持**（复用已有的 ffmpeg 抽帧能力探测宽高）——这是编辑器拿到视频尺寸的正路。
- 播放控制**复用**既有四条命令（`play_video` / `pause_video` / `resume_video` / `stop_video`，都按 `objectId`）：
  前端在对象上找视频承载组件，是 `VideoBlend` 就**同时起停两条**。只有「擦一笔」是新命令。
- **笔刷软边 `0.5`（战争雾是 `1`）**：擦除是 `min` 幂等，`softness = 1` 的圆刷没有平顶核，
  **擦得再密也到不了 0**——「擦完的区域」永远留一层 A 的残影（看着还是两条视频混在一起）。
  留个实心核（core = 半径的一半）才能真的擦到 0（干净地露出 B）。命令形状不变（`softness`
  本来就在 `stroke` 里）；编辑器预览与下发共用同一个常量 `VIDEO_BLEND_MASK_SOFTNESS`。

## 数据模型

```ts
/** 视频混合的一路：**图片或视频**（面板上的开关）+ **一个**素材。 */
export const VIDEO_BLEND_KINDS = ["image", "video"] as const;
export type VideoBlendKind = (typeof VIDEO_BLEND_KINDS)[number];

export interface VideoBlendChannelDoc {
  readonly kind: VideoBlendKind;
  readonly id?: string;
}

export const VIDEO_BLEND_AUDIO = ["none", "a", "b"] as const;
export type VideoBlendAudio = (typeof VIDEO_BLEND_AUDIO)[number];

/**
 * 视频混合组件的数据：两路素材（A 盖住 / B 露出）+ 循环 + 自动播放 + 声音来源。
 * 遮罩**不在数据里**——它是纯运行态（见目标第 3 条），组件只声明「放什么」。
 * **没有 `enabled`**：与 `GridMap` 同一条「组件在 = 在用」（Add Component 添加 / 组头移除）。
 */
export interface VideoBlendDataDoc {
  readonly a: VideoBlendChannelDoc;
  readonly b: VideoBlendChannelDoc;
  readonly loop: boolean;
  readonly autoPlay: boolean; // 场景激活时自动混合播放（与「视频」的 autoPlay 同义）
  readonly audio: VideoBlendAudio;
}
```

- **文档格式 28 → 29（一次配套发布）**：每路从「列表 + 选中」收成**一个素材**（`{ kind, id? }`）。
  迁移函数 `migrateVideoBlendChannels` 取选中那条（没选取第一条）、`kind` 记 `video`（老数据只可能是视频）；
  协议同批 18 → **19**。
- 默认值：`a/b = { kind: "video" }`、`loop: false`、`autoPlay: false`、`audio: "none"`。
- **实现与最初设计的差异（已落地）**：
  - 两路用**嵌套对象** `a` / `b`（而不是扁平的 `clipsA` / `pickedA`）——它们是同一路的两个字段
    （放哪种 / 放哪个），收在一个对象里读起来才是「一路」；
  - **去掉 `enabled`**：新组件走「组件在 = 在用」（`GridMap` 那套），不再背 `VideoOverlay.enabled`
    那份 v19 遗留的兼容字段；
  - **后续追加了 `autoPlay`**（协议 v18）：与「视频」的 `autoPlay` 同义——场景激活 / 前端刚连上时
    不用 GM 点「播放」，前端自己把两路起起来。它是个简单无副作用的开关，进组件规格、走泛型
    `setComponentField`（和 `loop` / `audio` 同一条路）；
  - **后续改了形状（协议 v19）：一路只放一个素材，且可以是图片或视频**（`kind`）。原来是「列表 + 选中」，
    但一个混合层只显示一路，列表给不了额外能力；图片那一档让「静图盖住视频、擦开露出视频」这类用法也能做。
    面板上每路是「图片 / 视频开关 + 选择按钮」（选择按钮弹现有通用选择框）；换种类会**清掉这一路已选的素材**
    （旧素材属于另一种类型）。

## 协议（16 → 17 → 18 → 19 → 20）

- `COMPONENT_TYPE.videoBlend = "VideoBlend"` + `videoBlendDataSchema` 进 `sceneComponentSchema` 的**严格分支**
  （若不进，写坏的 data 会掉进宽松分支被静默收下）；`PROTOCOL_VERSION` 16 → **17**。
- 播放控制复用 `play_video` / `pause_video` / `resume_video` / `stop_video`（命令形状不变，`objectId` 寻址）。
- 新增一条 **`erase_video_mask { objectId, stroke }`**：`stroke` 逐字复用 `eraseStrokeSchema`
  （归一化点 + 归一化半径 + 软边比例，与战争雾同一套）。**与 `erase_mask` 分开**是有意的：
  后者在协议里明确写死 `objectId` = 雾对象 id、雾层在推下去的 `FogOfWar` 里，混用会让两条语义互相污染。
- 老前端不认 `VideoBlend` → 混合层不建（整条场景消息仍合法）；靠握手 4002 挡在连上那一刻
  （与 v13 加 `FogOfWar` 同一条规矩）。
- **v18**：`videoBlendDataSchema` 多一项 `autoPlay`（缺省 `false`）。老前端（v17）不认它 →
  不会自动播（行为丢），照旧靠握手 4002 挡；命令那一组一个字节都没动。
- **v19**：两路从 `{ clips, picked }` 收成 `{ kind, id }`（每路一个素材、图片 / 视频）。老前端（v18）
  按 `clips` / `picked` 读 → 两路都读不到（混合层放不出来），照旧靠握手 4002 挡；命令那一组仍未动。
- **v20**：多一条命令 `fill_video_mask`（`{ objectId, covered }`：整张遮罩填成 1 / 0，Mask 窗口那两个
  「整张」按钮用）。**文档格式不动**；老前端（v19）不认这条命令 → 回一条未知命令，照旧靠握手 4002 挡。

## 编辑器

| 层 | 要加什么 |
|---|---|
| `components.ts` | `ComponentType` union 加 `"VideoBlend"`；`COMPONENT_TYPES` 加一条（`slot: "videoBlend"`、`templateKinds: ["Image"]`、`optionalKinds: ["Image"]`、displayName「视频混合」） |
| `presets.ts` | `ComponentSlot` 加 `"videoBlend"`；`DEFAULT_SLOT_COMPONENT` 加一行；`OBJECT_PRESETS.Image.slots` 加一行；`supportsVideoBlend`（照 `supportsVideo` 写）；`DEFAULT_VIDEO_BLEND_KIND`（v29 起：每路默认视频） |
| `schema.ts` | `videoBlendDataSchema` + `sceneComponentSchema` union 分支；`migrateVideoBlendChannels`（v29） |
| `validation.ts` | 校验块：`VideoOverlay` 与 `VideoBlend` 并存报 **error**（互斥）；素材引用（存不存在 / 对不对得上 `kind`）查不了——那要素材表 |
| `commands/video-blend.ts` | `setVideoBlendChannelKind(channel, kind)` / `setVideoBlendChannelId(channel, id \| null)` / `removeObjectVideoBlend`；`commands/component.ts` 两条 `case` |
| `scene-asset-refs.ts` | 两路的素材 `id` 的 guid ↔ id 换算（图片与视频同一个字段，`mapMediaFields`） |
| 面板 | `VideoBlendFields.tsx`：两路各「图片 / 视频开关 + 选择按钮 + 当前素材 + ×」+ `loop` / `audio` / `autoPlay` + 「打开 Mask 窗口」+ 播放三键；选择按当前种类弹 `ResourcePickerDialog`（`image` / `video`）；`registry.tsx` 注册组（`removable`） |
| Mask 窗口 | `VideoBlendMaskDialog.tsx`：复用 `MapDialogShell` 外壳 + `mask-math` 的像素运算；底图 = B 的缩略图（图片即它自己、视频是首帧）；软边圆刷擦除（软边 **0.5**，有实心核）；右侧两个「**整张盖住（1）/ 整张擦开（0）**」按钮；运行态按批下发 `erase_video_mask`、整张按钮下发 `fill_video_mask`；编辑态纯预览 |
| store | `video-blend-slice` + `store-types` + `initialState` + `history-slice`/`project-slice` 重置 + `store-context` 的 target / 下发 / 补发（照 `fog-reveal` 那套） |
| 后端 | `?info=1` 支持视频探测宽高（`routes/resources.ts`） |

## Unity

- `Presentation/VideoBlend.cs`（新）：**每路按 `kind` 出画面**——视频那一路一个 `VideoPlayer`（各一个子物体）
  → 一张 `RenderTexture`；图片那一路用 `ResourceImageLoader`（与对象自己的贴图同一条路）取一张贴图直接绑材质。
  CPU 遮罩（初始全不透明）+ `Texture2D`；按 `erase_video_mask` 擦、按序重放（素材尺寸变了「重填 + 重放」，与 `FogOfWar` 同构）；
  建一块面片用 `DiceTale/VideoBlend` shader，在**第一路就绪**时显出来（另一路随后上来）。
- `Resources/Shaders/VideoBlend.shader`（新）：`fixed4 a = tex2D(_TexA, uv); fixed4 b = tex2D(_TexB, uv); return lerp(b, a, mask.a) * vertexColor;`
  **不做羽化**：遮罩是软边圆刷画的（核内全擦），双线性过滤已经够柔。
- 遮罩尺寸 = 第一路就绪的素材像素尺寸（视频 `VideoPlayer.width/height`、图片贴图宽高）→ `previewMaskSizeFor`（与编辑器同式）。
- 接线：`Network/Protocol.cs`（组件名 + 命令 + 协议版本）、`Presentation/SceneObjectView.cs`（建视图时把取图加载器交给 `VideoBlend`）、
  `Logic/SceneMirror.cs`（挂载 + **自动播放**：`AutoplayStateOf` / `ShouldAutoplayVideo` 也认 `VideoBlend`，`autoPlay` 走泛型读取器）、
  `Logic/CommandRouter.cs`（路由四条播放命令 + `erase_video_mask` + `PlayVideoBlendAutomatically`；按 `kind` 把一路解析成 URL / 逻辑 ID）。
  **不加镜像强类型字段**（`SceneModel.cs` / `SceneParser.cs` 不动）——按那两处的规矩走泛型读取器。

## 任务清单

- [x] **D1 文档**：类型 + schema + 注册表 + presets + 校验 + 命令 + 资源换算 + 单测（`video-blend.test.ts`）
- [x] **D2 协议**：v17 + 组件 schema + `erase_video_mask` + 契约测试（`protocol-document-contract.test.ts` 加一条）
- [ ] **D3 后端**：`?info=1` 视频探测 + 测试
- [x] **D4 编辑器**：store 切片 + 面板 + Add Component 入口 + Mask 窗口 + 单测 / e2e
      （D4a 数据面板 / D4b-1 播放记账 / D4b-2 Mask 窗口 + 擦除记账；e2e 归 D6）
      ——Mask 窗口的盖层统一画成深色（运行时那边是 A 的画面），与雾窗口「按区域配色」同一套取舍
- [x] **D5 Unity**：`VideoBlend.cs` + `VideoBlend.shader` + 镜像 / 命令接线（Unity MCP 编译 0 error / 0 warning）
- [x] **D6 验证**：`pnpm check` 全绿 + Unity MCP 断言（shader 存在 / 擦除记账 / 空轨迹拒绝 / `ComponentData` 读取路径）
      + **桌面 e2e**：`e2e/video-blend.spec.ts`（编辑态「擦了不落盘」+ `@runtime` 的 `play_video` / `erase_video_mask` / `stop_video`）；
      顺带修了 4 个假前端写死的 `protocolVersion: 16`（协议已 v17，不改会连不上）
- [x] **D7 文档**：CODE-STRUCTURE（协议版本 + 命令表）/ 运行时镜像协议 spec（组件 / 命令 / 客户端表 + v17）/ `client/README` / 本文件
- [x] **D8 自动播放**（后续追加，与「视频」的 `autoPlay` 对齐）：文档字段 + 规格行 + 协议 **v18** +
      Unity（`SceneMirror` 自动播放表认 `VideoBlend`、`CommandRouter.PlayVideoBlendAutomatically`）+
      单测 / e2e（`video-blend.spec.ts` 加一行断言）/ Unity EditMode（泛型读取器）
- [x] **D9 一路一个素材 + 图片**（后续追加）：通道从「列表 + 选中」收成 `{ kind, id? }`（图片 / 视频），
      文档格式 **29** + `migrateVideoBlendChannels` + 协议 **v19**；面板改成「种类开关 + 选择按钮」；
      Unity 图片那一路走 `ResourceImageLoader`（不再只认 `VideoPlayer`）；样例工程抬到 v29
- [x] **D10 Mask 窗口的「整张」两个按钮**（后续追加）：右边原来那几行说明删掉，换成
      「整张盖住（1）/ 整张擦开（0）」——一次把整张遮罩填成 1 / 0。协议 **v20** 加命令
      `fill_video_mask`（`{ objectId, covered }`，与擦一笔共用**同一条有序操作序列**）；
      `mask-math` 加 `fillMaskAlpha`（只动 alpha，Unity 侧 `VideoBlend.FillMask` 是它的移植）；
      Unity 的操作记录从「只有笔画」扩成 `Stroke | Fill` 两档（重放同一套）

## 验收标准

- `pnpm check` 全绿（typecheck + 单测 + lint + 文档统计）；
- 契约测试：协议与文档的 `VideoBlend` 组件名逐字一致、两边都能解析、坏 data 两边都拒；
- e2e：属性面板能加 / 移除「视频混合」组、能编辑两条通道、Mask 窗口能开、擦一笔在运行态下发出 `erase_video_mask`、
  「整张」按钮发出 `fill_video_mask`；
- Unity MCP：脚本刷新后控制台 0 error / 0 warning；`VideoBlend` 视图建立、两个 `VideoPlayer` prepare、遮罩擦除后像素变化有断言；Game 视图截图存证。

## 风险与遗留

- **VideoPlayer → RenderTexture 是新的渲染路径**（现有视频是 `MaterialOverride` 零拷贝）。性能与显存要实测；
  平台解码仍以 **H.264 的 .mp4** 最稳（沿用 `VideoOverlay` 的结论）。
- **遮罩尺寸一致性**依赖「编辑器探测的宽高」与「Unity `VideoPlayer.width/height`」相等——两者应一致，
  但**竖屏 / 旋转元数据**要对齐（编辑器用 `autoOrient`，Unity 用播放器报的宽高），否则笔刷会错位。
- **两组件互斥**靠校验与菜单过滤，不是数据层强制（坏的手写文件仍可并存，前端取 `VideoBlend` 优先）。
- 老编辑器读新文件：新组件走宽松分支保留，不崩、不静默毁数。

## 待确认（我默认取的，可以否决）

1. **两条通道各用「列表 + picked」**（而不是各一个单引用）——因为你选的那条选项描述是「两组 clips + picked」；
   若只想要「各一条」，数据能简化成 `clipA?` / `clipB?`。
2. **`loop` / `audio` 两条共用**（不是 per-channel）。
3. **播放四命令复用**、只新增 `erase_video_mask`（不新增 `play_video_blend` 之类）。
4. **`VideoBlend` 与 `VideoOverlay` 互斥**（同一对象最多其一）。
5. **文档格式版本不动**（纯加法，无迁移），只把协议 +1 到 17。
