import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 跑团工程：新建 / 打开 / 项目资源面板（Assets）。
 *
 * 每个用例自建数据并自清理，互不依赖。
 */

async function newCampaign(request: APIRequestContext): Promise<string> {
  const name = `E2E工程${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const response = await request.post("/api/campaigns", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return name;
}

async function dropCampaign(request: APIRequestContext, name: string): Promise<void> {
  await request.delete(`/api/campaigns?name=${encodeURIComponent(name)}`);
}

/** 平板档位下左栏是抽屉、默认收起，先展开再切页签。 */
async function openLeftTab(page: Page, tab: "assets" | "scenes" | "hierarchy"): Promise<void> {
  const testId = `tab-${tab}`;
  if (!(await page.getByTestId(testId).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "项目", exact: true }).click();
  }

  await page.getByTestId(testId).click();
}

async function openCampaign(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "工程", exact: true }).click();
  await page.getByRole("menuitem", { name: "打开项目…" }).click();
  await page.getByTestId("campaign-row").filter({ hasText: name }).first().click();
}

test.describe("跑团工程", () => {
  test("新建项目后自动打开，资源面板显示工程文件与标准目录", async ({ page, request }) => {
    const name = `E2E新建${Date.now().toString(36)}`;
    try {
      await page.goto("/");
      await openLeftTab(page, "assets");

      // 未打开工程时给出明确指引，而不是空白面板
      await expect(page.getByText("还没有打开跑团")).toBeVisible();

      await page.getByRole("button", { name: "工程", exact: true }).click();
      await page.getByRole("menuitem", { name: "新建项目…" }).click();
      await page.getByTestId("project-name-input").fill(name);
      await page.getByTestId("confirm-create-project").click();

      await openLeftTab(page, "assets");
      await expect(page.getByText(`项目资源 · ${name}`)).toBeVisible();

      const rows = page.getByTestId("asset-row");
      await expect(rows.filter({ hasText: `${name}.dtproj.json` })).toHaveCount(1);
      for (const folder of ["maps", "images", "items"]) {
        await expect(rows.filter({ hasText: folder }).first()).toBeVisible();
      }
    } finally {
      await dropCampaign(request, name);
    }
  });

  test("新建文件夹出现在资源树里，并可删除", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    const folder = "第一章";
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    try {
      await openCampaign(page, campaign);
      await openLeftTab(page, "assets");
      await expect(page.getByText(`项目资源 · ${campaign}`)).toBeVisible();

      // 选中 maps 目录并新建子目录
      await page.getByTestId("asset-row").filter({ hasText: "maps" }).first().click();
      await page.getByRole("button", { name: "新建文件夹" }).click();
      await page.getByTestId("new-folder-input").fill(folder);
      await page.getByTestId("confirm-new-folder").click();

      const folderRow = page.getByTestId("asset-row").filter({ hasText: folder }).first();
      await expect(folderRow).toBeVisible();
      await expect(folderRow).toHaveAttribute("data-path", `maps/${folder}`);

      await page.getByLabel(`删除 ${folder}`).click();
      await expect(page.getByTestId("asset-row").filter({ hasText: folder })).toHaveCount(0);
    } finally {
      await dropCampaign(request, campaign);
    }
  });

  test("打开项目对话框列出已有跑团", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "工程", exact: true }).click();
      await page.getByRole("menuitem", { name: "打开项目…" }).click();

      await expect(
        page.getByTestId("campaign-row").filter({ hasText: campaign }).first(),
      ).toBeVisible();
    } finally {
      await dropCampaign(request, campaign);
    }
  });
});
