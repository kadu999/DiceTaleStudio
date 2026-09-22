import { expect, test } from "@playwright/test";
import {
  dropProject,
  dropStrayFolder,
  enterEditor,
  newProject,
  openLeftTab,
  openProject,
} from "./helpers/editor";

/**
 * 项目：新建 / 打开 / 资源面板（Assets）。
 *
 * 项目目录对齐 Unity 模板：项目根只有「项目文件 + `Assets/`」，
 * 所有资源都在 `Assets/` 下。面板**只读**：素材由人/外部工具提交到指定目录。
 *
 * 每个用例自建数据并自清理，互不依赖。
 */

/** `Assets/` 下预建的标准目录（约定见 @dts/resources 的 PROJECT_FOLDERS）。 */
const STANDARD_FOLDERS = ["config", "scenes", "images", "audio", "video"];

test.describe("项目", () => {
  test("新建项目后自动打开，资源面板显示 Assets 与标准目录", async ({ page, request }) => {
    const name = `E2E新建${Date.now().toString(36)}`;
    try {
      await enterEditor(page);
      await openLeftTab(page, "assets");

      // 未打开项目时给出明确指引，而不是空白面板
      await expect(page.getByText("还没有打开项目")).toBeVisible();
      // 没有项目就没有可打开的目录
      await expect(page.getByTestId("open-project-folder")).toHaveCount(0);

      await page.getByRole("button", { name: "工程", exact: true }).click();
      await page.getByRole("menuitem", { name: "新建项目…" }).click();
      await page.getByTestId("project-name-input").fill(name);
      await page.getByTestId("confirm-create-project").click();

      await openLeftTab(page, "assets");
      await expect(page.getByTestId("status-doc")).toHaveText(name);

      // 「打开目录」按钮：**只断言在**（真的有项目才出现）——点它会去开后端那台机器的
      // 资源管理器，跑测试时不该弹出窗口。接口行为由后端用例用注入的实现覆盖。
      await expect(page.getByTestId("open-project-folder")).toBeEnabled();

      const treeRows = page.getByTestId("folder-tree-row");
      const contentRows = page.getByTestId("folder-content-row");

      // 树根就是 Assets（对齐 Unity）：项目名不出现在目录树里
      await expect(treeRows).toHaveCount(1 + STANDARD_FOLDERS.length);
      await expect(treeRows.filter({ hasText: "Assets" })).toHaveCount(1);
      await expect(treeRows.filter({ hasText: name })).toHaveCount(0);
      // 每行都带类型图标（内联 SVG，不是字体字形）；`data-icon` 是给这里钉的
      await expect(treeRows.first()).toHaveAttribute("data-icon", "folder");
      // 目录树的行 = **展开三角 + 文件夹图标**两枚 SVG（三角能展开 / 收起那一层）；
      // 内层行（内容列）没有三角，只有类型图标。按具体的 `data-icon` 断言，
      // 别按 `svg` 的条数——那样下次多加一枚装饰图标就会变成假红。
      await expect(treeRows.first().locator('svg[data-icon="chevron"]')).toHaveCount(1);
      await expect(treeRows.first().locator('svg[data-icon="folder"]')).toHaveCount(1);
      await expect(contentRows.first()).toHaveAttribute("data-icon", "folder");
      await expect(contentRows.first().locator('svg[data-icon="folder"]')).toHaveCount(1);
      await expect(contentRows.first().locator('svg[data-icon="chevron"]')).toHaveCount(0);

      // 右列默认显示 Assets 的内容
      await expect(page.getByTestId("folder-breadcrumb")).toHaveText("/");
      await expect(contentRows).toHaveCount(STANDARD_FOLDERS.length);
      for (const folder of STANDARD_FOLDERS) {
        await expect(contentRows.filter({ hasText: folder }).first()).toBeVisible();
      }

      // 项目文件是特殊文件，两侧都不该出现；maps / items 也不再是标准目录
      await expect(contentRows.filter({ hasText: "project.json" })).toHaveCount(0);
      await expect(treeRows.filter({ hasText: "project.json" })).toHaveCount(0);
      await expect(contentRows.filter({ hasText: "maps" })).toHaveCount(0);
      await expect(contentRows.filter({ hasText: "items" })).toHaveCount(0);
    } finally {
      await dropProject(request, name);
    }
  });

  test("打开项目对话框只列出有 project.json 的项目", async ({ page, request }) => {
    const project = await newProject(request);
    const stray = `E2E残骸${Date.now().toString(36)}`;

    // 造一个只有目录、没有 project.json 的残留
    const created = await request.post("/api/projects/folder", {
      data: { project: stray, path: "Assets/scenes" },
    });
    expect(created.ok()).toBeTruthy();

    try {
      await enterEditor(page);
      await page.getByRole("button", { name: "工程", exact: true }).click();
      await page.getByRole("menuitem", { name: "打开项目…" }).click();

      await expect(page.getByTestId("project-row").filter({ hasText: project })).toBeVisible();
      // 没有 project.json 的目录不是项目，不该出现在列表里
      await expect(page.getByTestId("project-row").filter({ hasText: stray })).toHaveCount(0);
    } finally {
      await dropProject(request, project);
      await dropStrayFolder(request, stray);
    }
  });

  test("素材提交到指定目录后出现在面板里，且面板只读", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 资源不由编辑器写入：这里模拟外部把素材提交进项目目录
      const submitted = await request.put(
        `/api/resources/raw?id=${encodeURIComponent(`project:${project}/Assets/images/Map001.png`)}`,
        {
          headers: { "content-type": "image/png" },
          data: Buffer.from([137, 80, 78, 71]),
        },
      );
      expect(submitted.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "assets");

      // 右列可以逐级往下走：根（Assets）→ images
      const contentRows = page.getByTestId("folder-content-row");
      await expect(page.getByTestId("folder-breadcrumb")).toHaveText("/");

      await contentRows.filter({ hasText: "images" }).first().click();
      await expect(page.getByTestId("folder-breadcrumb")).toHaveText("/images");
      // 列表里**不显示扩展名**（完整文件名在属性面板里看）
      await expect(contentRows.filter({ hasText: "Map001" })).toBeVisible();
      await expect(contentRows.filter({ hasText: "Map001.png" })).toHaveCount(0);

      // 暂时不提供编辑：没有新建 / 导入 / 删除入口
      await expect(page.getByRole("button", { name: "新建文件夹" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "导入资源" })).toHaveCount(0);
      await expect(page.getByTestId("asset-file-input")).toHaveCount(0);
      await expect(page.getByLabel(/^删除 /)).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("选中贴图 / 视频可以查看属性（图片尺寸从图片本身读出）", async ({ page, request }) => {
    const project = await newProject(request);
    // 一张真的 1×1 PNG：这样「尺寸」只能是从图片本身读出来的
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const tinyMp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

    try {
      const uploads: Array<[string, string, Buffer]> = [
        ["Assets/images/Map001.png", "image/png", onePixelPng],
        ["Assets/video/Map002.mp4", "video/mp4", tinyMp4],
      ];
      for (const [subPath, contentType, data] of uploads) {
        const response = await request.put(
          `/api/resources/raw?id=${encodeURIComponent(`project:${project}/${subPath}`)}`,
          { headers: { "content-type": contentType }, data },
        );
        expect(response.ok()).toBeTruthy();
      }

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "assets");

      // 进 images/ 选中贴图（列表里显示的名字不带扩展名）
      const contentRows = page.getByTestId("folder-content-row");
      await contentRows.filter({ hasText: "images" }).first().click();
      await contentRows.filter({ hasText: "Map001" }).first().click();

      // 平板下属性面板是右抽屉，先唤出来
      if (!(await page.getByTestId("asset-properties").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      const properties = page.getByTestId("asset-properties");
      await expect(properties).toBeVisible();
      await expect(properties).toContainText("Map001.png");
      await expect(properties).toContainText("Assets/images/Map001.png");
      await expect(properties).toContainText("PNG 图片");
      // 尺寸是从图片本身读出来的，不是编的
      await expect(properties).toContainText("1 × 1");
      await expect(page.getByTestId("asset-preview-image")).toBeVisible();

      // 换一个目录选视频：属性跟着换，并给出视频预览
      await page.getByTestId("folder-tree-row").filter({ hasText: "video" }).first().click();
      await contentRows.filter({ hasText: "Map002" }).first().click();

      await expect(properties).toContainText("Map002.mp4");
      await expect(properties).toContainText("Assets/video/Map002.mp4");
      await expect(properties).toContainText("MP4 视频");
      await expect(page.getByTestId("asset-preview-video")).toHaveCount(1);
    } finally {
      await dropProject(request, project);
    }
  });
});
