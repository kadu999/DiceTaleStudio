using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    public static class ProjectionCoordinateMapper
    {
        /// <summary>
        /// Game UV is normalised over the 16:9 image, so a UV rect's physical aspect is
        /// (w * 16) / (h * 9): a physical square needs w = h * 9/16, and a physical 16:9
        /// rect needs w = h.
        /// </summary>
        public const float SquareWidthIn16By9 = 9f / 16f;

        /// <summary>
        /// How much of the frame height the pressure mat takes — the zoom knob.
        ///
        /// 0.75 is measured, not chosen: it is the value the rig settled on when the mat was
        /// calibrated against the real projector (2026-08-06, RMS 0.61 cells). It says the
        /// light spot is about 1/0.75 = 1.33x taller than the mat, so the game image is grown
        /// to fill that extra light instead of leaving it dark.
        ///
        /// The rule for any other rig is one line: this value ~ mat height / spot height.
        /// 1 is the no-waste end of the range — the image becomes the smallest 16:9 rectangle
        /// that still covers the square mat, with nothing above or below it. Going below that
        /// trades rendered pixels for coverage of a bigger spot; it does not protect the
        /// screen from being clipped by the projector's own frame, since that clipping happens
        /// in projector space and cuts the extra content and the screen alike.
        /// </summary>
        public const float MatHeightInFrame = 0.75f;

        /// <summary>One mat's physical edge length. Both edges — the mats are square.</summary>
        public const float MatEdgeCm = 50f;

        private const float MinimumRectSize = 0.001f;

        /// <summary>
        /// The interactive area's physical aspect (width / height) for a given number of mats
        /// and the dead strip between them.
        ///
        /// Mats are tiled left to right and each one is square, so without a seam the area is
        /// as many squares wide as there are mats. The seam is part of the area, not a gap in
        /// it: the projector lights that strip like everything else, it simply reads nothing.
        /// Leaving it out of the geometry is what makes one mat's content land a whole seam
        /// width off — the model would be claiming the two sensing grids are continuous when
        /// physically they are a bezel and a bit of air apart.
        ///
        /// Left to right rather than stacked because that is the only arrangement the spot
        /// can hold: at MatHeightInFrame 0.75 the spot is about 118 x 67 cm, which fits
        /// 100 x 50 and cannot fit 50 x 100.
        /// </summary>
        public static float MatAspectFor(int boardCount, float seamGapCm = 0f)
        {
            int mats = Mathf.Max(1, boardCount);
            float gap = Mathf.Max(0f, seamGapCm);
            return (mats * MatEdgeCm + (mats - 1) * gap) / MatEdgeCm;
        }

        /// <summary>The interactive area's physical width in cm, seams included.</summary>
        public static float AreaWidthCm(int boardCount, float seamGapCm = 0f)
        {
            int mats = Mathf.Max(1, boardCount);
            return mats * MatEdgeCm + (mats - 1) * Mathf.Max(0f, seamGapCm);
        }

        /// <summary>
        /// Where a seam sits along board UV's horizontal axis, as (start, end). Board UV is
        /// normalised over the whole area including the seams, so this is exactly the strip
        /// that reports nothing — the range a game must keep its tap targets out of.
        /// </summary>
        public static Vector2 SeamSpanInBoardUv(int seamIndex, int boardCount, float seamGapCm)
        {
            float width = AreaWidthCm(boardCount, seamGapCm);
            if (width <= 0f || boardCount < 2)
            {
                return new Vector2(0.5f, 0.5f);
            }

            float gap = Mathf.Max(0f, seamGapCm);
            float pitch = MatEdgeCm + gap;
            float start = (seamIndex + 1) * pitch - gap;
            return new Vector2(start / width, (start + gap) / width);
        }

        /// <summary>
        /// Re-expresses a board coordinate measured with one assumed seam width in terms of
        /// another. Used to test seam hypotheses against calibration samples without asking
        /// anyone to step on the mats again: the mat a sample landed on and where on that mat
        /// are both recoverable from the coordinate itself, and those are what actually got
        /// measured — the seam width is only how the two grids were stitched together.
        /// </summary>
        public static float ReexpressAcrossSeam(
            float boardUvX,
            int boardCount,
            float fromGapCm,
            float toGapCm,
            bool flipX)
        {
            int mats = Mathf.Max(1, boardCount);
            if (mats < 2)
            {
                return boardUvX;
            }

            float unflipped = flipX ? 1f - boardUvX : boardUvX;
            float fromWidth = AreaWidthCm(mats, fromGapCm);
            float fromPitch = MatEdgeCm + Mathf.Max(0f, fromGapCm);
            float x = Mathf.Clamp(unflipped, 0f, 1f) * fromWidth;
            int mat = Mathf.Clamp(Mathf.FloorToInt(x / fromPitch), 0, mats - 1);
            float local = Mathf.Clamp01((x - mat * fromPitch) / MatEdgeCm);

            float toWidth = AreaWidthCm(mats, toGapCm);
            float shifted = (mat * (MatEdgeCm + Mathf.Max(0f, toGapCm)) + local * MatEdgeCm) / toWidth;
            return flipX ? 1f - shifted : shifted;
        }

        /// <summary>The aspect an existing rect was built for — the inverse of the width formula.</summary>
        public static float MatAspectOf(Rect rect)
        {
            if (rect.height <= MinimumRectSize)
            {
                return 1f;
            }

            return rect.width / (rect.height * SquareWidthIn16By9);
        }

        /// <summary>How many mats a rect's shape implies. Rounded, so small drift does not change it.</summary>
        public static int BoardCountOf(Rect rect)
        {
            return Mathf.Max(1, Mathf.RoundToInt(MatAspectOf(rect)));
        }

        /// <summary>
        /// The tallest the mat area can be for a given aspect before it runs out of frame
        /// width. One mat can reach the full frame height; two run out at 8/9, where the
        /// 100 cm of mat exactly spans the frame.
        /// </summary>
        public static float MaximumMatHeightInFrame(float matAspect)
        {
            return Mathf.Min(1f, 1f / (SquareWidthIn16By9 * Mathf.Max(0.01f, matAspect)));
        }

        public static Rect DefaultInteractionRect => CenteredMatRect(MatHeightInFrame);

        public static Rect DefaultInteractionRectFor(int boardCount, float seamGapCm = 0f)
        {
            return CenteredMatRect(MatHeightInFrame, MatAspectFor(boardCount, seamGapCm));
        }

        /// <summary>
        /// The mat area, centred in the frame, at the given frame-height fraction. The mats
        /// are physically square, so the width follows from the height and how many of them
        /// there are; when that would overflow the frame the width becomes the binding
        /// constraint and the height is reduced to keep the shape honest.
        /// </summary>
        public static Rect CenteredMatRect(float heightInFrame, float matAspect = 1f)
        {
            float aspect = Mathf.Max(0.01f, matAspect);
            float height = Mathf.Clamp(heightInFrame, MinimumRectSize, MaximumMatHeightInFrame(aspect));
            float width = Mathf.Min(1f, height * SquareWidthIn16By9 * aspect);
            return new Rect(0.5f - width * 0.5f, 0.5f - height * 0.5f, width, height);
        }

        /// <summary>
        /// The mat rect grown by the same physical margin on both sides of each axis, as far as
        /// the frame allows: a side that would leave the frame pulls the opposite side in with
        /// it, so the result stays centred on the mat and a game framing its camera on the mat
        /// only has to scale, never shift. Returns the margin actually applied, in cm per side.
        /// </summary>
        public static Rect ExpandRectByMarginCm(
            Rect rect, Vector2 marginCm, int boardCount, float seamGapCm, out Vector2 appliedMarginCm)
        {
            float uvPerCmX = rect.width / AreaWidthCm(boardCount, seamGapCm);
            float uvPerCmY = rect.height / MatEdgeCm;
            float roomX = Mathf.Max(0f, Mathf.Min(rect.xMin, 1f - rect.xMax)) / Mathf.Max(1e-6f, uvPerCmX);
            float roomY = Mathf.Max(0f, Mathf.Min(rect.yMin, 1f - rect.yMax)) / Mathf.Max(1e-6f, uvPerCmY);
            appliedMarginCm = new Vector2(
                Mathf.Clamp(marginCm.x, 0f, roomX),
                Mathf.Clamp(marginCm.y, 0f, roomY));
            return Rect.MinMaxRect(
                rect.xMin - appliedMarginCm.x * uvPerCmX,
                rect.yMin - appliedMarginCm.y * uvPerCmY,
                rect.xMax + appliedMarginCm.x * uvPerCmX,
                rect.yMax + appliedMarginCm.y * uvPerCmY);
        }

        public static Matrix4x4 CreateProjectorToBoardPreviewMatrix(Rect interactionRect)
        {
            Rect rect = SanitizeInteractionRect(interactionRect);
            return HomographyUtility.FromCoefficients(
                1d / rect.width, 0d, -rect.x / rect.width,
                0d, 1d / rect.height, -rect.y / rect.height,
                0d, 0d, 1d);
        }

        public static Matrix4x4 CreateBoardToProjectorPreviewMatrix(Rect interactionRect)
        {
            Rect rect = SanitizeInteractionRect(interactionRect);
            return HomographyUtility.FromCoefficients(
                rect.width, 0d, rect.x,
                0d, rect.height, rect.y,
                0d, 0d, 1d);
        }

        public static Matrix4x4 CreateDefaultProjectorToBoardPreviewMatrix()
        {
            return CreateProjectorToBoardPreviewMatrix(DefaultInteractionRect);
        }

        public static Matrix4x4 CreateDefaultBoardToProjectorPreviewMatrix()
        {
            return CreateBoardToProjectorPreviewMatrix(DefaultInteractionRect);
        }

        public static Vector2 RawToBoardUv(
            Vector2 raw,
            Vector2Int sensorResolution,
            SensorPointMode pointMode,
            bool swapXY,
            bool flipX,
            bool flipY)
        {
            Vector2Int dimensions = sensorResolution;
            if (swapXY)
            {
                raw = new Vector2(raw.y, raw.x);
                dimensions = new Vector2Int(sensorResolution.y, sensorResolution.x);
            }

            float x;
            float y;
            if (pointMode == SensorPointMode.CellCenter)
            {
                x = (raw.x + 0.5f) / Mathf.Max(1, dimensions.x);
                y = (raw.y + 0.5f) / Mathf.Max(1, dimensions.y);
            }
            else
            {
                x = raw.x / Mathf.Max(1, dimensions.x - 1);
                y = raw.y / Mathf.Max(1, dimensions.y - 1);
            }

            if (flipX)
            {
                x = 1f - x;
            }

            if (flipY)
            {
                y = 1f - y;
            }

            return new Vector2(Mathf.Clamp01(x), Mathf.Clamp01(y));
        }

        public static Vector2 BoardToSourceUv(Vector2 boardUv, Rect interactionRect)
        {
            Rect rect = SanitizeInteractionRect(interactionRect);
            return new Vector2(
                rect.x + boardUv.x * rect.width,
                rect.y + boardUv.y * rect.height);
        }

        public static Vector2 SourceToBoardUv(Vector2 sourceUv, Rect interactionRect)
        {
            Rect rect = SanitizeInteractionRect(interactionRect);
            return new Vector2(
                (sourceUv.x - rect.x) / rect.width,
                (sourceUv.y - rect.y) / rect.height);
        }

        public static bool IsValidInteractionRect(Rect rect)
        {
            return rect.width >= MinimumRectSize
                && rect.height >= MinimumRectSize
                && rect.xMin >= 0f
                && rect.yMin >= 0f
                && rect.xMax <= 1f
                && rect.yMax <= 1f;
        }

        public static Rect SanitizeInteractionRect(Rect rect)
        {
            if (float.IsNaN(rect.x)
                || float.IsNaN(rect.y)
                || float.IsNaN(rect.width)
                || float.IsNaN(rect.height))
            {
                return DefaultInteractionRect;
            }

            float xMin = Mathf.Clamp01(Mathf.Min(rect.xMin, rect.xMax));
            float xMax = Mathf.Clamp01(Mathf.Max(rect.xMin, rect.xMax));
            float yMin = Mathf.Clamp01(Mathf.Min(rect.yMin, rect.yMax));
            float yMax = Mathf.Clamp01(Mathf.Max(rect.yMin, rect.yMax));
            if (xMax - xMin < MinimumRectSize || yMax - yMin < MinimumRectSize)
            {
                return DefaultInteractionRect;
            }

            return Rect.MinMaxRect(xMin, yMin, xMax, yMax);
        }

        public static bool IsInsideUnitSquare(Vector2 uv)
        {
            return uv.x >= 0f && uv.x <= 1f && uv.y >= 0f && uv.y <= 1f;
        }

        /// <summary>
        /// The swap/flip triple applied to normalised sensor coordinates. The eight
        /// combinations are exactly the eight symmetries of the square, so any
        /// rotation or mirroring of the mat relative to the projector can be
        /// expressed here — on the input side — instead of being baked into the
        /// homography where it would rotate the projected picture.
        /// </summary>
        public static Vector2 ApplyOrientation(Vector2 uv, bool swapXY, bool flipX, bool flipY)
        {
            if (swapXY)
            {
                uv = new Vector2(uv.y, uv.x);
            }

            if (flipX)
            {
                uv.x = 1f - uv.x;
            }

            if (flipY)
            {
                uv.y = 1f - uv.y;
            }

            return uv;
        }

        /// <summary>Undoes <see cref="ApplyOrientation"/>, reversing the operation order.</summary>
        public static Vector2 UnapplyOrientation(Vector2 uv, bool swapXY, bool flipX, bool flipY)
        {
            if (flipY)
            {
                uv.y = 1f - uv.y;
            }

            if (flipX)
            {
                uv.x = 1f - uv.x;
            }

            if (swapXY)
            {
                uv = new Vector2(uv.y, uv.x);
            }

            return uv;
        }

        /// <summary>
        /// Re-expresses a board coordinate measured under one orientation triple in
        /// terms of another, without needing the original raw sensor reading.
        /// </summary>
        public static Vector2 ReinterpretBoardUv(
            Vector2 boardUv,
            bool fromSwapXY, bool fromFlipX, bool fromFlipY,
            bool toSwapXY, bool toFlipX, bool toFlipY)
        {
            Vector2 normalisedRaw = UnapplyOrientation(boardUv, fromSwapXY, fromFlipX, fromFlipY);
            return ApplyOrientation(normalisedRaw, toSwapXY, toFlipX, toFlipY);
        }
    }
}
