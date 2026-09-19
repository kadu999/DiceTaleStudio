using System;
using System.Diagnostics;

namespace NuLight.ProjectionAlignment
{
    /// <summary>A serial handle is only a candidate. Two decoded sensor frames confirm a mat, including all-zero idle frames.</summary>
    public sealed class PressureBoardConnectionState
    {
        public const double FrameTimeoutSeconds = 3;
        private readonly object gate = new object();
        private readonly int rows, columns;
        private long lastFrameTicks;
        private int validFrames;

        public PressureBoardConnectionState(int rows, int columns)
        {
            if (rows < 1 || columns < 1) throw new ArgumentOutOfRangeException();
            this.rows = rows; this.columns = columns;
        }

        public bool ObserveDecodedFrame(int[] data, int frameRows, int frameColumns, long now)
        {
            if (data == null || frameRows != rows || frameColumns != columns || data.Length != (long)rows * columns)
                return false;
            lock (gate)
            {
                if (now < lastFrameTicks || (now - lastFrameTicks) / (double)Stopwatch.Frequency > FrameTimeoutSeconds)
                    validFrames = 0;
                lastFrameTicks = now;
                validFrames = Math.Min(2, validFrames + 1);
                return true;
            }
        }

        public bool IsConnected(bool portOpen, long now)
        {
            lock (gate)
                return portOpen && validFrames >= 2 && now >= lastFrameTicks &&
                    (now - lastFrameTicks) / (double)Stopwatch.Frequency <= FrameTimeoutSeconds;
        }
    }
}
