using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    public class GridMapEditorRenderer
    {
        public void DrawToolbar(GridMapEditorState state, out bool shouldLoadTexture, out bool shouldSave, out bool shouldLoad)
        {
            shouldLoadTexture = false;
            shouldSave = false;
            shouldLoad = false;

            var hasMapName = !string.IsNullOrEmpty(state.MapName);

            GUILayout.Label("工具", EditorStyles.boldLabel);
            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("加载图片"))
            {
                shouldLoadTexture = true;
            }

            EditorGUI.BeginDisabledGroup(!hasMapName);
            if (GUILayout.Button("Save"))
            {
                shouldSave = true;
            }

            if (GUILayout.Button("Load"))
            {
                shouldLoad = true;
            }
            EditorGUI.EndDisabledGroup();

            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();

            GUILayout.Label("属性", EditorStyles.boldLabel);
            state.GridSize = EditorGUILayout.Vector2IntField("网格大小", state.GridSize);
            state.BrushSize = EditorGUILayout.IntSlider("画笔大小", state.BrushSize, GridMapEditorConstants.MinBrushSize, GridMapEditorConstants.MaxBrushSize);

            EditorGUILayout.Space();
            DrawTypeList(state);
        }

        public void DrawTypeList(GridMapEditorState state)
        {
            GUILayout.Label("画笔类型", EditorStyles.boldLabel);
            GUILayout.Label("点击行选择画笔", EditorStyles.miniLabel);

            DrawEraserRow(state);

            foreach (var type in GridMapEditorState.PaintableTypes)
            {
                var selected = !state.EraseMode && type == state.SelectedType;
                var rowRect = EditorGUILayout.BeginHorizontal();
                if (selected)
                {
                    EditorGUI.DrawRect(rowRect, new Color(0.2f, 0.45f, 1f, 0.5f));
                }

                var visible = EditorGUILayout.Toggle(state.IsTypeVisible(type), GUILayout.Width(18f));
                state.SetTypeVisible(type, visible);

                var label = $"{type} ({(int)type})";
                var previousContentColor = GUI.contentColor;
                if (!visible)
                {
                    GUI.contentColor = new Color(0.55f, 0.55f, 0.55f, 1f);
                }

                var style = selected ? EditorStyles.boldLabel : EditorStyles.label;
                if (GUILayout.Button(label, style, GUILayout.ExpandWidth(true)))
                {
                    state.SelectedType = type;
                    state.EraseMode = false;
                }
                EditorGUIUtility.AddCursorRect(GUILayoutUtility.GetLastRect(), MouseCursor.Link);

                GUI.contentColor = previousContentColor;

                EditorGUI.BeginChangeCheck();
                var color = EditorGUILayout.ColorField(GUIContent.none, state.GetTypeColor(type), false, false, false, GUILayout.Width(56f));
                if (EditorGUI.EndChangeCheck())
                {
                    state.SetTypeColor(type, color);
                }

                EditorGUILayout.EndHorizontal();
            }
        }

        private void DrawEraserRow(GridMapEditorState state)
        {
            var erasing = state.EraseMode;
            var rowRect = EditorGUILayout.BeginHorizontal();
            if (erasing)
            {
                EditorGUI.DrawRect(rowRect, new Color(0.2f, 0.45f, 1f, 0.5f));
            }

            GUILayout.Space(18f); // 与类型行的显示开关列对齐

            if (GUILayout.Button("橡皮擦 (0)", erasing ? EditorStyles.boldLabel : EditorStyles.label, GUILayout.ExpandWidth(true)))
            {
                state.EraseMode = true;
            }
            EditorGUIUtility.AddCursorRect(GUILayoutUtility.GetLastRect(), MouseCursor.Link);

            // 灰色不可编辑色块，与类型行的颜色列对齐
            var swatchRect = GUILayoutUtility.GetRect(56f, 16f);
            EditorGUI.DrawRect(swatchRect, new Color(0.6f, 0.6f, 0.6f, 1f));

            EditorGUILayout.EndHorizontal();
        }

        public void DrawInfo(GridMapEditorState state)
        {
            EditorGUILayout.LabelField($"Map: {(string.IsNullOrEmpty(state.MapName) ? "-" : state.MapName)}");
            EditorGUILayout.LabelField($"Grid Size: {state.GridSize.x} x {state.GridSize.y}");
            EditorGUILayout.Space();
        }

        public void DrawGrid(GridMapEditorState state, Rect gridRect)
        {
            DrawBackground(gridRect, state);
            DrawCells(gridRect, state);
            DrawGridLines(gridRect, state);
        }

        private void DrawBackground(Rect gridRect, GridMapEditorState state)
        {
            if (state.ReferenceTexture != null)
            {
                var aspect = (float)state.ReferenceTexture.height / state.ReferenceTexture.width;
                var imageHeight = gridRect.width * aspect;
                var imageRect = new Rect(gridRect.x, gridRect.y + (gridRect.height - imageHeight) * 0.5f, gridRect.width, imageHeight);
                GUI.DrawTexture(imageRect, state.ReferenceTexture, ScaleMode.StretchToFill);
            }
            else
            {
                EditorGUI.DrawRect(gridRect, new Color(0.2f, 0.2f, 0.2f, 1f));
            }
        }

        private void DrawCells(Rect gridRect, GridMapEditorState state)
        {
            foreach (var pair in state.CellTypes)
            {
                var mask = pair.Value;
                if (mask == GridCellType.Empty)
                {
                    continue;
                }

                // 逆序叠加绘制：低位类型（Obstacle/Difficult/Water）最后画、显示在最上层；
                // 一个格子含多个掩码位时，各类型颜色按半透明叠加混合。
                for (int i = GridMapEditorState.PaintableTypes.Length - 1; i >= 0; i--)
                {
                    var type = GridMapEditorState.PaintableTypes[i];
                    if ((mask & type) == 0 || !state.IsTypeVisible(type))
                    {
                        continue;
                    }

                    var rect = GetCellRect(gridRect, state.GridSize, pair.Key);
                    EditorGUI.DrawRect(rect, state.GetTypeColor(type));
                }
            }
        }

        private void DrawGridLines(Rect gridRect, GridMapEditorState state)
        {
            Handles.color = new Color(1f, 1f, 1f, 0.3f);

            for (int x = 0; x <= state.GridSize.x; x++)
            {
                var xPos = gridRect.x + x * GridMapEditorConstants.CellDisplaySize;
                Handles.DrawLine(new Vector3(xPos, gridRect.y), new Vector3(xPos, gridRect.yMax));
            }

            for (int y = 0; y <= state.GridSize.y; y++)
            {
                var yPos = gridRect.y + y * GridMapEditorConstants.CellDisplaySize;
                Handles.DrawLine(new Vector3(gridRect.x, yPos), new Vector3(gridRect.xMax, yPos));
            }
        }

        public static bool TryGetGridPos(Rect gridRect, Vector2 mousePos, Vector2Int gridSize, out Vector2Int gridPos)
        {
            gridPos = default;
            if (!gridRect.Contains(mousePos))
            {
                return false;
            }

            var localX = mousePos.x - gridRect.x;
            var localY = mousePos.y - gridRect.y;
            var x = Mathf.FloorToInt(localX / GridMapEditorConstants.CellDisplaySize);
            var y = gridSize.y - 1 - Mathf.FloorToInt(localY / GridMapEditorConstants.CellDisplaySize);

            gridPos = new Vector2Int(x, y);
            return gridPos.x >= 0 && gridPos.x < gridSize.x && gridPos.y >= 0 && gridPos.y < gridSize.y;
        }

        private static Rect GetCellRect(Rect gridRect, Vector2Int gridSize, Vector2Int gridPos)
        {
            var x = gridRect.x + gridPos.x * GridMapEditorConstants.CellDisplaySize;
            var y = gridRect.y + (gridSize.y - 1 - gridPos.y) * GridMapEditorConstants.CellDisplaySize;
            return new Rect(x, y, GridMapEditorConstants.CellDisplaySize, GridMapEditorConstants.CellDisplaySize);
        }
    }
}
