import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  dropProject,
  enterEditor,
  expandRuns,
  mapObjectDoc,
  newProject,
  openProject,
  readSceneMap,
  sceneDoc,
  seedProjectDoc,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";
import {
  canvasAverageColor,
  canvasPointReachable,
  findEmptyCanvasPoint,
  worldSamplePoint,
} from "./helpers/canvas";

/**
 * 网格标注（地图编辑）：选中地图 → 属性面板开标注 → 在画布上涂抹 → 落进场景文件的 RLE。
 *
 * 种出来的地图刻意小：贴图声明 400×300、网格 8×6 → 每格 50×50px，
 * 屏幕上的落点好算、格子边界也离得开网格线（采样不会被线干扰）。
 * 默认视口是 1:1 且世界原点在画布正中，所以「世界坐标 → 屏幕点」只有一步（见 helpers/canvas）。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

/** 表格格心（默认视口：世界原点 = 贴图中心）。 */
function cellCenter(cell: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (cell.x + 0.5) * (MAP_SIZE.width / GRID.width) - MAP_SIZE.width / 2,
    y: (cell.y + 0.5) * (MAP_SIZE.height / GRID.height) - MAP_SIZE.height / 2,
  };
}

interface ReachableCell {
  readonly cell: { x: number; y: number };
  readonly point: { x: number; y: number };
}

/**
 * 找出**点得到**的格子（从正中往外扫，最多 `wanted` 个）。
 *
 * 平板下右半边被属性抽屉盖住，「中间那一格」不一定点得到——所以不猜，直接按格心换算出
 * 屏幕点再验证（`elementFromPoint` 真的落在画布上）。
 */
async function reachableCells(page: Page, wanted = 1): Promise<ReachableCell[]> {
  const found: ReachableCell[] = [];
  const center = { x: Math.floor(GRID.width / 2), y: Math.floor(GRID.height / 2) };
  const limit = Math.max(GRID.width, GRID.height);

  for (let radius = 0; radius <= limit && found.length < wanted; radius += 1) {
    for (let dy = -radius; dy <= radius && found.length < wanted; dy += 1) {
      for (let dx = -radius; dx <= radius && found.length < wanted; dx += 1) {
        const cell = { x: center.x + dx, y: center.y + dy };
        if (cell.x < 0 || cell.x >= GRID.width || cell.y < 0 || cell.y >= GRID.height) {
          continue;
        }

        const point = await worldSamplePoint(page, cellCenter(cell));
        if (await canvasPointReachable(page, point)) {
          found.push({ cell, point });
        }
      }
    }
  }

  if (found.length < wanted) {
    throw new Error(`只找到 ${found.length} 个可点击的格子（需要 ${wanted} 个）`);
  }

  return found;
}

/** 画布上这个点的「红度」：贴图是纯白，标注上障碍（红，α0.6）后 r 远大于 g。 */
async function redness(page: Page, point: { x: number; y: number }): Promise<number> {
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

/** 属性面板：桌面下常驻；平板下是右抽屉，先唤出来（没有那个按钮就说明已经可见）。 */
async function openInspector(page: Page): Promise<void> {
  if (await page.getByTestId("grid-paint-enter").isVisible().catch(() => false)) {
    return;
  }

  const toggle = page.getByRole("button", { name: "属性", exact: true });
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  }
}

/** 打开一个「只有一张小地图」的项目，选中地图并进入标注模式。 */
async function enterAnnotating(page: Page, request: APIRequestContext, project: string): Promise<void> {
  await enterEditor(page);
  await openProject(page, project);

  // 选中地图：世界原点就是贴图中心，点画布正中即命中（地图是唯一的对象）
  const center = await worldSamplePoint(page, { x: 0, y: 0 });
  await page.mouse.click(center.x, center.y);
  await openInspector(page);

  await expect(page.getByTestId("inspector-object-name")).toHaveValue("网格地图");
  await page.getByTestId("grid-paint-enter").click();
  await expect(page.getByTestId("scene-viewport")).toHaveAttribute("data-grid-paint", "true");
  await expect(page.getByTestId("grid-paint-badge")).toBeVisible();
}

