using NuLight.ProjectionAlignment.Placement;
using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    /// <summary>
    /// The reusable square-grid surface is the piece of the generic placement layer that a new
    /// demo gets for free, so its world-point-to-cell mapping is worth pinning down: every cell
    /// must round-trip, and points off the board must be rejected rather than clamped.
    /// </summary>
    public sealed class GridPlacementSurfaceTests
    {
        GameObject _go;
        GridPlacementSurface _grid;

        [SetUp]
        public void SetUp()
        {
            _go = new GameObject("grid");
            _grid = _go.AddComponent<GridPlacementSurface>();
            _grid.Columns = 6;
            _grid.Rows = 4;
            _grid.CellSize = 0.5f;
            _grid.CenterOnTransform = true;
        }

        [TearDown]
        public void TearDown()
        {
            if (_go != null) Object.DestroyImmediate(_go);
        }

        [Test]
        public void EveryCellCentre_RoundTripsBackToItsOwnCell()
        {
            for (int column = 0; column < _grid.Columns; column++)
            for (int row = 0; row < _grid.Rows; row++)
            {
                var cell = new Vector2Int(column, row);
                Assert.IsTrue(_grid.TryGetCell(_grid.CellCenter(cell), out Vector2Int resolved));
                Assert.AreEqual(cell, resolved);
            }
        }

        [Test]
        public void PointsInsideACell_ResolveToThatCell()
        {
            var cell = new Vector2Int(2, 1);
            Vector3 centre = _grid.CellCenter(cell);
            float nearEdge = _grid.CellSize * 0.45f;

            Assert.IsTrue(_grid.TryGetCell(centre + new Vector3(nearEdge, 0f, -nearEdge), out Vector2Int a));
            Assert.AreEqual(cell, a);
            Assert.IsTrue(_grid.TryGetCell(centre + new Vector3(-nearEdge, 0f, nearEdge), out Vector2Int b));
            Assert.AreEqual(cell, b);
        }

        [Test]
        public void PointsOffTheBoard_AreRejected()
        {
            Vector3 outside = _grid.CellCenter(new Vector2Int(0, 0))
                              + new Vector3(-_grid.CellSize * 2f, 0f, 0f);
            Assert.IsFalse(_grid.TryGetCell(outside, out _));
            Assert.IsFalse(_grid.Contains(new Vector2Int(-1, 0)));
            Assert.IsFalse(_grid.Contains(new Vector2Int(0, _grid.Rows)));
        }

        [Test]
        public void MovedAndRotatedBoard_StillResolvesCells()
        {
            _go.transform.position = new Vector3(3.2f, 1.4f, -0.75f);
            _go.transform.rotation = Quaternion.Euler(0f, 37f, 0f);

            var cell = new Vector2Int(5, 3);
            Assert.IsTrue(_grid.TryGetCell(_grid.CellCenter(cell), out Vector2Int resolved));
            Assert.AreEqual(cell, resolved);
        }

        [Test]
        public void SurfaceY_IsTheBoardHeightPlusItsOffset()
        {
            _go.transform.position = new Vector3(0f, 2f, 0f);
            _grid.SurfaceHeightOffset = 0.25f;
            Assert.AreEqual(2.25f, _grid.SurfaceY, 1e-4f);
            Assert.AreEqual(2.25f, _grid.CellCenter(new Vector2Int(1, 1)).y, 1e-4f);
        }

        [Test]
        public void WithoutCentering_CellZeroSitsOnTheTransform()
        {
            _grid.CenterOnTransform = false;
            _go.transform.position = new Vector3(1f, 0f, -2f);

            Vector3 origin = _grid.CellCenter(new Vector2Int(0, 0));
            Assert.AreEqual(1f, origin.x, 1e-4f);
            Assert.AreEqual(-2f, origin.z, 1e-4f);
            Assert.IsTrue(_grid.TryGetCell(_go.transform.position, out Vector2Int cell));
            Assert.AreEqual(new Vector2Int(0, 0), cell);
        }
    }
}
