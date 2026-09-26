# TASKS：视频混合组件（用 Mask 混合两条视频）

日期：2026-09-26
状态：**需求已确认，待实施**
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
- **`VideoOverlay` 与 `VideoBlend` 互斥**：一个对象最多挂二者之一（各占一个槽位，机制上不再禁止，所以要显式管）。
  Add Component 菜单里挂着其一时不再列另一个；`validateScene` 对并存报一条 warning。
- 遮罩的初始形态**不是**「格子区域位」（视频没有网格），就是**整张不透明**：所以没有 `regions`、
  没有 `reveal_fog_region` 那种整区开关，组件数据里也不存任何遮罩状态。
- 编辑器窗口的底图**不能是视频**（编辑器不解码、不预览，见 `VideoOverlay.cs` 头注）：用两条视频的
  **首帧缩略图**拼出预览——B 的缩略图铺底、A 的缩略图按遮罩盖在上面，「擦开露出 B」在窗口里肉眼可见。
  缩略图走既有 `GET /api/resources/thumbnail?id=`（视频走 ffmpeg 抽首帧）。
- 遮罩尺寸依据**视频像素尺寸**：后端 `?info=1` 现在对视频是明确拒绝的（「视频不支持 info=1」），
  **扩成支持**（复用已有的 ffmpeg 抽帧能力探测宽高）——这是编辑器拿到视频尺寸的正路。
- 播放控制**复用**既有四条命令（`play_video` / `pause_video` / `resume_video` / `stop_video`，都按 `objectId`）：
  前端在对象上找视频承载组件，是 `VideoBlend` 就**同时起停两条**。只有「擦一笔」是新命令。

## 数据模型

```ts
/**
 * 视频混合组件的数据：两条视频通道（A 盖住 / B 露出）+ 循环 + 声音来源。
 * 遮罩**不在数据里**——它是纯运行态（见目标第 3 条），组件只声明「放什么」。
 */
export interface VideoBlendDataDoc {
  /** 总开关（与 `VideoDataDoc.enabled` 同口径：只有开着前端才建混合层）。 */
  readonly enabled: boolean;
  /** 通道 A（盖在上面的那条）：加进来的视频列表 + 选中的那条。 */
  readonly clipsA: string[];
  readonly pickedA?: string;
  /** 通道 B（擦开露出的那条）：同上。 */
  readonly clipsB: string[];
  readonly pickedB?: string;
  /** 两条一起循环（先共用；两条节奏确实不同时再拆成 per-channel）。 */
  readonly loop: boolean;
  /** 出哪条的声音：`none`（缺省，与视频的「缺省静音」同一口径）/ `a` / `b`。 */
  readonly audio: "none" | "a" | "b";
}
```

- **文档格式版本不动（28）**：纯加法——旧文件不含它、照常解析；新文件里的新组件由
  `sceneComponentSchema` 的 `permissiveComponentSchema` 宽松分支兜底老编辑器（保留、不删、不崩）。
  无迁移（新组件没有历史扁平字段，不属于 `FEATURE_COMPONENT_TYPES`）。
- 默认值：`enabled: true`、`clipsA/clipsB: []`、`loop: false`、`audio: "none"`。

## 协议（16 → 17）

- `COMPONENT_TYPE.videoBlend = "VideoBlend"` + `videoBlendDataSchema` 进 `sceneComponentSchema` 的**严格分支**
  （若不进，写坏的 data 会掉进宽松分支被静默收下）；`PROTOCOL_VERSION` 16 → **17**。
- 播放控制复用 `play_video` / `pause_video` / `resume_video` / `stop_video`（命令形状不变，`objectId` 寻址）。
- 新增一条 **`erase_video_mask { objectId, stroke }`**：`stroke` 逐字复用 `eraseStrokeSchema`
  （归一化点 + 归一化半径 + 软边比例，与战争雾同一套）。**与 `erase_mask` 分开**是有意的：
  后者在协议里明确写死 `objectId` = 雾对象 id、雾层在推下去的 `FogOfWar` 里，混用会让两条语义互相污染。
- 老前端不认 `VideoBlend` → 混合层不建（整条场景消息仍合法）；靠握手 4002 挡在连上那一刻
  （与 v13 加 `FogOfWar` 同一条规矩）。

## 编辑器

