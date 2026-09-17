import { useEffect, useState } from "react";

/** 订阅媒体查询（用于平板 / 触控优先布局判定）。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const list = window.matchMedia(query);
    const onChange = (): void => {
      setMatches(list.matches);
    };

    onChange();
    list.addEventListener("change", onChange);
    return () => {
      list.removeEventListener("change", onChange);
    };
  }, [query]);

  return matches;
}

/**
 * 是否使用「紧凑 / 平板」布局。
 *
 * 同时看宽度与指针类型：窄屏要紧凑，触控优先的设备即使屏幕够宽也不该依赖 hover 与右键。
 */
export function useCompactLayout(): boolean {
  const narrow = useMediaQuery("(max-width: 1023px)");
  const coarse = useMediaQuery("(pointer: coarse)");
  return narrow || coarse;
}
