// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：命令模块的 barrel。
//
// 原来那一个 1985 行的 `commands.ts` 按「分节标题」拆成了下面这些模块，这里把它们的
// 导出面原样拼回去——`export * from "./commands"`（`src/index.ts` 里那一条）照旧解析得到，
// `factory.ts` / `validation.ts` / 各测试里 `../src/commands` 的 import 也不用改。
/**
 * 文档修改命令（纯函数，作用于 immer draft）。
 *
 * 层级：场景 → 对象 → 组件。
 * **对象一律挂在场景上**（`scene.objects`），地图也只是其中 kind = "Map" 的一个对象；
 * 场景本身不再是工程文件里的一项，增删改名是调用方的文件操作，这里只管「按名字找」。
 *
 * 所有编辑都经这里 → 由 `DocumentHistory.apply` 记录补丁 → 自动获得撤销/重做。
 * 命令返回 `false` 表示未产生变更（历史不会入栈）。
 */
export * from "./shared";
export * from "./object";
export * from "./field";
export * from "./scene";
export * from "./grid-map";
export * from "./play-sound";
export * from "./teleport";
export * from "./video";
export * from "./project";
