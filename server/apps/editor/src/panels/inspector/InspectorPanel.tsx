import { useEffect, useRef, useState } from "react";
import { normalizeDegrees, objectImage, type SceneObjectDoc } from "@dts/document";
import { cellPixelSize } from "@dts/grid";
import type { ResourceTreeNode } from "../../services/project-api";
import { findResourceNode, useEditorStore } from "../../state/editor-store";
import { assetDisplayPath, findAssetById } from "../asset-picker";
import { assetKindLabel, assetPreviewKind, formatSize } from "../asset-info";
import { EmptyState } from "../EmptyState";
import { Field, FieldGroup, FieldRow } from "./fields";
import { FogFields } from "./FogFields";
import { GridAnnotationFields } from "./GridAnnotationFields";
import { SoundFields } from "./SoundFields";

/** 右侧属性面板：当前选中对象 / 场景 / **资源文件**的属性。编辑能力在 M2/M3 接入。 */
export function InspectorPanel(): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const selectedAssetId = useEditorStore((state) => state.selectedAssetId);
  const tree = useEditorStore((state) => state.project.tree);
  const projectOpen = useEditorStore((state) => state.project.current !== null);

  const activeScene = scenes.find((scene) => scene.name === activeSceneName);
  const selected =
    activeScene === undefined
      ? undefined
      : activeScene.objects.find((object) => object.id === selection[0]);
  // 选中的资源可能在刷新后没了，所以按 id 现查一次
  const asset =
    selectedAssetId === null
      ? undefined
      : findResourceNode(tree, (node) => node.id === selectedAssetId);

  return (
    <div className="flex h-full min-h-0 flex-col panel border-l">
      <div className="panel-header">
        <span>属性</span>
        <span className="text-[10px]">
          {asset !== undefined
            ? "资源"
            : selected !== undefined
              ? "对象"
              : activeScene !== undefined
                ? "场景"
                : projectOpen
                  ? "项目"
                  : "空"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 text-[12px]">
        {asset !== undefined ? (
          <AssetProperties key={asset.id} asset={asset} />
        ) : selected !== undefined ? (
          // 对象视图只列**人要用它做决定**的字段：内部标识（id）与组件数量不显示——
          // id 是一串机器 id、组件数现在恒为 0，两者都只会占地方。
          // `key` = 对象 id：**换对象时分组回到展开**（折叠状态是组件本地的，参考实现也在
          // 切换对象时重置，免得「上一个对象收起的分组」跟着跑到下一个对象身上）
          <div key={selected.id} data-testid="object-properties">
            <FieldGroup title="基础" group="basic">
              <NameField object={selected} />
              <Field label="类型" value={selected.kind} />
              <ActiveField object={selected} />
              <LockedField object={selected} />
              <SortingOrderField object={selected} />
              <PositionFields object={selected} />
              <ScaleField object={selected} />
              <RotationField object={selected} />
            </FieldGroup>

            {/*
              「渲染」= **这个对象画出来是什么样**：现在只有「贴图」一行（每个对象都能显示一张
              图片，精灵就是靠它显示图片的；地图的贴图也是同一个字段，只是存在 `map.image` 里）。
              暂时只支持**替换图片**，后面要加的「怎么画」（着色、混合、动画…）都往这一组里放，
              不再塞回「基础」——「对象是什么」与「对象画成什么样」是两件事。
              **声音对象没有这一组**：它画的是**固定的内置音频图标**，不给换贴图。
            */}
            {selected.kind === "PlaySound" ? null : (
              <FieldGroup title="渲染" group="render">
                <TextureField object={selected} />
              </FieldGroup>
            )}

            {/* 「声音」只对声音对象出现：音频列表 + 层级就是它自己那点东西（基础属性照旧） */}
            {selected.kind === "PlaySound" ? (
              <FieldGroup title="声音" group="sound">
                <SoundFields object={selected} />
              </FieldGroup>
            ) : null}

            {/*
              「区域」只对地图对象出现：格子是地图独有的东西。网格规格（列 · 行 / 每格 / 行序）
              也归这一组——「对象是什么」（名称 / 位置 / 缩放）与「它的格子长什么样」是两件事。
              slug 沿用 `edit`：它只是测试与调试用的标识，改的是给人看的标题。
            */}
            {selected.map !== undefined ? (
              <FieldGroup title="区域" group="edit">
                <GridFields object={selected} />
                <CellSizeField object={selected} />
                <Field label="行序" value={selected.map.rowOrder} mono />
                {/* 网格线 / 网格标注两个总开关：不进任何窗口也能用（想看清贴图就关掉） */}
                <GridDisplayField />
                <GridAnnotationFields object={selected} />
              </FieldGroup>
            ) : null}

            {/*
              「战争雾」也只对地图对象出现：8 个区域位是中性的，哪些算雾区要在这里手动指定，
              真正的编辑在 Mask 窗口里做。
            */}
            {selected.map !== undefined ? (
              <FieldGroup title="战争雾" group="fog">
                <FogFields object={selected} />
              </FieldGroup>
            ) : null}
          </div>
        ) : activeScene !== undefined ? (
          <FieldGroup title="场景" group="scene">
            <Field label="名称" value={activeScene.name} />
            <Field label="对象" value={String(activeScene.objects.length)} />
            <Field
              label="地图对象"
              value={
                activeScene.objects.some((object) => object.kind === "Map")
                  ? `${activeScene.objects.filter((object) => object.kind === "Map").length} 个`
                  : "无（对象不依赖地图，可直接添加）"
              }
            />
          </FieldGroup>
        ) : (
          // 属性**不跟场景绑定**：打开着项目就总有东西可看（没有场景时看项目自身的属性）
          projectOpen ? <ProjectProperties /> : <EmptyState />
        )}
      </div>
    </div>
  );
}

