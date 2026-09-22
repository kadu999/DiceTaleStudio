import { expect, test, type Page } from "@playwright/test";
import {
  COMPONENT,
  CURRENT_SCENE_FORMAT_VERSION,
  closeDrawers,
  componentDataOf,
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openMenu,
  openProject,
  readSceneFile,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
  type SceneFileLike,
  uploadSceneImage,
} from "./helpers/editor";

/**
 * 场景管理：菜单里的新建 / 重命名 / 删除。
 *
 * 场景是 `Assets/scenes/<场景名>.json` 独立文件，**场景名就是文件名**：
 * 编辑器只做建 / 删 / 改名，**永不写场景内容**。
 */

function sceneFileId(project: string, name: string): string {
  return `project:${project}/Assets/scenes/${name}.json`;
}

/** 打开「场景」菜单里的一项。 */
async function sceneMenu(page: Page, name: RegExp | string): Promise<void> {
  // 走 openMenu（限定在菜单栏里）：属性面板也有一个叫「场景」的分组标题
  await openMenu(page, "场景");
  await page.getByRole("menuitem", { name }).click();
}

test.describe("场景菜单", () => {
  test("新建场景：建出场景文件、成为当前场景", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");

      await sceneMenu(page, "新建场景…");
      await page.getByTestId("scene-name-input").fill("酒馆");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 酒馆");

      // 文件落在 Assets/scenes/ 下，而且**名字不进文件**（名字就是文件名）
      const file = await readSceneFile(request, project, "酒馆");
      expect(file).toBeDefined();
      expect(file?.objects).toEqual([]);
      expect(file?.formatVersion).toBe(CURRENT_SCENE_FORMAT_VERSION);
      expect(file).not.toHaveProperty("name");
    } finally {
      await dropProject(request, project);
    }
  });

  test("重命名场景：只改文件名（没有地图对象时内容一字不动）", async ({ page, request }) => {    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("Map001", [
          { id: "door", name: "木门", kind: "Sprite", position: null, rotation: 0, components: [] },
        ]),
      ]);
      await enterEditor(page);
      await openProject(page, project);
      const before = await readSceneFile(request, project, "Map001");

      await sceneMenu(page, /重命名/);
      await page.getByTestId("scene-name-input").fill("大厅");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 大厅");

      // 没有地图对象 → 没有贴图引用要同步。
      // **不再比对整个文件**：打开旧版本文件时它已被升到当前版本并补上新增字段
      // （`active` / `sortingOrder` / `scale` / `locked`），所以「一字不动」只对**对象内容**成立。
      const after = await readSceneFile(request, project, "大厅");
      expect(after?.formatVersion).toBe(CURRENT_SCENE_FORMAT_VERSION);

      const door = (file: SceneFileLike | undefined): Record<string, unknown> =>
        file?.objects?.[0] ?? {};
      // 除新增字段外，其余字段逐字一致（id / 名字 / 类型 / 位置 / 旋转 / 组件）
      const NEW_OBJECT_FIELDS = ["active", "sortingOrder", "scale", "locked"];
      const withoutNewFields = (object: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(object).filter(([key]) => !NEW_OBJECT_FIELDS.includes(key)),
        );

      expect(withoutNewFields(door(after))).toEqual(withoutNewFields(door(before)));

      // 旧文件不存在了
      const old = await request.get(
        `/api/resources/text?id=${encodeURIComponent(sceneFileId(project, "Map001"))}`,
      );
      expect(old.status()).toBe(404);
    } finally {
      await dropProject(request, project);
    }
  });

  test("重命名场景：与场景同名的贴图引用跟着改名（否则贴图立刻找不到）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("Map001", [mapObjectDoc(project, "Map001")]),
      ]);
      await enterEditor(page);
      await openProject(page, project);

      await sceneMenu(page, /重命名/);
      await page.getByTestId("scene-name-input").fill("大厅");
      await page.getByTestId("confirm-scene").click();
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 大厅");

      // 贴图是按「与场景同名」约定引用的，所以引用要一起改指到 大厅.png
      // （只改引用：声明尺寸原样留着）
      const file = await readSceneFile(request, project, "大厅");
      expect(componentDataOf(file, { kind: "Map" }, COMPONENT.gridMap)?.["image"]).toEqual({
        id: `project:${project}/Assets/images/大厅.png`,
        width: 1920,
        height: 1080,
      });
    } finally {
      await dropProject(request, project);
    }
  });

  test("删除场景：删掉场景文件", async ({ page, request }) => {
    const project = await newProject(request);
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await sceneMenu(page, /^删除/);

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");

      const removed = await request.get(
        `/api/resources/text?id=${encodeURIComponent(sceneFileId(project, "Map001"))}`,
      );
      expect(removed.status()).toBe(404);
    } finally {
      await dropProject(request, project);
    }
  });

  test("没有场景时：点画布上的占位就能新建场景", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("no-scene-canvas")).toBeVisible();

      // 占位本身就是入口。注意「场景对象」面板里也有同样的占位（它默认就显示），
      // 所以这里限定在**画布**上点。
      await page.getByTestId("no-scene-canvas").getByTestId("empty-create-scene").click();
      await expect(page.getByTestId("scene-dialog")).toBeVisible();
      await page.getByTestId("scene-name-input").fill("Map001");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");
      // 有场景了，画布上的占位就该消失
      await expect(page.getByTestId("no-scene-canvas")).toHaveCount(0);
      // 场景对象面板里的占位同样消失
      await expect(page.getByTestId("object-tree").getByTestId("empty-create-scene")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("当前场景看得见，也能直接切换", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);

      // 当前场景在标题栏上看得见，「切换条」上点一下即切
      await expect(page.getByTestId("scene-current")).toHaveText("Map001");
      await expect(page.getByTestId("scene-bar")).toHaveAttribute("data-scene", "Map001");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await page.getByTestId("scene-chip").filter({ hasText: "Map002" }).click();

      await expect(page.getByTestId("scene-current")).toHaveText("Map002");
      await expect(page.getByTestId("scene-bar")).toHaveAttribute("data-scene", "Map002");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");
      // 当前那一格高亮，别的不是
      await expect(page.getByTestId("scene-chip").filter({ hasText: "Map002" })).toHaveAttribute(
        "data-active",
        "true",
      );
      await expect(page.getByTestId("scene-chip").filter({ hasText: "Map001" })).toHaveAttribute(
        "data-active",
        "false",
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("在资源面板里点场景文件就能切过去（当前场景那行高亮）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await openLeftTab(page, "assets");
      await page.getByTestId("folder-tree-row").filter({ hasText: "scenes" }).first().click();

      const contentRows = page.getByTestId("folder-content-row");
      // 目录里不显示扩展名，当前场景那一行是选中的
      await expect(contentRows.filter({ hasText: "Map001" })).toHaveAttribute(
        "data-selected",
        "true",
      );
      await expect(contentRows.filter({ hasText: "Map001.json" })).toHaveCount(0);

      // 点另一个场景文件即切过去
      await contentRows.filter({ hasText: "Map002" }).first().click();

      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");
      await expect(page.getByTestId("scene-bar")).toHaveAttribute("data-scene", "Map002");
      await expect(contentRows.filter({ hasText: "Map002" })).toHaveAttribute(
        "data-selected",
        "true",
      );
    } finally {
      await dropProject(request, project);
    }
  });

  test("保护：重名被拒绝（不覆盖已有场景）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001"), sceneDoc("Map002")]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      // 改名到已存在的场景名：对话框里给错误、不关窗
      await sceneMenu(page, /重命名/);
      await page.getByTestId("scene-name-input").fill("Map002");
      await page.getByTestId("confirm-scene").click();

      await expect(page.getByTestId("scene-dialog")).toBeVisible();
      await expect(page.getByText("场景「Map002」已存在")).toBeVisible();
      await page.getByTestId("scene-dialog-cancel").click();
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
    } finally {
      await dropProject(request, project);
    }
  });

  test("保护：只剩一个场景时不能删", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [sceneDoc("Map001")]);
      await enterEditor(page);
      await openProject(page, project);

      await openMenu(page, "场景");
      await expect(page.getByRole("menuitem", { name: /^删除/ })).toBeDisabled();
      await page.keyboard.press("Escape");
    } finally {
      await dropProject(request, project);
    }
  });
});

