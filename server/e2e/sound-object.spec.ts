import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  COMPONENT,
  closeDrawers,
  dropProject,
  enterEditor,
  newProject,
  openFirstObject,
  openInspector,
  openLeftTab,
  openProject,
  readSceneSound,
  sceneDoc,
  gameObjectDoc,
  seedProjectDoc,
  selectObject,
  useMoveTool,
  withComponent,
} from "./helpers/editor";
import { canvasAverageColor, offsetFrom, preciseWorldPoint, worldSamplePoint } from "./helpers/canvas";

/**
 * **声音对象**（动作对象）：弹框里「动作」种类下的「播放声音」。
 *
 * 它和实体一样摆在世界里（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上是一枚**固定的
 * 内置音频图标**（不给换贴图，能点选、能拖），另带自己的东西：**加进来的音频列表 + 选中的
 * 那条**（面板上单选，前端播的就是它）与**层级**（同层同时只响一条）。
 * 编辑器**不播放**——这里既钉住「画布上看得见、点得到、拖得动」，也钉住「页面上没有播放器」。
 *
 * 清单的**全部管理都在属性面板的「声音」组里**：小方块单选（播哪条）、`×` 移出一条、
 * 「清空」全部移出、`＋` 从项目素材里**添加**（弹「选择音频」）。没有别的窗口；
 * 显示名在**文件属性**上改。
 */

const SCENE = "Map001";

/** 把一段假音频提交到 `Assets/audio/`（内容无所谓：编辑器不解析音频、也不播放）。 */
async function uploadAudio(
  request: APIRequestContext,
  project: string,
  name: string,
): Promise<string> {
  const id = `project:${project}/Assets/audio/${name}`;
  const response = await request.put(`/api/resources/raw?id=${encodeURIComponent(id)}`, {
    headers: { "content-type": "audio/mpeg" },
    data: Buffer.from(`not-really-audio:${name}`),
  });
  expect(response.ok()).toBeTruthy();
  return id;
}

/** 某个屏幕点的「暖度」（r − g）：音频图标的牌面是暖橙，棋盘底纹是中性灰。 */
async function redness(page: Page, point: { x: number; y: number }): Promise<number> {
  const color = await canvasAverageColor(page, point, 12);
  return color.r - color.g;
}

