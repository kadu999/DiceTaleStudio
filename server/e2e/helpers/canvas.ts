import { type Page } from "@playwright/test";

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
 * 取画布上某个屏幕点周围 `radius` 像素的**平均颜色**（按 DPR 换算到后备缓冲像素）。
 *
 * 取平均而不是单点：网格线 / 原点十字 / 画笔预览随时可能正好压在被采样的那个像素上，
 * 单点会读到它们的颜色。一片纯色贴图的平均值仍然明显偏它自己的颜色。
 */
export async function canvasAverageColor(
  page: Page,
  point: { x: number; y: number },
  radius = 4,
): Promise<{ r: number; g: number; b: number }> {
  return page.evaluate(
    ({ x, y, radius }) => {
      const canvas = document.querySelector("canvas");
      const context = canvas?.getContext("2d") ?? null;
      if (canvas === null || context === null) {
        return { r: -1, g: -1, b: -1 };
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
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
      }

      return { r: r / pixels, g: g / pixels, b: b / pixels };
    },
    { x: point.x, y: point.y, radius },
  );
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
