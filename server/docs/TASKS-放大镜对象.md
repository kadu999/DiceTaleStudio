# TASKS：放大镜对象（点开一扇窗，中间看图、下面挑图）

日期：2026-09-27
状态：**已完成**（D1–D5；`pnpm check` 全绿 + 桌面 e2e 4 条全过 + Unity MCP 编译 0 error / 0 warning、EditMode 18/18）
前置：[[TASKS-战争雾独立对象]]（窗口形态 / 运行态命令的写法）、[[TASKS-视频混合组件]]（弹框 + 运行态记账 /
「数据在文档、命令只是触发器」那套口径）、[[TASKS-属性组与组件一一对应]]（一个组件一个组）

## 目标（用户原话与拍板）

用户原话：

> 再加一个放大镜对象，它是一个动作类型的场景对象。点击打开窗口，窗口中间显示图片，下面显示可以选择的图片。
> 在属性面板添加图片列表，支持精灵。前端也是弹一个这样的界面，只是中间显示图片，没有显示选择按钮，
> 没有关闭按钮，只能后端来关闭。

逐条拍板（本次会话问答的结论）：

1. **换图写进文档**（`picked` = 列表下标）：编辑器窗口里点下面那排小图 = 改这个对象的「当前展示哪一张」。
   运行态下文档一改，既有那条 `sceneHistory.subscribe → scheduleRuntimePush` 就会**整份 `scene_push`**，
   前端窗口跟着换图——**不为「换图」新增命令**（与视频 / 声音 / 传送阵的 `picked` 同一条口径）。
2. **触发在编辑器**：画布上**双击放大镜徽标** = 打开窗口（与传送阵「双击徽标 = 传送」同一套快路径），
   属性面板里也有按钮（平板上双击不可靠）。前端那台机器**没有点击上报这一层**（客户端目前完全没有
   输入 / 点击代码），所以「前端点一下打开」不在这批里。
3. **列表每一项都是精灵素材**：选图框用既有 `ResourcePickerDialog(kind="image", allowSprite)`，
   每一条可以取图集里的一格（`ImageRef.sprite`）。所以列表项直接复用 **`ImageRef`** 这个形状。
4. **前端窗口没有按钮**：中间一张图（等比放进屏幕），没有选择按钮、没有关闭按钮——
   开 / 关都只由后端（编辑器）的两条命令驱动。
5. **端到端**：document + protocol + 编辑器（面板 + 窗口 + 运行态命令）+ Unity（镜像解析 + 窗口 + 命令 + 仲裁）。

## 设计决策

- 它是**动作对象**（`kind: "Magnifier"`，与 `PlaySound` / `Teleport` 同类）：不建视图、不画贴图，
  画布上画一枚**固定的内置放大镜徽标**；它声明的是「告诉前端弹一扇窗、窗里放哪张图」。
- 数据住在**必需组件** `Magnifier` 里（像 `Teleport` 的 `teleport` 槽位），槽位 `magnifier`；
  缺组件（损坏的手写文件）走既有的「修复组件」入口，**不是**可选组件。
- **列表项 = `ImageRef`**（`id` + `width` / `height` + 可选 `sprite` + 可选 `guid`）：
  它本来就是「一张图的引用（可以取一格）」这个形状，所以
  - 选图框（精灵那一档）直接把它造出来；
  - 存盘时 `scene-asset-refs.ts` 把 `id` 换成 GUID（与图片层同一条）；
  - 推送时 `resolveSceneSprites` 把 `spriteGrid`（几行几列）解析进载荷（前端手上没有 `.meta`）。
- **`picked` 是下标（number）而不是某个键**：这是一份**有序的图片列表**（窗口下面那一排），
  「当前展示第几张」天然就是位置。`id` 不能当键（同一张图的**两个不同格子**是两条），
  而「id + 格子」拼一个键要另立一套约定、还要两端口径一致——下标不需要。
  代价是「删掉一条」要顺手把 `picked` 调一格（`removeMagnifierImage` 里就那一处）。
- **遮罩 / 窗口内容不进文档之外的东西**：编辑器窗口只是预览 + 挑图；**没有运行态遮罩**，
  也不像视频混合那样记「擦除轨迹」——唯一的运行态是「这扇窗现在是不是开着」。
- 编辑器**不解码任何东西**：中间那张图与下面那排小图都走既有 `sceneImage` / 缩略图那条路
  （图片是编辑器本来就会画的；精灵那一格用 CSS `background-position` 取）。
- **弹框是模态的**（仓库里没有非模态窗口原语，雾 / 视频混合那两扇窗也是模态）——所以
  「在画面上打开 / 关闭画面」在**属性面板里也有一份**：DM 关掉窗口继续编辑时，前端那扇窗不必跟着关。

