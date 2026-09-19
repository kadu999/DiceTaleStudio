import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  dropProject,
  expandRuns,
  mapObjectDoc,
  newProject,
  openFirstObject,
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
 * 钉住四件事（都是参考实现那套运行时语义在编辑器里的样子）：
 * 1. 罩子只盖在**已指定雾区的格子**上（其余透明）——运行时的初始状态；
 * 2. 擦除让那块变透明（露出底图）；
 * 3. **场景文件一个字节都不动**（擦了不保存）；
 * 4. 关掉再打开就回到未探索的样子（每次打开按当前文档重画）。
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

/** 遮罩画布上某一格的**不透明度**：255 = 黑罩（未探索），0 = 透明（已揭示）。 */
async function maskAlpha(page: Page, cell: { x: number; y: number }): Promise<number> {
  const point = await cellPointInBox(page, CANVAS, GRID, cell);
  return (await canvasColorAt(page, CANVAS, point, 2)).a;
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
  test("只盖雾区、只有擦除、擦了不落盘、重开恢复原样", async ({ page, request }) => {
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
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');

      // 没指定雾区：窗口打不开（罩子会是全透明，没什么可擦的）
      await expect(fog.getByTestId("fog-mask-open")).toBeDisabled();

      // 指定「区域1」→ 那 4 格成为雾区
      await fog.getByTestId("fog-region-1").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1]);
      await expect(fog.getByTestId("fog-cell-count")).toHaveText(`${FOG_CELLS} 格`);

      const fileBefore = await readSceneMap(request, project, SCENE);

      // 打开 Mask 窗口：只有擦除那一个工具，没有画笔 / 全部清除
      await fog.getByTestId("fog-mask-open").click();
      const dialog = page.getByTestId("fog-mask-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("fog-mask-close")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "全部清除" })).toHaveCount(0);

      // 1) 罩子只盖在雾格上：雾格不透明，非雾格透明
      await expect.poll(() => maskAlpha(page, { x: 1, y: 0 })).toBeGreaterThan(240);
      await expect.poll(() => maskAlpha(page, { x: 1, y: 3 })).toBeLessThan(15);

      // 2)+3) 擦一笔：雾格变透明，而**场景文件一个字节都没动**
      await eraseAcross(page, { x: 0, y: 0 }, { x: 1, y: 0 });
      await expect.poll(() => maskAlpha(page, { x: 1, y: 0 })).toBeLessThan(15);

      await page.waitForTimeout(1200); // 真有改动的话自动存早该写了
      expect(await readSceneMap(request, project, SCENE)).toEqual(fileBefore);
      expect(await persistedMask(request, project, { x: 0, y: 0 })).toBe(1);

      // 4) 关掉再打开：回到未探索的样子
      await dialog.getByTestId("fog-mask-close").click();
      await expect(page.getByTestId("fog-mask-dialog")).toHaveCount(0);
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();
      await expect.poll(() => maskAlpha(page, { x: 1, y: 0 })).toBeGreaterThan(240);
    } finally {
      await dropProject(request, project);
    }
  });

  test("雾区指定变了：重开按新绑定重画", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
      // 第一格「区域1」、第二格「区域4」
      (mapDoc.map as { cells: unknown }).cells = {
        encoding: "rle",
        runs: [
          [1, 1],
          [8, 1],
          [0, GRID.width * GRID.height - 2],
        ],
      };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');
      await fog.getByTestId("fog-region-1").click();
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();

      // 只指定区域1：区域4 那格不盖
      await expect.poll(() => maskAlpha(page, { x: 0, y: 0 })).toBeGreaterThan(240);
      await expect.poll(() => maskAlpha(page, { x: 1, y: 0 })).toBeLessThan(15);

      // 关窗、把区域4 也指定上、再开：两格都盖上
      await page.getByTestId("fog-mask-close").click();
      await fog.getByTestId("fog-region-8").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1, 8]);
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();

      await expect.poll(() => maskAlpha(page, { x: 1, y: 0 })).toBeGreaterThan(240);
    } finally {
      await dropProject(request, project);
    }
  });
});
