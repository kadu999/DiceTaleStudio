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
 * **放大镜**（动作对象，文档 v31 / 协议 v22）。
 *
 * 用户要的是：点开一扇窗，里面是**一屏画面**——上面标题、左边一张图、右边一段文字；
 * 下面一排**状态槽**（点一个 = 换成展示它），末尾「添加状态」加空槽，**填内容都在窗口里做**
 * （属性面板那边整行搬走了，只剩「窗口」那一行）。前端弹的是「同一扇窗」，只是
 * **没有状态槽、没有添加、也没有关闭按钮**——只能由后端来关。
 *
 * 所以这里钉四件事：
 * 1. **状态列表是文档数据**：加状态 / 挑图（可整张可一格）/ 写标题与文字 → 都落盘；
 * 2. **窗口与前端那扇同形**：上面是选中状态那一屏、下面是状态槽，点一个就换（也写文档）；
 * 3. **开 / 关两条命令**：运行态下「打开窗口 / 关闭画面」下发 `open_magnifier` / `close_magnifier`；
 *    **换状态 / 换图 / 改字都不是命令**——文档一改，整份 `scene_push` 就把新值带给前端；
 * 4. **属性面板不再有「图片」那一行**（搬进窗口了）。
 */

const SCENE = "Map001";
/** 图集素材：4 列 2 行（`Assets/images/handout.png`）。 */
const SHEET = { columns: 4, rows: 2 } as const;
const GUID = /^[0-9a-f]{32}$/;

const imageId = (project: string): string => `project:${project}/Assets/images/handout.png`;

/** 一个放大镜（动作对象），`states` / `picked` 由夹具给。 */
function magnifierDoc(
  states: readonly Record<string, unknown>[] = [],
  picked?: number,
): Record<string, unknown> {
  return withComponent(
    gameObjectDoc("放大镜", "Magnifier", { x: 0, y: 0 }, { id: "magnifier_1" }),
    COMPONENT.magnifier,
    { states, ...(picked === undefined ? {} : { picked }) } as Record<string, unknown>,
  );
}

