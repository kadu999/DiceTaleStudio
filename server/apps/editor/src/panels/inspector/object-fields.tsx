import { useEffect, useRef, useState } from "react";
import {
  effectiveScaleX,
  effectiveScaleY,
  isUniformScale,
  canRepairObjectComponent,
  componentForSlot,
  DEFAULT_SLOT_COMPONENT,
  mapDataOf,
  normalizeDegrees,
  objectImageSlot,
  objectImage,
  sortingOrderOf,
  SORTING_ORDER_LIMIT,
  spriteSheetOf,
  supportsSpriteSheet,
  type GameObjectDoc,
} from "@dts/document";
import { cellPixelSize } from "@dts/grid";
import { useEditorStore } from "../../state/editor-store";
import { assetDisplayPath, currentImageAssetId, findImageAsset } from "../asset-picker";
import { Field, FieldRow } from "./fields";

/**
 * 属性面板里**对象**部分的字段控件。
 *
 * 本文件从 `InspectorPanel.tsx` 拆出（纯搬运，行为不变）：面板本身只剩「选谁 + 按注册表渲染哪些分组」，
 * 每一行长什么样在这里。分组由 `registry.tsx` 组装。
 */

/** 对象名称：就地改名（Enter / 失焦提交，Esc 还原）。 */
export function NameField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
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
export function ActiveField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
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
export function LockedField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
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
 * 普通贴图显示项目内相对路径，后面跟一个「选择」按钮；精灵只显示当前子精灵状态。
 *
 * 这是**「渲染」分组目前唯一的一行**：现阶段渲染只做到「换一张图片」与「取图集里的哪一格」，
 * 后面加进来的渲染选项（着色、混合、动画…）都归到这一组。
 *
 * 按钮唤出的是「选择贴图」弹框（对齐 Unity 的 Object Picker）——素材由外部提交到
 * `Assets/images/`，编辑器不导入，所以这里只负责从已有图片里挑。没有图片的对象
 * （刚建出来的精灵）只画一个标记点，这里给一行说明 + 同一个「选择」入口。
 *
 * **子图（v20）**：图片是图集时显示「子图 第2行第3列（4×4）」。整图 / 子精灵在选择窗口中选择。
 * 只有**预设允许贴图槽位**的对象（`OBJECT_PRESETS` 里声明了 image 槽位，即精灵 / 玩家 / 道具 / 事件）才有这套 UI；
 * 地图的贴图在 `GridMap` 里、且不允许取子图（取一块会让已有格子标注错位）。
 */
