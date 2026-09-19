import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  dropProject,
  expandRuns,
  mapObjectDoc,
  newProject,
  openFirstObject,
  readSceneMap,
  sceneDoc,
  seedProjectDoc,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";
import { canvasAverageColor, canvasPixelSum, fittedCellPoint, worldSamplePoint } from "./helpers/canvas";

/**
 * 网格标注的**显示**那一半。
 *
 * 涂格子只在「网格编辑窗口」里做（落笔、落盘、撤销见 `grid-edit-window.spec.ts`）；
 * 这里管的是画布怎么把格子画出来：按区域颜色着色、三个显示开关，
 * 以及「显示开关只动看得见的东西，不动数据」。
 *
 * 种出来的地图刻意小：贴图声明 400×300、网格 8×6 → 每格 50×50px，
 * 默认视口是 1:1 且世界原点在画布正中，所以「世界坐标 → 屏幕点」只有一步（见 helpers/canvas）。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };
const CANVAS = "grid-editor-canvas";

/** 表格格心（默认视口：世界原点 = 贴图中心）。 */
function cellCenter(cell: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (cell.x + 0.5) * (MAP_SIZE.width / GRID.width) - MAP_SIZE.width / 2,
    y: (cell.y + 0.5) * (MAP_SIZE.height / GRID.height) - MAP_SIZE.height / 2,
  };
}

/** 画布上这个点的「红度」：贴图是纯白，标上区域1（红，α0.6）后 r 远大于 g。 */
async function redness(page: Page, point: { x: number; y: number }): Promise<number> {
  // `canvasAverageColor` 采的是**页面上第一块画布**（场景画布）：窗口开着时它排在
  // 对话框那几块画布前面，所以这里的采样始终是画布本身，不是窗口
  const color = await canvasAverageColor(page, point);
  return color.r - color.g;
}

/** 那个格子在场景文件里的掩码（还没落盘时按 -1 处理，便于 poll 时区分「还没写」）。 */
async function persistedMask(
  request: APIRequestContext,
  project: string,
  cell: { x: number; y: number },
): Promise<number> {
  const map = await readSceneMap(request, project, SCENE);
  if (map === undefined) {
    return -1;
  }

  return expandRuns(map.runs)[cell.y * GRID.width + cell.x] ?? -1;
}

/** 开一个「只有一张小地图」的项目，选中地图、露出属性面板。 */
async function seedAndOpen(
  page: Page,
  request: APIRequestContext,
  project: string,
): Promise<void> {
  await seedProjectDoc(request, project, [
    sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
  ]);
  await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
  await openFirstObject(page, project, "网格地图");
}

