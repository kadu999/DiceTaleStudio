import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  COMPONENT,
  closeDrawers,
  dropProject,
  enterEditor,
  newProject,
  openInspector,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
  withComponent,
} from "./helpers/editor";
import { exactWorldPoint, findEmptyCanvasPoint, sceneViewport, worldSamplePoint } from "./helpers/canvas";

/**
 * 场景变换手柄：**拖动（默认）/ 移动 / 旋转 / 缩放**四种工具。
 *
 * **geometría 怎么算**：手柄的位置从「对象的显示矩形」推出来，再经**从 DOM 读到的真实视口**
 * 换成屏幕点。之所以不去 import `@dts/renderer`（那样能保证同一份几何）：
 * `e2e/` 一直不引用内部包（根上没有 workspace 链接），而 `packages/renderer/test/gizmo.test.ts`
 * 已经**按输出反查**钉住了「几何 → 命中」的一致性。所以这里的常量是**复述**，
 * 分工是：**单测管「手柄画在哪儿」，这里管「真点下去会发生什么」**。
 *
 * 数值与 `packages/renderer/src/gizmo.ts` 的 GIZMO_AXIS_GAP / GIZMO_AXIS_LENGTH / GIZMO_RING_GAP
 * 保持一致；那边改了而这里没改，失败信息会直接指向"拖了没反应"。
 */
const GIZMO_AXIS_GAP = 45;
const GIZMO_AXIS_LENGTH = 40;
const GIZMO_RING_GAP = 22;

const SCENE = "Map001";
const SPRITE = "精灵";
/** 贴图声明尺寸 = 世界尺寸（1 图片像素 = 1 世界像素，再乘缩放）。 */
const SIZE = { width: 120, height: 120 };
const IMAGE_PATH = "Assets/images/Sprite.png";

interface PersistedObject {
  position?: { x: number; y: number } | null;
  rotation?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
}

