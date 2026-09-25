import { type FieldDef, type GameObjectDoc } from "@dts/document";
import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 组件规格 / 对象字段规格的**描述符行**渲染器。
 *
 * 一行代码回答两个问题：这一行长什么样（按 `kind` 选控件），以及改动怎么写回去
 * （统一走 store 的泛型入口 `setComponentField` / `setObjectField`）。于是「加一个简单字段」
 * 在编辑器这一侧**不需要碰任何文件**——规格里加一行，它自己就出现在面板上。
 *
 * 两种字段落点共用这一个渲染器（见 `FieldTarget`）：组件的 `data`、对象自身。
 *
 * 三条与既有手写控件**逐字一致**的约定（它们是面板的可读性底线，不是风格偏好）：
 * - 行外壳一律用 `fields.tsx` 的 `FieldRow`：标签定宽 `w-20` 且必须是行内第一个子元素
 *   （e2e 的几何用例按 `xpath=../../../span[1]` 取它）；
 * - `data-testid` 从描述符来，**不在渲染时拼字符串**——既有 testid 是测试契约，拼出来就等于
 *   把一次重构变成「改一堆断言」；
 * - 「正在输入的框不被 store 回灌」「非法值退回原值」「Esc 还原」，与 `object-fields.tsx` 同一套。
 */

/** 一行（描述符行与组件自己的自定义行共用）：`order` 决定它排在哪。 */
export interface InspectorRow {
  readonly order: number;
  readonly node: React.ReactNode;
}

/**
 * **字段的读写落点**：描述符只说「这一行长什么样」，改哪份数据由它回答。
 *
 * 两个实现：组件字段（`componentFields(type)`，读写 `object.components[]` 里那份 `data`）
 * 与对象自身字段（`objectFields`，读写 `object` 自己）。同一套行渲染器服务两种规格，
 * 于是给「基础」那一组加一个普通标量字段也不必再手写控件。
 */
export interface FieldTarget {
  /** 面板上显示的值（组件没补出来 / 文件缺这一项时落到描述符的默认值）。 */
  read(object: GameObjectDoc, field: FieldDef): unknown;
  /** 写回（经 store 的泛型入口，因此照样进撤销栈、照样自动落盘）。 */
  write(object: GameObjectDoc, field: FieldDef, value: unknown): void;
}

/**
 * 组件字段的落点。
 *
 * 读写在渲染器里只做「找组件、取那一个键」；真正的写入一律经 store 的 `setComponentField`
 * ——撤销、日志、落盘时机全在 store 那条路上，行控件不直接碰文档。
 */
export function componentFields(type: string): FieldTarget {
  return {
    read: (object, field) => {
      const data = object.components.find((component) => component.type === type)?.data as
        | Record<string, unknown>
        | undefined;
      const raw = data?.[field.key];
      return raw === undefined ? field.default : raw;
    },
    write: (object, field, value) => {
      useEditorStore.getState().setComponentField(object.id, type, field.key, value);
    },
  };
}

/**
 * 对象自身字段的落点（「基础」那一组里归规格管的那些，v26 起规格为空）。
 *
 * 读的是 `object` 自己的键；缺项时同样落到描述符的默认值。保留这条通道给**下一个**
 * 无专属语义的对象标量字段（显示顺序已搬进渲染组件，走 `SortingOrderField`）。
 */
export const objectFields: FieldTarget = {
  read: (object, field) => {
    const raw = (object as unknown as Record<string, unknown>)[field.key];
    return raw === undefined ? field.default : raw;
  },
  write: (object, field, value) => {
    useEditorStore.getState().setObjectField(object.id, field.key, value);
  },
};

/**
 * 由描述符**自动**出行的控件种类。
 *
 * 只列「无条件、无副作用、控件形状确定」的标量：列表选择、资源引用、颜色这些各有自己的
 * 交互与副作用（同步 `names`、查资源索引、弹选择框），继续由各自的组件手写——
 * 泛型写入那一侧也在 `coerceFieldValue` 里明确拒掉它们，两边口径一致。
 */
const AUTO_KINDS: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string", "text", "enum"]);

/** 某个规格里，能自动出行的那些字段对应的行。 */
export function descriptorRows(
  object: GameObjectDoc,
  spec: { readonly fields: readonly FieldDef[] },
  target: FieldTarget,
): InspectorRow[] {
  return spec.fields
    .filter((field) => AUTO_KINDS.has(field.kind))
    .map((field) => ({
      order: field.order ?? 0,
      node: <DescriptorRow key={field.key} object={object} target={target} field={field} />,
    }));
}

/** 描述符行与自定义行按 `order` 合并（描述符没写 `order` 的按 0 排在最前面）。 */
export function sortInspectorRows(rows: readonly InspectorRow[]): InspectorRow[] {
  return [...rows].sort((a, b) => a.order - b.order);
}

