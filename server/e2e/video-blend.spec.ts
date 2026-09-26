import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  COMPONENT,
  dropProject,
  enterEditor,
  findGameObject,
  gameObjectDoc,
  newProject,
  objectComponentData,
  openProject,
  readSceneFile,
  sceneDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
  uploadSceneImage,
  withComponent,
} from "./helpers/editor";
import { canvasColorAt } from "./helpers/canvas";

/**
 * 贴图上的**视频混合**（v17）：两条视频（A 盖住 / B 擦开露出）+ 一张**纯运行态**的 Mask。
 *
 * 两半：
 * 1. **编辑器怎么配 / Mask 窗口怎么擦**（不需要运行态）：两条通道各自「小方块单选」、
 *    循环 / 声音来源落进场景文件；Mask 窗口初始整张盖住、擦开露出、**场景文件一个字节都不动**；
 * 2. **命令怎么下发**（`@runtime`）：浏览器里再开一条**假前端** WebSocket（`/client`），
 *    点播放 → 前端收到 `play_video`（**只带 `objectId`**）；Mask 窗口擦一笔 → 收到
 *    `erase_video_mask`（载荷是**轨迹**：归一化点 + 半径 `0.05` + 软边 `0.5`——不是雾那档 `1`，
 *    要实心核，擦到的地方才真的到 0）。
 *
 * 编辑器**不播放视频**（不接解码）：这里钉的全是「面板 / 窗口 / 命令」。
 */

const SCENE = "Map001";
const TEXTURE_SIZE = { width: 320, height: 180 };
/** 编辑器下发的归一化半径（`48/960`，跨端契约里的那个数）。 */
const BRUSH_RATIO = 0.05;
const CANVAS = "video-blend-mask-canvas";
/** 场景文件里存的是**素材 GUID**（`sceneAssetRefsToGuids`），不是逻辑路径。 */
const GUID = /^[0-9a-f]{32}$/;

/** 把一段假视频提交到 `Assets/video/`（内容无所谓：编辑器不解析视频、也不播放）。 */
async function uploadVideo(
  request: APIRequestContext,
  project: string,
  name: string,
): Promise<string> {
  const id = `project:${project}/Assets/video/${name}`;
  const response = await request.put(`/api/resources/raw?id=${encodeURIComponent(id)}`, {
    headers: { "content-type": "video/mp4" },
    data: Buffer.from(`not-really-video:${name}`),
  });
  expect(response.ok()).toBeTruthy();
  return id;
}

/** 一张贴图 + `VideoBlend`（A / B 各一路，**A 故意不选**——留给「选素材」那一步；B 选了）。 */
function blendTextureDoc(project: string, clipB: string): Record<string, unknown> {
  const base = gameObjectDoc("视频混合贴图", "Image", { x: 0, y: 0 });
  const withImage = withComponent(base, COMPONENT.imageLayer, {
    id: `project:${project}/Assets/images/${SCENE}.png`,
    width: TEXTURE_SIZE.width,
    height: TEXTURE_SIZE.height,
    sortingOrder: 0,
  });

  return withComponent(withImage, COMPONENT.videoBlend, {
    a: { kind: "video" },
    b: { kind: "video", id: clipB },
    loop: false,
    audio: "none",
  });
}

/** 场景文件里那个对象的 `VideoBlend` 数据（没有就抛）。 */
async function blendData(
  request: APIRequestContext,
  project: string,
  objectId: string,
): Promise<Record<string, unknown>> {
  const file = await readSceneFile(request, project, SCENE);
  const data = objectComponentData(findGameObject(file, { objectId }), COMPONENT.videoBlend);
  if (data === undefined) {
    throw new Error("场景文件里没有 VideoBlend 组件");
  }

  return data;
}

/** 在 Mask 画布上沿中线拖一笔（模拟 GM 擦除）。 */
async function eraseAcross(page: Page): Promise<void> {
  const box = await page.getByTestId(CANVAS).boundingBox();
  if (box === null) {
    throw new Error("拿不到 Mask 画布尺寸");
  }

  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
}

/** Mask 画布正中的平均颜色（盖层是深色不透明；擦开后 alpha 掉下去）。 */
async function maskCenter(page: Page): Promise<{ readonly a: number }> {
  const box = await page.getByTestId(CANVAS).boundingBox();
  if (box === null) {
    throw new Error("拿不到 Mask 画布尺寸");
  }

  return canvasColorAt(page, CANVAS, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 2);
}