## 数据模型

```ts
/**
 * 放大镜（动作对象）的数据：**图片列表 + 当前展示的那一张**。
 *
 * 每一项就是一份图片引用（`ImageRef`，可带 `sprite` = 取图集里的一格）——与贴图 / 精灵引用的
 * 是同一件事，只是不带「显示顺序」（它不渲染在世界里，是弹出来的一扇窗）。
 * 它声明的是「告诉前端弹一扇窗、窗里放哪张图」，编辑器自己不弹前端那扇窗。
 */
export interface MagnifierDataDoc {
  /** 加进来的图片，顺序 = 加进来的先后（就是窗口下面那一排的次序）。空数组 = 还没加图。 */
  readonly images: ImageRef[];
  /** 当前展示的那一张（`images` 的下标，0 起）；缺省 = 还没选（窗口中间写「还没选图」）。 */
  readonly picked?: number;
}
```

- **文档格式 29 → 30**：`OBJECT_KINDS` 多一个 `"Magnifier"`，而 `kind` 在文档 schema 里是
  `z.enum(OBJECT_KINDS)`——老编辑器读新文件会**读不开**。所以照 `Fog`（v27）那条老规矩把格式 +1：
  新文件在新编辑器里正常读写，老编辑器遇到高版本会得到一句**明确的**「请升级编辑器」，
  而不是一个看不懂的 zod 报错。**没有迁移函数**（纯加法：老文件里没有这个 kind，也没有这个组件）。
- 默认值：`images: []`、`picked` 缺省（「没写」= 还没选）。新建出来就是「一扇还没有图的窗」。
- **命令那三条**（都作用于 immer draft，返回 false = 无变更）：
  - `addMagnifierImage(scene, objectId, image)`：追加一条（同一张图的同一个格子已经在列表里就
    不重复加，改成选中那一条）；列表原来是空的 → `picked = 0`（与「加进来一条却没选上」那条老规矩同义）。
  - `removeMagnifierImage(scene, objectId, index)`：移出第 `index` 条，并**收拾 `picked`**——
    移出的正好是选中那张 → 留在同一个下标（也就是原来后面那张），越界就退到最后一个；
    比它大的都减一；一条不剩就把 `picked` 整个删掉（不留空壳）。
  - `setMagnifierPicked(scene, objectId, index | null)`：改「展示第几张」（越界 / 没变 → false）。

## 协议（20 → 21）

- `COMPONENT_TYPE.magnifier = "Magnifier"` + `magnifierDataSchema` 进 `sceneComponentSchema` 的
  **严格分支**（不进的话，写坏的 data 会掉进宽松分支被静默收下）。`magnifierDataSchema` 的每一条
  复用 `imageRefSchema`（连「子图必须落在切分范围内」那条 refine 一起复用）。
- `resourceIdsOfObject` **要扫这个组件的每一张图**：不然前端不会把这几张图放进资源包，
  窗口弹出来是空的（这条漏了最不容易发现——资源包只影响「先下后载」）。
- 两条新命令（都与 `play_video` / `erase_mask` 同一套「命令只是触发器」口径，载荷里不带数据）：
  - **`open_magnifier { objectId }`**：让前端的放大镜窗口显示**这个对象** `picked` 那张图并打开。
    放哪一张从镜像里读——所以「编辑器换了图」不需要再来一条命令（整份 `scene_push` 会带着新值到）。
  - **`close_magnifier { objectId }`**：关掉。带 `objectId` 是为了**认领**（只关「当前正为这个对象
    开着」的那扇窗），避免换场景 / 重连后一条迟到的关闭把新开的窗关掉。
- **`PROTOCOL_VERSION` 20 → 21**：新组件对老前端是「不认 → 那扇窗永远弹不出来」，
  新命令对老前端是「未知命令」。两条都属于「不是崩，是行为丢」，按同一套纪律靠握手 4002 挡住。
- 前端**不需要** `images` 里的 `width` / `height`（窗口按纹理等比放），但要 `sprite` + `spriteGrid`
  算 UV —— 后者由推送那一步解析（`resolveSceneSprites`），与图片层完全同一条路。

## 编辑器

