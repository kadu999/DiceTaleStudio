using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Sub-cell position of a contact. The vendor analyser reports the peak of the smoothed
    /// frame as whole cells, so every reading carries up to half a cell (2.5 mm) of
    /// quantisation and a held finger steps between neighbouring cells; calibration then
    /// solves against those steps. The pressure-weighted centroid of the raw cells around the
    /// peak recovers the fraction.
    /// </summary>
    public static class ContactRefinement
    {
        /// <summary>Cells either side of the peak that take part — a fingertip is 3–4 cells wide, a piece base 5.</summary>
        public const int Radius = 2;

        /// <summary>
        /// Cells below this fraction of the strongest cell in the window are left out, so the
        /// background and the tail of a neighbouring contact do not pull the centroid.
        /// </summary>
        public const float FloorFraction = 0.3f;

        /// <summary>
        /// The centroid of the cells around (row, column) in a row-major frame, as (row, column)
        /// in cells. The window is symmetric about the peak on each axis and shrinks where the
        /// frame ends, so a contact near the border is not dragged inward by cells that are
        /// missing on one side only. The result stays within one cell of the peak.
        /// </summary>
        public static Vector2 Refine(int[] frame, int rows, int columns, int row, int column)
        {
            if (frame == null || rows <= 0 || columns <= 0 || frame.Length < rows * columns
                || row < 0 || row >= rows || column < 0 || column >= columns)
            {
                return new Vector2(row, column);
            }

            int rowReach = Mathf.Min(Radius, Mathf.Min(row, rows - 1 - row));
            int columnReach = Mathf.Min(Radius, Mathf.Min(column, columns - 1 - column));

            int strongest = 0;
            for (int dr = -rowReach; dr <= rowReach; dr++)
            {
                for (int dc = -columnReach; dc <= columnReach; dc++)
                {
                    strongest = Mathf.Max(strongest, frame[(row + dr) * columns + column + dc]);
                }
            }

            if (strongest <= 0)
            {
                return new Vector2(row, column);
            }

            float floor = strongest * FloorFraction;
            double weight = 0.0;
            double sumRow = 0.0;
            double sumColumn = 0.0;
            for (int dr = -rowReach; dr <= rowReach; dr++)
            {
                for (int dc = -columnReach; dc <= columnReach; dc++)
                {
                    float value = frame[(row + dr) * columns + column + dc] - floor;
                    if (value <= 0f)
                    {
                        continue;
                    }

                    weight += value;
                    sumRow += value * (row + dr);
                    sumColumn += value * (column + dc);
                }
            }

            if (weight <= 0.0)
            {
                return new Vector2(row, column);
            }

            return new Vector2(
                Mathf.Clamp((float)(sumRow / weight), row - 1f, row + 1f),
                Mathf.Clamp((float)(sumColumn / weight), column - 1f, column + 1f));
        }
    }
}
