import { expect, test } from "@playwright/test";
import {
  createProjectViaUi,
  dropProject,
  enterEditor,
  gotoEditor,
  newProject,
  sceneDoc,
  seedProjectDoc,
  startupDialogMode,
  waitForBootstrap,
} from "./helpers/editor";

/**
 * 启动行为。
 *
 * 规则：
 * 1. 有「上次打开的项目」且它还在 → 直接打开它，不弹对话框；
 * 2. 一个项目都没有 → 弹「新建项目」；
 * 3. 有项目但没有（或已失效的）上次记录 → 弹「打开项目」列表让用户挑。
 *
 * 判定「是不是项目」只看一条：文件夹里有没有 `project.json`。
 */
test.describe("编辑器启动引导", () => {
  test("一个项目都没有时，自动弹出「新建项目」", async ({ page }) => {
    // 把项目列表打桩成空，避免依赖仓库里现存的资源
    await page.route("**/api/projects", (route) => route.fulfill({ json: { projects: [] } }));

    await gotoEditor(page);

    expect(await startupDialogMode(page)).toBe("create");
    await expect(page.getByTestId("project-dialog")).toBeVisible();
    await expect(page.getByTestId("project-name-input")).toBeVisible();
  });

  test("有项目但没有上次记录时，弹出「打开项目」列表", async ({ page }) => {
    await page.route("**/api/projects", (route) =>
      route.fulfill({ json: { projects: [{ name: "已有项目", fileCount: 2 }] } }),
    );

    await gotoEditor(page);

    expect(await startupDialogMode(page)).toBe("open");
    await expect(page.getByTestId("project-row").filter({ hasText: "已有项目" })).toBeVisible();
  });

  test("新建项目后刷新：自动回到上次的项目，不再弹对话框", async ({ page, request }) => {
    const name = `E2E启动${Date.now().toString(36)}`;
    try {
      await enterEditor(page);
      await createProjectViaUi(page, name);
      // 场景列表页签已移除：直接把一个场景写进工程文件，验证刷新后确实是从磁盘读回来的
      await seedProjectDoc(request, name, [sceneDoc("Map001")]);

      await page.reload();
      await waitForBootstrap(page);

      // 记住了上次的项目：直接进去，不弹任何对话框
      expect(await startupDialogMode(page)).toBe("none");
      await expect(page.getByTestId("project-dialog")).toBeHidden();
      await expect(page.getByTestId("status-doc")).toHaveText(name);
      // 场景是从磁盘读回来的，不是留在内存里的残影
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
    } finally {
      await dropProject(request, name);
    }
  });

  test("主动关闭项目后刷新：不再自动打开它", async ({ page, request }) => {
    const name = `E2E关闭${Date.now().toString(36)}`;
    try {
      await enterEditor(page);
      await createProjectViaUi(page, name);

      await page.getByRole("button", { name: "工程", exact: true }).click();
      await page.getByRole("menuitem", { name: /关闭项目/ }).click();
      await expect(page.getByTestId("status-doc")).toHaveText("未命名项目");

      await page.reload();
      await waitForBootstrap(page);

      // 关闭 = 忘记：退回项目列表，而不是又把刚关掉的项目拉回来
      expect(await startupDialogMode(page)).toBe("open");
      await expect(page.getByTestId("status-doc")).toHaveText("未命名项目");
      await expect(page.getByTestId("project-row").filter({ hasText: name })).toBeVisible();
    } finally {
      await dropProject(request, name);
    }
  });

  test("上次的项目已被删掉时，退回项目列表而不是卡住", async ({ page, request }) => {
    // 另建一个项目：记录失效后列表仍然非空，才走「弹打开列表」而不是「弹新建」
    const other = await newProject(request);
    const name = `E2E失效${Date.now().toString(36)}`;
    try {
      await enterEditor(page);
      await createProjectViaUi(page, name);

      // 项目在别处被删了：本地记录随即失效
      await dropProject(request, name);

      await page.reload();
      await waitForBootstrap(page);

      expect(await startupDialogMode(page)).toBe("open");
      await expect(page.getByTestId("project-row").filter({ hasText: name })).toHaveCount(0);
      await expect(page.getByTestId("project-row").filter({ hasText: other })).toBeVisible();
    } finally {
      await dropProject(request, name);
      await dropProject(request, other);
    }
  });
});
