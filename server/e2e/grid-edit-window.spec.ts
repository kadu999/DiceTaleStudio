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
import { fittedCellPoint } from "./helpers/canvas";

/**
 * 网格编辑窗口：**不进标注模式**，在窗口里按区域涂 / 擦格子。
 *
 * 与 `grid-annotate.spec.ts` 覆盖的是同一份数据、同一套 store 动作，区别只在落笔的地方：
 * 标注那条走**场景画布**（要先进标注模式、落点按世界坐标算），这条走**窗口自己的画布**
 * （贴图铺满窗口，落点按窗口视口算）。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

const CANVAS = "grid-editor-canvas";

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

/** 在窗口里点某一格（一下 = 一格）。 */
async function clickCell(page: Page, cell: { x: number; y: number }): Promise<void> {
  const point = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, cell);
  await page.mouse.click(point.x, point.y);
}

test.describe("网格编辑窗口", () => {
  test("不进标注模式：选区域涂 / 擦 / 清空 → 落盘 → 撤销", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      // 1) 从「编辑」组打开窗口：**不用**先「开始标注」，画布也不进标注模式
      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("scene-viewport")).toHaveAttribute("data-grid-paint", "false");

      // 画笔是 8 个区域 + 橡皮擦（与战争雾窗口「只列已绑定的雾区」不同）
      await expect(dialog.getByTestId("grid-editor-brush-0")).toBeVisible();
      for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
        await expect(dialog.getByTestId(`grid-editor-brush-${bit}`)).toBeVisible();
      }

      // 2) 选「区域2」（位 2）涂一格
      await dialog.getByTestId("grid-editor-brush-2").click();
      const first = { x: 2, y: 2 };
      await clickCell(page, first);
      await expect.poll(() => persistedMask(request, project, first)).toBe(2);

      // 3) 拖一笔（跨三格）→ Ctrl+Z：一整笔一条撤销记录，三格一起回来
      const stroke = [
        { x: 4, y: 2 },
        { x: 5, y: 2 },
        { x: 6, y: 2 },
      ];
      const from = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, stroke[0] as { x: number; y: number });
      const to = await fittedCellPoint(page, CANVAS, MAP_SIZE, GRID, stroke[2] as { x: number; y: number });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      for (const cell of stroke) {
        await expect.poll(() => persistedMask(request, project, cell)).toBe(2);
      }

      await page.keyboard.press("Control+z");
      for (const cell of stroke) {
        await expect.poll(() => persistedMask(request, project, cell)).toBe(0);
      }
      // 第一格不受影响：撤销只回退这一笔
      await expect.poll(() => persistedMask(request, project, first)).toBe(2);

      // 4) 换「区域4」（位 8）涂同一格：按位叠加（与画布标注同一套语义）
      await dialog.getByTestId("grid-editor-brush-8").click();
      await clickCell(page, first);
      await expect.poll(() => persistedMask(request, project, first)).toBe(2 | 8);

      // 5) 橡皮擦**整格清零**（与雾窗口「只擦绑定位」不同）
      await dialog.getByTestId("grid-editor-brush-0").click();
      await clickCell(page, first);
      await expect.poll(() => persistedMask(request, project, first)).toBe(0);

      // 6) 全部清除：清掉整张网格
      await dialog.getByTestId("grid-editor-brush-1").click();
      await clickCell(page, first);
      await clickCell(page, { x: 0, y: 0 });
      await expect.poll(() => persistedMask(request, project, first)).toBe(1);
      await dialog.getByTestId("grid-editor-clear").click();
      await expect.poll(() => persistedMask(request, project, first)).toBe(0);
      await expect.poll(() => persistedMask(request, project, { x: 0, y: 0 })).toBe(0);

      // 7) 关闭窗口：模态层撤掉
      await dialog.getByTestId("grid-editor-close").click();
      await expect(page.getByTestId("grid-editor-dialog")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("画笔与画布标注共用同一套偏好；两个窗口互斥", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      // 在窗口里选「区域3」、把画笔调到 3 号
      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      await dialog.getByTestId("grid-editor-brush-4").click();
      await dialog.getByTestId("grid-editor-brush-size").fill("3");
      await expect(dialog.getByTestId("grid-editor-brush-size-label")).toContainText("3×3");

      // 关掉窗口后进标注模式：调色板里的画笔就是刚选的那个（同一套偏好）
      await dialog.getByTestId("grid-editor-close").click();
      await page.getByTestId("grid-paint-enter").click();
      await expect(page.getByTestId("grid-type-4")).toHaveAttribute("data-active", "true");
      await expect(page.getByTestId("grid-brush-size")).toHaveValue("3");
      await page.getByTestId("grid-paint-exit-panel").click();

      // 互斥：开着 Mask 窗口时点「打开编辑窗口」不该叠出第二层模态
      await page.locator('[data-group="fog"]').getByTestId("fog-region-8").click();
      await page.locator('[data-group="fog"]').getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();
      // 关掉 Mask 窗口再从「编辑」组打开网格编辑窗口
      await page.getByTestId("fog-mask-close").click();
      await page.getByTestId("grid-editor-open").click();
      await expect(page.getByTestId("grid-editor-dialog")).toBeVisible();
      await expect(page.getByTestId("fog-mask-dialog")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });
});
