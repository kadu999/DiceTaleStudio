import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  dropProject,
  mapObjectDoc,
  newProject,
  openFirstObject,
  openLeftTab,
  readSceneVideo,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";

/**
 * 地图 / 精灵上的**视频**（v14 起）：加一组视频，运行时选一条放。
 *
 * 两半：
 * 1. **编辑器怎么配**（不需要运行态）：面板「视频」组 → 「编辑」窗口加 / 删 / 起名字 →
 *    面板上点小方块选放哪条 → 循环 / 声音两个开关 → 都落进场景文件的 `video` 字段；
 * 2. **命令怎么下发**（`@runtime`）：浏览器里再开一条**假前端** WebSocket（`/client`），
 *    点播放 / 暂停 / 继续 / 停止 → 前端依次收到
 *    `play_video` / `pause_video` / `resume_video` / `stop_video`，**且只带 `objectId`**
 *    （放哪一条、循环、声音都在推下去的那个对象里）。
 *
 * 编辑器**不播放**：页面上没有 `<video>` 预览——放视频是前端（Unity）的事。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };
const SPRITE = "精灵";

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

/** 假前端收到的一条命令（这条用例只关心 kind 与 objectId）。 */
interface FakeCommand {
  readonly kind?: string;
  readonly objectId?: string;
}

/** 假前端的状态放在页面全局（`page.evaluate` 来回读）。 */
interface FakeClientWindow {
  __videoCommands?: FakeCommand[];
  __videoScene?: boolean;
  __videoSocket?: WebSocket;
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
    scope.__videoCommands = [];
    scope.__videoScene = false;

    const socket = new WebSocket(`ws://127.0.0.1:${clientPort}/client`);
    scope.__videoSocket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "client_hello",
          // 与 `@dts/protocol` 的 `PROTOCOL_VERSION` 一致（这里写死：e2e 不是 workspace 包，
          // 拿不到那个常量；版本一升这里会连不上、用例会当场失败，提醒同步改）
          protocolVersion: 12,
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
        scope.__videoScene = true;
        return;
      }

      if (parsed.type === "command") {
        scope.__videoCommands?.push(parsed.command ?? {});
        socket.send(
          JSON.stringify({
            type: "command_result",
            requestId: parsed.requestId,
            ok: true,
            effects: ["e2e 假前端收到视频命令"],
          }),
        );
      }
    });
  }, port);
}

/** 读回假前端收到的命令。 */
async function fakeCommands(page: Page): Promise<readonly FakeCommand[]> {
  return page.evaluate(() => (window as unknown as FakeClientWindow).__videoCommands ?? []);
}

/** 常见开头：建项目、放一张地图 + 一个**贴图**、上传两个假视频。 */
async function seed(
  project: string,
  request: APIRequestContext,
): Promise<{ a: string; b: string; mapId: string }> {
  const a = await uploadVideo(request, project, "opening.mp4");
  const b = await uploadVideo(request, project, "rain.webm");

  const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
  await seedProjectDoc(request, project, [
    // v21 起视频那一组的宿主是**贴图**（`kind: "Image"`），不是精灵——见下面那条用例
    sceneDoc(SCENE, [mapDoc, sceneObjectDoc(SPRITE, "Image", { x: 0, y: 0 })]),
  ]);
  await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));

  return { a, b, mapId: String(mapDoc.id) };
}

/**
 * 等这一笔改动**落盘**：自动存是防抖的——先变「未保存」，写完才回「已保存」。
 *
 * 直接轮询文件会说不好到底是「还没写完」还是「没写进去」；盯着底栏那个状态，
 * 失败信息才指向真正的原因（与 `object-edit.spec.ts` 的「改了就存」同一条思路）。
 */
async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "pending");
  await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "saved");
}

