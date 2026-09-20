import { type Page } from "@playwright/test";

/**
 * 世界坐标 → 屏幕点，按**真实视口**换算（视口原点 + 世界位移 × 缩放）。
 *
 * 与 `scenePoint` / `worldSamplePoint` 的分工：
 * - 那两个把「世界原点」当成**画布几何中心**，对「按对象矩形整块命中」的老用例够用
 *   （差几十像素照样落在 120px 的矩形里），而且 `scenePoint` 还会把落点夹进可点区域；
 * - **手柄只有 7px**，几十像素的偏差就是「点了没反应」，而且 `scenePoint` 的夹取会
 *   把落点挪到别处。所以凡是要点手柄，一律用这个精确换算。
 */
export async function preciseWorldPoint(
  page: Page,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const viewport = await sceneViewport(page);
  return {
    x: viewport.left + viewport.tx + world.x * viewport.scale,
    y: viewport.top + viewport.ty - world.y * viewport.scale,
  };
}

/**
 * 对象**当前**在屏幕哪儿：用对象中心的世界坐标做精确换算。
 *
 * 手柄贴在对象外框之外，所以「从对象出发按视口缩放量偏移」是唯一稳的算法。
 */
export async function objectScreenPoint(
  page: Page,
  center: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return preciseWorldPoint(page, center);
}

/**
 * 画布上放**手柄**（或任何贴在对象上的 UI）时用的换算：把世界位移换成屏幕像素位移。
 *
 * 与 `worldSamplePoint` / `scenePoint` 的区别：那两个假设「世界原点在画布正中」，
 * 只在没有左右面板挤压时对；**手柄贴在对象上**，位置由视口变换决定，
 * 所以要从「对象当前在屏幕哪儿」出发，按 `视口缩放` 加位移，才能点中。
 * 纯平移的量用不着视口原点，因此这条不需要读 DOM 属性。
 */
export async function offsetFrom(
  page: Page,
  base: { x: number; y: number },
  worldDelta: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const { scale } = await sceneViewport(page);
  return { x: base.x + worldDelta.x * scale, y: base.y - worldDelta.y * scale };
}

/**
 * 场景视口的**真实**变换（`scale` / `tx` / `ty`），由场景面板把它写在
 * `[data-testid="scene-viewport"]` 的 DOM 属性上。
 *
 * 为什么要读它而不是「画布中心 = 世界原点」：那条假设只在画布铺满窗口时成立，
 * 而画布会被左右面板挤窄、容器上下还有别的区块，于是「画布中心」和「视口原点」
 * 能差出几十像素——按中心算出来的世界坐标会整体偏掉，手柄根本点不中。
 */
export async function sceneViewport(
  page: Page,
): Promise<{ scale: number; tx: number; ty: number; left: number; top: number }> {
  const box = await page.getByTestId("scene-viewport").boundingBox();
  if (box === null) {
    throw new Error("拿不到场景视口尺寸");
  }

  const viewport = await page.getByTestId("scene-viewport").evaluate((element) => ({
    scale: Number(element.getAttribute("data-viewport-scale")),
    tx: Number(element.getAttribute("data-viewport-tx")),
    ty: Number(element.getAttribute("data-viewport-ty")),
  }));

  return { ...viewport, left: box.x, top: box.y };
}

/**
 * 世界坐标 → 屏幕点（**精确**，用于点手柄 / 断言手柄位置）。
 *
 * 与 `worldSamplePoint` 的区别：那个假设「世界原点在画布正中」，只在地图铺满的
 * 老用例里够用；手柄场景必须按视口真实变换算，否则点不中。
 * 不夹取：调用方自己选的点要么在视口里，要么就是用例写错了。
 */
export async function exactWorldPoint(
  page: Page,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const viewport = await sceneViewport(page);
  return {
    x: viewport.left + viewport.tx + world.x * viewport.scale,
    y: viewport.top + viewport.ty - world.y * viewport.scale,
  };
}

/**
 * 画布（canvas）上的坐标与采样工具（用例共用）。
 *
 * 默认视口是 scale 1 且**世界原点在画布正中**（`createCenteredViewport`），
 * 所以「世界坐标 → 画布上的点」只有一步：`screen = 画布中心 + (x, -y)`。
 *
 * **必须用 canvas 而不是 `scene-viewport` 容器**：默认视口把世界原点摆在**画布正中**，
 * 而画布是定宽撑满的——容器比它窄时（平板竖屏左边压着抽屉），两个「中心」能差出上百像素，
 * 按容器中心算出来的世界坐标会整体偏掉，点哪儿都不中。
 */

/** 平板抽屉宽度：竖屏下它盖在画布边缘上，落点必须避开。 */
export const DRAWER_WIDTH = 340;

