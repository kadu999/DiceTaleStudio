# TASKS：属性面板「组 ↔ 组件」一一对应 + FogOfWar 拆分

> 目标：后台编辑器属性面板里每一**组件组**一一对应一个**组件**；GridMap 里的战争雾
> 拆成独立组件 `FogOfWar`（formatVersion 24→25）。
> 实体属性（名称/变换等）保留在「基础」组，不进组件；能力入口（未添加时的开关/选图/修复）
> 显式标记为 capability，不伪装成组件组。

## 组件清单（目标结构）

| 组件 | 组标题 | 功能 | 适用对象 |
|---|---|---|---|
| —（实体属性） | 基础 | 名称/类型/激活/锁定/排序/位置/缩放/旋转 | 全部 |
| `GridMap` | 网格地图 | 地图贴图 + 网格（列/行/行序/格子 RLE/显示/标注） | Map |
| `FogOfWar` ★新增 | 战争雾 | 总开关 + 雾区（引用 GridMap 区域位，从属 GridMap） | Map |
| `ImageLayer` | 图片层 | 对象显示图，整张铺满 | Image/Player/Item/Event |
| `SpriteLayer` | 精灵层 | 精灵图，可取图集一格 | Sprite |
| `PlaySound` | 播放声音 | 音频列表 + 选中项 + 层级 | PlaySound |
| `Teleport` | 传送阵 | 目标场景列表 + 选中项（触发 = 切场景） | Teleport |
| `VideoOverlay` | 视频 | 视频列表 + 选中项 + 循环/声音开关 | Map/Image（可选） |

## 任务清单

### Phase 1：UI 层一一对应（只改 editor）

- [x] **P1.1+P2.9** editor 最终分组形态：`registry.tsx` 一组件一组（slug `map`/`fog`/`image`/`sprite`/`sound`/`teleport`/`video`，
      标题 = 组件 displayName）；`FogFields.tsx` 改读 `FogOfWar` 组件 ✅ 2026-09-25
- [x] **P1.2** `fields.tsx` FieldGroup 三类组角标（entity/capability），InspectorPanel 按「组件实例在不在」接线 ✅ 2026-09-25
- [x] **P1.3** `InspectorPanel.tsx` 注释重写（三类组说明）✅ 2026-09-25
- [x] **P2.10** 测试：document（fog 命令/校验/v25 迁移新增用例）、protocol（fog 组件化）、editor 组序
      （`["basic","map","fog","video"]` 等 + 角标断言）、backend 契约（legacyField 规则更新）——
      vitest 80 文件 1186 用例全绿，typecheck/lint 干净 ✅ 2026-09-25

### Phase 2：FogOfWar 拆分为独立组件（数据层 v24→v25）

- [x] **P2.1** `document/src/types.ts`：`DOCUMENT_FORMAT_VERSION` 24→25；`MapDataDoc` 删 `fog`；
      `MapFogDoc` → `FogOfWarDataDoc`（形状不变）；`ComponentType` 联合加 `"FogOfWar"` ✅ 2026-09-25
- [x] **P2.2** `document/src/components.ts`：注册 `FogOfWar`（slot `"fog"`、templateKinds/optionalKinds `["Map"]`）✅ 2026-09-25
- [x] **P2.3** `document/src/presets.ts`：`ComponentSlot` + `"fog"`；`DEFAULT_SLOT_COMPONENT`；
      `OBJECT_PRESETS.Map.slots`；新增 `supportsFog()` ✅ 2026-09-25
- [x] **P2.4** `document/src/schema.ts`：`migrateMapFogToComponent`（GridMap data.fog → FogOfWar 组件实例，
      确定性 id），挂进 `parseSceneFile` 迁移链（features 之后），needsRewrite 并入 ✅ 2026-09-25
- [x] **P2.5** `protocol/src/messages.ts`：`PROTOCOL_VERSION` 12→13；`COMPONENT_TYPE.fog`；
      `sceneComponentSchema` union 加 fog 分支；`mapDataSchema` 删 fog ✅ 2026-09-25
- [x] **P2.6** `document/src/access.ts`：`fogOf` / `isFogEnabled` / `fogDraftOf` / `ensureFogData` ✅ 2026-09-25
- [x] **P2.7** `commands/fog.ts` 新建（setFogEnabled/setFogRegions/fogMaskOf）；
      `commands/grid-map.ts` 清旧 fog 命令（clearMapFog 保留，mask 走 fogMaskOf）；
      editor-store（fog-slice / store-context）接线 ✅ 2026-09-25
