import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
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
} from "./helpers/editor";
import { exactWorldPoint, findEmptyCanvasPoint, scenePoint, sceneViewport, worldSamplePoint } from "./helpers/canvas";

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
      sceneObjectDoc(SPRITE, "SceneObject", { x: 0, y: 0 }, {
        image: { id: `project:${project}/${IMAGE_PATH}`, width: SIZE.width, height: SIZE.height },
      }),
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
  // 外框半宽半高（旋转后取极值）——三套手柄都由它派生
  const cornersLocal = [
    { x: -half.x, y: half.y },
    { x: half.x, y: half.y },
    { x: half.x, y: -half.y },
    { x: -half.x, y: -half.y },
  ];
  const corners = cornersLocal.map(at);
  const boundX = Math.max(...corners.map((corner) => Math.abs(corner.x - screenCenter.x)));
  const boundY = Math.max(...corners.map((corner) => Math.abs(corner.y - screenCenter.y)));

  const axisDistance = {
    x: boundX + GIZMO_AXIS_GAP,
    y: boundY + GIZMO_AXIS_GAP,
  };

  return {
    center: screenCenter,
    ringRadius: Math.hypot(boundX, boundY) + GIZMO_RING_GAP,
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

  test("四种工具下，点对象都只是选中、不会把它拖走", async ({ page, request }) => {
    const project = await openSprite(page, request);
    try {
      for (const tool of ["none", "move", "rotate", "scale"] as const) {
        await page.getByTestId(`tool-${tool}`).click();
        await expect(page.getByTestId("status-tool")).toHaveAttribute("data-tool", tool);
        await closeDrawers(page);

        // 从对象中心往外拖：只有手柄能改对象，本体这一下什么也不该改
        await dragWorld(page, { x: 0, y: 0 }, { x: 140, y: 110 });
        await page.waitForTimeout(900);

        const object = await currentObject(request, project);
        expect(object.position?.x ?? 0, `${tool} 模式下对象被拖走了`).toBe(0);
        expect(object.position?.y ?? 0, `${tool} 模式下对象被拖走了`).toBe(0);
        expect(object.rotation ?? 0, `${tool} 模式下角度被改了`).toBe(0);
        expect(object.scale ?? 1, `${tool} 模式下缩放被改了`).toBe(1);

        // 点一下仍然选中它（点对象 = 选中，不是取消选中）
        await page.getByTestId("reset-viewport").click();
        const center = await scenePoint(page, 0, 0);
        await page.mouse.click(center.x, center.y);
        await page.waitForTimeout(200);
        await expect(page.getByTestId("status-selection")).toHaveText("已选 1");
      }
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
      // 旋转：从环上按角度拖，角度确实变了
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
        .toBe(90);
      // 只是转，没有移动
      const rotated = await currentObject(request, project);
      expect(rotated.position?.x ?? 0).toBeCloseTo(0, 3);
      expect(rotated.position?.y ?? 0).toBeCloseTo(0, 3);

      // 缩放：拖角手柄，尺寸确实变了
      await page.getByTestId("tool-scale").click();
      const scaleGeometry = await gizmoOf(page, rotated);
      const corner =
        scaleGeometry.scale.find((entry) => entry.handle === "scale-bottom-right")?.point ??
        scaleGeometry.center;
      await dragScreen(page, corner, {
        x: scaleGeometry.center.x + (corner.x - scaleGeometry.center.x) * 2,
        y: scaleGeometry.center.y + (corner.y - scaleGeometry.center.y) * 2,
      });

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

      // 从环上的正右方拖到正上方 = 逆时针 90°
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
        .toBe(90);

      // 再拖回正右方 = 0°
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
      // 从正右方拖约 34°：不按 Shift 会是 34°，按住 Shift 应该吸到 30°
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
        .toBe(30);
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

      // 拖右下角：锚点是对角的左上角，把指针拖到「锚点以外两个半边」处 → 尺寸翻倍
      const before = await currentObject(request, project);
      const geometry = await gizmoOf(page, before);
      const corner =
        geometry.scale.find((entry) => entry.handle === "scale-bottom-right")?.point ?? geometry.center;
      await dragScreen(page, corner, {
        x: geometry.center.x + (corner.x - geometry.center.x) * 2,
        y: geometry.center.y + (corner.y - geometry.center.y) * 2,
      });

      await expect
        .poll(async () => (await currentObject(request, project)).scale ?? 0)
        .toBeGreaterThan(1.8);

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

      // 边手柄单轴：按**读到的**状态算右边中点的屏幕位置，再拖到「宽度翻倍」
      const scaled = await currentObject(request, project);
      const next = await gizmoOf(page, scaled);
      const rightEdge =
        next.scale.find((entry) => entry.handle === "scale-right")?.point ?? next.center;
      await dragScreen(page, rightEdge, {
        x: next.center.x + (rightEdge.x - next.center.x) * 2,
        y: rightEdge.y,
      });

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
});