export async function canvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator("canvas").boundingBox();
  if (box === null) {
    throw new Error("拿不到画布尺寸");
  }

  return box;
}

/**
 * 世界坐标 → 画布上的屏幕点。
 *
 * 算出来的点还要**夹进真正点得到的区域**：
 * - 平板下左边 `DRAWER_WIDTH` 像素是抽屉，即使画布铺满整宽，点在那里也会被抽屉吃掉；
 * - 世界坐标可以很大（场景是 1920×1080），直接换算会跑到画布外面去。
 *
 * 所以用例用 `clampedWorldPoint()` 拿到「实际落点 + 它对应的世界坐标」，
 * 再拿这个坐标去种对象、做断言。
 */
export async function scenePoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);

  const inset = 24;
  const raw = { x: box.x + box.width / 2 + x, y: box.y + box.height / 2 - y };
  return {
    x: Math.min(box.x + box.width - inset, Math.max(box.x + DRAWER_WIDTH + inset, raw.x)),
    y: Math.min(box.y + box.height - inset, Math.max(box.y + inset, raw.y)),
  };
}

/** 世界坐标 → 实际落点，以及**落点反推回来的世界坐标**（被夹过时用后者断言）。 */
export async function clampedWorldPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ point: { x: number; y: number }; world: { x: number; y: number } }> {
  const point = await scenePoint(page, x, y);
  return { point, world: await sceneWorldAt(page, point) };
}

/** 屏幕点 → 世界坐标（默认视口：世界原点在画布正中，y 向上）。 */
export async function sceneWorldAt(
  page: Page,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);
  return { x: point.x - (box.x + box.width / 2), y: box.y + box.height / 2 - point.y };
}

/**
 * 世界坐标 → 画布上的屏幕点，**不**夹取（只用来采样像素 / 精确点击）。
 *
 * 采样要看地图真实画在哪，不能像点击那样被夹进「点得到的区域」。
 */
export async function worldSamplePoint(
  page: Page,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);
  return { x: box.x + box.width / 2 + world.x, y: box.y + box.height / 2 - world.y };
}

/**
 * 取某个画布上某个屏幕点周围 `radius` 像素的**平均颜色**（按 DPR 换算到后备缓冲像素）。
 *
 * `canvasTestId` 用 `undefined` 表示「页面上第一块画布」（场景画布）；窗口里那几块
 * （网格编辑 / 战争雾遮罩）要按 testid 指定——同时挂在 DOM 里时第一块永远是场景画布。
 *
 * 取平均而不是单点：网格线 / 原点十字 / 画笔预览随时可能正好压在被采样的那个像素上，
 * 单点会读到它们的颜色。一片纯色贴图的平均值仍然明显偏它自己的颜色。
 */
export async function canvasColorAt(
  page: Page,
  canvasTestId: string | undefined,
  point: { x: number; y: number },
  radius = 4,
): Promise<{ r: number; g: number; b: number; a: number }> {
  return page.evaluate(
    ({ testId, x, y, radius }) => {
      const canvas =
        testId === null
          ? document.querySelector("canvas")
          : document.querySelector(`[data-testid="${testId}"]`);
      const context = canvas instanceof HTMLCanvasElement ? canvas.getContext("2d") : null;
      if (canvas === null || context === null) {
        return { r: -1, g: -1, b: -1, a: -1 };
      }

      const rect = canvas.getBoundingClientRect();
      const ratio = canvas.width / Math.max(1, rect.width);
      const size = Math.max(1, Math.round(radius * ratio));
      const px = Math.round((x - rect.left) * ratio) - Math.floor(size / 2);
      const py = Math.round((y - rect.top) * ratio) - Math.floor(size / 2);
      const data = context.getImageData(px, py, size, size).data;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
        a += data[i + 3] ?? 0;
      }

      return { r: r / pixels, g: g / pixels, b: b / pixels, a: a / pixels };
    },
    { testId: canvasTestId ?? null, x: point.x, y: point.y, radius },
  );
}

/**
 * 场景画布上某个屏幕点的平均颜色（不传 testid = 页面上第一块画布）。
 *
 * 采样的含义见 `canvasColorAt`。
 */
export async function canvasAverageColor(
  page: Page,
  point: { x: number; y: number },
  radius = 4,
): Promise<{ r: number; g: number; b: number; a: number }> {
  return canvasColorAt(page, undefined, point, radius);
}

