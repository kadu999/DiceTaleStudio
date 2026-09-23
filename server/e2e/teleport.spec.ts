import { expect, test, type Page } from "@playwright/test";
import {
  COMPONENT,
  closeDrawers,
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openInspector,
  openLeftTab,
  openProject,
  readSceneTeleport,
  sceneDoc,
  gameObjectDoc,
  seedProjectDoc,
  solidPng,
  uploadSceneImage,
  withComponent,
} from "./helpers/editor";
import { canvasAverageColor, preciseWorldPoint } from "./helpers/canvas";

/**
 * **传送阵**（动作对象）：弹框里「动作」种类下的第二个对象。
 *
 * 数据形状与**播放声音完全同一套**：**候选清单**（勾进来的目标场景）+ **选中的那一个**；
 * 界面上的分工也一样——清单在「传送目标」窗口里勾（面板上那枚 `＋`），
 * 选哪个在属性面板上点小方块。它只有一件事：**按一下，全场换到选中的那张图**（DM 的「换台」）。
 * 两个入口是同一件事——属性面板的「传送」按钮（平板的主入口）与画布上**双击徽标**（鼠标的快路径）。
 *
 * 这里钉住四件在真实使用里最容易出问题的事：
 * 1. 它和实体一样摆在世界里、画布上看得见点得到（不认贴图，画内置徽标）；
 * 2. 清单是清单、选中是选中：窗口里勾进来的才有资格被选中（两边别串了）；
 * 3. 按下去**真的切了场景**（状态栏 + 切换条都跟着变），而且**文档没被改**（按一下不是编辑）；
 * 4. 目标不合法时**点不动并写明理由**（没加目标 / 没选 / 目标不存在 / 目标就是当前场景）。
 *
 * 「运行中切场景会立刻推给前端」在 `smoke.spec.ts` 的运行态用例里（那边有服务端镜像可断言）。
 */

const SCENE = "Map001";
const OTHER = "Map002";

/** 新建一个传送阵（弹框：动作 → 传送阵），名字按类型预填。 */
async function createTeleport(page: Page): Promise<void> {
  await page.getByTestId("new-object").click();
  await expect(page.getByTestId("object-dialog")).toBeVisible();
  await page.getByTestId("object-category-action").click();
  await page.getByTestId("object-type-Teleport").click();
  await expect(page.getByTestId("object-name-input")).toHaveValue("传送阵");
  await page.getByTestId("confirm-object").click();
  await expect(page.getByTestId("object-dialog")).toHaveCount(0);
}

/**
 * 选中列表里的传送阵，并把属性面板露出来（平板下它是右抽屉）。
 *
 * **按名字找**而不是「第一行」：场景里通常还有地图，靠行序会因为「筛选还没生效」而选错行
 * （选了地图 → 面板上没有「传送」组 → 一路超时）。
 */
async function selectTeleportRow(page: Page, name = "传送阵"): Promise<void> {
  await openLeftTab(page, "hierarchy");
  await page.locator(`[data-testid="object-row"][data-name="${name}"]`).first().click();
  await openInspector(page);
  await expect(page.getByTestId("inspector-object-name")).toHaveValue(name);
}

/** 在「传送目标」窗口里勾 / 取消勾一张场景（窗口必须已经开着）。 */
async function toggleSceneInDialog(page: Page, sceneName: string, on: boolean): Promise<void> {
  const checkbox = page.locator(
    `[data-testid="teleport-scene-row"][data-scene="${sceneName}"] input[type="checkbox"]`,
  );
  if (on) {
    await checkbox.check();
  } else {
    await checkbox.uncheck();
  }
}

/** 属性面板上把「传送到哪一个」点成某一张（再点一次是取消选中）。 */
async function pickSceneChip(page: Page, sceneName: string): Promise<void> {
  await page.locator(`[data-testid="teleport-target-chip"][data-target="${sceneName}"]`).click();
}

