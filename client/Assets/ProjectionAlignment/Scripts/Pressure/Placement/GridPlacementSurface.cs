using UnityEngine;

namespace NuLight.ProjectionAlignment.Placement
{
    /// <summary>
    /// A ready-made <see cref="IPlacementSurface{TCell}"/> for the common case: a rectangular grid
    /// of square cells lying on this transform's local XZ plane. A game with its own board shape
    /// implements the interface on that board instead.
    /// </summary>
    [DisallowMultipleComponent]
    public class GridPlacementSurface : MonoBehaviour, IPlacementSurface<Vector2Int>
    {
        [Min(1)] public int Columns = 8;
        [Min(1)] public int Rows = 8;

        [Tooltip("Edge length of one cell in world units.")]
        [Min(1e-4f)] public float CellSize = 1f;

        [Tooltip("Cell (0,0) sits at this transform when off, and the grid is centred on it when on.")]
        public bool CenterOnTransform = true;

        [Tooltip("Height of the surface the miniatures stand on, relative to this transform.")]
        public float SurfaceHeightOffset;

        public float SurfaceY => transform.position.y + SurfaceHeightOffset;

        public bool TryGetCell(Vector3 worldPoint, out Vector2Int cell)
        {
            Vector3 local = transform.InverseTransformPoint(worldPoint);
            float size = Mathf.Max(1e-4f, CellSize);
            float x = local.x / size + (CenterOnTransform ? (Columns - 1) * 0.5f : 0f);
            float z = local.z / size + (CenterOnTransform ? (Rows - 1) * 0.5f : 0f);
            int column = Mathf.RoundToInt(x);
            int row = Mathf.RoundToInt(z);
            cell = new Vector2Int(column, row);
            return Contains(cell);
        }

        public bool Contains(Vector2Int cell)
            => cell.x >= 0 && cell.x < Columns && cell.y >= 0 && cell.y < Rows;

        /// <summary>World position of a cell's centre, on the playing surface.</summary>
        public Vector3 CellCenter(Vector2Int cell)
        {
            float size = Mathf.Max(1e-4f, CellSize);
            float x = (cell.x - (CenterOnTransform ? (Columns - 1) * 0.5f : 0f)) * size;
            float z = (cell.y - (CenterOnTransform ? (Rows - 1) * 0.5f : 0f)) * size;
            Vector3 world = transform.TransformPoint(new Vector3(x, 0f, z));
            world.y = SurfaceY;
            return world;
        }

        void OnDrawGizmosSelected()
        {
            Gizmos.color = new Color(0.2f, 0.9f, 1f, 0.35f);
            for (int column = 0; column < Columns; column++)
            for (int row = 0; row < Rows; row++)
                Gizmos.DrawWireCube(
                    CellCenter(new Vector2Int(column, row)),
                    new Vector3(CellSize, 0f, CellSize));
        }
    }
}
