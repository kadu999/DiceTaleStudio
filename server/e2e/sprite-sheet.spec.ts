import { expect, test, type Page } from "@playwright/test";
import {
  COMPONENT,
  colorGridPng,
  componentDataOf,
  dropProject,
  enterEditor,
  findGameObject,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openProject,
  readObjectSprite,
  readSceneFile,
  readSpriteSheet,
  sceneDoc,
  gameObjectDoc,
  seedProjectDoc,
  selectObject,
  withComponent,
} from "./helpers/editor";
import { canvasAverageColor, exactWorldPoint } from "./helpers/canvas";

/**
 * **精灵（子图，v20 / 协议 v10）**：把一张图按「行 × 列」切成格子，对象引用其中一格。
 *
 * 三条口径在这里钉住（也用画布像素证明，而不只是看文件）：
 *
 * 1. **切分只有一份**：住在**素材自己的 `.meta`**（`A.png.meta` 的 `sprite.sheet`，v23 起），
 *    对象身上只有「引用哪张图 + 第几格」——改切分，所有引用它的对象一起变；
 * 2. **只画那一格**：画布上对象那块矩形里刷的是**选中那一格**的像素
 *    （图集四格四种颜色，采样就能分辨画的是哪一块）；
 * 3. **地图不给子图**：贴图住在 `GridMap` 里、格子按整张贴图算，选择窗口里没有切分面板。
 *
 * 图集用「每格一色」造（`colorGridPng`），格序数与文档同一读法：**从左到右、从上到下**。
 */

const SCENE = "Map001";
const CELL = 32;

const RED = [255, 0, 0] as const;
const GREEN = [0, 255, 0] as const;
const BLUE = [0, 0, 255] as const;
const YELLOW = [255, 255, 0] as const;

/** 某点的平均颜色是不是这个纯色（画布上贴图可能被轻微缩放，给一点容差）。 */
async function expectColorAt(
  page: Page,
  world: { x: number; y: number },
  color: readonly [number, number, number],
): Promise<void> {
  const point = await exactWorldPoint(page, world);
  await expect
    .poll(async () => {
      const sampled = await canvasAverageColor(page, point, 3);
      return [Math.round(sampled.r), Math.round(sampled.g), Math.round(sampled.b)];
    })
    .toEqual([color[0], color[1], color[2]]);
}

