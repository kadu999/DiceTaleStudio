import { describe, expect, it } from "vitest";
import { loadProviders } from "../src/image-gen/providers";
import { parseDataEntry } from "../src/image-gen/providers/types";

/**
 * 生图平台契约：**一个平台 = `providers/` 下的一个文件**，后端自动发现。
 *
 * 这里不联外部接口（那是 `image-gen-api.test.ts` 的事），只钉住
 * 「每个平台都实现了同一套接口」以及「加一个文件就多一个平台」这件事本身。
 */

describe("生图平台：自动发现与接口契约", () => {
  it("发现内置平台（volcengine / openai），每个都有完整的接口", async () => {
    const providers = await loadProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("volcengine");
    expect(ids).toContain("openai");

    for (const provider of providers) {
      expect(provider.id.length).toBeGreaterThan(0);
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.endpoint.startsWith("/")).toBe(true);
      // 地址与模型是部署参数，不该由平台文件提供（只从 app.json 来）
      expect("baseUrl" in provider.defaults).toBe(false);
      expect("model" in provider.defaults).toBe(false);
      expect(provider.defaults.sizes.length).toBeGreaterThan(0);
    }
  });

  it("尺寸形状按平台判：Seedream 认 `2K` 档位，OpenAI 不认", async () => {
    const providers = await loadProviders();
    const volc = providers.find((p) => p.id === "volcengine")!;
    const openai = providers.find((p) => p.id === "openai")!;

    for (const provider of providers) {
      expect(provider.acceptsSize("1024x1024")).toBe(true);
    }

    expect(volc.acceptsSize("2K")).toBe(true);
    expect(volc.acceptsSize("4K")).toBe(true);
    expect(openai.acceptsSize("2K")).toBe(false);
  });

  it("请求体带着平台自己的额外字段（火山关水印、直回 b64）", async () => {
    const providers = await loadProviders();
    const volc = providers.find((p) => p.id === "volcengine")!;

    expect(
      volc.buildRequest({
        prompt: "一把钥匙",
        size: "1024x1024",
        model: "doubao-seedream-4-0-250828",
        extraBody: volc.defaults.extraBody,
        images: [],
      }),
    ).toEqual({
      kind: "json",
      endpoint: "/images/generations",
      body: {
        model: "doubao-seedream-4-0-250828",
        prompt: "一把钥匙",
        size: "1024x1024",
        n: 1,
        response_format: "b64_json",
        watermark: false,
      },
    });
  });

  it("图生图：带输入图时，火山走 data-URI JSON，OpenAI 走 multipart `/images/edits`", async () => {
    const providers = await loadProviders();
    const volc = providers.find((p) => p.id === "volcengine")!;
    const openai = providers.find((p) => p.id === "openai")!;

    expect(volc.supportsEdit).toBe(true);
    expect(openai.supportsEdit).toBe(true);
    // 蒙版局部重绘是预留给「支持它」的平台：OpenAI 的 images/edits 认 mask，火山暂不声明
    expect(openai.supportsMask).toBe(true);
    expect(volc.supportsMask).toBe(false);

    const image = { data: Buffer.from([1, 2, 3]), mime: "image/png" };

    const volcRequest = volc.buildRequest({
      prompt: "把它改成蓝色",
      size: "1024x1024",
      model: "doubao-seedream-4-0-250828",
      extraBody: volc.defaults.extraBody,
      images: [image],
    });
    expect(volcRequest.kind).toBe("json");
    expect(volcRequest.endpoint).toBe("/images/generations");
    expect((volcRequest as { body: Record<string, unknown> }).body.image).toEqual([
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    ]);

    const openaiRequest = openai.buildRequest({
      prompt: "把它改成蓝色",
      size: "1024x1024",
      model: "gpt-image-1",
      extraBody: {},
      images: [image],
    });
    expect(openaiRequest.kind).toBe("multipart");
    expect(openaiRequest.endpoint).toBe("/images/edits");
    expect((openaiRequest as { files: readonly unknown[] }).files).toHaveLength(1);
  });

  it("多图参考 / 蒙版局部重绘：多张输入图都进去，OpenAI 的 mask 走 multipart 文件字段", async () => {
    const providers = await loadProviders();
    const volc = providers.find((p) => p.id === "volcengine")!;
    const openai = providers.find((p) => p.id === "openai")!;

    const a = { data: Buffer.from([1]), mime: "image/png" };
    const b = { data: Buffer.from([2]), mime: "image/png" };
    const mask = { data: Buffer.from([9]), mime: "image/png" };

    // 多图参考：火山的 `image` 是数组，两张都在
    const volcMany = volc.buildRequest({
      prompt: "参考这两张的风格",
      size: "1024x1024",
      model: "m",
      extraBody: {},
      images: [a, b],
    });
    expect((volcMany as unknown as { body: { image: string[] } }).body.image).toHaveLength(2);

    // 蒙版：OpenAI 把 mask 作为 multipart 的 `mask` 文件字段
    const openaiMask = openai.buildRequest({
      prompt: "只重画这块",
      size: "1024x1024",
      model: "m",
      extraBody: {},
      images: [a],
      mask,
    });
    expect(openaiMask.kind).toBe("multipart");
    const files = (openaiMask as { files: readonly { field: string }[] }).files;
    expect(files.map((f) => f.field)).toEqual(["image", "mask"]);
  });

  it("取图：`b64_json` 优先，其次 `url`；都没有则 undefined", () => {
    expect(parseDataEntry({ data: [{ b64_json: "AAA", url: "https://x/a.png" }] })).toEqual({
      base64: "AAA",
      url: "https://x/a.png",
    });
    expect(parseDataEntry({ data: [{ url: "https://x/a.png" }] })).toEqual({ url: "https://x/a.png" });
    expect(parseDataEntry({ data: [] })).toBeUndefined();
    expect(parseDataEntry({})).toBeUndefined();
  });
});
