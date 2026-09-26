# TASKS：属性面板里「视频」改成可添加 / 可移除

日期：2026-09-26
状态：已完成（`pnpm check` 全绿：typecheck / 1189 单测 / lint / 文档统计）
前置：[[TASKS-网格变成贴图上的组件]]（文档 v28：网格 = 贴图上的可选组件，可加可移除）

> **后续（同日）**：这里的「组件里放添加 / 移除按钮」入口已按用户要求改成 Unity 式的
> **底部 Add Component + 组头移除**，见 [[TASKS-属性面板添加组件]]。本文留作当时的记录：
> 数据模型（`enabled` 保留、文档 / 协议不变）与文档命令 `removeObjectVideo` 仍然有效。

## 目标（用户拍板）

「在后台编辑器的场景对象的属性面板，添加功能：有些组件是可以添加和删除，例如视频、网格地图等，
这样就不用『启用』的属性了。」

范围经确认**只做「视频」**，且**保留 `enabled` 字段、只改界面**：把视频那一组从
「先勾一个『启用』开关、关着时整组只剩开关」改成与**网格地图同一套可选能力模型**——
没加时属性面板只给一个「添加视频」入口，加了才是完整面板、组尾给「移除视频」。
**组件在 = 在用**；`video.enabled` 仍留在数据里（添加时写 `true`），只为兼容旧文件与前端读口。

## 数据模型

**不变**：文档格式版本、协议版本都不动（`enabled` 字段保留、`VideoOverlay` 组件形状不变），
因此**不需要迁移、不需要改 Unity 客户端**。

- 文档命令新增 `removeObjectVideo`（摘掉整个 `VideoOverlay` 组件，列表随组件一起删）；
- 「添加」复用既有命令 `setVideoEnabled(…, true)`（缺组件就按规格补一份 `enabled: true`，

  已挂但旧的 `enabled: false` 就翻回来）——所以它天然覆盖「没加」与「旧的关着」两种入口态。

## 任务清单

- [x] D1 文档：`commands/video.ts` 新增 `removeObjectVideo`（与 `removeObjectGridMap` 同一套：
      没有组件 / 对象不在 = 没变更）；单测补齐
- [x] D2 编辑器 store：`addObjectVideo` / `removeObjectVideo` 两个 action 取代 `setVideoEnabled`
      （`video-slice.ts` / `store-types.ts`）；播放被拒的运行日志措辞改成「视频没启用（…→ 添加视频）」
- [x] D3 属性面板：`registry.tsx` 给视频组加「添加视频」入口（`add-video`）与组尾「移除视频」
      （`remove-video`），入口判据 = `isVideoEnabled`；`VideoFields.tsx` 删掉 `VideoSwitch` 与早返回
- [x] D4 验证：`pnpm check` 全绿；单测（`video.test.ts` / `video-object.test.tsx` /
      `descriptor-rows.test.tsx` / `inspector-groups.test.tsx`）与 e2e
      （`video-object.spec.ts` / `inspector-groups.spec.ts`）从 `video-enable` 改到 `add-video`
- [x] D5 文档：CODE-STRUCTURE（行数 + 描述）/ README（「视频（贴图）」一节）/ 本文件

## 语义后果 / 遗留

- **旧的 `enabled: false` 文件**：属性面板会按「没启用」显示「添加视频」入口，点一下即翻回 `true`；
  「移除视频」则把组件（含列表）整个删掉。前端行为不变（仍读 `enabled`）。
- 网格地图早在 v28 就是这套模型，这次把视频对齐，两者在面板上的交互现在完全一致。
