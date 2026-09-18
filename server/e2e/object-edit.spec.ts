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
 * 画布（canvas）在屏幕上的外框。
 *
 * **必须用 canvas 而不是 `scene-viewport` 容器**：默认视口把世界原点摆在**画布正中**，
 * 而画布是定宽撑满的——容器比它窄时（平板竖屏左边压着抽屉），两个「中心」能差出上百像素，
 * 按容器中心算出来的世界坐标会整体偏掉，点哪儿都不中。
 */
async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator("canvas").boundingBox();
  if (box === null) {
    throw new Error("拿不到画布尺寸");
  }

  return box;
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
  const box = await canvasBox(page);

  const inset = 24;
  const raw = { x: box.x + box.width / 2 + x, y: box.y + box.height / 2 - y };
  return {
    x: Math.min(box.x + box.width - inset, Math.max(box.x + DRAWER_WIDTH + inset, raw.x)),
    y: Math.min(box.y + box.height - inset, Math.max(box.y + inset, raw.y)),
  };
}

/** 平板抽屉宽度：竖屏下它盖在画布左边缘上，落点必须避开。 */
const DRAWER_WIDTH = 340;

/**
 * 找一个**真正点得到**的空白屏幕点：屏幕坐标在「抽屉右边 / 画布里面」，
 * 而且正下方就是画布（不是别的面板）。
 *
 * 世界原点在画布正中，而画布可能比窗口宽——所以「画布左侧」未必露得出来。
 * 这里不猜，直接按候选世界坐标换算出屏幕点再验证。
 */
async function findEmptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);

  // 世界坐标上下左右都撒一点：平板竖屏左边是抽屉、横屏右边可能是属性抽屉，
  // 「哪一侧露得出来」随档位变，所以不猜方向，扫一遍。
  for (let y = 360; y >= -360; y -= 120) {
    for (let x = 320; x >= -320; x -= 80) {
      const point = await worldSamplePoint(page, { x, y });
      if (point.x < box.x + DRAWER_WIDTH + 24 || point.y < box.y + 24) {
        continue;
      }

      const overCanvas = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
        point,
      );
      if (overCanvas) {
        return point;
      }
    }
  }

  throw new Error("找不到可点击的空白处");
}

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
  const box = await canvasBox(page);
  return { x: point.x - (box.x + box.width / 2), y: box.y + box.height / 2 - point.y };
}

/**
 * 世界坐标 → 画布上的屏幕点，**不**夹取（只用来采样像素 / 精确点击）。
 *
 * 采样要看地图真实画在哪，不能像点击那样被夹进「点得到的区域」。
 */
async function worldSamplePoint(
  page: Page,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);
  return { x: box.x + box.width / 2 + world.x, y: box.y + box.height / 2 - world.y };
}

/**
 * 取画布上某个屏幕点周围 `radius` 像素的**平均颜色**（按 DPR 换算到后备缓冲像素）。
 *
 * 取平均而不是单点：网格线 / 原点十字随时可能正好压在被采样的那个像素上，
 * 单点会读到它们的颜色。一片纯色贴图的平均值仍然明显偏它自己的颜色。
 */
