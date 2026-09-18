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
});