- [x] **P2.8** `document/src/validation.ts`：fog 校验移到 FogOfWar 组件（未知位/开无区/关有区），
      地图块移除 ✅ 2026-09-25
- [x] **P2.9** editor：`registry.tsx` 加 FogOfWar 条目（panel `"fog"`）；`FogFields.tsx` 改读 fog 组件 ✅ 2026-09-25
- [x] **P2.10** 测试：document（v25 迁移 + fog 命令）、protocol、editor 组序（`["basic","map","fog","video"]`）、
      backend 契约测试 ✅ 2026-09-25（见 Phase 1 区 P2.10 条目的详细说明）
- [x] **P2.11** Unity 同步：`Protocol.cs`（Version 13 + `ComponentType.FogOfWar`）/ `SceneModel.cs`（`MirrorFog`，
      `fog == null` = 没开雾）/ `SceneParser.cs`（按组件解析，未知组件保留不动）/ `SceneObjectView.cs` /
      `FogOfWar.cs` / `CommandRouter.cs`（三档拒绝原因）；新增 3 条 EditMode 测试
      （编译级验证通过；Test Runner 实跑待 Unity 空闲）✅ 2026-09-25
- [ ] **P2.12** 全量验证：`pnpm check` + e2e smoke + e2e 用例更新 + CODE-STRUCTURE.md

## 关键约束

- 组件名 `FogOfWar` 三处（document / protocol / Unity）逐字一致，契约测试
  `apps/backend/test/protocol-document-contract.test.ts` 兜底。
- 「fog 整个不在 = 没开雾」语义保持：关闭且 regions 空 → 删组件；开关打开才建组件。
- v25 文件被旧编辑器拒绝是设计行为（schema.ts 高版本闸），迁移依赖 git 兜底。
- `clearMapFog` 与格子数据的耦合留在 grid-map.ts，不波及 `@dts/grid` 包的数据结构。

## 进度日志

- 2026-09-25 方案确认，任务书建立。
- 2026-09-25 P2.1–P2.10 完成：FogOfWar 组件化（文档 v25 / 协议 v13）、属性面板一组件一组、
  三类组角标（实体/组件/能力入口）。服务端 vitest 80 文件 1186 用例全绿，typecheck/lint 干净。
- 2026-09-25 P2.11 完成：Unity 侧 Protocol v13 + `FogOfWar` 组件解析（子代理实施，编译级验证 0 error，
  11/11 解析 harness 通过）。client/README.md 旧措辞已同步。
- 2026-09-25 P2.12 进行中：e2e 用例已全部改到新口径（inspector-groups 重写、
  fog-mask / fog-reveal / grid-annotate 夹具改挂 `FogOfWar` 组件、helpers 的
  `readSceneFog*` 改读组件；video-object / sound-object / teleport 的旧 slug 定位符已修）；`pnpm check`（typecheck+test+lint+docs 统计）全绿；
  CODE-STRUCTURE.md 统计与描述已同步。全量 e2e 串行跑验证中（本机 6 核，
  并行跑 canvas 像素类用例会资源争抢超时，串行全绿即算过；参考机 28 核默认 4 workers）。
  注意（已解决）：4 条假前端 @runtime 用例（fog-reveal / global-bgm / sound / video 的「命令下发」）
  一度失败——根因是 e2e 假客户端 `client_hello` 里写死的 `protocolVersion: 12` 与服务端 v13 握手被拒
  （正是版本握手纪律的设计行为；此前 stash 实验被残留后端进程污染、误判为既有问题）。4 处已改 13，
  @runtime 组 10/10 全过。
- 2026-09-25 P2.12 完成：全量 e2e 失败清零（hierarchy / scene-menu / global-bgm 是
  helpers 里 `CURRENT_SCENE_FORMAT_VERSION = 24` 硬编码过期，已改 25；video-object /
  sound-object / teleport 的旧 slug 定位符已修）；`pnpm check` 全绿；CODE-STRUCTURE.md、
  client/README.md、TASKS 文档全部同步。P2.11 的 3 条新 EditMode 测试经 Unity MCP 实跑
  **3/3 通过**。全部任务完成。
