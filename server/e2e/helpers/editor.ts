import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * E2E 公共操作。
 *
 * 编辑器启动时会跑一次**启动引导**：自动打开上次的项目 / 一个项目都没有时弹「新建项目」/
 * 有项目但没记录时弹「打开项目」列表。所以用例入口统一走 `gotoEditor`，先等引导跑完
 * （`data-bootstrapped="true"`），否则启动对话框可能在点击中途冒出来把点击吃掉。
 */

export type LeftTab = "assets" | "hierarchy";

/**
 * 场景文件的当前格式版本。
 *
 * **必须与 `@dts/document` 的 `DOCUMENT_FORMAT_VERSION` 一起改**：e2e 不引用内部包
 * （见 `scene-transform.spec.ts` 顶部那条分工说明），所以这里是**复述**——
 * 升级场景格式时忘了改这一处，`hierarchy` / `scene-menu` 里那几条「旧文件自动回写」
 * 的用例会立刻指出来。
 *
 * 要有意制造「旧版本文件」时别用它：自己写那个版本号（`formatVersion: 4` 之类），
 * 并预期编辑器会把它升上来回写一次。
 */
export const CURRENT_SCENE_FORMAT_VERSION = 24;

/**
 * **承载对象特性的组件类型名**（v19 起特性住在 `object.components[]` 里）。
 *
 * | 旧扁平字段（v18 及更早） | 组件 `type` |
 * |---|---|
 * | `object.map` | `gridMap` |
 * | `object.image` | `imageLayer`（贴图）/ `spriteLayer`（精灵）——v21 起拆成两种 |
 * | `object.sound` | `playSound` |
 * | `object.teleport` | `teleport` |
 * | `object.video` | `videoOverlay` |
 *
 * 与 `@dts/document` 的 `DEFAULT_SLOT_COMPONENT` 一致（e2e 不引用内部包，所以这里是**复述**）；
 * 组件名只在 helpers 里写这一份，spec 不该再散落字符串字面量。
 */
export const COMPONENT = {
  gridMap: "GridMap",
  /** 对象自己那张图：**贴图对象**用它（整张铺满）。 */
  imageLayer: "ImageLayer",
  /** 对象自己那张图：**精灵对象**用它（会取图集里的一格）。 */
  spriteLayer: "SpriteLayer",
  playSound: "PlaySound",
  teleport: "Teleport",
  videoOverlay: "VideoOverlay",
} as const;

/** 场景文件（或内存里的场景文档）的形状：只声明 e2e 真正会读的字段。 */
export interface SceneFileLike {
  readonly formatVersion?: number;
  readonly objects?: readonly Record<string, unknown>[];
}

/** 组件实例 id 的约定：`<对象 id>__<组件类型>`（与 `@dts/document` 的 `componentId` 一致）。 */
export function componentId(objectId: string, component: string): string {
  return `${objectId}__${component}`;
}

/** 按 `id` / `kind` 在场景文件里找一个对象（两个条件都给时都要满足）。 */
export function findGameObject(
  file: SceneFileLike | undefined,
  selector: { readonly objectId?: string; readonly kind?: string },
): Record<string, unknown> | undefined {
  return file?.objects?.find((object) => {
    if (selector.objectId !== undefined && object.id !== selector.objectId) {
      return false;
    }

    return selector.kind === undefined || object.kind === selector.kind;
  });
}

/** 某个对象身上的组件实例（v19 起特性住在 `components[]` 里；没有实例就是 `undefined`）。 */
export function componentInstanceOf(
  object: Record<string, unknown> | undefined,
  component: string,
): Record<string, unknown> | undefined {
  const components = object?.["components"];
  if (!Array.isArray(components)) {
    return undefined;
  }

  return components.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && item["type"] === component,
  );
}

/**
 * 某个对象身上的组件**数据**（`undefined` = 这个对象没有这个组件）。
 *
 * 返回的是那一份**活引用**：造夹具的用例可以直接改它（例如换掉地图的 `cells`）。
 */
