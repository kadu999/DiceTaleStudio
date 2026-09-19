import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  closeDrawers,
  dropProject,
  enterEditor,
  newProject,
  openInspector,
  openLeftTab,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
} from "./helpers/editor";
import { scenePoint, sceneWorldAt, worldSamplePoint } from "./helpers/canvas";

/**
 * 对象的**锁定**：锁上就拖不动。
 *
 * 用「木门」这种小对象来量：从它身上按下 → 拖到别处 → 抬手，读数直接看场景文件里的
 * `position`。要注意**锁住的对象在画布上按下去拖动 = 平移画布**（它跟背景一个待遇），
 * 所以锁定那段走完要按「复位」把视口放回默认，后面的世界坐标换算才准。
 */

const SCENE = "Map001";
const DOOR = "木门";

/** 场景文件里某个对象的位置（读不到时返回 null）。 */
async function persistedPosition(
  request: APIRequestContext,
  project: string,
  name: string = DOOR,
): Promise<{ x: number; y: number } | null> {
  const id = `project:${project}/Assets/scenes/${SCENE}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    return null;
  }

  const raw = (await response.json()) as {
    objects?: Array<{ name?: string; position?: { x: number; y: number } | null }>;
  };
  return raw.objects?.find((object) => object.name === name)?.position ?? null;
}

test.describe("对象锁定", () => {
  test("锁上后画布上拖不动、坐标框禁用；解锁后又能拖", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [sceneObjectDoc(DOOR, "SceneObject", { x: 0, y: 0 })]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await selectObject(page);

      // 基线：未锁时能拖（不然「拖不动」的断言可能只是因为压根拖不动）
      const from = await worldSamplePoint(page, { x: 0, y: 0 });
      const to = { x: from.x + 120, y: from.y - 80 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();

      const movedTo = await sceneWorldAt(page, to);
      await expect
        .poll(async () => {
          const position = await persistedPosition(request, project);
          return position !== null && Math.hypot(position.x - movedTo.x, position.y - movedTo.y) < 4;
        })
        .toBe(true);

      // 锁上：坐标框立刻禁用（锁 = 不能移动，留一个能改坐标的入口等于没锁）
      await page.getByTestId("inspector-object-locked").check();
      await expect(page.getByTestId("inspector-object-x")).toBeDisabled();
      await expect(page.getByTestId("inspector-object-y")).toBeDisabled();

      const locked = await persistedPosition(request, project);
      expect(locked).not.toBeNull();

      // 再从对象身上拖一次。拖动是相对位移，所以断言「落点没变」而不是变多少。
      // 锁住的对象跟背景一个待遇：这一下会变成平移画布，所以之后要复位视口。
      await closeDrawers(page);
      const center = await worldSamplePoint(page, locked ?? { x: 0, y: 0 });
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 150, center.y + 90, { steps: 8 });
      await page.mouse.up();

      // 拖动要是真生效了，800ms 内必落盘；等它一下再读
      await page.waitForTimeout(1200);
      expect(await persistedPosition(request, project)).toEqual(locked);

      await page.getByTestId("reset-viewport").click();

      // 解锁：又能拖了
      await openInspector(page);
      await page.getByTestId("inspector-object-locked").uncheck();
      await expect(page.getByTestId("inspector-object-x")).toBeEnabled();

      await closeDrawers(page);
      const start = await worldSamplePoint(page, locked ?? { x: 0, y: 0 });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 140, start.y - 60, { steps: 8 });
      await page.mouse.up();

      await expect
        .poll(async () => {
          const position = await persistedPosition(request, project);
          return (
            position !== null &&
            Math.hypot(position.x - (locked?.x ?? 0), position.y - (locked?.y ?? 0)) > 20
          );
        })
        .toBe(true);
    } finally {
      await dropProject(request, project);
    }
  });

  test("列表里的锁：锁住地图后点画布仍能选中它，但拖不走", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 地图声明成 1920×1080（铺满视口）——正是最容易被误拖的那种对象
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          {
            ...sceneObjectDoc("网格地图", "Map", { x: 0, y: 0 }, { sortingOrder: -10 }),
            map: {
              image: {
                id: `project:${project}/Assets/images/${SCENE}.png`,
                width: 1920,
                height: 1080,
              },
              grid: { width: 64, height: 36 },
              rowOrder: "bottom-up",
              cells: { encoding: "rle", runs: [[0, 64 * 36]] },
            },
          },
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      // 平板下左栏是抽屉：先唤出来才看得到那行    
      await openLeftTab(page, "hierarchy");

      // 从列表里锁上（每行都有一枚锁）
      const lock = page.getByTestId("object-lock-toggle").first();
      await expect(lock).toHaveAttribute("data-locked", "false");
      await lock.click();
      await expect(lock).toHaveAttribute("data-locked", "true");

      // 落盘：locked 写进场景文件
      await expect
        .poll(async () => {
          const id = `project:${project}/Assets/scenes/${SCENE}.json`;
          const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
          const raw = (await response.json()) as { objects?: Array<{ locked?: boolean }> };
          return raw.objects?.[0]?.locked;
        })
        .toBe(true);

      // 锁着也点得中（锁只拦「移动」，不拦「选中」）：点一下画布正中，属性面板应显示已锁定
      await closeDrawers(page);
      const center = await scenePoint(page, 0, 0);
      await page.mouse.click(center.x, center.y);
      await openInspector(page);
      await expect(page.getByTestId("inspector-object-locked")).toBeChecked();

      // 在画布上拖它：位置一动不动
      await closeDrawers(page);
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 160, center.y + 120, { steps: 8 });
      await page.mouse.up();

      await page.waitForTimeout(1200);
      expect(await persistedPosition(request, project, "网格地图")).toEqual({ x: 0, y: 0 });
    } finally {
      await dropProject(request, project);
    }
  });
});
