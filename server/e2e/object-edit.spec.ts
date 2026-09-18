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
} from "./helpers/editor";

/**
 * 场景对象的创建与编辑。
 *
 * 创建只有一条路：**「新建对象」弹框**（画布标题栏的按钮 / `Ctrl+Shift+N` / 编辑菜单），
 * 对象生成在场景正中，之后在画布上拖动定位。
 *
 * 默认视口是 scale 1、无平移（`createViewport()`），所以**世界像素直接对应画布上的偏移**：
 * 归一化坐标 × 占位画布尺寸（1920×1080）就是标记点的屏幕落点。
 */

const SCENE_A = "Map001";
const SCENE_B = "Map002";
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

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
 * 归一化场景坐标 → 画布上的屏幕点（见文件头的默认视口说明）。
 *
 * 取值要注意：**平板竖屏下左边 340px 是抽屉**，点落在那里会打在抽屉上而不是画布。
 * 所以种子的坐标要让 `x * 1920` 落在 340 与画布宽度之间（本文件用 0.25 → 480）。
 */
async function scenePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("scene-viewport").boundingBox();
  if (box === null) {
    throw new Error("拿不到画布尺寸");
  }

  return { x: box.x + x * CANVAS_WIDTH, y: box.y + y * CANVAS_HEIGHT };
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
  test("弹框创建：先选种类、再选种类下的对象，生成在场景正中", async ({ page, request }) => {
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

      // 二级：实体下目前只有 2D地图，默认选中，名字按类型预填
      await expect(page.getByTestId("object-type-Map")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("object-name-input")).toHaveValue("2D地图");

      // 还没做出来的种类：给提示，且创建按钮不可用
      await page.getByTestId("object-category-action").click();
      await expect(page.getByTestId("object-type-list")).toContainText("还没有可创建的对象");
      await expect(page.getByTestId("confirm-object")).toBeDisabled();

      await page.getByTestId("object-category-entity").click();
      await page.getByTestId("confirm-object").click();
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);

      await expect(page.getByTestId("object-row")).toHaveCount(1);
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");

      // 生成在场景正中
      await expect
        .poll(async () => (await readSceneObjects(request, project, SCENE_A))[0]?.position ?? null)
        .toEqual({ x: 0.5, y: 0.5 });

      // 再开一次：名字自动避开重名
      await page.getByTestId("new-object").click();
      await expect(page.getByTestId("object-name-input")).toHaveValue("2D地图 2");

      await page.getByTestId("object-dialog-cancel").click();
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);
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

      // 实体 = 场景物体 + 2D地图
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

  test("拖动画布上的标记点：位置随之改变（画布坐标与归一化坐标一致）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await openSceneForEdit(page, request, project, [
        sceneDoc(SCENE_A, [
          {
            id: "door",
            name: "木门",
            kind: "SceneObject",
            position: { x: 0.25, y: 0.3 },
            rotation: 0,
            components: [],
          },
        ]),
      ]);

      const from = await scenePoint(page, 0.25, 0.3);
      const to = { x: from.x + 120, y: from.y + 60 };

      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();

      // 拖动改位置 → 自动存写回；而且落点就是指针处的归一化坐标
      const box = await page.getByTestId("scene-viewport").boundingBox();
      if (box === null) {
        throw new Error("拿不到画布尺寸");
      }

      const expectedX = (to.x - box.x) / CANVAS_WIDTH;
      const expectedY = (to.y - box.y) / CANVAS_HEIGHT;

      await expect
        .poll(async () => {
          const position = (await readSceneObjects(request, project, SCENE_A))[0]?.position ?? null;
          return position === null
            ? null
            : Math.hypot(position.x - expectedX, position.y - expectedY) < 0.002;
        })
        .toBe(true);

      // 命中标记点也顺带选中了它
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");
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

      await page.getByTestId("inspector-object-x").fill("0.25");
      await page.getByTestId("inspector-object-y").fill("0.75");
      await page.getByTestId("inspector-object-y").blur();

      // 只比关心的两个字段（对象上还有 id / kind / components 等）
      await expect
        .poll(async () => {
          const object = (await readSceneObjects(request, project, SCENE_A))[0];
          return object === undefined ? null : { name: object.name, position: object.position };
        })
        .toEqual({ name: "大门", position: { x: 0.25, y: 0.75 } });
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
      await expectPersistedObjectNames(request, project, SCENE_A, ["2D地图"]);
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
      await expectPersistedObjectNames(request, project, SCENE_A, ["2D地图"]);
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

      await expectPersistedObjectNames(request, project, SCENE_A, ["2D地图"]);
      expect(await readSceneObjects(request, project, SCENE_B)).toEqual([]);
    } finally {
      await dropProject(request, project);
    }
  });
});