test.describe("动作对象：播放声音", () => {
  test("新建 → 窗口里加 / 移出音频 → 面板上换选 → 落盘；编辑器只存数据、不播放", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      const step1 = await uploadAudio(request, project, "step1.mp3");
      const step2 = await uploadAudio(request, project, "step2.mp3");
      const step3 = await uploadAudio(request, project, "step3.mp3");

      await seedProjectDoc(request, project, [sceneDoc(SCENE, [])]);
      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 新建对象 →「动作」→「播放声音」（名字按类型预填）
      await page.getByTestId("new-object").click();
      await page.getByTestId("object-category-action").click();
      await page.getByTestId("object-type-PlaySound").click();
      await expect(page.getByTestId("object-name-input")).toHaveValue("播放声音");
      await page.getByTestId("confirm-object").click();
      await expect(page.getByTestId("object-dialog")).toHaveCount(0);

      // 列表：动作种类筛得出来；行尾显示层级
      await expect(page.getByTestId("category-filter-action")).toBeVisible();
      await page.getByTestId("category-filter-action").click();
      const row = page.getByTestId("object-row").first();
      await expect(row).toHaveAttribute("data-kind", "PlaySound");
      await expect(row).toContainText("音效");

      // 属性面板：基础和实体一样（位置 / 缩放 / 锁定 / 显示顺序都在），另有「声音」；
      // **没有「渲染」**——图标是固定的内置图标，不给换贴图
      await selectObject(page, 0);
      await expect(page.locator('[data-group="sound"]')).toBeVisible();
      await expect(page.locator('[data-group="render"]')).toHaveCount(0);
      await expect(page.getByTestId("pick-texture")).toHaveCount(0);
      await expect(page.getByTestId("inspector-object-x")).toHaveValue("0");
      await expect(page.getByTestId("inspector-object-scale")).toHaveValue("1");
      await expect(page.getByLabel("声音层级")).toHaveValue("sfx");

      // **编辑器不播放**：页面上没有任何播放器（音频试听不在这个功能里）
      await expect(page.locator("audio")).toHaveCount(0);

      /*
        面板行序是 层级 → 音频 → 播放（层级在上面）；「音频」那一行自己就是清单管理：
        小方块（单选播哪条）+ ＋ 添加 + 清空。
        控件行与「视频」那一组**完全一致**：播放 / 暂停 / 停止 + 一行状态。
        一条都没加时写明「还没加音频」。
      */
      const panelOrder = await page
        .locator('[data-group="sound"] [data-testid^="sound-"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
      expect(panelOrder).toEqual([
        "sound-layer",
        // 「音频」那一行的容器（现在里面只有「还没加音频」＋ ＋ 添加）
        "sound-clips",
        "sound-empty",
        "sound-add",
        "sound-play",
        "sound-pause",
        "sound-stop",
        // 按钮下面那行小字：现在在播什么（点下去有没有生效一眼看得见）
        "sound-status",
      ]);
      await expect(page.getByTestId("sound-empty")).toHaveText("还没加音频");
      await expect(page.locator('[data-group="sound"]')).not.toContainText("audio/");

      // 「＋ 添加」弹「选择音频」：列出项目里的音频（带路径），点一条就加进来
      await page.getByTestId("sound-add").click();
      const picker = page.getByTestId("audio-picker-dialog");
      await expect(picker).toBeVisible();
      const pickItem = (id: string) =>
        picker.locator(`[data-testid="audio-picker-item"][data-asset-id="${id}"]`);
      await expect(pickItem(step1)).toContainText("audio/step1.mp3");
      await pickItem(step1).click();
      await pickItem(step2).click();
      await pickItem(step3).click();
      // 加过的标「已加入」（不会再重复加）
      await expect(pickItem(step1)).toHaveAttribute("data-added", "true");
      await picker.getByTestId("audio-picker-close").click();
      await expect(picker).toHaveCount(0);

      // 面板：**加进来的音频全列出来**（小方块）；加进来的第一条自动是「播的那条」
      const chips = page.getByTestId("sound-clip");
      await expect(chips).toHaveCount(3);

      // 加错了可以移出：点小方块上的 ×（素材文件不会被删）
      await page.locator(`[data-testid="sound-clip-remove"][data-clip="${step3}"]`).click();
      await expect(chips).toHaveCount(2);
      await expect(page.getByTestId("sound-clips")).not.toContainText("step3");

      // 小方块只读显示显示名（没起过 = 文件名）；起名在**文件属性**上改
      await expect(chips.nth(0)).toHaveText("step1");
      await expect(chips.nth(1)).toHaveText("step2");
      await expect(chips.nth(0)).toHaveAttribute("data-selected", "true");
      await expect(chips.nth(1)).toHaveAttribute("data-selected", "false");

      // 换选就在面板上点（单选）：点第二条 → 播的就换成它（清单不动）
      await chips.nth(1).click();
      await expect(chips.nth(1)).toHaveAttribute("data-selected", "true");
      await expect(chips.nth(0)).toHaveAttribute("data-selected", "false");
      await expect(chips.nth(1)).toHaveAttribute("title", /audio\/step2\.mp3/);

      // 「清空」一次全部移出（素材文件不会被删）
      await page.getByTestId("sound-clear").click();
      await expect(page.getByTestId("sound-empty")).toHaveText("还没加音频");

      // 重新加两条（下面落盘断言要数）
      await page.getByTestId("sound-add").click();
      const repick = page.getByTestId("audio-picker-dialog");
      await repick.locator(`[data-testid="audio-picker-item"][data-asset-id="${step1}"]`).click();
      await repick.locator(`[data-testid="audio-picker-item"][data-asset-id="${step2}"]`).click();
      await repick.getByTestId("audio-picker-close").click();
      await expect(page.getByTestId("sound-clip")).toHaveCount(2);
      // 加进来的第一条自动是「播的那条」；再点第二条 → 播的就换成它
      await page.getByTestId("sound-clip").nth(1).click();

      // 换层级：音效 → 旁白（**背景音乐不在对象上**了：v15 起它是项目级全局设置，
      // 见 `global-bgm.spec.ts`；这里只留音效 / 旁白两档）
      await page.getByLabel("声音层级").selectOption("voice");
      await expect(row).toContainText("旁白");

      // 落盘：加进来的清单 + 选中的那条 + 层级，对象和实体一样摆在世界原点。
      //
      // **这里比结构、不比具体 id**：场景文件按设计存**素材 GUID**而不是逻辑路径
      // （`sceneAssetRefsToGuids`：内存里是逻辑 ID，落盘换 GUID，这样改文件名不会断引用）。
      // 「哪条是哪条」由上面那几条 UI 断言兜住——小方块依次是 step1 与 step2，
      // 且点第二条之后选中的是第二条。
      await expect
        .poll(async () => {
          const saved = await readSceneSound(request, project, SCENE);
          if (saved === undefined) {
            return null;
          }

          const clips = saved.clips ?? [];
          return {
            clipCount: clips.length,
            allGuids: clips.every((clip) => /^[0-9a-f]{32}$/.test(clip)),
            distinct: new Set(clips).size === clips.length,
            picked: saved.picked === clips[1] ? "second" : saved.picked === clips[0] ? "first" : "other",
            layer: saved.layer,
            position: saved.position,
          };
        })
        .toEqual({
          clipCount: 2,
          allGuids: true,
          distinct: true,
          picked: "second",
          layer: "voice",
          position: { x: 0, y: 0 },
        });
    } finally {
      await dropProject(request, project);
    }
  });

  test("世界里看得见：画布上是一枚音频徽标，能点选、能拖", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 一个摆在世界原点的声音对象（手写文件里的样子：kind + PlaySound 组件）
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          withComponent(
            gameObjectDoc("脚步", "PlaySound", { x: 0, y: 0 }),
            COMPONENT.playSound,
            { clips: [], layer: "sfx" },
          ),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 像素采样与点击都用**精确**换算：采样点必须落在图标上，点击点必须落在 7px 级别的
      // 手柄上——两者都不能用「世界原点 = 画布中心」那条近似
      const origin = await preciseWorldPoint(page, { x: 0, y: 0 });

      // 1) 画出来了：牌面是**实色**暖橙（暖度很高），旁边的棋盘底纹是中性灰（暖度 ≈ 0）
      const plainRedness = await redness(page, await preciseWorldPoint(page, { x: 240, y: 0 }));
      await expect.poll(() => redness(page, origin)).toBeGreaterThan(plainRedness + 20);

      // 2) 点得到：拾取用的还是那块显示矩形（与实体同一套）
      await page.mouse.click(origin.x, origin.y);
      const soundRow = page.getByTestId("object-row").first();
      await expect(soundRow).toHaveAttribute("data-kind", "PlaySound");
      await expect(soundRow).toHaveAttribute("data-selected", "true");

      // 3) 用手柄移动它：位置跟着走，并自动落盘。
      //    注意是「移动」工具——拖动工具只平移画布，对象本体不会被跟手拖走。
      //    先把对象挪到**画布靠左**：平板竖屏下属性是覆盖式右抽屉，对象摆在正中时
      //    它右侧的手柄会正好落在抽屉底下（那一下就点不中）
      await openInspector(page);
      await page.getByTestId("inspector-object-x").fill("-200");
      await page.getByTestId("inspector-object-y").fill("0");
      await page.getByTestId("inspector-object-y").blur();
      await expect(page.getByTestId("inspector-object-x")).toHaveValue("-200");
      await closeDrawers(page);
      await useMoveTool(page);
      await closeDrawers(page);

      const moved = await preciseWorldPoint(page, { x: -200, y: 0 });
      const axis = await offsetFrom(page, moved, { x: 105, y: 0 });
      const to = await offsetFrom(page, axis, { x: 120, y: 0 });
      await page.mouse.move(axis.x, axis.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();

      await expect
        .poll(async () => (await readSceneSound(request, project, SCENE))?.position?.x ?? 0)
        .toBeGreaterThan(-100);
    } finally {
      await dropProject(request, project);
    }
  });

  /**
   * 未放置（`position: null`）的声音对象：**画布上什么也画不出来**——没有位置就没有那块
   * 显示矩形（与没落位的精灵同一个口径），所以旧文件 / 手写文件里的这种对象要「落位」才看得见。
   * 这里把那条路钉住：列表写明「未放置」→ 属性面板给个坐标 → 图标出现并落盘。
   */
  test("未放置的声音对象要落位才看得见（列表写明「未放置」，给坐标后图标出现）", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      // 手写文件里的样子：有 kind 与 PlaySound 组件，但 position 是 null
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          withComponent(
            gameObjectDoc("脚步", "PlaySound", null),
            COMPONENT.playSound,
            { clips: [], layer: "sfx" },
          ),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");

      // 列表写明「未放置」，画布上没有它（世界原点那块就是空底纹）
      const row = page.getByTestId("object-row").first();
      await expect(row).toContainText("未放置");

      const origin = await worldSamplePoint(page, { x: 0, y: 0 });
      const plainRedness = await redness(page, await worldSamplePoint(page, { x: 240, y: 0 }));
      expect(await redness(page, origin)).toBeLessThan(plainRedness + 6);

      // 属性面板给一个坐标（这里点「落位」= 一键放到世界原点）→ 图标立刻出现
      await selectObject(page, 0);
      await expect(page.getByTestId("place-object-at-origin")).toBeVisible();
      await page.getByTestId("place-object-at-origin").click();

      await expect.poll(() => redness(page, origin)).toBeGreaterThan(plainRedness + 20);
      await expect(row).not.toContainText("未放置");
      await expect
        .poll(async () => (await readSceneSound(request, project, SCENE))?.position)
        .toEqual({ x: 0, y: 0 });
    } finally {
      await dropProject(request, project);
    }
  });

  /**
   * 播放 / 停止按钮的**能不能点**：随时都能点——编辑器只**记账**（哪一层该播什么），
   * 连上了就下发，没连上就等前端连上补发。所以这里钉住「点得动 + 记账 + 不写文档」。
   *
   * 「前端已连 + 真回执 + 连上补发」那条链路在 `apps/backend/test/runtime-hub.test.ts`
   * 与 `apps/editor/test/sound-playback.test.ts` 里钉（不在 e2e 常驻一个 mock：
   * 那会让所有并行用例都看到一个「已连接的前端」）。
   */
  test("播放 / 停止随时可点：编辑态点一下只记账，不写文档", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 一条音频素材：窗口里才加得进来
      const step1 = await uploadAudio(request, project, "step1.mp3");

      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          withComponent(
            gameObjectDoc("脚步", "PlaySound", { x: 0, y: 0 }),
            COMPONENT.playSound,
            { clips: [], layer: "sfx" },
          ),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      await selectObject(page, 0);

      const play = page.getByTestId("sound-play");
      const stop = page.getByTestId("sound-stop");

      // 编辑态（编辑器还没连服务端）：两个按钮都**点得动**，title 写明白「已记录、等连上补发」；
      // 一条音频都没加 → 「播放」置灰，「停止」照样能点
      await expect(play).toBeDisabled();
      await expect(play).toHaveAttribute("title", /先加一条音频/);
      await expect(stop).toBeEnabled();
      await expect(stop).toHaveAttribute("title", /已记录：编辑器还没连上服务端/);

      // 点「＋ 添加」加一条 → 它自动成为「播的那条」，「播放」可以点了
      await page.getByTestId("sound-add").click();
      const picker = page.getByTestId("audio-picker-dialog");
      await expect(picker).toBeVisible();
      await picker.locator(`[data-testid="audio-picker-item"][data-asset-id="${step1}"]`).click();
      await picker.getByTestId("audio-picker-close").click();
      await expect(picker).toHaveCount(0);

      await expect(page.getByTestId("sound-clip")).toHaveCount(1);
      await expect(page.getByTestId("sound-clip")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("sound-clip")).toHaveText("step1");
      await expect(play).toBeEnabled();
      await expect(play).toHaveAttribute("title", /已记录：编辑器还没连上服务端/);

      // 点「播放」：**看得见的变化** —— 按钮写成「播放中」并高亮，旁边写明正在播放什么；
      // 只记账 + 下发指令 —— 页面上仍然没有播放器，保存状态也还是「已保存」（不写文档）
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "idle");
      await expect(page.getByTestId("sound-status")).toHaveText("没在播放");

      await play.click();
      await expect(play).toHaveText("播放中");
      await expect(play).toHaveAttribute("data-playing", "true");
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "playing");
      await expect(page.getByTestId("sound-status")).toHaveText("正在播放：step1");

      // 会动的那个图标：三根声音条**真在跑动画**（不是只放了一张静态图）
      // —— 先关掉「跟随系统减少动效」，否则系统偏好会让它按规范停下来（那时靠文字表达）
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const wave = play.getByTestId("sound-wave").locator("span").first();
      await expect(wave).toBeVisible();
      const waveAnimation = await wave.evaluate((element) => {
        const style = getComputedStyle(element);
        return { name: style.animationName, duration: style.animationDuration };
      });
      expect(waveAnimation.name).not.toBe("none");
      expect(Number.parseFloat(waveAnimation.duration)).toBeGreaterThan(0);

      await expect(page.locator("audio")).toHaveCount(0);
      await expect(page.getByTestId("status-scene-save")).toHaveAttribute("data-state", "saved");

      // 点「停止」：状态回落到「没在播放」，按钮也变回「播放」
      await stop.click();
      await expect(play).toHaveText("▶ 播放");
      await expect(play).toHaveAttribute("data-playing", "false");
      await expect(page.getByTestId("sound-wave")).toHaveCount(0);
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "idle");
      await expect(page.getByTestId("sound-status")).toHaveText("没在播放");

      /*
        「切到运行态、前端还没连 → 照样点得动，title 换成『前端未连接，等它连上补发』」这条
        **不在这里点**：运行态是**服务端状态**（全局），e2e 并行用例会互相影响；
        它由 jsdom 单测钉（`apps/editor/test/sound-object.test.tsx` 的「运行态但前端没连」）。
      */
    } finally {
      await dropProject(request, project);
    }
  });

  /**
   * **画布上看得见「在播」**：正在播的声音对象，图标是活的（一圈圈往外扩的声波 + 喇叭呼吸）。
   *
   * 编辑器自己不出声，所以这条「看得见的变化」就是它在响的唯一证据——这里用「相隔一会儿的
   * 两帧画布**像素是否相同**」来钉：没在播时一帧都不该变，播起来必须变，停掉又回到不变。
   * 动画本身的参数（圈数 / 越扩越淡 / 周期性）在 `packages/renderer/test/audio-badge.test.ts` 里钉。
   */
  test("正在播的声音对象：画布上的图标会动，停掉就不动了", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      const clip = await uploadAudio(request, project, "step1.mp3");

      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          // 加进来一条并选中它（`picked`），否则「播放」点不了
          withComponent(
            gameObjectDoc("脚步", "PlaySound", { x: 0, y: 0 }),
            COMPONENT.playSound,
            { clips: [clip], picked: clip, layer: "sfx" },
          ),
        ]),
      ]);

      await enterEditor(page);
      await openProject(page, project);
      await openLeftTab(page, "hierarchy");
      await selectObject(page, 0);

      const canvas = page.locator('[data-testid="scene-viewport"] canvas');

      // 1) 还没播：图标是静止的——相隔一会儿两帧**一模一样**
      const still = await canvas.screenshot();
      await page.waitForTimeout(200);
      expect((await canvas.screenshot()).equals(still)).toBe(true);

      // 2) 点「播放」（只记账 + 下发指令，编辑器不出声）：图标动起来了
      await page.getByTestId("sound-play").click();
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "playing");

      const playing = await canvas.screenshot();
      await page.waitForTimeout(200);
      expect((await canvas.screenshot()).equals(playing)).toBe(false);

      // 3) 停掉：回到静止（再取两帧又一样了）
      await page.getByTestId("sound-stop").click();
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "idle");

      const stopped = await canvas.screenshot();
      await page.waitForTimeout(200);
      expect((await canvas.screenshot()).equals(stopped)).toBe(true);
    } finally {
      await dropProject(request, project);
    }
  });
});

