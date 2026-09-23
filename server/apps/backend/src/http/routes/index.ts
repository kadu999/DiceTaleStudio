import type { Route } from "../router";
import { getConfig } from "./config";
import { getHealth } from "./health";
import {
  createProjectFolderRoute,
  createProjectRoute,
  deleteProjectRoute,
  getProjectMetasRoute,
  getProjectAssetByGuidRoute,
  getProjectTreeRoute,
  listProjectsRoute,
  revealProjectPathRoute,
} from "./projects";
import {
  deleteResourceRoute,
  getBundleRoute,
  getManifestRoute,
  listResourcesRoute,
  readResourceRoute,
  readResourceTextRoute,
  renameResourceRoute,
  writeResourceRoute,
  writeResourceTextRoute,
} from "./resources";
import { getState } from "./state";

/**
 * 路由表：**加一条接口 = 加一个函数 + 加一行**。
 *
 * 顺序无关紧要（按「路径精确匹配 + 动词」查表），但分组与 `README` 的接口清单保持一致：
 * 运行态摘要 → 项目 → 通用资源。
 *
 * `PUT` 与 `POST` 共用同一个写资源函数是有意的：两者语义相同（请求体就是文件内容），
 * 前端历史上两种都发过，收窄会破坏已有的上传路径。
 */
export const ROUTES: readonly Route[] = [
  // ---------------------------------------------------------------- 运行态摘要
  { method: "GET", path: "/api/health", handler: getHealth },
  { method: "GET", path: "/api/config", handler: getConfig },
  { method: "GET", path: "/api/state", handler: getState },

  // ---------------------------------------------------------------- 项目
  { method: "GET", path: "/api/projects", handler: listProjectsRoute },
  { method: "POST", path: "/api/projects", handler: createProjectRoute },
  { method: "DELETE", path: "/api/projects", handler: deleteProjectRoute },
  { method: "GET", path: "/api/projects/tree", handler: getProjectTreeRoute },
  { method: "GET", path: "/api/projects/meta", handler: getProjectMetasRoute },
  { method: "GET", path: "/api/projects/asset", handler: getProjectAssetByGuidRoute },
  { method: "POST", path: "/api/projects/folder", handler: createProjectFolderRoute },
  { method: "POST", path: "/api/projects/reveal", handler: revealProjectPathRoute },

  // ---------------------------------------------------------------- 通用资源
  { method: "GET", path: "/api/resources/index", handler: listResourcesRoute },
  { method: "GET", path: "/api/resources/raw", handler: readResourceRoute },
  { method: "PUT", path: "/api/resources/raw", handler: writeResourceRoute },
  { method: "POST", path: "/api/resources/raw", handler: writeResourceRoute },
  { method: "DELETE", path: "/api/resources/raw", handler: deleteResourceRoute },
  { method: "GET", path: "/api/resources/text", handler: readResourceTextRoute },
  { method: "PUT", path: "/api/resources/text", handler: writeResourceTextRoute },
  { method: "POST", path: "/api/resources/text", handler: writeResourceTextRoute },
  { method: "GET", path: "/api/resources/manifest", handler: getManifestRoute },
  { method: "GET", path: "/api/resources/bundle", handler: getBundleRoute },
  { method: "POST", path: "/api/resources/rename", handler: renameResourceRoute },
];
