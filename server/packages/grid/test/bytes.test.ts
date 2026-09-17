import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeGridBytes, encodeGridBytes, gridBytesLength } from "../src/bytes";
import type { GridData } from "../src/bytes";

const FIXTURE = fileURLToPath(new URL("./fixtures/Map001.bytes", import.meta.url));

function readFixture(): ArrayBuffer {
  const buffer = readFileSync(FIXTURE);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

describe(".bytes 编解码 —— 对照 Unity 真实产物 Map001.bytes", () => {
  it("解码真实文件得到 64x36 网格", () => {
    const data = decodeGridBytes(readFixture());
    expect(data.size).toEqual({ width: 64, height: 36 });
    expect(data.cells.length).toBe(64 * 36);
  });

  it("文件长度符合 8 + w*h*4 且为实测的 9224 字节", () => {
    expect(gridBytesLength({ width: 64, height: 36 })).toBe(9224);
    expect(readFixture().byteLength).toBe(9224);
  });

  it("解码后再编码与原始文件逐字节一致（golden round-trip）", () => {
    const original = new Uint8Array(readFixture());
    const reencoded = new Uint8Array(encodeGridBytes(decodeGridBytes(readFixture())));
    expect(reencoded).toEqual(original);
  });

  it("小端序与 Unity BinaryWriter 一致（头部字节可人工核对）", () => {
    const bytes = new Uint8Array(readFixture());
    // width = 64 = 0x40, height = 36 = 0x24，小端布局
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([64, 0, 0, 0]);
    expect([bytes[4], bytes[5], bytes[6], bytes[7]]).toEqual([36, 0, 0, 0]);
  });

  it("掩码全部落在已知位范围内", () => {
    const data = decodeGridBytes(readFixture());
    const invalid = [...data.cells].filter((mask) => (mask & ~0xff) !== 0);
    expect(invalid).toEqual([]);
  });
});

describe(".bytes 编解码 —— 合成数据与错误处理", () => {
  const size = { width: 4, height: 3 };

  it("合成数据往返一致", () => {
    const cells = new Uint8Array([0, 1, 2, 4, 8, 16, 32, 64, 128, 0, 3, 255]);
    const data: GridData = { size, cells };
    const decoded = decodeGridBytes(encodeGridBytes(data));
    expect(decoded.size).toEqual(size);
    expect([...decoded.cells]).toEqual([...cells]);
  });

  it("cells 长度与尺寸不符时抛错", () => {
    expect(() => encodeGridBytes({ size, cells: new Uint8Array(3) })).toThrow(/不匹配/);
  });

  it("长度不足时抛错（不静默截断）", () => {
    expect(() => decodeGridBytes(new ArrayBuffer(4))).toThrow(/小于头部/);

    // 头部合法但数据不足
    const short = new ArrayBuffer(12);
    const view = new DataView(short);
    view.setInt32(0, 4, true);
    view.setInt32(4, 3, true);
    expect(() => decodeGridBytes(short)).toThrow(/小于期望/);
  });

  it("尺寸非法时抛错", () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setInt32(0, 0, true);
    view.setInt32(4, 4, true);
    expect(() => decodeGridBytes(buffer)).toThrow(/尺寸非法/);
  });

  it("掩码越界时抛错", () => {
    const buffer = new ArrayBuffer(8 + 4);
    const view = new DataView(buffer);
    view.setInt32(0, 1, true);
    view.setInt32(4, 1, true);
    view.setInt32(8, 999, true);
    expect(() => decodeGridBytes(buffer)).toThrow(/掩码越界/);
  });
});
