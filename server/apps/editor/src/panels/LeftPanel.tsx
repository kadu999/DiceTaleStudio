import { useState } from "react";
import { AssetsPanel } from "./assets/AssetsPanel";
import { HierarchyPanel } from "./hierarchy/HierarchyPanel";
import { ScenesPanel } from "./scenes/ScenesPanel";

/**
 * 左栏：项目资源（Assets）+ 场景（Scenes）+ 对象容器（Hierarchy）三个页签。
 *
 * 对应 Unity 里 Project 与 Hierarchy 两个窗口；窄屏/平板下这一栏是抽屉，
 * 两个页签共用同一个抽屉，避免再挤出一列。
 */
export function LeftPanel(): React.JSX.Element {
  const [tab, setTab] = useState<"assets" | "scenes" | "hierarchy">("assets");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-1 py-0.5">
        <TabButton
          active={tab === "assets"}
          testId="tab-assets"
          onClick={() => setTab("assets")}
        >
          项目资源
        </TabButton>
        <TabButton
          active={tab === "scenes"}
          testId="tab-scenes"
          onClick={() => setTab("scenes")}
        >
          场景
        </TabButton>
        <TabButton
          active={tab === "hierarchy"}
          testId="tab-hierarchy"
          onClick={() => setTab("hierarchy")}
        >
          对象容器
        </TabButton>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "assets" ? <AssetsPanel /> : null}
        {tab === "scenes" ? <ScenesPanel /> : null}
        {tab === "hierarchy" ? <HierarchyPanel /> : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  testId,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly testId: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] ${
        active
          ? "bg-[var(--color-editor-panel)] text-[var(--color-editor-text)]"
          : "text-[var(--color-editor-text-dim)] hover:bg-[var(--color-editor-panel)]"
      }`}
    >
      {children}
    </button>
  );
}
