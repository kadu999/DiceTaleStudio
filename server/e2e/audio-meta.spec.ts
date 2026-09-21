import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  dropProject,
  enterEditor,
  newProject,
  openLeftTab,
  openMenu,
  openProject,
  readProjectAudioMeta,
  readProjectAudioTags,
  seedProjectDoc,
} from "./helpers/editor";

/**
 * **音频标注**（v17 / v18）：显示名 + **整数标签**，**都在属性面板里改**。
 *
 * v18 把那个「音频文件」列表窗口删掉了——「选中哪个就改哪个」本来就是这个面板的用法，
 * 多一个窗口只是让人多跳一次。标签学 Unity：**tag 是个整数**（`audioTags` 的下标），
 * 名字住在表里，音频文件只记 ID。所以这一份钉住：
 * 1. 资源面板选中一个音频 → 属性面板里就地改**显示名**、右下角那个 **「＋」** 勾标签 → 落进 `project.json`；
 * 2. 标签表在「工程 → 标签…」：**序号预先列好，只填名字**（改名字只改表，文件里的 ID 不动；没有新建 / 删除）；
 * 3. 行上 chip 的 `×` 只从这个文件上摘掉，标签本身还在表里；撤销能把他们一起还原。
 */

const SCENE = "Map001";

/** 把一段假音频提交到 `Assets/audio/`。 */
async function uploadAudio(
  request: APIRequestContext,
  project: string,
  name: string,
  folder = "audio",
): Promise<string> {
  const id = `project:${project}/Assets/${folder}/${name}`;
  const response = await request.put(`/api/resources/raw?id=${encodeURIComponent(id)}`, {
    headers: { "content-type": "audio/mpeg" },
    data: Buffer.from(`not-really-audio:${name}`),
  });
  expect(response.ok()).toBeTruthy();
  return id;
}

/** 在资源面板里选中 `Assets/audio/` 下的某个文件（平板档位下顺便把属性抽屉唤出来）。 */
async function selectAudioAsset(page: Page, fileName: string): Promise<void> {
  await openLeftTab(page, "assets");
  const rows = page.getByTestId("folder-content-row");
  await rows.filter({ hasText: "audio" }).first().click();
  await rows.filter({ hasText: fileName }).first().click();

  if (!(await page.getByTestId("asset-properties").isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "属性", exact: true }).click();
  }

  await expect(page.getByTestId("asset-properties")).toBeVisible();
}

async function openAudioTagsDialog(page: Page): Promise<void> {
  if (!(await page.getByTestId("audio-tag-editor").isVisible().catch(() => false))) {
    await openMenu(page, "工程");
    await page.getByRole("menuitem", { name: /^标签/ }).click();
  }

  await expect(page.getByTestId("audio-tag-editor")).toBeVisible();
}

async function closeAudioTagsDialog(page: Page): Promise<void> {
  if (await page.getByTestId("audio-tag-editor").isVisible().catch(() => false)) {
    await page.getByTestId("audio-tag-editor-close").click();
    await expect(page.getByTestId("audio-tag-editor")).toBeHidden();
  }
}