test.describe("精灵：把图集切成子图", () => {
  test("选一格 → 只画那一格，并落进场景文件与工程文件两份", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const imageId = `project:${project}/Assets/images/sheet.png`;
      // 2×2 图集（红 绿 / 蓝 黄），对象先用**整张图**（一格 32×32 → 对象 64×64）
      await seedProjectDoc(
        request,
        project,
        [
          sceneDoc(SCENE, [
            withComponent(
              gameObjectDoc("精灵", "Sprite", { x: 0, y: 0 }),
              COMPONENT.spriteLayer,
              { id: imageId, width: CELL * 2, height: CELL * 2 },
            ),
          ]),
        ],
        { spriteSheets: { [imageId]: { columns: 2, rows: 2 } } },
      );
      const uploaded = await request.put(
        `/api/resources/raw?id=${encodeURIComponent(imageId)}`,
        {
          headers: { "content-type": "image/png" },
          data: colorGridPng(2, 2, [RED, GREEN, BLUE, YELLOW], CELL),
        },
      );
      expect(uploaded.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      await selectObject(page);

      // 整张图：四个格子各画各的（左上红、右下黄）
      await expectColorAt(page, { x: -CELL / 2, y: CELL / 2 }, RED);
      await expectColorAt(page, { x: CELL / 2, y: -CELL / 2 }, YELLOW);
      // 属性面板这时不说子图
      await expect(page.getByTestId("texture-sprite")).toHaveCount(0);

      // 打开选择窗口：切分已经在工程文件里（2×2），点右上那一格（绿）
      await page.getByTestId("pick-texture").click();
      const dialog = page.getByTestId("image-picker-dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("image-picker-sprite")).toHaveCount(4);
      await page.locator('[data-testid="image-picker-sprite"][data-sprite="1,0"]').click();

      await page.getByTestId("image-picker-confirm").click();
      await expect(dialog).toHaveCount(0);

      // 属性面板写出「子图 第1行第2列（2×2）」
      await expect(page.getByTestId("texture-sprite")).toContainText("子图 第1行第2列（2×2）");

      // **画布只画那一格**：整块矩形都成了绿（其余三格的颜色不见了）。
      // 采样点避开**世界原点的十字光标**（它正好在对象中心）与选中框的 8 个手柄
      // （对象这时是 32×32，边与角上都有 7px 的东西）——取四个象限里靠内的点
      await expectColorAt(page, { x: 10, y: 10 }, GREEN);
      await expectColorAt(page, { x: -10, y: 10 }, GREEN);
      await expectColorAt(page, { x: 10, y: -10 }, GREEN);

      // 落盘：**场景文件只记「第几格」**（行列在素材自己的 `.meta` 里，另有断言）
      await expect
        .poll(async () => readObjectSprite(request, project, SCENE, { objectId: "object_精灵" }))
        .toEqual({ column: 1, row: 0 });
      await expect
        .poll(async () => {
          const file = await readSceneFile(request, project, SCENE);
          const data = componentDataOf(file, { objectId: "object_精灵" }, COMPONENT.spriteLayer);
          return { width: data?.["width"], height: data?.["height"] };
        })
        .toEqual({ width: CELL, height: CELL });
      await expect.poll(async () => readSpriteSheet(request, imageId)).toEqual({
        columns: 2,
        rows: 2,
      });

      // 场景文件里不该出现行列（那是素材自己的 `.meta` 里的字段）
      const text = JSON.stringify(await readSceneFile(request, project, SCENE));
      expect(text).not.toContain("columns");
    } finally {
      await dropProject(request, project);
    }
  });

  test("改切分：同一份引用算出另一块像素（对象侧一个字节都不改）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const imageId = `project:${project}/Assets/images/sheet.png`;
      // 图集是**一行四色**（红 绿 蓝 黄，各 16px 宽，整张 64×16）；对象声明尺寸 32×16，
      // 对应「2 列」时那一格的大小，指着第 (1, 0) 格：
      // - 切分 2×1 → 那一格 = 图里 x32..64 = **蓝 + 黄**（左半边蓝、右半边黄）
      // - 切分 4×1 → 那一格 = 图里 x16..32 = **纯绿**
      // 于是「改切分」在画布上有肉眼可辨的变化，而对象身上一个字节都不用改
      await seedProjectDoc(
        request,
        project,
        [
          sceneDoc(SCENE, [
            withComponent(
              gameObjectDoc("精灵", "Sprite", { x: 0, y: 0 }),
              COMPONENT.spriteLayer,
              { id: imageId, width: CELL, height: 16, sprite: { column: 1, row: 0 } },
            ),
          ]),
        ],
        { spriteSheets: { [imageId]: { columns: 2, rows: 1 } } },
      );
      const uploaded = await request.put(
        `/api/resources/raw?id=${encodeURIComponent(imageId)}`,
        {
          headers: { "content-type": "image/png" },
          data: colorGridPng(4, 1, [RED, GREEN, BLUE, YELLOW], 16),
        },
      );
      expect(uploaded.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      await selectObject(page);

      // 2×1：那一格左半蓝、右半黄（采样点避开世界原点的十字光标与选中框手柄：
      // 对象是 32×16，十字臂 ±7、手柄 7px 都在边上）
      await expect(page.getByTestId("texture-sprite")).toContainText("子图 第1行第2列（2×1）");
      await expect(page.getByTestId("texture-sprite-out-of-range")).toHaveCount(0);
      await expectColorAt(page, { x: -8, y: 3 }, BLUE);
      await expectColorAt(page, { x: 8, y: -3 }, YELLOW);

      // 把切分改成 4×1（工程级、只有一份），从图片资源属性进入精灵编辑器
      await openLeftTab(page, "assets");
      await page.locator('[data-testid="folder-content-row"][data-path="Assets/images"] [data-testid="folder-content-label"]').click();
      await page.locator('[data-testid="folder-content-row"][data-path="Assets/images/sheet.png"] [data-testid="folder-content-label"]').click();
      const spriteToggle = page.getByTestId("sprite-type-toggle");
      if (!(await spriteToggle.isChecked())) await spriteToggle.click();
      await page.getByTestId("sprite-import-mode").selectOption("Multiple");
      await page.getByTestId("sprite-edit").click();
      await page.getByTestId("sprite-editor-columns").fill("4");
      await page.getByTestId("sprite-editor-apply").click();
      await openLeftTab(page, "hierarchy");
      await selectObject(page);

      // 同一格、同一份引用，现在算出的是**纯绿**——「改切分，引用它的对象一起变」是解析出来的
      await expect(page.getByTestId("texture-sprite")).toContainText("子图 第1行第2列（4×1）");
      await expectColorAt(page, { x: -8, y: 3 }, GREEN);
      await expectColorAt(page, { x: 8, y: -3 }, GREEN);

      await expect.poll(async () => readSpriteSheet(request, imageId)).toEqual({
        columns: 4,
        rows: 1,
      });
      // 对象侧照旧：还是 (1, 0)
      expect(await readObjectSprite(request, project, SCENE, { objectId: "object_精灵" })).toEqual({
        column: 1,
        row: 0,
      });
    } finally {
      await dropProject(request, project);
    }
  });

  test("地图对象的选择窗口没有切分面板（贴图不支持子图）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const map = mapObjectDoc(project, SCENE, "地图", { width: 128, height: 128 }, { width: 4, height: 4 });
      await seedProjectDoc(request, project, [sceneDoc(SCENE, [map])]);
      await request.put(
        `/api/resources/raw?id=${encodeURIComponent(`project:${project}/Assets/images/${SCENE}.png`)}`,
        {
          headers: { "content-type": "image/png" },
          data: colorGridPng(2, 2, [RED, GREEN, BLUE, YELLOW], CELL),
        },
      );

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      // 场景里只有这一个对象（地图）；用公共助手选中它——平板档位下面板是覆盖式抽屉，
      // 助手会把该开的抽屉开好（直接点列表行会被抽屉挡住）
      await selectObject(page);

      await page.getByTestId("pick-texture").click();
      await expect(page.getByTestId("image-picker-dialog")).toBeVisible();
      await expect(page.getByTestId("image-picker-sprite")).toHaveCount(0);
      await expect(page.getByTestId("image-picker-confirm")).toContainText("使用整图");
      await page.getByTestId("image-picker-cancel").click();

      // 场景文件里的地图贴图引用照旧只有 id / 宽高（没有子图字段）
      const file = await readSceneFile(request, project, SCENE);
      const data = componentDataOf(file, { kind: "Map" }, COMPONENT.gridMap) as
        | { image?: Record<string, unknown> }
        | undefined;
      expect(Object.keys(data?.image ?? {}).sort()).toEqual(["height", "id", "width"]);
      expect(findGameObject(file, { kind: "Map" })).toBeDefined();
    } finally {
      await dropProject(request, project);
    }
  });
});
