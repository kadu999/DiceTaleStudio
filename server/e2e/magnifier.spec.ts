import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { canvasAverageColor, preciseWorldPoint } from "./helpers/canvas";
import {
  COMPONENT,
  componentDataOf,
  dropProject,
  enterEditor,
  gameObjectDoc,
  newProject,
  openLeftTab,
  openProject,
  readSceneFile,
  sceneDoc,
  seedImageSpriteMeta,
  seedProjectDoc,
  selectObject,
  solidPng,
  uploadSceneImage,
  withComponent,
} from "./helpers/editor";

/**
 * **放大镜**（动作对象，文档 v30 / 协议 v21）。
 *
 * 用户要的是：点开一扇窗，**中间一张大图、下面一排可以选的图**；属性面板里有图片列表（支持精灵）；
 * 前端弹的是「同一扇窗」，只是**没有选择按钮、也没有关闭按钮**——只能由后端来关。
 *
 * 所以这里钉三件事：
 * 1. **图片列表是文档数据**：从精灵素材里挑（可整张可一格）→ 落盘成「素材 GUID + 第几格」；
 * 2. **窗口与前端那扇同形**：中间是当前那张、下面是可选的那些，点一张就换（也写文档）；
 * 3. **开 / 关两条命令**：运行态下「打开窗口 / 关闭画面」下发 `open_magnifier` / `close_magnifier`；
 *    **换图不是命令**——文档一改，整份 `scene_push` 就把新那张带给前端（运行态那条在这里验）。
 */

const SCENE = "Map001";
/** 图集素材：4 列 2 行（`Assets/images/handout.png`）。 */
const SHEET = { columns: 4, rows: 2 } as const;
const GUID = /^[0-9a-f]{32}$/;

const imageId = (project: string): string => `project:${project}/Assets/images/handout.png`;

/** 一个放大镜（动作对象），`images` / `picked` 由夹具给。 */
function magnifierDoc(
  images: readonly Record<string, unknown>[] = [],
  picked?: number,
): Record<string, unknown> {
  return withComponent(
    gameObjectDoc("放大镜", "Magnifier", { x: 0, y: 0 }, { id: "magnifier_1" }),
    COMPONENT.magnifier,
    { images, ...(picked === undefined ? {} : { picked }) } as Record<string, unknown>,
  );
}

/** 场景文件里那个对象的放大镜数据（没有就抛）。 */
async function magnifierData(
  request: APIRequestContext,
  project: string,
  objectId: string,
): Promise<Record<string, unknown>> {
  const file = await readSceneFile(request, project, SCENE);
  const data = componentDataOf(file, { objectId }, COMPONENT.magnifier);
  if (data === undefined) {
    throw new Error("场景文件里没有放大镜组件");
  }

  return data as Record<string, unknown>;
}

/** 打开编辑器、打开项目、选中这个放大镜。 */
async function openMagnifier(page: Page, project: string): Promise<void> {
  await enterEditor(page);
  await openProject(page, project);
  await openLeftTab(page, "hierarchy");
  await selectObject(page, 0);
  await expect(page.getByTestId("inspector-object-name")).toHaveValue("放大镜");
}

// ---------------------------------------------------------------- 编辑态：面板 + 窗口