export function TextureField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const openImagePicker = useEditorStore((state) => state.openImagePicker);
  const missingMapData = canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.map);
  const missingImageComponent = !missingMapData &&
    objectImageSlot(object) !== "map" &&
    canRepairObjectComponent(object, componentForSlot("image", object.kind));
  const missingComponent = missingMapData || missingImageComponent;
  const image = missingMapData ? undefined : objectImage(object);

  // 引用的文件不在项目里（素材没提交 / 改名了）：直接把这件事写出来
  const currentAsset = image === undefined ? undefined : findImageAsset(tree, image, assetMetas);
  const missing = image !== undefined && currentAsset === undefined;

  // 子图：能不能切由**图片用的是哪个组件**说了算（`supportsSpriteSheet`：精灵能、贴图不能、
  // 地图的贴图在 GridMap 里根本不在这一套里）。
  // 这里显示的是**文件里存的那一格**（不是夹取后的那一格）：越界时旁边挂一枚提示，
  // 「文件里写的」与「实际画的」都说清楚，人才知道要去重选一格
  const spriteCapable = supportsSpriteSheet(object);
  const cell = spriteCapable ? image?.sprite : undefined;
  const sheet = image === undefined ? undefined : spriteSheetOf(assetMetas, image);
  const outOfRange =
    cell !== undefined &&
    sheet !== undefined &&
    (cell.column >= sheet.columns || cell.row >= sheet.rows);

  return (
    <FieldRow label="贴图">
      {spriteCapable ? (
        image === undefined ? (
          <span className={`min-w-0 flex-1 text-[11px] ${missingImageComponent ? "text-[var(--color-editor-warn)]" : "text-[var(--color-editor-text-dim)]"}`}>
            {missingImageComponent ? "图片组件缺失" : "（无贴图）"}
          </span>
        ) : <span className="min-w-0 flex-1" />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
            image === undefined ? "text-[var(--color-editor-text-dim)]" : ""
          }`}
          title={currentAsset?.id ?? image?.id}
        >
          {missingComponent
            ? missingMapData ? "地图数据缺失" : "图片组件缺失"
            : image === undefined
              ? "（无贴图）"
              : assetDisplayPath(currentAsset?.id ?? currentImageAssetId(image, assetMetas))}
        </span>
      )}
      {cell === undefined || sheet === undefined ? null : (
        <span
          data-testid="texture-sprite"
          className="flex-none font-mono text-[10px] text-[var(--color-editor-accent)]"
          title="显示的是这张图集里的一个子图；改图集的切分会一起变（在「选择」窗口里切）"
        >
          子图 第{cell.row + 1}行第{cell.column + 1}列（{sheet.columns}×{sheet.rows}）
        </span>
      )}
      {outOfRange ? (
        <span
          data-testid="texture-sprite-out-of-range"
          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
          title="这张图的切分被改小了，这一格已经超出范围（按最后一格显示）；在「选择」窗口里重选一格"
        >
          格子越界
        </span>
      ) : null}
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
        {missingMapData ? "选择贴图并修复" : missingImageComponent ? "选择图片并添加" : "选择"}
      </button>
    </FieldRow>
  );
}

/**
 * **显示顺序**（渲染层属性，v26 起住在渲染组件里）：大的画在前面（盖住小的）。
 *
 * 从 `sortingOrderOf` 读（地图取 `GridMap` 的 data、其余取图片层的 data），经 store 的
 * `setRenderSortingOrder` 写回——那条命令按「先地图、后图片层」路由。这一行只出现在
 * 三个渲染组（网格地图 / 图片层 / 精灵层）里：**没有渲染层的对象没有这个参数**。
 *
 * 提交规则与缩放 / 角度同一套：失焦 / 回车生效、Esc 还原、连续输入合并成一条撤销记录。
 */
export function SortingOrderField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const setRenderSortingOrder = useEditorStore((state) => state.setRenderSortingOrder);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = sortingOrderOf(object);
  const [draft, setDraft] = useState(String(current));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== inputRef.current) {
      setDraft(String(current));
    }
  }, [object.id, current]);

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isFinite(parsed) ? parsed : current;
    setRenderSortingOrder(object.id, next);
    // 提交后回到**文档里实际采用的值**（会被取整 / 夹取），否则框里留着用户敲的原始文本
    setDraft(String(Math.min(SORTING_ORDER_LIMIT, Math.max(-SORTING_ORDER_LIMIT, Math.round(next)))));
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
        min={-SORTING_ORDER_LIMIT}
        max={SORTING_ORDER_LIMIT}
        title="大的画在前面（盖住小的）；相同则按场景对象列表里的先后"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(String(current));
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
 * **等比锁**（默认打开）：只有一个「缩放」框，改它 = 两轴一起改（写出去仍是等比 `scale`）。
 * 关掉它才露出 X / Y 两个框，各自独立——对应文档 v11 的单轴 `scaleX` / `scaleY`。
 * 两轴被改成相等时文档会自动折叠回等比（`collapseScale`），所以「拉平了」不会在文件里
 * 留下两个等价但多余的字段。
 *
 * 缩放是**等比 / 单轴都作用于同一块矩形**：地图的贴图与网格、精灵的图片、拾取范围、
 * 选中框一起缩放。
 */
export function ScaleField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const setObjectScale = useEditorStore((state) => state.setObjectScale);
  const setObjectScaleAxes = useEditorStore((state) => state.setObjectScaleAxes);
  // 两轴有效值（单轴字段缺省 = 用等比 `scale`，所以不能直接读 object.scale）
  const scaleX = effectiveScaleX(object);
  const scaleY = effectiveScaleY(object);

  // 等比锁是**局部界面状态**，不进文档也不持久化：它只决定「露出一个框还是两个框」。
  // 打开时两轴本就相等（否则数据是非等比），所以默认值取「当前是不是等比」更贴合直觉
  const [uniform, setUniform] = useState(() => isUniformScale(scaleX, scaleY));
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(formatScale(scaleX));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== inputRef.current) {
      setDraft(formatScale(scaleX));
    }
  }, [object.id, scaleX]);

  const commit = (): void => {
    const parsed = Number.parseFloat(draft);
    // 非法值（留空 / 敲了字母）退回当前值，不要把 NaN 写进文档；
    // 0 / 负数 / 超大值照常交给命令，由它夹到 0.01 ~ 100
    const next = Number.isFinite(parsed) ? parsed : scaleX;
    setObjectScale(object.id, next);
    // 提交后回到**文档里实际采用的值**（会被夹取），否则框里留着用户敲的原始文本
    setDraft(formatScale(next));
  };

  return (
    <>
      <FieldRow label="缩放">
        <button
          type="button"
          data-testid="inspector-object-scale-uniform"
          data-active={uniform}
          aria-pressed={uniform}
          title={
            uniform
              ? "等比锁：打开时只有一个缩放框，两轴一起改（点一下可拆成 X / Y 单轴）"
              : "等比锁：关掉后 X / Y 各改各的（点一下恢复等比）"
          }
          onClick={() => setUniform((value) => !value)}
          className={`flex-none rounded border px-1 text-[11px] ${
            uniform
              ? "border-[var(--color-editor-accent)] text-[var(--color-editor-accent)]"
              : "border-[var(--color-editor-border)] text-[var(--color-editor-text-dim)]"
          }`}
        >
          {uniform ? "锁" : "解"}
        </button>
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
              setDraft(formatScale(scaleX));
            }
          }}
        />
      </FieldRow>

      {uniform ? null : (
        <ScaleAxisField
          key={`${object.id}-x`}
          label="缩放 X"
          testId="inspector-object-scale-x"
          value={scaleX}
          onCommit={(next) => setObjectScaleAxes(object.id, next, scaleY)}
        />
      )}

      {uniform ? null : (
        <ScaleAxisField
          key={`${object.id}-y`}
          label="缩放 Y"
          testId="inspector-object-scale-y"
          value={scaleY}
          onCommit={(next) => setObjectScaleAxes(object.id, scaleX, next)}
        />
      )}
    </>
  );
}

/**
 * 一个**单轴**缩放输入框（等比锁关掉后才出现）。
 *
 * 与等比的「缩放」框同一套提交规则，只是把另一个轴原样带回去——
 * 两个轴一起提交，`setObjectScaleAxes` 才有机会把「两轴又相等了」折叠回等比。
 */
export function ScaleAxisField({
  label,
  testId,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: number;
  readonly onCommit: (next: number) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(formatScale(value));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（与等比框同一套理由）
    if (document.activeElement !== inputRef.current) {
      setDraft(formatScale(value));
    }
  }, [value]);

  const commit = (): void => {
    const parsed = Number.parseFloat(draft);
    const next = Number.isFinite(parsed) ? parsed : value;
    onCommit(next);
    setDraft(formatScale(next));
  };

  return (
    <FieldRow label={label}>
      <input
        ref={inputRef}
        value={draft}
        data-testid={testId}
        aria-label={label}
        inputMode="decimal"
        type="number"
        step="0.1"
        min="0"
        title="1 = 原始尺寸；只改这一个轴，范围 0.01 ~ 100"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(formatScale(value));
          }
        }}
      />
    </FieldRow>
  );
}

/**
 * 缩放输入框里的文本：去掉浮点噪声（`0.30000000000000004` 这种）与无意义的小数零。
 */
export function formatScale(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * 对象的**角度**（绕竖轴旋转，单位**度**）。
 *
 * 与缩放同一套提交方式（失焦 / 回车生效、连续输入合并成一条撤销记录、Esc 还原）。
 * 文档里存的是**弧度**（`GameObjectDoc.rotation`），这里只做度 ↔ 弧度的换算，
 * 因为 Unity 的 Inspector 也是度数——两边对着看才不会算错。
 *
 * **符号与 Unity 一致**：这里填 `30`，Unity 里就是 `Quaternion.Euler(0, 30, 0)`。
 * 越界（超过半圈）先归一化到 `(-180, 180]`，框里回填归一化后的值。
 */
export function RotationField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
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
export function formatDegrees(rotationRadians: number): string {
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
export function PositionFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
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

export interface NumberInputProps {
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
export function NumberInput({
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
export function GridFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const setMapGrid = useEditorStore((state) => state.setMapGrid);
  const columnsRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLInputElement>(null);
  const grid = mapDataOf(object)?.grid;
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
export function CellSizeField({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const image = mapDataOf(object)?.image;
  const grid = mapDataOf(object)?.grid;
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
export function GridDisplayField(): React.JSX.Element {
  const showGridLines = useEditorStore((state) => state.gridPaint.showGridLines);
  const showAnnotations = useEditorStore((state) => state.gridPaint.showAnnotations);
  const setGridLinesVisible = useEditorStore((state) => state.setGridLinesVisible);
  const setGridAnnotationsVisible = useEditorStore((state) => state.setGridAnnotationsVisible);

  return (
    <FieldRow label="显示">
      {/* 两个都是「名称在左、勾选框在右」：与激活 / 锁定 / 启用那些开关同一套写法 */}
      <div className="flex min-w-0 flex-1 items-center gap-3 text-[11px]">
        <label className="flex items-center gap-1.5" title="在画布上画网格线（所有地图；只影响显示）">
          <span>网格线</span>
          <input
            type="checkbox"
            data-testid="grid-lines-toggle"
            aria-label="网格线"
            checked={showGridLines}
            className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
            onChange={(event) => setGridLinesVisible(event.target.checked)}
          />
        </label>
        <label
          className="flex items-center gap-1.5"
          title="在画布上给格子着色（所有地图；只影响显示，标出来的数据不会动）"
        >
          <span>网格标注</span>
          <input
            type="checkbox"
            data-testid="grid-annotations-toggle"
            aria-label="网格标注"
            checked={showAnnotations}
            className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
            onChange={(event) => setGridAnnotationsVisible(event.target.checked)}
          />
        </label>
      </div>
    </FieldRow>
  );
}

/** 网格列 / 行输入框里的文本。 */
export function formatCount(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** 网格列 / 行输入：留空或非法（含 0 与负数）都退回原值——网格至少要有 1 格。 */
export function parseCount(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 位置留空 / 非法时的落点：世界原点（= 场景正中）。 */
export const WORLD_ORIGIN_FALLBACK = 0;

/** 位置输入框里的文本：没有位置时留空（提交时按世界原点处理）。 */
export function formatCoordinate(value: number | undefined): string {
  return value === undefined ? "" : String(Math.round(value * 100) / 100);
}

/** 位置输入：留空或非法都按世界原点。 */
export function parseCoordinate(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : WORLD_ORIGIN_FALLBACK;
}