| 层 | 要加什么 |
|---|---|
| `components.ts` | `ComponentType` union 加 `"Magnifier"`；注册表加一条（`slot: "magnifier"`、`templateKinds: ["Magnifier"]`、`repairKinds: ["Magnifier"]`、显示名「放大镜」） |
| `presets.ts` | `ComponentSlot` 加 `"magnifier"`；`DEFAULT_SLOT_COMPONENT` 加一行；`OBJECT_KINDS` 加 `"Magnifier"`；`OBJECT_PRESETS.Magnifier = { slots: { magnifier: "Magnifier" } }`；`supportsMagnifier`（照 `supportsFog` 写） |
| `types.ts` | `MagnifierDataDoc` + `DOCUMENT_FORMAT_VERSION` 29 → 30 |
| `schema.ts` | `magnifierDataSchema` + `sceneComponentSchema` 的 union 分支 |
| `factory.ts` | `createMagnifierObject({ name, images?, position? })`（照 `createTeleportObject`；给了 `images` 就把第一条当作已选中） |
| `access.ts` | `magnifierDataOf` + `ensureMagnifierData`（默认 `{ images: [] }`） |
| `commands/magnifier.ts` | `addMagnifierImage` / `removeMagnifierImage` / `setMagnifierPicked` + barrel |
| `commands/component.ts` | 三条泛型组件命令的 `case`（属性面板的「添加 / 移除组件」要能建出默认数据） |
| `scene-asset-refs.ts` | `Magnifier` 的 `images[]` 逐条 `id ↔ guid` 换算 |
| `sprites.ts` | `resolveSceneSprites` 里给 `Magnifier.images[]` 逐条解析 `sprite` / `spriteGrid`（夹格 + 路径 ID） |
| `validation.ts` | 空列表 → warning（面板上窗口没图可放）；`picked` 越界 → warning（按「还没选」处理） |
| 面板 | `MagnifierFields.tsx`：「图片」一排小图（点 = 换成展示它、每项 `×` 移出、`＋` 弹选图框）+「窗口」行（打开窗口 / 在画面上打开 · 关闭画面）；`registry.tsx` 注册组（**不可移除**，缺组件走修复入口） |
| 窗口 | `MagnifierDialog.tsx`：复用 `MapDialogShell`；中间大图（等比放进可视区）+ 下面那一排可点的小图 + 底栏「在画面上打开 / 关闭画面」；编辑态纯预览 |
| 画布 | 放大镜徽标：`object-kinds.ts` 的 `badgeIconOf` 给 `"magnifier"`，`packages/renderer` 画一个放大镜图形；`ScenePanel.tsx` 的双击认它（打开窗口） |
| store | `magnifier-slice` + `store-types` + `initialState` + `history-slice`/`project-slice` 重置 + `store-context` 的 `magnifierTargetOf` / `deliverMagnifierWindow` / 重连补发 |
| 新建对象 | `object-kinds.ts` 的「动作」种类加一项（`creatable`）+ `game-object-factory.ts` 的工厂表加一行 |

## Unity

- `Protocol.cs`：组件名 `Magnifier`、命令 `open_magnifier` / `close_magnifier`、`Version = 21`
  （两条命令都只用 `objectId`，`CommandRequest` 不必加字段）。
- `Data/SceneModel.cs` + `SceneParser.cs`：加 `MirrorMagnifier`（`List<MirrorImage> images` + `int picked`）
  与 `ParseMagnifier`（**复用既有的 `ParseImage`**，所以 `sprite` / `spriteGrid` 的夹取口径与图片层逐字一致）。
- `Presentation/UI/MagnifierWindow.cs`（新，**代码构建**，与字幕窗 / 场景淡入同一条路，仓库里没有 prefab）：
  全屏半透明底 + 居中一张等比放大的图；**没有任何按钮**，`raycastTarget = false`（不吃点击）；
  `Show(Texture2D, MirrorSprite)` / `Hide()`。图片用 `ResourceImageLoader` 取（本地包优先），
  精灵那一格按 `SpriteLayer.UvRectOf` 的同一套算 UV——用 `Image.sprite` 的 `Sprite.Create` 带 `rect` 实现。
- `Logic/CommandRouter.cs`：`HandleOpenMagnifier` / `HandleCloseMagnifier`；回执与既有命令同一套
  （镜像里没有这个对象 / 没有 `Magnifier` 组件 / 还没选图，各给一句人话）。
- **换图 / 删对象 / 换场景都要跟着变**：`SceneMirror` 加一个 `SceneApplied(string sceneName)` 通知
  （与 `AutoPlayVideoRequested` 同一条「镜像落地后叫一声」的路），`CommandRouter` 收到后：
  窗口开着且目标对象还在这个场景里 → 刷新成 `images[picked]`（**只在图真的换了时才重载**）；
  目标对象不在 / 没有可放的图 → 关掉。
- `Network/BackendManager.cs`：把 `mirror.SceneApplied` 接到命令路由上（一行）。

## 任务清单

- [x] **D1 文档**：类型 + schema（格式 30）+ 注册表 + presets + 工厂 + 访问器 + 三条命令 + 资源换算 +
      子图解析 + 校验 + 单测（`magnifier.test.ts` 27 条）