/**
 * **「画布就是这块地图」**的窗口（战争雾 Mask 窗口：贴图与遮罩绝对定位铺满长宽比盒子）
 * 上，某一格的屏幕点。
 *
 * 与 `fittedCellPoint` 的区别：那边是 `SceneLayer` 渲染的窗口（视口按 `fitViewport`
 * 算、有边距），这边画布 == 地图矩形，所以只有一步等比换算；**y 要翻**——
 * 格子 `(x, 0)` 是图片最下面一行。
 */
export async function cellPointInBox(
  page: Page,
  canvasTestId: string,
  grid: { width: number; height: number },
  cell: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(canvasTestId).boundingBox();
  if (box === null) {
    throw new Error(`拿不到 ${canvasTestId} 的尺寸`);
  }

  return {
    x: box.x + ((cell.x + 0.5) * box.width) / grid.width,
    y: box.y + ((grid.height - 1 - cell.y + 0.5) * box.height) / grid.height,
  };
}


/** 这个屏幕点正下方真的是画布吗（抽屉 / 面板会盖在上面，点不到画布）。 */
export async function canvasPointReachable(
  page: Page,
  point: { x: number; y: number },
): Promise<boolean> {
  return page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
    point,
  );
}

/**
 * 整块画布的**像素和**：一条粗粒度的「画布指纹」。
 *
 * 用来断言「显示开关真的改了画面」而不用挑单点：贴图取深色时，网格线（白，α0.12）
 * 压在它上面会让总和明显变高，关掉网格线总和就掉下来。单点采样反而不好使——
 * 网格线只有 1px 宽，采样点很容易正好压在线上或正好避开。
 */
export async function canvasPixelSum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === null || context === null) {
      return -1;
    }

    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let index = 0; index < data.length; index += 4) {
      sum += (data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0);
    }

    return sum;
  });
}

/**
 * **格子编辑窗口**（`CellPaintDialog`：战争雾 / 网格编辑共用）画布上，某一格的屏幕点。
 *
 * 窗口用 `fitViewport([贴图矩形], 画布尺寸, padding)` 把这张地图装满，而贴图矩形的中心
 * **就是世界原点**（窗口是这张地图的独立视图），所以世界原点落在画布正中、换算只有一步：
 *
 * ```
 * screen = 画布中心 + 世界坐标 × scale
 * ```
 *
 * `scale` 取「可用宽 / 贴图宽」与「可用高 / 贴图高」的较小值——与 `fitViewport` 同一算式。
 * 这里手写一遍是有意的：断言看的是**真点之后落进文件的那一格**，而不是「点了某个像素」。
 */
export async function fittedCellPoint(
  page: Page,
  canvasTestId: string,
  mapSize: { width: number; height: number },
  grid: { width: number; height: number },
  cell: { x: number; y: number },
  padding = 12,
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(canvasTestId).boundingBox();
  if (box === null) {
    throw new Error(`拿不到 ${canvasTestId} 的尺寸`);
  }

  const scale = Math.min(
    (box.width - padding * 2) / mapSize.width,
    (box.height - padding * 2) / mapSize.height,
  );
  const cellSize = { x: mapSize.width / grid.width, y: mapSize.height / grid.height };
  const world = {
    x: (cell.x + 0.5) * cellSize.x - mapSize.width / 2,
    y: (cell.y + 0.5) * cellSize.y - mapSize.height / 2,
  };

  return {
    x: box.x + box.width / 2 + world.x * scale,
    y: box.y + box.height / 2 - world.y * scale,
  };
}

/**
 * 找一个**真正点得到**的空白屏幕点：屏幕坐标在「抽屉右边 / 画布里面」，
 * 而且正下方就是画布（不是别的面板）。
 *
 * 世界原点在画布正中，而画布可能比窗口宽——所以「画布左侧」未必露得出来。
 * 这里不猜，直接按候选世界坐标换算出屏幕点再验证。
 */
export async function findEmptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);

  // 世界坐标上下左右都撒一点：平板竖屏左边是抽屉、横屏右边可能是属性抽屉，
  // 「哪一侧露得出来」随档位变，所以不猜方向，扫一遍。
  for (let y = 360; y >= -360; y -= 120) {
    for (let x = 320; x >= -320; x -= 80) {
      const point = await worldSamplePoint(page, { x, y });
      if (point.x < box.x + DRAWER_WIDTH + 24 || point.y < box.y + 24) {
        continue;
      }

      if (await canvasPointReachable(page, point)) {
        return point;
      }
    }
  }

  throw new Error("找不到可点击的空白处");
}

/**
 * 在画布上一笔划过（按下 → 若干次移动 → 抬手）。
 *
 * 用 `steps` 让中间产生多个 pointermove：涂抹的「补齐直线」逻辑靠它才生效，
 * 直接跳两点的话测不到「快拖也不断线」。
 */
export async function dragOnCanvas(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