/** 场景里第一个对象（读不到时返回 undefined）。 */
async function persistedObject(
  request: APIRequestContext,
  project: string,
): Promise<PersistedObject | undefined> {
  const id = `project:${project}/Assets/scenes/${SCENE}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    return undefined;
  }

  const raw = (await response.json()) as { objects?: PersistedObject[] };
  return raw.objects?.[0];
}

/** 开场：建项目 → 种一块纯绿精灵 → 打开 → 选中 → 视口复位。 */
async function openSprite(page: Page, request: APIRequestContext): Promise<string> {
  const project = await newProject(request);
  await seedProjectDoc(request, project, [
    sceneDoc(SCENE, [
      withComponent(
        sceneObjectDoc(SPRITE, "SceneObject", { x: 0, y: 0 }),
        COMPONENT.textureRenderer,
        { id: `project:${project}/${IMAGE_PATH}`, width: SIZE.width, height: SIZE.height },
      ),
    ]),
  ]);
  await request.put(
    `/api/resources/raw?id=${encodeURIComponent(`project:${project}/${IMAGE_PATH}`)}`,
    { headers: { "content-type": "image/png" }, data: solidPng(SIZE.width, SIZE.height, [0, 255, 0]) },
  );

  await enterEditor(page);
  await openProject(page, project);
  await selectObject(page);
  await closeDrawers(page);
  await page.getByTestId("reset-viewport").click();
  return project;
}

/**
 * 当前选中对象的手柄几何（**屏幕坐标**：center / 两根轴 / 八个缩放块的角与边中点 / 环半径）。
 *
 * 视口从 DOM 上读（面板把它写在 `[data-testid=scene-viewport]` 上），于是用例与画布对
 * 「世界原点落在屏幕哪儿」的看法必然一致。
 *
 * **轴距与环半径按矩形自己的半尺寸算**（不取旋转后四角的极值）：手柄的间距要贴着对象，
 * 但不该随角度一会儿大一会儿小——画布那边是这么算的，用例照着复述。
 * 缩放手柄与其**对侧锚点**同在 `scale` 里按同一套「对角 / 对边」映射配对：拖拽时锚点不动，
 * 所以「尺寸翻倍」= 把指针拖到 `锚点 + 2×(把手 − 锚点)`（与画布那边的倍率定义同一套）。
 */
async function gizmoOf(page: Page, object: PersistedObject) {
  const viewport = await sceneViewport(page);
  const scale = object.scale ?? 1;
  const center = object.position ?? { x: 0, y: 0 };
  const half = {
    x: (SIZE.width * (object.scaleX ?? scale)) / 2,
    y: (SIZE.height * (object.scaleY ?? scale)) / 2,
  };
  const rotation = object.rotation ?? 0;

  // 视口 → 屏幕（与画布 viewport.ts 同一套：y 翻转）
  const toScreen = (world: { x: number; y: number }): { x: number; y: number } => ({
    x: viewport.left + viewport.tx + world.x * viewport.scale,
    y: viewport.top + viewport.ty - world.y * viewport.scale,
  });
  // 对象自己的局部坐标 → 世界（绕中心转 rotation）
  const rotate = (local: { x: number; y: number }): { x: number; y: number } => ({
    x: center.x + local.x * Math.cos(rotation) - local.y * Math.sin(rotation),
    y: center.y + local.x * Math.sin(rotation) + local.y * Math.cos(rotation),
  });
  const at = (local: { x: number; y: number }): { x: number; y: number } => toScreen(rotate(local));

  const screenCenter = toScreen(center);
  // 手柄间距从**半尺寸**量起（`gizmoScreenGeometry` 的口径）：转过角度的正方形也是 60 而不是 84.85
  const bound = {
    x: half.x * viewport.scale,
    y: half.y * viewport.scale,
  };

  const axisDistance = {
    x: bound.x + GIZMO_AXIS_GAP,
    y: bound.y + GIZMO_AXIS_GAP,
  };

  return {
    center: screenCenter,
    ringRadius: Math.hypot(bound.x, bound.y) + GIZMO_RING_GAP,
    axes: [
      {
        handle: "move-x" as const,
        root: { x: screenCenter.x + axisDistance.x, y: screenCenter.y },
        tip: { x: screenCenter.x + axisDistance.x + GIZMO_AXIS_LENGTH, y: screenCenter.y },
      },
      {
        handle: "move-y" as const,
        root: { x: screenCenter.x, y: screenCenter.y - axisDistance.y },
        tip: { x: screenCenter.x, y: screenCenter.y - axisDistance.y - GIZMO_AXIS_LENGTH },
      },
    ],
    /** 八个缩放块：四角 + 四边中点（与画布上的名字一致）。 */
    scale: [
      { handle: "scale-top-left" as const, point: at({ x: -half.x, y: half.y }) },
      { handle: "scale-top-right" as const, point: at({ x: half.x, y: half.y }) },
      { handle: "scale-bottom-right" as const, point: at({ x: half.x, y: -half.y }) },
      { handle: "scale-bottom-left" as const, point: at({ x: -half.x, y: -half.y }) },
      { handle: "scale-top" as const, point: at({ x: 0, y: half.y }) },
      { handle: "scale-right" as const, point: at({ x: half.x, y: 0 }) },
      { handle: "scale-bottom" as const, point: at({ x: 0, y: -half.y }) },
      { handle: "scale-left" as const, point: at({ x: -half.x, y: 0 }) },
    ],
  };
}

/** 缩放块的对侧锚点（就是对角 / 对边中点，与画布 `scaleAnchorFor` 同一套映射）。 */
const SCALE_ANCHORS: Readonly<Record<string, string>> = {
  "scale-top-left": "scale-bottom-right",
  "scale-top-right": "scale-bottom-left",
  "scale-bottom-right": "scale-top-left",
  "scale-bottom-left": "scale-top-right",
  "scale-top": "scale-bottom",
  "scale-right": "scale-left",
  "scale-bottom": "scale-top",
  "scale-left": "scale-right",
};

/** 某个缩放块在屏幕上的位置与它的对侧锚点（拿不到就抛，用例都建立在「有手柄」之上）。 */
function scaleHandleOf(
  geometry: Awaited<ReturnType<typeof gizmoOf>>,
  handle: string,
): { point: { x: number; y: number }; anchor: { x: number; y: number } } {
  const point = geometry.scale.find((entry) => entry.handle === handle)?.point;
  const target = SCALE_ANCHORS[handle];
  const anchor = geometry.scale.find((entry) => entry.handle === target)?.point;
  if (point === undefined || anchor === undefined) {
    throw new Error(`拿不到 ${handle} 的缩放块 / 锚点几何`);
  }

  return { point, anchor };
}

/** 把缩放块拖到「锚点之外 `factor` 倍」——倍率就是 `factor`（锚点固定不动）。 */
function scaleTarget(
  handle: { point: { x: number; y: number }; anchor: { x: number; y: number } },
  factor: number,
): { x: number; y: number } {
  return {
    x: handle.anchor.x + (handle.point.x - handle.anchor.x) * factor,
    y: handle.anchor.y + (handle.point.y - handle.anchor.y) * factor,
  };
}

/** 直接按屏幕点拖（手柄位置来自 `gizmoOf`，本来就是屏幕坐标）。 */
async function dragScreen(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** 世界坐标拖拽（对象本体、空白、以及"随便哪一点"用它，省得自己换算）。 */
async function dragWorld(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await dragScreen(page, await exactWorldPoint(page, from), await exactWorldPoint(page, to));
}

/** 已落盘的对象状态（没有就失败——用例都建立在"对象已经存在"之上）。 */
async function currentObject(request: APIRequestContext, project: string): Promise<PersistedObject> {
  const object = await persistedObject(request, project);
  if (object === undefined) {
    throw new Error("读不到场景里的对象");
  }

  return object;
}

test.describe("场景变换手柄", () => {
  test("默认是「拖动」：只平移画布，拖对象不会把它碰歪（只选中）", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", "none");

      // 从对象本体拖走
      const before = await sceneViewport(page);
      await dragWorld(page, { x: 0, y: 0 }, { x: 150, y: 90 });
      await page.waitForTimeout(1200);

      // 对象一动不动……
      const object = await currentObject(request, project);
      expect(object.position?.x ?? 0).toBe(0);
      expect(object.position?.y ?? 0).toBe(0);
      // ……动的是摄像机
      const after = await sceneViewport(page);
      expect(after.tx).not.toBeCloseTo(before.tx, 1);

      // 而且它仍然是选中的（拖动不该顺手把选中丢掉）
      await expect(page.getByTestId("status-selection")).toHaveText("已选 1");
    } finally {
      await dropProject(request, project);
    }
  });

  test("拖对象本体：只有「移动」工具会挪动它，其余三个工具只平移画布", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      // 「移动」工具：拖本体 = 自由移动（两个轴一起走，不必先对准箭头）
      await page.getByTestId("tool-move").click();
      await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", "move");
      await closeDrawers(page);

      await dragWorld(page, { x: 0, y: 0 }, { x: 140, y: 110 });
      await expect
        .poll(async () => (await currentObject(request, project)).position?.x ?? 0)
        .toBeCloseTo(140, 0);
      const dragged = await currentObject(request, project);
      expect(dragged.position?.y ?? 0).toBeCloseTo(110, 0);
      // 自由移动只挪位置：角度与缩放不碰
      expect(dragged.rotation ?? 0).toBe(0);
      expect(dragged.scale ?? 1).toBe(1);

      // 其余三个工具：本体这一下什么也不改（旋转 / 缩放下「顺手把对象碰歪」最烦人）。
      // 每次先复位视口：上一轮拖本体是**平移画布**，不复位的话落点会一轮轮被挤出画面
      for (const tool of ["none", "rotate", "scale"] as const) {
        await page.getByTestId("reset-viewport").click();
        await page.getByTestId(`tool-${tool}`).click();
        await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", tool);
        await closeDrawers(page);

        await dragWorld(page, { x: 140, y: 110 }, { x: 60, y: 40 });
        await page.waitForTimeout(900);

        const object = await currentObject(request, project);
        expect(object.position?.x ?? 0, `${tool} 模式下对象被拖走了`).toBeCloseTo(140, 0);
        expect(object.position?.y ?? 0, `${tool} 模式下对象被拖走了`).toBeCloseTo(110, 0);
        expect(object.rotation ?? 0, `${tool} 模式下角度被改了`).toBe(0);
        expect(object.scale ?? 1, `${tool} 模式下缩放被改了`).toBe(1);

        // 点一下仍然选中它（点对象 = 选中，不是取消选中）
        await page.getByTestId("reset-viewport").click();
        // 「复位」= 把对象装进画布（居中在它身上），所以落点要从**真实视口**换算，
        // 不能按「世界原点在画布正中」去猜
        const center = await exactWorldPoint(page, { x: 140, y: 110 });
        await page.mouse.click(center.x, center.y);
        await page.waitForTimeout(200);
        await expect(page.getByTestId("status-selection")).toHaveText("已选 1");
      }
    } finally {
      await dropProject(request, project);
    }
  });

  test("拖对象本体：按一下不动就抬手，位置一分不改（只有真的拖了才写文档）", async ({
    page,
    request,
  }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-move").click();
      await closeDrawers(page);

      const center = await exactWorldPoint(page, { x: 0, y: 0 });
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);

      const object = await currentObject(request, project);
      expect(object.position?.x ?? 0).toBe(0);
      expect(object.position?.y ?? 0).toBe(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("移动：拖 X 箭头只沿 X 走、Y 箭头只沿 Y 走，并落盘", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-move").click();
      await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", "move");
      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const xAxis = geometry.axes.find((axis) => axis.handle === "move-x");
      const yAxis = geometry.axes.find((axis) => axis.handle === "move-y");
      if (xAxis === undefined || yAxis === undefined) {
        throw new Error("拿不到移动轴几何");
      }

      // 抓 X 轴中段往 +X 拖 200
      const grabX = { x: (xAxis.root.x + xAxis.tip.x) / 2, y: xAxis.root.y };
      await dragScreen(page, grabX, { x: grabX.x + 200, y: grabX.y });

      await expect
        .poll(async () => (await currentObject(request, project)).position?.x ?? 0)
        .toBeGreaterThan(150);

      const afterX = await currentObject(request, project);
      expect(Math.abs(afterX.position?.y ?? 999)).toBeLessThan(2);

      // 抓 Y 轴中段往 +Y 拖 200：几何**必须按移动后的对象重算**——
      // 对象已经往 +X 挪了 200，照搬按下前的位置会抓空（这一条踩过一次）
      const moved = await gizmoOf(page, afterX);
      const yAxisNow = moved.axes.find((axis) => axis.handle === "move-y");
      if (yAxisNow === undefined) {
        throw new Error("拿不到移动轴几何");
      }

      const grabY = { x: yAxisNow.root.x, y: (yAxisNow.root.y + yAxisNow.tip.y) / 2 };
      await dragScreen(page, grabY, { x: grabY.x, y: grabY.y - 200 });

      await expect
        .poll(async () => (await currentObject(request, project)).position?.y ?? 0)
        .toBeGreaterThan(150);

      const afterY = await currentObject(request, project);
      expect(Math.abs((afterY.position?.x ?? 0) - (afterX.position?.x ?? 0))).toBeLessThan(2);
    } finally {
      await dropProject(request, project);
    }
  });

  test("旋转 / 缩放：本体不参与，抓手柄才动对象", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      // 旋转：从环上按角度拖，角度确实变了。
      // **往屏幕上方拖 = 对象在屏幕上逆时针转 = 文档里 -90°**：画布 y 向下、世界 y 向上，
      // 两者差一个负号（数值的含义与属性面板那个输入框都不变，只有手势映射反号）
      await page.getByTestId("tool-rotate").click();
      const before = await currentObject(request, project);
      const rotateGeometry = await gizmoOf(page, before);
      const radius = rotateGeometry.ringRadius;
      await dragScreen(
        page,
        { x: rotateGeometry.center.x + radius, y: rotateGeometry.center.y },
        { x: rotateGeometry.center.x, y: rotateGeometry.center.y - radius },
      );

      await expect
        .poll(async () => {
          const rotation = (await currentObject(request, project)).rotation;
          return rotation === undefined ? 0 : Math.round((rotation * 180) / Math.PI);
        })
        .toBe(-90);
      const rotated = await currentObject(request, project);
      expect(rotated.position?.x ?? 0).toBeCloseTo(0, 3);
      expect(rotated.position?.y ?? 0).toBeCloseTo(0, 3);

      // 缩放：拖角手柄，尺寸确实变了
      await page.getByTestId("tool-scale").click();
      const scaleGeometry = await gizmoOf(page, rotated);
      const corner = scaleHandleOf(scaleGeometry, "scale-bottom-right");
      await dragScreen(page, corner.point, scaleTarget(corner, 2));

      await expect.poll(async () => (await currentObject(request, project)).scale ?? 0).toBeGreaterThan(1.8);
    } finally {
      await dropProject(request, project);
    }
  });

  test("旋转：沿圆环拖，角度落盘", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-rotate").click();
      await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", "rotate");

      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const radius = geometry.ringRadius;

      // 从环上的正右方拖到**屏幕上方**：屏幕上逆时针 90° → 文档里 -90°
      await dragScreen(
        page,
        { x: geometry.center.x + radius, y: geometry.center.y },
        { x: geometry.center.x, y: geometry.center.y - radius },
      );

      await expect
        .poll(async () => {
          const rotation = (await currentObject(request, project)).rotation;
          return rotation === undefined ? 0 : Math.round((rotation * 180) / Math.PI);
        })
        .toBe(-90);

      // 再拖回正右方（屏幕顺时针 90°）= 0°
      const afterFirst = await currentObject(request, project);
      const second = await gizmoOf(page, afterFirst);
      await dragScreen(
        page,
        { x: second.center.x, y: second.center.y - second.ringRadius },
        { x: second.center.x + second.ringRadius, y: second.center.y },
      );

      await expect
        .poll(async () => {
          const rotation = (await currentObject(request, project)).rotation;
          return rotation === undefined ? 0 : Math.round((rotation * 180) / Math.PI);
        })
        .toBe(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("旋转：Shift 把角度吸附到 15° 的整数倍", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-rotate").click();

      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const radius = geometry.ringRadius;
      // 从正右方往**屏幕上方**拖约 34°：文档里是 -34°（屏幕上的逆时针），
      // 按住 Shift 应该吸到 -30°
      const targetAngle = (34 * Math.PI) / 180;

      await page.keyboard.down("Shift");
      await dragScreen(
        page,
        { x: geometry.center.x + radius, y: geometry.center.y },
        {
          x: geometry.center.x + radius * Math.cos(targetAngle),
          y: geometry.center.y - radius * Math.sin(targetAngle),
        },
      );
      await page.keyboard.up("Shift");

      await expect
        .poll(async () => {
          const rotation = (await currentObject(request, project)).rotation;
          return rotation === undefined ? 0 : Math.round((rotation * 180) / Math.PI);
        })
        .toBe(-30);
    } finally {
      await dropProject(request, project);
    }
  });

  test("缩放：拖角手柄等比（只写 scale），拖边手柄单轴", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-scale").click();
      await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", "scale");
      await expect(page.getByTestId("status-selection")).toHaveText("已选 1");

      // 拖右下角：锚点是对角的左上角，把指针拖到「锚点之外两倍处」→ 尺寸**正好**翻倍
      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const corner = scaleHandleOf(geometry, "scale-bottom-right");
      await dragScreen(page, corner.point, scaleTarget(corner, 2));

      await expect.poll(async () => (await currentObject(request, project)).scale ?? 0).toBeCloseTo(2, 1);

      const uniform = await currentObject(request, project);
      expect(uniform.scaleX).toBeUndefined();
      expect(uniform.scaleY).toBeUndefined();

      // 画面上也真的变大了：缩到约 2 倍后世界 (100, 0) 落在精灵里（原来是外面）
      const sample = await worldSamplePoint(page, { x: 100, y: 0 });
      const color = await page.evaluate(
        ({ x, y }) => {
          const canvas = document.querySelector("canvas");
          const context = canvas?.getContext("2d") ?? null;
          if (canvas === null || context === null) {
            return null;
          }

          const rect = canvas.getBoundingClientRect();
          const ratio = canvas.width / Math.max(1, rect.width);
          const pixel = context.getImageData(
            Math.round((x - rect.left) * ratio),
            Math.round((y - rect.top) * ratio),
            1,
            1,
          ).data;
          return { r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 };
        },
        sample,
      );
      expect(color?.g ?? 0).toBeGreaterThan(150);

      // 边手柄单轴：按**读到的**状态算右边中点的屏幕位置与它的对侧锚点，
      // 再把指针拖到「锚点之外两倍处」→ 宽度**正好**在现有基础上翻倍（高度一点不动）
      const scaled = await currentObject(request, project);
      const next = await gizmoOf(page, scaled);
      const rightEdge = scaleHandleOf(next, "scale-right");
      await dragScreen(page, rightEdge.point, scaleTarget(rightEdge, 2));

      await expect
        .poll(async () => (await currentObject(request, project)).scaleX ?? 0)
        .toBeGreaterThan((scaled.scale ?? 1) * 1.8);

      const perAxis = await currentObject(request, project);
      // 等比的 scale 归 1，两轴各写各的；高度停在角手柄拖出来的那个值
      expect(perAxis.scale).toBe(1);
      expect(perAxis.scaleY).toBeCloseTo(scaled.scale ?? 0, 1);
    } finally {
      await dropProject(request, project);
    }
  });

  test("锁定的对象手柄画出来也拖不动", async ({ page, request }) => {
    test.setTimeout(60_000);
    const project = await openSprite(page, request);
    try {
      await openInspector(page);
      await page.getByTestId("inspector-object-locked").check();
      await expect(page.getByTestId("inspector-object-locked")).toBeChecked();
      await closeDrawers(page);
      await page.getByTestId("tool-scale").click();

      // 在手柄该在的位置按下并拖走：锁定后这一下既不该缩放手柄，也不该跟手移动
      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const corner =
        geometry.scale.find((entry) => entry.handle === "scale-bottom-right")?.point ?? geometry.center;
      await dragScreen(page, corner, { x: corner.x + 120, y: corner.y + 120 });

      await page.waitForTimeout(1200);
      const locked = await currentObject(request, project);

      expect(locked.position?.x ?? 0).toBe(0);
      expect(locked.position?.y ?? 0).toBe(0);
      expect(locked.scale).toBe(1);
      expect(locked.scaleX).toBeUndefined();
    } finally {
      await dropProject(request, project);
    }
  });

  test("一次手柄拖拽只产生一条撤销记录", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-move").click();

      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const axis = geometry.axes.find((entry) => entry.handle === "move-x");
      if (axis === undefined) {
        throw new Error("拿不到移动轴几何");
      }

      const grab = { x: (axis.root.x + axis.tip.x) / 2, y: axis.root.y };
      await dragScreen(page, grab, { x: grab.x + 260, y: grab.y });
      await expect
        .poll(async () => (await currentObject(request, project)).position?.x ?? 0)
        .toBeGreaterThan(200);

      const moved = (await currentObject(request, project)).position?.x ?? 0;

      // 一次 Ctrl+Z 就该回到按下前（不是逐步回退）
      await page.keyboard.press("Control+z");

      await expect
        .poll(async () => (await currentObject(request, project)).position?.x ?? 0)
        .toBeLessThan(moved / 2);
    } finally {
      await dropProject(request, project);
    }
  });

  test("属性面板：关掉等比锁后能分别改 X / Y", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      await openInspector(page);
      await expect(page.getByTestId("inspector-object-scale")).toHaveValue("1");

      // 等比锁默认打开：没有单轴的框
      await expect(page.getByTestId("inspector-object-scale-x")).toBeHidden();

      await page.getByTestId("inspector-object-scale-uniform").click();
      await expect(page.getByTestId("inspector-object-scale-x")).toBeVisible();

      await page.getByTestId("inspector-object-scale-x").fill("3");
      await page.getByTestId("inspector-object-scale-x").blur();

      // 只改了一个轴 → 两轴各写各的，等比的 scale 归 1
      await expect.poll(async () => (await currentObject(request, project)).scaleX ?? 0).toBe(3);
      const perAxis = await currentObject(request, project);
      expect(perAxis.scale).toBe(1);
      expect(perAxis.scaleY).toBe(1);

      // 把 Y 也改成 3 → 两轴又相等，自动折叠回等比 `scale`
      await page.getByTestId("inspector-object-scale-y").fill("3");
      await page.getByTestId("inspector-object-scale-y").blur();

      await expect.poll(async () => (await currentObject(request, project)).scale ?? 0).toBe(3);
      const collapsed = await currentObject(request, project);
      expect(collapsed.scaleX).toBeUndefined();
      expect(collapsed.scaleY).toBeUndefined();
    } finally {
      await dropProject(request, project);
    }
  });

  test("按下不拖就抬手：移动与缩放都不动文档（按下不跳）", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      // 移动：按在 X 箭头正中间，按下 → 抬手，中间没有任何 move
      await page.getByTestId("tool-move").click();
      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const axis = geometry.axes.find((entry) => entry.handle === "move-x");
      if (axis === undefined) {
        throw new Error("拿不到移动轴几何");
      }

      await page.mouse.move((axis.root.x + axis.tip.x) / 2, axis.root.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);

      let object = await currentObject(request, project);
      // 曾经这里会把位置写成「指针的绝对坐标」：按下去的那一刻中心就跑到光标下面
      expect(object.position?.x ?? 0).toBe(0);
      expect(object.position?.y ?? 0).toBe(0);

      // 缩放：按在右下角，按下 → 抬手
      await page.getByTestId("tool-scale").click();
      object = await currentObject(request, project);
      const corner = scaleHandleOf(await gizmoOf(page, object), "scale-bottom-right");
      await page.mouse.move(corner.point.x, corner.point.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);

      const scaled = await currentObject(request, project);
      // 曾经这里的分母是「半尺寸」，按下瞬间倍率就是 1.5：一按就变大
      expect(scaled.scale ?? 1).toBe(1);
      expect(scaled.scaleX).toBeUndefined();
      expect(scaled.position?.x ?? 0).toBe(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("移动按指针位移算：X 箭头拖 200px，对象正好走 200（不是跳到指针的绝对坐标）", async ({
    page,
    request,
  }) => {
    const project = await openSprite(page, request);
    try {
      await page.getByTestId("tool-move").click();
      const before = await currentObject(request, project);
      const axis = (await gizmoOf(page, before)).axes.find((entry) => entry.handle === "move-x");
      if (axis === undefined) {
        throw new Error("拿不到移动轴几何");
      }

      // 视口是 1:1（`reset-viewport`）→ 200 屏幕像素 = 200 世界单位。
      // 一次 move + 立刻抬手：落盘必须在抬手前完成，终点才不会丢
      const grab = { x: (axis.root.x + axis.tip.x) / 2, y: axis.root.y };
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 200, grab.y);
      await page.mouse.up();

      // 绝对坐标那种写法会得到 ~320（200 位移 + 抓手距离中心的距离）
      await expect
        .poll(async () => (await currentObject(request, project)).position?.x ?? 0)
        .toBeCloseTo(200, 0);
      expect(Math.abs((await currentObject(request, project)).position?.y ?? 999)).toBeLessThan(1);
    } finally {
      await dropProject(request, project);
    }
  });

  test("旋转 45° 之后：箭头 / 缩放块 / 旋转环都还点得中", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      // 用属性面板把对象转到 45°：这是「已经转过角度」最确定的入口
      await openInspector(page);
      await page.getByTestId("inspector-object-rotation").fill("45");
      await page.getByTestId("inspector-object-rotation").blur();
      await closeDrawers(page);
      await expect
        .poll(async () => {
          const rotation = (await currentObject(request, project)).rotation;
          return rotation === undefined ? 0 : Math.round((rotation * 180) / Math.PI);
        })
        .toBe(45);

      // 曾经绘制用的是「旋转后的外框」、命中用的是局部矩形：转过角度后
      // 画出来的手柄根本点不中（箭头、环、缩放块全都不行）
      await page.getByTestId("tool-move").click();
      let object = await currentObject(request, project);
      const axis = (await gizmoOf(page, object)).axes.find((entry) => entry.handle === "move-x");
      if (axis === undefined) {
        throw new Error("拿不到移动轴几何");
      }

      const grab = { x: (axis.root.x + axis.tip.x) / 2, y: axis.root.y };
      await dragScreen(page, grab, { x: grab.x + 120, y: grab.y });
      await expect
        .poll(async () => (await currentObject(request, project)).position?.x ?? 0)
        .toBeCloseTo(120, 0);

      await page.getByTestId("tool-scale").click();
      object = await currentObject(request, project);
      const corner = scaleHandleOf(await gizmoOf(page, object), "scale-top-right");
      await dragScreen(page, corner.point, scaleTarget(corner, 1.5));
      await expect.poll(async () => (await currentObject(request, project)).scale ?? 0).toBeGreaterThan(1.4);

      await page.getByTestId("tool-rotate").click();
      object = await currentObject(request, project);
      const rotated = await gizmoOf(page, object);
      await dragScreen(
        page,
        { x: rotated.center.x + rotated.ringRadius, y: rotated.center.y },
        { x: rotated.center.x, y: rotated.center.y - rotated.ringRadius },
      );

      // 45° + (-90°)（从环的正右拖到**屏幕上方** = 屏幕上逆时针 90°）= -45°
      await expect
        .poll(async () => {
          const rotation = (await currentObject(request, project)).rotation;
          return rotation === undefined ? 0 : Math.round((rotation * 180) / Math.PI);
        })
        .toBe(-45);
    } finally {
      await dropProject(request, project);
    }
  });
});

test.describe("画布上的其它拖动", () => {
  test("空白处拖动 = 平移视口，不改对象", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      const blank = await findEmptyCanvasPoint(page);
      await dragScreen(page, blank, { x: blank.x + 60, y: blank.y + 40 });

      await page.waitForTimeout(1200);
      expect((await currentObject(request, project)).position?.x ?? 0).toBe(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("工具开关在画布左上角，四个按钮都点得到", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      const viewport = await page.getByTestId("scene-viewport").boundingBox();
      const tools: readonly Locator[] = (["none", "move", "rotate", "scale"] as const).map((tool) =>
        page.getByTestId(`tool-${tool}`),
      );

      for (const button of tools) {
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        // 落在画布范围内、而且贴着**左上角**
        expect(box?.x ?? 0).toBeGreaterThanOrEqual((viewport?.x ?? 0) - 1);
        expect(box?.y ?? 0).toBeGreaterThanOrEqual((viewport?.y ?? 0) - 1);
        expect(box?.y ?? 0).toBeLessThan((viewport?.y ?? 0) + (viewport?.height ?? 0) / 2);
        expect(box?.x ?? 0).toBeLessThan((viewport?.x ?? 0) + (viewport?.width ?? 0) / 2);
      }
    } finally {
      await dropProject(request, project);
    }
  });

  /**
   * 工具开关浮在画布上，底下可能是任何颜色的贴图（一张亮地图），所以它必须**自带底色**、
   * 而且字与底色的对比度够高。曾经它是「透明底 + 暗字」：压在亮地图上那四个字直接看不见。
   */
  test("工具开关在亮地图上也看得清：底色不透明、每个按钮的字与底色对比度足够", async ({
    page,
    request,
  }) => {
    const project = await openSprite(page, request);
    try {
      const control = await page.getByTestId("tool-switch").evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor };
      });

      const background = parseColor(control.background);
      // 底色必须**不透明**：透明底等于让地图的颜色决定字能不能看清
      expect(background.alpha).toBe(1);

      for (const tool of ["none", "move", "rotate", "scale"] as const) {
        const own = await page.getByTestId(`tool-${tool}`).evaluate((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, background: style.backgroundColor };
        });

        // 按钮自己没有底色时（未选中）透出的就是整条开关的底色
        const ownBackground = parseColor(own.background);
        const behind = ownBackground.alpha > 0 ? ownBackground : background;
        const ratio = contrastRatio(parseColor(own.color), behind);

        // WCAG AA 正文标准 4.5:1；实测未选中 ≈13:1、选中 ≈7:1
        expect(ratio, `${tool} 这一格的字与底色对比度只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await dropProject(request, project);
    }
  });
});

/** `rgb(...)` / `rgba(...)` → 分量（缺省 alpha = 1）。 */
function parseColor(value: string): { r: number; g: number; b: number; alpha: number } {
  const parts = (/rgba?\(([^)]+)\)/.exec(value)?.[1] ?? "")
    .split(",")
    .map((part) => Number.parseFloat(part.trim()));

  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, alpha: parts[3] ?? 1 };
}

/** sRGB 分量 → 相对亮度（WCAG 2.x 的算式）。 */
function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 两个颜色的对比度（1 ~ 21）。 */
function contrastRatio(
  first: { r: number; g: number; b: number },
  second: { r: number; g: number; b: number },
): number {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
