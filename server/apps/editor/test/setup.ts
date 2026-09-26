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

/*
  jsdom 也没有 `Element.prototype.scrollIntoView`（布局是假的，无从滚动）。
  资源面板用它把左树滚到「当前所在的那一层」，缺了它组件会**真的抛错**——
  补一个空实现，让用例能跑到「列表内容对不对」这一层。
  为什么不在组件里加特性判断：那是为测试让步的运行时分支，浏览器里永远不会走到。
*/
if (typeof window !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => undefined;
}

/*
  jsdom 也没有 `ResizeObserver`（布局是假的，量不出尺寸）。
  Mask / 放大镜那几扇窗用 `useFittedBox` 把舞台按**实测**尺寸等比装起来——缺了它组件会
  **真的抛错**。补一个「什么都不观察」的实现：尺寸一直停在 0（舞台是 0×0），
  用例断言的是结构与记账，不看像素。
  为什么不在组件里加特性判断：那是为测试让步的运行时分支，与上面 `scrollIntoView` 同一条理由。
*/
if (typeof window !== "undefined" && typeof globalThis.ResizeObserver !== "function") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

export {};
