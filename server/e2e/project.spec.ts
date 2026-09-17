import { expect, test, type Page } from "@playwright/test";

/**
 * 平板档位下左栏是抽屉、默认收起，先展开再断言。
 * 桌面档位下左栏常驻，直接可见。
 */
async function openAssetsPanel(page: Page): Promise<void> {
  if (!(await page.getByTestId("tab-assets").isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "项目", exact: true }).click();
  }

  await expect(page.getByTestId("tab-assets")).toBeVisible();
}

/**
 * 跑团工程：新建 / 打开 / 项目资源面板（Assets）。
 *
 * 一个跑团 = 一个文件夹 + 一个工程文件；用例直接跑真实后端，
 * 因此用带时间戳的名字并在最后清理。
 */

const NAME = `E2E跑团${Date.now().toString(36)}`;
const FOLDER = "第一章";

test.describe("跑团工程", () => {
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/campaigns?name=${encodeURIComponent(NAME)}`);
  });

  test("新建项目后自动打开，资源面板显示工程文件与标准目录", async ({ page }) => {
    await page.goto("/");
    await openAssetsPanel(page);

    // 未打开工程时给出明确指引，而不是空白面板
    await expect(page.getByText("还没有打开跑团")).toBeVisible();

    await page.getByRole("button", { name: "工程", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建项目…" }).click();
    await page.getByTestId("project-name-input").fill(NAME);
    await page.getByTestId("confirm-create-project").click();

    await openAssetsPanel(page);
    await expect(page.getByText(`项目资源 · ${NAME}`)).toBeVisible();

    const rows = page.getByTestId("asset-row");
    await expect(rows.filter({ hasText: `${NAME}.dtproj.json` })).toHaveCount(1);
    for (const folder of ["maps", "images", "items"]) {
      await expect(rows.filter({ hasText: folder }).first()).toBeVisible();
    }

    // 工程文件本身也是合法的项目文档：状态栏应显示为默认项目名之外的内容
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
  });

  test("新建文件夹出现在资源树里，并可删除", async ({ page }) => {
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工程", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开项目…" }).click();
    await page.getByTestId("campaign-row").filter({ hasText: NAME }).first().click();

    await openAssetsPanel(page);
    await expect(page.getByText(`项目资源 · ${NAME}`)).toBeVisible();

    // 选中 maps 目录并新建子目录
    const mapsRow = page.getByTestId("asset-row").filter({ hasText: "maps" }).first();
    await mapsRow.click();
    await page.getByRole("button", { name: "新建文件夹" }).click();
    await page.getByTestId("new-folder-input").fill(FOLDER);
    await page.getByTestId("confirm-new-folder").click();

    const folderRow = page.getByTestId("asset-row").filter({ hasText: FOLDER }).first();
    await expect(folderRow).toBeVisible();
    await expect(folderRow).toHaveAttribute("data-path", `maps/${FOLDER}`);

    // 删除它（confirm 已在上面自动接受）
    await page.getByLabel(`删除 ${FOLDER}`).click();
    await expect(page.getByTestId("asset-row").filter({ hasText: FOLDER })).toHaveCount(0);
  });

  test("打开项目对话框列出已有跑团", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "工程", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开项目…" }).click();

    await expect(page.getByTestId("campaign-row").filter({ hasText: NAME }).first()).toBeVisible();
  });
});
