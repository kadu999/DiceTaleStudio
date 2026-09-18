import type { ResourceEntry } from "@dts/resources";

/**
 * 项目 HTTP 客户端。
 *
 * 编辑器不直接碰文件系统，所有资源访问都经后端 `/api/*`。
 */

export interface ProjectSummary {
  readonly name: string;
  readonly hasProject: boolean;
  readonly fileCount: number;
  readonly updatedAt?: string;
}

export interface ResourceTreeNode {
  readonly name: string;
  readonly path: string;
  readonly id: string;
  readonly type: "folder" | "file";
  readonly size?: number;
  readonly children?: ResourceTreeNode[];
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw new Error(`无法连接服务端：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    let reason = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string" && body.error.length > 0) {
        reason = body.error;
      }
    } catch {
      // 保持默认原因
    }

    throw new Error(reason);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const projectApi = {
  async list(): Promise<ProjectSummary[]> {
    const body = await request<{ projects: ProjectSummary[] }>("/api/projects");
    return body.projects;
  },

  async create(name: string): Promise<void> {
    await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  async remove(name: string): Promise<void> {
    await request(`/api/projects?name=${encodeURIComponent(name)}`, { method: "DELETE" });
  },

  async tree(name: string): Promise<ResourceTreeNode[]> {
    const body = await request<{ tree: ResourceTreeNode[] }>(
      `/api/projects/tree?name=${encodeURIComponent(name)}`,
    );
    return body.tree;
  },

  async createFolder(project: string, path: string): Promise<void> {
    await request("/api/projects/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, path }),
    });
  },

  /**
   * 在**运行服务端的那台机器**上用文件管理器打开项目目录，返回打开的真实路径。
   *
   * 浏览器不能替用户开文件夹，所以这件事只能后端做；从平板经局域网访问时，
   * 弹出来的是服务端那台电脑的窗口（不是平板上的文件 App）。
   */
  async reveal(name: string): Promise<string> {
    const body = await request<{ path: string }>("/api/projects/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return body.path;
  },

  async listResources(): Promise<ResourceEntry[]> {
    const body = await request<{ entries: ResourceEntry[] }>("/api/resources/index");
    return body.entries;
  },

  async readText(id: string): Promise<string> {
    const response = await fetch(`/api/resources/text?id=${encodeURIComponent(id)}`);
    if (!response.ok) {
      throw new Error(`读取资源失败：${response.status} ${response.statusText}`);
    }

    return response.text();
  },

  async writeText(id: string, text: string): Promise<void> {
    await request(`/api/resources/text?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: text,
    });
  },

  async uploadBinary(id: string, data: ArrayBuffer, contentType = "application/octet-stream"): Promise<void> {
    await request(`/api/resources/raw?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: data,
    });
  },

  async deleteResource(id: string): Promise<void> {
    await request(`/api/resources/raw?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /** 重命名资源（场景文件改名用）。服务端不覆盖已有文件，重名会报错。 */
  async renameResource(from: string, to: string): Promise<void> {
    await request("/api/resources/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  },
};

/** 依据扩展名给出上传用的 Content-Type。 */
export function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}
