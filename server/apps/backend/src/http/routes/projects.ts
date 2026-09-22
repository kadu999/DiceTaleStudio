import { stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createEmptyProject } from "@dts/document";
import {
  buildResourceTree,
  createProject,
  deleteProject,
  listProjects,
  normalizePath,
  projectFileId,
  projectFolderId,
  projectPath,
  readProjectEntries,
  validateProjectName,
  validateProjectRelativePath,
} from "@dts/resources";
import { bodyString, bodyTrimmed, queryRaw, readJsonBody } from "../requests";
import { HttpError, badRequest, sendJson } from "../responses";
import type { RouteContext } from "../router";

/**
 * 项目接口：**一条协议一个函数**。
 *
 * 这里只有项目（= `resources/projects/<项目名>/` 那一层）的生命周期与资源树；
 * 项目**内容**（场景、素材）走 `/api/resources/*`（见 `./resources.ts`）。
 */

/** `GET /api/projects`：列出全部项目（判定标准只有一条：文件夹里有 `project.json`）。 */
export async function listProjectsRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.response, 200, { projects: await listProjects(ctx.provider) });
}

/** `POST /api/projects`：新建项目（写项目文件 + 建标准子目录）。重名 / 非法名 → 400。 */
export async function createProjectRoute(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const name = bodyTrimmed(body, "name");

  try {
    await createProject(ctx.provider, name, {
      folders: ctx.config.app.projectFolders,
      project: createEmptyProject(name),
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }

  ctx.log("info", `已创建项目: ${name}`);
  sendJson(ctx.response, 201, { ok: true, name });
}

/** `DELETE /api/projects?name=`：删除整个项目（连资源一起清掉）。 */
export async function deleteProjectRoute(ctx: RouteContext): Promise<void> {
  const name = queryRaw(ctx.url, "name");

  let removed: number;
  try {
    ({ removed } = await deleteProject(ctx.provider, name));
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }

  ctx.log("info", `已删除项目: ${name}（清理 ${removed} 个文件）`);
  sendJson(ctx.response, 200, { ok: true, name, removed });
}

/**
 * `GET /api/projects/tree?name=`：资源树（编辑器 Assets 面板用）。
 *
 * 不存在的项目返回**空树 + `exists:false`**，而不是错误——否则会把「标准子目录」
 * 凭空画出来，让人以为项目还在。
 */
export async function getProjectTreeRoute(ctx: RouteContext): Promise<void> {
  const name = queryRaw(ctx.url, "name");
  if (name.length === 0) {
    throw badRequest("缺少 name 参数");
  }

  const entries = await readProjectEntries(ctx.provider, name);
  sendJson(ctx.response, 200, {
    name,
    exists: entries.length > 0,
    tree:
      entries.length === 0
        ? []
        : buildResourceTree(name, entries, ctx.config.app.projectFolders),
  });
}

/** `POST /api/projects/folder`：在项目里建一个目录（路径必须过项目内相对路径校验）。 */
export async function createProjectFolderRoute(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const project = bodyString(body, "project");
  const folderPath = bodyString(body, "path");
  const reason = validateProjectRelativePath(folderPath);
  if (project.length === 0 || reason !== undefined) {
    throw badRequest(reason ?? "缺少 project 参数");
  }

  const id = projectFolderId(project, folderPath);
  await ctx.provider.ensureFolder(id);
  ctx.log("info", `已创建目录: ${id}`);
  sendJson(ctx.response, 201, { ok: true, id });
}

/**
 * `POST /api/projects/reveal`：用文件管理器打开项目里的某一层（资源面板的「打开目录」按钮）。
 *
 * 打开的是**服务端这台机器**上的目录：浏览器不能替用户开文件夹，所以只能后端做。
 * 绝对路径由服务端自己拼（`资源根 / projects / 项目名 / 项目内相对路径`），
 * 客户端只能给**项目内的相对路径**，而且必须过 `validateProjectRelativePath`
 * （逐段拒绝 `..`），拼好后还要**再确认落在项目目录里**才 spawn——这是这个接口的安全边界。
 *
 * 请求体：
 * - `name`：项目名（必填）；
 * - `path`：项目内相对路径（可选，空 = 项目根）；
 * - `selectFile`：为真且 `path` 指向一个**存在的文件**时，打开它所在的目录并选中它
 *   （Linux 没有统一的「选中文件」接口，会退回打开父目录）。
 */
export async function revealProjectPathRoute(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);

  const name = bodyTrimmed(body, "name");
  const nameReason = validateProjectName(name);
  if (nameReason !== undefined) {
    throw badRequest(nameReason);
  }

  if (!(await ctx.provider.exists(projectFileId(name)))) {
    throw new HttpError(404, `项目「${name}」不存在`);
  }

  const subPath = normalizePath(bodyString(body, "path")).trim();
  if (subPath.length > 0) {
    const pathReason = validateProjectRelativePath(subPath);
    if (pathReason !== undefined) {
      throw badRequest(pathReason);
    }
  }

  const projectFolder = resolve(ctx.config.resourceRoot, ctx.config.dirs.project, projectPath(name));
  const target = subPath.length === 0 ? projectFolder : resolve(projectFolder, ...subPath.split("/"));
  // 拼出来之后再确认一次：任何越出项目目录的路径都不许开
  if (target !== projectFolder && !target.startsWith(projectFolder + sep)) {
    throw badRequest("路径不允许越出项目目录");
  }

  const selectFile = body.selectFile === true;
  let fileToSelect: string | undefined;
  if (selectFile && subPath.length > 0) {
    // 只对**真实存在的文件**做「选中」：目录也过 `/select,` 会变成「打开它并选中它自己」，
    // 那不是用户要的；`path` 是个不存在的文件则是明确的错，不能悄悄退化成打开目录。
    const info = await stat(target).catch(() => null);
    if (info === null) {
      throw new HttpError(404, `文件不存在：${subPath}`);
    }

    fileToSelect = info.isFile() ? target : undefined;
  }

  const folderToOpen = fileToSelect === undefined ? target : dirname(fileToSelect);
  try {
    await ctx.openFolder(folderToOpen, fileToSelect);
  } catch (error) {
    throw new HttpError(500, error instanceof Error ? error.message : String(error));
  }

  ctx.log(
    "info",
    fileToSelect === undefined
      ? `已在文件管理器中打开目录: ${folderToOpen}`
      : `已在文件管理器中定位文件: ${fileToSelect}`,
  );
  sendJson(ctx.response, 200, { ok: true, path: folderToOpen });
}
