import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  CURRENT_SCENE_FORMAT_VERSION,
  closeBgmDialog,
  dropProject,
  enterEditor,
  newProject,
  openBgmDialog,
  openMenu,
  openProject,
  readAudioMeta,
  readProjectAudioTags,
  readProjectFormatVersion,
  readProjectSettings,
  seedProjectAudioMeta,
  seedProjectDoc,
} from "./helpers/editor";

/**
 * **背景音乐**（v16）：顶栏「音乐」弹框 + 四条命令，与项目设置**分离**。
 *
 * 这一份走**真浏览器**钉四件事（措辞与纯逻辑在 `apps/editor/test/bgm-*.test.*`）：
 * 1. 弹框里列出的就是**项目 `Assets/audio/` 下的音频**（按名字排、可搜、标签靠勾），
 *    点一首就发一条 `play_bgm{clip}`；
 * 2. **工程文件里没有歌单**：`settings.audio.bgm` 只有 `volume`，也没有默认曲 / 循环 / 名字；
 * 3. 进运行态**不会自动出声**（没有「默认曲」这回事了），播放权全在 DM 手上；
 * 4. 暂停 / 继续 / 停止各一条命令；前端（重）连上后补发记账里的那一首。
 *
 * 真前端（Unity）出声在 `client/` 那边验（见 client/README 的验收清单）。
 */

const SCENE = "Map001";

/** 把一段假音频提交到 `Assets/audio/`（内容无所谓：这里的假前端不解析音频）。 */
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

/** 假前端收到的一条命令（背景音乐这一组只关心 kind / clip）。 */
interface FakeBgmCommand {
  readonly kind?: string;
  readonly clip?: string;
}

interface FakeBgmWindow {
  __bgmCommands?: FakeBgmCommand[];
  __bgmScene?: boolean;
  __bgmSockets?: WebSocket[];
  __bgmConnect?: () => void;
}

/** 运行态是服务端全局单例：只在一个档位上跑，免得并行档位互相开关。 */
function skipOutsideDesktop(testInfo: TestInfo): void {
  test.skip(
    !testInfo.project.name.startsWith("desktop"),
    "运行态是全局状态：只在一个档位上跑，免得并行档位互相开关",
  );
}

/**
 * 在页面里装一只**假前端**：握手、收场景、把命令记下来并按协议回执。
 *
 * 装一次、可以连多次（`__bgmConnect()`）：用例要验「掉线再连上会补发」，
 * 而命令列表在两次连接之间**不清空**（否则看不出补发）。
 */
async function installFakeBgmClient(page: Page, port: number): Promise<void> {
  await page.evaluate((clientPort) => {
    const scope = window as unknown as FakeBgmWindow;
    scope.__bgmCommands = [];
    scope.__bgmScene = false;
    scope.__bgmSockets = [];

    scope.__bgmConnect = () => {
      const socket = new WebSocket(`ws://127.0.0.1:${clientPort}/client`);
      scope.__bgmSockets?.push(socket);

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
          command?: FakeBgmCommand;
          project?: string | null;
        };

        if (parsed.type === "resources_prepare") {
          // 假装资源包已经下完（背景音乐要在这个包里的音频才能放出来）
          socket.send(
            JSON.stringify({
              type: "resources_ready",
              project: String(parsed.project ?? "e2e"),
              fingerprint: "e2e",
              fileCount: 1,
              bytes: 1,
              ok: true,
            }),
          );
          return;
        }

        if (parsed.type === "scene_sync") {
          scope.__bgmScene = true;
          return;
        }

        if (parsed.type === "command") {
          scope.__bgmCommands?.push(parsed.command ?? {});
          socket.send(
            JSON.stringify({
              type: "command_result",
              requestId: parsed.requestId,
              ok: true,
              effects: ["e2e 假前端收到背景音乐命令"],
            }),
          );
        }
      });
    };
  }, port);
}

const connectFakeBgmClient = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as FakeBgmWindow).__bgmConnect?.());

const fakeBgmCommands = async (page: Page): Promise<readonly FakeBgmCommand[]> =>
  page.evaluate(() => (window as unknown as FakeBgmWindow).__bgmCommands ?? []);

const fakeBgmKinds = async (page: Page): Promise<string[]> =>
  (await fakeBgmCommands(page)).map((item) => item.kind ?? "");

/** 关掉假前端的全部连接（用例收尾 + 「掉线」那一步都用它）。 */
const closeFakeBgmSockets = async (page: Page): Promise<void> =>
  page.evaluate(() => {
    for (const socket of (window as unknown as FakeBgmWindow).__bgmSockets ?? []) {
      socket.close();
    }

    (window as unknown as FakeBgmWindow).__bgmSockets = [];
  });

