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
 * 网格编辑窗口：**唯一的**涂格子入口（落笔 → 落盘 → 撤销都在这里）。
 *
 * 窗口自带视口（贴图铺满窗口），所以落点按窗口视口算（`fittedCellPoint`），
 * 与场景画布那套世界坐标无关；画布怎么把格子画出来见 `grid-annotate.spec.ts`。
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
  test("选区域涂 / 擦 / 清空 → 落盘 → 撤销", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      // 1) 从「区域」组打开窗口：涂格子只在这一个地方做
      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      await expect(dialog).toBeVisible();

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

      // 4) 换「区域4」（位 8）涂同一格：按位叠加
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

  test("画笔偏好留在窗口里：关掉再开还是那一套", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      // 选「区域3」、把画笔调到 3 号
      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");
      await dialog.getByTestId("grid-editor-brush-4").click();
      await dialog.getByTestId("grid-editor-brush-size").fill("3");
      await expect(dialog.getByTestId("grid-editor-brush-size-label")).toContainText("3×3");

      // 关掉再开：画笔与大小都还是刚才那个（偏好写在浏览器本地）
      await dialog.getByTestId("grid-editor-close").click();
      await expect(page.getByTestId("grid-editor-dialog")).toHaveCount(0);
      await page.getByTestId("grid-editor-open").click();
      const again = page.getByTestId("grid-editor-dialog");
      await expect(again.getByTestId("grid-editor-brush-4")).toHaveAttribute("data-active", "true");
      await expect(again.getByTestId("grid-editor-brush-size")).toHaveValue("3");

      // 而且真的按它落笔：3 号画笔 = 3×3 格，中心在 (4,3) 时整片都被标成区域3
      await clickCell(page, { x: 4, y: 3 });
      for (const [x, y] of [
        [3, 2],
        [4, 3],
        [5, 4],
      ] as const) {
        await expect.poll(() => persistedMask(request, project, { x, y })).toBe(4);
      }
    } finally {
      await dropProject(request, project);
    }
  });

  test("每类的显示开关：关掉只是不画，照样能画它", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      await page.getByTestId("grid-editor-open").click();
      const dialog = page.getByTestId("grid-editor-dialog");

      // 关掉「区域1」的显示
      await expect(dialog.getByTestId("grid-editor-visible-1")).toBeChecked();
      await dialog.getByTestId("grid-editor-visible-1").uncheck();
      await expect(dialog.getByTestId("grid-editor-visible-1")).not.toBeChecked();

      // 关掉的是「画」：数据照样写得进去（同 Unity）
      await dialog.getByTestId("grid-editor-brush-1").click();
      const cell = { x: 6, y: 1 };
      await clickCell(page, cell);
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);

      // 再打开就看得见（开关状态也留着）
      await dialog.getByTestId("grid-editor-visible-1").check();
      await expect(dialog.getByTestId("grid-editor-visible-1")).toBeChecked();
    } finally {
      await dropProject(request, project);
    }
  });

  test("两个窗口互斥：开一个另一个自动关", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));
      await openFirstObject(page, project, "网格地图");

      // 先打开战争雾（关着时雾区设置不显示），再指定一个雾区
      await page.locator('[data-group="fog"]').getByTestId("fog-enable").check();
      await page.locator('[data-group="fog"]').getByTestId("fog-region-8").click();
      await page.locator('[data-group="fog"]').getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();

      // 关掉 Mask 窗口再从「区域」组打开网格编辑窗口
      await page.getByTestId("fog-mask-close").click();
      await page.getByTestId("grid-editor-open").click();
      await expect(page.getByTestId("grid-editor-dialog")).toBeVisible();
      await expect(page.getByTestId("fog-mask-dialog")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });
});
