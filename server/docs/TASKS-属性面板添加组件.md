# TASKS：属性面板改成 Unity 式「添加组件 / 移除组件」

日期：2026-09-26
状态：已完成（`pnpm check` 全绿 + 相关 e2e）
前置：[[TASKS-视频变成可选组件]]（组件可加可移除，但入口在各自组里）

## 目标（用户拍板）

「属性面板添加组件，改成和 Unity 那样：在**底部**有一个 **Add Component** 按钮来选择添加的组件，
不是现在这样在组件里面加一个添加按钮和删除按钮。」

选定做法：

- 面板**底部**一个「添加组件」按钮（Unity 的 Add Component），点开列出这个对象**还能加**的组件
  （可选能力：网格地图 / 视频），选一个就加上；
- **可选组件没挂上时不再单独出组**（旧做法是「未添加」的能力入口里放一枚「添加」按钮）；
- 可选组件挂上后是正式组，**组头**一枚 ✕ = 移除该组件（Unity 组件头的 Remove Component）；
- 必需组件（图片层 / 精灵层 / 声音 / 传送 / 战争雾）**不给移除**——摘掉会把对象弄坏。
  坏文件里缺必需组件时的「修复」入口照旧（仍挂「未添加」角标）。

## 数据模型

**不变**：文档格式版本、协议版本都不动，Unity 客户端不用改。

- 文档命令新增一对**统一入口**：`commands/component.ts` 的 `addObjectComponent` /
  `removeObjectComponent`——按组件类型分派到既有命令（网格走 `addObjectGridMap` / 移除；
  视频走 `setVideoEnabled(true)` / `removeObjectVideo`）。加第三种可选组件只在这里加一条 `case`；
- store：`component-slice` 新增 `addObjectComponent` / `removeObjectComponent`；
  删掉只服务旧界面的 `addObjectVideo` / `removeObjectVideo` / `addObjectGridMap` / `removeObjectGridMap`
  四条 action（文档命令仍保留，供统一入口分派）。

## 任务清单

- [x] D1 文档：`commands/component.ts`（统一入口）+ `commands/index.ts` 导出
- [x] D2 store：`component-slice` 两个泛型 action；settle 到 `store-types`；旧的四条 action 删除
- [x] D3 属性面板：`registry.tsx` 去 `availableWithoutComponent`、加 `removable` 与
      `addableComponentsFor`；`componentEditorsFor` 只收「已挂上 + 缺必需组件的修复入口」；
      `InspectorPanel.tsx` 底部 `AddComponentMenu`；`fields.tsx` 的 `FieldGroup` 支持组头移除
- [x] D4 验证：`pnpm check` 全绿；单测（`video-object` / `inspector-groups` / `descriptor-rows`）
      与 e2e（`video-object` / `inspector-groups`）改到「添加组件 / 组头移除」
- [x] D5 文档：CODE-STRUCTURE（命令表 + store 行 + 注册表行）/ README / 本文件

## 语义后果 / 遗留

- **旧的 `enabled: false` 视频**：组件还在，所以照常出「视频」组（不暴露开关，播放会被前端拒）；
  要彻底清掉用组头的 ✕。
- 「添加组件」用**内联展开**而不是浮层：属性面板本身是滚动容器，浮层会被裁切；可选组件通常只有
  两三项，展开不占地方。展开状态随对象切换重置（`object-properties` 按对象 id 重建）。
- 底部按钮只在**还有可加组件**时出现（比如精灵就没有）。
