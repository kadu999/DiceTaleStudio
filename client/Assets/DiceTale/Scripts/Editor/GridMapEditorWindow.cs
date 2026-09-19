using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    public class GridMapEditorWindow : EditorWindow
    {
        private GridMapEditorState state;
        private GridMapEditorRenderer renderer;
        private Vector2 scrollPosition;
        private Vector2 panelScrollPosition;

        private const float PanelWidth = 260f;

        [SerializeField] private string serializedMapName = "";
        [SerializeField] private Vector2Int serializedGridSize = new Vector2Int(20, 20);
        [SerializeField] private GridCellType serializedSelectedType = GridCellType.Obstacle;
        [SerializeField] private int serializedBrushSize = 1;
        [SerializeField] private bool serializedEraseMode;
        [SerializeField] private List<GridMapEditorState.CellTypeSettings> serializedTypeSettings;

        [MenuItem("DiceTale/GridMap Editor")]
        public static void ShowWindow()
        {
            GetWindow<GridMapEditorWindow>("GridMap Editor");
        }

        private void OnEnable()
        {
            renderer = new GridMapEditorRenderer();
            state = CreateInstance<GridMapEditorState>();
            state.hideFlags = HideFlags.HideAndDontSave;

            state.MapName = serializedMapName;
            state.GridSize = serializedGridSize;
            state.SelectedType = serializedSelectedType;
            state.BrushSize = serializedBrushSize;
            state.EraseMode = serializedEraseMode;
            state.TypeSettings = serializedTypeSettings;
        }

        private void OnDisable()
        {
            if (state == null)
            {
                return;
            }

            serializedMapName = state.MapName;
            serializedGridSize = state.GridSize;
            serializedSelectedType = state.SelectedType;
            serializedBrushSize = state.BrushSize;
            serializedEraseMode = state.EraseMode;
            serializedTypeSettings = new List<GridMapEditorState.CellTypeSettings>(state.TypeSettings);

            DestroyImmediate(state);
            state = null;
        }

        private void OnGUI()
        {
            var viewportWidth = Mathf.Max(position.width - PanelWidth, 50f);
            var viewportRect = new Rect(0f, 0f, viewportWidth, position.height);
            var panelRect = new Rect(viewportRect.xMax, 0f, position.width - viewportRect.xMax, position.height);

            GUILayout.BeginArea(panelRect);
            panelScrollPosition = EditorGUILayout.BeginScrollView(panelScrollPosition);
            renderer.DrawToolbar(
                state,
                out var shouldLoadTexture,
                out var shouldSave,
                out var shouldLoad);
            renderer.DrawInfo(state);
            EditorGUILayout.EndScrollView();
            GUILayout.EndArea();

            EditorGUI.DrawRect(new Rect(viewportRect.xMax, 0f, 1f, position.height), new Color(0f, 0f, 0f, 0.35f));

            var totalWidth = state.GridSize.x * GridMapEditorConstants.CellDisplaySize;
            var totalHeight = state.GridSize.y * GridMapEditorConstants.CellDisplaySize;
            var gridRect = new Rect(0f, 0f, totalWidth, totalHeight);

            scrollPosition = GUI.BeginScrollView(viewportRect, scrollPosition, gridRect);
            renderer.DrawGrid(state, gridRect);
            GUI.EndScrollView();

            if (shouldLoadTexture)
            {
                var filePath = EditorUtility.OpenFilePanel("选择参考图", "Assets", "png,jpg,jpeg,bmp");
                state.LoadReferenceTexture(filePath);
            }
            if (shouldSave)
            {
                state.SaveData();
            }
            if (shouldLoad)
            {
                state.LoadData();
            }

            HandleInput(viewportRect, gridRect);
        }

        private void HandleInput(Rect viewportRect, Rect gridRect)
        {
            var e = Event.current;
            if (e == null)
            {
                return;
            }

            if (e.type != EventType.MouseDown && e.type != EventType.MouseDrag)
            {
                return;
            }

            if (!viewportRect.Contains(e.mousePosition))
            {
                return;
            }

            var localX = e.mousePosition.x + scrollPosition.x;
            var localY = e.mousePosition.y - viewportRect.y + scrollPosition.y;

            var x = Mathf.FloorToInt(localX / GridMapEditorConstants.CellDisplaySize);
            var y = state.GridSize.y - 1 - Mathf.FloorToInt(localY / GridMapEditorConstants.CellDisplaySize);

            if (x < 0 || x >= state.GridSize.x || y < 0 || y >= state.GridSize.y)
            {
                return;
            }

            var gridPos = new Vector2Int(x, y);
            if (e.button == 0)
            {
                if (state.EraseMode)
                {
                    state.Erase(gridPos);
                }
                else
                {
                    state.Paint(gridPos);
                }
                e.Use();
            }
        }
    }
}
