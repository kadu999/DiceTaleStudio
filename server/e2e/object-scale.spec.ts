import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  closeDrawers,
  dropProject,
  enterEditor,
  newProject,
  openInspector,
  openLeftTab,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  selectObject,
  solidPng,
} from "./helpers/editor";
import {
  canvasAverageColor,
  canvasPointReachable,
  findEmptyCanvasPoint,
  worldSamplePoint,
} from "./helpers/canvas";

/**
 * 对象的**缩放**：每个对象的基础属性都有它，默认 1。
 *
 * 用一个「120×120 的纯绿精灵」来量，因为缩放的效果可以直接在画布像素上读出来：
 * 缩放 1 时它覆盖 `±60`，缩放 2 时覆盖 `±120`——(100, 0) 这一点就从前者的「外面」
 * 变成后者的「里面」。顺便验证**拾取范围跟着一起变**（显示 / 拾取 / 选中框共用同一块矩形）。
 */

const SCENE = "Map001";
/** 贴图声明尺寸 = 世界尺寸（1 图片像素 = 1 世界像素，再乘缩放）。 */
const SIZE = { width: 120, height: 120 };
const IMAGE_PATH = "Assets/images/Sprite.png";

/** 场景里第一个对象在文件里的缩放（还没落盘时返回 undefined）。 */
async function persistedScale(
  request: APIRequestContext,
  project: string,
): Promise<number | undefined> {
  const id = `project:${project}/Assets/scenes/${SCENE}.json`;
  const response = await request.get(`/api/resources/text?id=${encodeURIComponent(id)}`);
  if (!response.ok()) {
    return undefined;
  }

  const raw = (await response.json()) as { objects?: Array<{ scale?: number }> };
  return raw.objects?.[0]?.scale;
}

/** 画布上某个世界点是不是「精灵的颜色」（纯绿贴图；棋盘底纹与网格线都不是）。 */
async function isSpriteColor(page: Page, world: { x: number; y: number }): Promise<boolean> {
  const color = await canvasAverageColor(page, await worldSamplePoint(page, world));
  return color.g > 180 && color.r < 90;
}

test.describe("对象缩放", () => {
  test("默认 1；改成 2 后画布上真的变大、拾取范围跟着变，并落盘", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await seedProjectDoc(request, project, [
        sceneDoc(SCENE, [
          sceneObjectDoc("精灵", "SceneObject", { x: 0, y: 0 }, {
            image: { id: `project:${project}/${IMAGE_PATH}`, width: SIZE.width, height: SIZE.height },
          }),
        ]),
      ]);
      const uploaded = await request.put(
        `/api/resources/raw?id=${encodeURIComponent(`project:${project}/${IMAGE_PATH}`)}`,
        {
          headers: { "content-type": "image/png" },
          data: solidPng(SIZE.width, SIZE.height, [0, 255, 0]),
        },
      );
      expect(uploaded.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);
      await selectObject(page);

      // 默认 1：精灵覆盖 ±60 —— (40, 0) 在里面，(100, 0) 在外面
      await expect(page.getByTestId("inspector-object-scale")).toHaveValue("1");
      await expect.poll(() => isSpriteColor(page, { x: 40, y: 0 })).toBe(true);
      await expect.poll(() => isSpriteColor(page, { x: 100, y: 0 })).toBe(false);

      // 改成 2：覆盖 ±120，(100, 0) 也进了精灵的范围
      const scaleInput = page.getByTestId("inspector-object-scale");
      await scaleInput.fill("2");
      await scaleInput.blur();
      await expect.poll(() => isSpriteColor(page, { x: 100, y: 0 })).toBe(true);

      // 落盘：scale 写进场景文件
      await expect.poll(() => persistedScale(request, project)).toBe(2);

      // 拾取范围也变大了。平板下左右抽屉盖着画布，先全部关掉，再点空白取消选中
      await closeDrawers(page);
      const blank = await findEmptyCanvasPoint(page);
      await page.mouse.click(blank.x, blank.y);

      // (100, 0) 现在确实点得到，而且点下去应该命中精灵（缩放后的矩形覆盖 ±120）
      const inside = await worldSamplePoint(page, { x: 100, y: 0 });
      expect(await canvasPointReachable(page, inside)).toBe(true);
      await page.mouse.click(inside.x, inside.y);

      // 打开场景对象列表（平板下是左抽屉）看选中状态——**不点行**，否则等于自问自答
      await openLeftTab(page, "hierarchy");
      await expect(page.getByTestId("object-row").first()).toHaveAttribute("data-selected", "true");

      // 缩回 1：(100, 0) 又回到外面
      await openInspector(page);
      await expect(page.getByTestId("inspector-object-scale")).toHaveValue("2");
      await page.getByTestId("inspector-object-scale").fill("1");
      await page.getByTestId("inspector-object-scale").blur();
      await expect.poll(() => isSpriteColor(page, { x: 100, y: 0 })).toBe(false);
      await expect.poll(() => persistedScale(request, project)).toBe(1);
    } finally {
      await dropProject(request, project);
    }
  });
});
