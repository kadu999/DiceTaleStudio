/**
 * CODE-STRUCTURE.md §0 速查表的行数校验。
 *
 * 文档里的统计是手工维护的，每次重构都漂移（见 docs/TODO-批B 台账 #4）。
 * 本脚本重算 §0 的两行汇总（源码规模 / 测试规模，含各自分桶）与 §0.1 表格里
 * 钉住的具体文件行数（`server.ts` / `hub.ts` / `InspectorPanel.tsx`），
 * 与文档逐字比对——不一致就退出 1，并给出「文档写的是 X，实测是 Y」的清单。
 *
 * 计数口径（脚本即唯一权威，改口径先改这里）：
 * - 源码 = `packages/<各包>/src`、`apps/backend/src`、`apps/editor/src` 下的 `.ts` / `.tsx`；
 * - 单测 = `packages/<各包>/test`、`apps/<各应用>/test` 下的 `.ts` / `.tsx`；
 * - E2E = `e2e/` 下的 `.ts` / `.tsx`（`.cjs` reporter 不算）；
 * - 架构测试 = `test/*.ts`。
 *
 * 挂在 `pnpm check` 的最后一步：重构改了行数，要么更新文档，要么别合。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = join(SERVER_ROOT, "docs", "CODE-STRUCTURE.md");

/** 收集一个目录下所有匹配扩展名的文件（递归，按相对路径排序）。 */
function collectFiles(dir, extensions) {
  const result = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((suffix) => entry.name.endsWith(suffix))) {
        result.push(full);
      }
    }
  };

  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) {
    walk(dir);
  }

  return result.sort();
}

/** 行数 = 换行符个数（文件末尾的半截行不算一行）。 */
function lineCountOf(path) {
  const text = readFileSync(path, "utf8");
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

/** 一组文件桶的 {files, lines}。 */
function bucketOf(dirs, extensions) {
  const files = dirs.flatMap((dir) => collectFiles(join(SERVER_ROOT, dir), extensions));
  return { files: files.length, lines: files.reduce((sum, file) => sum + lineCountOf(file), 0) };
}

const format = (value) => value.toLocaleString("en-US");

const SOURCE = {
  packages: bucketOf(["packages/grid/src", "packages/document/src", "packages/protocol/src", "packages/resources/src", "packages/renderer/src"], [".ts"]),
  backend: bucketOf(["apps/backend/src"], [".ts"]),
  editor: bucketOf(["apps/editor/src"], [".ts", ".tsx"]),
};
const PACKAGE_SOURCE = {
  grid: bucketOf(["packages/grid/src"], [".ts"]),
  document: bucketOf(["packages/document/src"], [".ts"]),
  protocol: bucketOf(["packages/protocol/src"], [".ts"]),
  resources: bucketOf(["packages/resources/src"], [".ts"]),
  renderer: bucketOf(["packages/renderer/src"], [".ts"]),
};
const sourceFiles = SOURCE.packages.files + SOURCE.backend.files + SOURCE.editor.files;
const sourceLines = SOURCE.packages.lines + SOURCE.backend.lines + SOURCE.editor.lines;

const TEST = {
  unit: bucketOf(["packages/grid/test", "packages/document/test", "packages/protocol/test", "packages/resources/test", "packages/renderer/test", "apps/backend/test", "apps/editor/test"], [".ts", ".tsx"]),
  e2e: bucketOf(["e2e"], [".ts", ".tsx"]),
  architecture: bucketOf(["test"], [".ts"]),
};
const testLines = TEST.unit.lines + TEST.e2e.lines + TEST.architecture.lines;

/** §0.1 表格里钉住「现状」的具体文件（文件名 → 仓库内路径）。 */
const ANCHORED_FILES = {
  "server.ts": "apps/backend/src/http/server.ts",
  "hub.ts": "apps/backend/src/ws/hub.ts",
  "InspectorPanel.tsx": "apps/editor/src/panels/inspector/InspectorPanel.tsx",
};

const doc = readFileSync(DOC_PATH, "utf8");
const mismatches = [];

/** 在文档里找一行，对其中的「数字 / 分桶数字」逐组比对。 */
function checkRow(rowLabel, actualText) {
  const row = doc.split("\n").find((line) => line.startsWith(`| ${rowLabel} |`));
  if (row === undefined) {
    mismatches.push(`找不到「${rowLabel}」这一行（文档结构变了？）`);
    return;
  }

  const cell = row.split("|")[2]?.trim() ?? "";
  if (cell !== actualText) {
    mismatches.push(`§0「${rowLabel}」：文档写的是「${cell}」，实测「${actualText}」`);
  }
}

checkRow(
  "源码规模（不含测试）",
  `${format(sourceFiles)} 个文件 / ${format(sourceLines)} 行（packages ${format(SOURCE.packages.lines)} · backend ${format(SOURCE.backend.lines)} · editor ${format(SOURCE.editor.lines)}）`,
);
checkRow(
  "测试规模",
  `${format(testLines)} 行（单测 ${format(TEST.unit.lines)} · E2E ${format(TEST.e2e.lines)} · 架构测试 ${format(TEST.architecture.lines)}）`,
);

for (const [name, relPath] of Object.entries(ANCHORED_FILES)) {
  const actual = lineCountOf(join(SERVER_ROOT, relPath));
  // §0.1 表格里 `<name>` **N 行** 的现状描述（before 列的数字是历史值，不验）。
  const pattern = new RegExp("`" + name.replace(".", "\\.") + "` \\*\\*(\\d[\\d,]*) 行\\*\\*");
  const match = doc.match(pattern);
  if (match === null) {
    mismatches.push(`§0.1 里找不到「${name}」的加粗行数（文档结构变了？）`);
    continue;
  }

  if (match[1] !== format(actual)) {
    mismatches.push(`§0.1「${name}」：文档写的是 ${match[1]} 行，实测 ${format(actual)} 行（${relPath}）`);
  }
}

// §3.x 节标题里的包规模（`### 3.N `@dts/<pkg>` — …（N 行…）`，计数 = 该包 src 行数）。
for (const line of doc.split("\n")) {
  const match = line.match(/^### 3\.\d `@dts\/(\w+)` — .*（(\d[\d,]*) 行/);
  if (match === null) {
    continue;
  }

  const bucket = PACKAGE_SOURCE[match[1]];
  if (bucket === undefined) {
    continue;
  }

  if (match[2] !== format(bucket.lines)) {
    mismatches.push(`§3「@dts/${match[1]}」节标题：文档写的是 ${match[2]} 行，实测 ${format(bucket.lines)} 行（src 合计）`);
  }
}

if (mismatches.length > 0) {
  console.error("CODE-STRUCTURE.md §0 统计漂移：");
  for (const item of mismatches) {
    console.error(`  ✗ ${item}`);
  }

  console.error("\n改代码就更新文档对应数字；改计数口径先改本脚本。相对仓库根：");
  console.error(`  ${relative(process.cwd(), DOC_PATH)}`);
  process.exit(1);
}

console.log(
  `CODE-STRUCTURE.md §0 统计一致：源码 ${format(sourceLines)} 行 / ${format(sourceFiles)} 文件，测试 ${format(testLines)} 行`,
);