test.describe("放大镜：属性面板 + 那扇窗", () => {
  test("属性面板：＋ 挑一张精灵（取一格）→ 落盘成「GUID + 第几格」并自动选中", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await uploadSceneImage(request, project, "handout", solidPng(64, 64, [200, 120, 40]));
      // 放大镜的选图框只列**精灵**素材（与精灵对象挑图同一档）：没有 `.meta` 的图默认是
      // `Default`、根本不出现在列表里——所以先把这份 meta 写成精灵（4×2）
      await seedImageSpriteMeta(request, imageId(project), { mode: "Multiple", sheet: SHEET });
      await seedProjectDoc(request, project, [sceneDoc(SCENE, [magnifierDoc()])]);
      await openMagnifier(page, project);

      const group = page.locator('[data-group="magnifier"]');
      await expect(group.getByTestId("magnifier-empty")).toBeVisible();
      await expect(group.getByTestId("magnifier-close-window")).toHaveCount(0);
      // 编辑态：只有窗口预览（进运行态才投到前端）
      await expect(group.getByTestId("magnifier-window-state")).toContainText("编辑态只有窗口预览");

      // ＋ → 通用选图框（精灵那一档：可以整张，也可以取一格）
      await group.getByTestId("magnifier-add").click();
      const picker = page.getByTestId("image-picker-dialog");
      await expect(picker).toBeVisible();
      // 先选那一行，右边的切分面板才出来（与精灵对象挑图是同一条路）
      await picker
        .locator(`[data-testid="image-picker-item"][data-asset-id="${imageId(project)}"]`)
        .click();
      await expect(page.getByTestId("image-picker-sprite")).toHaveCount(SHEET.columns * SHEET.rows);
      await page.locator('[data-testid="image-picker-sprite"][data-sprite="1,0"]').click();
      await page.getByTestId("image-picker-confirm").click();
      await expect(picker).toHaveCount(0);

      // 落盘：**素材 GUID + 第几格**（路径 ID 只在内存里），并且自动选中第一条
      await expect
        .poll(async () => {
          const data = await magnifierData(request, project, "magnifier_1");
          const images = data["images"] as readonly Record<string, unknown>[] | undefined;
          const first = images?.[0];
          const sprite = first?.["sprite"] as
            | { readonly column?: number; readonly row?: number }
            | undefined;
          return {
            count: images?.length,
            picked: data["picked"],
            idIsGuid: typeof first?.["id"] === "string" && GUID.test(String(first["id"])),
            sprite: { column: sprite?.column, row: sprite?.row },
          };
        })
        .toEqual({ count: 1, picked: 0, idIsGuid: true, sprite: { column: 1, row: 0 } });

      // 面板上那一条是选中的（前端窗里放的就是它）
      const chip = group.getByTestId("magnifier-image");
      await expect(chip).toHaveCount(1);
      await expect(chip).toHaveAttribute("data-selected", "true");

      // 点一下（已选中的）= 取消展示：面板上不再有选中的那条
      await group.getByTestId("magnifier-image-pick").click();
      await expect(chip).toHaveAttribute("data-selected", "false");
      await expect
        .poll(async () => (await magnifierData(request, project, "magnifier_1"))["picked"])
        .toBeUndefined();
    } finally {
      await dropProject(request, project);
    }
  });

  test("窗口：中间是当前那张、下面那排点一下就换（写文档、可撤销）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await uploadSceneImage(request, project, "handout", solidPng(64, 64, [200, 120, 40]));
      await seedImageSpriteMeta(request, imageId(project), { mode: "Multiple", sheet: SHEET });
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          magnifierDoc(
            [
              { id: imageId(project), width: 64, height: 64 },
              { id: imageId(project), width: 16, height: 32, sprite: { column: 1, row: 0 } },
            ],
            0,
          ),
        ]),
      ]);
      await openMagnifier(page, project);

      const group = page.locator('[data-group="magnifier"]');
      await group.getByTestId("magnifier-open").click();

      const dialog = page.getByTestId("magnifier-dialog");
      await expect(dialog).toBeVisible();
      // 中间：当前那张（舞台）；下面：**可以选择的图片**
      await expect(dialog.getByTestId("magnifier-stage")).toBeVisible();
      const picks = dialog.getByTestId("magnifier-pick");
      await expect(picks).toHaveCount(2);
      await expect(picks.nth(0)).toHaveAttribute("data-selected", "true");

      // 编辑态只是预览：底栏「在画面上打开」点不了
      await expect(dialog.getByTestId("magnifier-show")).toBeDisabled();
      await expect(dialog.getByTestId("magnifier-dialog-state")).toContainText("编辑态只是预览");

      // 点下面第二张 → 换成展示它（写文档）
      await picks.nth(1).click();
      await expect
        .poll(async () => (await magnifierData(request, project, "magnifier_1"))["picked"])
        .toBe(1);
      await expect(dialog.getByTestId("magnifier-pick").nth(1)).toHaveAttribute("data-selected", "true");

      // 撤销回到第一张（换图是文档数据，进撤销栈）
      await page.keyboard.press("Control+z");
      await expect
        .poll(async () => (await magnifierData(request, project, "magnifier_1"))["picked"])
        .toBe(0);

      // 关掉编辑器这扇窗（前端那扇不受影响——那是「关闭画面」的事）
      await page.getByTestId("magnifier-close").click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("画布上双击徽标 = 打开窗口（鼠标的快路径）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await uploadSceneImage(request, project, "handout", solidPng(64, 64, [200, 120, 40]));
      await seedImageSpriteMeta(request, imageId(project), { mode: "Multiple", sheet: SHEET });
      // 手写一条已经选好的（省掉挑图那一步：双击那条路本身才是这里要验的）
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          magnifierDoc([{ id: imageId(project), width: 16, height: 32, sprite: { column: 1, row: 0 } }], 0),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 徽标画在世界原点（新建对象落在场景正中）：采样确认它画出来了（牌面暖黄，棋盘是中性灰）
      const origin = await preciseWorldPoint(page, { x: 0, y: 0 });
      const color = await canvasAverageColor(page, origin, 12);
      expect(color.r - color.b, "放大镜徽标没画出来（暖黄牌面的红应明显高于蓝）").toBeGreaterThan(20);

      await page.mouse.dblclick(origin.x, origin.y);
      await expect(page.getByTestId("magnifier-dialog")).toBeVisible();
      await expect(page.getByTestId("magnifier-stage")).toBeVisible();
    } finally {
      await dropProject(request, project);
    }
  });
});

// ---------------------------------------------------------------- 运行态：开 / 关两条命令

interface FakeCommand {
  readonly kind?: string;
  readonly objectId?: string;
}

