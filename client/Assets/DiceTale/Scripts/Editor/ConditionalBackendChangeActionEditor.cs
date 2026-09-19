using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// Custom inspector for condition-based backend actions: the condition area only shows
    /// the target field matching the selected <c>valueType</c> and the legal operators;
    /// all other fields (including subclass fields) are drawn with the default layout.
    /// CustomEditor uses inherit=true, so ShowHideAction / TeleportAction / TeleportZoneAction
    /// and any future conditional action share this editor — a single condition-editing entry.
    /// The condition area is also exposed as a static helper
    /// (<see cref="DrawConditionFields(SerializedObject)"/>) so subclass-specific editors
    /// (e.g. PlayVideoActionEditor, which arranges fields by command) can reuse it.
    /// </summary>
    [CustomEditor(typeof(DiceTale.ConditionalBackendChangeAction), true)]
    public class ConditionalBackendChangeActionEditor : UnityEditor.Editor
    {
        private static readonly string[] ValueTypeLabels = { "Bool", "String", "Number", "Integer" };

        private static readonly string[] OpLabels =
            { "Equal", "Not Equal", "Greater Or Equal", "Less Or Equal" };

        public override void OnInspectorGUI()
        {
            serializedObject.Update();

            DrawScriptField(); // script field at the top, like the default inspector
            DrawConditionFields(serializedObject);

            // Default drawing for the remaining fields (including subclass fields);
            // the script field and condition area are drawn above, so both are excluded.
            DrawPropertiesExcluding(serializedObject, "condition", "m_Script");

            serializedObject.ApplyModifiedProperties();
        }

        /// <summary>Read-only script field at the top (same as the default inspector).</summary>
        private void DrawScriptField()
        {
            var script = serializedObject.FindProperty("m_Script");
            if (script == null)
            {
                return;
            }

            EditorGUI.BeginDisabledGroup(true);
            EditorGUILayout.PropertyField(script);
            EditorGUI.EndDisabledGroup();
        }

        /// <summary>
        /// 条件区绘制（静态，供子类自定义 Editor 复用）：只显示与所选 valueType 匹配的
        /// 目标字段和合法运算符。
        /// </summary>
        internal static void DrawConditionFields(SerializedObject serializedObject)
        {
            var condition = serializedObject.FindProperty("condition");
            if (condition == null)
            {
                return;
            }

            EditorGUILayout.LabelField("Trigger Condition (empty = always)", EditorStyles.boldLabel);

            var valueType = condition.FindPropertyRelative("valueType");
            var op = condition.FindPropertyRelative("op");
            var targetBool = condition.FindPropertyRelative("targetBool");
            var targetString = condition.FindPropertyRelative("targetString");
            var targetNumber = condition.FindPropertyRelative("targetNumber");
            var targetInteger = condition.FindPropertyRelative("targetInteger");

            var kind = DrawValueTypeField(valueType);
            DrawOpField(op, kind);

            // Show only the target field matching the selected value type
            switch (kind)
            {
                case BackendValueKind.Bool:
                    EditorGUILayout.PropertyField(targetBool, new GUIContent("Target Bool"));
                    break;

                case BackendValueKind.String:
                    EditorGUILayout.PropertyField(targetString, new GUIContent("Target Option Name"));
                    break;

                case BackendValueKind.Number:
                    EditorGUILayout.PropertyField(targetNumber, new GUIContent("Target Number"));
                    break;

                case BackendValueKind.Integer:
                    EditorGUILayout.PropertyField(targetInteger, new GUIContent("Target Integer"));
                    break;
            }
        }

        private static BackendValueKind DrawValueTypeField(SerializedProperty valueType)
        {
            valueType.intValue = EditorGUILayout.Popup("Value Type", valueType.intValue, ValueTypeLabels);
            return (BackendValueKind)valueType.intValue;
        }

        /// <summary>Operator popup: Bool/String only show Equal/NotEqual; Number shows all.</summary>
        private static void DrawOpField(SerializedProperty op, BackendValueKind kind)
        {
            var maxIndex = (kind == BackendValueKind.Number || kind == BackendValueKind.Integer)
                ? (int)DiceTale.ComponentCondition.Op.AtMost
                : (int)DiceTale.ComponentCondition.Op.NotEqual;

            if (op.intValue > maxIndex)
            {
                op.intValue = maxIndex; // fix invalid operator after switching value type
            }

            var labels = new string[maxIndex + 1];
            var values = new int[maxIndex + 1];
            for (int i = 0; i <= maxIndex; i++)
            {
                labels[i] = OpLabels[i];
                values[i] = i;
            }

            op.intValue = EditorGUILayout.IntPopup("Operator", op.intValue, labels, values);
        }
    }
}