/** 对象名称：就地改名（Enter / 失焦提交，Esc 还原）。 */
function NameField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const renameObject = useEditorStore((state) => state.renameObject);
  const [draft, setDraft] = useState(object.name);

  // 选中的对象换了、或名字在别处被改（例如列表内联改名），输入框跟着走
  useEffect(() => {
    setDraft(object.name);
  }, [object.id, object.name]);

  const commit = (): void => {
    if (draft.trim() === object.name) {
      return;
    }

    if (!renameObject(object.id, draft)) {
      // 名字非法（空）：退回原值，不要留下一个会被拒绝的输入
      setDraft(object.name);
    }
  };

  return (
    <FieldRow label="名称">
      <input
        value={draft}
        data-testid="inspector-object-name"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(object.name);
          }
        }}
      />
    </FieldRow>
  );
}

/**
 * 是否显示（对齐 Unity 的激活勾选框）：不勾就**不画**，也不参与画布上的点选。
 *
 * 对象本身还在场景里、还在列表里，所以这不是「删除」——随时可以再勾回来。
 */
function ActiveField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setObjectActive = useEditorStore((state) => state.setObjectActive);

  return (
    <FieldRow label="激活">
      {/* 行名已经说明功能，勾选框右边不再写一遍说明（占地方又没人读） */}
      <input
        type="checkbox"
        checked={object.active}
        data-testid="inspector-object-active"
        aria-label="激活（显示）"
        title={object.active ? "显示在场景里" : "已隐藏（不画、也点不到）"}
        className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
        onChange={(event) => setObjectActive(object.id, event.target.checked)}
      />
    </FieldRow>
  );
}

/**
 * 是否**锁定**：锁上就**不能被移动**（画布上拖不动、世界坐标输入框也禁用）。
 *
 * 只锁「位置」这一件事：改名 / 显示顺序 / 缩放 / 激活 / 换贴图、以及地图的网格标注都照常改。
 * 摆场景时最容易被误拖的就是铺满视口的底图，所以这个开关虽然简单，但要和「激活」一样显眼。
 */
function LockedField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setObjectLocked = useEditorStore((state) => state.setObjectLocked);

  return (
    <FieldRow label="锁定">
      {/* 同上：说明收进 title，行里只留勾选框 */}
      <input
        type="checkbox"
        checked={object.locked}
        data-testid="inspector-object-locked"
        aria-label="锁定（不能移动）"
        title={object.locked ? "已锁定（拖不动、坐标也改不了）" : "未锁定（可以在画布上拖动）"}
        className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
        onChange={(event) => setObjectLocked(object.id, event.target.checked)}
      />
    </FieldRow>
  );
}

