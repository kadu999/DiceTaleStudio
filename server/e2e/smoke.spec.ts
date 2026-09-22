import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";
import {
  COMPONENT,
  closeDrawers,
  dropProject,
  enterEditor,
  newProject,
  openFirstObject,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  withComponent,
} from "./helpers/editor";

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
    // 运行态是**服务端状态**，所以这里只断言状态栏在说人话（编辑状态 / 运行中），
    // 不断言「一定是编辑」——并行的用例可能正开着运行态
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", /^(edit|run)$/);
    await expect(page.getByTestId("status-mode")).toContainText(/编辑状态|运行中/);
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

/** 运行态用例的场景与对象名（只有这个 describe 用得到）。 */
const RUN_SCENE = "Map001";
const RUN_OBJECT = "木门";
/** 运行态用例里「换台」的第二个场景（名字排在 Map001 之后，切换条上的下一格就是它）。 */
const OTHER_SCENE = "Map002";

/**
 * 场景文件里那个对象**落盘**的样子（`active` / `position`）。
 *
 * 直接读文件、不经过编辑器：这是「运行中的改动有没有写进文件」唯一的硬证据。
 */
async function persistedObject(
  request: APIRequestContext,
  project: string,
): Promise<{ active?: boolean; position?: { x: number; y: number } | null } | undefined> {
  const id = `project:${project}/Assets/scenes/${RUN_SCENE}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  expect(response.ok()).toBeTruthy();

  const raw = (await response.json()) as {
    objects?: Array<{ name?: string; active?: boolean; position?: { x: number; y: number } | null }>;
  };
  return raw.objects?.find((object) => object.name === RUN_OBJECT);
}

/**
 * 运行态用例**只在一个档位上跑**。
 *
 * 运行态是服务端**全局单例**：三个档位（桌面 + 两个平板）是并行 worker，同一份用例会同时开三份，
 * 互相开关运行态、也会互相把对面刚连上的前端踢下线——断言就成了「偶尔失败」。
 * 桌面档位足够量这套语义（`serial` 只管得住同一档位内部，档位之间靠这个函数）。
 */
function skipOutsideDesktop(testInfo: TestInfo): void {
  test.skip(
    !testInfo.project.name.startsWith("desktop"),
    "运行态是全局状态：只在一个档位跑，免得并行档位互相开关",
  );
}

test.describe("平板紧凑布局", () => {
  test("平板下场景默认铺满，左右面板收进抽屉（由菜单或工具条唤出）", async ({
    page,
  }, testInfo) => {
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

/*
  `@runtime` 标记：这一组开关的是**服务端全局单例**，所以 `pnpm e2e` 分两趟跑——
  第一趟并行跑其它用例并把这组排除在外（`--grep-invert @runtime`），
  第二趟把这组单独跑、只用一个 worker（`--grep @runtime --workers=1`）。

  为什么非得这样：运行态开着的时候，**任何一个刚打开的编辑器都会跟着进入运行态**，
  于是「运行中的改动不保存」对那个编辑器也生效（它的落盘断言会超时），
  而别人关闸时它还会被还原掉——两条都是这个功能的正确行为，但对并行的邻居是破坏性的。
  多个档位同时跑同一份运行态用例同样会互相开关（`serial` 只管得住同一档位内部）。
*/
test.describe("编辑态 / 运行态", { tag: "@runtime" }, () => {
  /*
    运行态是**服务端状态**（全局一份）：它是全局单例，所以这一组用例
    ① 在档位内串行跑（`serial`），② 只在一个档位上跑（`skipOutsideDesktop`），
    ③ 整组被 `@runtime` 隔离出来单独跑（见上）。
    其它文件不碰运行态（编辑器重启后的恢复由 backend 单测 runtime-hub 钉）。
  */
  test.describe.configure({ mode: "serial" });

  test("编辑 / 运行是服务端状态：切过去、切回来，状态栏与运行面板同步", async ({
    page,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await enterEditor(page);

    // 先确保处于编辑态（运行态是服务端状态，别的并行用例可能正开着）
    await page.getByTestId("mode-edit").click();
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

  test("刷新页面不退出运行态（运行态记在服务端）", async ({ page }, testInfo) => {
    skipOutsideDesktop(testInfo);

    await enterEditor(page);

    await page.getByTestId("mode-run").click();
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

    // 刷新：编辑器这只 WS 断了，但服务端还记着在运行
    await page.reload();
    await enterEditor(page);

    // 界面自动回到运行态（不是「刷新就退出运行」），徽标还在
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");
    await expect(page.getByTestId("client-badge")).toBeVisible();

    // 收尾：点「编辑」才真的关闸
    await page.getByTestId("mode-edit").click();
    await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    await expect(page.getByTestId("client-badge")).toHaveCount(0);
  });

  /*
    运行中的改动**不保存、退出即还原**（对齐 Unity 的播放模式）。

    用「木门」这种小对象来量：运行中把它**隐藏 + 挪到 x=500**，读文件确认一个字节没写；
    点「编辑」退出运行后，界面与文件都必须回到进入运行前的样子（显示、世界原点）。
  */
  test("运行中的改动不落盘：退出运行后隐藏与位置都还原", async ({ page, request }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(RUN_SCENE, [sceneObjectDoc(RUN_OBJECT, "Sprite", { x: 0, y: 0 })]),
      ]);
      await openFirstObject(page, project, RUN_OBJECT);

      // 基线：显示着、在世界原点
      await expect(page.getByTestId("inspector-object-active")).toBeChecked();
      await expect(page.getByTestId("inspector-object-x")).toHaveValue("0");

      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

      // 运行中：隐藏 + 挪走（界面上确实生效——运行中的改动只是不保存，不是不能改）
      await page.getByTestId("inspector-object-active").uncheck();
      await page.getByTestId("inspector-object-x").fill("500");
      await page.getByTestId("inspector-object-x").press("Enter");

      await expect(page.getByTestId("inspector-object-active")).not.toBeChecked();
      await expect(page.getByTestId("inspector-object-x")).toHaveValue("500");

      // 场景文件**一点没动**：运行中改的是临时状态
      expect(await persistedObject(request, project)).toMatchObject({
        active: true,
        position: { x: 0, y: 0 },
      });

      // 退出运行 = 停止播放：隐藏和位置原样还回来
      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
      await expect(page.getByTestId("inspector-object-active")).toBeChecked();
      await expect(page.getByTestId("inspector-object-x")).toHaveValue("0");
      expect(await persistedObject(request, project)).toMatchObject({
        active: true,
        position: { x: 0, y: 0 },
      });
    } finally {
      await dropProject(request, project);
    }
  });

  /*
    切场景 = DM 的「换台」：运行中切换必须**立刻**推给前端。

    这里没有前端，所以看编辑器自己那行「镜像场景：X」——它来自服务端收到 `scene_push`
    之后广播回来的 `editor_state`，所以能断言「推到了、而且推的是新场景」。
    少了这一推，投影上还是上一张图，DM 还得跑去面板点「重新同步」。
  */
  test("运行中切场景：镜像场景立刻跟着换（不用手动重新同步）", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc(RUN_SCENE), sceneDoc(OTHER_SCENE)]);

      await enterEditor(page);
      await openProject(page, project);
      await closeDrawers(page);

      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");
      await expect(page.getByTestId("runtime-mirror-scene")).toHaveText(RUN_SCENE);

      // 切换条上点一下：镜像立刻换成第二个场景
      await page.getByTestId("scene-chip").filter({ hasText: OTHER_SCENE }).click();

      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${OTHER_SCENE}`);
      await expect(page.getByTestId("runtime-mirror-scene")).toHaveText(OTHER_SCENE);

      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    } finally {
      await dropProject(request, project);
    }
  });

  /*
    传送阵 = 「按一下换台」：它**没有自己的命令**，触发它就是编辑器切换当前场景 →
    走 `scene_push`（全量、立刻推）。这条用例把这句话钉住：运行中点「传送」，
    服务端收到的镜像场景必须立刻变成目标场景。
  */
  test("运行中点传送阵：镜像场景立刻跟着换（它没有自己的命令）", async ({ page, request }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(RUN_SCENE, [
          withComponent(
            sceneObjectDoc("传送阵", "Teleport", { x: 0, y: 0 }, { id: "teleport_01" }),
            COMPONENT.teleport,
            { targets: [OTHER_SCENE], picked: OTHER_SCENE },
          ),
        ]),
        sceneDoc(OTHER_SCENE),
      ]);

      await openFirstObject(page, project, "传送阵");
      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");
      await expect(page.getByTestId("runtime-mirror-scene")).toHaveText(RUN_SCENE);

      // 按一下传送：场景切过去，并且**立刻**推给前端（镜像场景那行跟着变）
      await page.getByTestId("teleport-go").click();
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${OTHER_SCENE}`);
      await expect(page.getByTestId("runtime-mirror-scene")).toHaveText(OTHER_SCENE);

      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    } finally {
      await dropProject(request, project);
    }
  });
});
