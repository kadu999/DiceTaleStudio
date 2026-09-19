using System.Collections.Generic;
using System.IO;
using DiceTale;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor.Tests
{
    public class GridMapEditorStateTests
    {
        private GameObject _cleanupGameObject;
        private string _cleanupFilePath;

        // 与 SaveData 写入路径（Assets/DiceTale/Resources/Scenes）一致的清理清单
        private static readonly string[] TestMapNames = { "TestMap", "OverlapTestMap" };

        [SetUp]
        public void SetUp()
        {
            // 清理上次执行可能残留的 .bytes（防止泄漏进仓库/构建包）
            foreach (var name in TestMapNames)
            {
                DeleteTestMapFile(name);
            }
        }

        [TearDown]
        public void TearDown()
        {
            if (_cleanupGameObject != null)
            {
                Object.DestroyImmediate(_cleanupGameObject);
                _cleanupGameObject = null;
            }

            if (!string.IsNullOrEmpty(_cleanupFilePath) && File.Exists(_cleanupFilePath))
            {
                File.Delete(_cleanupFilePath);
                _cleanupFilePath = null;
            }
        }

        private static void DeleteTestMapFile(string name)
        {
            var path = Path.Combine(Application.dataPath, GridMapEditorConstants.DataDirectoryFull, $"{name}.bytes");
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }

        [Test]
        public void Paint_WithBrushSize1_PaintsSingleCenterCell()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;

            state.Paint(new Vector2Int(2, 2));

            Assert.AreEqual(1, state.CellTypes.Count);
            Assert.IsTrue(state.CellTypes.ContainsKey(new Vector2Int(2, 2)));
            Assert.AreEqual(GridCellType.Obstacle, state.CellTypes[new Vector2Int(2, 2)]);
        }

        [Test]
        public void Paint_WithBrushSize3_Paints3x3CenteredCells()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(10, 10);
            state.BrushSize = 3;
            state.SelectedType = GridCellType.Obstacle;

            state.Paint(new Vector2Int(5, 5));

            Assert.AreEqual(9, state.CellTypes.Count);
            for (int x = 4; x <= 6; x++)
            {
                for (int y = 4; y <= 6; y++)
                {
                    Assert.IsTrue(state.CellTypes.ContainsKey(new Vector2Int(x, y)));
                }
            }
        }

        [Test]
        public void Paint_OutOfBounds_IsIgnored()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;

            state.Paint(new Vector2Int(-1, -1));

            Assert.AreEqual(0, state.CellTypes.Count);
        }

        [Test]
        public void Erase_RemovesCells()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;
            state.Paint(new Vector2Int(2, 2));

            state.Erase(new Vector2Int(2, 2));

            Assert.AreEqual(0, state.CellTypes.Count);
        }

        [Test]
        public void Clear_RemovesAllCells()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;
            state.Paint(new Vector2Int(1, 1));
            state.Paint(new Vector2Int(2, 2));
            state.Paint(new Vector2Int(3, 3));

            state.Clear();

            Assert.AreEqual(0, state.CellTypes.Count);
        }

        [Test]
        public void GridSize_IsClampedToAtLeastOne()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(0, -3);
            Assert.AreEqual(Vector2Int.one, state.GridSize);
        }

        [Test]
        public void BrushSize_IsClampedToConstants()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.BrushSize = 0;
            Assert.AreEqual(GridMapEditorConstants.MinBrushSize, state.BrushSize);
            state.BrushSize = 100;
            Assert.AreEqual(GridMapEditorConstants.MaxBrushSize, state.BrushSize);
        }

        [Test]
        public void SaveData_AndRuntimeGridMap_LoadData_Match()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.MapName = "TestMap";
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Difficult;
            state.Paint(new Vector2Int(1, 1));
            state.SelectedType = GridCellType.Water;
            state.Paint(new Vector2Int(2, 2));

            state.SaveData();

            _cleanupGameObject = new GameObject("TestMap");
            var gridMap = _cleanupGameObject.AddComponent<GridMap>();
            gridMap.LoadData("TestMap");

            _cleanupFilePath = Path.Combine(Application.dataPath, GridMapEditorConstants.DataDirectoryFull, "TestMap.bytes");

            Assert.AreEqual(GridCellType.Difficult, gridMap.GetCellType(new Vector2Int(1, 1)));
            Assert.AreEqual(GridCellType.Water, gridMap.GetCellType(new Vector2Int(2, 2)));
            Assert.AreEqual(GridCellType.Empty, gridMap.GetCellType(new Vector2Int(0, 0)));
        }

        [Test]
        public void Paint_PerformUndo_RevertsDictionary()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;

            state.Paint(new Vector2Int(2, 2));
            Assert.AreEqual(1, state.CellTypes.Count);

            Undo.PerformUndo();
            Assert.AreEqual(0, state.CellTypes.Count);
        }

        [Test]
        public void LoadData_WithEmptyMapName_LeavesExistingCellsIntact()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.MapName = "";
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;
            state.Paint(new Vector2Int(2, 2));

            state.LoadData();

            Assert.AreEqual(1, state.CellTypes.Count);
            Assert.IsTrue(state.CellTypes.ContainsKey(new Vector2Int(2, 2)));
        }

        [Test]
        public void TypeSettings_HaveDefaultsForAllPaintableTypes()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            Assert.AreEqual(GridMapEditorState.PaintableTypes.Length, state.TypeSettings.Count);

            foreach (var type in GridMapEditorState.PaintableTypes)
            {
                Assert.IsTrue(state.IsTypeVisible(type), $"{type} 应默认可见");
                Assert.AreNotEqual(Color.clear, state.GetTypeColor(type), $"{type} 应有默认颜色");
            }
        }

        [Test]
        public void SetTypeVisible_ReflectedInIsTypeVisible()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.SetTypeVisible(GridCellType.Water, false);
            Assert.IsFalse(state.IsTypeVisible(GridCellType.Water));
            Assert.IsTrue(state.IsTypeVisible(GridCellType.Obstacle));

            state.SetTypeVisible(GridCellType.Water, true);
            Assert.IsTrue(state.IsTypeVisible(GridCellType.Water));
        }

        [Test]
        public void SetTypeColor_ReflectedInGetTypeColor()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            var color = new Color(0.1f, 0.2f, 0.3f, 0.9f);
            state.SetTypeColor(GridCellType.Water, color);
            Assert.AreEqual(color, state.GetTypeColor(GridCellType.Water));
        }

        [Test]
        public void TypeSettings_AreReinjectedViaProperty()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.SetTypeColor(GridCellType.Fog1, new Color(1f, 0f, 0f, 0.5f));
            state.SetTypeVisible(GridCellType.Fog1, false);

            var persisted = new List<GridMapEditorState.CellTypeSettings>(state.TypeSettings);
            var restored = ScriptableObject.CreateInstance<GridMapEditorState>();
            restored.TypeSettings = persisted;

            Assert.IsFalse(restored.IsTypeVisible(GridCellType.Fog1));
            Assert.AreEqual(new Color(1f, 0f, 0f, 0.5f), restored.GetTypeColor(GridCellType.Fog1));
        }

        [Test]
        public void Paint_TwoTypesOnSameCell_CombinesMasks()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;
            state.Paint(new Vector2Int(2, 2));

            state.SelectedType = GridCellType.Fog1;
            state.Paint(new Vector2Int(2, 2));

            Assert.AreEqual(1, state.CellTypes.Count);
            Assert.AreEqual(GridCellType.Obstacle | GridCellType.Fog1, state.CellTypes[new Vector2Int(2, 2)]);
        }

        [Test]
        public void Erase_RemovesAllMasksOnCell()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;
            state.Paint(new Vector2Int(2, 2));
            state.SelectedType = GridCellType.Water;
            state.Paint(new Vector2Int(2, 2));

            state.Erase(new Vector2Int(2, 2));

            Assert.AreEqual(0, state.CellTypes.Count);
        }

        [Test]
        public void SaveData_OverlappingMasks_RoundTripPreserved()
        {
            var state = ScriptableObject.CreateInstance<GridMapEditorState>();
            state.MapName = "OverlapTestMap";
            state.GridSize = new Vector2Int(5, 5);
            state.BrushSize = 1;
            state.SelectedType = GridCellType.Obstacle;
            state.Paint(new Vector2Int(1, 1));
            state.SelectedType = GridCellType.Fog1;
            state.Paint(new Vector2Int(1, 1));

            state.SaveData();

            _cleanupGameObject = new GameObject("OverlapTestMap");
            var gridMap = _cleanupGameObject.AddComponent<GridMap>();
            gridMap.LoadData("OverlapTestMap");

            _cleanupFilePath = Path.Combine(Application.dataPath, GridMapEditorConstants.DataDirectoryFull, "OverlapTestMap.bytes");

            Assert.AreEqual(GridCellType.Obstacle | GridCellType.Fog1, gridMap.GetCellType(new Vector2Int(1, 1)));
        }
    }
}
