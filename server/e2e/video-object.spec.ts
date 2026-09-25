import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  closeDrawers,
  dropProject,
  mapObjectDoc,
  newProject,
  openFirstObject,
  openLeftTab,
  readSceneVideo,
  sceneDoc,
  gameObjectDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";

/**
 * 地图 / 精灵上的**视频**（v14 起）：加一组视频，运行时选一条放。
 *
 * 两半：
 * 1. **编辑器怎么配**（不需要运行态）：面板「视频」组 → 小方块单选放哪条、`×` /「清空」移出、
 *    `＋` 添加 → 循环 / 声音两个开关 → 都落进场景文件的 `video` 字段；
 *    （清单管理全在面板上，没有别的窗口；显示名在**文件属性**上改。）
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
    sceneDoc(SCENE, [mapDoc, gameObjectDoc(SPRITE, "Image", { x: 0, y: 0 })]),
  ]);
  await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));

  return { a, b, mapId: String(mapDoc.id) };
}

/**
 * 等自动保存完成。`pending` 是短暂状态，输入操作返回前可能已经过去；下方每处调用
 * 都会继续读取场景文件并断言具体数据，保存状态只负责同步时机。
 */
async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "saved");
}

test.describe("地图 / 贴图：视频列表", () => {
  test("面板空态 → 添加两条 → 选一条 → 循环 / 声音 → 全部落进场景文件", async ({
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
      await expect(video.getByTestId("video-clips")).toHaveCount(0);
      await expect(video.getByTestId("video-play")).toHaveCount(0);
      // 编辑器**不播放**：页面上没有任何视频播放器
      await expect(page.locator("video")).toHaveCount(0);
      expect(await readSceneVideo(request, project, SCENE)).toBeUndefined();

      // 打开「启用」：这才露出视频列表、＋ 添加与那几个按钮
      await video.getByTestId("video-enable").check();
      await expect(video.getByTestId("video-empty")).toHaveText("还没加视频");
      await expect(video.getByTestId("video-add")).toBeVisible();
      await expect(video.getByTestId("video-play")).toBeDisabled();
      await expect(video.getByTestId("video-play")).toHaveAttribute("title", /先加一条视频/);
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ enabled: true, clips: [] });

      // 「＋ 添加视频」直接弹「选择视频」：选中一条 → 点「添加」加入（一次一条，弹框随即关闭）
      await video.getByTestId("video-add").click();
      const picker = page.getByTestId("video-picker-dialog");
      await expect(picker).toBeVisible();
      const item = (id: string) => picker.locator(`[data-testid="video-picker-item"][data-asset-id="${id}"]`);
      await expect(item(a)).toHaveAttribute("title", /video\/opening\.mp4/);
      await item(a).click();
      await picker.getByTestId("video-picker-add").click();
      await expect(picker).toHaveCount(0);
      // 加第二条：重新打开，再一次一条；webm 那条带提醒（Unity 在 Windows 上多半解不了）
      await video.getByTestId("video-add").click();
      const picker2 = page.getByTestId("video-picker-dialog");
      await picker2.locator(`[data-testid="video-picker-item"][data-asset-id="${b}"]`).click();
      await expect(picker2.locator(`[data-testid="video-picker-item"][data-asset-id="${b}"]`)).toHaveAttribute("data-warning", "webm");
      await picker2.getByTestId("video-picker-add").click();
      await expect(picker2).toHaveCount(0);

      // 面板上两条小方块：只读显示名（起名在文件属性上改），webm 那条的 tooltip 里带着提醒
      await expect(video.getByTestId("video-clip")).toHaveCount(2);
      await expect(video.getByTestId("video-clip").first()).toHaveText("opening");
      await expect(video.getByTestId("video-clip").nth(1)).toHaveText("rain");
      await expect(video.getByTestId("video-clip").nth(1)).toHaveAttribute(
        "title",
        /WebM：Windows 上多半解不了/,
      );

      // 落盘：列表按加进来的顺序，第一条自动选中（加进来就能直接放）。
      //
      // **这里比的是结构，不是具体 id**：场景文件按设计存的是**素材 GUID**、不是逻辑路径
      // （`sceneAssetRefsToGuids`：内存里是逻辑 ID，落盘换成 GUID，这样改文件名不会断引用）。
      // 所以断言「两条、顺序保持、第一条被选中」，id 用 32 位十六进制匹配；
      // 「顺序 = [a, b]」由上面 UI 那条断言（小方块依次是「opening」「rain」）兜住。
      await waitForSaved(page);
      const saved = await readSceneVideo(request, project, SCENE);
      const guid = /^[0-9a-f]{32}$/;
      expect(saved).toMatchObject({ enabled: true, loop: false, audio: false });
      expect(saved?.clips).toHaveLength(2);
      expect(saved?.clips?.[0]).toMatch(guid);
      expect(saved?.clips?.[1]).toMatch(guid);
      expect(saved?.clips?.[0]).not.toBe(saved?.clips?.[1]);
      expect(saved?.picked).toBe(saved?.clips?.[0]);

      // 点第二条 = 改成放它；小方块上的 × = 移出那一条
      await video.getByTestId("video-clip").nth(1).click();
      await expect(video.getByTestId("video-clip").nth(1)).toHaveAttribute("data-selected", "true");
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ picked: saved?.clips?.[1] });

      // 小方块上的 ×：移出那一条（素材文件不会被删）；移走的正好是选中的 → 选中顺到剩下的那条
      await video.locator(`[data-testid="video-clip-remove"][data-clip="${b}"]`).click();
      await expect(video.getByTestId("video-clip")).toHaveCount(1);
      await waitForSaved(page);
      expect(await readSceneVideo(request, project, SCENE)).toMatchObject({ picked: saved?.clips?.[0] });

      // 重新加回第二条（循环 / 声音断言要数）：一次一条
      await video.getByTestId("video-add").click();
      const repick = page.getByTestId("video-picker-dialog");
      await repick.locator(`[data-testid="video-picker-item"][data-asset-id="${b}"]`).click();
      await repick.getByTestId("video-picker-add").click();
      await expect(repick).toHaveCount(0);
      await expect(video.getByTestId("video-clip")).toHaveCount(2);
      await video.getByTestId("video-clip").nth(1).click();

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
      //
      // 先关掉两个抽屉：`openFirstObject` 会把属性面板（平板下是**右抽屉**）露出来，
      // 而「对象」按钮在场景标题栏的**最右端**——竖屏平板上正好被右抽屉的遮罩盖住，
      // 直接点会一直等可点击直到用例超时。桌面档位没有抽屉，这个调用是空操作。
      await closeDrawers(page);
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
      await video.getByTestId("video-add").click();
      const picker = page.getByTestId("video-picker-dialog");
      await picker.locator(`[data-testid="video-picker-item"][data-asset-id="${a}"]`).click();
      await picker.getByTestId("video-picker-add").click();
      await waitForSaved(page);
      // 落盘是 **GUID**（见上一条用例的说明）；这里只关心「有一条被选中」，具体是哪条由面板单选钉住
      const runtimeSaved = await readSceneVideo(request, project, SCENE);
      expect(runtimeSaved).toMatchObject({ enabled: true });
      expect(runtimeSaved?.clips).toHaveLength(1);
      expect(runtimeSaved?.picked).toBe(runtimeSaved?.clips?.[0]);

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
