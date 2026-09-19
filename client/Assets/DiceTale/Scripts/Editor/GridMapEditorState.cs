using System.Collections.Generic;
using System.IO;
using DiceTale;
using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    public class GridMapEditorState : ScriptableObject
    {
        [SerializeField] private string mapName = "";
        [SerializeField] private Vector2Int gridSize = new Vector2Int(20, 20);
        [SerializeField] private GridCellType selectedType = GridCellType.Obstacle;
        [SerializeField] private int brushSize = 1;
        [SerializeField] private bool eraseMode;
        [SerializeField] private List<SerializedCell> serializedCells = new List<SerializedCell>();
        [SerializeField] private List<CellTypeSettings> typeSettings = new List<CellTypeSettings>();

        private Dictionary<Vector2Int, GridCellType> cellTypes = new Dictionary<Vector2Int, GridCellType>();
        private Dictionary<GridCellType, CellTypeSettings> settingsByType = new Dictionary<GridCellType, CellTypeSettings>();

        /// <summary>所有可绘制的格子类型（掩码 1/2/4/8...128）。</summary>
        public static readonly GridCellType[] PaintableTypes =
        {
            GridCellType.Obstacle,
            GridCellType.Difficult,
            GridCellType.Water,
            GridCellType.Fog1,
            GridCellType.Fog2,
            GridCellType.Fog3,
            GridCellType.Fog4,
            GridCellType.Fog5,
        };

        [System.Serializable]
        private class SerializedCell
        {
            public int x;
            public int y;
            public int mask;
        }

        [System.Serializable]
        public class CellTypeSettings
        {
            public GridCellType type;
            public bool visible = true;
            public Color color = Color.white;
        }

        public string MapName { get => mapName; set => mapName = value; }
        public Vector2Int GridSize
        {
            get => gridSize;
            set
            {
                gridSize = Vector2Int.Max(value, Vector2Int.one);
                // 缩小尺寸后字典里会残留越界坐标，导致 SaveData 越界崩溃，立即裁剪
                PruneOutOfBoundsCells();
            }
        }
        public GridCellType SelectedType { get => selectedType; set => selectedType = value; }
        public int BrushSize { get => brushSize; set => brushSize = Mathf.Clamp(value, GridMapEditorConstants.MinBrushSize, GridMapEditorConstants.MaxBrushSize); }
        public bool EraseMode { get => eraseMode; set => eraseMode = value; }
        [field: System.NonSerialized]
        public Texture2D ReferenceTexture { get; set; }
        public IReadOnlyDictionary<Vector2Int, GridCellType> CellTypes => cellTypes;

        public List<CellTypeSettings> TypeSettings
        {
            get => typeSettings;
            set
            {
                typeSettings = value;
                EnsureTypeSettings();
            }
        }

        public bool IsTypeVisible(GridCellType type)
        {
            return settingsByType.TryGetValue(type, out var settings) ? settings.visible : true;
        }

        public Color GetTypeColor(GridCellType type)
        {
            return settingsByType.TryGetValue(type, out var settings) ? settings.color : GetDefaultColor(type);
        }

        public void SetTypeVisible(GridCellType type, bool visible)
        {
            var settings = GetOrCreateSettings(type);
            if (settings.visible == visible)
            {
                return;
            }

            Undo.RecordObject(this, "切换类型显示");
            settings.visible = visible;
        }

        public void SetTypeColor(GridCellType type, Color color)
        {
            var settings = GetOrCreateSettings(type);
            if (settings.color == color)
            {
                return;
            }

            Undo.RecordObject(this, "修改类型颜色");
            settings.color = color;
        }

        private CellTypeSettings GetOrCreateSettings(GridCellType type)
        {
            if (!settingsByType.TryGetValue(type, out var settings))
            {
                settings = new CellTypeSettings
                {
                    type = type,
                    visible = true,
                    color = GetDefaultColor(type)
                };
                typeSettings.Add(settings);
                settingsByType[type] = settings;
            }

            return settings;
        }

        private void EnsureTypeSettings()
        {
            if (typeSettings == null)
            {
                typeSettings = new List<CellTypeSettings>();
            }

            settingsByType.Clear();
            foreach (var settings in typeSettings)
            {
                if (settings == null)
                {
                    continue;
                }

                settingsByType[settings.type] = settings;
            }

            foreach (var type in PaintableTypes)
            {
                GetOrCreateSettings(type);
            }
        }

        private static Color GetDefaultColor(GridCellType type)
        {
            switch (type)
            {
                case GridCellType.Obstacle: return new Color(1f, 0f, 0f, 0.6f);
                case GridCellType.Difficult: return new Color(1f, 0.5f, 0f, 0.6f);
                case GridCellType.Water: return new Color(0f, 0.5f, 1f, 0.6f);
                case GridCellType.Fog1: return new Color(0.85f, 0.85f, 0.85f, 0.55f);
                case GridCellType.Fog2: return new Color(0.3f, 0.8f, 0.9f, 0.6f);
                case GridCellType.Fog3: return new Color(0.65f, 0.4f, 0.9f, 0.65f);
                case GridCellType.Fog4: return new Color(1f, 0.65f, 0.15f, 0.7f);
                case GridCellType.Fog5: return new Color(0.95f, 0.3f, 0.3f, 0.75f);
                default: return Color.white;
            }
        }

        private void OnEnable()
        {
            Undo.undoRedoPerformed -= RebuildDictionary;
            Undo.undoRedoPerformed += RebuildDictionary;
            EnsureTypeSettings();
            RebuildDictionary();
        }

        private void OnDisable()
        {
            Undo.undoRedoPerformed -= RebuildDictionary;
        }

        private void OnValidate()
        {
            EnsureTypeSettings();
            RebuildDictionary();
        }

        private void RebuildDictionary()
        {
            cellTypes.Clear();
            if (serializedCells == null)
            {
                return;
            }

            foreach (var cell in serializedCells)
            {
                if (cell == null)
                {
                    continue;
                }

                var pos = new Vector2Int(cell.x, cell.y);
                var type = (GridCellType)cell.mask;
                if (type != GridCellType.Empty && IsInsideGrid(pos))
                {
                    cellTypes[pos] = type;
                }
            }
        }

        private void SyncDictionaryToSerializedCells()
        {
            if (serializedCells == null)
            {
                serializedCells = new List<SerializedCell>();
            }

            serializedCells.Clear();
            foreach (var pair in cellTypes)
            {
                serializedCells.Add(new SerializedCell
                {
                    x = pair.Key.x,
                    y = pair.Key.y,
                    mask = (int)pair.Value
                });
            }
        }

        /// <summary>裁剪字典中超出当前 GridSize 的条目，并同步回 serializedCells。</summary>
        private void PruneOutOfBoundsCells()
        {
            if (cellTypes == null || cellTypes.Count == 0)
            {
                return;
            }

            var keysToRemove = new List<Vector2Int>();
            foreach (var pos in cellTypes.Keys)
            {
                if (!IsInsideGrid(pos))
                {
                    keysToRemove.Add(pos);
                }
            }

            if (keysToRemove.Count == 0)
            {
                return;
            }

            foreach (var pos in keysToRemove)
            {
                cellTypes.Remove(pos);
            }

            SyncDictionaryToSerializedCells();
        }

        public void Paint(Vector2Int center)
        {
            Undo.RecordObject(this, "Paint Grid");
            ApplyBrush(center, selectedType);
        }

        public void Erase(Vector2Int center)
        {
            Undo.RecordObject(this, "Erase Grid");
            ApplyBrush(center, GridCellType.Empty);
        }

        private void ApplyBrush(Vector2Int center, GridCellType type)
        {
            var radius = (brushSize - 1) / 2;
            for (int x = -radius; x <= radius; x++)
            {
                for (int y = -radius; y <= radius; y++)
                {
                    var pos = new Vector2Int(center.x + x, center.y + y);
                    if (!IsInsideGrid(pos))
                    {
                        continue;
                    }

                    if (type == GridCellType.Empty)
                    {
                        cellTypes.Remove(pos);
                    }
                    else
                    {
                        // 掩码叠加：同一格子上合并多个类型位（例如 Obstacle | Fog1）
                        cellTypes.TryGetValue(pos, out var existing);
                        cellTypes[pos] = existing | type;
                    }
                }
            }

            SyncDictionaryToSerializedCells();
        }

        public void Clear()
        {
            Undo.RecordObject(this, "Clear Grid");
            cellTypes.Clear();
            SyncDictionaryToSerializedCells();
        }

        public void SaveData()
        {
            if (string.IsNullOrEmpty(mapName))
            {
                Debug.LogWarning("地图名不能为空");
                return;
            }

            if (HasInvalidFileNameChars(mapName))
            {
                Debug.LogError($"地图名含非法字符（路径分隔符、.. 等），已中止保存: {mapName}");
                return;
            }

            // 双保险：写入前再裁剪一次越界条目，防止缩小 GridSize 后残留坐标越界
            PruneOutOfBoundsCells();

            var data = new GridMapData
            {
                gridSizeX = gridSize.x,
                gridSizeY = gridSize.y,
                cells = new int[gridSize.x * gridSize.y]
            };

            foreach (var pair in cellTypes)
            {
                SetCellMask(data.cells, pair.Key.x, pair.Key.y, gridSize.x, (int)pair.Value);
            }

            var directory = Path.Combine(Application.dataPath, GridMapEditorConstants.DataDirectoryFull);
            if (!Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var path = Path.Combine(directory, $"{mapName}.bytes");
            using (var writer = new BinaryWriter(File.Open(path, FileMode.Create)))
            {
                writer.Write(data.gridSizeX);
                writer.Write(data.gridSizeY);
                foreach (var mask in data.cells)
                {
                    writer.Write(mask);
                }
            }
            AssetDatabase.Refresh();
            Debug.Log($"地图数据已保存: {path}");
        }

        public void LoadData()
        {
            if (string.IsNullOrEmpty(mapName))
            {
                return;
            }

            var path = Path.Combine(Application.dataPath, GridMapEditorConstants.DataDirectoryFull, $"{mapName}.bytes");
            if (!File.Exists(path))
            {
                Debug.LogWarning($"未找到地图数据文件: {path}");
                return;
            }

            using (var reader = new BinaryReader(File.Open(path, FileMode.Open)))
            {
                var data = new GridMapData();
                data.gridSizeX = reader.ReadInt32();
                data.gridSizeY = reader.ReadInt32();
                var count = data.gridSizeX * data.gridSizeY;
                data.cells = new int[count];
                for (int i = 0; i < count; i++)
                {
                    data.cells[i] = reader.ReadInt32();
                }

                Undo.RecordObject(this, "Load Grid");
                cellTypes.Clear();

                GridSize = new Vector2Int(data.gridSizeX, data.gridSizeY);
                for (int y = 0; y < gridSize.y; y++)
                {
                    for (int x = 0; x < gridSize.x; x++)
                    {
                        var pos = new Vector2Int(x, y);
                        var type = (GridCellType)GetCellMask(data.cells, x, y, gridSize.x);
                        if (IsInsideGrid(pos) && type != GridCellType.Empty)
                        {
                            cellTypes[pos] = type;
                        }
                    }
                }

                SyncDictionaryToSerializedCells();
            }
        }

        public void LoadReferenceTexture(string filePath)
        {
            // 加载新纹理前销毁已存在的旧引用纹理，避免重复加载泄漏
            if (ReferenceTexture != null)
            {
                Object.DestroyImmediate(ReferenceTexture);
                ReferenceTexture = null;
            }

            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
            {
                Debug.LogWarning($"图片路径无效: {filePath}");
                return;
            }

            var bytes = File.ReadAllBytes(filePath);
            var texture = new Texture2D(2, 2);
            if (!texture.LoadImage(bytes))
            {
                Debug.LogWarning($"无法解析图片: {filePath}");
                Object.DestroyImmediate(texture);
                return;
            }

            ReferenceTexture = texture;
            MapName = Path.GetFileNameWithoutExtension(filePath);

            LoadData();
        }

        private bool IsInsideGrid(Vector2Int pos)
        {
            return pos.x >= 0 && pos.x < gridSize.x && pos.y >= 0 && pos.y < gridSize.y;
        }

        private static int GetCellMask(int[] cells, int x, int y, int width)
        {
            return cells[y * width + x];
        }

        private static void SetCellMask(int[] cells, int x, int y, int width, int mask)
        {
            cells[y * width + x] = mask;
        }

        /// <summary>校验 mapName 是否含文件系统非法字符，防止写入路径被 ./.. 等穿目录。
        /// 全限定 System.Array：本文件不引用 using System，避免与 UnityEngine.Object 的 Object 标识符歧义。</summary>
        private static bool HasInvalidFileNameChars(string name)
        {
            var invalid = Path.GetInvalidFileNameChars();
            for (int i = 0; i < name.Length; i++)
            {
                if (System.Array.IndexOf(invalid, name[i]) >= 0)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
