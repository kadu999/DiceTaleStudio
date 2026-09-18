import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  dropProject,
  enterEditor,
  expectPersistedObjectNames,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openProject,
  readSceneObjects,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";

/**
 * 场景对象的创建与编辑。
 *
 * 创建只有一条路：**「新建对象」弹框**（画布标题栏的按钮 / `Ctrl+Shift+N` / 编辑菜单），
 * 对象生成在场景正中，之后在画布上拖动定位。
 *
 * 默认视口是 scale 1 且**世界原点在画布正中**（`createCenteredViewport`），
 * 所以「世界坐标 → 画布上的点」只有一步：`screen = 画布中心 + (x, -y)`。
 */

const SCENE_A = "Map001";
const SCENE_B = "Map002";

async function openSceneForEdit(
  page: Page,
  request: APIRequestContext,
  project: string,
  scenes: readonly Record<string, unknown>[],
): Promise<void> {
  await seedProjectDoc(request, project, scenes);
  await enterEditor(page);
  await openProject(page, project);
  await openLeftTab(page, "hierarchy");
}

/**
 * 世界坐标 → 画布上的屏幕点（见文件头的默认视口说明：世界原点在画布正中）。
 *
 * 算出来的点还要**夹进真正点得到的区域**：
 * - 平板下左边 `DRAWER_WIDTH` 像素是抽屉，即使画布铺满整宽，点在那里也会被抽屉吃掉；
 * - 世界坐标可以很大（场景是 1920×1080），直接换算会跑到画布外面去。
 *
 * 所以用例用 `clampedWorldPoint()` 拿到「实际落点 + 它对应的世界坐标」，
 * 再拿这个坐标去种对象、做断言。
 */
async function scenePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("scene-viewport").boundingBox();
  if (box === null) {
    throw new Error("拿不到画布尺寸");
  }

  const inset = 24;
  const raw = { x: box.x + box.width / 2 + x, y: box.y + box.height / 2 - y };
  return {
    x: Math.min(box.x + box.width - inset, Math.max(box.x + DRAWER_WIDTH + inset, raw.x)),
    y: Math.min(box.y + box.height - inset, Math.max(box.y + inset, raw.y)),
  };
}

/** 平板抽屉宽度：竖屏下它盖在画布左边缘上，落点必须避开。 */
const DRAWER_WIDTH = 340;

/** 世界坐标 → 实际落点，以及**落点反推回来的世界坐标**（被夹过时用后者断言）。 */
async function clampedWorldPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ point: { x: number; y: number }; world: { x: number; y: number } }> {
  const point = await scenePoint(page, x, y);
  return { point, world: await sceneWorldAt(page, point) };
}

/** 屏幕点 → 世界坐标（默认视口：世界原点在画布正中，y 向上）。 */
async function sceneWorldAt(
  page: Page,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("scene-viewport").boundingBox();
  if (box === null) {
    throw new Error("拿不到画布尺寸");
  }

  return { x: point.x - (box.x + box.width / 2), y: box.y + box.height / 2 - point.y };
}

/**
 * 数一数画布上某个**精确颜色**的像素（采样步长 2px）。
 *
 * 用途：判断某个标记点画没画。标记点是不透明实心圆，圆心附近就是精确色；
 * 网格线 / 原点十字 / 棋盘格都是别的颜色，不会误判。
 */
async function countCanvasColor(
  page: Page,
  rgb: readonly [number, number, number],
): Promise<number> {
  const [r, g, b] = rgb;
  return page.evaluate(
    ({ r, g, b }) => {
      const canvas = document.querySelector("canvas");
      const context = canvas?.getContext("2d") ?? null;
      if (canvas === null || context === null) {
        return 0;
      }

      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let y = 0; y < canvas.height; y += 2) {
        for (let x = 0; x < canvas.width; x += 2) {
          const at = (y * canvas.width + x) * 4;
          if (data[at] === r && data[at + 1] === g && data[at + 2] === b) {
            count += 1;
          }
        }
      }

      return count;
    },
    { r, g, b },
  );
}

