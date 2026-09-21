import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  dropProject,
  expandRuns,
  mapObjectDoc,
  newProject,
  openFirstObject,
  readSceneFog,
  readSceneFogRegions,
  readSceneMap,
  sceneDoc,
  seedProjectDoc,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";
import { canvasColorAt, cellPointInBox } from "./helpers/canvas";

/**
 * 战争雾 Mask 窗口：**只有擦除**，擦的是遮罩这张图（不是格子），而且**不写文档**。
 *
 * 钉住五件事（都是参考实现那套运行时语义在编辑器里的样子）：
 * 1. 罩子只盖在**已指定雾区的格子**上（其余透明）——运行时的初始状态；
 * 2. 罩子按**区域颜色**画：编辑器里要一眼看出哪块是哪区（运行时那边统一是黑的，
 *    等前端重构；配色与画布上的「网格标注」共用同一份偏好）；
 * 3. 擦除让那块变透明（露出底图）；
 * 4. **场景文件一个字节都不动**（擦了不保存）；
 * 5. 关掉再打开就回到未探索的样子（每次打开按当前文档重画）。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };
const CANVAS = "fog-mask-canvas";

/** 左下角 4 格是「区域1」：指定区域1 之后，罩子应该正好盖在这 4 格上。 */
const FOG_CELLS = 4;

/** 场景里某个格子的掩码（还没落盘时按 -1 处理）。 */
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

/** 遮罩画布上某一格的像素（罩子按区域配色画，所以看的是颜色而不只是 alpha）。 */
async function maskPixel(
  page: Page,
  cell: { x: number; y: number },
): Promise<{ r: number; g: number; b: number; a: number }> {
  const point = await cellPointInBox(page, CANVAS, GRID, cell);
  return canvasColorAt(page, CANVAS, point, 2);
}

