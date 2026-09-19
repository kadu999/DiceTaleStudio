using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// <see cref="DiceTale.PlayVideoAction"/> 的自定义 Inspector：按所选命令（<c>_command</c>）
    /// 显示相关参数——<c>Play</c> 时显示 Clip Index / Loop / Speed；<c>Pause / Resume / Stop</c>
    /// 不涉及片源参数，隐藏这三项并给一行提示。目标播放器（Video Player / Video Players）
    /// 与条件区（复用 <see cref="ConditionalBackendChangeActionEditor.DrawConditionFields"/>）
    /// 在所有命令下都显示；基类其余字段（如 triggerOnce）按默认布局兜底绘制。
    /// </summary>
    [CustomEditor(typeof(DiceTale.PlayVideoAction))]
    public class PlayVideoActionEditor : UnityEditor.Editor
    {
        private SerializedProperty command;
        private SerializedProperty videoPlayer;
        private SerializedProperty videoPlayers;
        private SerializedProperty index;
        private SerializedProperty isLooping;
        private SerializedProperty speed;

        private void OnEnable()
        {
            command = serializedObject.FindProperty("_command");
            videoPlayer = serializedObject.FindProperty("_videoPlayer");
            videoPlayers = serializedObject.FindProperty("_videoPlayers");
            index = serializedObject.FindProperty("_index");
            isLooping = serializedObject.FindProperty("_isLooping");
            speed = serializedObject.FindProperty("_speed");
        }

        public override void OnInspectorGUI()
        {
            serializedObject.Update();

            DrawScriptField();
            ConditionalBackendChangeActionEditor.DrawConditionFields(serializedObject);

            EditorGUILayout.PropertyField(videoPlayer, new GUIContent("Video Player"));
            EditorGUILayout.PropertyField(videoPlayers, new GUIContent("Video Players"));

            var kind = (DiceTale.PlayVideoAction.VideoCommand)command.intValue;
            EditorGUILayout.PropertyField(command, new GUIContent("Command", kind.ToString()));

            // 仅 Play 使用片源参数；Pause / Resume / Stop 不适用则隐藏
            if (command.intValue == (int)DiceTale.PlayVideoAction.VideoCommand.Play)
            {
                EditorGUILayout.PropertyField(index, new GUIContent("Clip Index"));
                EditorGUILayout.PropertyField(isLooping, new GUIContent("Loop"));
                EditorGUILayout.PropertyField(speed, new GUIContent("Speed"));
            }
            else
            {
                EditorGUILayout.HelpBox(
                    "Pause / Resume / Stop 不涉及片源参数（Clip Index / Loop / Speed 仅 Play 使用）。",
                    MessageType.Info);
            }

            // 其余字段（含基类的 triggerOnce 等）按默认布局
            DrawPropertiesExcluding(
                serializedObject,
                "m_Script",
                "condition",
                "_command",
                "_videoPlayer",
                "_videoPlayers",
                "_index",
                "_isLooping",
                "_speed");

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