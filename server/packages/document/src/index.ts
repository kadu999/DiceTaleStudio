// 文档包的分层（由下往上）：类型 → 类型层级 → 特性描述 → 访问器 → schema → 命令 → 校验。
//
// `export *` 的顺序 = 「谁先声明谁赢」的优先级，所以**访问器与特性表放在命令之前**：
// 同名导出（如 `objectImage`、`supportsVideo`、`DEFAULT_SOUND_LAYER`）由它们提供，
// `commands.ts` 只负责命令本身。加一层时请照这个顺序插。
export * from "./fields";
export * from "./kinds";
export * from "./types";
export * from "./scale";
export * from "./features";
export * from "./access";
export * from "./sprites";
export * from "./asset-meta";
export * from "./schema";
export * from "./components";
export * from "./factory";
export * from "./history";
export * from "./commands";
export * from "./validation";
