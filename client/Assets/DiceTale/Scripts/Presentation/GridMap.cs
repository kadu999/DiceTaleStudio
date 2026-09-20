using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace DiceTale
{
    [System.Serializable]
    public class GridMapData
    {
        public int gridSizeX = 20;
        public int gridSizeY = 20;
        public int[] cells = new int[0];
    }

    public class GridMap : MonoBehaviour
    {
        [SerializeField]
        private Vector2Int gridSize = new Vector2Int(20, 20);

        [SerializeField]
        private float cellSize = 1f;

        [SerializeField]
        private bool drawBlockedCells = true;

        private GridCellType[,] cellGrid;
        private HashSet<Vector2Int> dynamicObstacles = new HashSet<Vector2Int>();

        /// <summary>编辑态是否已加载过 .bytes 网格数据（Scene 视图直接显示阻挡格，避免每帧重载）。</summary>
        private bool dataLoadedInEditor;

        public Vector2Int GridSize => gridSize;
        public float CellSize => cellSize;

        /// <summary>网格原点：网格左下角（XZ 平面，Y 取地图所在高度）。</summary>
        public Vector3 GridOrigin => transform.position - new Vector3(
            gridSize.x * cellSize * 0.5f,
            0f,
            gridSize.y * cellSize * 0.5f
        );

        public float GridWidth => gridSize.x * cellSize;
        public float GridHeight => gridSize.y * cellSize;

        private void Awake()
        {
            EnsureCellGrid();
        }

        /// <summary>确保 cellGrid 已初始化（默认全空格子），数据未加载（如缺少 .bytes）时也不会 NRE。</summary>
        private void EnsureCellGrid()
        {
            if (cellGrid == null)
            {
                cellGrid = new GridCellType[gridSize.x, gridSize.y];
            }
        }

        public void LoadData(string fileName = null)
        {
            var name = fileName ?? this.name.Replace("(Clone)", "");
            // .bytes 网格数据集中在 Resources/Scenes/ 子目录：短名只匹配 Resources 根，子目录带路径（"Scenes/Map001"）
            var textAsset = Resources.Load<TextAsset>(name);
            if (textAsset == null)
            {
                textAsset = Resources.Load<TextAsset>("Scenes/" + name);
            }

            if (textAsset == null)
            {
                return;
            }

            try
            {
                using (var reader = new BinaryReader(new MemoryStream(textAsset.bytes)))
                {
                    var data = new GridMapData();
                    data.gridSizeX = reader.ReadInt32();
                    data.gridSizeY = reader.ReadInt32();

                    // 输入校验：损坏/截断的 .bytes 或非法尺寸会导致越界崩溃、负尺寸分配、纹理/A* 规模爆炸
                    const int MaxGridDimension = 1024;
                    if (data.gridSizeX <= 0 || data.gridSizeY <= 0 ||
                        data.gridSizeX > MaxGridDimension || data.gridSizeY > MaxGridDimension)
                    {
                        Debug.LogError($"[GridMap] 网格数据尺寸非法: {data.gridSizeX}x{data.gridSizeY}（{name}.bytes），已忽略");
                        return;
                    }

                    var count = data.gridSizeX * data.gridSizeY;
                    data.cells = new int[count];
                    for (int i = 0; i < count; i++)
                    {
                        data.cells[i] = reader.ReadInt32();
                    }

                    gridSize = new Vector2Int(data.gridSizeX, data.gridSizeY);
                    cellGrid = new GridCellType[gridSize.x, gridSize.y];

                    for (int y = 0; y < gridSize.y; y++)
                    {
                        for (int x = 0; x < gridSize.x; x++)
                        {
                            cellGrid[x, y] = (GridCellType)GetCellMask(data.cells, x, y, gridSize.x);
                        }
                    }
                }
            }
            catch (System.Exception ex)
            {
                Debug.LogError($"[GridMap] 网格数据读取失败（{name}.bytes）: {ex.Message}");
            }
        }

        public void SaveData(string fileName = null)
        {
            EnsureCellGrid(); // 编辑器未加载数据时也能安全保存（全空格子）

            var data = new GridMapData
            {
                gridSizeX = gridSize.x,
                gridSizeY = gridSize.y,
                cells = new int[gridSize.x * gridSize.y]
            };

            for (int x = 0; x < gridSize.x; x++)
            {
                for (int y = 0; y < gridSize.y; y++)
                {
                    SetCellMask(data.cells, x, y, gridSize.x, (int)cellGrid[x, y]);
                }
            }

#if UNITY_EDITOR
            var directory = Path.Combine(Application.dataPath, "DiceTale/Resources");
            if (!Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var path = Path.Combine(directory, $"{fileName ?? this.name}.bytes");
            using (var writer = new BinaryWriter(File.Open(path, FileMode.Create)))
            {
                writer.Write(data.gridSizeX);
                writer.Write(data.gridSizeY);
                foreach (var mask in data.cells)
                {
                    writer.Write(mask);
                }
            }
            UnityEditor.AssetDatabase.Refresh();
#endif
        }

        private static int GetCellMask(int[] cells, int x, int y, int width)
        {
            return cells[y * width + x];
        }

        private static void SetCellMask(int[] cells, int x, int y, int width, int mask)
        {
            cells[y * width + x] = mask;
        }

        public bool IsWalkable(Vector2Int gridPos)
        {
            if (gridPos.x < 0 || gridPos.x >= gridSize.x || gridPos.y < 0 || gridPos.y >= gridSize.y)
            {
                return false;
            }

            if (dynamicObstacles.Contains(gridPos))
            {
                return false;
            }

            // 只要含 Obstacle 位即不可通行（允许与其他类型位组合，如 Obstacle | Fog1）
            return (GetCellType(gridPos) & GridCellType.Obstacle) == GridCellType.Empty;
        }

        public void SetCellType(Vector2Int gridPos, GridCellType type)
        {
            if (cellGrid == null || !IsInside(gridPos))
            {
                return;
            }

            cellGrid[gridPos.x, gridPos.y] = type;
        }

        public GridCellType GetCellType(Vector2Int gridPos)
        {
            if (cellGrid == null || !IsInside(gridPos))
            {
                return GridCellType.Empty;
            }

            return cellGrid[gridPos.x, gridPos.y];
        }

        private bool IsInside(Vector2Int gridPos)
        {
            return gridPos.x >= 0 && gridPos.x < gridSize.x && gridPos.y >= 0 && gridPos.y < gridSize.y;
        }

        /// <summary>格子二维数组（[x, y]，值为格子类型）。</summary>
        public GridCellType[,] CellGrid => cellGrid;

        public void AddDynamicObstacle(Vector2Int gridPos)
        {
            if (gridPos.x < 0 || gridPos.x >= gridSize.x || gridPos.y < 0 || gridPos.y >= gridSize.y)
            {
                return;
            }

            dynamicObstacles.Add(gridPos);
        }

        public void RemoveDynamicObstacle(Vector2Int gridPos)
        {
            dynamicObstacles.Remove(gridPos);
        }

        public void ClearDynamicObstacles()
        {
            dynamicObstacles.Clear();
        }

        /// <summary>网格数据/尺寸变化后，让所有动态阻挡重新计算占用格子（网格加载完成后调用）。</summary>
        public void RefreshDynamicObstacles()
        {
            foreach (var obstacle in Object.FindObjectsByType<DynamicObstacle>(FindObjectsSortMode.None))
            {
                obstacle.RefreshBlocking();
            }
        }

        /// <summary>世界坐标 → 格子坐标（地面为 XZ 平面，Y 不参与换算）。</summary>
        public Vector2Int WorldToGrid(Vector3 worldPosition)
        {
            var localPosition = worldPosition - GridOrigin;
            return new Vector2Int(
                Mathf.FloorToInt(localPosition.x / cellSize),
                Mathf.FloorToInt(localPosition.z / cellSize)
            );
        }

        /// <summary>格子坐标 → 格子中心的世界坐标（XZ 平面，Y 为网格所在高度）。</summary>
        public Vector3 GridToWorld(Vector2Int gridPos)
        {
            return GridOrigin + new Vector3(
                gridPos.x * cellSize + cellSize * 0.5f,
                0f,
                gridPos.y * cellSize + cellSize * 0.5f
            );
        }

        /// <summary>把屏幕坐标投射到本网格所在的 XZ 平面（Y 取网格自身高度）。
        /// 供「屏幕→世界」换算复用，避免各模块重复实现投射逻辑。
        /// （战争雾不走这里：它按后台下发的**归一化轨迹**在遮罩上擦，与格子无关。）</summary>
        public Vector3 ScreenToPlane(Camera camera, Vector2 screenPosition)
        {
            if (camera == null)
            {
                return Vector3.zero;
            }

            var planeY = transform.position.y;
            var plane = new Plane(Vector3.up, new Vector3(0f, planeY, 0f));
            var ray = camera.ScreenPointToRay(screenPosition);
            if (plane.Raycast(ray, out var distance))
            {
                return ray.GetPoint(distance);
            }

            // 视线与平面平行（罕见）：退回正交投影结果
            var fallback = camera.ScreenToWorldPoint(screenPosition);
            fallback.y = planeY;
            return fallback;
        }

        public List<Vector2Int> FindPath(Vector2Int start, Vector2Int end)
        {
            if (!IsWalkable(end))
            {
                return null;
            }

            if (start == end)
            {
                return new List<Vector2Int>();
            }

            var openSet = new List<Vector2Int> { start };
            var cameFrom = new Dictionary<Vector2Int, Vector2Int>();
            var gScore = new Dictionary<Vector2Int, float> { [start] = 0 };
            var fScore = new Dictionary<Vector2Int, float> { [start] = Heuristic(start, end) };

            int[] dx = { 0, 1, 0, -1 };
            int[] dy = { 1, 0, -1, 0 };

            while (openSet.Count > 0)
            {
                var current = openSet[0];
                var lowestIndex = 0;
                for (int i = 1; i < openSet.Count; i++)
                {
                    if (fScore[openSet[i]] < fScore[current])
                    {
                        current = openSet[i];
                        lowestIndex = i;
                    }
                }

                if (current == end)
                {
                    return ReconstructPath(cameFrom, current, start);
                }

                openSet.RemoveAt(lowestIndex);

                for (int i = 0; i < 4; i++)
                {
                    var neighbor = new Vector2Int(current.x + dx[i], current.y + dy[i]);
                    if (!IsWalkable(neighbor))
                    {
                        continue;
                    }

                    var tentativeG = gScore[current] + 1;
                    if (!gScore.ContainsKey(neighbor) || tentativeG < gScore[neighbor])
                    {
                        cameFrom[neighbor] = current;
                        gScore[neighbor] = tentativeG;
                        fScore[neighbor] = tentativeG + Heuristic(neighbor, end);

                        if (!openSet.Contains(neighbor))
                        {
                            openSet.Add(neighbor);
                        }
                    }
                }
            }

            return null;
        }

        private static float Heuristic(Vector2Int a, Vector2Int b)
        {
            return Mathf.Abs(a.x - b.x) + Mathf.Abs(a.y - b.y);
        }

        private static List<Vector2Int> ReconstructPath(Dictionary<Vector2Int, Vector2Int> cameFrom, Vector2Int current, Vector2Int start)
        {
            var path = new List<Vector2Int> { current };
            while (current != start)
            {
                current = cameFrom[current];
                path.Add(current);
            }
            path.Reverse();
            path.RemoveAt(0);
            return path;
        }

        private void OnDrawGizmos()
        {
            EnsureCellGrid();

#if UNITY_EDITOR
            // 编辑态（未运行）也能在 Scene 视图看到阻挡格子：直接加载 .bytes 网格数据
            if (!Application.isPlaying && !dataLoadedInEditor)
            {
                LoadData();
                dataLoadedInEditor = true;
            }
#endif

            // 完整网格线（全部行列）：便于在 Scene 视图核对网格与地图是否对齐
            DrawGridLines();

            if (!drawBlockedCells)
            {
                return;
            }

            for (int x = 0; x < gridSize.x; x++)
            {
                for (int y = 0; y < gridSize.y; y++)
                {
                    var type = cellGrid[x, y];
                    // 雾格子由战争雾那一层自己画（前端按地图数据建遮罩），Gizmos 不画雾，避免 Scene 视图误判
                    if (type == GridCellType.Empty || IsFogType(type))
                    {
                        continue;
                    }

                    DrawCellGizmo(new Vector2Int(x, y), GetCellTypeColor(type));
                }
            }

            var dynamicColor = new Color(1f, 0f, 1f, 0.5f);
            foreach (var obstacle in dynamicObstacles)
            {
                DrawCellGizmo(obstacle, dynamicColor);
            }
        }

        /// <summary>画完整网格线（XZ 平面，Y 取网格所在高度），不依赖格子数据。线条较淡，仅作对齐参考。</summary>
        private void DrawGridLines()
        {
            Gizmos.color = new Color(1f, 1f, 1f, 0.3f);
            var origin = GridOrigin;
            var width = gridSize.x * cellSize;
            var height = gridSize.y * cellSize;

            for (int x = 0; x <= gridSize.x; x++)
            {
                var from = origin + new Vector3(x * cellSize, 0f, 0f);
                Gizmos.DrawLine(from, from + new Vector3(0f, 0f, height));
            }

            for (int y = 0; y <= gridSize.y; y++)
            {
                var from = origin + new Vector3(0f, 0f, y * cellSize);
                Gizmos.DrawLine(from, from + new Vector3(width, 0f, 0f));
            }
        }

        private static Color GetCellTypeColor(GridCellType type)
        {
            // 组合掩码按优先级取主色（Obstacle 优先，其次 Difficult/Water，最后雾）
            if ((type & GridCellType.Obstacle) != 0)
            {
                return new Color(1f, 0f, 0f, 0.5f);
            }
            if ((type & GridCellType.Difficult) != 0)
            {
                return new Color(1f, 0.5f, 0f, 0.5f);
            }
            if ((type & GridCellType.Water) != 0)
            {
                return new Color(0f, 0.5f, 1f, 0.5f);
            }
            if ((type & GridCellType.Fog1) != 0)
            {
                return new Color(0.85f, 0.85f, 0.85f, 0.4f);
            }
            if ((type & GridCellType.Fog2) != 0)
            {
                return new Color(0.3f, 0.8f, 0.9f, 0.45f);
            }
            if ((type & GridCellType.Fog3) != 0)
            {
                return new Color(0.65f, 0.4f, 0.9f, 0.5f);
            }
            if ((type & GridCellType.Fog4) != 0)
            {
                return new Color(1f, 0.65f, 0.15f, 0.55f);
            }
            if ((type & GridCellType.Fog5) != 0)
            {
                return new Color(0.95f, 0.3f, 0.3f, 0.6f);
            }
            return Color.clear;
        }

        private static bool IsFogType(GridCellType type)
        {
            // 含任意雾位即为雾格子（可与障碍等其他位组合）
            const GridCellType fogMask = GridCellType.Fog1 | GridCellType.Fog2 | GridCellType.Fog3 | GridCellType.Fog4 | GridCellType.Fog5;
            return (type & fogMask) != 0;
        }

        private void DrawCellGizmo(Vector2Int gridPos, Color color)
        {
            if (gridPos.x < 0 || gridPos.x >= gridSize.x || gridPos.y < 0 || gridPos.y >= gridSize.y)
            {
                return;
            }

            Gizmos.color = color;
            var center = GridToWorld(gridPos);
            var size = new Vector3(cellSize, 0.1f, cellSize);
            Gizmos.DrawCube(center, size);
        }
    }
}
