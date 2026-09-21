import { describe, expect, it } from "vitest";
import { assetDisplayPath, findAssetById, listAudioAssets, listImageAssets, listVideoAssets } from "../src/panels/asset-picker";
import type { ResourceTreeNode } from "../src/services/project-api";

/** 资源树的小样例：一张图、一个视频、一层子目录。 */
const TREE: ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: "project:我的项目/Assets",
    type: "folder",
    children: [
      {
        name: "images",
        path: "Assets/images",
        id: "project:我的项目/Assets/images",
        type: "folder",
        children: [
          {
            name: "Map001.png",
            path: "Assets/images/Map001.png",
            id: "project:我的项目/Assets/images/Map001.png",
            type: "file",
          },
          {
            name: "Map002.png",
            path: "Assets/images/Map002.png",
            id: "project:我的项目/Assets/images/Map002.png",
            type: "file",
          },
        ],
      },
      {
        name: "video",
        path: "Assets/video",
        id: "project:我的项目/Assets/video",
        type: "folder",
        children: [
          {
            name: "Map001.mp4",
            path: "Assets/video/Map001.mp4",
            id: "project:我的项目/Assets/video/Map001.mp4",
            type: "file",
          },
        ],
      },
      {
        name: "audio",
        path: "Assets/audio",
        id: "project:我的项目/Assets/audio",
        type: "folder",
        children: [
          {
            name: "bgm.mp3",
            path: "Assets/audio/bgm.mp3",
            id: "project:我的项目/Assets/audio/bgm.mp3",
            type: "file",
          },
          {
            name: "step1.wav",
            path: "Assets/audio/step1.wav",
            id: "project:我的项目/Assets/audio/step1.wav",
            type: "file",
          },
        ],
      },
    ],
  },
];

describe("资源显示路径", () => {
  it("省掉 project: 前缀、项目名与 Assets/，只留项目内相对路径", () => {
    expect(assetDisplayPath("project:我的项目/Assets/images/Map001.png")).toBe("images/Map001.png");
    expect(assetDisplayPath("project:我的项目/Assets/video/Map001.mp4")).toBe("video/Map001.mp4");
  });

  it("不是项目资源的 id 原样返回（不猜）", () => {
    expect(assetDisplayPath("config/editor.json")).toBe("config/editor.json");
  });
});

describe("图片素材列表", () => {
  it("只挑图片，且按路径排序", () => {
    expect(listImageAssets(TREE).map((node) => node.id)).toEqual([
      "project:我的项目/Assets/images/Map001.png",
      "project:我的项目/Assets/images/Map002.png",
    ]);
  });

  it("按 id 找得到文件（用于判断贴图是否存在）", () => {
    expect(findAssetById(TREE, "project:我的项目/Assets/images/Map002.png")?.name).toBe("Map002.png");
    expect(findAssetById(TREE, "project:我的项目/Assets/images/场景1.png")).toBeUndefined();
  });
});

describe("音频素材列表（选择音频弹框用）", () => {
  it("只挑音频（mp3 / wav），图片与视频都不算", () => {
    expect(listAudioAssets(TREE).map((node) => node.id)).toEqual([
      "project:我的项目/Assets/audio/bgm.mp3",
      "project:我的项目/Assets/audio/step1.wav",
    ]);
  });
});

describe("视频素材列表（选择视频弹框用）", () => {
  it("只挑视频（mp4 / webm），图片与音频都不算", () => {
    expect(listVideoAssets(TREE).map((node) => node.id)).toEqual([
      "project:我的项目/Assets/video/Map001.mp4",
    ]);
  });
});