interface FakeClientWindow {
  __magnifierCommands?: FakeCommand[];
  __magnifierScene?: Record<string, unknown> | null;
  __magnifierSocket?: WebSocket;
}

/** 运行态全是全局状态（只有一个座位能连），非桌面档位跳过。 */
function skipOutsideDesktop(testInfo: TestInfo): void {
  test.skip(
    !testInfo.project.name.startsWith("desktop"),
    "运行态是全屏状态、只有一个座位能连，桌面档位跑就够了",
  );
}

/** 在页面里开一个**假前端**：收命令、记最后一份场景，都按协议回执。 */
async function connectFakeClient(page: Page, port: number): Promise<void> {
  await page.evaluate((clientPort) => {
    const scope = window as unknown as FakeClientWindow;
    scope.__magnifierCommands = [];
    scope.__magnifierScene = null;

    const socket = new WebSocket(`ws://127.0.0.1:${clientPort}/client`);
    scope.__magnifierSocket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "client_hello",
          // 与 `@dts/protocol` 的 `PROTOCOL_VERSION` 一致（照抄字面量：e2e 不 import workspace 包，
          // 那个常量不会被类型检查兜住，见 CODE-STRUCTURE 的「复述常量」一节）
          protocolVersion: 21,
          name: "e2e 假前端",
          version: "0.0.0",
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      const parsed = JSON.parse(String(event.data)) as {
        type?: string;
        requestId?: string;
        command?: FakeCommand;
        scene?: Record<string, unknown> | null;
      };

      if (parsed.type === "scene_sync") {
        scope.__magnifierScene = parsed.scene ?? null;
        return;
      }

      if (parsed.type === "command") {
        scope.__magnifierCommands?.push(parsed.command ?? {});
        socket.send(
          JSON.stringify({
            type: "command_result",
            requestId: parsed.requestId,
            ok: true,
            effects: ["e2e 假前端收到命令"],
          }),
        );
      }
    });
  }, port);
}

async function fakeCommands(page: Page): Promise<readonly FakeCommand[]> {
  return page.evaluate(() => (window as unknown as FakeClientWindow).__magnifierCommands ?? []);
}

/** 假前端手上那份场景里，这个放大镜的 `picked`（还没收到场景时 `undefined`）。 */
async function fakePicked(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const scene = (window as unknown as FakeClientWindow).__magnifierScene;
    const objects = (scene?.["objects"] ?? []) as readonly Record<string, unknown>[];
    const object = objects.find((item) => item["id"] === "magnifier_1");
    const components = (object?.["components"] ?? []) as readonly Record<string, unknown>[];
    const magnifier = components.find((item) => item["type"] === "Magnifier");
    return (magnifier?.["data"] as Record<string, unknown> | undefined)?.["picked"];
  });
}

test.describe("放大镜：开 / 关两条命令 + 换图靠整份场景", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("「打开窗口 / 关闭画面」下发 open_magnifier / close_magnifier；换图走 scene_push", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      await uploadSceneImage(request, project, "handout", solidPng(64, 64, [200, 120, 40]));
      await seedImageSpriteMeta(request, imageId(project), { mode: "Multiple", sheet: SHEET });
      // 两条图（第一条整张、第二条取一格）：下面那排点一下就换
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          magnifierDoc(
            [
              { id: imageId(project), width: 64, height: 64 },
              { id: imageId(project), width: 16, height: 32, sprite: { column: 1, row: 0 } },
            ],
            0,
          ),
        ]),
      ]);

      await openMagnifier(page, project);
      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");
      await connectFakeClient(page, port);
      await page.waitForFunction(() => (window as unknown as FakeClientWindow).__magnifierScene !== null);
      await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

      const group = page.locator('[data-group="magnifier"]');
      const dialog = page.getByTestId("magnifier-dialog");

      // 打开那扇窗 → open_magnifier（只带 objectId：放哪一张从镜像里读）
      await group.getByTestId("magnifier-open").click();
      await expect(dialog).toBeVisible();
      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "open_magnifier").length)
        .toBe(1);

      const opened = (await fakeCommands(page)).find((item) => item.kind === "open_magnifier");
      expect(opened?.objectId).toBe("magnifier_1");

      // 换图**不是命令**：文档一改，整份场景推下去，假前端那边的 picked 跟着变
      await expect.poll(async () => fakePicked(page)).toBe(0);
      await dialog.getByTestId("magnifier-pick").nth(1).click();
      await expect.poll(async () => fakePicked(page)).toBe(1);
      expect((await fakeCommands(page)).filter((item) => item.kind !== "open_magnifier")).toEqual([]);

      // 关闭画面 → close_magnifier（带 objectId 认领）；用底栏那一枚（窗口开着时面板在遮罩后面）
      await dialog.getByTestId("magnifier-hide").click();
      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "close_magnifier").length)
        .toBe(1);
      const closed = (await fakeCommands(page)).find((item) => item.kind === "close_magnifier");
      expect(closed?.objectId).toBe("magnifier_1");
    } finally {
      await dropProject(request, project);
    }
  });
});
