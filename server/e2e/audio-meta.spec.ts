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
 * 1. 资源面板选中一个音频 → 属性面板里就地改**显示名**、**「＋ 标签」**勾标签 → 落进 `project.json`；
 * 2. 标签表在「工程 → 标签…」：新建 / **改名（只改表，文件里的 ID 不动）** / 删除（留洞）；
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

      // 2) 「＋ 标签」→ 选择标签框里现建一个「战斗」：建出 tag #0 并立刻挂上
      await page.getByTestId("asset-audio-add-tag").click();
      await expect(page.getByTestId("audio-tag-dialog")).toBeVisible();
      await page.getByTestId("audio-tag-new").fill("战斗");
      await page.getByTestId("audio-tag-new").press("Enter");
      await page.getByTestId("audio-tag-close").click();
      await expect(page.getByTestId("audio-tag-dialog")).toBeHidden();

      await expect
        .poll(async () => await readProjectAudioTags(request, project), {
          timeout: 8000,
          message: "等待标签表落盘",
        })
        .toEqual(["战斗"]);
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

  test("标签表：新建 / 改名（**只改表**）/ 删除留洞", async ({ page, request }) => {
    const project = await newProject(request);

    try {
      const battle = await uploadAudio(request, project, "battle.wav");
      await seedProjectDoc(request, project, [{ name: SCENE, objects: [] }]);

      await enterEditor(page);
      await openProject(page, project);

      // 1) 建两个标签（ID 按建的先后：#0 战斗、#1 紧张）
      await openAudioTagsDialog(page);
      await expect(page.getByTestId("audio-tag-editor-empty")).toBeVisible();
      await page.getByTestId("audio-tag-editor-new").fill("战斗");
      await page.getByTestId("audio-tag-editor-new").press("Enter");
      await page.getByTestId("audio-tag-editor-new").fill("紧张");
      await page.getByTestId("audio-tag-editor-new").press("Enter");
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
      const nameInput = page.locator('[data-testid="audio-tag-editor-name"][data-id="0"]');
      await nameInput.fill("交战");
      await nameInput.press("Enter");
      await expect
        .poll(async () => (await readProjectAudioTags(request, project))?.[0], {
          timeout: 8000,
          message: "等待改名落盘",
        })
        .toBe("交战");
      // 文件里记的还是那个整数（一个字节都没动）
      expect((await readProjectAudioMeta(request, project))?.[battle]?.tags).toEqual([0]);

      // 4) 删除 #1（没人用）：表里留洞，别的 ID 不位移
      page.once("dialog", (dialog) => void dialog.accept());
      await page.locator('[data-testid="audio-tag-editor-delete"][data-id="1"]').click();
      await expect
        .poll(async () => await readProjectAudioTags(request, project), {
          timeout: 8000,
          message: "等待删除落盘",
        })
        .toEqual(["交战", null]);

      // 5) 新建「追击」：**优先复用那个洞**（回到 #1），不追加 #2
      await page.getByTestId("audio-tag-editor-new").fill("追击");
      await page.getByTestId("audio-tag-editor-new").press("Enter");
      await expect
        .poll(async () => await readProjectAudioTags(request, project), {
          timeout: 8000,
          message: "等待复用洞落盘",
        })
        .toEqual(["交战", "追击"]);

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