export function objectComponentData(
  object: Record<string, unknown> | undefined,
  component: string,
): Record<string, unknown> | undefined {
  const data = componentInstanceOf(object, component)?.["data"];
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

/**
 * 取某个对象的某个组件的数据（v19 起特性住在 `components` 里）。
 *
 * 两种找法都在用，且都只认**显式声明的条件**：
 * - 按 `kind`：地图 / 声音 / 传送阵这种「一种类型一个对象」的场景；
 * - 按 `objectId`：同一个 kind 在场景里有多个、要指名道姓的时候。
 */
export function componentDataOf(
  file: SceneFileLike | undefined,
  objectIdOrKind: { readonly objectId?: string; readonly kind?: string },
  component: string,
): Record<string, unknown> | undefined {
  return objectComponentData(findGameObject(file, objectIdOrKind), component);
}

/**
 * 给一个场景对象**挂上**一个组件实例（造夹具用；同类型的旧实例会被替换）。
 *
 * 组件 id 就是 `componentId(对象 id, 组件类型)`（与编辑器写盘时同一套约定），
 * 不传 `actions` —— 特性组件的动作列表在夹具里一律是空的（与迁移产出的形状一致）。
 */
export function withComponent(
  object: Record<string, unknown>,
  component: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const existing = Array.isArray(object["components"]) ? (object["components"] as unknown[]) : [];
  const kept = existing.filter(
    (item) => !(typeof item === "object" && item !== null && (item as { type?: unknown }).type === component),
  );

  return {
    ...object,
    components: [
      ...kept,
      { id: componentId(String(object["id"]), component), type: component, data, actions: [] },
    ],
  };
}

/** 用接口建一个真项目（含 `project.json`），返回项目名。 */
export async function newProject(request: APIRequestContext): Promise<string> {
  const name = `E2E项目${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const response = await request.post("/api/projects", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return name;
}

/** 删除整个项目（连同它的目录）。 */
export async function dropProject(request: APIRequestContext, name: string): Promise<void> {
  await request.delete(`/api/projects?name=${encodeURIComponent(name)}`);
}

/**
 * 删掉一个**不是项目**的目录（没有 `project.json`，接口不认它是项目）。
 * 用于清理「半途创建」的残留目录。
 */
export async function dropStrayFolder(request: APIRequestContext, name: string): Promise<void> {
  await request.delete(`/api/resources/raw?id=${encodeURIComponent(`project:${name}`)}`);
}

/** 打开编辑器，并等启动引导跑完。 */
export async function gotoEditor(page: Page): Promise<void> {
  await page.goto("/");
  await waitForBootstrap(page);
}

export async function waitForBootstrap(page: Page): Promise<void> {
  await expect(page.locator('[data-bootstrapped="true"]')).toBeVisible();
}

/** 启动引导弹出了哪种对话框（`create` / `open` / `none`）——引导结束后才可信。 */
export async function startupDialogMode(page: Page): Promise<string> {
  const attribute = await page.locator("[data-bootstrapped]").getAttribute("data-project-dialog");
  return attribute ?? "none";
}

/** 把启动引导弹出的对话框关掉（用例自己决定要打开哪个项目）。 */
export async function dismissStartupDialog(page: Page): Promise<void> {
  if ((await startupDialogMode(page)) === "none") {
    return;
  }

  await page.getByTestId("project-dialog-cancel").click();
  await expect(page.getByTestId("project-dialog")).toBeHidden();
}

/** 进入编辑器，并且不让启动对话框挡路。 */
export async function enterEditor(page: Page): Promise<void> {
  await gotoEditor(page);
  await dismissStartupDialog(page);
}

/**
 * 点菜单栏上的一个一级菜单（工程 / 场景 / 编辑 / 视图 / 运行）。
 *
 * **限定在菜单栏里、并且只认下拉触发器**：属性面板的分组标题可能与菜单同名（例如「场景」），
 * 而菜单栏右侧的模式开关又叫「编辑 / 运行」——按名字找会命中多个按钮
 * （Playwright 的严格模式会直接失败）。下拉触发器带 `aria-haspopup="menu"`，
 * 模式开关没有，所以拿它当分辨依据最稳。
 */
export async function openMenu(page: Page, label: string): Promise<void> {
  await page
    .getByTestId("menu-bar")
    .locator('button[aria-haspopup="menu"]')
    .filter({ hasText: label })
    .first()
    .click();
}

/**
 * 打开顶栏的「音乐」弹框（背景音乐：点一首就播 / 暂停 · 继续 / 停止）。
 *
 * 单独抽出来是因为好几条用例要用它：顶栏那个按钮只是**打开弹框**，
 * 打开之后要找的行 / 按钮都在弹框里（`bgm-track` / `bgm-pause` / `bgm-stop`）。
 *
 * **已经是开着的就别再点**：再点一次触发器反而是「又开一次」，没有意义。
 * 与 `openLeftTab` 的「已经是这个页签就别再点」同一条规矩。
 */
export async function openBgmDialog(page: Page): Promise<void> {
  if (!(await page.getByTestId("bgm-dialog").isVisible().catch(() => false))) {
    await page.getByTestId("bgm-control").click();
  }

  await expect(page.getByTestId("bgm-dialog")).toBeVisible();
}

/**
 * 收起顶栏的「音乐」弹框。
 *
 * **弹框开着的时候它拦住页面**（Radix 的模态对话框会把 `pointer-events: none` 打到
 * `body` 上）：不收起来，接下来点任何别的地方都会一直等「元素能收到指针事件」，直到用例超时。
 * 所以「点完弹框里的东西要去点别处」时，先调它。
 */
export async function closeBgmDialog(page: Page): Promise<void> {
  if (!(await page.getByTestId("bgm-dialog").isVisible().catch(() => false))) {
    return;
  }

  if (await page.getByTestId("bgm-close").isVisible().catch(() => false)) {
    await page.getByTestId("bgm-close").click();
  } else {
    await page.keyboard.press("Escape");
  }

  await expect(page.getByTestId("bgm-dialog")).toBeHidden();
}

/**
 * 切到左栏某个页签（默认停在「场景对象」）。
 *
 * 平板档位下左栏是抽屉、默认收起，所以先把它唤出来再切页签。
 */
export async function openLeftTab(page: Page, tab: LeftTab): Promise<void> {
  const button = page.getByTestId(`tab-${tab}`);
  if (!(await button.isVisible().catch(() => false))) {
    // 唤出左抽屉的按钮在菜单栏上（属性面板的分组标题也可能叫「项目」）
    await page.getByTestId("menu-bar").getByRole("button", { name: "项目", exact: true }).click();
  }

  // 已经是这个页签就别再点（重复点击只会徒增抖动）
  if ((await button.getAttribute("data-active")) !== "true") {
    await button.click();
  }
}

/**
 * 关掉所有抽屉（平板 / 触控档位下左右面板都是覆盖式抽屉，会盖住画布）。
 *
 * 桌面档位下面板是常驻分栏、没有「关闭」按钮，这里什么都不做。
 * 需要在画布上点击（拾取、涂抹）而采样点又落在抽屉底下时，先调它。
 */
export async function closeDrawers(page: Page): Promise<void> {
  const closers = page.getByRole("button", { name: "关闭", exact: true });
  // 抽屉关掉即卸载，所以每次点剩下的第一个，直到一个不剩
  for (let remaining = await closers.count(); remaining > 0; remaining -= 1) {
    await closers.first().click();
  }
}

/** 打开属性面板（平板下它是右抽屉；桌面下常驻，什么都不用做）。 */
export async function openInspector(page: Page): Promise<void> {
  if (await page.getByTestId("inspector-object-name").isVisible().catch(() => false)) {
    return;
  }

  const toggle = page.getByRole("button", { name: "属性", exact: true });
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  }
}

/** 从「工程 → 打开项目」里打开指定项目。 */
export async function openProject(page: Page, name: string): Promise<void> {
  await openMenu(page, "工程");
  await page.getByRole("menuitem", { name: "打开项目…" }).click();
  await page.getByTestId("project-row").filter({ hasText: name }).first().click();
  await expect(page.getByTestId("status-doc")).toHaveText(name);
}

/** 用界面新建一个项目（会自动打开它并记入「上次打开」）。 */
export async function createProjectViaUi(page: Page, name: string): Promise<void> {
  await openMenu(page, "工程");
  await page.getByRole("menuitem", { name: "新建项目…" }).click();
  await page.getByTestId("project-name-input").fill(name);
  await page.getByTestId("confirm-create-project").click();
  await expect(page.getByTestId("status-doc")).toHaveText(name);
}

/**
 * 造一个场景（内存形状：场景名 + 内容）。场景名就是 `Assets/scenes/` 下的文件名。
 */
export function sceneDoc(
  name: string,
  objects: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return { name, objects };
}

/**
 * 造一个场景里的普通对象（形状与 `createGameObject` 一致，无组件无动作）。
 *
 * `kind` 缺省是**精灵** `Sprite`（`GameObject` 是抽象基类，不落进文档）。
 *
 * `position` 是**世界坐标**（场景中心为原点，x 向右、y 向上，单位像素）；不传即未放置。
 * `active` / `sortingOrder` 是 v7 起、`scale` 是 v8 起、`locked` 是 v9 起、地图的战争雾
 * （v19 起在 `GridMap` 组件的 `fog` 里，v10–v18 是 `map.fog`；v13 起里面还有总开关 `enabled`）
 * 是 v10 起的显式字段（默认「显示、顺序 0、缩放 1、不锁、没开战争雾」）。
 *
 * 对象特性（地图 / 贴图 / 声音 / 传送 / 视频）**不在这里给参数**：v19 起它们是
 * `components[]` 里的实例，要带就自己用 `withComponent` 挂上去（见 `mapObjectDoc`）。
 */
export function gameObjectDoc(
  name: string,
  kind = "Sprite",
  position: { x: number; y: number } | null = null,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `object_${name}`,
    name,
    kind,
    active: true,
    sortingOrder: 0,
    position,
    rotation: 0,
    scale: 1,
    locked: false,
    components: [],
    ...patch,
  };
}

/**
 * 造一个地图对象（地图只是场景里的对象；贴图与场景同名，放 `Assets/images/`）。
 *
 * 地图**有世界坐标**（贴图中心，默认世界原点），`size` 是贴图里声明的尺寸——
 * 声明得比视口小就能在画布上看到这块棋盘的边界。
 * 显示顺序用编辑器建地图时的默认值（`MAP_DEFAULT_SORTING_ORDER = -10`，垫在最下面）。
 *
 * 贴图与网格是它的 **`GridMap` 组件**（v19 起；v18 及更早写在 `object.map` 里）。
 */
export function mapObjectDoc(
  project: string,
  sceneName: string,
  name = `${sceneName} 地图`,
  size: { width: number; height: number } = { width: 1920, height: 1080 },
  grid: { width: number; height: number } = { width: 64, height: 36 },
): Record<string, unknown> {
  return withComponent(
    gameObjectDoc(name, "Map", { x: 0, y: 0 }, { sortingOrder: -10 }),
    COMPONENT.gridMap,
    {
      image: {
        id: `project:${project}/Assets/images/${sceneName}.png`,
        width: size.width,
        height: size.height,
      },
      grid,
      rowOrder: "bottom-up",
      cells: { encoding: "rle", runs: [[0, grid.width * grid.height]] },
    },
  );
}

/**
 * 把贴图上传到项目的 `Assets/images/` 下（模拟外部把素材提交进目录）。
 *
 * 地图对象引用的就是这张图，所以画布应该把它画出来。
 */
export async function uploadSceneImage(
  request: APIRequestContext,
  project: string,
  sceneName: string,
  data: Buffer,
): Promise<void> {
  const response = await request.put(
    `/api/resources/raw?id=${encodeURIComponent(`project:${project}/Assets/images/${sceneName}.png`)}`,
    { headers: { "content-type": "image/png" }, data },
  );
  expect(response.ok()).toBeTruthy();
}

/**
 * 造一张纯色 PNG（自己编码，不依赖任何图形库）。
 *
 * 用途：断言「贴图真的画到画布上了」——采样画布像素时，纯色最容易判断，
 * 也不会被棋盘格背景或网格线混淆。
 */
export function solidPng(width: number, height: number, color: readonly [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // 每行的过滤器字节
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
    }
  }

  return encodePng(raw, width, height);
}

/**
 * 造一张**图集**样的 PNG：按「列 × 行」切成格子，每格一种颜色。
 *
 * `colors` 的顺序是**从左到右、从上到下**（与文档里子图的格序数同一个读法：
 * `row: 0` 是最上面一行）——于是「选中第 (column, row) 格」该看到哪种颜色一眼可算。
 *
 * 用例用它断言**只画了那一格**：采样画布上各格子的位置，只有选中那一格的颜色出现。
 * 缺的颜色补黑（越界不报错，反正测的是「画出来的是哪一块」）。
 */
export function colorGridPng(
  columns: number,
  rows: number,
  colors: readonly (readonly [number, number, number])[],
  cell = 32,
): Buffer {
  const width = columns * cell;
  const height = rows * cell;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    const row = Math.floor(y / cell);
    for (let x = 0; x < width; x += 1) {
      const column = Math.floor(x / cell);
      const color = colors[row * columns + column] ?? [0, 0, 0];
      const at = rowStart + 1 + x * 3;
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
    }
  }

  return encodePng(raw, width, height);
}

/** 把「每行 1 个过滤器字节 + RGB」的原始像素编成 PNG（`solidPng` / `colorGridPng` 共用）。 */
function encodePng(raw: Buffer, width: number, height: number): Buffer {
  const chunk = (type: string, payload: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：真彩 RGB
  // 10..12 依次是压缩方式 / 过滤方式 / 交错方式，都是 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 直接往盘上写工程文件与场景文件。
 *
 * 用例要先把内容造在盘上，再从编辑器里读回来——这同时也验证了
 * 「`project.json` + `Assets/scenes/*.json` 会被正确读出」。
 *
 * 工程文件**故意写 v4**（打开时会被升到当前版本并回写），场景文件写当前版本：
 * 场景文件若有版本差就会被重写一次，那会让「重命名场景内容不变」这类断言变得不确定。
 * 旧版**坐标格式**的迁移由 `hierarchy.spec.ts` 的专门用例覆盖。
 */
export async function seedProjectDoc(
  request: APIRequestContext,
  project: string,
  scenes: readonly Record<string, unknown>[],
  /**
   * 额外塞进工程文件的**项目级数据**。
   *
   * 也用来有意造出**旧形状**的字段（如 v20–v22 的 `spriteSheets` 切分表）：
   * 编辑器打开时会按迁移把它们搬进各素材自己的 `.meta` 并回写工程文件——
   * 所以这种用例的断言要读**素材 meta**，而不是工程文件（见 `readSpriteSheet`）。
   */
  projectPatch?: Record<string, unknown>,
): Promise<void> {
  // 工程文件：项目级数据，场景不在里面
  const doc = {
    formatVersion: 4,
    name: project,
    items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
    ...projectPatch,
  };

  const projectResponse = await request.put(
    `/api/resources/text?id=${encodeURIComponent(`project:${project}/project.json`)}`,
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
      data: `${JSON.stringify(doc, null, 2)}\n`,
    },
  );
  expect(projectResponse.ok()).toBeTruthy();

  // 场景文件：场景名就是文件名，文件内容里不存名字
  for (const scene of scenes) {
    const name = String(scene.name);
    const file = { formatVersion: CURRENT_SCENE_FORMAT_VERSION, objects: scene.objects ?? [] };

    const response = await request.put(
      `/api/resources/text?id=${encodeURIComponent(
        `project:${project}/Assets/scenes/${name}.json`,
      )}`,
      {
        headers: { "content-type": "text/plain; charset=utf-8" },
        data: `${JSON.stringify(file, null, 2)}\n`,
      },
    );
    expect(response.ok()).toBeTruthy();
  }
}

/** 场景文件里的一个对象（e2e 断言落盘用）：只声明用例真正会读的字段。 */
export interface PersistedGameObject {
  readonly id?: string;
  readonly name: string;
  readonly kind: string;
  readonly position: { x: number; y: number } | null;
  readonly active?: boolean;
  readonly locked?: boolean;
  readonly sortingOrder?: number;
  readonly rotation?: number;
  readonly scale?: number;
}

/** 直接读一个场景文件里的对象（e2e 断言用）。 */
export async function readGameObjects(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<PersistedGameObject[]> {
  const id = `project:${project}/Assets/scenes/${sceneName}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    return [];
  }

  const file = JSON.parse(await response.text()) as { objects?: PersistedGameObject[] };
  return file.objects ?? [];
}

/** 场景文件里地图对象的**网格数据**（标注用例断言落盘用）。 */
export interface SceneMapData {
  readonly grid: { readonly width: number; readonly height: number };
  readonly runs: ReadonlyArray<readonly [number, number]>;
}

/**
 * 读一个场景文件的**整份内容**（断言格式版本 / 组件时用它 + `componentDataOf`）。
 *
 * 读不到、或读到的是**半截 JSON**（迁移回写与这次读撞在一起）都返回 `undefined`：
 * 调用方多半在 `expect.poll` 里，`undefined` 会让它再试一轮，而不是当场炸成偶发失败。
 */
export async function readSceneFile(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<SceneFileLike | undefined> {
  const id = `project:${project}/Assets/scenes/${sceneName}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    return undefined;
  }

  try {
    return JSON.parse(await response.text()) as SceneFileLike;
  } catch {
    return undefined;
  }
}

/**
 * 读场景文件里第一个地图对象的网格数据（尺寸 + 展开前的游程）。
 *
 * 游程在文件里的位置是 **`GridMap` 组件的 `data.cells.runs`**（`cells` 是 `{encoding, runs}`；
 * v18 及更早是 `object.map.cells.runs`），这里把它摊平成 `{grid, runs}`：用例只关心这两样。
 */
export async function readSceneMap(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<SceneMapData | undefined> {
  const file = await readSceneFile(request, project, sceneName);
  const data = componentDataOf(file, { kind: "Map" }, COMPONENT.gridMap);
  const grid = data?.["grid"] as SceneMapData["grid"] | undefined;
  const runs = (data?.["cells"] as { runs?: SceneMapData["runs"] } | undefined)?.runs;
  if (grid === undefined || runs === undefined) {
    return undefined;
  }

  return { grid, runs };
}

/**
 * 读场景文件里地图对象的**战争雾配置**（总开关 + 指定的雾区位）。
 *
 * 没开过战争雾就是 `undefined`——「没开也没指定」在文件里是 **`GridMap` 组件里没有 `fog`**
 * （v18 及更早是没有 `map.fog`；见 `setMapFogEnabled` / `setMapFogRegions`）。
 */
export async function readSceneFog(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<{ enabled?: boolean; regions?: readonly number[] } | undefined> {
  const file = await readSceneFile(request, project, sceneName);
  return componentDataOf(file, { kind: "Map" }, COMPONENT.gridMap)?.["fog"] as
    | { enabled?: boolean; regions?: readonly number[] }
    | undefined;
}

/**
 * 读场景文件里地图对象的**战争雾绑定**（指定的雾区位）。
 *
 * 没指定过雾区就是 `undefined`——「没指定」在文件里是**没有 `fog` 这个字段**
 * （见 `setMapFogRegions`）。
 */
export async function readSceneFogRegions(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<readonly number[] | undefined> {
  return (await readSceneFog(request, project, sceneName))?.regions;
}

/**
 * 读场景文件里**某个对象**的视频配置（**地图 / 贴图**上的 `VideoOverlay`），按 `kind` 找——
 * 不按数组下标：用例里对象顺序不是契约，`readSceneFog` 也是这么做的。
 *
 * 缺省找 `Map`（大多数用例是给地图配视频）。v21 起视频那一组的宿主是**地图与贴图**
 * （精灵不再带），一个场景里两种宿主可以同时有视频——所以想读哪一个必须由调用方说清。
 *
 * 没加过视频就是 `undefined`——「没加」在文件里是**没有这个组件**（v18 及更早是没有
 * `video` 这个字段；见 `setVideoClips`）。
 */
export async function readSceneVideo(
  request: APIRequestContext,
  project: string,
  sceneName: string,
  kind: "Map" | "Image" = "Map",
): Promise<
  | {
      clips?: readonly string[];
      picked?: string;
      names?: Record<string, string>;
      loop?: boolean;
      audio?: boolean;
      enabled?: boolean;
    }
  | undefined
> {
  const id = `project:${project}/Assets/scenes/${sceneName}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    // 读不到就是读不到：在这些用例里场景文件一定存在，静默返回 undefined 只会把失败说成「没加视频」
    throw new Error(`读场景文件失败：HTTP ${response.status()}（${id}）`);
  }

  const file = JSON.parse(await response.text()) as SceneFileLike;
  const data = componentDataOf(file, { kind }, COMPONENT.videoOverlay);
  if (data === undefined) {
    return undefined;
  }

  return {
    enabled: data["enabled"] as boolean | undefined,
    clips: data["clips"] as readonly string[] | undefined,
    picked: data["picked"] as string | undefined,
    names: data["names"] as Record<string, string> | undefined,
    loop: data["loop"] as boolean | undefined,
    audio: data["audio"] as boolean | undefined,
  };
}

/**
 * 读场景文件里**声音对象**的数据（音频列表 + 选中的那条 + 名字 + 层级）。
 *
 * 连对象自己的 `position` 一起带出来：声音对象的用例既断言「配置落盘」也断言「落位」。
 * 场景里没有 `kind: "PlaySound"` 的对象时 `undefined`；对象在、但**没有 `PlaySound` 组件**
 * 时（手写文件）也 `undefined`——两种都是「这份数据不存在」。
 */
export async function readSceneSound(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<
  | {
      clips?: readonly string[];
      picked?: string;
      names?: Record<string, string>;
      layer?: string;
      position?: { x: number; y: number } | null;
    }
  | undefined
> {
  const file = await readSceneFile(request, project, sceneName);
  const object = findGameObject(file, { kind: "PlaySound" });
  if (object === undefined) {
    return undefined;
  }

  const data = objectComponentData(object, COMPONENT.playSound);
  return {
    clips: data?.["clips"] as readonly string[] | undefined,
    picked: data?.["picked"] as string | undefined,
    names: data?.["names"] as Record<string, string> | undefined,
    layer: data?.["layer"] as string | undefined,
    position: object["position"] as { x: number; y: number } | null | undefined,
  };
}

/**
 * 读场景文件里**传送阵**的数据（候选目标场景 + 选中的那一个）。
 *
 * 与 `readSceneSound` 同一套：没有 `kind: "Teleport"` 的对象、或它没带 `Teleport` 组件时
 * 都返回 `undefined`。
 */
export async function readSceneTeleport(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<{ targets?: readonly string[]; picked?: string } | undefined> {
  const file = await readSceneFile(request, project, sceneName);
  const data = componentDataOf(file, { kind: "Teleport" }, COMPONENT.teleport);
  if (data === undefined) {
    return undefined;
  }

  return {
    targets: data["targets"] as readonly string[] | undefined,
    picked: data["picked"] as string | undefined,
  };
}

/**
 * 读**工程文件**里的全局设置（`project.json` 的 `settings.audio`）。
 *
 * v16 起这里**只有三档音量**：背景音乐的歌单 / 默认曲 / 循环不再进文档
 * （清单就是项目 `Assets/audio/` 下的音频），所以「改完音量有没有落盘」直接看文件即可，
 * 而「有没有把歌单偷偷写进去」也是看它。
 * 老工程文件里没有这一项时返回 `undefined`（`parseProjectFile` 会补一份缺省的并要求回写）。
 */
export async function readProjectSettings(
  request: APIRequestContext,
  project: string,
): Promise<
  | {
      bgm?: { clips?: readonly string[]; picked?: string; names?: Record<string, string>; loop?: boolean; volume?: number };
      sfx?: { volume?: number };
      voice?: { volume?: number };
    }
  | undefined
> {
  const id = `project:${project}/project.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    throw new Error(`读工程文件失败：HTTP ${response.status()}（${id}）`);
  }

  const file = JSON.parse(await response.text()) as {
    formatVersion?: number;
    settings?: {
      audio?: {
        bgm?: { clips?: string[]; picked?: string; names?: Record<string, string>; loop?: boolean; volume?: number };
        sfx?: { volume?: number };
        voice?: { volume?: number };
      };
    };
  };

  return file.settings?.audio;
}

/**
 * 读某个素材**自己那份 `<素材>.meta`** 的原文对象；没有那一份时返回 `undefined`。
 *
 * v23 起素材级数据（图片的切分 / 导入设置、v24 起音频的显示名与标签）都住在这里，
 * 不再住工程文件；`.meta` 本身不进资源树，但走 `/api/resources/text` 读得到。
 */
export async function readAssetMeta(
  request: APIRequestContext,
  assetId: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await request.get(
    `/api/resources/text?id=${encodeURIComponent(`${assetId}.meta`)}`,
  );
  if (response.status() === 404) {
    return undefined;
  }

  if (!response.ok()) {
    throw new Error(`读素材 meta 失败：HTTP ${response.status()}（${assetId}.meta）`);
  }

  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/**
 * 读某个**音频素材** meta 里的 `audio` 段（显示名 + 标签 ID 列表）；没有这一段 → `undefined`。
 *
 * 「没有这一段」才是「这个文件还没整理过」（**不补空壳**）：每个素材都有 meta，
 * 但只有起了名字 / 勾了标签才会写出 `audio`。
 */
export async function readAudioMeta(
  request: APIRequestContext,
  assetId: string,
): Promise<{ name?: string; tags?: number[] } | undefined> {
  const meta = await readAssetMeta(request, assetId);
  const audio = meta?.["audio"];
  if (typeof audio !== "object" || audio === null) {
    return undefined;
  }

  return audio as { name?: string; tags?: number[] };
}

/**
 * 读工程文件里的**标签表**（`audioTags`，v18 起）：**下标就是 tag ID**，值是这个 ID 的名字
 * （`null` = 删掉的洞）。没有标签时整个字段不在文件里 → `undefined`。
 */
export async function readProjectAudioTags(
  request: APIRequestContext,
  project: string,
): Promise<Array<string | null> | undefined> {
  const id = `project:${project}/project.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    throw new Error(`读工程文件失败：HTTP ${response.status()}（${id}）`);
  }

  return (JSON.parse(await response.text()) as { audioTags?: Array<string | null> }).audioTags;
}

/**
 * 读一个图片素材 meta 里的**切分**（`sprite.sheet`）：v23 起它住在 `<素材>.meta` 里，
 * 工程文件里已经没有那张 `spriteSheets` 表了。
 *
 * 这是「一张图按几行几列切」的**唯一一份**（对象身上只存「引用哪张图 + 第几格」），
 * 所以断言「切分落在素材的 `.meta` 而不是场景文件 / 工程文件」就用它。
 * `sprite` / `sheet` 缺省时返回 `undefined`（= 整图）。
 */
export async function readSpriteSheet(
  request: APIRequestContext,
  assetId: string,
): Promise<{ columns: number; rows: number } | undefined> {
  const meta = await readAssetMeta(request, assetId);
  const sprite = meta?.["sprite"];
  if (typeof sprite !== "object" || sprite === null) {
    return undefined;
  }

  const sheet = (sprite as { sheet?: unknown }).sheet;
  if (typeof sheet !== "object" || sheet === null) {
    return undefined;
  }

  const { columns, rows } = sheet as { columns?: unknown; rows?: unknown };
  return typeof columns === "number" && typeof rows === "number" ? { columns, rows } : undefined;
}

/**
 * 读某个对象显示的**子图引用**（`SpriteLayer` 的 `sprite`，v20 起）：`{ column, row }`。
 *
 * 没有子图（整张图）时返回 `undefined`——**对象身上只有格子引用**，「几行几列」在工程文件里。
 */
export async function readObjectSprite(
  request: APIRequestContext,
  project: string,
  sceneName: string,
  selector: { readonly objectId?: string; readonly kind?: string },
): Promise<{ column: number; row: number } | undefined> {
  const file = await readSceneFile(request, project, sceneName);
  const object = findGameObject(file, selector);
  const data = objectComponentData(object, COMPONENT.spriteLayer);
  const sprite = data?.["sprite"];
  if (typeof sprite !== "object" || sprite === null) {
    return undefined;
  }

  return sprite as { column: number; row: number };
}

/**
 * 直接把**标签表 + 若干音频文件的标注**写下去（v24 形状）。
 *
 * 标签表是**项目级**数据，仍住工程文件（`audioTags`：下标 = tag ID）；
 * 显示名与标签 ID 是**素材级**数据，v24 起写在那个音频文件自己的 `<素材>.meta` 里
 * （`importer: "audio"` 的 `audio` 段）。工程文件版本故意写 4：编辑器打开时会升到当前版本
 * 并回写一次（与 `seedProjectDoc` 同一条规矩），缺的素材 meta 也由它补齐。
 *
 * 给「只关心按标签找 / 播」的用例用（编辑那套界面在 `audio-meta.spec.ts` 里单独验）。
 */
export async function seedProjectAudioMeta(
  request: APIRequestContext,
  project: string,
  input: {
    readonly tags: ReadonlyArray<string | null>;
    readonly meta: Readonly<Record<string, { name?: string; tags?: readonly number[] }>>;
  },
): Promise<void> {
  const doc = {
    formatVersion: 4,
    name: project,
    items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
    audioTags: [...input.tags],
  };

  const response = await request.put(
    `/api/resources/text?id=${encodeURIComponent(`project:${project}/project.json`)}`,
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
      data: `${JSON.stringify(doc, null, 2)}\n`,
    },
  );
  expect(response.ok()).toBeTruthy();

  // 标注各写各的 `<素材>.meta`：**空壳不写**（既没名字也没标签时整个 `audio` 段不存在）
  for (const [assetId, entry] of Object.entries(input.meta)) {
    const audio = {
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.tags === undefined ? {} : { tags: [...entry.tags] }),
    };
    const meta = {
      formatVersion: 1,
      guid: randomUUID().replaceAll("-", ""),
      importer: "audio",
      ...(Object.keys(audio).length === 0 ? {} : { audio }),
    };

    const metaResponse = await request.put(
      `/api/resources/text?id=${encodeURIComponent(`${assetId}.meta`)}`,
      {
        headers: { "content-type": "text/plain; charset=utf-8" },
        data: `${JSON.stringify(meta, null, 2)}\n`,
      },
    );
    expect(metaResponse.ok()).toBeTruthy();
  }
}

/** 读工程文件的 `formatVersion`（迁移有没有把新形状回写进文件，看它）。 */
export async function readProjectFormatVersion(
  request: APIRequestContext,
  project: string,
): Promise<number | undefined> {
  const id = `project:${project}/project.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    throw new Error(`读工程文件失败：HTTP ${response.status()}（${id}）`);
  }

  return (JSON.parse(await response.text()) as { formatVersion?: number }).formatVersion;
}

/** 把 RLE 游程展开成掩码数组（断言某一格画上了什么）。 */
export function expandRuns(runs: ReadonlyArray<readonly [number, number]>): number[] {
  const cells: number[] = [];
  for (const [mask, count] of runs) {
    for (let index = 0; index < count; index += 1) {
      cells.push(mask);
    }
  }

  return cells;
}

/**
 * 轮询场景文件，等自动保存落盘后断言对象名。
 *
 * 「改了就存」有 800ms 防抖，所以断言落盘不能靠固定 sleep。
 */
export async function expectPersistedObjectNames(
  request: APIRequestContext,
  project: string,
  sceneName: string,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(async () => (await readGameObjects(request, project, sceneName)).map((o) => o.name), {
      timeout: 8000,
      message: "等待场景文件落盘",
    })
    .toEqual(expected);
}

/**
 * 切到「移动」工具（画布左上角的工具开关）。
 *
 * **对象不会被跟手拖走**：拖动工具只平移画布，想改对象位置就得用移动工具的 X / Y 箭头。
 * 所以任何「拖对象本体」的老用例都要先调到这个工具，否则那一下只会平移视口。
 *
 * 手柄本身的位置由 `ScenePanel` 算，用例不必知道：抓轴线中段即可。
 */
export async function useMoveTool(page: Page): Promise<void> {
  await page.getByTestId("tool-move").click();
  await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", "move");
}

/**
 * 场景里的某个对象，并保证属性面板露出来（平板下它是右抽屉）。
 *
 * 对象列表在「场景对象」页签里，所以要先把左栏切过去。
 */
export async function selectObject(page: Page, index = 0): Promise<void> {
  await openLeftTab(page, "hierarchy");
  await page.getByTestId("object-row").nth(index).click();

  if (!(await page.getByTestId("inspector-object-name").isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "属性", exact: true }).click();
  }
}

/**
 * 「打开项目 → 选中第一个对象 → 露出属性面板」这套开场（属性相关的用例都这么起手）。
 *
 * 顺带把选中对象的**名字**钉住：选中偏了（列表顺序变了、场景没起来）时立刻失败，
 * 而不是等到后面某条断言给出一个莫名其妙的数字。
 */
export async function openFirstObject(
  page: Page,
  project: string,
  expectedName: string,
): Promise<void> {
  await enterEditor(page);
  await openProject(page, project);
  await selectObject(page, 0);
  await expect(page.getByTestId("inspector-object-name")).toHaveValue(expectedName);
}