/** 一行描述符：按 `kind` 分派到具体控件。 */
function DescriptorRow({
  object,
  target,
  field,
}: {
  readonly object: GameObjectDoc;
  readonly target: FieldTarget;
  readonly field: FieldDef;
}): React.JSX.Element {
  switch (field.kind) {
    case "boolean":
      return <BooleanRow object={object} target={target} field={field} />;
    case "enum":
      return <EnumRow object={object} target={target} field={field} />;
    case "integer":
    case "number":
      return <NumberRow object={object} target={target} field={field} />;
    default:
      return <TextRow object={object} target={target} field={field} />;
  }
}

function BooleanRow({
  object,
  target,
  field,
}: {
  readonly object: GameObjectDoc;
  readonly target: FieldTarget;
  readonly field: FieldDef;
}): React.JSX.Element {
  return (
    <FieldRow label={field.label}>
      {/* 行名已经说明功能，勾选框右边不再写一遍说明（与「基础」组的激活 / 锁定同一套） */}
      <input
        type="checkbox"
        data-testid={field.testId}
        aria-label={field.label}
        checked={target.read(object, field) === true}
        title={field.tooltip}
        className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
        onChange={(event) => target.write(object, field, event.target.checked)}
      />
    </FieldRow>
  );
}

function EnumRow({
  object,
  target,
  field,
}: {
  readonly object: GameObjectDoc;
  readonly target: FieldTarget;
  readonly field: FieldDef;
}): React.JSX.Element {
  const value = target.read(object, field);

  return (
    <FieldRow label={field.label}>
      <select
        data-testid={field.testId}
        aria-label={field.label}
        value={typeof value === "string" ? value : ""}
        title={field.tooltip}
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px]"
        onChange={(event) => target.write(object, field, event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/**
 * 数字行（`number` / `integer`）。
 *
 * 与既有的手写数字框同一套提交规则：各自提交、失焦 / 回车生效、Esc 还原、
 * 连续输入合并成一条撤销记录（`coalesce` 由规格声明）。
 * 非法值（留空 / 敲了字母）退回当前值，不把 `NaN` 写进文档；越界由文档命令按 `min` / `max` 夹取。
 */
function NumberRow({
  object,
  target,
  field,
}: {
  readonly object: GameObjectDoc;
  readonly target: FieldTarget;
  readonly field: FieldDef;
}): React.JSX.Element {
  const value = target.read(object, field);
  const current = typeof value === "number" ? value : 0;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(formatNumber(current));

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后触发的同步会把刚敲的值冲掉）
    if (document.activeElement !== inputRef.current) {
      setDraft(formatNumber(current));
    }
  }, [object.id, current]);

  const commit = (): void => {
    // `integer` 用 `parseInt`、`number` 用 `parseFloat`：与这两类字段过去那些手写控件逐字一致
    // （原来的「显示顺序」框就是 `parseInt`）。注意文档命令自己还会 `Math.round` + 夹取，
    // 所以这里**不做**取整——两处各取一次整会让「敲 12.6 得到 12 还是 13」取决于谁先动手。
    const parsed = field.kind === "integer" ? Number.parseInt(draft, 10) : Number.parseFloat(draft);
    const next = Number.isFinite(parsed) ? parsed : current;
    target.write(object, field, next);
    // 提交后回到文档里实际采用的值（会被取整 / 夹取），否则框里留着用户敲的原始文本
    setDraft(formatNumber(next));
  };

  return (
    <FieldRow label={field.label}>
      <input
        ref={inputRef}
        value={draft}
        data-testid={field.testId}
        aria-label={field.label}
        // 整数用 numeric（与原来那条手写的「显示顺序」框一致）、小数用 decimal
        inputMode={field.kind === "integer" ? "numeric" : "decimal"}
        type="number"
        step={field.step ?? 1}
        min={field.min}
        max={field.max}
        title={field.tooltip}
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(formatNumber(current));
          }
        }}
      />
    </FieldRow>
  );
}

/** 文本行（`string` 单行 / `text` 多行）：与数字行同一套提交规则。 */
function TextRow({
  object,
  target,
  field,
}: {
  readonly object: GameObjectDoc;
  readonly target: FieldTarget;
  readonly field: FieldDef;
}): React.JSX.Element {
  const value = target.read(object, field);
  const current = typeof value === "string" ? value : "";
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(current);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(current);
    }
  }, [object.id, current]);

  const commit = (): void => {
    target.write(object, field, draft);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      setDraft(current);
      return;
    }

    // 多行框里的回车是换行，只有单行框才把回车当提交
    if (event.key === "Enter" && field.kind !== "text") {
      commit();
      event.currentTarget.blur();
    }
  };

  const shared = {
    ref: inputRef,
    value: draft,
    "data-testid": field.testId,
    "aria-label": field.label,
    title: field.tooltip,
    className:
      "min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none",
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown,
  };

  return (
    <FieldRow label={field.label}>
      {field.kind === "text" ? <textarea {...shared} rows={2} /> : <input {...shared} />}
    </FieldRow>
  );
}

/** 数字输入框里的文本：非法 / 缺省时留空。 */
function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}
