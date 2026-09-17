import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 场景列表：新建 / 切换 / 删除，以及「改了就存」。
 *
 * 每个用例**自建跑团并自清理**，不依赖其它用例的副作用
 * （否则单独跑某一条就会因为缺少前置数据而失败）。
 */

const SCENE_A = "Map001";
const SCENE_B = "酒馆";

async function newCampaign(request: APIRequestContext): Promise<string> {
  const name = `E2E场景${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const response = await request.post("/api/campaigns", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return name;
}

async function dropCampaign(request: APIRequestContext, name: string): Promise<void> {
  await request.delete(`/api/campaigns?name=${encodeURIComponent(name)}`);
}

/** 左栏在平板档位下是抽屉、默认收起，先展开再切页签。 */
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

/** 在场景页签里新建一个场景。 */
async function createScene(page: Page, name: string): Promise<void> {
  await openLeftTab(page, "scenes");
  await page.getByTestId("new-scene").click();
  await page.getByTestId("scene-name-input").fill(name);
  await page.getByTestId("confirm-scene").click();
}

/** 轮询工程文件，等自动保存落盘（不依赖固定 sleep）。 */
async function expectPersistedScenes(
  request: APIRequestContext,
  campaign: string,
  expected: readonly string[],
): Promise<void> {
  const id = `campaign:${campaign}/${campaign}.dtproj.json`;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
        if (!response.ok()) {
          return [];
        }

        const doc = JSON.parse(await response.text()) as { scenes?: Array<{ name: string }> };
        return (doc.scenes ?? []).map((scene) => scene.name);
      },
      { timeout: 8000, message: "等待工程文件落盘" },
    )
    .toEqual(expected);
}

test.describe("场景列表", () => {
  test("新建场景后出现在列表并成为当前场景", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    try {
      await openCampaign(page, campaign);
      await openLeftTab(page, "scenes");

      await expect(page.getByText("这个跑团还没有场景")).toBeVisible();

      await createScene(page, SCENE_A);

      const row = page.getByTestId("scene-row").filter({ hasText: SCENE_A }).first();
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-active", "true");
      await expect(page.getByText(`当前：${SCENE_A}`)).toBeVisible();

      // 新场景是空场景：没有对象、也没有地图
      await expect(row).toContainText("0 对象");
      await expectPersistedScenes(request, campaign, [SCENE_A]);
    } finally {
      await dropCampaign(request, campaign);
    }
  });

  test("多个场景之间可切换", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    try {
      await openCampaign(page, campaign);
      await createScene(page, SCENE_A);
      await createScene(page, SCENE_B);

      const rowA = page.getByTestId("scene-row").filter({ hasText: SCENE_A }).first();
      const rowB = page.getByTestId("scene-row").filter({ hasText: SCENE_B }).first();

      await expect(rowB).toHaveAttribute("data-active", "true");

      await rowA.click();
      await expect(rowA).toHaveAttribute("data-active", "true");
      await expect(rowB).toHaveAttribute("data-active", "false");
      await expect(page.getByText(`当前：${SCENE_A}`)).toBeVisible();
    } finally {
      await dropCampaign(request, campaign);
    }
  });

  test("切回页面重开跑团后场景仍在（改了就存）", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    try {
      await openCampaign(page, campaign);
      await createScene(page, SCENE_A);
      await createScene(page, SCENE_B);
      await expectPersistedScenes(request, campaign, [SCENE_A, SCENE_B]);

      await page.reload();
      // 刷新后不自动恢复工程：文档回到空项目（状态栏常驻，平板档位下也可见）
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 0");

      await openCampaign(page, campaign);
      await openLeftTab(page, "scenes");

      await expect(page.getByTestId("scene-row").filter({ hasText: SCENE_A }).first()).toBeVisible();
      await expect(page.getByTestId("scene-row").filter({ hasText: SCENE_B }).first()).toBeVisible();
    } finally {
      await dropCampaign(request, campaign);
    }
  });

  test("场景里没有地图也能新建对象（对象挂在场景上）", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    try {
      await openCampaign(page, campaign);
      await createScene(page, SCENE_A);
      await openLeftTab(page, "hierarchy");

      await page.getByTestId("new-object").click();
      await page.getByTestId("object-name-input").fill("木门");
      await page.getByTestId("confirm-object").click();

      await expect(page.getByTestId("object-row").filter({ hasText: "木门" })).toBeVisible();
      // 场景里没有地图对象，对象照样建出来了
      await expect(page.getByTestId("object-row").filter({ hasText: "地图" })).toHaveCount(0);
    } finally {
      await dropCampaign(request, campaign);
    }
  });

  test("地图作为对象添加进场景（不是场景本身）", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    try {
      await openCampaign(page, campaign);
      await createScene(page, SCENE_A);
      await openLeftTab(page, "hierarchy");

      await page.getByTestId("add-map").click();

      const mapRow = page.getByTestId("object-row").filter({ hasText: "地图" }).first();
      await expect(mapRow).toBeVisible();
      // 地图对象带着自己的网格尺寸
      await expect(mapRow).toContainText("64×36");
    } finally {
      await dropCampaign(request, campaign);
    }
  });

  test("删除场景后从列表消失", async ({ page, request }) => {
    const campaign = await newCampaign(request);
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    try {
      await openCampaign(page, campaign);
      await createScene(page, SCENE_A);
      await createScene(page, SCENE_B);

      await page.getByLabel(`删除场景 ${SCENE_B}`).click();
      await expect(page.getByTestId("scene-row").filter({ hasText: SCENE_B })).toHaveCount(0);
      await expect(page.getByTestId("scene-row").filter({ hasText: SCENE_A }).first()).toBeVisible();
    } finally {
      await dropCampaign(request, campaign);
    }
  });
});
