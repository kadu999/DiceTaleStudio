import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  dropProject,
  mapObjectDoc,
  newProject,
  openFirstObject,
  sceneDoc,
  seedProjectDoc,
  solidPng,
  uploadSceneImage,
} from "./helpers/editor";
import { cellPointInBox } from "./helpers/canvas";

/**
 * 战争雾：编辑器里的轨迹**真的会下发到前端**（`erase_mask` / `reveal_fog_region`）。
 *
 * 这是这条链路唯一能自动跑通的端到端用例：浏览器里再开一条**假前端** WebSocket
 * （`/client`，与 Unity 走同一条协议），把收到的命令记在 `window` 上，再按协议回执。
 *
 * 钉住四件事：
 * 1. Mask 窗口里擦一笔 → 前端收到 `erase_mask`，载荷是**轨迹**（归一化点 + 半径 `0.05` + 软边 1），
 *    **不是**整张遮罩/格子数据；
 * 2. 「整区开关」→ 前端收到 `reveal_fog_region`（区域位 + 揭示/盖回）；
 * 3. 前端回执 `ok:true` → 编辑器日志里出现「命令执行成功」（不假装成功、也不超时）；
 * 4. 编辑态擦除**不下发**（Mask 窗口那时只是预览）——这条由 store 单测钉，这里只保证运行态能发出去。
 *
 * `@runtime` 标记：运行态是服务端全局单例，这一组只在一个档位、串行跑（见 `smoke.spec.ts` 的说明）。
 */

const SCENE = "Map001";
const MAP_SIZE = { width: 400, height: 300 };
const GRID = { width: 8, height: 6 };
const CANVAS = "fog-mask-canvas";
/** 左下角 4 格是「区域1」：指定它之后 Mask 窗口里才有可擦的雾。 */
const FOG_CELLS = 4;
/** 编辑器下发的归一化半径（`48/960`，跨端契约里的那个数）。 */
const BRUSH_RATIO = 0.05;

/** 假前端收到的一条命令（只列这条用例用到的字段）。 */
interface FakeCommand {
  readonly kind?: string;
  readonly objectId?: string;
  readonly stroke?: {
    readonly points?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
    readonly radius?: number;
    readonly softness?: number;
  };
  readonly region?: number;
  readonly revealed?: boolean;
}

/** 假前端的状态放在页面全局（`page.evaluate` 来回读）。 */
interface FakeClientWindow {
  __fogCommands?: FakeCommand[];
  __fogScene?: boolean;
  __fogSocket?: WebSocket;
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
    scope.__fogCommands = [];
    scope.__fogScene = false;

    const socket = new WebSocket(`ws://127.0.0.1:${clientPort}/client`);
    scope.__fogSocket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "client_hello",
          // 与 `@dts/protocol` 的 `PROTOCOL_VERSION` 一致（这里写死：e2e 不是 workspace 包，
          // 拿不到那个常量；版本一升这里会连不上、用例会当场失败，提醒同步改）
          protocolVersion: 8,
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
        scope.__fogScene = true;
        return;
      }

      if (parsed.type === "command") {
        scope.__fogCommands?.push(parsed.command ?? {});
        socket.send(
          JSON.stringify({
            type: "command_result",
            requestId: parsed.requestId,
            ok: true,
            effects: ["e2e 假前端收到轨迹"],
          }),
        );
      }
    });
  }, port);
}

/** 读回假前端收到的命令。 */
async function fakeCommands(page: Page): Promise<readonly FakeCommand[]> {
  return page.evaluate(() => (window as unknown as FakeClientWindow).__fogCommands ?? []);
}

