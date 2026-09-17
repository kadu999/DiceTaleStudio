import type { ResourceEntry } from "@dts/resources";

/**
 * 跑团工程 HTTP 客户端。
 *
 * 编辑器不直接碰文件系统，所有资源访问都经后端 `/api/*`。
 */

export interface CampaignSummary {
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

export const campaignApi = {
  async list(): Promise<CampaignSummary[]> {
    const body = await request<{ campaigns: CampaignSummary[] }>("/api/campaigns");
    return body.campaigns;
  },

  async create(name: string): Promise<void> {
    await request("/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  async remove(name: string): Promise<void> {
    await request(`/api/campaigns?name=${encodeURIComponent(name)}`, { method: "DELETE" });
  },

  async tree(name: string): Promise<ResourceTreeNode[]> {
    const body = await request<{ tree: ResourceTreeNode[] }>(
      `/api/campaigns/tree?name=${encodeURIComponent(name)}`,
    );
    return body.tree;
  },

  async createFolder(campaign: string, path: string): Promise<void> {
    await request("/api/campaigns/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ campaign, path }),
    });
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