test.describe("地图 / 贴图：视频列表", () => {
  test("面板空态 → 窗口加两条 → 起名字 → 选一条 → 循环 / 声音 → 全部落进场景文件", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      const { a, b } = await seed(project, request);
      await openFirstObject(page, project, "网格地图");

      const video = page.locator('[data-group="video"]');
      await expect(video).toBeVisible();
      // 没开视频：整组只剩「启用」那一个开关（与战争雾那一组同一套）
      await expect(video.getByTestId("video-enable")).not.toBeChecked();
      await expect(video.getByTestId("video-edit")).toHaveCount(0);
      await expect(video.getByTestId("video-play")).toHaveCount(0);
      // 编辑器**不播放**：页面上没有任何视频播放器
      await expect(page.locator("video")).toHaveCount(0);
      expect(await readSceneVideo(request, project, SCENE)).toBeUndefined();

      // 打开「启用」：这才露出视频列表、编辑入口与那几个按钮
      await video.getByTestId("video-enable").check();
      await expect(video.getByTestId("video-empty")).toHaveText("还没加视频");
      await expect(video.getByTestId("video-edit")).toHaveText("编辑");
      await expect(video.getByTestId("video-play")).toBeDisabled();
      await expect(video.getByTestId("video-play")).toHaveAttribute("title", /先加一条视频/);
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ enabled: true, clips: [] });

      // 「编辑视频」窗口：＋ 添加视频 → 「选择视频」弹框里点两条（可连着点；已加的标「已加入」）
      await video.getByTestId("video-edit").click();
      const dialog = page.getByTestId("video-edit-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("video-edit-row")).toHaveCount(0);

      await dialog.getByTestId("video-add").click();
      const picker = page.getByTestId("video-picker-dialog");
      await expect(picker).toBeVisible();
      const item = (id: string) => picker.locator(`[data-testid="video-picker-item"][data-asset-id="${id}"]`);
      await expect(item(a)).toContainText("video/opening.mp4");
      await item(a).click();
      await item(b).click();
      await expect(item(a)).toHaveAttribute("data-added", "true");
      // webm 那条带提醒（Unity 在 Windows 上多半解不了）
      await expect(item(b)).toHaveAttribute("data-warning", "webm");
      await picker.getByTestId("video-picker-close").click();
      await expect(picker).toHaveCount(0);

      // 窗口里两行：路径看得见，名字就地改（留空 = 用文件名）
      await expect(dialog.getByTestId("video-edit-row")).toHaveCount(2);
      await expect(dialog.getByTestId("video-edit-path").first()).toHaveText("video/opening.mp4");
      await expect(dialog.getByTestId("video-edit-warning")).toHaveCount(1);
      const nameInput = dialog.locator(`[data-testid="video-edit-name"][data-clip="${a}"]`);
      await nameInput.fill("开场动画");
      await nameInput.press("Enter");
      await dialog.getByTestId("video-edit-close").click();
      await expect(dialog).toHaveCount(0);

      // 落盘：列表按加进来的顺序，第一条自动选中（加进来就能直接放）
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({
        enabled: true,
        clips: [a, b],
        picked: a,
        loop: false,
        audio: false,
        names: { [a]: "开场动画" },
      });

      // 面板上：两条小方块，名字用自定义名 / 素材名；点第二条 = 改成放它
      await expect(video.getByTestId("video-clip")).toHaveCount(2);
      await expect(video.getByTestId("video-clip").first()).toHaveText("开场动画");
      await expect(video.getByTestId("video-clip").nth(1)).toHaveText("rain");
      await video.getByTestId("video-clip").nth(1).click();
      await expect(video.getByTestId("video-clip").nth(1)).toHaveAttribute("data-selected", "true");
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ picked: b });

      // 循环 / 声音两个开关：写文档（行里只有勾选框，状态看勾没勾上）
      await video.getByTestId("video-loop").check();
      await video.getByTestId("video-audio").check();
      await expect(video.getByTestId("video-loop")).toBeChecked();
      await expect(video.getByTestId("video-audio")).toBeChecked();
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ loop: true, audio: true });

      // 「播放」现在点得动了
      await expect(video.getByTestId("video-play")).toBeEnabled();
    } finally {
      await dropProject(request, project);
    }
  });

  test("贴图也有这一组（视频盖在它自己的矩形上）；精灵 / 声音对象 / 传送阵没有", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      await seed(project, request);
      await openFirstObject(page, project, "网格地图");
      await openLeftTab(page, "hierarchy");

      // 第二个对象是**贴图**：v21 起视频那一组从精灵挪到了贴图
      await selectObject(page, 1);
      await expect(page.locator('[data-group="video"]')).toBeVisible();
      // 贴图没有地图专属那两组
      await expect(page.locator('[data-group="edit"]')).toHaveCount(0);
      await expect(page.locator('[data-group="fog"]')).toHaveCount(0);
      // **贴图**身上也能真的把视频存进去（不是「面板长出来了、数据写不进去」）
      const textureVideo = page.locator('[data-group="video"]');
      await textureVideo.getByTestId("video-enable").check();
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE, "Image")).toMatchObject({
        enabled: true,
        clips: [],
      });

      // 再建一个**精灵**（新对象落在名单末尾）：它有「渲染」、**没有**视频那一组
      await page.getByTestId("new-object").click();
      await page.getByTestId("object-type-Sprite").click();
      await page.getByTestId("confirm-object").click();
      await selectObject(page, 2);
      await expect(page.locator('[data-group="render"]')).toBeVisible();
      await expect(page.locator('[data-group="video"]')).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });
});