/** 打开项目并选中那张**视频混合贴图**。 */
async function openBlendObject(page: Page, project: string): Promise<void> {
  await enterEditor(page);
  await openProject(page, project);
  await selectObject(page, 0);
  await expect(page.getByTestId("inspector-object-name")).toHaveValue("视频混合贴图");
}

// ---------------------------------------------------------------- 编辑态：面板与 Mask 窗口

test.describe("视频混合：属性面板与 Mask 窗口", () => {
  test("两路素材 / 循环 / 声音 / 自动播放落进场景文件；Mask 窗口擦了不落盘", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const clipA = await uploadVideo(request, project, "a.mp4");
      const clipB = await uploadVideo(request, project, "b.mp4");
      const doc = blendTextureDoc(project, clipB);
      const objectId = String(doc["id"]);
      await seedProjectDoc(request, project, [sceneDoc(SCENE, [doc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(8, 8, [40, 80, 120]));
      await openBlendObject(page, project);

      const group = page.locator('[data-group="videoBlend"]');
      // 两路各是「种类开关 + 选择按钮 + 当前素材」：B 已选（fixture 给的）、A 还空着；
      // 再加循环 / 声音 / 自动播放三行 + Mask 入口
      await expect(group.getByTestId("video-blend-a-kind-video")).toHaveAttribute("data-active", "true");
      await expect(group.getByTestId("video-blend-a-kind-image")).toHaveAttribute("data-active", "false");
      await expect(group.getByTestId("video-blend-a-empty")).toBeVisible();
      await expect(group.getByTestId("video-blend-b-current")).toContainText("b");
      await expect(group.getByTestId("video-blend-loop")).toBeVisible();
      await expect(group.getByTestId("video-blend-audio")).toBeVisible();
      await expect(group.getByTestId("video-blend-auto-play")).toBeVisible();
      await expect(group.getByTestId("video-blend-mask-open")).toBeVisible();
      await expect(group.getByTestId("video-blend-play")).toBeEnabled();

      // A 还没选 → 点「选择视频…」弹通用选择框，挑一条「添加」（写文档、可撤销）。
      // 落盘的是**素材 GUID** 而不是逻辑路径，所以断言形状（32 位十六进制）
      await group.getByTestId("video-blend-a-pick").click();
      const picker = page.getByTestId("video-picker-dialog");
      await picker.locator(`[data-testid="video-picker-item"][data-asset-id="${clipA}"]`).click();
      await picker.getByTestId("video-picker-add").click();
      await expect
        .poll(async () => {
          const a = (await blendData(request, project, objectId))["a"] as {
            readonly kind?: string;
            readonly id?: string;
          };
          return { kind: a.kind, idIsGuid: typeof a.id === "string" && GUID.test(a.id) };
        })
        .toEqual({ kind: "video", idIsGuid: true });

      // 循环打开：也是文档数据
      await group.getByTestId("video-blend-loop").check();
      await expect
        .poll(async () => (await blendData(request, project, objectId))["loop"])
        .toBe(true);

      // 自动播放打开：同样是文档数据（v18，与「视频」那个开关同义）
      await group.getByTestId("video-blend-auto-play").check();
      await expect
        .poll(async () => (await blendData(request, project, objectId))["autoPlay"])
        .toBe(true);

      const before = await blendData(request, project, objectId);

      // Mask 窗口：初始整张不透明（盖层），擦一笔之后那一带的 alpha 掉下去
      await group.getByTestId("video-blend-mask-open").click();
      await expect(page.getByTestId("video-blend-mask-dialog")).toBeVisible();
      const covered = await maskCenter(page);
      expect(covered.a).toBeGreaterThan(200);

      await eraseAcross(page);
      await expect.poll(async () => (await maskCenter(page)).a).toBeLessThan(50);

      // **擦了不落盘**：场景文件里那份 VideoBlend 与擦之前逐字一致（没有遮罩字段）
      expect(await blendData(request, project, objectId)).toEqual(before);

      await page.getByTestId("video-blend-mask-close").click();
      await expect(page.getByTestId("video-blend-mask-dialog")).toBeHidden();
    } finally {
      await dropProject(request, project);
    }
  });
});

// ---------------------------------------------------------------- 运行态：命令下发

/** 假前端收到的一条命令（只列这条用例用到的字段）。 */
interface FakeCommand {
  readonly kind?: string;
  readonly objectId?: string;
  readonly stroke?: {
    readonly points?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
    readonly radius?: number;
    readonly softness?: number;
  };
}

interface FakeClientWindow {
  __blendCommands?: FakeCommand[];
  __blendScene?: boolean;
  __blendSocket?: WebSocket;
}

/** 运行态是服务端全局单例：只在一个档位上跑，免得并行档位互相开关。 */
function skipOutsideDesktop(testInfo: TestInfo): void {
  test.skip(
    !testInfo.project.name.startsWith("desktop"),
    "运行态是全局状态：只在一个档位跑，免得并行档位互相开关",
  );
}

/** 在页面里开一条**假前端**连接：握手、收场景、把命令记下来并按协议回执。 */
async function connectFakeClient(page: Page, port: number): Promise<void> {
  await page.evaluate((clientPort) => {
    const scope = window as unknown as FakeClientWindow;
    scope.__blendCommands = [];
    scope.__blendScene = false;

    const socket = new WebSocket(`ws://127.0.0.1:${clientPort}/client`);
    scope.__blendSocket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "client_hello",
          // 与 `@dts/protocol` 的 `PROTOCOL_VERSION` 一致（这里写死：e2e 不是 workspace 包，
          // 拿不到那个常量；版本一升这里会连不上、用例会当场失败，提醒同步改）
          protocolVersion: 19,
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
      };

      if (parsed.type === "scene_sync") {
        scope.__blendScene = true;
        return;
      }

      if (parsed.type === "command") {
        scope.__blendCommands?.push(parsed.command ?? {});
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
  return page.evaluate(() => (window as unknown as FakeClientWindow).__blendCommands ?? []);
}

test.describe("视频混合：轨迹下发给前端", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("播放 / 停止 → play_video / stop_video；Mask 窗口擦一笔 → erase_video_mask", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      const clipA = await uploadVideo(request, project, "a.mp4");
      const clipB = await uploadVideo(request, project, "b.mp4");
      const doc = blendTextureDoc(project, clipB);
      const objectId = String(doc["id"]);
      // A 也选上，这样「播放」才点得动
      const blend = objectComponentData(doc, COMPONENT.videoBlend)!;
      blend["a"] = { kind: "video", id: clipA };

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [doc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(8, 8, [40, 80, 120]));
      await openBlendObject(page, project);

      const group = page.locator('[data-group="videoBlend"]');

      // 进入运行态 → 假前端连上（拿到整份场景 = 镜像协议那条路是通的）
      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");
      await connectFakeClient(page, port);
      await page.waitForFunction(() => (window as unknown as FakeClientWindow).__blendScene === true);
      await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

      // 播放：命令只带 objectId（放哪两路 / 循环 / 声音都在推下去的那个对象里）
      await group.getByTestId("video-blend-play").click();
      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "play_video").length)
        .toBe(1);

      const play = (await fakeCommands(page)).find((item) => item.kind === "play_video");
      expect(play?.objectId).toBe(objectId);
      expect(play?.stroke).toBeUndefined();

      // Mask 窗口擦一笔 → erase_video_mask：只有轨迹（归一化点 + 半径 0.05 + 软边 0.5）
      await group.getByTestId("video-blend-mask-open").click();
      await expect(page.getByTestId("video-blend-mask-dialog")).toBeVisible();
      await eraseAcross(page);

      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "erase_video_mask").length)
        .toBeGreaterThan(0);

      const eraseCommands = (await fakeCommands(page)).filter((item) => item.kind === "erase_video_mask");
      for (const command of eraseCommands) {
        expect(command.objectId).toBe(objectId);
        expect(command.stroke?.radius).toBeCloseTo(BRUSH_RATIO, 5);
        expect(command.stroke?.softness).toBe(0.5);
        expect(command.stroke?.points?.length ?? 0).toBeGreaterThan(0);
        for (const point of command.stroke?.points ?? []) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(1);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(1);
        }
      }

      // 假前端回执 ok:true → 编辑器日志里看得见「命令 执行成功」
      await expect(page.getByText(/命令\s*执行成功/).first()).toBeVisible();

      // 停止：拆掉混合层
      await page.getByTestId("video-blend-mask-close").click();
      await group.getByTestId("video-blend-stop").click();
      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "stop_video").length)
        .toBe(1);
      expect((await fakeCommands(page)).find((item) => item.kind === "stop_video")?.objectId).toBe(objectId);
    } finally {
      await page.evaluate(() => {
        (window as unknown as FakeClientWindow).__blendSocket?.close();
      });
      // 退出运行态（前端会被踢下线）
      await page.getByTestId("mode-edit").click().catch(() => undefined);
      await dropProject(request, project);
    }
  });
});
