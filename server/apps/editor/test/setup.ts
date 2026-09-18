/**
 * 编辑器（jsdom）测试的公共环境准备。
 *
 * jsdom 里没有 `matchMedia`，而 store 在**模块求值时**就要用它判断「是不是紧凑布局」——
 * 不先补上，任何 import 了 store 的用例都会在收集阶段就炸掉。
 * 这里只实现测试真正用到的那部分（`matches`），按「精确指针 + 宽屏」返回（= 桌面布局）。
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

export {};