test.describe("音频标注：在属性面板里改", () => {
  test("显示名 + 新标签 + 摘标签：全部落进 project.json，撤销能回去", async ({ page, request }) => {
    const project = await newProject(request);

    try {
      const battle = await uploadAudio(request, project, "battle.wav");
      await uploadAudio(request, project, "theme.mp3");
      await seedProjectDoc(request, project, [{ name: SCENE, objects: [] }]);

      await enterEditor(page);
      await openProject(page, project);

      // 一开始没有任何标注（不补空壳）
      expect(await readProjectAudioMeta(request, project)).toBeUndefined();
      expect(await readProjectAudioTags(request, project)).toBeUndefined();

      await selectAudioAsset(page, "battle");

      // 名称那一行仍是**真实文件名**（面板同时要回答「这是盘上的哪个文件」）
      await expect(page.getByTestId("asset-properties")).toContainText("battle.wav");
      await expect(page.getByTestId("asset-audio-tags")).toContainText("没有标签");

      // 1) 显示名就地改
      await page.getByTestId("asset-audio-name").fill("战斗曲");
      await page.getByTestId("asset-audio-name").press("Enter");

      await expect
        .poll(async () => (await readProjectAudioMeta(request, project))?.[battle]?.name, {
          timeout: 8000,
          message: "等待显示名落盘",
        })
        .toBe("战斗曲");

      // 2) 先在「标签」窗口给 #0 起名「战斗」，再回属性面板的「＋」里把它勾上
      await openAudioTagsDialog(page);
      await page.locator('[data-testid="audio-tag-editor-name"][data-id="0"]').fill("战斗");
      await page.locator('[data-testid="audio-tag-editor-name"][data-id="0"]').press("Enter");
      await expect
        .poll(async () => await readProjectAudioTags(request, project), {
          timeout: 8000,
          message: "等待标签表落盘",
        })
        .toEqual(["战斗"]);
      await closeAudioTagsDialog(page);

      await page.getByTestId("asset-audio-add-tag").click();
      await expect(page.getByTestId("audio-tag-dialog")).toBeVisible();
      // 选择标签框里**没有新建入口**：只从已有的标签里勾
      await expect(page.getByTestId("audio-tag-new")).toHaveCount(0);
      await page.locator('[data-testid="audio-tag-toggle"][data-id="0"]').click();
      await page.getByTestId("audio-tag-close").click();
      await expect(page.getByTestId("audio-tag-dialog")).toBeHidden();

      await expect
        .poll(async () => (await readProjectAudioMeta(request, project))?.[battle]?.tags, {
          timeout: 8000,
          message: "等待标签引用落盘",
        })
        .toEqual([0]);

      // 属性面板上按**名字**显示那个 tag
      await expect(page.locator('[data-testid="asset-audio-tag"][data-id="0"]')).toContainText(
        "战斗",
      );

      // 3) chip 上的 × = 只从这个文件上摘掉；标签本身还在表里
      await page.locator('[data-testid="asset-audio-tag-remove"][data-id="0"]').click();
      await expect
        .poll(async () => (await readProjectAudioMeta(request, project))?.[battle]?.tags, {
          timeout: 8000,
          message: "等待摘标签落盘",
        })
        .toBeUndefined();
      expect(await readProjectAudioTags(request, project)).toEqual(["战斗"]);

      // 4) 撤销：把引用拿回来
      await page.keyboard.press("Control+z");
      await expect
        .poll(async () => (await readProjectAudioMeta(request, project))?.[battle]?.tags, {
          timeout: 8000,
          message: "等待撤销落盘",
        })
        .toEqual([0]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("标签表：序号预先列好，只填名字（只改表，没有新建 / 删除）", async ({ page, request }) => {
    const project = await newProject(request);

    try {
      const battle = await uploadAudio(request, project, "battle.wav");
      await seedProjectDoc(request, project, [{ name: SCENE, objects: [] }]);

      await enterEditor(page);
      await openProject(page, project);

      // 1) 序号一开始就铺好了（#0…#15），没有任何「新建」入口——往格子里填名字就行
      await openAudioTagsDialog(page);
      await expect(page.getByTestId("audio-tag-editor-new")).toHaveCount(0);
      await expect(page.getByTestId("audio-tag-editor-delete")).toHaveCount(0);
      await expect(page.getByTestId("audio-tag-editor-name")).toHaveCount(16);

      const tagName = (id: number) =>
        page.locator(`[data-testid="audio-tag-editor-name"][data-id="${id}"]`);

      // #0 战斗、#1 紧张：序号就是 ID
      await tagName(0).fill("战斗");
      await tagName(0).press("Enter");
      await tagName(1).fill("紧张");
      await tagName(1).press("Enter");
      await expect
        .poll(async () => await readProjectAudioTags(request, project), {
          timeout: 8000,
          message: "等待标签表落盘",
        })
        .toEqual(["战斗", "紧张"]);
      await closeAudioTagsDialog(page);

      // 2) 在属性面板里给 battle 勾上 #0
      await selectAudioAsset(page, "battle");
      await page.getByTestId("asset-audio-add-tag").click();
      await page.locator('[data-testid="audio-tag-toggle"][data-id="0"]').click();
      await page.getByTestId("audio-tag-close").click();
      await expect
        .poll(async () => (await readProjectAudioMeta(request, project))?.[battle]?.tags, {
          timeout: 8000,
          message: "等待引用落盘",
        })
        .toEqual([0]);

      // 3) **改名只改表**：#0「战斗」→「交战」
      await openAudioTagsDialog(page);
      await tagName(0).fill("交战");
      await tagName(0).press("Enter");
      await expect
        .poll(async () => (await readProjectAudioTags(request, project))?.[0], {
          timeout: 8000,
          message: "等待改名落盘",
        })
        .toBe("交战");
      // 文件里记的还是那个整数（一个字节都没动）
      expect((await readProjectAudioMeta(request, project))?.[battle]?.tags).toEqual([0]);

      // 4) 换个序号填名字：那个序号就是它的 ID
      await tagName(1).fill("追击");
      await tagName(1).press("Enter");
      await expect
        .poll(async () => await readProjectAudioTags(request, project), {
          timeout: 8000,
          message: "等待改名落盘",
        })
        .toEqual(["交战", "追击"]);

      // 5) 空格子没填名字就不会写进数据（打开窗口看一眼不会改任何东西）
      expect((await readProjectAudioTags(request, project))?.length).toBe(2);

      await closeAudioTagsDialog(page);

      // 属性面板上那条 chip 也跟着显示新名字（改的是表，文件没动）
      await expect(page.locator('[data-testid="asset-audio-tag"][data-id="0"]')).toContainText(
        "交战",
      );
    } finally {
      await dropProject(request, project);
    }
  });
});
