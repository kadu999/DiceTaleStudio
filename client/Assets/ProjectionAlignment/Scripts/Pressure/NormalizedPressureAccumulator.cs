using System;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Aggregates pressure blobs that belong to the same logical board cell.
    /// A physical base can be split into several contacts, so a cell's force is their sum.
    ///
    /// Two readings come out of the same contacts and they are NOT interchangeable:
    /// <see cref="Add"/> clamps to the normalized 0..1 range gameplay presence rules expect,
    /// while <see cref="AddUnclamped"/> keeps the running total. Presence only ever asks
    /// "is anything on this cell", so the ceiling costs it nothing; a press-to-confirm test asks
    /// "is there MORE force than a moment ago", and the ceiling destroys exactly that signal —
    /// a resting miniature already reads ~0.94, so "baseline + 0.12" lands above a value the
    /// clamped reading can never reach and the press can never register.
    /// </summary>
    public static class NormalizedPressureAccumulator
    {
        public static float Add(float accumulated, float sample)
            => Math.Min(1f, AddUnclamped(accumulated, sample));

        /// <summary>Running total with no ceiling — for tests that compare a cell against itself.</summary>
        public static float AddUnclamped(float accumulated, float sample)
        {
            if (float.IsNaN(accumulated) || accumulated < 0f) accumulated = 0f;
            if (float.IsNaN(sample) || sample <= 0f) return accumulated;
            return accumulated + sample;
        }
    }
}
