using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Placement
{
    /// <summary>
    /// Drop-in physical-piece tracking for a demo that has no rules layer of its own: register the
    /// transforms that have a real miniature standing on them, and subscribe to
    /// <c>PiecePlaced</c> / <c>PieceLifted</c>. Cells come from a <see cref="GridPlacementSurface"/>.
    ///
    /// A game with its own board and pieces skips this class and declares its own one-line
    /// subclass of <see cref="PiecePlacementTracker{TPiece,TCell}"/> instead.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-55)] // PressureInputRouter=-60, virtual Touchscreen=-50.
    public sealed class GridPiecePlacementTracker
        : PiecePlacementTracker<Transform, Vector2Int>, IPlacementPieceSource<Transform, Vector2Int>
    {
        [Header("Board")]
        [Tooltip("Empty = the surface on this object, otherwise the first one in the scene.")]
        public GridPlacementSurface Grid;

        [Tooltip("Read each registered piece's cell from its world position every frame.")]
        public bool DeriveCellsFromTransforms = true;

        [Tooltip("Turn off while the demo cannot accept sensor truth (menus, calibration).")]
        public bool InputAllowed = true;

        readonly List<Transform> _registered = new List<Transform>(16);
        readonly Dictionary<Transform, Vector2Int> _declaredCells =
            new Dictionary<Transform, Vector2Int>();

        GridPlacementSurface _boundGrid;

        public IReadOnlyList<Transform> RegisteredPieces => _registered;

        bool IPlacementPieceSource<Transform, Vector2Int>.PlacementInputAllowed => InputAllowed;

        /// <summary>
        /// Points the tracker at a board that was chosen after this component was added.
        /// Assigning <see cref="Grid"/> alone only takes effect if the tracker has not bound yet,
        /// which is never true for a component added by script.
        /// </summary>
        public void SetGrid(GridPlacementSurface grid)
        {
            Grid = grid;
            AutoBind();
        }

        public void RegisterPiece(Transform piece)
        {
            if (piece == null || _registered.Contains(piece)) return;
            _registered.Add(piece);
        }

        /// <summary>Registers a piece and states which cell the demo's own logic puts it on.</summary>
        public void RegisterPiece(Transform piece, Vector2Int cell)
        {
            RegisterPiece(piece);
            SetPieceCell(piece, cell);
        }

        public void SetPieceCell(Transform piece, Vector2Int cell)
        {
            if (piece == null) return;
            _declaredCells[piece] = cell;
        }

        public void UnregisterPiece(Transform piece)
        {
            if (piece == null) return;
            _registered.Remove(piece);
            _declaredCells.Remove(piece);
        }

        public void ClearPieces()
        {
            _registered.Clear();
            _declaredCells.Clear();
        }

        void Awake() => AutoBind();

        protected override void OnEnable()
        {
            AutoBind();
            base.OnEnable();
        }

        void AutoBind()
        {
            if (Grid == null) Grid = GetComponent<GridPlacementSurface>();
            if (Grid == null) Grid = FindFirstObjectByType<GridPlacementSurface>();
            if (Grid == null || ReferenceEquals(_boundGrid, Grid)) return;
            Bind(this, Grid);
            _boundGrid = Grid;
        }

        void IPlacementPieceSource<Transform, Vector2Int>.CollectPlacementPieces(
            List<PiecePlacementBinding<Transform, Vector2Int>> into)
        {
            into.Clear();
            for (int i = _registered.Count - 1; i >= 0; i--)
            {
                Transform piece = _registered[i];
                if (piece == null)
                {
                    _registered.RemoveAt(i);
                    continue;
                }

                if (!TryResolvePieceCell(piece, out Vector2Int cell)) continue;
                into.Add(new PiecePlacementBinding<Transform, Vector2Int>(piece, cell));
            }
        }

        bool TryResolvePieceCell(Transform piece, out Vector2Int cell)
        {
            if (DeriveCellsFromTransforms && Grid != null
                && Grid.TryGetCell(piece.position, out cell)) return true;
            return _declaredCells.TryGetValue(piece, out cell);
        }
    }
}
