import { expect, test } from "@playwright/test";
import {
  dropProject,
  enterEditor,
  mapObjectDoc,
  newProject,
  openLeftTab,
  openProject,
  sceneDoc,
  sceneObjectDoc,
  seedProjectDoc,
  startupDialogMode,
  waitForBootstrap,
} from "./helpers/editor";

/**
 * 场景数据与场景对象（Hierarchy）。
 *
 * 编辑器目前**只读**：场景的新建/切换、对象的新建/添加地图都没有 UI 入口，
 * 内容由工程文件提供。所以用例先把内容写进工程文件、再从编辑器里读回来——
 * 这同时也验证了「工程文件里的场景与对象会被正确读出」。
 *
 * 每个用例自建项目并自清理，不依赖其它用例的副作用。
 */

const SCENE_A = "Map001";
// 第二个场景也用拉丁名：当前场景取「按名字排序的第一个」，
// 混排中英文时中文会排在拉丁字母前面（localeCompare zh-Hans-CN），会让断言变得不好读
const SCENE_B = "Map002";

/** 建项目 → 造场景 → 打开它。 */
async function openSeededProject(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  project: string,
  scenes: readonly Record<string, unknown>[],
): Promise<void> {
  await seedProjectDoc(request, project, scenes);
  await enterEditor(page);
  await openProject(page, project);
}

test.describe("场景数据", () => {
  test("工程文件里的多个场景都会被读出，当前场景是第一个", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSeededProject(page, request, project, [sceneDoc(SCENE_A), sceneDoc(SCENE_B)]);

      await expect(page.getByTestId("status-scenes")).toHaveText("场景 2");
      await expect(page.getByTestId("status-active-scene")).toHaveText(`当前场景 ${SCENE_A}`);
    } finally {
      await dropProject(request, project);
    }
  });

  test("刷新后自动回到上次的项目，场景还在", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSeededProject(page, request, project, [sceneDoc(SCENE_A)]);
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");

      await page.reload();
      await waitForBootstrap(page);

      // 自动回到上次的项目：不弹对话框，场景从磁盘读回来
      expect(await startupDialogMode(page)).toBe("none");
      await expect(page.getByTestId("status-doc")).toHaveText(project);
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
    } finally {
      await dropProject(request, project);
    }
  });

  test("旧版工程文件（v2，场景内联）打开时自动升级：场景拆成文件、工程文件回写 v3", async ({
    page,
    request,
  }) => {
    const project = await newProject(request);
    try {
      // 造一个 v2 工程文件：场景内联在里面（这就是升级前的形态）
      const legacy = {
        formatVersion: 2,
        name: project,
        scenes: [
          {
            id: "m1",
            name: SCENE_A,
            objects: [
              { id: "door", name: "木门", kind: "SceneObject", position: null, rotation: 0, components: [] },
            ],
          },
        ],
        items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      };
      const projectId = `project:${project}/project.json`;
      const written = await request.put(
        `/api/resources/text?id=${encodeURIComponent(projectId)}`,
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
          data: `${JSON.stringify(legacy, null, 2)}\n`,
        },
      );
      expect(written.ok()).toBeTruthy();

      await enterEditor(page);
      await openProject(page, project);

      // 场景照样读得出来（内容没丢）
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
      await openLeftTab(page, "hierarchy");
      await expect(page.getByTestId("object-row").filter({ hasText: "木门" })).toBeVisible();

      // 工程文件已回写成 v4：不再有 scenes
      const doc = JSON.parse(
        await (await request.get(`/api/resources/text?id=${encodeURIComponent(projectId)}`)).text(),
      ) as Record<string, unknown>;
      expect(doc.formatVersion).toBe(4);
      expect("scenes" in doc).toBe(false);

      // 场景被拆成了独立文件，内容原样搬过去
      const sceneResponse = await request.get(
        `/api/resources/text?id=${encodeURIComponent(
          `project:${project}/Assets/scenes/${SCENE_A}.json`,
        )}`,
      );
      expect(sceneResponse.ok()).toBeTruthy();
      const scene = JSON.parse(await sceneResponse.text()) as {
        objects: Array<{ name: string }>;
        formatVersion: number;
      };
      expect(scene.formatVersion).toBe(4);
      expect(scene.objects.map((object) => object.name)).toEqual(["木门"]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("旧版场景文件（v3）打开时自动回写：内容不变、升到 v4", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      // 造一份「旧版编辑器写出来的」工程文件 + 场景文件
      const projectDoc = {
        formatVersion: 3,
        name: project,
        items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      };
      const legacyScene = {
        formatVersion: 3,
        objects: [
          { id: "door", name: "木门", kind: "SceneObject", position: null, rotation: 0, components: [] },
        ],
      };

      for (const [subPath, body] of [
        ["project.json", projectDoc],
        [`Assets/scenes/${SCENE_A}.json`, legacyScene],
      ] as const) {
        const response = await request.put(
          `/api/resources/text?id=${encodeURIComponent(`project:${project}/${subPath}`)}`,
          {
            headers: { "content-type": "text/plain; charset=utf-8" },
            data: `${JSON.stringify(body, null, 2)}\n`,
          },
        );
        expect(response.ok()).toBeTruthy();
      }

      await enterEditor(page);
      await openProject(page, project);

      // 内容照常读出来
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
      await openLeftTab(page, "hierarchy");
      await expect(page.getByTestId("object-row").filter({ hasText: "木门" })).toBeVisible();

      // 场景文件被回写成 v4：对象还在
      const sceneResponse = await request.get(
        `/api/resources/text?id=${encodeURIComponent(
          `project:${project}/Assets/scenes/${SCENE_A}.json`,
        )}`,
      );
      const scene = JSON.parse(await sceneResponse.text()) as Record<string, unknown> & {
        objects: Array<{ name: string }>;
      };
      expect(scene.formatVersion).toBe(4);
      expect(scene.objects.map((object) => object.name)).toEqual(["木门"]);
    } finally {
      await dropProject(request, project);
    }
  });

  test("没有场景时：画布与场景对象面板都明确显示「没有场景」", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await enterEditor(page);
      await openProject(page, project);

      // 画布不画假网格，而是给出占位（否则「什么都没有」看起来像「有个空地图」）
      await expect(page.getByTestId("no-scene-canvas")).toBeVisible();
      await expect(page.getByTestId("scene-viewport").getByText("没有场景")).toBeVisible();

      await openLeftTab(page, "hierarchy");
      await expect(page.getByTestId("object-tree").getByText("没有场景")).toBeVisible();
      await expect(page.getByTestId("object-row")).toHaveCount(0);

      // 属性面板**不跟场景绑定**：没有场景时显示项目属性，而不是「没有场景」
      if (!(await page.getByTestId("project-properties").isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "属性", exact: true }).click();
      }

      await expect(page.getByTestId("project-properties")).toBeVisible();
      await expect(page.getByTestId("project-properties")).toContainText(project);
      await expect(page.getByTestId("project-properties")).toContainText("0 个");
    } finally {
      await dropProject(request, project);
    }
  });
});