/** 在遮罩上按住拖一笔（模拟 GM 擦除）。 */
async function eraseAcross(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const start = await cellPointInBox(page, CANVAS, GRID, from);
  const end = await cellPointInBox(page, CANVAS, GRID, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

test.describe("战争雾 Mask 窗口", () => {
  test("开关：关着只有开关，打开才露出雾区设置；开关是**文档数据**（前端按它决定生不生成雾）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');
      await expect(fog.getByTestId("fog-enable")).not.toBeChecked();
      await expect(fog.getByTestId("fog-region-1")).toHaveCount(0);
      await expect(fog.getByTestId("fog-mask-open")).toHaveCount(0);
      // 没开过 = 文件里没有 `map.fog` 这个字段
      await expect.poll(() => readSceneFog(request, project, SCENE)).toBeUndefined();

      // 打开以后才露出「指定雾区」与编辑入口，而且**开关落进了场景文件**
      await fog.getByTestId("fog-enable").check();
      await expect(fog.getByTestId("fog-region-1")).toBeVisible();
      await expect(fog.getByTestId("fog-mask-open")).toBeVisible();
      await expect
        .poll(() => readSceneFog(request, project, SCENE))
        .toEqual({ enabled: true, regions: [] });

      // 关掉又收起来
      await fog.getByTestId("fog-enable").uncheck();
      await expect(fog.getByTestId("fog-region-1")).toHaveCount(0);
      await expect(fog.getByTestId("fog-mask-open")).toHaveCount(0);
      // 一个雾区都没指定：关掉 = 没有内容要记，字段整个摘掉（与「从没开过」同义）
      await expect.poll(() => readSceneFog(request, project, SCENE)).toBeUndefined();

      // 指定了雾区再关掉：**绑定留着**、只是把开关写 false（再打开就回来）
      await fog.getByTestId("fog-enable").check();
      await fog.getByTestId("fog-region-1").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1]);
      await fog.getByTestId("fog-enable").uncheck();
      await expect
        .poll(() => readSceneFog(request, project, SCENE))
        .toEqual({ enabled: false, regions: [1] });
      // 关着只是「现在没有雾」：重新打开，绑定还在
      await fog.getByTestId("fog-enable").check();
      await expect(fog.getByTestId("fog-region-1")).toHaveAttribute("data-bound", "true");
    } finally {
      await dropProject(request, project);
    }
  });

  test("只盖雾区、按区域颜色、只有擦除、擦了不落盘、重开恢复原样", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
      (mapDoc.map as { cells: unknown }).cells = {
        encoding: "rle",
        runs: [
          [1, FOG_CELLS],
          [0, GRID.width * GRID.height - FOG_CELLS],
        ],
      };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');

      // 先打开战争雾：关着时连雾区设置都不显示（见上面那条用例）
      await fog.getByTestId("fog-enable").check();

      // 没指定雾区：窗口打不开（罩子会是全透明，没什么可擦的）
      await expect(fog.getByTestId("fog-mask-open")).toBeDisabled();

      // 指定「区域1」→ 那 4 格成为雾区
      await fog.getByTestId("fog-region-1").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1]);

      const fileBefore = await readSceneMap(request, project, SCENE);

      // 打开 Mask 窗口：只有擦除那一个工具，没有画笔 / 全部清除
      await fog.getByTestId("fog-mask-open").click();
      const dialog = page.getByTestId("fog-mask-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("fog-mask-close")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "全部清除" })).toHaveCount(0);

      // 1)+2) 罩子只盖在雾格上、且是**区域1 的默认红**（#ff0000，α0.6）；非雾格透明
      await expect.poll(async () => (await maskPixel(page, { x: 1, y: 0 })).a).toBeGreaterThan(100);
      await expect
        .poll(async () => {
          const pixel = await maskPixel(page, { x: 1, y: 0 });
          return pixel.r > 200 && pixel.g < 60;
        })
        .toBe(true);
      await expect.poll(async () => (await maskPixel(page, { x: 1, y: 3 })).a).toBeLessThan(15);

      // 3)+4) 擦一笔：雾格变透明，而**场景文件一个字节都没动**
      await eraseAcross(page, { x: 0, y: 0 }, { x: 1, y: 0 });
      await expect.poll(async () => (await maskPixel(page, { x: 1, y: 0 })).a).toBeLessThan(15);

      await page.waitForTimeout(1200); // 真有改动的话自动存早该写了
      expect(await readSceneMap(request, project, SCENE)).toEqual(fileBefore);
      expect(await persistedMask(request, project, { x: 0, y: 0 })).toBe(1);

      // 5) 关掉再打开：回到未探索的样子
      await dialog.getByTestId("fog-mask-close").click();
      await expect(page.getByTestId("fog-mask-dialog")).toHaveCount(0);
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();
      await expect.poll(async () => (await maskPixel(page, { x: 1, y: 0 })).a).toBeGreaterThan(100);
    } finally {
      await dropProject(request, project);
    }
  });

  test("整区开关：打开 = 整片揭示、关闭 = 整片盖回去（不写文档）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
      // 左下角 4 格区域1、接着 4 格区域4
      (mapDoc.map as { cells: unknown }).cells = {
        encoding: "rle",
        runs: [
          [1, FOG_CELLS],
          [8, FOG_CELLS],
          [0, GRID.width * GRID.height - FOG_CELLS * 2],
        ],
      };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');
      await fog.getByTestId("fog-enable").check();
      await fog.getByTestId("fog-region-1").click();
      await fog.getByTestId("fog-region-8").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1, 8]);

      const fileBefore = await readSceneMap(request, project, SCENE);
      await fog.getByTestId("fog-mask-open").click();
      const dialog = page.getByTestId("fog-mask-dialog");
      await expect(dialog).toBeVisible();

      const region1Cell = { x: 0, y: 0 };
      const region4Cell = { x: FOG_CELLS, y: 0 };

      // 初始：两区都有罩子（区域1 红、区域4 浅灰）
      await expect.poll(async () => (await maskPixel(page, region1Cell)).a).toBeGreaterThan(100);
      await expect.poll(async () => (await maskPixel(page, region4Cell)).a).toBeGreaterThan(100);

      // 打开区域1：4 格一起揭示，区域4 那 4 格不动
      await dialog.getByTestId("fog-region-toggle-1").check();
      await expect.poll(async () => (await maskPixel(page, region1Cell)).a).toBeLessThan(15);
      await expect.poll(async () => (await maskPixel(page, { x: 3, y: 0 })).a).toBeLessThan(15);
      await expect.poll(async () => (await maskPixel(page, region4Cell)).a).toBeGreaterThan(100);

      // 关闭区域1：整片盖回去
      await dialog.getByTestId("fog-region-toggle-1").uncheck();
      await expect.poll(async () => (await maskPixel(page, region1Cell)).a).toBeGreaterThan(100);

      // 打开区域4：只有它那 4 格揭示
      await dialog.getByTestId("fog-region-toggle-8").check();
      await expect.poll(async () => (await maskPixel(page, region4Cell)).a).toBeLessThan(15);
      await expect.poll(async () => (await maskPixel(page, region1Cell)).a).toBeGreaterThan(100);

      // 擦了不保存：整区开关只是预览，场景文件一个字节不动
      await page.waitForTimeout(1200);
      expect(await readSceneMap(request, project, SCENE)).toEqual(fileBefore);

      // 关掉重开：开关复位、罩子回到未探索
      await dialog.getByTestId("fog-mask-close").click();
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();
      await expect(page.getByTestId("fog-region-toggle-8")).not.toBeChecked();
      await expect.poll(async () => (await maskPixel(page, region4Cell)).a).toBeGreaterThan(100);
    } finally {
      await dropProject(request, project);
    }
  });
  test("两个雾区各有各的颜色；绑定变了重开按新绑定画", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
      // 第一格「区域1」（默认红）、第二格「区域4」（默认浅灰）
      (mapDoc.map as { cells: unknown }).cells = {
        encoding: "rle",
        runs: [
          [1, 1],
          [8, 1],
          [0, GRID.width * GRID.height - 2],
        ],
      };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');
      await fog.getByTestId("fog-enable").check();
      await fog.getByTestId("fog-region-1").click();
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();

      // 只指定区域1：区域1 那格是红的，区域4 那格不盖
      await expect.poll(async () => (await maskPixel(page, { x: 0, y: 0 })).r).toBeGreaterThan(200);
      await expect.poll(async () => (await maskPixel(page, { x: 1, y: 0 })).a).toBeLessThan(15);

      // 关窗、把区域4 也指定上、再开：两格都盖上，而且**颜色不一样**（浅灰 vs 红）
      await page.getByTestId("fog-mask-close").click();
      await fog.getByTestId("fog-region-8").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1, 8]);
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();

      await expect.poll(async () => (await maskPixel(page, { x: 1, y: 0 })).r).toBeGreaterThan(180);
      const red = await maskPixel(page, { x: 0, y: 0 });
      const gray = await maskPixel(page, { x: 1, y: 0 });
      expect(red.r - red.g).toBeGreaterThan(150); // 区域1：红
      expect(Math.abs(gray.r - gray.b)).toBeLessThan(20); // 区域4：浅灰（三通道接近）
    } finally {
      await dropProject(request, project);
    }
  });
});