test.describe("动作对象：传送阵", () => {
  test("新建 → 窗口里勾目标 → 点「传送」就换台；按一下不改文档，落盘只有 targets/picked", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          mapObjectDoc(project, SCENE, "小图", { width: 400, height: 300 }, { width: 8, height: 6 }),
        ]),
        sceneDoc(OTHER, []),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(400, 300, [0, 255, 0]));

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      await createTeleport(page);

      // 列表：动作种类筛得出来，行尾写它会把 DM 送到哪张图（还没加目标就明说，别留白）
      await expect(page.getByTestId("category-filter-action")).toBeVisible();
      const row = page.locator('[data-testid="object-row"][data-kind="Teleport"]').first();
      await expect(row).toContainText("未加目标");

      // 属性面板：基础和实体一样，另有「传送」；**没有「渲染」**（徽标是固定的，不给换贴图）
      await selectTeleportRow(page);
      await expect(page.locator('[data-group="teleport"]')).toBeVisible();
      await expect(page.locator('[data-group="render"]')).toHaveCount(0);
      await expect(page.getByTestId("inspector-object-x")).toHaveValue("0");

      // 还没加目标：只有「＋」，按钮写「先加目标」且点不动（面板上不另起一行解释）
      await expect(page.getByTestId("teleport-target-chip")).toHaveCount(0);
      const go = page.getByTestId("teleport-go");
      await expect(go).toBeDisabled();
      await expect(go).toHaveText("先加目标");

      // 「＋」窗口：勾上另一张图（勾进来即成为候选，并且默认选中它——与播放声音同一条规矩）
      await page.getByTestId("teleport-edit").click();
      await expect(page.getByTestId("teleport-edit-dialog")).toBeVisible();
      await expect(page.getByTestId("teleport-scene-row")).toHaveCount(2);
      await toggleSceneInDialog(page, OTHER, true);
      await page.getByTestId("teleport-edit-close").click();
      await expect(page.getByTestId("teleport-edit-dialog")).toHaveCount(0);

      // 面板上：候选列成小方块，选中的那一个点着；按钮自己说明「传到哪」
      const chip = page.locator(`[data-testid="teleport-target-chip"][data-target="${OTHER}"]`);
      await expect(chip).toHaveAttribute("data-selected", "true");
      await expect(chip).toHaveAttribute("data-missing", "false");
      await expect(go).toBeEnabled();
      await expect(go).toHaveText("⇢ 传送");

      // 落盘：清单 + 选中的那一个都写进文件
      await expect
        .poll(async () => (await readSceneTeleport(request, project, SCENE))?.targets)
        .toEqual([OTHER]);
      await expect
        .poll(async () => (await readSceneTeleport(request, project, SCENE))?.picked)
        .toBe(OTHER);

      // 按一下 = 换台（按钮在「传送」组里，平板下就是右抽屉，所以别把它关掉）
      await page.getByTestId("teleport-go").click();
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${OTHER}`);
      await expect(page.getByTestId("scene-bar")).toHaveAttribute("data-scene", OTHER);

      // 换台不是编辑：文档一个字节没改（落盘还是按下之前那份）
      expect(await readSceneTeleport(request, project, SCENE)).toEqual({
        targets: [OTHER],
        picked: OTHER,
      });
    } finally {
      await dropProject(request, project);
    }
  });

  test("画布上双击徽标 = 同一个动作（鼠标的快路径）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          mapObjectDoc(project, SCENE, "小图", { width: 400, height: 300 }, { width: 8, height: 6 }),
        ]),
        sceneDoc(OTHER, []),
      ]);
      await uploadSceneImage(request, project, SCENE, solidPng(400, 300, [0, 255, 0]));

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      await createTeleport(page);
      await selectTeleportRow(page);
      await page.getByTestId("teleport-edit").click();
      await expect(page.getByTestId("teleport-edit-dialog")).toBeVisible();
      await toggleSceneInDialog(page, OTHER, true);
      await page.getByTestId("teleport-edit-close").click();
      await expect(page.getByTestId("teleport-edit-dialog")).toHaveCount(0);
      await closeDrawers(page);

      // 徽标就在世界原点（新建对象落在场景正中）：采样确认它画出来了（牌面是青色，棋盘是中性灰）
      const origin = await preciseWorldPoint(page, { x: 0, y: 0 });
      const color = await canvasAverageColor(page, origin, 12);
      expect(color.b - color.r, "传送徽标没画出来（青色牌面的蓝应明显高于红）").toBeGreaterThan(20);

      // 双击它 → 换台
      await page.mouse.dblclick(origin.x, origin.y);
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${OTHER}`);
      await expect(page.getByTestId("scene-bar")).toHaveAttribute("data-scene", OTHER);

      // 双击**普通对象**（地图内部、避开原点那枚徽标）不换台：只有传送阵认双击
      await page.getByTestId("scene-chip").filter({ hasText: SCENE }).click();
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${SCENE}`);
      const onMap = await preciseWorldPoint(page, { x: -150, y: 100 });
      await page.mouse.dblclick(onMap.x, onMap.y);
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${SCENE}`);
    } finally {
      await dropProject(request, project);
    }
  });

  test("目标不合法就点不动：不存在 / 就是当前场景，都写明理由", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 手写两份：一份指向不存在的场景；一份指向自己（当前场景）
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          withComponent(
            gameObjectDoc("死名字", "Teleport", { x: 0, y: 0 }, { id: "teleport_dead" }),
            COMPONENT.teleport,
            { targets: ["Map999"], picked: "Map999" },
          ),
          withComponent(
            gameObjectDoc("自指", "Teleport", { x: 120, y: 0 }, { id: "teleport_self" }),
            COMPONENT.teleport,
            { targets: [SCENE], picked: SCENE },
          ),
        ]),
        sceneDoc(OTHER, []),
      ]);

      await enterEditor(page);
      await openProject(page, project);

      // 目标不存在：小方块标红，按钮直接写「目标已失效」并点不动
      await selectTeleportRow(page, "死名字");
      const dead = page.locator('[data-testid="teleport-target-chip"][data-target="Map999"]');
      await expect(dead).toHaveAttribute("data-missing", "true");
      const go = page.getByTestId("teleport-go");
      await expect(go).toBeDisabled();
      await expect(go).toHaveText("目标已失效");

      // 窗口里也说得明白：它照常列出来并点明「已失效」，在这儿就能取消勾（不会悄悄消失）
      await page.getByTestId("teleport-edit").click();
      await expect(page.getByTestId("teleport-edit-dialog")).toBeVisible();
      const deadRow = page.locator('[data-testid="teleport-scene-row"][data-scene="Map999"]');
      await expect(deadRow).toHaveAttribute("data-checked", "true");
      await expect(deadRow).toContainText("已失效");

      // 把好的那张勾进来：**勾进来只是成为候选**，选中的还卡在那条死名字上（清单 ≠ 选中）
      await toggleSceneInDialog(page, OTHER, true);
      await page.getByTestId("teleport-edit-close").click();
      await expect(go).toBeDisabled();
      await expect(go).toHaveText("目标已失效");

      // 回面板上点活的那个 → 通了
      await pickSceneChip(page, OTHER);
      await expect(go).toBeEnabled();
      await expect(go).toHaveText("⇢ 传送");

      // 目标就是当前场景：同样点不动（按下去什么都不会发生）
      await selectTeleportRow(page, "自指");
      await expect(page.getByTestId("teleport-go")).toBeDisabled();
      await expect(page.getByTestId("teleport-go")).toHaveText("已经在这个场景");
    } finally {
      await dropProject(request, project);
    }
  });
});
