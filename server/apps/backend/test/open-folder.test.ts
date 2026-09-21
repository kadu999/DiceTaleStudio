import { describe, expect, it } from "vitest";
import { fileRevealCommand, folderOpenCommand } from "../src/open-folder";

/**
 * 「打开目录 / 定位文件」的平台命令映射。
 *
 * 只测这两个**纯函数**：真正的 `openFolder` / `revealFile` 会去 spawn 系统命令，
 * 在跑测试的机器上会弹出资源管理器窗口（HTTP 那一侧用注入的假实现覆盖）。
 */

describe("打开目录：平台 → 命令", () => {
  it("Windows 用 explorer.exe，目录作为单独一个参数", () => {
    expect(folderOpenCommand("win32", "C:\\资源\\我的项目")).toEqual({
      command: "explorer.exe",
      args: ["C:\\资源\\我的项目"],
    });
  });

  it("macOS 用 open，Linux 用 xdg-open", () => {
    expect(folderOpenCommand("darwin", "/Users/me/项目")?.command).toBe("open");
    expect(folderOpenCommand("linux", "/home/me/项目")?.command).toBe("xdg-open");
  });

  it("路径带空格 / & 时**原样**放进参数（不在 shell 里解析）", () => {
    const spec = folderOpenCommand("linux", "/tmp/a b & rm -rf /");
    expect(spec?.args).toEqual(["/tmp/a b & rm -rf /"]);
  });

  it("不认识的平台返回 undefined（由调用方给出可读错误）", () => {
    expect(folderOpenCommand("aix", "/tmp/x")).toBeUndefined();
  });
});

describe("定位文件：平台 → 命令", () => {
  it("Windows 用 explorer 的 `/select,`，且与路径在**同一个参数**里", () => {
    const spec = fileRevealCommand("win32", "C:\\资源\\我的项目\\Assets\\images\\Map 001.png");
    expect(spec).toEqual({
      command: "explorer.exe",
      // 逗号后没有空格：分开写 explorer 会把路径当成别的目标
      args: ["/select,C:\\资源\\我的项目\\Assets\\images\\Map 001.png"],
      reveal: true,
    });
  });

  it("macOS 用 open -R（R = reveal）", () => {
    expect(fileRevealCommand("darwin", "/Users/me/项目/Assets/a.png")).toEqual({
      command: "open",
      args: ["-R", "/Users/me/项目/Assets/a.png"],
      reveal: true,
    });
  });

  it("Linux 没有统一的「选中文件」，退回打开它所在的目录", () => {
    expect(fileRevealCommand("linux", "/home/me/项目/Assets/a.png")).toEqual({
      command: "xdg-open",
      args: ["/home/me/项目/Assets"],
      reveal: false,
    });
  });

  it("不认识的平台返回 undefined", () => {
    expect(fileRevealCommand("aix", "/tmp/x")).toBeUndefined();
  });
});