/** 标记点颜色（`kindMarkerColor`）：普通对象蓝、地图（未知类型）灰。 */
const MARKER_BLUE: readonly [number, number, number] = [79, 156, 249];
const MARKER_GRAY: readonly [number, number, number] = [154, 164, 178];

/** 用属性面板把某个对象移到精确的世界坐标（面板在平板下是右抽屉，先唤出来）。 */
async function setObjectPositionViaInspector(
  page: Page,
  world: { x: number; y: number },
): Promise<void> {
  await selectObject(page);

  await page.getByTestId("inspector-object-x").fill(String(world.x));
  await page.getByTestId("inspector-object-y").fill(String(world.y));
  await page.getByTestId("inspector-object-y").blur();

  await expect(page.getByTestId("inspector-object-x")).toHaveValue(
    String(Math.round(world.x * 100) / 100),
  );
  await expect(page.getByTestId("inspector-object-y")).toHaveValue(
    String(Math.round(world.y * 100) / 100),
  );
}

/** 用「新建对象」弹框创建一个对象（不传名字就用弹框里按类型预填的那个）。 */
async function createObject(page: Page, name?: string): Promise<void> {
  await page.getByTestId("new-object").click();
  await expect(page.getByTestId("object-dialog")).toBeVisible();

  if (name !== undefined) {
    await page.getByTestId("object-name-input").fill(name);
  }

  await page.getByTestId("confirm-object").click();
  await expect(page.getByTestId("object-dialog")).toHaveCount(0);
}