/** 一个「只有图」的状态（最常见的形状）。 */
function imageState(image: Record<string, unknown>): Record<string, unknown> {
  return { image };
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

// ---------------------------------------------------------------- 编辑态：窗口里加状态 / 填内容

test.describe("放大镜：窗口里加状态 + 填内容", () => {
  test("「添加状态」→ 上面挑一张精灵（取一格）→ 落盘成「GUID + 第几格」", async ({
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

      // 属性面板只剩「窗口」那一行，而且只有一个「打开窗口」按钮：
      // 没有「图片」列表 / ＋，也没有「关闭画面」与状态说明文字
      const group = page.locator('[data-group="magnifier"]');
      await expect(group.getByTestId("magnifier-window")).toBeVisible();
      await expect(group.getByTestId("magnifier-open")).toBeVisible();
      await expect(group.getByTestId("magnifier-images")).toHaveCount(0);
      await expect(group.getByTestId("magnifier-add")).toHaveCount(0);
      await expect(group.getByTestId("magnifier-close-window")).toHaveCount(0);
      await expect(group.getByTestId("magnifier-window-state")).toHaveCount(0);

      // 打开那扇窗：一个状态都没有，上面写「还没有状态」
      await group.getByTestId("magnifier-open").click();
      const dialog = page.getByTestId("magnifier-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("magnifier-stage-empty")).toContainText("还没有状态");
      await expect(dialog.getByTestId("magnifier-state")).toHaveCount(0);

      // 「添加状态」→ 加一个空槽并选中它（上面那块换成「点这里挑一张图」）
      await dialog.getByTestId("magnifier-add-state").click();
      await expect(dialog.getByTestId("magnifier-state")).toHaveCount(1);
      await expect(dialog.getByTestId("magnifier-state").nth(0)).toHaveAttribute(
        "data-selected",
        "true",
      );
      await expect(dialog.getByTestId("magnifier-state-blank")).toHaveCount(1);
      await expect(dialog.getByTestId("magnifier-image-empty")).toBeVisible();

      // 点图那块 → 通用选图框（精灵那一档：可以整张，也可以取一格）
      await dialog.getByTestId("magnifier-image-pick").click();
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

      // 落盘：**素材 GUID + 第几格**（路径 ID 只在内存里），状态槽上出现缩略图
      await expect
        .poll(async () => {
          const data = await magnifierData(request, project, "magnifier_1");
          const states = data["states"] as readonly Record<string, unknown>[] | undefined;
          const image = states?.[0]?.["image"] as Record<string, unknown> | undefined;
          const sprite = image?.["sprite"] as
            | { readonly column?: number; readonly row?: number }
            | undefined;
          return {
            count: states?.length,
            picked: data["picked"],
            idIsGuid: typeof image?.["id"] === "string" && GUID.test(String(image["id"])),
            sprite: { column: sprite?.column, row: sprite?.row },
          };
        })
        .toEqual({ count: 1, picked: 0, idIsGuid: true, sprite: { column: 1, row: 0 } });

      // 上面那块换成舞台（就是刚才挑的那一格），空槽占位没了
      await expect(dialog.getByTestId("magnifier-stage")).toBeVisible();
      await expect(dialog.getByTestId("magnifier-state-blank")).toHaveCount(0);

      // 右上角 × 把图移出（状态还在，只是没图了）
      await dialog.getByTestId("magnifier-image-clear").click();
      await expect(dialog.getByTestId("magnifier-image-empty")).toBeVisible();
      await expect
        .poll(async () => {
          const data = await magnifierData(request, project, "magnifier_1");
          const states = data["states"] as readonly Record<string, unknown>[] | undefined;
          return { count: states?.length, image: states?.[0]?.["image"] };
        })
        .toEqual({ count: 1, image: undefined });
    } finally {
      await dropProject(request, project);
    }
  });

  test("窗口：上面是选中状态那一屏（标题 / 图 / 文字），下面点一个槽就换（写文档、可撤销）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await uploadSceneImage(request, project, "handout", solidPng(64, 64, [200, 120, 40]));
      await seedImageSpriteMeta(request, imageId(project), { mode: "Multiple", sheet: SHEET });
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          magnifierDoc(
            [
              imageState({ id: imageId(project), width: 64, height: 64 }),
              {
                title: "线索二",
                image: { id: imageId(project), width: 16, height: 32, sprite: { column: 1, row: 0 } },
                text: "第一行\n第二行",
              },
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
      // 上面：当前那一屏（舞台）；下面：**状态槽**
      await expect(dialog.getByTestId("magnifier-stage")).toBeVisible();
      const slots = dialog.getByTestId("magnifier-state");
      await expect(slots).toHaveCount(2);
      await expect(slots.nth(0)).toHaveAttribute("data-selected", "true");
      // 第一个状态没有标题：输入框是空的
      await expect(dialog.getByTestId("magnifier-title")).toHaveValue("");

      // 编辑器窗底栏**没有**「在画面上打开 / 关闭画面 / 状态提示」：开关就是这扇窗本身
      await expect(dialog.getByTestId("magnifier-show")).toHaveCount(0);
      await expect(dialog.getByTestId("magnifier-hide")).toHaveCount(0);
      await expect(dialog.getByTestId("magnifier-dialog-state")).toHaveCount(0);

      // 点下面第二个槽 → 换成展示它（写文档），上面那块换成它的标题 / 图 / 文字
      await slots.nth(1).click();
      await expect
        .poll(async () => (await magnifierData(request, project, "magnifier_1"))["picked"])
        .toBe(1);
      await expect(dialog.getByTestId("magnifier-state").nth(1)).toHaveAttribute("data-selected", "true");
      await expect(dialog.getByTestId("magnifier-title")).toHaveValue("线索二");
      await expect(dialog.getByTestId("magnifier-text")).toHaveValue("第一行\n第二行");

      // 撤销回到第一个（换状态是文档数据，进撤销栈）
      await page.keyboard.press("Control+z");
      await expect
        .poll(async () => (await magnifierData(request, project, "magnifier_1"))["picked"])
        .toBe(0);

      // 写标题与文字：失焦时落盘（多行照原样）
      await dialog.getByTestId("magnifier-title").fill("线索一");
      await dialog.getByTestId("magnifier-title").blur();
      await dialog.getByTestId("magnifier-text").fill("甲\n乙");
      await dialog.getByTestId("magnifier-text").blur();
      await expect
        .poll(async () => {
          const data = await magnifierData(request, project, "magnifier_1");
          const states = data["states"] as readonly Record<string, unknown>[] | undefined;
          return { title: states?.[0]?.["title"], text: states?.[0]?.["text"] };
        })
        .toEqual({ title: "线索一", text: "甲\n乙" });

      // 关掉编辑器这扇窗：运行态下前端那扇也跟着收（这条用例是编辑态，没有前端）
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
          magnifierDoc(
            [imageState({ id: imageId(project), width: 16, height: 32, sprite: { column: 1, row: 0 } })],
            0,
          ),
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
          protocolVersion: 25,
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

test.describe("放大镜：开 / 关两条命令 + 换状态靠整份场景", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("打开编辑器窗 = open_magnifier、关掉 = close_magnifier；换状态走 scene_push", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      await uploadSceneImage(request, project, "handout", solidPng(64, 64, [200, 120, 40]));
      await seedImageSpriteMeta(request, imageId(project), { mode: "Multiple", sheet: SHEET });
      // 两个状态（第二个还带标题与文字）：下面那排点一下就换
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          magnifierDoc(
            [
              imageState({ id: imageId(project), width: 64, height: 64 }),
              {
                title: "线索二",
                image: { id: imageId(project), width: 16, height: 32, sprite: { column: 1, row: 0 } },
                text: "第一行\n第二行",
              },
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

      // 打开那扇窗 → open_magnifier（只带 objectId：放哪一屏从镜像里读）
      await group.getByTestId("magnifier-open").click();
      await expect(dialog).toBeVisible();
      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "open_magnifier").length)
        .toBe(1);

      const opened = (await fakeCommands(page)).find((item) => item.kind === "open_magnifier");
      expect(opened?.objectId).toBe("magnifier_1");

      // 换状态**不是命令**：文档一改，整份场景推下去，假前端那边的 picked 跟着变
      await expect.poll(async () => fakePicked(page)).toBe(0);
      await dialog.getByTestId("magnifier-state").nth(1).click();
      await expect.poll(async () => fakePicked(page)).toBe(1);
      expect((await fakeCommands(page)).filter((item) => item.kind !== "open_magnifier")).toEqual([]);

      // 关掉编辑器这扇窗 = 前端那扇跟着收：close_magnifier（带 objectId 认领）
      await page.getByTestId("magnifier-close").click();
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
