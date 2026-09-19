using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Placement
{
    /// <summary>
    /// Where a piece sits according to the game's own rules, which is what the tracker uses to
    /// decide who owns a freshly confirmed cell. It is never derived from pressure: sensor truth
    /// and rule truth stay separate by construction.
    /// </summary>
    public readonly struct PiecePlacementBinding<TPiece, TCell> where TPiece : class
    {
        public readonly TPiece Piece;
        public readonly TCell Cell;

        public PiecePlacementBinding(TPiece piece, TCell cell)
        {
            Piece = piece;
            Cell = cell;
        }
    }

    /// <summary>A physical miniature became stably present on, or disappeared from, one cell.</summary>
    public readonly struct PiecePlacementEvent<TPiece, TCell> where TPiece : class
    {
        public readonly TPiece Piece;
        public readonly TCell Cell;

        /// <summary>Continuous pressure time behind a placement; zero for a lift.</summary>
        public readonly float StableDuration;
        public readonly float Timestamp;

        /// <summary>
        /// True when the placement only restates what was already on the board (game start,
        /// input resumed after calibration, hardware reconnected). Gameplay must never treat a
        /// resync as a fresh confirmation by the player.
        /// </summary>
        public readonly bool IsResync;

        public PiecePlacementEvent(
            TPiece piece,
            TCell cell,
            float stableDuration,
            float timestamp,
            bool isResync)
        {
            Piece = piece;
            Cell = cell;
            StableDuration = stableDuration;
            Timestamp = timestamp;
            IsResync = isResync;
        }
    }

    /// <summary>A placed piece was deliberately pressed down harder than its resting weight.</summary>
    public readonly struct PiecePressureEvent<TPiece, TCell> where TPiece : class
    {
        public readonly TPiece Piece;
        public readonly TCell Cell;
        public readonly float BaselinePressure;
        public readonly float ConfirmedPressure;
        public readonly float Timestamp;

        public PiecePressureEvent(
            TPiece piece,
            TCell cell,
            float baselinePressure,
            float confirmedPressure,
            float timestamp)
        {
            Piece = piece;
            Cell = cell;
            BaselinePressure = baselinePressure;
            ConfirmedPressure = confirmedPressure;
            Timestamp = timestamp;
        }
    }

    /// <summary>
    /// The board half of the contract: where the playing surface is in world space, and which
    /// cell a world point lands on. Implement it on whatever already owns the grid (a hex board,
    /// a square grid, a set of pads); the tracker never assumes a cell shape.
    /// </summary>
    public interface IPlacementSurface<TCell>
    {
        /// <summary>World-space height of the surface the miniatures stand on.</summary>
        float SurfaceY { get; }

        /// <summary>False for points outside the playable area; the contact is then ignored.</summary>
        bool TryGetCell(Vector3 worldPoint, out TCell cell);
    }

    /// <summary>
    /// The game half of the contract: which pieces are on the board right now and where the
    /// rules say each of them stands. Called every frame, so fill the buffer instead of
    /// allocating a new list.
    /// </summary>
    public interface IPlacementPieceSource<TPiece, TCell> where TPiece : class
    {
        /// <summary>
        /// False while the game cannot accept sensor truth at all (calibration overlay raised,
        /// game unloading, input suspended). The tracker then drops to Unknown without
        /// broadcasting a board-wide fake lift.
        /// </summary>
        bool PlacementInputAllowed { get; }

        void CollectPlacementPieces(List<PiecePlacementBinding<TPiece, TCell>> into);
    }
}
