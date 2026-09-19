import { expect, test } from "@playwright/test";
import { enterEditor } from "./helpers/editor";

/**
 * E2E 冒烟：四区布局、平板抽屉、画布交互、运行态切换。
 *
 * 跑在**已构建**的编辑器产物上（由后端同源托管），与生产路径一致：
 * 先 `pnpm build`，再 `pnpm e2e`。
 *
 * 选择器一律用 data-testid：菜单项与模式开关可能存在同名文本，
 * 用文本选择器会命中多个元素（严格模式下直接失败）。
 *
 * 入口统一走 `enterEditor`：启动引导可能弹「新建项目 / 打开项目」对话框，
 * 不先关掉它会挡住后续点击。
 */

test.describe("编辑器外壳", () => {
  test("打开后能看到菜单栏与场景视口", async ({ page }) => {
    await enterEditor(page);

    await expect(page.getByText("DiceTaleStudio")).toBeVisible();
    await expect(page.getByTestId("scene-viewport")).toBeVisible();
    // 编辑 / 运行 模式切换必须在首屏可见
    await expect(page.getByTestId("mode-edit")).toBeVisible();
    await expect(page.getByTestId("mode-run")).toBeVisible();
  });

  test("没有项目时画布给出占位，而不是画出一个假地图", async ({ page }) => {
    await enterEditor(page);

    await expect(page.getByTestId("scene-viewport")).toBeVisible();
    await expect(page.getByTestId("scene-viewport").locator("canvas")).toBeVisible();
    // 没有项目 / 场景时不该画出一个「看起来像地图」的区域
    await expect(page.getByTestId("scene-viewport").getByText("没有打开项目")).toBeVisible();
    await expect(page.getByText("当前场景还没有地图对象")).toHaveCount(0);
  });

  test("底部状态栏显示文档与运行态信息", async ({ page }) => {
    await enterEditor(page);
    await expect(page.getByTestId("status-scenes")).toHaveText(/场景 \d+/);
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    await expect(page.getByTestId("status-selection")).toHaveText("已选 0");
  });

  test("菜单可以在触控下操作（平板无快捷键）", async ({ page }) => {
    await enterEditor(page);

    await page.getByRole("button", { name: "视图", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /隐藏场景对象|显示场景对象/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /适配视口/ })).toBeVisible();
  });
});

test.describe("画布视口交互", () => {
  test("拖拽平移与滚轮缩放不报错，画布持续可用", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await enterEditor(page);
    const viewport = page.getByTestId("scene-viewport");
    const box = await viewport.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) {
      return;
    }

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 120, centerY + 80, { steps: 8 });
    await page.mouse.up();

    await page.mouse.move(centerX, centerY);
    await page.mouse.wheel(0, -240);
    await page.mouse.wheel(0, 480);

    await expect(viewport).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("编辑态 / 运行态", () => {
  test("切到运行态后状态栏与运行面板同步更新", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await enterEditor(page);
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");

    await page.getByTestId("mode-run").click();
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

    // 宽屏下运行面板嵌在场景下方；平板下是抽屉——两种布局都应有「运行态」标题
    await expect(page.getByText("运行态").first()).toBeVisible();

    // 运行态下顶上要有「前端连上了没」的徽标；e2e 里没有前端，所以是「等待前端连接」
    await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "no");

    await page.getByTestId("mode-edit").click();
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    await expect(page.getByTestId("client-badge")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("平板下场景默认铺满，左右面板收进抽屉（由菜单或工具条唤出）", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("tablet"), "只在平板档位验证紧凑布局");

    await enterEditor(page);

    const viewport = page.getByTestId("scene-viewport");
    const box = await viewport.boundingBox();
    expect(box).not.toBeNull();

    // 视口应当占据接近整屏宽度（触控/窄屏下默认不并排三栏）
    const viewportWidth = page.viewportSize()?.width ?? 0;
    if (box !== null && viewportWidth > 0) {
      expect(box.width).toBeGreaterThan(viewportWidth * 0.8);
    }
  });
});