async function canvasAverageColor(
  page: Page,
  point: { x: number; y: number },
  radius = 4,
): Promise<{ r: number; g: number; b: number }> {
  return page.evaluate(
    ({ x, y, radius }) => {
      const canvas = document.querySelector("canvas");
      const context = canvas?.getContext("2d") ?? null;
      if (canvas === null || context === null) {
        return { r: -1, g: -1, b: -1 };
      }

      const rect = canvas.getBoundingClientRect();
      const ratio = canvas.width / Math.max(1, rect.width);
      const size = Math.max(1, Math.round(radius * ratio));
      const px = Math.round((x - rect.left) * ratio) - Math.floor(size / 2);
      const py = Math.round((y - rect.top) * ratio) - Math.floor(size / 2);
      const data = context.getImageData(px, py, size, size).data;

      let r = 0;
      let g = 0;
      let b = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
      }

      return { r: r / pixels, g: g / pixels, b: b / pixels };
    },
    { x: point.x, y: point.y, radius },
  );
}


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

  test("拖动画布上的对象：位置随之改变（世界坐标 y 向上，屏幕 y 向下）", async ({
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

      // 拖动整块矩形（不是中心那个点）：点哪儿都能拿起来
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");
    } finally {
      await dropProject(request, project);
    }
  });

  test("画布拾取：按对象整块矩形命中；重叠时选 sortingOrder 大的", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 两个 120×120 的纯色矩形，中心都在世界原点：谁盖住谁、点谁，只看 sortingOrder
      const smallId = `project:${project}/Assets/images/small.png`;
      const bigId = `project:${project}/Assets/images/big.png`;
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [
          sceneObjectDoc("大红", "SceneObject", { x: 0, y: 0 }, {
            sortingOrder: 5,
            image: { id: bigId, width: 120, height: 120 },
          }),
          sceneObjectDoc("小蓝", "SceneObject", { x: 0, y: 0 }, {
            sortingOrder: 1,
            image: { id: smallId, width: 120, height: 120 },
          }),
        ]),
      ]);
      for (const [id, color] of [
        [bigId, [255, 0, 0]],
        [smallId, [0, 0, 255]],
      ] as const) {
        const uploaded = await request.put(`/api/resources/raw?id=${encodeURIComponent(id)}`, {
          headers: { "content-type": "image/png" },
          data: solidPng(120, 120, color),
        });
        expect(uploaded.ok()).toBeTruthy();
      }

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      const selectedNames = async (): Promise<string[]> =>
        page
          .locator('[data-testid="object-row"][data-selected="true"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-name") ?? ""));

      const clickWorld = async (world: { x: number; y: number }): Promise<void> => {
        const point = await worldSamplePoint(page, world);
        await page.mouse.click(point.x, point.y);
      };

      // 1) 点**离中心很远**的地方（世界 55,55，旧的「中心点 + 12px 半径」拾取根本点不到）
      //    → 命中那块 120×120 的大红（半径 85，盖得住这里）
      await clickWorld({ x: 55, y: 55 });
      await expect.poll(selectedNames).toEqual(["大红"]);

      // 2) 点两者重叠的正中 → 显示顺序大的赢（大红 5 > 小蓝 1）
      await clickWorld({ x: 0, y: 0 });
      await expect.poll(selectedNames).toEqual(["大红"]);

      // 3) 把小蓝的顺序抬到大红之上 → 同一处重叠点改成选中小蓝
      await page.getByTestId("object-row").filter({ hasText: "小蓝" }).first().click();
      if (!(await page.getByTestId("inspector-object-sorting").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }
      await page.getByTestId("inspector-object-sorting").fill("9");
      await page.getByTestId("inspector-object-sorting").blur();
      await expect
        .poll(async () => {
          const objects = await readSceneObjects(request, project, SCENE_A);
          return objects.find((object) => object.name === "小蓝")?.sortingOrder ?? null;
        })
        .toBe(9);

      await clickWorld({ x: 0, y: 0 });
      await expect.poll(selectedNames).toEqual(["小蓝"]);

      // 4) 点**谁都不在**的地方 → 取消选中（不是「点了没反应」）。
      //    不能写死世界坐标：平板竖屏左边 340px 是抽屉，点在它盖住的位置等于点在抽屉上。
      //    所以按「窗口宽度」换算候选点，挑一个**屏幕坐标确实在抽屉右边、底下又是画布**的。
      const emptyPoint = await findEmptyCanvasPoint(page);
      await page.mouse.click(emptyPoint.x, emptyPoint.y);
      await expect.poll(selectedNames).toEqual([]);

      // 5) 从空白处**拖动**是平移画布，不该顺手取消选中（选中要保持住）
      await clickWorld({ x: 0, y: 0 });
      await expect.poll(selectedNames).toEqual(["小蓝"]);

      const blank = await worldSamplePoint(page, { x: 300, y: 300 });
      await page.mouse.move(blank.x, blank.y);
      await page.mouse.down();
      await page.mouse.move(blank.x + 80, blank.y + 40, { steps: 5 });
      await page.mouse.up();
      await expect.poll(selectedNames).toEqual(["小蓝"]);

      // 6) **只有左键**拾取与拖动：中键 / 右键按下-拖动-抬起，既不该改选中，也不该挪动对象
      const center = await worldSamplePoint(page, { x: 0, y: 0 });
      const positionOf = async (name: string): Promise<unknown> =>
        (await readSceneObjects(request, project, SCENE_A)).find((object) => object.name === name)
          ?.position ?? null;
      const before = await positionOf("小蓝");

      for (const button of ["middle", "right"] as const) {
        await page.mouse.move(center.x, center.y);
        await page.mouse.down({ button });
        await page.mouse.move(center.x + 90, center.y + 60, { steps: 5 });
        await page.mouse.up({ button });

        // 右键会弹出浏览器上下文菜单，按 Esc 收掉，免得挡住后面的操作
        if (button === "right") {
          await page.keyboard.press("Escape");
        }

        await expect.poll(selectedNames).toEqual(["小蓝"]);
        expect(await positionOf("小蓝")).toEqual(before);
      }
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

      // 从**没有对象的地方**开始拖 = 平移画布：对象的世界坐标不受影响（改的是相机）。
      // 世界原点现在**不能**当空白点了——地图整块矩形在那儿，点下去会变成拖地图
      // （矩形拾取之后的行为，正是「点哪儿选哪儿」）。所以用探针量一个真的空位。
      const empty = await clampedWorldPoint(page, 0, -520);

      await page.mouse.move(empty.point.x, empty.point.y);
      await page.mouse.down();
      await page.mouse.move(empty.point.x + 200, empty.point.y + 100, { steps: 5 });
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

  test("世界坐标：X / Y 轴标看得见，两个输入框等分并吃满整行宽度", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [sceneObjectDoc("木门", "SceneObject", { x: -320, y: 270 })]),
      ]);
      await selectObject(page);

      // 轴标（X / Y）看得见，而且就是各自输入框的无障碍名字
      await expect(page.getByLabel("世界坐标 X")).toHaveValue("-320");
      await expect(page.getByLabel("世界坐标 Y")).toHaveValue("270");
      // 单位挂在行标签上，不再占输入框的宽度；标签也不能被挤到换行
      // （平板抽屉只有 340px）——输入框 → label → 容器 → 行，行里第一个 span 就是行标签
      const rowLabel = page.getByTestId("inspector-object-x").locator("xpath=../../../span[1]");
      await expect(rowLabel).toHaveText("世界坐标 (px)");
      expect((await rowLabel.boundingBox())?.height ?? 0).toBeLessThan(24);

      // 不再是固定 64px；两轴等宽；合起来吃掉这一行的大部分宽度
      const xBox = await page.getByTestId("inspector-object-x").boundingBox();
      const yBox = await page.getByTestId("inspector-object-y").boundingBox();
      // 输入框外面那层（两个轴共用的容器）：输入框 → label → 容器
      const rowBox = await page.getByTestId("inspector-object-x").locator("xpath=../..").boundingBox();

      const xWidth = xBox?.width ?? 0;
      const yWidth = yBox?.width ?? 0;
      const rowWidth = rowBox?.width ?? 0;

      expect(xWidth).toBeGreaterThan(80);
      expect(Math.abs(xWidth - yWidth)).toBeLessThan(2);
      expect((xWidth + yWidth) / rowWidth).toBeGreaterThan(0.8);
    } finally {
      await dropProject(request, project);
    }
  });

  test("网格列数 / 行数可以改：格子按新规格重建，每格尺寸是算出来的", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [mapObjectDoc(project, SCENE_A)]),
      ]);

      // 地图那一行（列表里它是唯一带网格尺寸的）
      await page.getByTestId("object-row").filter({ hasText: "地图" }).first().click();
      if (!(await page.getByTestId("inspector-object-name").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      // 1920×1080 分 64×36：每格 30×30（**算出来的**，文档里不存这个数）
      await expect(page.getByLabel("网格列数")).toHaveValue("64");
      await expect(page.getByLabel("网格行数")).toHaveValue("36");
      await expect(page.getByTestId("object-properties")).toContainText("30 × 30 px");

      // 列数 64 → 32：每格变成 60×30
      await page.getByLabel("网格列数").fill("32");
      await page.getByLabel("网格列数").blur();
      await expect(page.getByTestId("object-properties")).toContainText("60 × 30 px");

      // 落盘：网格是新规格，格子数据按新格数重建（校验要求展开格数 = 列 × 行）
      await expect
        .poll(async () => {
          const file = await request.get(
            `/api/resources/text?id=${encodeURIComponent(
              `project:${project}/Assets/scenes/${SCENE_A}.json`,
            )}`,
          );
          const raw = (await file.json()) as {
            objects?: Array<{ map?: { grid: unknown; cells: { runs: Array<[number, number]> } } }>;
          };
          return raw.objects?.[0]?.map?.grid ?? null;
        })
        .toEqual({ width: 32, height: 36 });

      // 0 / 负数被挡回原值（网格至少 1 格），不会写进文件
      await page.getByLabel("网格列数").fill("0");
      await page.getByLabel("网格列数").blur();
      await expect(page.getByLabel("网格列数")).toHaveValue("32");
    } finally {
      await dropProject(request, project);
    }
  });

  test("精灵显示图片：选一张图后画在它自己的位置上（和地图贴图同一套规矩）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [sceneObjectDoc("精灵", "SceneObject", { x: 0, y: 0 })]),
      ]);
      // 200×150 的纯绿图：声明尺寸就是它在世界里的尺寸（1 图片像素 = 1 世界像素）
      const imageId = `project:${project}/Assets/images/sprite.png`;
      const uploaded = await request.put(
        `/api/resources/raw?id=${encodeURIComponent(imageId)}`,
        {
          headers: { "content-type": "image/png" },
          data: solidPng(200, 150, [0, 255, 0]),
        },
      );
      expect(uploaded.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      await selectObject(page);

      // 刚建出来的精灵没有图片：属性面板写明白，并给同一个「选择」入口
      await expect(page.getByTestId("object-properties")).toContainText("（无贴图）");
      const inside = { x: 40, y: 40 };
      await expect
        .poll(async () => (await canvasAverageColor(page, await worldSamplePoint(page, inside))).g)
        .toBeLessThan(200);

      // 选一张图
      await page.getByTestId("pick-texture").click();
      await expect(page.getByTestId("image-picker-dialog")).toBeVisible();
      await page.locator(`[data-testid="image-picker-item"][data-asset-id="${imageId}"]`).click();
      await page.getByTestId("image-picker-confirm").click();
      await expect(page.getByTestId("image-picker-dialog")).toHaveCount(0);

      // 属性面板显示简化路径；精灵中心在 (0,0)，所以 (40,40) 落在它的图里 → 绿了
      await expect(page.getByTestId("object-properties")).toContainText("images/sprite.png");
      await expect
        .poll(async () => (await canvasAverageColor(page, await worldSamplePoint(page, inside))).g)
        .toBeGreaterThan(200);

      // 落盘：图片挂在对象自己的 image 上（不是 map.image），宽高就是素材本身
      await expect
        .poll(async () => {
          const file = await request.get(
            `/api/resources/text?id=${encodeURIComponent(
              `project:${project}/Assets/scenes/${SCENE_A}.json`,
            )}`,
          );
          const raw = (await file.json()) as {
            objects?: Array<{ image?: unknown; map?: unknown }>;
          };
          const object = raw.objects?.[0];
          return object === undefined ? null : { image: object.image, map: object.map };
        })
        .toEqual({
          image: { id: imageId, width: 200, height: 150 },
          map: undefined,
        });
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

  test("地图是世界里的对象：改世界坐标 / 拖它，贴图跟着走", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 贴图声明成 400×300（比视口小）：这样地图是一块**看得见边界**的小棋盘，
      // 移动它以后原地会真的空出来（1920×1080 铺满视口，怎么挪都是红的）
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [
          mapObjectDoc(project, SCENE_A, "网格地图", { width: 400, height: 300 }),
        ]),
      ]);
      // 贴图要在打开项目**之前**提交：编辑器不会盯着素材目录变化
      await uploadSceneImage(request, project, SCENE_A, solidPng(4, 4, [255, 0, 0]));

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      await expect(page.getByTestId("scene-image-error")).toHaveCount(0);

      // 落点挑在棋盘内、又离网格线足够远的地方（网格 64×36 → 一格 6.25×8.33px）
      const inside = { x: 60, y: 60 };
      await expect
        .poll(async () => (await canvasAverageColor(page, await worldSamplePoint(page, inside))).r)
        .toBeGreaterThan(180);

      // 点棋盘里任意一处就能选中地图：拾取用的是**它整块矩形**，不再是中心那个小圆点
      const insidePoint = await worldSamplePoint(page, inside);
      await page.mouse.click(insidePoint.x, insidePoint.y);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");

      // 属性面板里改世界坐标：它就是贴图中心
      await setObjectPositionViaInspector(page, { x: -300, y: 200 });

      // 原地空出来、贴图出现在新位置（-300,200 的棋盘覆盖 x∈[-500,-100]、y∈[50,350]）
      const moved = { x: -240, y: 260 };
      await expect
        .poll(async () => (await canvasAverageColor(page, await worldSamplePoint(page, moved))).r)
        .toBeGreaterThan(180);
      await expect
        .poll(async () => (await canvasAverageColor(page, await worldSamplePoint(page, inside))).r)
        .toBeLessThan(90);

      // 落盘：位置就是世界坐标（贴图中心）
      await expect
        .poll(async () => {
          const map = (await readSceneObjects(request, project, SCENE_A)).find(
            (object) => object.kind === "Map",
          );
          return map?.position ?? null;
        })
        .toEqual({ x: -300, y: 200 });

      // 在画布上直接拖地图同样能移动它（和普通对象一样，按整块矩形拾取）。
      // 落点先探一次：平板竖屏左边有抽屉、桌面也可能被面板压住，
      // 直接按世界坐标算出的屏幕点不一定点得到（那一下会变成平移画布）
      const probed = await clampedWorldPoint(page, -200, 150);
      await setObjectPositionViaInspector(page, probed.world);

      const from = await scenePoint(page, probed.world.x, probed.world.y);
      const to = { x: from.x + 120, y: from.y - 60 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();

      const expected = await sceneWorldAt(page, to);
      await expect
        .poll(async () => {
          const position = (await readSceneObjects(request, project, SCENE_A))[0]?.position ?? null;
          return position === null
            ? null
            : Math.hypot(position.x - expected.x, position.y - expected.y) < 2;
        })
        .toBe(true);
    } finally {
      await dropProject(request, project);
    }
  });

  test("列表里双击改名", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [sceneDoc(SCENE_A, [sceneObjectDoc("木门")])]);

      // 「双击那一行」现在要点名字那一块：行首多了一枚激活按钮，`.first()` 会点到它
      await page.getByTestId("object-row").first().locator("button", { hasText: "木门" }).dblclick();
      await page.getByTestId("object-rename-input").fill("大门");
      await page.keyboard.press("Enter");

      await expect(page.getByTestId("object-row").filter({ hasText: "大门" })).toBeVisible();
      await expectPersistedObjectNames(request, project, SCENE_A, ["大门"]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("激活按钮：不激活就不画（对齐 Unity），对象仍在场景里", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [mapObjectDoc(project, SCENE_A, "网格地图", { width: 400, height: 300 })]),
      ]);
      // 纯红贴图：画布上还有没有红色，就说明那张图还画不画
      await uploadSceneImage(request, project, SCENE_A, solidPng(4, 4, [255, 0, 0]));

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 采样点避开世界原点：原点十字与网格线都会混进平均值里
      // （地图 400×300，采样点仍稳稳落在贴图内）
      const inside = { x: 60, y: 60 };
      const redAt = async (): Promise<number> =>
        (await canvasAverageColor(page, await worldSamplePoint(page, inside))).r;

      await expect.poll(redAt).toBeGreaterThan(180);

      const row = page.getByTestId("object-row").first();
      const toggle = row.getByTestId("object-active-toggle");
      await expect(row).toHaveAttribute("data-active", "true");
      await expect(toggle).toHaveAttribute("data-active", "true");

      // 点一下 = 隐藏：画布上那块变成底纹（红通道掉下去），行标记也跟着变
      await toggle.click();
      await expect(row).toHaveAttribute("data-active", "false");
      await expect(toggle).toHaveAttribute("data-active", "false");
      await expect.poll(redAt).toBeLessThan(90);

      // 对象**还在**场景里（不是删除）：行还在，属性面板照样能打开
      await expect(page.getByTestId("object-row")).toHaveCount(1);

      // 落盘：active 写进场景文件
      await expect
        .poll(async () => (await readSceneObjects(request, project, SCENE_A))[0]?.active)
        .toBe(false);

      // 再点一下 = 又显示出来（第二下必须能切回来）
      await toggle.click();
      await expect(row).toHaveAttribute("data-active", "true");
      await expect.poll(redAt).toBeGreaterThan(180);
    } finally {
      await dropProject(request, project);
    }
  });

  test("显示顺序：大的画在前面（盖住小的），相同则按列表先后", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 两个重叠的纯色精灵，中心都在世界原点：谁盖住谁只看 sortingOrder
      const greenId = `project:${project}/Assets/images/green.png`;
      const blueId = `project:${project}/Assets/images/blue.png`;
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE_A, [
          sceneObjectDoc("绿块", "SceneObject", { x: 0, y: 0 }, {
            sortingOrder: 5,
            image: { id: greenId, width: 120, height: 120 },
          }),
          sceneObjectDoc("蓝块", "SceneObject", { x: 0, y: 0 }, {
            sortingOrder: 1,
            image: { id: blueId, width: 120, height: 120 },
          }),
        ]),
      ]);
      for (const [id, color] of [
        [greenId, [0, 255, 0]],
        [blueId, [0, 0, 255]],
      ] as const) {
        const uploaded = await request.put(`/api/resources/raw?id=${encodeURIComponent(id)}`, {
          headers: { "content-type": "image/png" },
          data: solidPng(120, 120, color),
        });
        expect(uploaded.ok()).toBeTruthy();
      }

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 采样点避开世界原点：原点十字与标记点都会混进平均值里。
      // 两个精灵都是 120×120，采样点仍在它们重合的那块里
      const sample = await worldSamplePoint(page, { x: 36, y: 36 });
      const colorAtSample = async (): Promise<{ r: number; g: number; b: number }> =>
        canvasAverageColor(page, sample, 6);

      // 绿块顺序 5 > 蓝块 1 → 绿的在上面（蓝块虽然列在后面，但顺序更小）
      await expect.poll(async () => (await colorAtSample()).g).toBeGreaterThan(180);
      await expect.poll(async () => (await colorAtSample()).b).toBeLessThan(90);

      // 把绿块的顺序改成 -1（排到蓝块下面）→ 原点变成蓝色
      const greenRow = page.getByTestId("object-row").filter({ hasText: "绿块" }).first();
      await greenRow.click();
      if (!(await page.getByTestId("inspector-object-sorting").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      await page.getByTestId("inspector-object-sorting").fill("-1");
      await page.getByTestId("inspector-object-sorting").blur();

      await expect.poll(async () => (await colorAtSample()).b).toBeGreaterThan(180);
      await expect.poll(async () => (await colorAtSample()).g).toBeLessThan(90);

      // 落盘：顺序写进场景文件
      await expect
        .poll(async () => {
          const objects = await readSceneObjects(request, project, SCENE_A);
          return objects.find((object) => object.name === "绿块")?.sortingOrder ?? null;
        })
        .toBe(-1);
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
