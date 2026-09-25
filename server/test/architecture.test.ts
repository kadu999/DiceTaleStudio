import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 架构边界测试。
 *
 * 这些规则是「分模块解耦合」与「代码资源分离」的可执行版本——
 * 靠约定守不住，靠测试才守得住。任何一条失败都说明依赖方向被破坏了。
 */

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES_ROOT = join(SERVER_ROOT, "packages");

/** 不允许依赖 UI / 宿主的"纯逻辑"包。 */
const PURE_PACKAGES = ["grid", "document", "protocol", "resources"];

/** 允许用 DOM/Canvas，但不允许依赖 React。 */
const DOM_OK_PACKAGES = ["renderer"];

const FORBIDDEN_MODULES = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "node:fs",
  "node:path",
  "node:http",
  "node:child_process",
  "fs",
  "path",
  "http",
  "child_process",
];

const FORBIDDEN_DOM_GLOBALS = [
  "window.",
  "document.",
  "localStorage",
  "sessionStorage",
  "navigator.",
  "HTMLElement",
  "requestAnimationFrame",
];

function listSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      result.push(...listSourceFiles(full));
      continue;
    }

    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      result.push(full);
    }
  }

  return result;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

describe("架构边界：packages 不得依赖 UI / 宿主", () => {
  it("纯逻辑包不 import React、Node 内置模块或 DOM", () => {
    const violations: string[] = [];

    for (const pkg of PURE_PACKAGES) {
      for (const file of listSourceFiles(join(PACKAGES_ROOT, pkg, "src"))) {
        const source = readFileSync(file, "utf8");
        const rel = relative(SERVER_ROOT, file);

        for (const specifier of importSpecifiers(source)) {
          if (FORBIDDEN_MODULES.some((bad) => specifier === bad || specifier.startsWith(`${bad}/`))) {
            violations.push(`${rel} 引入了禁止的模块 "${specifier}"`);
          }
        }

        for (const global of FORBIDDEN_DOM_GLOBALS) {
          if (source.includes(global)) {
            violations.push(`${rel} 使用了 DOM/宿主全局 "${global}"`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("renderer 可以用 DOM，但不得依赖 React", () => {
    const violations: string[] = [];

    for (const pkg of DOM_OK_PACKAGES) {
      for (const file of listSourceFiles(join(PACKAGES_ROOT, pkg, "src"))) {
        const source = readFileSync(file, "utf8");
        const rel = relative(SERVER_ROOT, file);

        for (const specifier of importSpecifiers(source)) {
          if (specifier === "react" || specifier.startsWith("react/") || specifier === "react-dom") {
            violations.push(`${rel} 引入了 React（渲染层必须与 UI 框架解耦）`);
          }

          if (specifier.startsWith("node:")) {
            violations.push(`${rel} 引入了 Node 内置模块 "${specifier}"`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("架构边界：packages 不得互相越权依赖", () => {
  /** 允许的包间依赖（与实施方案中的依赖方向一致）。 */
  const ALLOWED: Record<string, string[]> = {
    grid: [],
    protocol: [],
    resources: [],
    document: ["grid"],
    renderer: ["grid", "document"],
  };

  it("只允许声明的依赖方向（且必须写在 package.json 里）", () => {
    const violations: string[] = [];

    for (const [pkg, allowed] of Object.entries(ALLOWED)) {
      const packageJson = JSON.parse(
        readFileSync(join(PACKAGES_ROOT, pkg, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      const declared = Object.keys(packageJson.dependencies ?? {})
        .filter((name) => name.startsWith("@dts/"))
        .map((name) => name.replace("@dts/", ""));

      for (const dep of declared) {
        if (!allowed.includes(dep)) {
          violations.push(`packages/${pkg} 声明了未允许的依赖 @dts/${dep}`);
        }
      }

      for (const file of listSourceFiles(join(PACKAGES_ROOT, pkg, "src"))) {
        const source = readFileSync(file, "utf8");
        const rel = relative(SERVER_ROOT, file);
        for (const specifier of importSpecifiers(source)) {
          if (!specifier.startsWith("@dts/")) {
            continue;
          }

          const dep = specifier.replace("@dts/", "");
          if (!allowed.includes(dep)) {
            violations.push(`${rel} 引入了未允许的包 "@dts/${dep}"`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

/** 去掉注释后再扫描：文档注释里提到 `resources/` 之类的说明不算硬编码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("架构边界：代码里不得硬编码资源路径", () => {
  /**
   * `packages/resources` 是**资源 ID 与目录约定的唯一归属地**，它当然要写出目录名与文件名模式；
   * 其余包一律只能使用逻辑 ID。
   */
  const SCANNED = [...PURE_PACKAGES, ...DOM_OK_PACKAGES].filter((pkg) => pkg !== "resources");

  it("除 resources 包外，源码不出现 resources/ 或地图文件名之类的字面量", () => {
    const violations: string[] = [];
    const literalPatterns = [/["'`][^"'`]*resources\//, /["'`]Map\d+\.(png|bytes)["'`]/];

    for (const pkg of SCANNED) {
      for (const file of listSourceFiles(join(PACKAGES_ROOT, pkg, "src"))) {
        const source = stripComments(readFileSync(file, "utf8"));
        const rel = relative(SERVER_ROOT, file);
        for (const pattern of literalPatterns) {
          if (pattern.test(source)) {
            violations.push(`${rel} 出现资源路径字面量（应使用 @dts/resources 的逻辑 ID）`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("resources 包是唯一持有目录约定的地方", () => {
    // 反向断言：约定确实集中在 resources 包里，而不是散落各处
    const providerSource = readFileSync(join(PACKAGES_ROOT, "resources", "src", "provider.ts"), "utf8");
    expect(providerSource).toMatch(/DEFAULT_RESOURCE_DIRS/);
  });

  it("磁盘访问只出现在后端（唯一允许碰文件系统的地方）", () => {
    const offenders: string[] = [];
    for (const pkg of [...PURE_PACKAGES, ...DOM_OK_PACKAGES]) {
      for (const file of listSourceFiles(join(PACKAGES_ROOT, pkg, "src"))) {
        const source = readFileSync(file, "utf8");
        if (/from\s+["']node:fs/.test(source)) {
          offenders.push(relative(SERVER_ROOT, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

/**
 * kind 退役的**可搜索约束**（见 docs/PLAN-组件驱动与kind退役.md 阶段 3）：
 * 功能由组件承载后，`kind === "Map"` 这类**按字面量判行为**的分支只允许出现在
 * 历史 schema 迁移里；分类 / 标签 / 创建模板路由 / mismatch 提示等「读 kind 但不按它
 * 否决组件行为」的用法是退役后保留的职责，不受此约束（也不在本测试的命中模式里）。
 *
 * 命中即失败；确需新增例外时把它加进 ALLOWLIST 并写清理由。
 */
describe("架构边界：kind 只剩显示 / 分类 / 创建模板 / 兼容迁移职责（可搜索约束）", () => {
  /** 按 kind 字面量判行为的唯一允许点 → 存在的理由。 */
  const ALLOWLIST = new Map<string, string>([
    ["packages/document/src/schema.ts", "历史 schema 迁移（v18 及更早扁平字段搬入组件）"],
  ]);

  /**
   * 对象 kind 的字面量都是 PascalCase（OBJECT_KINDS）；命令 / 操作 / 历史条目等
   * 其它 `xxx.kind` 判别值是小写（`command.kind === "play_sound"`、`action.kind === "play"`），
   * 要求首字母大写即只命中对象 kind 的行为分支，不误伤它们。
   */
  const BEHAVIOR_BRANCH = /\.kind\s*={2,3}\s*["'][A-Z]/;

  it("源码不得按 kind 字面量判定行为（例外见 ALLOWLIST）", () => {
    const offenders: string[] = [];
    const roots = [
      ...[...PURE_PACKAGES, ...DOM_OK_PACKAGES].map((pkg) => join(PACKAGES_ROOT, pkg, "src")),
      join(SERVER_ROOT, "apps", "backend", "src"),
      join(SERVER_ROOT, "apps", "editor", "src"),
    ];

    for (const root of roots) {
      for (const file of listSourceFiles(root)) {
        const rel = relative(SERVER_ROOT, file).replace(/\\/g, "/");
        const source = stripComments(readFileSync(file, "utf8"));
        if (ALLOWLIST.has(rel)) {
          continue;
        }

        if (BEHAVIOR_BRANCH.test(source)) {
          offenders.push(`${rel} 按 kind 字面量判定行为（应改按组件；迁移见 ALLOWLIST）`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("例外清单是真实职责：schema 迁移里确实还有按 kind 的迁移分支", () => {
    const schemaSource = readFileSync(join(PACKAGES_ROOT, "document", "src", "schema.ts"), "utf8");
    expect(schemaSource).toMatch(BEHAVIOR_BRANCH);
  });
});
});
