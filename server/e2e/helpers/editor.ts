import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

/**
 * E2E 公共操作。
 *
 * 编辑器启动时会跑一次**启动引导**：自动打开上次的项目 / 一个项目都没有时弹「新建项目」/
 * 有项目但没记录时弹「打开项目」列表。所以用例入口统一走 `gotoEditor`，先等引导跑完
 * （`data-bootstrapped="true"`），否则启动对话框可能在点击中途冒出来把点击吃掉。
 */

export type LeftTab = "assets" | "hierarchy";

/** 场景文件的当前格式版本（与 `@dts/document` 的 `DOCUMENT_FORMAT_VERSION` 保持一致）。 */
export const CURRENT_SCENE_FORMAT_VERSION = 5;

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

/** 左栏在平板档位下是抽屉、默认收起，先展开再切页签。 */
export async function openLeftTab(page: Page, tab: LeftTab): Promise<void> {
  const testId = `tab-${tab}`;
  if (!(await page.getByTestId(testId).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "项目", exact: true }).click();
  }

  await page.getByTestId(testId).click();
}

/** 从「工程 → 打开项目」里打开指定项目。 */
export async function openProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "工程", exact: true }).click();
  await page.getByRole("menuitem", { name: "打开项目…" }).click();
  await page.getByTestId("project-row").filter({ hasText: name }).first().click();
  await expect(page.getByTestId("status-doc")).toHaveText(name);
}

/** 用界面新建一个项目（会自动打开它并记入「上次打开」）。 */
export async function createProjectViaUi(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "工程", exact: true }).click();
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
 * 造一个场景里的普通对象（形状与 `createSceneObject` 一致，无组件无动作）。
 *
 * `position` 是**世界坐标**（场景中心为原点，x 向右、y 向上，单位像素）；不传即未放置。
 */
export function sceneObjectDoc(
  name: string,
  kind = "SceneObject",
  position: { x: number; y: number } | null = null,
): Record<string, unknown> {
  return {
    id: `object_${name}`,
    name,
    kind,
    position,
    rotation: 0,
    components: [],
  };
}

/** 造一个地图对象（地图只是场景里的对象；贴图与场景同名，放 `Assets/images/`）。 */
export function mapObjectDoc(
  project: string,
  sceneName: string,
  name = `${sceneName} 地图`,
): Record<string, unknown> {
  return {
    ...sceneObjectDoc(name, "Map"),
    map: {
      image: {
        id: `project:${project}/Assets/images/${sceneName}.png`,
        width: 1920,
        height: 1080,
      },
      grid: { width: 64, height: 36, cellSize: 1 },
      rowOrder: "bottom-up",
      cells: { encoding: "rle", runs: [[0, 64 * 36]] },
    },
  };
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
): Promise<void> {
  // 工程文件：项目级数据，场景不在里面
  const doc = {
    formatVersion: 4,
    name: project,
    items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
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

/** 直接读一个场景文件里的对象（e2e 断言用）。 */
export async function readSceneObjects(
  request: APIRequestContext,
  project: string,
  sceneName: string,
): Promise<
  Array<{ name: string; kind: string; position: { x: number; y: number } | null }>
> {
  const id = `project:${project}/Assets/scenes/${sceneName}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    return [];
  }

  const file = JSON.parse(await response.text()) as {
    objects?: Array<{ name: string; kind: string; position: { x: number; y: number } | null }>;
  };
  return file.objects ?? [];
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
    .poll(async () => (await readSceneObjects(request, project, sceneName)).map((o) => o.name), {
      timeout: 8000,
      message: "等待场景文件落盘",
    })
    .toEqual(expected);
}
