import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  CURRENT_SCENE_FORMAT_VERSION,
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openMenu,
  openProject,
  sceneDoc,
  seedProjectDoc,
} from "./helpers/editor";

/**
 * 场景管理：菜单里的新建 / 重命名 / 删除。
 *
 * 场景是 `Assets/scenes/<场景名>.json` 独立文件，**场景名就是文件名**：
 * 编辑器只做建 / 删 / 改名，**永不写场景内容**。
 */

function sceneFileId(project: string, name: string): string {
  return `project:${project}/Assets/scenes/${name}.json`;
}

async function readSceneFile(
  request: APIRequestContext,
  project: string,
  name: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(
    `/api/resources/text?id=${encodeURIComponent(sceneFileId(project, name))}`,
  );
  expect(response.ok()).toBeTruthy();
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/** 打开「场景」菜单里的一项。 */
async function sceneMenu(page: Page, name: RegExp | string): Promise<void> {
  // 走 openMenu（限定在菜单栏里）：属性面板也有一个叫「场景」的分组标题
  await openMenu(page, "场景");
  await page.getByRole("menuitem", { name }).click();
}

test.describe("场景菜单", () => {
  test("新建场景：建出场景文件、成为当前场景", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");

      await sceneMenu(page, "新建场景…");
      await page.getByTestId("scene-name-input").fill("酒馆");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 酒馆");

      // 文件落在 Assets/scenes/ 下，而且**名字不进文件**（名字就是文件名）
      const file = await readSceneFile(request, project, "酒馆");
      expect(file.objects).toEqual([]);
      expect(file.formatVersion).toBe(CURRENT_SCENE_FORMAT_VERSION);
      expect("name" in file).toBe(false);
    } finally {
      await dropProject(request, project);
    }
  });

  test("重命名场景：只改文件名（没有地图对象时内容一字不动）", async ({ page, request }) => {    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("Map001", [
          { id: "door", name: "木门", kind: "SceneObject", position: null, rotation: 0, components: [] },
        ]),
      ]);
      await enterEditor(page);
      await openProject(page, project);
      const before = await readSceneFile(request, project, "Map001");

      await sceneMenu(page, /重命名/);
      await page.getByTestId("scene-name-input").fill("大厅");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 大厅");

      // 没有地图对象 → 没有贴图引用要同步。
      // **不再比对整个文件**：打开旧版本文件时它已被升到当前版本并补上新增字段
      // （`active` / `sortingOrder`），所以「一字不动」只对**对象内容**成立。
      const after = await readSceneFile(request, project, "大厅");
      expect(after.formatVersion).toBe(CURRENT_SCENE_FORMAT_VERSION);

      const door = (file: Record<string, unknown>): Record<string, unknown> =>
        (file.objects as Record<string, unknown>[] | undefined)?.[0] ?? {};
      // 除新增字段外，其余字段逐字一致（id / 名字 / 类型 / 位置 / 旋转 / 组件）
      const withoutNewFields = (object: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(object).filter(([key]) => key !== "active" && key !== "sortingOrder"),
        );

      expect(withoutNewFields(door(after))).toEqual(withoutNewFields(door(before)));

      // 旧文件不存在了
      const old = await request.get(
        `/api/resources/text?id=${encodeURIComponent(sceneFileId(project, "Map001"))}`,
      );
      expect(old.status()).toBe(404);
    } finally {
      await dropProject(request, project);
    }
  });

  test("重命名场景：与场景同名的贴图引用跟着改名（否则贴图立刻找不到）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("Map001", [mapObjectDoc(project, "Map001")]),
      ]);
      await enterEditor(page);
      await openProject(page, project);

      await sceneMenu(page, /重命名/);
      await page.getByTestId("scene-name-input").fill("大厅");
      await page.getByTestId("confirm-scene").click();
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 大厅");

      // 贴图是按「与场景同名」约定引用的，所以引用要一起改指到 大厅.png
      const file = (await readSceneFile(request, project, "大厅")) as {
        objects: Array<{ map?: { image?: { id?: string } } }>;
      };
      expect(file.objects[0]?.map?.image?.id).toBe(
        `project:${project}/Assets/images/大厅.png`,
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("删除场景：删掉场景文件", async ({ page, request }) => {
    const project = await newProject(request);
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await sceneMenu(page, /^删除/);

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");

      const removed = await request.get(
        `/api/resources/text?id=${encodeURIComponent(sceneFileId(project, "Map001"))}`,
      );
      expect(removed.status()).toBe(404);
    } finally {
      await dropProject(request, project);
    }
  });

  test("没有场景时：点画布上的占位就能新建场景", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("no-scene-canvas")).toBeVisible();

      // 占位本身就是入口。注意「场景对象」面板里也有同样的占位（它默认就显示），
      // 所以这里限定在**画布**上点。
      await page.getByTestId("no-scene-canvas").getByTestId("empty-create-scene").click();
      await expect(page.getByTestId("scene-dialog")).toBeVisible();
      await page.getByTestId("scene-name-input").fill("Map001");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");
      // 有场景了，画布上的占位就该消失
      await expect(page.getByTestId("no-scene-canvas")).toHaveCount(0);
      // 场景对象面板里的占位同样消失
      await expect(page.getByTestId("object-tree").getByTestId("empty-create-scene")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("当前场景看得见，也能直接切换", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);

      // 画布标题栏就是当前场景：看得见、能切
      const switcher = page.getByTestId("scene-switcher");
      await expect(switcher).toHaveValue("Map001");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await switcher.selectOption("Map002");

      await expect(switcher).toHaveValue("Map002");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");
    } finally {
      await dropProject(request, project);
    }
  });

  test("在资源面板里点场景文件就能切过去（当前场景那行高亮）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await openLeftTab(page, "assets");
      await page.getByTestId("folder-tree-row").filter({ hasText: "scenes" }).first().click();

      const contentRows = page.getByTestId("folder-content-row");
      // 目录里不显示扩展名，当前场景那一行是选中的
      await expect(contentRows.filter({ hasText: "Map001" })).toHaveAttribute(
        "data-selected",
        "true",
      );
      await expect(contentRows.filter({ hasText: "Map001.json" })).toHaveCount(0);

      // 点另一个场景文件即切过去
      await contentRows.filter({ hasText: "Map002" }).first().click();

      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");
      await expect(page.getByTestId("scene-switcher")).toHaveValue("Map002");
      await expect(contentRows.filter({ hasText: "Map002" })).toHaveAttribute(
        "data-selected",
        "true",
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("保护：重名被拒绝（不覆盖已有场景）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      // 改名到已存在的场景名：对话框里给错误、不关窗
      await sceneMenu(page, /重命名/);
      await page.getByTestId("scene-name-input").fill("Map002");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("scene-dialog")).toBeVisible();
      await expect(page.getByText("场景「Map002」已存在")).toBeVisible();
      await page.getByTestId("scene-dialog-cancel").click();
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
    } finally {
      await dropProject(request, project);
    }
  });

  test("保护：只剩一个场景时不能删", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001")]);
      await enterEditor(page);
      await openProject(page, project);

      await openMenu(page, "场景");
      await expect(page.getByRole("menuitem", { name: /^删除/ })).toBeDisabled();
      await page.keyboard.press("Escape");
    } finally {
      await dropProject(request, project);
    }
  });
});
