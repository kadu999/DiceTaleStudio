import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer } from "./helpers/http-server";

/**
 * 静态托管：**缺了产物文件必须 404，绝不能回 index.html**。
 *
 * 这是踩过的坑：产物文件名带内容哈希，`pnpm build` 一次就换一批；**构建前打开着的页面**
 * 手里还攥着旧文件名，一刷新就来要它。以前那种「找不到就回 index.html（200 + text/html）」
 * 会让浏览器拿 HTML 当 ES 模块解析——页面直接白屏卡死（控制台报 MIME type / `Unexpected token '<'`）。
 */

describe("静态托管", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = await startTestServer();
    baseUrl = server.baseUrl;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  it("不存在的 /assets/x.js 返回 404，而不是 index.html（卡死那个坑）", async () => {
    const response = await fetch(`${baseUrl}/assets/index-不存在了.js`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    // 关键：绝不能是 HTML（浏览器会把 HTML 当模块解析，页面直接白屏）
    expect(await response.text()).not.toContain("<!doctype html>");
  });

  it("其它带扩展名的文件缺失也是 404（favicon / 图片 / css 同理）", async () => {
    for (const path of ["/favicon.ico", "/assets/missing.css", "/some.json"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toContain("application/json");
    }
  });

  it("不带扩展名的路径仍走 SPA 回退（200 + HTML，交给前端路由）", async () => {
    const response = await fetch(`${baseUrl}/某个未来的前端路由`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // `no-store`：回退出来的 HTML 不能被缓存成某个路由的响应
    expect(response.headers.get("cache-control")).toBe("no-store");
    // 编辑器没构建时，回退页给出可操作的提示（而不是空白）
    expect(await response.text()).toContain("<!doctype html>");
  });

  it("根路径照常给编辑器页面", async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("目录穿越仍然被挡住", async () => {
    const response = await fetch(`${baseUrl}/../../package.json`);

    expect([403, 404]).toContain(response.status);
  });

  it("畸形的百分号编码回 400，而不是 500", async () => {
    const response = await fetch(`${baseUrl}/%ZZ`);

    expect(response.status).toBe(400);
  });
});
