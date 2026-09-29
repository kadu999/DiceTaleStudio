# AI 工作指引

本文件是给 AI 编码工具的仓库导航与工作约定。它只保留高价值、稳定的规则；具体实现细节以源码和下方链接的现行文档为准。不要把历史计划当成当前状态。

## 开始任务

1. 先看 `git status --short`，保留已有工作，不覆盖或回退不属于本任务的改动。
2. 先定位需求对应的源码、测试和调用链，再读相关文档；不要先通读整仓或按旧计划猜当前架构。
3. 先把需求归类：
   - **简单数据字段**：检查 `server/packages/document/src/component-specs/`、`setComponentField` 和 Inspector 的 `DescriptorRows` 是否适用。规格只覆盖简单标量；列表、素材选择、弹框和有副作用的字段仍走专用逻辑。
   - **新交互 / 行为**：沿现有命令、store、面板和运行时路径实现，不要为了少改文件把不同职责硬合并。
   - **跨层或 Unity 功能**：先列简短改动面和验收点，再按数据流逐层追踪；不要假定 TypeScript 改动自动完成了 C# 镜像或运行时行为。
4. 小任务直接实现；只有跨包、跨语言、数据迁移或行为边界不清时，先给简短方案。避免没有明确收益的大重构。

## 必须遵守的架构约定

- **数据归属**：服务端文档是唯一真源；Web 编辑器修改文档，Unity 客户端是镜像与表现层。先沿现有数据流找写入点和消费点。
- **共享数据形状**：优先使用 `server/packages/contract/` 的既有 schema 和常量。`document`（磁盘）与 `protocol`（wire）各自的变体及差异按现有模式维护；不要新建第三份手抄清单。
- **生成文件**：不要直接编辑生成物。修改源后运行 `pnpm gen:contract`；用 `pnpm check:contract` 校验。
- **简单字段**：组件规格仅接管可安全泛型读写的字段，不驱动 Zod schema；不要把有副作用的字段塞进通用写入。组件规格是渐进采用，不是假设所有组件都已注册。
- **Unity 字段**：优先使用 `SceneModel.cs` 的 `ComponentData` / `ComponentBool` / `ComponentString` / `ComponentNumber` / `ComponentObject` / `ComponentArray` 读取原始组件数据。除数组项等泛型读取无法表达的语义外，不重复添加镜像字段或 `SceneParser` 解析行。新增常量按生成器流程处理。
- **依赖边界**：遵循 `server/test/architecture.test.ts` 强制的包依赖方向；资源走逻辑 ID / `ResourceProvider`，不要在业务代码硬编码资源路径或绕过文件系统边界。
- **版本判据**：不要因“新增了字段”就自动抬版本。按 `server/docs/SPEC-版本与迁移判据.md` 判断旧读者是否会读错；协议新增命令等兼容性变化需按该文档评估。
- **保留语义**：不要为了让测试通过而放宽断言、删除有效测试或修改无关夹具。发现基线失败时，先确认是否由本次改动引入，并如实报告。

## 验证：从窄到宽

在 `server/` 目录运行。根据改动范围逐步验证，不要求每个小改动一开始就跑完整矩阵：

1. 先跑受影响的测试，例如 `pnpm exec vitest run apps/editor/test/video-object.test.tsx`；也可将路径替换为对应测试文件。
2. 按受影响包运行类型检查，例如 `pnpm --filter @dts/document typecheck` 或 `pnpm --filter @dts/editor typecheck`。
3. 契约 / 生成源变更运行 `pnpm check:contract`；需要更新生成物时先运行 `pnpm gen:contract`。
4. UI 流程变更运行相关 Playwright 用例或 `pnpm e2e:smoke`。涉及运行态时使用仓库 `pnpm e2e` / `pnpm e2e:full` 脚本的分趟串行策略；不要把 `@runtime` 用例与其它用例并行跑。
5. 跨包 / 跨语言或准备提交的改动运行 `pnpm check`。Unity 改动还需在可用的 Unity Editor 中检查编译与相关 EditMode / PlayMode 测试；若环境不可用，说明尚未验证，不要声称通过。

`pnpm check` 包含 TypeScript 类型检查、Vitest、ESLint、文档统计和契约生成检查；它不等于完整 E2E，也不替代 Unity 编译 / 测试。

## 任务描述模板

```text
需求：<要实现什么>
验收：<用户能观察到的结果 / 边界条件>

先判断这是简单字段、交互行为还是跨层功能。按 AGENTS.md 和现有实现工作：
- 小任务直接实现；跨包 / 跨语言任务先列简短改动面。
- 复用现有数据模型、命令、规格和测试模式，不做无关重构。
- 不手改生成物；不擅自抬文档 / 协议版本。
- 先跑相关定向测试，再按影响范围扩大验证。

完成后报告：改动摘要、验证命令及结果、未验证项 / 风险。
```

## 现行导航

- 总体结构与依赖边界：`server/docs/CODE-STRUCTURE.md`
- 后台服务端模块职责与改动入口：`server/docs/BACKEND-MODULES.md`
- 产品与开发命令：`server/README.md`
- 字段 / 组件改动面的实测基线：`server/docs/BASELINE-加一个组件要碰哪些文件.md`
- 数据形状与生成流程：`server/docs/PLAN-降低改动面.md`、`server/docs/PLAN-单一数据源与codegen.md`
- 文档 / 协议版本决策：`server/docs/SPEC-版本与迁移判据.md`
- Unity 分层、字段读取和验证：`client/README.md`

计划文档可能保留历史执行记录。判断当前状态时，以源码、测试和文档中的最新执行记录交叉确认；发现文档与实现冲突时，不要盲目照旧文档改代码，并在结果中指出冲突。
