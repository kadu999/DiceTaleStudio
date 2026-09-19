import { expect, test } from "@playwright/test";
import {
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
} from "./helpers/editor";

/**
 * 属性面板的**分组**（可折叠）：地图对象分「基础 / 编辑」，点标题收起 / 展开。
 *
 * 这里只驱动真实界面（分组是纯 UI 行为，没有数据副作用），所以一条用例够了；
 * 「换对象时重置」「折叠不动数据」由 jsdom 那条 `inspector-groups.test.tsx` 覆盖。
 */

const SCENE = "Map001";

test.describe("属性分组", () => {
  test("地图分「基础 / 编辑」两组，点标题可收起 / 展开；精灵没有编辑组", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          mapObjectDoc(project, SCENE, "网格地图", { width: 400, height: 300 }, { width: 8, height: 6 }),
          sceneObjectDoc("精灵", "SceneObject", { x: 200, y: 0 }),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 选中地图（列表第一行）→ 属性面板应有两个分组
      await selectObject(page, 0);

      const basic = page.locator('[data-group="basic"]');
      const edit = page.locator('[data-group="edit"]');
      await expect(basic).toBeVisible();
      await expect(edit).toBeVisible();
      // 默认都展开
      await expect(basic).toHaveAttribute("data-open", "true");
      await expect(edit).toHaveAttribute("data-open", "true");
      await expect(basic).toContainText("名称");
      await expect(edit).toContainText("网格标注");

      const editHeader = edit.getByTestId("field-group-header");
      await expect(editHeader).toHaveAttribute("aria-expanded", "true");

      // 收起「编辑」：内容整块消失，但分组标题还在（还能再展开）
      await editHeader.click();
      await expect(edit).toHaveAttribute("data-open", "false");
      await expect(edit).toContainText("编辑");
      await expect(edit.getByTestId("grid-paint-enter")).toHaveCount(0);
      // 另一个分组不受影响
      await expect(basic).toHaveAttribute("data-open", "true");

      // 再点一下展开
      await editHeader.click();
      await expect(edit).toHaveAttribute("data-open", "true");
      await expect(edit.getByTestId("grid-paint-enter")).toBeVisible();

      // 精灵：只有「基础」，没有「编辑」（格子是地图独有的）
      await selectObject(page, 1);
      await expect(page.locator('[data-group="basic"]')).toBeVisible();
      await expect(page.locator('[data-group="edit"]')).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  /**
   * 外观契约：三个「看相」问题各钉一条**可量的**断言（jsdom 里没有样式计算，只能在真浏览器里量）。
   *
   * - 箭头够大：表头里的 SVG 宽度 ≥ 12px（以前是 10px 的 `▾` 字形）
   * - 「条」明显：表头**平时就有底色**（不是只有 hover 才出现）、高度 ≥ 22px
   * - 不再是线格：属性行没有下边框，只有分组卡片自己有边框
   */
  test("表头是一条有底色的条、箭头是够大的 SVG、属性行没有分隔线", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          mapObjectDoc(project, SCENE, "网格地图", { width: 400, height: 300 }, { width: 8, height: 6 }),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      await selectObject(page, 0);

      const header = page.locator('[data-group="basic"] [data-testid="field-group-header"]');
      const arrow = header.locator("svg");
      await expect(header).toBeVisible();
      await expect(arrow).toBeVisible();

      const arrowBox = await arrow.boundingBox();
      expect(arrowBox?.width ?? 0).toBeGreaterThanOrEqual(12);
      expect(arrowBox?.height ?? 0).toBeGreaterThanOrEqual(12);

      const headerBox = await header.boundingBox();
      expect(headerBox?.height ?? 0).toBeGreaterThanOrEqual(22);

      // 「条」= 平时就有底色（面板底色是 #1b1e24，表头是 #20242b）
      const headerBackground = await header.evaluate(
        (element) => window.getComputedStyle(element).backgroundColor,
      );
      expect(headerBackground).not.toBe("rgba(0, 0, 0, 0)");

      // 行不再画线：名称那行没有下边框……
      const nameRow = page.getByTestId("inspector-object-name").locator("xpath=../..");
      expect(
        await nameRow.evaluate((element) => window.getComputedStyle(element).borderBottomWidth),
      ).toBe("0px");

      // ……但分组卡片自己的边框还在（分组的边界靠它）
      expect(
        await page
          .locator('[data-group="basic"]')
          .evaluate((element) => window.getComputedStyle(element).borderBottomWidth),
      ).not.toBe("0px");
    } finally {
      await dropProject(request, project);
    }
  });
});
