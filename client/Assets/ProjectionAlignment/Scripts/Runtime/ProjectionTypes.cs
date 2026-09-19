using System;
using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    public enum ProjectionContentMode
    {
        FullFrameWithInteractionRegion = 0,
        InteractionRegionOnlyDebug = 1
    }

    public enum SensorPointMode
    {
        EdgeToEdge = 0,
        CellCenter = 1
    }

    public enum ProjectionCalibrationState
    {
        Idle,
        CollectingPrimary,
        Solving,
        Validating,
        Ready,
        Failed
    }

    [Serializable]
    public struct CalibrationSample
    {
        public Vector2 projectorUv;
        public Vector2 boardUv;
        [Range(0.01f, 1f)] public float confidence;

        public CalibrationSample(Vector2 projectorUv, Vector2 boardUv, float confidence = 1f)
        {
            this.projectorUv = projectorUv;
            this.boardUv = boardUv;
            this.confidence = Mathf.Clamp(confidence, 0.01f, 1f);
        }
    }

    public readonly struct PressureContact
    {
        public readonly Vector2 rawPosition;
        public readonly float radius;
        public readonly float pressure;

        /// <summary>
        /// Which mat the contact landed on, counted left to right across the combined
        /// area — 0 is always the left mat, so it says nothing about which serial port
        /// the frame arrived on. Always 0 on a single-mat rig.
        /// </summary>
        public readonly int boardIndex;

        public PressureContact(Vector2 rawPosition, float radius, float pressure, int boardIndex = 0)
        {
            this.rawPosition = rawPosition;
            this.radius = radius;
            this.pressure = pressure;
            this.boardIndex = boardIndex;
        }
    }

    public readonly struct BoardContact
    {
        public readonly Vector2 boardUv;
        public readonly Vector2 rawPosition;
        public readonly float radius;
        public readonly float pressure;

        /// <summary>Which mat reported it, left to right. See <see cref="PressureContact.boardIndex"/>.</summary>
        public readonly int boardIndex;

        /// <summary>
        /// Pressure mapped to 0..1 by PressureInputRouter.pressureFullScale. The raw scale
        /// depends on firmware and must be confirmed on hardware; never divide by a constant.
        /// </summary>
        public readonly float normalizedPressure;

        /// <summary>
        /// The same division with no ceiling. Full scale is a display scale, not a limit: the
        /// analyser reports a smoothed peak cell value, and a resting miniature already sits
        /// near it (~0.94 at the shipped scale of 100), so anything asking "is this heavier
        /// than a moment ago" — press-to-confirm — reads a flat line off
        /// <see cref="normalizedPressure"/> no matter how hard the player pushes.
        /// Presence, UI alpha and touch pressure keep the clamped reading.
        /// </summary>
        public readonly float pressureRatio;

        public BoardContact(Vector2 boardUv, PressureContact source, float normalizedPressure)
        {
            this.boardUv = boardUv;
            rawPosition = source.rawPosition;
            radius = source.radius;
            pressure = source.pressure;
            boardIndex = source.boardIndex;
            pressureRatio = float.IsNaN(normalizedPressure) || normalizedPressure < 0f
                ? 0f
                : normalizedPressure;
            this.normalizedPressure = Mathf.Clamp01(normalizedPressure);
        }
    }

    public interface IPressureBoardSource
    {
        string SourceName { get; }
        bool IsReady { get; }
        Vector2Int SensorResolution { get; }

        /// <summary>
        /// How many mats this source is speaking for. The whole geometry hangs off it:
        /// the mats are tiled left to right, so the interactive area is this many squares
        /// wide and board UV is normalised over all of them.
        /// </summary>
        int BoardCount { get; }

        IReadOnlyList<PressureContact> Contacts { get; }
    }
}
