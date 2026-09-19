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
import { canvasPixelSum, fittedCellPoint } from "./helpers/canvas";

/**
 * 战争雾：属性面板指定雾区 → Mask 窗口在贴图上按雾区涂 / 擦 → 落进场景文件的 RLE。
 *
 * 与 `grid-annotate.spec.ts` 同一个套路（种一张小地图、真点画布、断言落盘），差别只有一点：
 * 涂抹发生在**对话框自己的画布**上，所以坐标按窗口的视口算（`fittedCellPoint`）。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

const CANVAS = "fog-mask-canvas";

/** 场景里某个格子的掩码（还没落盘时按 -1 处理，便于 poll 时区分「还没写」）。 */
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

/** 在 Mask 窗口里点某一格（一下 = 一格，对齐画笔大小 1 的默认值）。 */
async function clickFogCell(page: Page, cell: { x: number; y: number }): Promise<void> {
  const point = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, cell);
  await page.mouse.click(point.x, point.y);
}

test.describe("战争雾", () => {
  test("指定雾区 → Mask 窗口涂 / 擦（橡皮只擦绑定位）→ 落盘 → 撤销", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      // 种一格「区域1」（位 1）在 (0,0)：它是**没被指定为雾区**的其它区域，
      // 用来验证「橡皮只擦已指定的雾区位」——擦雾不能顺手把它抹了
      const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
      (mapDoc.map as { cells: unknown }).cells = {
        encoding: "rle",
        runs: [
          [1, 1],
          [0, GRID.width * GRID.height - 1],
        ],
      };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');

      // 1) 没指定雾区：Mask 窗口打不开（先指定才有意义）
      await expect(fog.getByTestId("fog-mask-open")).toBeDisabled();
      await expect(fog.getByTestId("fog-cell-count")).toHaveText("0 格");

      // 2) 指定「区域4」（位 8）→ 写进场景文件
      await fog.getByTestId("fog-region-8").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([8]);
      await expect(fog.getByTestId("fog-region-8")).toHaveAttribute("data-bound", "true");

      // 3) 打开 Mask 窗口：画笔只列已指定的雾区
      await fog.getByTestId("fog-mask-open").click();
      const dialog = page.getByTestId("fog-mask-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("fog-brush-bit-8")).toBeVisible();
      await expect(dialog.getByTestId("fog-brush-bit-1")).toHaveCount(0);

      // 4) 在 (0,0) 涂区域4：那格本来是区域1，涂完是 1|8 = 9
      const target = { x: 0, y: 0 };
      await clickFogCell(page, target);
      await expect.poll(() => persistedMask(request, project, target)).toBe(1 | 8);

      // 5) 橡皮只擦**已指定的雾区位**：同格的区域1 必须留着（这就是与标注橡皮的区别）
      await dialog.getByTestId("fog-brush-erase").click();
      await clickFogCell(page, target);
      await expect.poll(() => persistedMask(request, project, target)).toBe(1);

      // 6) 拖一笔（跨三格）→ Ctrl+Z：**一整笔就是一条撤销记录**，三个格子一起回来
      await dialog.getByTestId("fog-brush-bit-8").click();
      const stroke = [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
      ];
      const from = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, stroke[0] as { x: number; y: number });
      const to = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, stroke[2] as { x: number; y: number });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      for (const cell of stroke) {
        await expect.poll(() => persistedMask(request, project, cell)).toBe(8);
      }

      await page.keyboard.press("Control+z");
      for (const cell of stroke) {
        await expect.poll(() => persistedMask(request, project, cell)).toBe(0);
      }
      // 上一格不受影响：撤销只回退这一笔
      await expect.poll(() => persistedMask(request, project, target)).toBe(1);

      // 7) 全部清除：清掉已指定雾区的格子，绑定还在
      await dialog.getByTestId("fog-brush-bit-8").click();
      const second = { x: 2, y: 2 };
      await clickFogCell(page, second);
      await expect.poll(() => persistedMask(request, project, second)).toBe(8);
      await dialog.getByTestId("fog-mask-clear").click();
      await expect.poll(() => persistedMask(request, project, second)).toBe(0);
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([8]);

      // 8) 关闭窗口：模态层撤掉（这时场景画布又只剩一块，采样工具才不会被抢）
      await dialog.getByTestId("fog-mask-close").click();
      await expect(page.getByTestId("fog-mask-dialog")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("预览开关：打开后画布上出现雾罩（纯显示，不动数据）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 深色贴图：雾罩是浅色的，压在深色上才量得出来（白色贴图上几乎看不出差别）
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [20, 20, 20]));
      await openFirstObject(page, project, "网格地图");

      const fog = page.locator('[data-group="fog"]');
      await fog.getByTestId("fog-region-1").click();
      await expect.poll(() => readSceneFogRegions(request, project, SCENE)).toEqual([1]);

      // 涂一小片雾：落点由窗口自己的视口算，断言只看「这一片真的写进去了」
      await fog.getByTestId("fog-mask-open").click();
      const dialog = page.getByTestId("fog-mask-dialog");
      await expect(dialog).toBeVisible();
      for (const cell of [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 2, y: 3 },
        { x: 3, y: 3 },
      ]) {
        await clickFogCell(page, cell);
      }
      await expect.poll(() => persistedMask(request, project, { x: 2, y: 2 })).toBe(1);
      await dialog.getByTestId("fog-mask-close").click();
      await expect(page.getByTestId("fog-mask-dialog")).toHaveCount(0);

      // 关掉「网格标注」的着色：区域配色会把浅色雾罩盖淡，量出来的差值就不明显了
      await page.getByTestId("grid-annotations-toggle").uncheck();
      await page.mouse.move(4, 4);

      const before = await canvasPixelSum(page);

      await page.getByTestId("fog-preview-toggle").check();
      await expect.poll(() => canvasPixelSum(page)).toBeGreaterThan(before);

      // 纯显示开关：关掉只是不画，格子数据不动
      await page.getByTestId("fog-preview-toggle").uncheck();
      await expect.poll(() => canvasPixelSum(page)).toBeLessThanOrEqual(before);
      await expect.poll(() => persistedMask(request, project, { x: 2, y: 2 })).toBe(1);
    } finally {
      await dropProject(request, project);
    }
  });
});