/** 在遮罩画布上按住拖一笔（与 `fog-mask.spec.ts` 同一套模拟 GM 擦除）。 */
async function eraseAcross(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const start = await cellPointInBox(page, CANVAS, GRID, from);
  const end = await cellPointInBox(page, CANVAS, GRID, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

/** 一张带雾的地图：左下角 4 格是「区域1」，且**只有区域1 算雾区**。 */
function fogMapDoc(project: string): Record<string, unknown> {
  const mapDoc = mapObjectDoc(project, SCENE, "网格地图", MAP_SIZE, GRID);
  (mapDoc.map as { cells: unknown }).cells = {
    encoding: "rle",
    runs: [
      [1, FOG_CELLS],
      [0, GRID.width * GRID.height - FOG_CELLS],
    ],
  };
  (mapDoc.map as { fog?: unknown }).fog = { enabled: true, regions: [1] };
  return mapDoc;
}

test.describe("战争雾：轨迹下发给前端", { tag: "@runtime" }, () => {
  test.describe.configure({ mode: "serial" });

  test("Mask 窗口擦一笔 / 整区开关 → 前端收到 erase_mask / reveal_fog_region", async ({
    page,
    request,
  }, testInfo) => {
    skipOutsideDesktop(testInfo);

    const port = Number(process.env.E2E_PORT ?? 1421);
    const project = await newProject(request);

    try {
      const mapDoc = fogMapDoc(project);
      await seedProjectDoc(request, project, [sceneDoc(SCENE, [mapDoc])]);
      await uploadSceneImage(request, project, SCENE, solidPng(4, 4, [60, 60, 60]));
      await openFirstObject(page, project, "网格地图");

      // 战争雾那一组是**文档数据**（种子文件里 `fog.enabled = true`）：开着才有「编辑」入口
      const fog = page.locator('[data-group="fog"]');
      await expect(fog.getByTestId("fog-enable")).toBeChecked();
      await expect(fog.getByTestId("fog-mask-open")).toBeVisible();

      // 进入运行态：没点「运行」之前，前端根本连不上（503 拒握手）
      await page.getByTestId("mode-run").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "run");

      // 假前端连上：拿到整份场景（说明镜像协议那条路是通的）
      await connectFakeClient(page, port);
      await page.waitForFunction(() => (window as unknown as FakeClientWindow).__fogScene === true);
      await expect(page.getByTestId("client-badge")).toHaveAttribute("data-connected", "yes");

      // 打开 Mask 窗口：擦一笔（拖动中分批下发，抬手补最后一批）
      await fog.getByTestId("fog-mask-open").click();
      await expect(page.getByTestId("fog-mask-dialog")).toBeVisible();
      await eraseAcross(page, { x: 0, y: 0 }, { x: 1, y: 0 });

      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "erase_mask").length)
        .toBeGreaterThan(0);

      const eraseCommands = (await fakeCommands(page)).filter((item) => item.kind === "erase_mask");
      for (const command of eraseCommands) {
        // 对象对得上（就是种子文档里那张地图）；载荷里只有**轨迹**，没有格子/遮罩数据
        expect(command.objectId).toBe(mapDoc.id);
        expect(command.stroke?.radius).toBeCloseTo(BRUSH_RATIO, 5);
        expect(command.stroke?.softness).toBe(1);
        expect(command.stroke?.points?.length ?? 0).toBeGreaterThan(0);
        for (const point of command.stroke?.points ?? []) {
          // 归一化 [0,1]（y 向下）；擦的是左下角那一格附近
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(1);
          expect(point.y).toBeGreaterThanOrEqual(0.5);
          expect(point.y).toBeLessThanOrEqual(1);
        }
      }

      // 一笔被切成几批时，相邻两批共享一个落点（接缝处不能断）
      if (eraseCommands.length > 1) {
        const first = eraseCommands[0]?.stroke?.points ?? [];
        const second = eraseCommands[1]?.stroke?.points ?? [];
        expect(second[0]).toEqual(first[first.length - 1]);
      }

      // 整区开关：区域1 整片揭示
      await page.getByTestId("fog-region-toggle-1").check();

      await expect
        .poll(async () => (await fakeCommands(page)).filter((item) => item.kind === "reveal_fog_region").length)
        .toBe(1);

      const region = (await fakeCommands(page)).find((item) => item.kind === "reveal_fog_region");
      expect(region).toMatchObject({ objectId: mapDoc.id, region: 1, revealed: true });

      // 假前端回了 ok:true → 编辑器日志里看得见「命令 执行成功」（不假装成功、也不超时）
      await expect(page.getByText(/命令\s*执行成功/).first()).toBeVisible();

      // 收尾：关对话框 → 退出运行态（前端会被踢下线）
      await page.getByTestId("fog-mask-close").click();
      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("status-mode")).toHaveAttribute("data-mode", "edit");
    } finally {
      await page.evaluate(() => {
        (window as unknown as FakeClientWindow).__fogSocket?.close();
      });
      await dropProject(request, project);
    }
  });
});