- [x] **D2 协议**：`COMPONENT_TYPE.magnifier` + `magnifierDataSchema` + `resourceIdsOfObject` +
      `open_magnifier` / `close_magnifier` + 版本 21 + 契约测试（组件名 / 缺省值 / 非法样本三条 + 真跑一遍）
- [x] **D3 编辑器**：store 切片 + 面板 + 修复入口 + 窗口 + 画布徽标与双击 + 单测（14 条）
- [x] **D4 Unity**：`MagnifierReader` + `MagnifierWindow` + 命令路由 + `SceneApplied` 接线
      （Unity MCP：0 error / 0 warning；EditMode 18/18，新增 3 条）
- [x] **D5 验证与文档**：`pnpm check` 全绿 + `e2e/magnifier.spec.ts` 4 条（3 编辑态 + 1 `@runtime`）+
      CODE-STRUCTURE / 运行时镜像协议 spec / `client/README` / 本文件

## 实现时顺手做的（都在这一批里）

- **修了一个真 bug**：`SceneObjectView.NeedsView` 原来只跳过 `PlaySound` / `Teleport`，放大镜对象会被
  建出一个空视图（动作对象一个 GameObject 都不该建）。已加上 `Magnifier`，并由 EditMode 用例钉住。
- **泛型读取器读不了的那一层单独收一处**：`MagnifierReader.TryPickImage`（`Data/MagnifierReader.cs`）
  ——`MirrorObject` / `SceneParser` 一个字节都没动（不然「数组的第 N 项」会把镜像税带回来），
  测试直接打它。
- **一格图的矩形复用 `SpriteLayer.UvRectOf`**：那是全链路唯一一次 y 翻转，放大镜不另写一份。
- **`useFittedBox` 抽进 `dialog-size.ts`**：视频混合 Mask 窗口那份内联的「量实测尺寸 + 按长宽比
  算等比盒子」改成用它——量法只剩一份。
- **`<AssetImage>` 抽成 `panels/asset-image.tsx`**：整张 / 图集某一格，与素材面板的精灵预览同一套算式。
- **`panels/asset-picker.ts` 加 `spriteCellBackgroundPosition`**：精灵预览的格子偏移原来两处各写一遍。

## 验收标准

- `pnpm check` 全绿（typecheck + 单测 + lint + 文档统计）；
- 契约测试：协议与文档的 `Magnifier` 组件名逐字一致，两边都拒写坏的 data；
- 文档：三条命令的边界（重复加同一格、删中间那一条时 `picked` 的跟随、越界 `picked`）都有单测；
- 编辑器：属性面板能建出放大镜对象、加 / 移出图片、在窗口里换图（换图**落盘**、可撤销）；
- e2e：运行态下「在画面上打开 / 关闭画面」发出 `open_magnifier` / `close_magnifier`；
  编辑态点小图只写文档、不发命令；
- Unity MCP：脚本刷新后控制台 0 error / 0 warning；窗口能开 / 关，换图后重载的是新那张。

## 风险与遗留

- **编辑器窗口是模态的**（仓库没有非模态原语）：所以「在画面上打开 / 关闭画面」在属性面板里也放了一份，
  DM 不必留着窗口。真要「浮在画布上不挡编辑」的窗口，那是另一件事（要新造一层非模态原语）。
- **前端那台机器点不开**：客户端没有输入层，也没有「上报点击」的协议。真要做「前端点一下放大镜就弹窗」，
  是单独一批（相机射线 + 命中对象 + 新消息 + 后端判定），本批不含。
- **`picked` 用下标**：手写文件里改列表顺序 / 插一条，会让「展示第几张」跟着挪位。校验只会报
  「越界」，不会替你修——这是有意的（推断「他本来想看哪张」比报一句更危险）。
- **窗口同时只有一扇**（`UIManager` 一个类型一个实例）：后开的放大镜会顶掉前一个。
  现场同时要看两张图就再放一个放大镜对象、来回切——两扇窗叠着是另一件事。
- 老编辑器读新文件：`kind` 枚举对不上 → 明确的「请升级编辑器」（格式 30 的作用就是这个）。

## 待确认（我默认取的，可以否决）

1. **「点击打开窗口」= 编辑器里双击徽标 + 面板按钮**（前端那台机器的点击上报不在本批，见上）；
2. **窗口同开同关由编辑器的按钮决定**，关掉编辑器那扇窗**不**连带关前端那扇（DM 要能关掉窗口继续编辑）；
3. **列表一项 = 一份图片引用**（可以取某一格），不是「只能整张图」；
4. **`picked` 是下标**（不是 id / 不是「id::格子」拼的键）；
5. **换图不新增命令**（靠整份 `scene_push` 同步），只新增开 / 关两条命令。