test.describe("网格标注", () => {
  test("标注一格：画布着色 → 落盘 → 撤销/重做 → 清空", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));

      await enterAnnotating(page, request, project);

      const [target] = await reachableCells(page);
      expect(target).toBeDefined();
      const cell = target!.cell;

      // 点一下 = 一格（默认画笔是障碍、1 号画笔）
      await page.mouse.click(target!.point.x, target!.point.y);
      // 挪开指针：画布上的画笔预览会垫一层半透明白，采样要看画上去的颜色本身
      await page.mouse.move(4, 4);

      await expect.poll(() => redness(page, target!.point)).toBeGreaterThan(60);
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);

      // 一整笔 = 一条撤销记录：Ctrl+Z 回到全空，Ctrl+Shift+Z 又回来
      await page.keyboard.press("Control+z");
      await expect.poll(() => persistedMask(request, project, cell)).toBe(0);
      await expect.poll(() => redness(page, target!.point)).toBeLessThan(40);

      await page.keyboard.press("Control+Shift+z");
      await expect.poll(() => persistedMask(request, project, cell)).toBe(1);

      // 清空：格子回到空游程（铺满整张网格，不是空数组）
      await page.getByTestId("grid-clear").click();
      await expect
        .poll(async () => (await readSceneMap(request, project, SCENE))?.runs)
        .toEqual([[0, GRID.width * GRID.height]]);
      await expect(page.getByTestId("grid-annotated-count")).toHaveText("0 格");
    } finally {
      await dropProject(request, project);
    }
  });

  test("拖一笔：直线经过的格子连成一片（中间不落空）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));

      await enterAnnotating(page, request, project);

      const [from, to] = await reachableCells(page, 2);
      expect(from).toBeDefined();
      expect(to).toBeDefined();

      await page.mouse.move(from!.point.x, from!.point.y);
      await page.mouse.down();
      await page.mouse.move(to!.point.x, to!.point.y, { steps: 8 });
      await page.mouse.up();
      await page.mouse.move(4, 4);

      // 两端一定被画到（中间的格子由「补齐直线」负责，见 @dts/grid 的 strokeCenters）
      await expect.poll(() => persistedMask(request, project, from!.cell)).toBe(1);
      await expect.poll(() => persistedMask(request, project, to!.cell)).toBe(1);

      // 整笔画了不止一格，而且都落进了同一条 RLE（数据合法：格数 = 列 × 行）
      const map = await readSceneMap(request, project, SCENE);
      const cells = expandRuns(map?.runs ?? []);
      expect(cells).toHaveLength(GRID.width * GRID.height);
      expect(cells.filter((mask) => mask !== 0).length).toBeGreaterThan(1);
    } finally {
      await dropProject(request, project);
    }
  });

  test("网格外点击不画（也不会取消选中）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));

      await enterAnnotating(page, request, project);

      // 地图之外、但仍在画布上的一点（贴图只占 400×300）
      const blank = await findEmptyCanvasPoint(page);
      await page.mouse.click(blank.x, blank.y);
      await page.mouse.move(4, 4);

      // 什么都没画，而且还在标注模式（点网格外不该把地图取消选中、把调色板收掉）
      await expect
        .poll(async () => (await readSceneMap(request, project, SCENE))?.runs)
        .toEqual([[0, GRID.width * GRID.height]]);
      await expect(page.getByTestId("scene-viewport")).toHaveAttribute("data-grid-paint", "true");
      await expect(page.getByTestId("grid-brush-size")).toBeVisible();
    } finally {
      await dropProject(request, project);
    }
  });

  test("显示开关只影响画布，不影响数据", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID)]),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [255, 255, 255]));

      await enterAnnotating(page, request, project);

      const [target] = await reachableCells(page);
      await page.mouse.click(target!.point.x, target!.point.y);
      await page.mouse.move(4, 4);
      await expect.poll(() => redness(page, target!.point)).toBeGreaterThan(60);

      // 关掉「障碍」的显示：画布不再着色……
      await page.getByTestId("grid-type-visible-1").uncheck();
      await expect.poll(() => redness(page, target!.point)).toBeLessThan(40);
      // ……但格子的数据还在（自动存有 800ms 防抖，所以这里也要等落盘）
      await expect.poll(() => persistedMask(request, project, target!.cell)).toBe(1);

      // 再打开就回来
      await page.getByTestId("grid-type-visible-1").check();
      await expect.poll(() => redness(page, target!.point)).toBeGreaterThan(60);
    } finally {
      await dropProject(request, project);
    }
  });
});