test.describe("创建与编辑场景对象", () => {
  test("弹框创建：先选种类、再选种类下的对象，精灵生成在世界原点（场景正中）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A)]);

      await page.getByTestId("new-object").click();
      await expect(page.getByTestId("object-dialog")).toBeVisible();

      // 一级：种类（实体 / 动作 / 事件），默认选中目前唯一有内容的「实体」
      await expect(page.getByTestId("object-category-entity")).toHaveAttribute(
        "data-selected",
        "true",
      );
      await expect(page.getByTestId("object-category-action")).toBeVisible();
      await expect(page.getByTestId("object-category-event")).toBeVisible();

      // 二级：实体下有 网格地图 / 精灵，默认选中第一个（网格地图），名字按类型预填
      await expect(page.getByTestId("object-type-Map")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("object-type-SceneObject")).toBeVisible();
      await expect(page.getByTestId("object-name-input")).toHaveValue("网格地图");

      // 还没做出来的种类：给提示，且创建按钮不可用
      await page.getByTestId("object-category-action").click();
      await expect(page.getByTestId("object-type-list")).toContainText("还没有可创建的对象");
      await expect(page.getByTestId("confirm-object")).toBeDisabled();

      // 造精灵来验证落点：地图铺满整个场景，本来就没有「摆在哪」这回事（position 为 null）
      await page.getByTestId("object-category-entity").click();
      await page.getByTestId("object-type-SceneObject").click();
      await expect(page.getByTestId("object-name-input")).toHaveValue("精灵");
      await page.getByTestId("confirm-object").click();
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);

      await expect(page.getByTestId("object-row")).toHaveCount(1);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");

      // 生成在场景正中 = 世界原点
      await expect
        .poll(async () => (await readSceneObjects(request, project, SCENE_A))[0]?.position ?? null)
        .toEqual({ x: 0, y: 0 });

      // 再开一次：同类类型（精灵）已存在，预填名自动避开重名
      await page.getByTestId("new-object").click();
      await page.getByTestId("object-type-SceneObject").click();
      await expect(page.getByTestId("object-name-input")).toHaveValue("精灵 2");

      await page.getByTestId("object-dialog-cancel").click();
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("精灵：实体下的第二个类型，复用 SceneObject kind，名字按「精灵」预填", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A)]);

      await page.getByTestId("new-object").click();
      await expect(page.getByTestId("object-dialog")).toBeVisible();

      await page.getByTestId("object-type-SceneObject").click();
      await expect(page.getByTestId("object-type-SceneObject")).toHaveAttribute(
        "data-selected",
        "true",
      );
      await expect(page.getByTestId("object-name-input")).toHaveValue("精灵");

      await page.getByTestId("confirm-object").click();
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);

      // 落盘的是 SceneObject kind（精灵没有新造 kind，前端无需配合），且生成在场景正中
      await expect
        .poll(async () =>
          (await readSceneObjects(request, project, SCENE_A)).map((object) => ({
            name: object.name,
            kind: object.kind,
            position: object.position,
          })),
        )
        .toEqual([{ name: "精灵", kind: "SceneObject", position: { x: 0, y: 0 } }]);

      await expect(page.getByTestId("object-row")).toHaveCount(1);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute(
        "data-kind",
        "SceneObject",
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("网格地图的贴图真的画在场景里（采样画布像素验证，不是只画棋盘格）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [mapObjectDoc(project, SCENE_A)]),
      ]);
      // 纯红贴图：画布上出现 #ff0000 就说明贴图被画出来了（棋盘格与网格线都不是这个色）
      await uploadSceneImage(request, project, SCENE_A, solidPng(4, 4, [255, 0, 0]));

      await enterEditor(page);
      await openProject(page, project);

      // 全画布扫描找纯红像素：贴图按声明的 1920×1080 铺满整个可见区域，
      // 中心那点会压着网格线与原点十字，所以不针对单点断言。
      await expect
        .poll(() =>
          page.evaluate(() => {
            const canvas = document.querySelector("canvas");
            const context = canvas?.getContext("2d") ?? null;
            if (canvas === null || context === null) {
              return 0;
            }

            const whole = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let redCount = 0;
            for (let y = 0; y < canvas.height; y += 4) {
              for (let x = 0; x < canvas.width; x += 4) {
                const at = (y * canvas.width + x) * 4;
                if (whole[at] === 255 && whole[at + 1] === 0 && whole[at + 2] === 0) {
                  redCount += 1;
                }
              }
            }

            return redCount;
          }),
        )
        .toBeGreaterThan(1000);

      // 贴图读得到，就不该出现「贴图未显示」的提示
      await expect(page.getByTestId("scene-image-error")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("贴图缺失时画布给出明确提示，而不是静默只画棋盘格", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 只声明地图对象，**不**上传贴图
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [mapObjectDoc(project, SCENE_A)]),
      ]);
      await enterEditor(page);
      await openProject(page, project);

      await expect(page.getByTestId("scene-image-error")).toBeVisible();
      // 原因里要带上**找不到的那个路径**，否则只有一句「失败了」根本没法查
      await expect(page.getByTestId("scene-image-error")).toContainText("找不到资源");
      await expect(page.getByTestId("scene-image-error")).toContainText(
        `project:${project}/Assets/images/${SCENE_A}.png`,
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("属性面板显示简短的贴图路径，并能在弹框里换一张贴图", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [mapObjectDoc(project, SCENE_A)]),
      ]);
      // 当前贴图（红色）+ 备选贴图（蓝色）：两张都提交进 Assets/images/
      await uploadSceneImage(request, project, SCENE_A, solidPng(4, 4, [255, 0, 0]));
      const response = await request.put(
        `/api/resources/raw?id=${encodeURIComponent(`project:${project}/Assets/images/floor.png`)}`,
        { headers: { "content-type": "image/png" }, data: solidPng(4, 4, [0, 0, 255]) },
      );
      expect(response.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);
      await selectObject(page);

      // 1) 路径只显示项目内相对路径：project:项目/Assets/images/x.png → images/x.png
      const fields = page.locator('[data-testid="object-properties"]');
      await expect(fields).toContainText(`images/${SCENE_A}.png`);
      await expect(fields).not.toContainText(`project:${project}`);
      await expect(fields).not.toContainText("Assets/");
      // 贴图存在 → 不该有「找不到」标记
      await expect(page.getByTestId("texture-missing")).toHaveCount(0);

      // 2) 点「选择」打开弹框，列出项目里的两张图，当前那张是高亮的
      await page.getByTestId("pick-texture").click();
      const picker = page.getByTestId("image-picker-dialog");
      const items = page.getByTestId("image-picker-item");

      // 弹框内容依赖打开时顺手刷新出来的资源树，所以整块一起轮询
      await expect
        .poll(
          async () => ({
            visible: await picker.isVisible().catch(() => false),
            count: await items.count(),
          }),
          { timeout: 15_000 },
        )
        .toMatchObject({ visible: true, count: 2 });

      // 按逻辑 ID 断言选中态，不靠显示文本
      const current = page.locator(
        `[data-testid="image-picker-item"][data-asset-id="project:${project}/Assets/images/${SCENE_A}.png"]`,
      );
      await expect(current).toHaveAttribute("data-selected", "true");

      // 3) 选另一张并确定：地图贴图与尺寸都写回文件
      await page
        .locator(
          `[data-testid="image-picker-item"][data-asset-id="project:${project}/Assets/images/floor.png"]`,
        )
        .click();
      await page.getByTestId("image-picker-confirm").click();
      await expect(page.getByTestId("image-picker-dialog")).toHaveCount(0);

      await expect
        .poll(async () => {
          const object = (
            await readSceneObjects(request, project, SCENE_A)
          )[0] as unknown as { map?: { image?: { id: string; width: number; height: number } } };
          return object?.map?.image;
        })
        .toEqual({
          id: `project:${project}/Assets/images/floor.png`,
          width: 4,
          height: 4,
        });

      // 面板上的路径跟着变，而且**不是**一整串逻辑 ID
      await expect(fields).toContainText("images/floor.png");
      await expect(fields).not.toContainText(`project:${project}`);
    } finally {
      await dropProject(request, project);
    }
  });

  test("快捷键 Ctrl+Shift+N 也能唤出弹框", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A)]);

      await page.keyboard.press("Control+Shift+N");
      await expect(page.getByTestId("object-dialog")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);
      await expect(page.getByTestId("object-row")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("面板按种类过滤：默认全部，实体 / 动作 / 事件都在", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [
          sceneObjectDoc("木门"),
          sceneObjectDoc("机关", "Event"),
          mapObjectDoc(project, SCENE_A),
        ]),
      ]);

      // 种类按钮与弹框同一套归类：全部 + 实体 / 动作 / 事件（哪怕动作现在还没有对象）
      await expect(page.getByTestId("category-filter-all")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("category-filter-entity")).toBeVisible();
      await expect(page.getByTestId("category-filter-action")).toBeVisible();
      await expect(page.getByTestId("category-filter-event")).toBeVisible();

      // 默认「全部」：三个对象都在，而且**不分组**
      await expect(page.getByTestId("object-row")).toHaveCount(3);

      // 实体 = 精灵（kind=SceneObject）+ 网格地图（kind=Map）
      await page.getByTestId("category-filter-entity").click();
      await expect(page.getByTestId("object-row")).toHaveCount(2);
      await expect(page.getByTestId("object-row").filter({ hasText: "机关" })).toHaveCount(0);

      // 事件 = kind 为 Event 的对象
      await page.getByTestId("category-filter-event").click();
      await expect(page.getByTestId("object-row")).toHaveCount(1);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-kind", "Event");

      // 动作：现在还没有这类对象
      await page.getByTestId("category-filter-action").click();
      await expect(page.getByTestId("object-row")).toHaveCount(0);
      await expect(page.getByTestId("object-tree")).toContainText("「动作」下还没有对象");

      // 种类过滤与关键字过滤是叠加的
      await page.getByTestId("category-filter-entity").click();
      await page.getByTestId("object-filter").fill("木门");
      await expect(page.getByTestId("object-row")).toHaveCount(1);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-name", "木门");
    } finally {
      await dropProject(request, project);
    }
  });

  test("拖动画布上的标记点：位置随之改变（世界坐标 y 向上，屏幕 y 向下）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [sceneObjectDoc("木门", "SceneObject", { x: 0, y: 0 })]),
      ]);

      // 先把对象挪到「三种视口都点得到」的落点（平板竖屏左边是抽屉，
      // 而落点坐标只能在场景打开之后量），再用它的实际屏幕点开始拖动。
      const probed = await clampedWorldPoint(page, -200, 150);
      await setObjectPositionViaInspector(page, probed.world);

      const from = await scenePoint(page, probed.world.x, probed.world.y);
      const to = { x: from.x + 120, y: from.y + 60 };

      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();

      // 拖动改位置 → 自动存写回；落点就是指针处的世界坐标：
      // 屏幕向右 120px、向下 60px = 世界 x +120、**y -60**（y 向上）。
      const expected = await sceneWorldAt(page, to);
      await expect
        .poll(async () => {
          const position = (await readSceneObjects(request, project, SCENE_A))[0]?.position ?? null;
          return position === null
            ? null
            : Math.hypot(position.x - expected.x, position.y - expected.y) < 2;
        })
        .toBe(true);

      // 命中标记点也顺带选中了它
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");
    } finally {
      await dropProject(request, project);
    }
  });

  test("画布平移后「复位」：视口回到世界原点居中 + 1:1", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [sceneObjectDoc("木门", "SceneObject", { x: 0, y: 0 })]),
      ]);

      // 挪到一个「三种视口都点得到」的落点（平板竖屏左边是抽屉）
      const probed = await clampedWorldPoint(page, -200, 150);
      await setObjectPositionViaInspector(page, probed.world);

      const objectPoint = await scenePoint(page, probed.world.x, probed.world.y);

      // 关掉属性抽屉：它在平板下盖住画布右半边，而下面要从画布正中开始平移。
      // 左抽屉可能也开着（两个抽屉都有「关闭」），所以先按「属性」标题定位到右抽屉。
      const inspectorDrawer = page.locator("div").filter({ hasText: /^属性关闭$/ });
      if (await inspectorDrawer.isVisible().catch(() => false)) {
        await inspectorDrawer.getByRole("button", { name: "关闭" }).click();
        await expect(inspectorDrawer).toHaveCount(0);
      }

      const center = await scenePoint(page, 0, 0);

      // 从空白处拖动 = 平移画布：对象的世界坐标不受影响（改的是相机）。
      // 对象在世界坐标里离原点至少 150px，所以画布正中一定是空白。
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 200, center.y + 100, { steps: 5 });
      await page.mouse.up();

      // 平移只动相机，对象的世界坐标不变（落盘防抖，所以轮询）
      await expect
        .poll(async () => {
          const position = (await readSceneObjects(request, project, SCENE_A))[0]?.position ?? null;
          return position === null
            ? null
            : Math.hypot(position.x - probed.world.x, position.y - probed.world.y) < 1;
        })
        .toBe(true);

      // 复位后按原世界坐标算出的屏幕点能命中它 → 说明视口真的回到了「原点居中、1:1」
      await page.getByTestId("reset-viewport").click();
      await page.mouse.click(objectPoint.x, objectPoint.y);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");
    } finally {
      await dropProject(request, project);
    }
  });

  test("属性面板与列表不显示内部字段（ID / 组件数量），地图行仍显示网格尺寸", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [sceneObjectDoc("木门"), mapObjectDoc(project, SCENE_A)]),
      ]);

      await page.getByTestId("object-row").filter({ hasText: "木门" }).first().click();

      // 平板下属性是右抽屉，先唤出来
      if (!(await page.getByTestId("inspector-object-name").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      const fields = page.locator('[data-testid="object-properties"]');
      // 该有的：名称（可编辑）/ 类型 / 世界坐标
      await expect(fields).toContainText("名称");
      await expect(fields).toContainText("类型");
      await expect(fields).toContainText("世界坐标");
      // 不该有的：内部标记（id）与组件数量
      await expect(fields).not.toContainText("ID");
      await expect(fields).not.toContainText("组件");
      // id 的具体值也不该露出来
      await expect(fields).not.toContainText(sceneObjectDoc("木门").id as string);

      // 列表行：普通对象不再挂「0 组件」，地图那行保留网格尺寸
      const doorRow = page.getByTestId("object-row").filter({ hasText: "木门" }).first();
      await expect(doorRow).not.toContainText("组件");
      await expect(page.getByTestId("object-row").filter({ hasText: "地图" }).first()).toContainText(
        "64×36",
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("地图不参与摆放：没有坐标输入框与标记点，文件里残留的位置会被清掉", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      // 地图上带着世界坐标：早期编辑器留下的写法（贴图铺满场景，这个坐标没人读）
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [
          sceneObjectDoc("木门"),
          sceneObjectDoc("无位置的木门"),
          { ...mapObjectDoc(project, SCENE_A), position: { x: 0, y: 0 } },
        ]),
      ]);
      // 贴图要在打开项目**之前**提交：编辑器不会盯着素材目录变化
      await uploadSceneImage(request, project, SCENE_A, solidPng(4, 4, [255, 0, 0]));

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 兜底断言：地图的贴图确实画着（别把「地图没画」当成「没有标记点」）
      await expect(page.getByTestId("scene-image-error")).toHaveCount(0);
      await expect.poll(() => countCanvasColor(page, [255, 0, 0])).toBeGreaterThan(1000);

      // 打开时就修好并回写：磁盘上不再留着那个假坐标
      await expect
        .poll(async () => {
          const map = (await readSceneObjects(request, project, SCENE_A)).find(
            (object) => object.kind === "Map",
          );
          // 别用 `??`：这里的期望值就是 null，null 会被它吞掉
          return map === undefined ? "没有地图对象" : map.position;
        })
        .toBeNull();

      // 普通对象挪到三种视口都点得到的落点：它的标记点就是「扫描确实能找到标记点」的对照
      const probed = await clampedWorldPoint(page, -200, 150);
      await setObjectPositionViaInspector(page, probed.world);

      await expect.poll(() => countCanvasColor(page, MARKER_BLUE)).toBeGreaterThan(5);
      // 地图没有标记点（灰色那枚），哪怕文件里残留过坐标
      await expect.poll(() => countCanvasColor(page, MARKER_GRAY)).toBe(0);

      // 属性面板：地图没有世界坐标输入框，只说明它铺满整个场景
      await openLeftTab(page, "hierarchy");
      await page.getByTestId("object-row").filter({ hasText: "地图" }).first().click();
      if (!(await page.getByTestId("inspector-object-name").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      await expect(page.getByTestId("object-properties")).toContainText("铺满整个场景");
      await expect(page.getByTestId("inspector-object-x")).toHaveCount(0);
      await expect(page.getByTestId("inspector-object-y")).toHaveCount(0);

      // 列表里：地图不标「未放置」（它本来就没有位置），没位置的普通对象照旧要标
      await expect(
        page.getByTestId("object-row").filter({ hasText: "地图" }).first(),
      ).not.toContainText("未放置");
      await expect(
        page.getByTestId("object-row").filter({ hasText: "无位置的木门" }).first(),
      ).toContainText("未放置");
    } finally {
      await dropProject(request, project);
    }
  });

  test("列表里双击改名", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A, [sceneObjectDoc("木门")])]);

      await page.getByTestId("object-row").first().locator("button").first().dblclick();
      await page.getByTestId("object-rename-input").fill("大门");
      await page.keyboard.press("Enter");

      await expect(page.getByTestId("object-row").filter({ hasText: "大门" })).toBeVisible();
      await expectPersistedObjectNames(request, project, SCENE_A, ["大门"]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("属性面板里改名字与坐标（未放置的对象也能一键落位）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A, [sceneObjectDoc("木门")])]);
      await page.getByTestId("object-row").first().click();

      // 平板下属性是右抽屉，先唤出来
      if (!(await page.getByTestId("inspector-object-name").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      await page.getByTestId("inspector-object-name").fill("大门");
      await page.getByTestId("inspector-object-name").blur();

      // 属性面板里填的就是世界坐标（单位像素）
      await page.getByTestId("inspector-object-x").fill("-320");
      await page.getByTestId("inspector-object-y").fill("270");
      await page.getByTestId("inspector-object-y").blur();

      // 只比关心的两个字段（对象上还有 id / kind / components 等）
      await expect
        .poll(async () => {
          const object = (await readSceneObjects(request, project, SCENE_A))[0];
          return object === undefined ? null : { name: object.name, position: object.position };
        })
        .toEqual({ name: "大门", position: { x: -320, y: 270 } });
    } finally {
      await dropProject(request, project);
    }
  });

  test("多选删除后可以撤销、重做", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [sceneObjectDoc("木门"), sceneObjectDoc("酒桶")]),
      ]);

      const rows = page.getByTestId("object-row");
      await rows.filter({ hasText: "木门" }).first().click();
      await rows.filter({ hasText: "酒桶" }).first().click({ modifiers: ["Control"] });
      await expect(rows.filter({ hasText: "木门" }).first()).toHaveAttribute("data-selected", "true");
      await expect(rows.filter({ hasText: "酒桶" }).first()).toHaveAttribute("data-selected", "true");

      await page.getByTestId("delete-object").click();
      await expect(page.getByTestId("object-row")).toHaveCount(0);

      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("object-row")).toHaveCount(2);

      await page.keyboard.press("Control+Shift+z");
      await expect(page.getByTestId("object-row")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("复制对象：名字加「副本」、位置错开，并自动落盘", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A, [sceneObjectDoc("木门")])]);

      await page.getByTestId("object-row").first().click();
      await page.keyboard.press("Control+d");

      const copy = page.getByTestId("object-row").filter({ hasText: "木门 副本" });
      await expect(copy).toBeVisible();
      await expect(copy).toHaveAttribute("data-selected", "true");
      await expectPersistedObjectNames(request, project, SCENE_A, ["木门", "木门 副本"]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("改了就存：自动落盘，状态从「未保存」变「已保存」", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A)]);

      await createObject(page);

      // 防抖窗口内是「未保存」，自动存之后变「已保存」
      await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "pending");
      await expectPersistedObjectNames(request, project, SCENE_A, ["网格地图"]);
      await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "saved");
      await expect(page.getByTestId("save-scene")).toBeDisabled();
    } finally {
      await dropProject(request, project);
    }
  });

  test("手动保存：按钮立刻落盘", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A)]);

      await createObject(page);
      await expect(page.getByTestId("save-scene")).toBeEnabled();

      await page.getByTestId("save-scene").click();

      await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "saved");
      await expectPersistedObjectNames(request, project, SCENE_A, ["网格地图"]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("切场景：未保存的改动写回它所属的场景，不写当前场景", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A), sceneDoc(SCENE_B)]);
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${SCENE_A}`);

      await createObject(page);
      await expect(page.getByTestId("object-row")).toHaveCount(1);

      // 不等自动存，立刻切到另一个场景
      await page.getByTestId("scene-switcher").selectOption(SCENE_B);
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${SCENE_B}`);
      await expect(page.getByTestId("object-row")).toHaveCount(0);

      await expectPersistedObjectNames(request, project, SCENE_A, ["网格地图"]);
      expect(await readSceneObjects(request, project, SCENE_B)).toEqual([]);
    } finally {
      await dropProject(request, project);
    }
  });
});