/* ------------------------------------------------------------------
   声音命令真的会下发到前端（`play_sound` / `pause_sound` / `resume_sound` / `stop_sound`）。

   与 `video-object.spec.ts` 同一套做法：浏览器里再开一条**假前端** WebSocket（`/client`，
   与 Unity 走同一条协议），把收到的命令记在 `window` 上并按协议回执。
   编辑器自己不出声，所以这里钉的是「按下去的那几个键确实发出去了」这一半。
   ------------------------------------------------------------------ */

/** 假前端收到的一条命令（这条用例只关心 kind / objectId / layer）。 */
interface FakeSoundCommand {
  readonly kind?: string;
  readonly objectId?: string;
  readonly layer?: string;
}

interface FakeSoundWindow {
  __soundCommands?: FakeSoundCommand[];
  __soundScene?: boolean;
  __soundSocket?: WebSocket;
}

/** 运行态是服务端全局单例：只在一个档位上跑，免得并行档位互相开关。 */
function skipOutsideDesktop(testInfo: TestInfo): void {
  test.skip(
    !testInfo.project.name.startsWith("desktop"),
    "运行态是全局状态：只在一个档位上跑，免得并行档位互相开关",
  );
}

/** 在页面里开一条**假前端**连接：握手、收场景、把命令记下来并按协议回执。 */
async function connectFakeSoundClient(page: Page, port: number): Promise<void> {
  await page.evaluate((clientPort) => {
    const scope = window as unknown as FakeSoundWindow;
    scope.__soundCommands = [];
    scope.__soundScene = false;

    const socket = new WebSocket(`ws://127.0.0.1:${clientPort}/client`);
    scope.__soundSocket = socket;

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
        command?: FakeSoundCommand;
      };

      if (parsed.type === "scene_sync") {
        scope.__soundScene = true;
        return;
      }

      if (parsed.type === "command") {
        scope.__soundCommands?.push(parsed.command ?? {});
        socket.send(
          JSON.stringify({
            type: "command_result",
            requestId: parsed.requestId,
            ok: true,
            effects: ["e2e 假前端收到声音命令"],
          }),
        );
      }
    });
  }, port);
}

