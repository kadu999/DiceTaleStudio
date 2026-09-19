using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 迷雾区域（探索揭示，GPU 渲染，单层）：
    /// 所有雾标记（Fog1~Fog5）合成一块整体雾，边缘统一 GPU 羽化（有雾就光滑）。
    /// 玩家进入某个区域 → 该区域格子清除，剩余雾自动重新羽化，边缘保持光滑。
    /// 揭示对所有在场玩家（1~4 号棋子）生效，不只当前玩家。
    /// 支持按住鼠标右键逐格擦除（自包含鼠标采样，不依赖 InputManager 组件；
    /// 屏幕→世界坐标投影复用 GridMap.ScreenToPlane）。
    /// 需要与 GridMap 同物体。
    /// </summary>
    [RequireComponent(typeof(GridMap))]
    public class FogOfWar : MonoBehaviour
    {
        [SerializeField]
        private Color fogColor = new Color(0.85f, 0.88f, 0.92f, 1f);

        [SerializeField]
        private int fogSortingOrder = 1;

        [SerializeField]
        private float checkInterval = 0.2f;

        [Tooltip("允许按住鼠标右键擦除鼠标所指的雾（逐格擦除）")]
        [SerializeField]
        private bool allowRightClickErase = true;

        [Tooltip("雾边缘羽化强度（GPU 模糊次数）")]
        [SerializeField]
        private int blurPasses = 2;

        /// <summary>所有雾位掩码（Fog1|Fog2|Fog3|Fog4|Fog5），用于提取格子的雾分量。</summary>
        private const GridCellType FogMask =
            GridCellType.Fog1 | GridCellType.Fog2 | GridCellType.Fog3 | GridCellType.Fog4 | GridCellType.Fog5;

        private const string BlurShaderName = "DiceTale/FogBlur";
        private const string GridSizeProperty = "_GridSize";

        private GridMap gridMap;

        // 单层雾状态（格子级）：alpha=1 雾存在，0 已揭示/擦除
        private Texture2D fogState;
        private int width;
        private int height;

        // 代码生成的雾地面网格（XZ 平面，法线朝上），随物体销毁
        private Mesh groundMesh;

        // GPU 羽化链
        private RenderTexture[] blurRTs;
        private Material blurMaterial;
        private Material displayMaterial;

        private readonly Dictionary<GridCellType, List<int>> cellsByType = new Dictionary<GridCellType, List<int>>();
        private readonly HashSet<GridCellType> revealedAreas = new HashSet<GridCellType>();
        private float checkTimer;

        private void Start()
        {
            gridMap = GetComponent<GridMap>();
            BuildFog();
        }

        private void Update()
        {
            HandleRightClickErase();
            TickPlayerReveal();
        }

        private void OnDestroy()
        {
            if (fogState != null)
            {
                Destroy(fogState);
            }

            if (groundMesh != null)
            {
                Destroy(groundMesh);
            }

            if (blurRTs != null)
            {
                for (int i = 0; i < blurRTs.Length; i++)
                {
                    if (blurRTs[i] != null)
                    {
                        blurRTs[i].Release();
                        Destroy(blurRTs[i]);
                    }
                }
            }

            // 释放本组件自己 new 出来的运行时材质（勿动外部指定/共享材质）
            if (blurMaterial != null)
            {
                Destroy(blurMaterial);
            }

            if (displayMaterial != null)
            {
                Destroy(displayMaterial);
            }
        }

        // ---------------------------------------------------------------- 构建

        private void BuildFog()
        {
            if (!TryInitGrid(out var gridWidth, out var gridHeight))
            {
                return;
            }

            if (!CreateBlurMaterial())
            {
                return;
            }

            CreateFogState();
            CreateBlurChain();
            CreateDisplayObject(gridWidth, gridHeight);
            BlurFog(); // 初始羽化一次

            Debug.Log($"[FogOfWar] {name}: fog cells={CountFogCells()}, single layer");
        }

        private bool TryInitGrid(out float gridWidth, out float gridHeight)
        {
            gridWidth = 0f;
            gridHeight = 0f;

            if (gridMap == null)
            {
                Debug.LogWarning("[FogOfWar] GridMap missing on " + name);
                return false;
            }

            var gridSize = gridMap.GridSize;
            if (gridSize.x <= 0 || gridSize.y <= 0 || gridMap.CellGrid == null)
            {
                Debug.LogWarning("[FogOfWar] Grid data not ready on " + name);
                return false;
            }

            width = gridSize.x;
            height = gridSize.y;
            gridWidth = gridMap.GridWidth;
            gridHeight = gridMap.GridHeight;
            return true;
        }

        private bool CreateBlurMaterial()
        {
            var blurShader = Shader.Find(BlurShaderName);
            if (blurShader == null)
            {
                Debug.LogError($"[FogOfWar] Shader '{BlurShaderName}' not found!");
                return false;
            }

            blurMaterial = new Material(blurShader);
            blurMaterial.SetVector(GridSizeProperty, new Vector4(width, height, 0f, 0f));
            return true;
        }

        /// <summary>单层雾状态：所有雾标记格子 alpha=1，并记录每区域格子。</summary>
        private void CreateFogState()
        {
            fogState = new Texture2D(width, height, TextureFormat.RGBA32, false);
            fogState.filterMode = FilterMode.Point;
            fogState.wrapMode = TextureWrapMode.Clamp;
            fogState.name = "FogState";

            var colors = new Color[width * height];
            cellsByType.Clear();

            var cellGrid = gridMap.CellGrid;
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    // 只取雾位分量：格子可能是 Obstacle|Fog1 等组合掩码，
                    // 分组/揭示一律按雾类型（Fog1~Fog5）归属，避免组合掩码把雾区拆散
                    var fogType = cellGrid[x, y] & FogMask;
                    if (fogType == GridCellType.Empty)
                    {
                        continue;
                    }

                    // 地面网格 UV V=0 在 -Z 侧，与格子第 0 行同侧，行序无需翻转（列方向同理）
                    var index = y * width + x;
                    colors[index] = new Color(fogColor.r, fogColor.g, fogColor.b, 1f);

                    if (!cellsByType.TryGetValue(fogType, out var list))
                    {
                        list = new List<int>();
                        cellsByType[fogType] = list;
                    }

                    list.Add(index);
                }
            }

            fogState.SetPixels(colors);
            fogState.Apply();
        }

        private int CountFogCells()
        {
            var count = 0;
            foreach (var list in cellsByType.Values)
            {
                count += list.Count;
            }

            return count;
        }

        private void CreateBlurChain()
        {
            blurRTs = new RenderTexture[Mathf.Max(1, blurPasses)];
            for (int i = 0; i < blurRTs.Length; i++)
            {
                blurRTs[i] = new RenderTexture(width * 2, height * 2, 0, RenderTextureFormat.ARGB32);
                blurRTs[i].filterMode = FilterMode.Bilinear;
                blurRTs[i].wrapMode = TextureWrapMode.Clamp;
            }
        }

        private void CreateDisplayObject(float gridWidth, float gridHeight)
        {
            displayMaterial = new Material(Shader.Find("Unlit/Transparent"));

            var go = new GameObject("FogOverlay");
            go.transform.SetParent(transform, false);
            go.transform.localPosition = new Vector3(0, 0.2f, 0);
            // 战争雾平铺在 XZ 地面：不用内置 Quad（其原生朝向是 2D 的 XY 平面，需旋转），
            // 也不用内置 Plane（UV 方向有已知坑），改为代码生成的地面网格：
            // 法线朝上 +Y、无需旋转，UV 与格子行列一一对应（V=0 在 -Z 侧）。
            go.transform.localRotation = Quaternion.identity;
            go.transform.localScale = new Vector3(gridWidth, 1f, gridHeight);

            var meshFilter = go.AddComponent<MeshFilter>();
            meshFilter.mesh = CreateGroundMesh();

            var meshRenderer = go.AddComponent<MeshRenderer>();
            meshRenderer.material = displayMaterial;
            meshRenderer.sortingOrder = fogSortingOrder;
        }

        /// <summary>
        /// 生成 1×1 的 XZ 地面网格：法线朝上 +Y，UV(0,0) 在 (-0.5, 0, -0.5)（-Z 侧）。
        /// 缩放 (gridWidth, 1, gridHeight) 后与网格范围一致，纹理行/列与格子行列一一对应。
        /// </summary>
        private Mesh CreateGroundMesh()
        {
            groundMesh = new Mesh
            {
                name = "FogGroundPlane",
                vertices = new[]
                {
                    new Vector3(-0.5f, 0f, -0.5f), // uv (0,0)：-Z 侧，对应格子第 0 行
                    new Vector3(0.5f, 0f, -0.5f),  // uv (1,0)
                    new Vector3(-0.5f, 0f, 0.5f),  // uv (0,1)：+Z 侧
                    new Vector3(0.5f, 0f, 0.5f),   // uv (1,1)
                },
                uv = new[]
                {
                    new Vector2(0f, 0f),
                    new Vector2(1f, 0f),
                    new Vector2(0f, 1f),
                    new Vector2(1f, 1f),
                },
                triangles = new[] { 0, 2, 1, 1, 2, 3 } // 绕序保证法线朝 +Y
            };
            groundMesh.RecalculateNormals();
            groundMesh.RecalculateBounds();
            return groundMesh;
        }

        // ---------------------------------------------------------------- 每帧渲染

        /// <summary>单层雾 GPU 羽化（每帧从状态重算，剩余雾边缘始终光滑）。</summary>
        private void BlurFog()
        {
            if (fogState == null || blurRTs == null || blurRTs.Length == 0 || blurMaterial == null)
            {
                return;
            }

            Graphics.Blit(fogState, blurRTs[0], blurMaterial);
            for (int i = 1; i < blurRTs.Length; i++)
            {
                Graphics.Blit(blurRTs[i - 1], blurRTs[i], blurMaterial);
            }

            displayMaterial.mainTexture = blurRTs[blurRTs.Length - 1];
        }

        // ---------------------------------------------------------------- 玩家揭示

        private void TickPlayerReveal()
        {
            checkTimer -= Time.deltaTime;
            if (checkTimer > 0f)
            {
                return;
            }

            checkTimer = checkInterval;
            CheckPlayerFogArea();
        }

        private void CheckPlayerFogArea()
        {
            var players = Game.Instance != null && Game.Instance.CharacterManager != null
                ? Game.Instance.CharacterManager.Players
                : null;
            if (players == null)
            {
                return;
            }

            // 所有在场玩家都可揭示雾区（当前玩家之外，其余玩家的棋子走过同样清雾）
            for (int i = 0; i < players.Count; i++)
            {
                var type = GetPlayerGridType(players[i]);
                if (type == GridCellType.Empty || revealedAreas.Contains(type))
                {
                    continue;
                }

                revealedAreas.Add(type);
                ClearAreaCells(type);
                Debug.Log($"[FogOfWar] area {type} revealed (cleared)");
            }
        }

        private GridCellType GetPlayerGridType(BackendObject player)
        {
            if (gridMap == null || player == null)
            {
                return GridCellType.Empty;
            }

            var gridPos = gridMap.WorldToGrid(player.transform.position);
            // 只取雾位：与 cellsByType 的分组口径一致（Obstacle|Fog1 的格子按 Fog1 归属）
            return gridMap.GetCellType(gridPos) & FogMask;
        }

        // ---------------------------------------------------------------- 右键擦除

        private void HandleRightClickErase()
        {
            if (!allowRightClickErase || gridMap == null || fogState == null)
            {
                return;
            }

            // 输入统一经 InputManager 查询（右键按住 + 世界坐标；挂起时自动返回 false，与点击同一门控）
            var input = Game.Instance != null ? Game.Instance.InputManager : null;
            if (input == null || !input.TryGetRightMouseWorldPosition(out var worldPosition))
            {
                return;
            }

            // 世界坐标（网格平面）→ 格
            var gridPos = gridMap.WorldToGrid(worldPosition);
            var index = gridPos.y * width + gridPos.x;
            if (index < 0 || index >= width * height)
            {
                return;
            }

            ClearCell(index);
            BlurFog(); // 状态变化后重新羽化一次
        }

        // ---------------------------------------------------------------- 格子操作

        /// <summary>清除某区域的所有雾格子（批量写入，只上传一次 GPU）。</summary>
        private void ClearAreaCells(GridCellType type)
        {
            if (!cellsByType.TryGetValue(type, out var indices))
            {
                return;
            }

            var cleared = new Color(fogColor.r, fogColor.g, fogColor.b, 0f);
            for (int i = 0; i < indices.Count; i++)
            {
                fogState.SetPixel(indices[i] % width, indices[i] / width, cleared);
            }

            fogState.Apply(); // 只上传一次

            BlurFog(); // 状态变化后重新羽化一次
        }

        private void ClearCell(int index)
        {
            var color = fogState.GetPixel(index % width, index / width);
            if (color.a <= 0f)
            {
                return;
            }

            fogState.SetPixel(index % width, index / width, new Color(color.r, color.g, color.b, 0f));
            fogState.Apply();
        }
    }
}