/**
 * 对象要显示的图片（**精灵**就靠它显示图片；地图的贴图也是这个字段，只是存在 `map.image` 里）：
 * 显示**项目内相对路径**（`images/Map001.png`），后面跟一个「选择」按钮。
 *
 * 这是**「渲染」分组目前唯一的一行**：现阶段渲染只做到「换一张图片」，后面加进来的
 * 渲染选项（着色、混合、动画…）都归到这一组。
 *
 * 按钮唤出的是「选择图片」弹框（对齐 Unity 的 Object Picker）——素材由外部提交到
 * `Assets/images/`，编辑器不导入，所以这里只负责从已有图片里挑。没有图片的对象
 * （刚建出来的精灵）只画一个标记点，这里给一行说明 + 同一个「选择」入口。
 */
function TextureField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const openImagePicker = useEditorStore((state) => state.openImagePicker);
  const image = objectImage(object);

  // 引用的文件不在项目里（素材没提交 / 改名了）：直接把这件事写出来
  const missing = image !== undefined && findAssetById(tree, image.id) === undefined;

  return (
    <FieldRow label="贴图">
      <span
        className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
          image === undefined ? "text-[var(--color-editor-text-dim)]" : ""
        }`}
        title={image?.id}
      >
        {image === undefined ? "（无贴图）" : assetDisplayPath(image.id)}
      </span>
      {missing ? (
        <span
          data-testid="texture-missing"
          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
          title="项目里找不到这个文件：素材要提交到 Assets/images/ 下，或在这里换一张"
        >
          找不到
        </span>
      ) : null}
      <button
        type="button"
        data-testid="pick-texture"
        className="toolbar-button flex-none hover:toolbar-button-hover"
        onClick={() => openImagePicker(object.id)}
      >
        选择
      </button>
    </FieldRow>
  );
}

/**
 * 显示顺序：**大的画在前面**（盖住小的）。
 *
 * 和坐标输入框一样是「各自提交、失焦/回车生效」，区别在于这里是**整数**且会**夹**到
 * 允许范围内——顺序只是个层号，敲出小数或超大值没有意义。连续输入合并成一条撤销记录。
 */
function SortingOrderField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setObjectSortingOrder = useEditorStore((state) => state.setObjectSortingOrder);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(object.sortingOrder));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== inputRef.current) {
      setDraft(String(object.sortingOrder));
    }
  }, [object.id, object.sortingOrder]);

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10);
    // 非法值（留空 / 敲了字母）退回当前值，不要把 NaN 写进文档
    const next = Number.isFinite(parsed) ? parsed : object.sortingOrder;
    setObjectSortingOrder(object.id, next);
    // 提交后回到 store 实际采用的值（会被取整 / 夹取），否则框里留着用户敲的原始文本
    setDraft(String(next));
  };

  return (
    <FieldRow label="显示顺序">
      <input
        ref={inputRef}
        value={draft}
        data-testid="inspector-object-sorting"
        aria-label="显示顺序"
        inputMode="numeric"
        type="number"
        step="1"
        title="大的画在前面（盖住小的）；相同则按场景对象列表里的先后"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </FieldRow>
  );
}

/**
 * 对象的**缩放**：`1` = 原始尺寸（每个对象都有，默认就是 1）。
 *
 * 与显示顺序同一套提交方式（各自提交、失焦 / 回车生效、连续输入合并成一条撤销记录），
 * 区别只有一点：允许小数（`0.5`、`1.5` 都是常用值），所以用 `parseFloat` 而不是 `parseInt`。
 * 输入非法（留空 / 敲了字母）就退回当前值，不把 NaN 写进文档；越界（0 / 负数 / 超大）
 * 交给文档命令夹到 `0.01 ~ 100`，框里回填**夹取后**的值。
 *
 * 缩放是**等比**的：地图的贴图与网格、精灵的图片、拾取范围、选中框一起缩放。
 */
function ScaleField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setObjectScale = useEditorStore((state) => state.setObjectScale);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(formatScale(object.scale));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== inputRef.current) {
      setDraft(formatScale(object.scale));
    }
  }, [object.id, object.scale]);

  const commit = (): void => {
    const parsed = Number.parseFloat(draft);
    // 非法值（留空 / 敲了字母）退回当前值，不要把 NaN 写进文档；
    // 0 / 负数 / 超大值照常交给命令，由它夹到 0.01 ~ 100
    const next = Number.isFinite(parsed) ? parsed : object.scale;
    setObjectScale(object.id, next);
    // 提交后回到**文档里实际采用的值**（会被夹取），否则框里留着用户敲的原始文本
    setDraft(formatScale(next));
  };

  return (
    <FieldRow label="缩放">
      <input
        ref={inputRef}
        value={draft}
        data-testid="inspector-object-scale"
        aria-label="缩放"
        inputMode="decimal"
        type="number"
        step="0.1"
        min="0"
        title="1 = 原始尺寸；等比缩放（贴图与地图网格一起缩放），范围 0.01 ~ 100"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(formatScale(object.scale));
          }
        }}
      />
    </FieldRow>
  );
}

/**
 * 缩放输入框里的文本：去掉浮点噪声（`0.30000000000000004` 这种）与无意义的小数零。
 */
function formatScale(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * 对象的**角度**（绕竖轴旋转，单位**度**）。
 *
 * 与缩放同一套提交方式（失焦 / 回车生效、连续输入合并成一条撤销记录、Esc 还原）。
 * 文档里存的是**弧度**（`SceneObjectDoc.rotation`），这里只做度 ↔ 弧度的换算，
 * 因为 Unity 的 Inspector 也是度数——两边对着看才不会算错。
 *
 * **符号与 Unity 一致**：这里填 `30`，Unity 里就是 `Quaternion.Euler(0, 30, 0)`。
 * 越界（超过半圈）先归一化到 `(-180, 180]`，框里回填归一化后的值。
 */
function RotationField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setObjectRotation = useEditorStore((state) => state.setObjectRotation);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(formatDegrees(object.rotation));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== inputRef.current) {
      setDraft(formatDegrees(object.rotation));
    }
  }, [object.id, object.rotation]);

  const commit = (): void => {
    const parsed = Number.parseFloat(draft);
    // 非法值（留空 / 敲了字母）退回当前值，不要把 NaN 写进文档
    const degrees = Number.isFinite(parsed) ? parsed : (object.rotation * 180) / Math.PI;
    setObjectRotation(object.id, (degrees * Math.PI) / 180);
    // 提交后回到**文档里实际采用的值**（会被归一化），否则框里留着用户敲的原始文本
    setDraft(String(normalizeDegrees(degrees)));
  };

  return (
    <FieldRow label="角度">
      <input
        ref={inputRef}
        value={draft}
        data-testid="inspector-object-rotation"
        aria-label="角度"
        inputMode="decimal"
        type="number"
        step="15"
        title="绕竖轴旋转，单位度，与 Unity 的 Transform 一致（正值 = Unity 里正的 Y 轴旋转）；超过半圈会归一化到 -180 ~ 180"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(formatDegrees(object.rotation));
          }
        }}
      />
    </FieldRow>
  );
}

/** 弧度 → 度数文本（去掉浮点噪声）。 */
function formatDegrees(rotationRadians: number): string {
  return String(Math.round(((rotationRadians * 180) / Math.PI) * 100) / 100);
}

/**
 * 对象位置：**世界坐标**（x 向右、y 向上，单位像素）。
 *
 * 两个轴各占一半宽度、带 X / Y 轴标（对齐 Unity 的 Transform：一眼看出哪个框是哪个轴）；
 * 输入框跟着面板宽度伸缩，不做固定宽度。
 *
 * 这是**精确**摆放的入口；粗略摆放直接拖画布上的标记点。
 *
 * 两条容易踩的坑，这里都避开了：
 * 1. **各自提交各自的字段**，另一个轴取对象当前值——不能用兄弟输入框的 state，
 *    否则「改完 x 再去改 y」时，x 的失焦提交会带上还没敲完的 y；
 * 2. **正在输入的框不被 store 回灌**，否则提交后触发的同步会把用户刚敲的值冲掉。
 *    留空或非法值按世界原点处理（手写文件里 `position: null` 的对象也能一键落位）。
 *
 * 还没有落点的对象（`position: null`）多一个「**落位**」按钮：那种对象在画布上不画、也点不到，
 * 没有这个按钮就只能靠「在坐标框里敲一个数」这种没人猜得到的办法把它找回来。
 *
 * **锁定的对象禁用这两个框**：锁上就是「不能被移动」，留一个还能改坐标的入口等于没锁
 * （store 的 `moveObject` 也会拒掉，那是第二道保险）。
 */
function PositionFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const moveObject = useEditorStore((state) => state.moveObject);
  const xRef = useRef<HTMLInputElement>(null);
  const yRef = useRef<HTMLInputElement>(null);
  const [x, setX] = useState(formatCoordinate(object.position?.x));
  const [y, setY] = useState(formatCoordinate(object.position?.y));

  useEffect(() => {
    if (document.activeElement !== xRef.current) {
      setX(formatCoordinate(object.position?.x));
    }

    if (document.activeElement !== yRef.current) {
      setY(formatCoordinate(object.position?.y));
    }
  }, [object.id, object.position]);

  const commitX = (): void => {
    const next = parseCoordinate(x);
    moveObject(object.id, { x: next, y: object.position?.y ?? WORLD_ORIGIN_FALLBACK });
    // 提交后输入框回到规范值：store 没产生变更时不会有回灌，
    // 不写回就会把用户敲的非法/留空值留在框里
    setX(formatCoordinate(next));
  };

  const commitY = (): void => {
    const next = parseCoordinate(y);
    moveObject(object.id, { x: object.position?.x ?? WORLD_ORIGIN_FALLBACK, y: next });
    setY(formatCoordinate(next));
  };

  return (
    <FieldRow label="世界坐标 (px)">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <NumberInput
          prefix="X"
          prefixClassName="text-[var(--color-editor-danger)]"
          label="世界坐标 X"
          value={x}
          testId="inspector-object-x"
          inputRef={xRef}
          onChange={setX}
          onCommit={commitX}
          placeholder={String(WORLD_ORIGIN_FALLBACK)}
          disabled={object.locked}
          title={object.locked ? "对象已锁定：先解锁才能改坐标" : undefined}
        />
        <NumberInput
          prefix="Y"
          prefixClassName="text-[var(--color-editor-ok)]"
          label="世界坐标 Y"
          value={y}
          testId="inspector-object-y"
          inputRef={yRef}
          onChange={setY}
          onCommit={commitY}
          placeholder={String(WORLD_ORIGIN_FALLBACK)}
          disabled={object.locked}
          title={object.locked ? "对象已锁定：先解锁才能改坐标" : undefined}
        />
        {/*
          未放置（`position: null`，只可能来自手写文件或旧版数据）的对象**既画不出来也点不到**，
          看起来就像「这个对象没了」。给一个明确的落位入口：一键放到世界原点，之后照常拖 / 缩放。
        */}
        {object.position === null ? (
          <button
            type="button"
            data-testid="place-object-at-origin"
            title="这个对象还没有落点（画布上不画、也点不到）：放到世界原点（画布正中）"
            className="flex-none rounded bg-[var(--color-editor-accent)] px-1.5 py-0.5 text-[10px] text-black hover:opacity-90"
            onClick={() =>
              moveObject(object.id, { x: WORLD_ORIGIN_FALLBACK, y: WORLD_ORIGIN_FALLBACK })
            }
          >
            落位
          </button>
        ) : null}
      </div>
    </FieldRow>
  );
}

interface NumberInputProps {
  /** 前缀（世界的 X / Y、网格的「列」「行」）：**看得见**，免得几个框分不清谁是谁。 */
  readonly prefix: string;
  /** 前缀配色；不传就用暗色。 */
  readonly prefixClassName?: string;
  /** 无障碍名字：前缀只有一个字，读屏听不出来。 */
  readonly label: string;
  readonly value: string;
  readonly testId: string;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly placeholder?: string;
  /** 锁定对象时禁用（禁用后仍显示当前值，只是改不了）。 */
  readonly disabled?: boolean;
  readonly title?: string;
}

/** 带前缀的数字输入：两三个这样的框在一行里**等分**整行剩下的宽度（好读也好改）。 */
function NumberInput({
  prefix,
  prefixClassName = "text-[var(--color-editor-text-dim)]",
  label,
  value,
  testId,
  inputRef,
  onChange,
  onCommit,
  placeholder,
  disabled = false,
  title,
}: NumberInputProps): React.JSX.Element {
  return (
    // 用 label 包住：点前缀也能聚焦到输入框；无障碍名字由 aria-label 给
    <label className="flex min-w-0 flex-1 items-center gap-1">
      <span aria-hidden="true" className={`flex-none font-mono text-[10px] ${prefixClassName}`}>
        {prefix}
      </span>
      <input
        ref={inputRef}
        value={value}
        data-testid={testId}
        aria-label={label}
        inputMode="decimal"
        type="number"
        step="1"
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none disabled:opacity-50"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/**
 * 地图网格的**列数 / 行数**：可编辑。
 *
 * 改尺寸会把格子按新规格重建（重叠部分原样保留，多出来的格子是空、被缩掉的丢弃）——
 * 格子数据是铺满整张网格的，尺寸与格数必须一致。
 */
function GridFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setMapGrid = useEditorStore((state) => state.setMapGrid);
  const columnsRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLInputElement>(null);
  const grid = object.map?.grid;
  const [columns, setColumns] = useState(formatCount(grid?.width));
  const [rows, setRows] = useState(formatCount(grid?.height));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== columnsRef.current) {
      setColumns(formatCount(grid?.width));
    }

    if (document.activeElement !== rowsRef.current) {
      setRows(formatCount(grid?.height));
    }
  }, [object.id, grid]);

  // 各自提交各自的字段：改列数时行数取当前值，反之亦然
  const commitColumns = (): void => {
    if (grid === undefined) {
      return;
    }

    const width = parseCount(columns, grid.width);
    setMapGrid(object.id, { width, height: grid.height });
    // 提交后输入框回到**规范值**：store 里没产生变更时不会有回灌，
    // 不写回就会把用户敲的非法值（例如 0）留在框里
    setColumns(String(width));
  };

  const commitRows = (): void => {
    if (grid === undefined) {
      return;
    }

    const height = parseCount(rows, grid.height);
    setMapGrid(object.id, { width: grid.width, height });
    setRows(String(height));
  };

  return (
    <FieldRow label="网格">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <NumberInput
          prefix="列"
          label="网格列数"
          value={columns}
          testId="inspector-grid-columns"
          inputRef={columnsRef}
          onChange={setColumns}
          onCommit={commitColumns}
        />
        <NumberInput
          prefix="行"
          label="网格行数"
          value={rows}
          testId="inspector-grid-rows"
          inputRef={rowsRef}
          onChange={setRows}
          onCommit={commitRows}
        />
      </div>
    </FieldRow>
  );
}

/**
 * 每格的世界尺寸：**算出来的**（贴图宽 ÷ 列数），所以只读。
 *
 * 文档里不存这个数（v6 起那个恒为 1 的 `cellSize` 已经删掉）——存一份只会和事实不一致。
 */
function CellSizeField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const image = object.map?.image;
  const grid = object.map?.grid;
  if (image === undefined || grid === undefined) {
    return <Field label="每格" value="—" />;
  }

  const cell = cellPixelSize(grid, image);
  return <Field label="每格" value={`${round2(cell.x)} × ${round2(cell.y)} px`} mono />;
}

/**
 * 画布上**网格线**与**网格标注**两个总开关。
 *
 * 它们是**显示开关**（纯看，不动数据）：想看清贴图时把网格线关掉、想只看美术时把标注关掉，
 * 关掉以后画笔照样能画、撤销栈与落盘都不受影响。
 *
 * 与「每类的显示开关」一样属于**编辑器偏好**（写浏览器本地，见 `services/grid-paint-prefs`），
 * 不是文档数据——所以它作用于画布上的**所有地图**（一个场景可以有多张），
 * 而不是「这张地图自己记着」。
 */
function GridDisplayField(): React.JSX.Element {
  const showGridLines = useEditorStore((state) => state.gridPaint.showGridLines);
  const showAnnotations = useEditorStore((state) => state.gridPaint.showAnnotations);
  const setGridLinesVisible = useEditorStore((state) => state.setGridLinesVisible);
  const setGridAnnotationsVisible = useEditorStore((state) => state.setGridAnnotationsVisible);

  return (
    <FieldRow label="显示">
      <div className="flex min-w-0 flex-1 items-center gap-3 text-[11px]">
        <label className="flex items-center gap-1.5" title="在画布上画网格线（所有地图；只影响显示）">
          <input
            type="checkbox"
            data-testid="grid-lines-toggle"
            checked={showGridLines}
            className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
            onChange={(event) => setGridLinesVisible(event.target.checked)}
          />
          <span>网格线</span>
        </label>
        <label
          className="flex items-center gap-1.5"
          title="在画布上给格子着色（所有地图；只影响显示，标出来的数据不会动）"
        >
          <input
            type="checkbox"
            data-testid="grid-annotations-toggle"
            checked={showAnnotations}
            className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
            onChange={(event) => setGridAnnotationsVisible(event.target.checked)}
          />
          <span>网格标注</span>
        </label>
      </div>
    </FieldRow>
  );
}

/** 网格列 / 行输入框里的文本。 */
function formatCount(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** 网格列 / 行输入：留空或非法（含 0 与负数）都退回原值——网格至少要有 1 格。 */
function parseCount(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 位置留空 / 非法时的落点：世界原点（= 场景正中）。 */
const WORLD_ORIGIN_FALLBACK = 0;

/** 位置输入框里的文本：没有位置时留空（提交时按世界原点处理）。 */
function formatCoordinate(value: number | undefined): string {
  return value === undefined ? "" : String(Math.round(value * 100) / 100);
}

/** 位置输入：留空或非法都按世界原点。 */
function parseCoordinate(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : WORLD_ORIGIN_FALLBACK;
}

/**
 * 选中资源文件时的属性视图。
 *
 * 图片 / 视频 / 音频额外给预览（图片还会读出真实像素尺寸——那是贴图最有用的属性）。
 * 预览直接用后端的原始字节接口，所以「提交到目录里的素材」能立刻看到，不需要先导入。
 */
function AssetProperties({ asset }: { readonly asset: ResourceTreeNode }): React.JSX.Element {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const preview = assetPreviewKind(asset.name);
  const src = `/api/resources/raw?id=${encodeURIComponent(asset.id)}`;

  return (
    <div data-testid="asset-properties">
      <FieldGroup title="资源" group="asset">
        <Field label="名称" value={asset.name} />
        <Field label="路径" value={asset.path} mono />
        <Field label="类型" value={assetKindLabel(asset.name)} />
        {asset.size === undefined ? null : (
          <Field label="大小" value={formatSize(asset.size)} mono />
        )}
        {imageSize === null ? null : (
          <Field label="尺寸" value={`${imageSize.width} × ${imageSize.height}`} mono />
        )}
      </FieldGroup>

      {preview === "image" ? (
        <img
          src={src}
          alt={asset.name}
          data-testid="asset-preview-image"
          className="max-h-64 w-full rounded border border-[var(--color-editor-border)] bg-black/20 object-contain"
          onLoad={(event) =>
            setImageSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
      ) : null}

      {preview === "video" ? (
        <video
          src={src}
          controls
          data-testid="asset-preview-video"
          className="w-full rounded border border-[var(--color-editor-border)]"
        />
      ) : null}

      {preview === "audio" ? (
        <audio src={src} controls data-testid="asset-preview-audio" className="w-full" />
      ) : null}
    </div>
  );
}

/** 资源树里的文件数（项目属性用）。 */
function countFiles(nodes: readonly ResourceTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      total += 1;
    } else {
      total += countFiles(node.children ?? []);
    }
  }

  return total;
}

/**
 * 没选任何东西时的项目属性。
 *
 * 属性面板**不跟场景绑定**：只要打开着项目就有内容可看，没有场景也不该是空白。
 */
function ProjectProperties(): React.JSX.Element {
  const doc = useEditorStore((state) => state.doc);
  const folder = useEditorStore((state) => state.project.current);
  const scenes = useEditorStore((state) => state.scenes);
  const tree = useEditorStore((state) => state.project.tree);

  return (
    <div data-testid="project-properties">
      <FieldGroup title="项目" group="project">
        <Field label="名称" value={doc.name} />
        <Field label="文件夹" value={folder ?? "—"} mono />
        <Field label="场景" value={`${scenes.length} 个`} />
        <Field label="资源文件" value={`${countFiles(tree)} 个`} />
      </FieldGroup>
    </div>
  );
}
