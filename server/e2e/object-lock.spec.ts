import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  closeDrawers,
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openInspector,
  openLeftTab,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
  useMoveTool,
} from "./helpers/editor";
import { offsetFrom, preciseWorldPoint, scenePoint } from "./helpers/canvas";

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
  test("锁上后手柄拖不动、坐标框禁用；解锁后又能拖", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [sceneObjectDoc(DOOR, "SceneObject", { x: 0, y: 0 })]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await selectObject(page);
      // `selectObject` 会在平板下唤出左抽屉，而工具开关贴在画布左上角：先关掉再切工具
      await closeDrawers(page);
      await useMoveTool(page);
      await closeDrawers(page);

      /** 抓 X 轴中段往 +X 拖 120：对象的 x 应该跟着走。 */
      const dragAxis = async (): Promise<void> => {
        // 平板下属性是**覆盖式右抽屉**，会盖住画布右侧——不关掉，手柄的落点会被抽屉吃掉
        await closeDrawers(page);
        const position = await persistedPosition(request, project);
        // 用**真实视口**换算：手柄只有 7px，按「世界坐标 → 画布中心」算会整体偏掉
        // （平板档位就是这么超时的）
        const base = await preciseWorldPoint(page, position ?? { x: 0, y: 0 });
        const from = await offsetFrom(page, base, { x: 105, y: 0 });
        const to = await offsetFrom(page, from, { x: 120, y: 0 });
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
      };

      // 基线：未锁时手柄能拖（不然「拖不动」的断言可能只是因为压根拖不动）
      await dragAxis();

      await expect
        .poll(async () => (await persistedPosition(request, project))?.x ?? 0)
        .toBeGreaterThan(100);

      // 锁上：坐标框立刻禁用（锁 = 不能移动，留一个能改坐标的入口等于没锁）
      await openInspector(page);
      await page.getByTestId("inspector-object-locked").check();
      await expect(page.getByTestId("inspector-object-x")).toBeDisabled();
      await expect(page.getByTestId("inspector-object-y")).toBeDisabled();

      const locked = await persistedPosition(request, project);
      expect(locked).not.toBeNull();
      await closeDrawers(page);

      // 再拖一次手柄：锁定的对象手柄画着但点不到，所以这一下什么也不该发生
      await dragAxis();
      await page.waitForTimeout(1200);
      expect(await persistedPosition(request, project)).toEqual(locked);

      await page.getByTestId("reset-viewport").click();

      // 解锁：手柄又能拖了
      await openInspector(page);
      await page.getByTestId("inspector-object-locked").uncheck();
      await expect(page.getByTestId("inspector-object-x")).toBeEnabled();
      await closeDrawers(page);

      await dragAxis();

      await expect
        .poll(async () => (await persistedPosition(request, project))?.x ?? 0)
        .toBeGreaterThan((locked?.x ?? 0) + 100);
    } finally {
      await dropProject(request, project);
    }
  });

  test("列表里的锁：锁住地图后点画布仍能选中它，但拖不走", async ({ page, request }) => {
    // 本文件里最重的一条：建项目 → 开编辑器 → 开抽屉 → 点锁 → **轮询磁盘** → 关抽屉 →
    // 点画布 → 开属性面板断言 → 再关抽屉 → 一次真实拖拽（8 步）→ 等 1.2s → 再断言。
    // 满载并行跑（4+ worker，还要跟后端抢 HTTP）时 30s 不够，实测偶发超时——放宽到 60s，
    // 与 `scene-transform.spec.ts` 里那条拖拽用例同一处理（**没有放宽任何断言**）。
    test.setTimeout(60_000);

    const project = await newProject(request);
    try {
      // 地图声明成 1920×1080（铺满视口）——正是最容易被误拖的那种对象
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [mapObjectDoc(project, SCENE, "网格地图")]),
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

      // 在画布上拖它：位置一动不动（对象本体本就不会被跟手拖走，锁定的更不会）
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