test.describe("背景音乐：清单来自项目音频，与项目设置分离", () => {
  test("弹框列出 Assets/audio 下的音频（可搜）；工程文件里没有任何歌单字段", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);

    try {
      await uploadAudio(request, project, "theme.mp3");
      await uploadAudio(request, project, "battle.wav");
      await uploadAudio(request, project, "rain.ogg", "audio/environment");
      await seedProjectDoc(request, project, [{ name: SCENE, objects: [] }]);

      await enterEditor(page);
      await openProject(page, project);

      await openBgmDialog(page);

      // 清单 = 项目音频（按显示名排序：battle < rain < theme）；路径**默认不露**
      await expect(page.getByTestId("bgm-track")).toHaveCount(3);
      await expect(page.getByTestId("bgm-list")).toContainText("battle");
      await expect(page.getByTestId("bgm-track").nth(0)).toContainText("battle");
      await expect(page.getByTestId("bgm-track").nth(1)).toContainText("rain");
      await expect(page.getByTestId("bgm-list")).not.toContainText("audio/environment");

      // 「路径」开关：点开才在行右边显示路径，再点一下收回去
      await page.getByTestId("bgm-paths-toggle").click();
      await expect(page.getByTestId("bgm-list")).toContainText("audio/environment");
      await page.getByTestId("bgm-paths-toggle").click();
      await expect(page.getByTestId("bgm-list")).not.toContainText("audio/environment");

      // 搜索按文件名 / 路径过滤
      await page.getByTestId("bgm-search").fill("rain");
      await expect(page.getByTestId("bgm-track")).toHaveCount(1);
      await page.getByTestId("bgm-search").fill("nope");
      await expect(page.getByTestId("bgm-empty")).toContainText("没有匹配的音频");
      await page.getByTestId("bgm-search").fill("");

      await closeBgmDialog(page);

      // 工程文件里**没有歌单**（也没有默认曲 / 循环 / 名字）：迁移把 v4 的工程文件升到当前版本
      await expect
        .poll(async () => await readProjectFormatVersion(request, project), {
          timeout: 8000,
          message: "等待工程文件升到当前版本",
        })
        .toBe(CURRENT_SCENE_FORMAT_VERSION);

      const audio = await readProjectSettings(request, project);
      expect(audio?.bgm?.volume).toBe(0.6);
      const serialized = JSON.stringify(audio);
      for (const gone of ["clips", "picked", "names", "loop"]) {
        expect(serialized).not.toContain(gone);
      }
    } finally {
      await dropProject(request, project);
    }
  });

  test("「工程 → 全局设置…」里只有三档音量；改了会落盘（歌单 / 默认曲 / 循环都不在）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);

    try {
      await uploadAudio(request, project, "theme.mp3");
      await seedProjectDoc(request, project, [{ name: SCENE, objects: [] }]);

      await enterEditor(page);
      await openProject(page, project);

      await openMenu(page, "工程");
      await page.getByRole("menuitem", { name: /^全局设置/ }).click();

      await expect(page.getByTestId("global-settings-dialog")).toBeVisible();
      await expect(page.getByTestId("volume-bgm")).toBeVisible();
      await expect(page.getByTestId("volume-sfx")).toBeVisible();
      await expect(page.getByTestId("volume-voice")).toBeVisible();
      // 歌单 / 默认曲 / 循环那一套已经不在这里了
      await expect(page.getByTestId("bgm-list")).toHaveCount(0);
      await expect(page.getByTestId("bgm-add")).toHaveCount(0);
      await expect(page.getByTestId("bgm-loop")).toHaveCount(0);
      await expect(page.getByTestId("bgm-default")).toHaveCount(0);

      await page.getByTestId("volume-bgm").fill("0.2");
      await expect(page.getByTestId("global-settings-dialog")).toContainText("背景音乐放哪一首");
      await page.getByTestId("global-settings-close").click();

      await expect
        .poll(async () => (await readProjectSettings(request, project))?.bgm?.volume, {
          timeout: 8000,
          message: "等待音量落盘",
        })
        .toBe(0.2);
    } finally {
      await dropProject(request, project);
    }
  });
});