/**
 * 跑团现场最常用的动作：**换台**。
 *
 * DM 是边讲边切的，所以这里钉的是「一次点击 / 一个按键就到位」：切换条点一下、
 * `1`-`9` 直选、`[` / `]` 前后；顺序按**自然序**（`第2幕` 在 `第10幕` 前，编号才靠得住）；
 * 切到没去过的场景自动铺满，切回去恢复上次的视角。
 */
test.describe("场景切换：切换条与快捷键", () => {
  test("切换条按自然序排：第2幕 在第10幕 前面（序号就是快捷键的说明）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("第10幕"),
        sceneDoc("第2幕"),
        sceneDoc("第1幕"),
      ]);
      await enterEditor(page);
      await openProject(page, project);

      const chips = page.getByTestId("scene-chip");
      await expect(chips).toHaveCount(3);
      await expect(chips.nth(0)).toHaveAttribute("data-scene", "第1幕");
      await expect(chips.nth(1)).toHaveAttribute("data-scene", "第2幕");
      await expect(chips.nth(2)).toHaveAttribute("data-scene", "第10幕");
      // 序号写在格子上（前九格）：按 2 就该到第 2 格
      await expect(chips.nth(1)).toHaveAttribute("data-index", "2");
    } finally {
      await dropProject(request, project);
    }
  });

  test("快捷键：`1`-`9` 直选、`[` / `]` 上一场 / 下一场（到端点不循环）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("Map001"),
        sceneDoc("Map002"),
        sceneDoc("Map003"),
      ]);
      await enterEditor(page);
      await openProject(page, project);
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");

      await page.keyboard.press("]");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");
      await page.keyboard.press("]");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map003");

      // 到末尾：再按一下什么都不做（不绕回第一场）
      await page.keyboard.press("]");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map003");

      await page.keyboard.press("[");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map002");

      await page.keyboard.press("3");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map003");
      await expect(page.getByTestId("scene-bar")).toHaveAttribute("data-scene", "Map003");
    } finally {
      await dropProject(request, project);
    }
  });

  test("在输入框里打字时数字键不切场景（免得改坐标改到一半换了图）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc("Map001", [sceneObjectDoc("木门", "Sprite", { x: 0, y: 0 })]),
        sceneDoc("Map002"),
      ]);
      await enterEditor(page);
      await openProject(page, project);

      await selectObject(page);
      const filter = page.getByTestId("object-filter");
      await filter.fill("");
      await filter.click();
      await page.keyboard.type("2");

      await expect(filter).toHaveValue("2");
      await expect(page.getByTestId("status-active-scene")).toHaveText("当前场景 Map001");
    } finally {
      await dropProject(request, project);
    }
  });

  test("换台时视口跟着走：没去过的场景自动铺满，切回去恢复上次的视角", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      // 两张**大小不同**的地图：同一张图就看不出「到底适配了谁」
      const small = mapObjectDoc(
        project,
        "Map001",
        "小图",
        { width: 400, height: 300 },
        { width: 8, height: 6 },
      );
      const large = mapObjectDoc(
        project,
        "Map002",
        "大图",
        { width: 1600, height: 1200 },
        { width: 32, height: 24 },
      );
      await seedProjectDoc(request, project, [
        sceneDoc("Map001", [small]),
        sceneDoc("Map002", [large]),
      ]);
      await uploadSceneImage(request, project, "Map001", solidPng(400, 300, [0, 255, 0]));
      await uploadSceneImage(request, project, "Map002", solidPng(1600, 1200, [0, 0, 255]));

      await enterEditor(page);
      await openProject(page, project);
      // 平板下左栏是**覆盖式抽屉**，会盖住切换条左边那几格
      await closeDrawers(page);
      // 先把视角复位成 1:1：小图**适配**出来是 ~2 倍，两者明显不同，正好用来区分
      // 「切过去自动铺满」与「切回来还记得刚才的视角」
      await page.getByTestId("reset-viewport").click();
      await expect.poll(() => readViewportScale(page)).toBeCloseTo(1, 2);

      const box = await page.getByTestId("scene-viewport").boundingBox();
      const fitOf = (size: { width: number; height: number }): number =>
        Math.min(((box?.width ?? 0) - 48) / size.width, ((box?.height ?? 0) - 48) / size.height);
      const smallFit = fitOf({ width: 400, height: 300 });
      // 小图「铺满」与 1:1 分得开，这条断言才有意义
      expect(smallFit).toBeGreaterThan(1.2);

      // 切到大图：自动适配（整张 1600×1200 铺进画布），而不是沿用 1:1
      await page.getByTestId("scene-chip").filter({ hasText: "Map002" }).click();
      await expect.poll(() => readViewportScale(page)).toBeCloseTo(
        fitOf({ width: 1600, height: 1200 }),
        2,
      );

      // 切回小图：回到刚才复位的 1:1（记住的是用户视角，不是又适配成 ~2 倍）
      await page.getByTestId("scene-chip").filter({ hasText: "Map001" }).click();
      await expect.poll(() => readViewportScale(page)).toBeCloseTo(1, 2);
    } finally {
      await dropProject(request, project);
    }
  });
});

/** 画布上当前的缩放（面板把它写在 DOM 属性上，只给 E2E 用）。 */
async function readViewportScale(page: Page): Promise<number> {
  const raw = await page.getByTestId("scene-viewport").getAttribute("data-viewport-scale");
  return Number.parseFloat(raw ?? "1");
}