test.describe("网格标注：画布显示", () => {
  test("编辑窗口里涂一格：画布按区域颜色着色，并且落盘", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedAndOpen(page, request, project);

      const cell = { x: 2, y: 3 };
      // 落点先算好：窗口一开，页面上就有两块画布，画布尺寸得在这之前量
      const point = await worldSamplePoint(page, cellCenter(cell));
      await expect.poll(() => redness(page, point)).toBeLessThan(40);

      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      await expect(dialog).toBeVisible();

      const at = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, cell);
      await page.mouse.click(at.x, at.y);
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);

      // 关掉窗口再看画布：着色来自文档里的格子，不是窗口里的临时状态
      await dialog.getByTestId("grid-editor-close").click();
      await expect(page.getByTestId("grid-editor-dialog")).toHaveCount(0);
      await expect.poll(() => redness(page, point)).toBeGreaterThan(60);
    } finally {
      await dropProject(request, project);
    }
  });

  test("每类的显示开关：关掉就不着色，数据还在", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedAndOpen(page, request, project);

      const cell = { x: 4, y: 2 };
      const point = await worldSamplePoint(page, cellCenter(cell));

      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      const at = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, cell);
      await page.mouse.click(at.x, at.y);
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);
      await expect.poll(() => redness(page, point)).toBeGreaterThan(60);

      // 关掉「区域1」的显示：画布不再着色……
      await dialog.getByTestId("grid-editor-visible-1").uncheck();
      await expect.poll(() => redness(page, point)).toBeLessThan(40);
      // ……但格子的数据还在（自动存有防抖，所以这里也要等落盘）
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);

      // 再打开就回来
      await dialog.getByTestId("grid-editor-visible-1").check();
      await expect.poll(() => redness(page, point)).toBeGreaterThan(60);
    } finally {
      await dropProject(request, project);
    }
  });

  test("网格线开关：关掉就只剩贴图（纯显示，不影响数据）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      // 深色贴图：网格线是白的（α0.12），压在深色上才量得出来
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [20, 20, 20]));
      await openFirstObject(page, project, "网格地图");
      await page.mouse.move(4, 4);

      const withLines = await canvasPixelSum(page);
      expect(withLines).toBeGreaterThan(0);

      await page.getByTestId("grid-lines-toggle").uncheck();
      await expect.poll(() => canvasPixelSum(page)).toBeLessThan(withLines);

      await page.getByTestId("grid-lines-toggle").check();
      await expect.poll(() => canvasPixelSum(page)).toBeGreaterThanOrEqual(withLines);
    } finally {
      await dropProject(request, project);
    }
  });

  test("网格标注总开关：关掉就不着色，数据不动", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedAndOpen(page, request, project);

      const cell = { x: 5, y: 4 };
      const point = await worldSamplePoint(page, cellCenter(cell));

      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      const at = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, cell);
      await page.mouse.click(at.x, at.y);
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);
      await dialog.getByTestId("grid-editor-close").click();

      await expect.poll(() => redness(page, point)).toBeGreaterThan(60);

      // 关掉总开关：画布不再着色，数据还在
      await page.getByTestId("grid-annotations-toggle").uncheck();
      await expect.poll(() => redness(page, point)).toBeLessThan(40);
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);

      // 打开总开关：立刻又看得见
      await page.getByTestId("grid-annotations-toggle").check();
      await expect.poll(() => redness(page, point)).toBeGreaterThan(60);
    } finally {
      await dropProject(request, project);
    }
  });

  test("战争雾是区域数据、不在画布上再画一层：开「战争雾」画面一个像素都不变", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
      // 整张网格涂「区域1」（掩码 1），并把区域1 指定成雾区：
      // 画布若给雾另加一层覆盖，同一格会被画第二遍（红 α0.6 叠两次 → 绿通道 102 掉到 41）
      (mapDoc.map as { cells: unknown }).cells = {
        encoding: "rle",
        runs: [[1, GRID.width * GRID.height]],
      };
      (mapDoc.map as { fog?: unknown }).fog = { regions: [1] };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      const cell = { x: 2, y: 3 };
      const point = await worldSamplePoint(page, cellCenter(cell));

      // 区域层画出来的红：白底上叠一次 α0.6 → 绿通道约 102
      await expect.poll(async () => (await canvasAverageColor(page, point)).g).toBeLessThan(150);
      const before = await canvasAverageColor(page, point);
      expect(before.g).toBeGreaterThan(90);

      // 打开战争雾：画布上**不该**多出任何一层（雾只在 Mask 窗口里看）
      await page.getByTestId("fog-enable").check();
      await expect(page.getByTestId("fog-region-1")).toBeVisible(); // 等界面稳住再采样
      const after = await canvasAverageColor(page, point);
      expect(Math.abs(after.g - before.g)).toBeLessThanOrEqual(2);

      // 关掉「网格标注」总开关：区域层不画了，战争雾那一组照样不往画布上补
      await page.getByTestId("grid-annotations-toggle").uncheck();
      await expect.poll(async () => (await canvasAverageColor(page, point)).g).toBeGreaterThan(250);
    } finally {
      await dropProject(request, project);
    }
  });
});
