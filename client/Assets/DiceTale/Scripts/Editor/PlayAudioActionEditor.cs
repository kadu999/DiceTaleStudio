using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// <see cref="DiceTale.PlayAudioAction"/> 的自定义 Inspector：按播放目标（<c>_target</c>）
    /// 显示对应参数——<c>Dialogue</c> 显示 Clip / Loop；<c>BackgroundMusic</c> 显示 Clip / Layer
    /// （背景音乐恒循环，隐藏 Loop）。条件区复用
    /// <see cref="ConditionalBackendChangeActionEditor.DrawConditionFields"/>，基类其余字段兜底绘制。
    /// </summary>
    [CustomEditor(typeof(DiceTale.PlayAudioAction))]
    public class PlayAudioActionEditor : UnityEditor.Editor
    {
        private SerializedProperty target;
        private SerializedProperty clip;
        private SerializedProperty loop;
        private SerializedProperty layer;

        private void OnEnable()
        {
            target = serializedObject.FindProperty("_target");
            clip = serializedObject.FindProperty("clip");
            loop = serializedObject.FindProperty("loop");
            layer = serializedObject.FindProperty("_layer");
        }

        public override void OnInspectorGUI()
        {
            serializedObject.Update();

            DrawScriptField();
            ConditionalBackendChangeActionEditor.DrawConditionFields(serializedObject);

            EditorGUILayout.PropertyField(target, new GUIContent("Target", "Dialogue=对白通道；BackgroundMusic=背景音乐层"));

            switch ((DiceTale.PlayAudioAction.PlayTarget)target.intValue)
            {
                case DiceTale.PlayAudioAction.PlayTarget.BackgroundMusic:
                    EditorGUILayout.PropertyField(clip, new GUIContent("Clip"));
                    EditorGUILayout.PropertyField(layer, new GUIContent("Layer"));
                    EditorGUILayout.HelpBox("背景音乐恒循环、换曲顶替（同曲在播不重启）。", MessageType.Info);
                    break;

                default:
                    EditorGUILayout.PropertyField(clip, new GUIContent("Clip"));
                    EditorGUILayout.PropertyField(loop, new GUIContent("Loop"));
                    break;
            }

            // 其余字段（含基类的 triggerOnce 等）按默认布局
            DrawPropertiesExcluding(serializedObject, "m_Script", "condition", "_target", "clip", "loop", "_layer");

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
    }
}