test.describe("场景对象", () => {
  test("对象挂在场景上：没有地图对象也照样有对象", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSeededProject(page, request, project, [sceneDoc(SCENE_A, [sceneObjectDoc("木门")])]);
      await openLeftTab(page, "hierarchy");

      await expect(page.getByTestId("object-row").filter({ hasText: "木门" })).toBeVisible();
      // 场景里没有地图对象，对象照样在
      await expect(page.getByTestId("object-row").filter({ hasText: "地图" })).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });

  test("地图作为对象出现，带自己的网格尺寸（不是场景本身）", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSeededProject(page, request, project, [
        sceneDoc(SCENE_A, [mapObjectDoc(project, SCENE_A)]),
      ]);
      await openLeftTab(page, "hierarchy");

      const mapRow = page.getByTestId("object-row").filter({ hasText: "地图" }).first();
      await expect(mapRow).toBeVisible();
      await expect(mapRow).toContainText("64×36");

      // 地图只是场景里的一个对象：场景数量没变
      await expect(page.getByTestId("status-scenes")).toHaveText("场景 1");
    } finally {
      await dropProject(request, project);
    }
  });

  test("面板只列对象（没有内联新建行），新建入口在画布标题栏", async ({ page, request }) => {
    const project = await newProject(request);
    try {
      await openSeededProject(page, request, project, [sceneDoc(SCENE_A)]);
      await openLeftTab(page, "hierarchy");

      await expect(page.getByTestId("object-tree")).toBeVisible();
      // 创建统一走弹框，面板里不该再有类型下拉 / 名字输入 / 确定按钮
      await expect(page.getByTestId("object-name-input")).toHaveCount(0);
      await expect(page.getByTestId("object-kind")).toHaveCount(0);
      await expect(page.getByTestId("confirm-object")).toHaveCount(0);
      // 入口在画布标题栏（创建出来的对象落在场景正中）
      await expect(page.getByTestId("new-object")).toBeVisible();
      await expect(page.getByTestId("add-map")).toHaveCount(0);
    } finally {
      await dropProject(request, project);
    }
  });
});