test.describe("视频：命令下发给前端", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("播放 / 暂停 / 继续 / 停止 → 前端收到四条命令（只带 objectId）", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      const { a, mapId } = await seed(project, request);

      // 直接在面板上配好（这一条钉的是**命令链路**，配视频的交互在上一条用例里钉过了）
      await openFirstObject(page, project, "网格地图");
      const video = page.locator('[data-group="video"]');
      await video.getByTestId("video-enable").check();
      await video.getByTestId("video-edit").click();
      const dialog = page.getByTestId("video-edit-dialog");
      await dialog.getByTestId("video-add").click();
      const picker = page.getByTestId("video-picker-dialog");
      await picker.locator(`[data-testid="video-picker-item"][data-asset-id="${a}"]`).click();
      await picker.getByTestId("video-picker-close").click();
      await dialog.getByTestId("video-edit-close").click();
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ enabled: true, picked: a });

      // 进入运行态：没点「运行」之前，前端根本连不上（503 拒握手）
      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

      // 假前端连上：拿到整份场景（说明镜像协议那条路是通的）
      await connectFakeClient(page, port);
      await page.waitForFunction(() => (window as unknown as FakeClientWindow).__videoScene === true);
      await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

      const kinds = async (): Promise<string[]> => (await fakeCommands(page)).map((item) => item.kind ?? "");

      // 播放 → play_video{objectId}
      await video.getByTestId("video-play").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "play_video").length).toBe(1);
      await expect(video.getByTestId("video-status")).toHaveAttribute("data-state", "playing");

      // 暂停 / 继续
      await video.getByTestId("video-pause").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "pause_video").length).toBe(1);
      await expect(video.getByTestId("video-status")).toHaveAttribute("data-state", "paused");

      await video.getByTestId("video-pause").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "resume_video").length).toBe(1);
      await expect(video.getByTestId("video-status")).toHaveAttribute("data-state", "playing");

      // 停止 → stop_video；界面上回到「没在放」
      await video.getByTestId("video-stop").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "stop_video").length).toBe(1);
      await expect(video.getByTestId("video-status")).toHaveAttribute("data-state", "idle");

      // 命令里**只有 objectId**：放哪一条 / 循环 / 声音都在推下去的那个对象里
      const commands = await fakeCommands(page);
      for (const command of commands) {
        expect(command.objectId).toBe(mapId);
        expect(JSON.stringify(command)).not.toContain("clips");
        expect(JSON.stringify(command)).not.toContain("loop");
      }

      // 回执 ok:true → 编辑器日志里看得见「命令 执行成功」（不假装成功、也不超时）
      await expect(page.getByText(/命令\s*执行成功/).first()).toBeVisible();

      // 收尾：退出运行态（前端会被踢下线）
      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    } finally {
      await page.evaluate(() => {
        (window as unknown as FakeClientWindow).__videoSocket?.close();
      });
      await dropProject(request, project);
    }
  });
});
