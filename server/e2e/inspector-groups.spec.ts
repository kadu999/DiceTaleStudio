import { expect, test } from "@playwright/test";
import {
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openProject,
  sceneDoc,
  gameObjectDoc,
  seedProjectDoc,
  selectObject,
} from "./helpers/editor";

/**
 * 属性面板的**分组**（可折叠）：地图对象分「基础 / 渲染 / 区域 / 战争雾」四组，点标题收起 / 展开。
 *
 * 这里只驱动真实界面（分组是纯 UI 行为，没有数据副作用），所以一条用例够了；
 * 「换对象时重置」「折叠不动数据」由 jsdom 那条 `inspector-groups.test.tsx` 覆盖。
 */

const SCENE = "Map001";

test.describe("属性分组", () => {
  test("地图分「基础 / 渲染 / 区域 / 战争雾」四组，点标题可收起 / 展开；贴图有「视频」、精灵没有", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          mapObjectDoc(project, SCENE, "网格地图", { width: 400, height: 300 }, { width: 8, height: 6 }),
          gameObjectDoc("精灵", "Sprite", { x: 200, y: 0 }),
          // 贴图：视频那一组的宿主（v21 起从精灵换成贴图）
          gameObjectDoc("贴图", "Image", { x: -200, y: 0 }),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 选中地图（列表第一行）→ 属性面板应有五个分组
      await selectObject(page, 0);

      const basic = page.locator('[data-group="basic"]');
      const render = page.locator('[data-group="render"]');
      const edit = page.locator('[data-group="edit"]');
      const fog = page.locator('[data-group="fog"]');
      const video = page.locator('[data-group="video"]');
      await expect(basic).toBeVisible();
      await expect(render).toBeVisible();
      await expect(edit).toBeVisible();
      await expect(fog).toBeVisible();
      await expect(video).toBeVisible();
      // 默认都展开
      await expect(basic).toHaveAttribute("data-open", "true");
      await expect(render).toHaveAttribute("data-open", "true");
      await expect(edit).toHaveAttribute("data-open", "true");
      await expect(fog).toHaveAttribute("data-open", "true");
      await expect(video).toHaveAttribute("data-open", "true");
      await expect(basic).toContainText("名称");
      await expect(render).toContainText("贴图");
      await expect(edit).toContainText("区域");
      await expect(edit).toContainText("网格标注");
      // 战争雾那一组关着时只有开关（打开才露出雾区设置，见 fog-mask.spec.ts）
      await expect(fog).toContainText("战争雾");
      await expect(fog).toContainText("启用");
      // 视频那一组还没开时只剩「启用」那一个开关（打开之后的样子见 video-object.spec.ts）
      await expect(video).toContainText("视频");
      await expect(video.getByTestId("video-enable")).toBeVisible();
      await expect(video.getByTestId("video-clips")).toHaveCount(0);

      const renderHeader = render.getByTestId("field-group-header");
      await expect(renderHeader).toHaveAttribute("aria-expanded", "true");

      // 「渲染」**排在「基础」下面**（贴图那一行搬进来了，基础组里不再有它）
      await expect(render.getByTestId("pick-texture")).toBeVisible();
      await expect(basic.getByTestId("pick-texture")).toHaveCount(0);
      // 网格规格（列 · 行 / 每格 / 行序）搬进了「区域」：基础组里不再有它
      await expect(edit.getByTestId("inspector-grid-columns")).toBeVisible();
      await expect(edit.getByTestId("inspector-grid-rows")).toBeVisible();
      await expect(edit).toContainText("每格");
      await expect(edit).toContainText("行序");
      await expect(basic.getByTestId("inspector-grid-columns")).toHaveCount(0);
      await expect(basic).not.toContainText("每格");
      await expect(basic).not.toContainText("行序");
      // 只在**对象属性**里数列（`data-group` 这种通用属性别人也在用，
      // 例如分栏容器 react-resizable-panels 就给自己的 div 挂了一个）
      const order = await page
        .locator('[data-testid="object-properties"] [data-group]')
        .evaluateAll((sections) => sections.map((section) => section.getAttribute("data-group")));
      expect(order).toEqual(["basic", "render", "edit", "fog", "video"]);

      // 收起「渲染」：内容整块消失，但分组标题还在（还能再展开）
      await renderHeader.click();
      await expect(render).toHaveAttribute("data-open", "false");
      await expect(render).toContainText("渲染");
      await expect(render.getByTestId("pick-texture")).toHaveCount(0);
      // 其它分组不受影响
      await expect(basic).toHaveAttribute("data-open", "true");

      // 再点一下展开
      await renderHeader.click();
      await expect(render).toHaveAttribute("data-open", "true");
      await expect(render.getByTestId("pick-texture")).toBeVisible();

      const editHeader = edit.getByTestId("field-group-header");
      // 收起「区域」：内容整块消失，但分组标题还在（还能再展开）
      await editHeader.click();
      await expect(edit).toHaveAttribute("data-open", "false");
      await expect(edit).toContainText("区域");
      await expect(edit.getByTestId("grid-editor-open")).toHaveCount(0);
      await expect(edit.getByTestId("inspector-grid-columns")).toHaveCount(0);
      // 另一个分组不受影响
      await expect(basic).toHaveAttribute("data-open", "true");

      // 再点一下展开
      await editHeader.click();
      await expect(edit).toHaveAttribute("data-open", "true");
      await expect(edit.getByTestId("grid-editor-open")).toBeVisible();
      await expect(edit.getByTestId("inspector-grid-columns")).toBeVisible();

      // 收起「战争雾」：入口那行消失，标题还在
      const fogHeader = fog.getByTestId("field-group-header");
      await fogHeader.click();
      await expect(fog).toHaveAttribute("data-open", "false");
      await expect(fog.getByTestId("fog-enable")).toHaveCount(0);
      await fogHeader.click();
      await expect(fog).toHaveAttribute("data-open", "true");
      await expect(fog.getByTestId("fog-enable")).toBeVisible();

      // 收起「视频」：那一个开关也消失，标题还在
      const videoHeader = video.getByTestId("field-group-header");
      await videoHeader.click();
      await expect(video).toHaveAttribute("data-open", "false");
      await expect(video.getByTestId("video-enable")).toHaveCount(0);
      await videoHeader.click();
      await expect(video).toHaveAttribute("data-open", "true");
      await expect(video.getByTestId("video-enable")).toBeVisible();

      // 精灵：只有「基础 / 渲染」（**没有视频**——v21 起那一组归贴图），
      // 也没有「区域 / 战争雾」（都是地图独有的）
      await selectObject(page, 1);
      await expect(page.locator('[data-group="basic"]')).toBeVisible();
      await expect(page.locator('[data-group="render"]')).toBeVisible();
      await expect(page.locator('[data-group="video"]')).toHaveCount(0);
      await expect(page.locator('[data-group="edit"]')).toHaveCount(0);
      await expect(page.locator('[data-group="fog"]')).toHaveCount(0);

      // 贴图：有「基础 / 渲染 / 视频」，同样没有地图那两组
      await selectObject(page, 2);
      await expect(page.locator('[data-group="basic"]')).toBeVisible();
      await expect(page.locator('[data-group="render"]')).toBeVisible();
      await expect(page.locator('[data-group="video"]')).toBeVisible();
      await expect(page.locator('[data-group="edit"]')).toHaveCount(0);
      await expect(page.locator('[data-group="fog"]')).toHaveCount(0);
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