| 层 | 要加什么 |
|---|---|
| `components.ts` | `ComponentType` union 加 `"VideoBlend"`；`COMPONENT_TYPES` 加一条（`slot: "videoBlend"`、`templateKinds: ["Image"]`、`optionalKinds: ["Image"]`、displayName「视频混合」） |
| `presets.ts` | `ComponentSlot` 加 `"videoBlend"`；`DEFAULT_SLOT_COMPONENT` 加一行；`OBJECT_PRESETS.Image.slots` 加一行；`supportsVideoBlend`（照 `supportsVideo` 写） |
| `schema.ts` | `videoBlendDataSchema` + `sceneComponentSchema` union 分支 |
| `validation.ts` | 校验块：`picked` ∈ `clips`、空 clip 报错；`VideoOverlay` 与 `VideoBlend` 并存报 warning |
| `commands/video-blend.ts` | `setVideoBlendClips(channel, clips)` / `setVideoBlendPicked(channel, clipId)` / `removeObjectVideoBlend`；`commands/component.ts` 两条 `case` |
| `scene-asset-refs.ts` | `clipsA/pickedA/clipsB/pickedB` 的 guid ↔ id 换算 |
| 面板 | `VideoBlendFields.tsx`：两组通道（各「加列表 + 选一条」）+ `loop` + `audio` + 「打开 Mask 窗口」+ 播放三键；`registry.tsx` 注册组（`removable`） |
| Mask 窗口 | `VideoBlendMaskDialog.tsx`：复用 `MapDialogShell` 外壳 + `mask-math` 的像素运算；底图 = A/B 首帧缩略图；运行态按批下发 `erase_video_mask`；编辑态纯预览 |
| store | `video-blend-slice` + `store-types` + `initialState` + `history-slice`/`project-slice` 重置 + `store-context` 的 target / 下发 / 补发（照 `fog-reveal` 那套） |
| 后端 | `?info=1` 支持视频探测宽高（`routes/resources.ts`） |

## Unity

- `Presentation/VideoBlend.cs`（新）：两个 `VideoPlayer`（各一个子物体）→ 两个 `RenderTexture`；
  CPU 遮罩（初始全不透明）+ `Texture2D`；按 `erase_video_mask` 擦、按序重放（数据变了「重填 + 重放」，与 `FogOfWar` 同构）；
  建一块面片用 `DiceTale/VideoBlend` shader，隐藏对象自身 Renderer（沿用 `VideoOverlay` 的「首帧前不显示」「失败恢复」）。
- `Resources/Shaders/VideoBlend.shader`（新）：`fixed4 a = tex2D(_TexA, uv); fixed4 b = tex2D(_TexB, uv); return lerp(b, a, mask.a) * vertexColor;`
  羽化复用 `DiceTale/FogBlur` 链（遮罩是白的，模糊只作用于 alpha）。
- 遮罩尺寸 = `VideoPlayer.width/height` → `previewMaskSizeFor`（与编辑器同式；`Prepare` 后才知道尺寸，先不建、`prepareCompleted` 再建）。
- 接线：`Network/Protocol.cs`（组件名 + 命令）、`Data/SceneModel.cs`（镜像字段）、`Data/SceneParser.cs`（case）、
  `Logic/SceneMirror.cs`（挂载）、`Logic/CommandRouter.cs`（路由 `erase_video_mask`）。

## 任务清单

- [ ] **D1 文档**：类型 + schema + 注册表 + presets + 校验 + 命令 + 资源换算 + 单测（`video-blend.test.ts`）
- [ ] **D2 协议**：v17 + 组件 schema + `erase_video_mask` + 契约测试（`protocol-document-contract.test.ts` 加一条）
- [ ] **D3 后端**：`?info=1` 视频探测 + 测试
- [ ] **D4 编辑器**：store 切片 + 面板 + Add Component 入口 + Mask 窗口 + 单测 / e2e
- [ ] **D5 Unity**：`VideoBlend.cs` + `VideoBlend.shader` + 镜像 / 命令接线
- [ ] **D6 验证**：`pnpm check` 全绿 + 相关 e2e + Unity MCP（编译 0 error / 0 warning + 断言 + Game 视图截图）
- [ ] **D7 文档**：CODE-STRUCTURE / README / 运行时镜像协议 spec / 本文件

## 验收标准

- `pnpm check` 全绿（typecheck + 单测 + lint + 文档统计）；
- 契约测试：协议与文档的 `VideoBlend` 组件名逐字一致、两边都能解析、坏 data 两边都拒；
- e2e：属性面板能加 / 移除「视频混合」组、能编辑两条通道、Mask 窗口能开、擦一笔在运行态下发出 `erase_video_mask`；
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