const fakeSoundCommands = async (page: Page): Promise<readonly FakeSoundCommand[]> =>
  page.evaluate(() => (window as unknown as FakeSoundWindow).__soundCommands ?? []);

test.describe("声音：命令下发给前端", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("播放 / 暂停 / 继续 / 停止 → 前端收到四条命令（控件行与视频那组一致）", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      const clip = await uploadAudio(request, project, "step1.mp3");
      const soundDoc = withComponent(
        gameObjectDoc("脚步", "PlaySound", { x: 0, y: 0 }),
        COMPONENT.playSound,
        { clips: [clip], picked: clip, layer: "sfx" },
      );
      await seedProjectDoc(request, project, [sceneDoc(SCENE, [soundDoc])]);
      await openFirstObject(page, project, "脚步");

      // 进入运行态：没点「运行」之前，前端根本连不上（503 拒握手）
      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

      await connectFakeSoundClient(page, port);
      await page.waitForFunction(() => (window as unknown as FakeSoundWindow).__soundScene === true);
      await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

      const kinds = async (): Promise<string[]> =>
        (await fakeSoundCommands(page)).map((item) => item.kind ?? "");

      // 播放 → play_sound{objectId, layer}（播哪一条由前端从镜像里读，命令里不带）
      await page.getByTestId("sound-play").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "play_sound").length).toBe(1);
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "playing");
      expect((await fakeSoundCommands(page)).find((item) => item.kind === "play_sound")).toEqual({
        kind: "play_sound",
        objectId: String(soundDoc.id),
        layer: "sfx",
      });

      // 暂停 / 继续：按**层级**给（同层只响一条，所以不带 objectId）
      await page.getByTestId("sound-pause").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "pause_sound").length).toBe(1);
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "paused");
      expect((await fakeSoundCommands(page)).find((item) => item.kind === "pause_sound")).toEqual({
        kind: "pause_sound",
        layer: "sfx",
      });

      await page.getByTestId("sound-pause").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "resume_sound").length).toBe(1);
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "playing");

      // 停止 → stop_sound{layer}
      await page.getByTestId("sound-stop").click();
      await expect.poll(async () => (await kinds()).filter((kind) => kind === "stop_sound").length).toBe(1);
      await expect(page.getByTestId("sound-status")).toHaveAttribute("data-state", "idle");

      // 回执 ok:true → 编辑器日志里看得见「命令 执行成功」
      await expect(page.getByText(/命令\s*执行成功/).first()).toBeVisible();

      // 收尾：退出运行态（前端会被踢下线）
      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    } finally {
      await page.evaluate(() => {
        (window as unknown as FakeSoundWindow).__soundSocket?.close();
      });
      await dropProject(request, project);
    }
  });
});