test.describe("背景音乐：命令下发给前端", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("点一首 → play_bgm{clip}；暂停 · 继续 / 停止；掉线重连补发当前那一首", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      // 排序按**显示名**：`battle` < `theme`，第一行是 battle
      const battle = await uploadAudio(request, project, "battle.wav");
      await uploadAudio(request, project, "theme.mp3");
      await seedProjectDoc(request, project, [{ name: SCENE, objects: [] }]);

      // 标注要在**进运行态之前**配好：运行态里改素材 meta 不落盘（退出运行会还原）。
      // 这一条只关心「按名字 / 标签找 → 点播」，所以标签表与各音频文件的标注直接写盘
      // （在界面里改的那条路走 `audio-meta.spec.ts`）。
      await seedProjectAudioMeta(request, project, {
        tags: ["战斗"],
        meta: { [battle]: { name: "战斗曲", tags: [0] } },
      });

      await enterEditor(page);
      await openProject(page, project);

      await test.step("素材 meta 里读得到标注（音频文件记整数 ID，名字在标签表里）", async () => {
        await expect
          .poll(async () => (await readAudioMeta(request, battle))?.name, {
            timeout: 8000,
            message: "等待素材 meta 读出标注",
          })
          .toBe("战斗曲");
        expect((await readAudioMeta(request, battle))?.tags).toEqual([0]);
        // 标签表是**项目级**数据，仍在工程文件里
        expect(await readProjectAudioTags(request, project)).toEqual(["战斗"]);
      });

      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

      await installFakeBgmClient(page, port);
      await connectFakeBgmClient(page);
      await page.waitForFunction(() => (window as unknown as FakeBgmWindow).__bgmScene === true);
      await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

      await test.step("进运行态不会自动出声（没有默认曲这回事了）", async () => {
        await page.waitForTimeout(400);
        expect(await fakeBgmCommands(page)).toEqual([]);
        await expect(page.getByTestId("bgm-control")).toContainText("背景音乐");
      });

      await test.step("按名字找到它，点一首就发一条 play_bgm{clip}；标签靠勾选筛", async () => {
        await openBgmDialog(page);

        // 搜索框只管名字 / 路径 / 文件名（标签不归它管，v19 起）
        await page.getByTestId("bgm-search").fill("战斗曲");
        await expect(page.getByTestId("bgm-track")).toHaveCount(1);
        await expect(page.getByTestId("bgm-track").first()).toContainText("战斗曲");
        await page.getByTestId("bgm-search").fill("");

        // 标签是**勾的**：清单上方那一排点一下 = 按它筛，再点一下取消
        await page.getByTestId("bgm-tag-option").click();
        await expect(page.getByTestId("bgm-tag-option")).toHaveAttribute("data-selected", "true");
        await expect(page.getByTestId("bgm-track")).toHaveCount(1);
        await page.getByTestId("bgm-tag-option").click();
        await expect(page.getByTestId("bgm-tag-option")).toHaveAttribute("data-selected", "false");
        await expect(page.getByTestId("bgm-track")).toHaveCount(2);

        // 点行只**选中**，不出声：会出声的键只有底部那一排（播放 / 暂停 / 停止）
        await page.getByTestId("bgm-track").first().click();
        await expect(page.getByTestId("bgm-track").first()).toHaveAttribute("data-selected", "true");
        await page.waitForTimeout(200);
        expect((await fakeBgmKinds(page)).filter((kind) => kind === "play_bgm")).toHaveLength(0);

        await page.getByTestId("bgm-play").click();

        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "play_bgm").length)
          .toBe(1);
        expect((await fakeBgmCommands(page)).at(-1)).toEqual({ kind: "play_bgm", clip: battle });

        // 再按一次播放：还是真发一条（前端从头重播）
        await page.getByTestId("bgm-play").click();
        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "play_bgm").length)
          .toBe(2);
      });

      await test.step("关掉再打开：正在放的那一首还是「选中的」", async () => {
        await closeBgmDialog(page);
        await openBgmDialog(page);

        // 选中 / 播放态都在 store 里：弹框只是把它画出来（不靠弹框自己记）
        await expect(page.getByTestId("bgm-track").first()).toHaveAttribute("data-selected", "true");
        await expect(page.getByTestId("bgm-track").first()).toHaveAttribute("data-playing", "true");
        await expect(page.getByTestId("bgm-track").first()).toContainText("●");
        await expect(page.getByTestId("bgm-status")).toContainText("正在放");
        await expect(page.getByTestId("bgm-pause")).toContainText("暂停");
      });

      await test.step("暂停 / 继续 / 停止各一条", async () => {
        await page.getByTestId("bgm-pause").click();
        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "pause_bgm").length)
          .toBe(1);

        await page.getByTestId("bgm-pause").click();
        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "resume_bgm").length)
          .toBe(1);

        await page.getByTestId("bgm-stop").click();
        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "stop_bgm").length)
          .toBe(1);
        // 没在放就什么都不写（那句「没在放」是废话：暂停 / 停止灰着已经说明了），选中还在
        await expect(page.getByTestId("bgm-status")).toHaveText("");
        await expect(page.getByTestId("bgm-play")).toBeEnabled();
      });

      await test.step("掉线重连：补发记账里的那一首", async () => {
        // 停过一次之后那一首还选着：再按播放 = 从头放
        await page.getByTestId("bgm-play").click();
        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "play_bgm").length)
          .toBe(3);

        // 掉线（假前端全部关掉）→ 等编辑器看见「前端不在了」→ 再连一只新的
        await closeFakeBgmSockets(page);
        await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "no");

        await connectFakeBgmClient(page);
        await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

        // 补发一条 play_bgm{battle}（停过一次之后又重新点的那一首）
        await expect
          .poll(async () => (await fakeBgmKinds(page)).filter((kind) => kind === "play_bgm").length)
          .toBe(4);
        expect((await fakeBgmCommands(page)).at(-1)).toEqual({ kind: "play_bgm", clip: battle });
      });

      // 回执 ok:true → 编辑器日志里看得见「命令 执行成功」
      await expect(page.getByText(/命令\s*执行成功/).first()).toBeVisible();

      // 走出运行态之前先把弹框收起来：Radix 的模态开着时会吃掉全页的指针事件
      await closeBgmDialog(page);
      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    } finally {
      // 收尾要**稳**：页面已经关掉时 `page.evaluate` 会抛，那会把真正的失败点盖掉
      await closeFakeBgmSockets(page).catch(() => undefined);
      await dropProject(request, project);
    }
  });
});
