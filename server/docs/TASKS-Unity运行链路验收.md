# Unity 运行链路验收任务清单

> 来源：`PLAN-组件驱动与kind退役.md` 第 99-100 行的「下次继续」顺序。
> 目的：补齐 Unity GPU 绘制、外部图片本地/HTTP 加载与视频播放验证，并把结果写回 PLAN 文档。
> 日期：2026-09-24

## 环境现状（开工前确认）

- 后端 `1420`：运行中 ✓（2026-09-24 确认）
- Unity MCP `http://127.0.0.1:8080/mcp`：v3.4.7，48 个工具 ✓
- Unity `6000.3.19f1`：运行中（Edit 模式）✓
- 编辑器 Vite `5173`：已停止，需启动 ✗
- `client/ProjectSettings/EditorSettings.asset` 的 `m_EnterPlayModeOptions`（0→1）为工作区改动、排除在提交外，**不要直接覆盖**

## 执行方式

无头执行：不依赖浏览器点击，通过后端 WS `/editor` 直连发送 `editor_hello` → `scene_push` → `runtime_start`；
Unity 侧检查通过 MCP `execute_code` / `read_console` / `manage_editor` 完成。

## 任务列表

### 任务 1：启动 Vite + 确认 Unity 场景

- [x] 启动编辑器 Vite `5173`（`pnpm --filter @dts/editor dev`，后台）— 已监听，`http://localhost:5173/` 返回 200
- [x] 通过 MCP 确认 Unity 当前打开 `client/Assets/DiceTale/Scenes/Demo.unity`，控制台 0 error / 0 warning

### 任务 2：运行态激活 + Unity Play + 链路确认

- [x] WS 连接后端 `/editor`：`editor_hello`（PROTOCOL_VERSION=12）→ 推送 `场景1` 场景文档 + 项目设置 → `runtime_start`
- [x] MCP 令 Unity 进入 Play
- [x] `GET /api/state` 同时满足：`runtimeActive=true`、Unity 客户端已连接、资源包 `ok=true`
- [x] Unity 控制台无新增 error/warning

### 任务 3：SceneMirror 模型与视图断言

- [x] 当前镜像 5 个对象，动作对象（PlaySound/Teleport 类）**无视图** — 播放声音/传送阵 view: NONE ✓
- [x] 地图/图片对象挂载的 renderer（`ImageLayer`/`SpriteLayer`/`GridMap`）与组件一致 — 地图→Map001.png 1920x1080、精灵→Lock.png 4096x4096、贴图→Bridge.png 256x256，shader=DiceTale/ImageLayer ✓
- [x] `MeshFilter.sharedMesh`、`MeshRenderer`、材质 shader/纹理已建立 — 三个视图均 verts=4/tris=2、材质与纹理非空 ✓

### 任务 4：GPU 绘制验证

- [x] Game 视图截图或 RenderTexture 像素抽样：非空、地图及对象可见 — 1134x567，blackRatio 41.9%，distinctColors 27546；截图可见地图全貌元素（道路/河流/桥）、精灵挂锁、贴图桥，GPU 实际绘制确认
- [x] 记录 GPU/Shader 错误（控制台 + 截图证据）— 控制台 0 error / 0 warning，无 magenta 着色器失败，shader=DiceTale/ImageLayer 正常

### 任务 5：图片加载验证

- [x] 资源包内本地图片读取成功（纹理非空、尺寸正确）— Map001.png 1920x1080 / Lock.png 4096x4096 / Bridge.png 256x256，与源 PNG 尺寸逐一核对一致 ✓
- [x] 一个资源包未包含的图片经 HTTP fallback 加载成功 — 移走 bundle 内 A.png 后 `LocalUrlOf=null`，经 `/api/resources/raw` 回退加载 4096x2048 入缓存、未进失败名单；测试后已恢复缓存文件 ✓

### 任务 6：VideoOverlay 视频播放验证

- [x] 运行态对带 `VideoOverlay` 的地图触发「播放」 — `play_video` 命令 ok=true；VideoPlayer `isPrepared=True isPlaying=True`，本地包 `file:///...video/Map001.mp4`，`quadRenderer.enabled=True`/`mapRenderer.enabled=False`（视频面片替代地图）✓
- [x] `VideoPlayer` prepare 成功、首帧显示 — player.texture=2560x1440；Game 视图截图可见河流流动水纹视频帧覆盖地图区域 ✓
- [x] 暂停/继续/停止正常 — 暂停冻结在 time=1.00（isPaused=True）；停止后 VideoOverlay 子物体销毁（children=0）、地图 Renderer 恢复 enabled ✓；**发现**：`resume_video` 实际从头重播（time 归零）而非从暂停处续播，已记录
- [x] 失败日志可定位 — 404 路径产生 `WindowsVideoMedia error 0xc00d001a` + `[视频] 播放失败` + `[视频] 等首帧超时（15 秒）` 完整诊断链 ✓
- [x] **发现缺陷（本轮最重要）**：视频 clip 以素材 guid 下发（编辑器 `resolveSceneSprites` 只翻译图片引用），客户端 `VideoUrlOf` 拿 guid 走 `/api/resources/raw?id=<guid>` → 404，**真实编辑器流程下视频播放同样不可用**；声音 clip 同形式、疑同陷。验收采用 guid→`project:` 翻译后的载荷绕开，视频管线本身验证通过

### 任务 7：退出运行态与还原语义

- [x] 退出编辑器运行态（`runtime_stop`）、停止 Unity Play — `/api/state` 全清空（runtimeActive=false、client/scene/resources/settings 均 null）；Unity 已回 Edit ✓
- [x] 确认还原语义：镜像清理、无残留视图/对象 — Play 模式对象随退出销毁，控制台清空后 0 error/0 warning ✓
- [x] 确认仓库样例项目未被改动/保存 — git status 仅新增本文档；`EditorSettings.asset` 的 m_EnterPlayModeOptions 工作区改动已被 Unity 自行归位（与 HEAD 一致），非本轮回滚 ✓

### 任务 8：回归与文档写回

- [x] 视验证结果补充回归测试 — `runtime-push.test.ts` 补 2 条 `it.skip` 钉住 clip-guid 缺陷（修复后启用）；`architecture.test.ts` 补 kind 行为分支扫描约束（2 条，8/8 通过）
- [x] 把 GPU/外部图片/视频结果写回 `PLAN-组件驱动与kind退役.md` — 已写入本轮验收记录、缺陷 1（clip guid 404）/缺陷 2（resume 重播）、环境记录与剩余工作

### 任务 9：阶段 3/4 状态更新

- [x] 确认「kind 只剩显示/分类/模板/迁移职责」的架构测试约束是否已落地 — 原本未落地；本轮已在 `test/architecture.test.ts` 实现（PascalCase 字面量行为分支扫描 + schema 迁移唯一例外 + 反向断言），8/8 通过
- [x] 更新阶段 4 盘点状态 — 用户确认无外部数据；改用**合成覆盖法**（迁移链 = 历史形状全集）落地 `legacy-inventory.test.ts` 18 项，全部通过；PLAN 已记录结论并冻结退役议程

## 注意事项

- 运行态期间**不得**改动或保存仓库样例项目（`测试项目`）
- 全部验收完成后退出运行态，Unity 回到 Edit

## 后续补做（2026-09-25）

- [x] 复核「clip guid 404」：确认为无头推送绕过编辑器加载层（`sceneAssetRefsToIds`）所致，**非产品缺陷**，已在 PLAN 撤回；删除误加的 2 条 skip 测试（测错层）
- [x] 修复 `resume_video` 从头重播：`VideoOverlay.Resume()` 改为先存 `player.time`、`Play()` 后由协程等 `isPlaying` 再寻位（开播瞬间同步赋值会被盖掉，第一版修法实测无效）；`StopPlayback` 清理协程
- [x] 重新编译并实测验证：暂停 P=3.00 → resume → time=3.46 继续上行 ✓；播放/暂停/停止回归正常；控制台 0 error/0 warning；退出运行态与 Play，仓库零改动
- [x] 待人工：真实浏览器端到端点击一次（编辑器 UI → 运行 → 视频播放/暂停/继续/停止）— 用户已于 2026-09-25 完成，确认没问题
