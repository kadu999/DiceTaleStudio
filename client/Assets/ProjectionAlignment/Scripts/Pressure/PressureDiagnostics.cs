using System;

namespace NuLight.ProjectionAlignment
{
    /// <summary>Cumulative counters for one port/connection, never combined across mats.</summary>
    public struct PressureStreamSnapshot
    {
        public string Port;
        public long ConnectionId;
        public double Seconds;
        public bool Connected, ChecksumEnabled;
        public int BitsPerSample, FrameBytes, BaudRate, Parsed, Delivered, Consumed, Superseded, Dropped, Bad, Queued;
        public double RecentHz, QueueMilliseconds;
    }

    /// <summary>A count difference over wall time; independent of rendering and GUI reads.</summary>
    public sealed class PressureRateMeasurement
    {
        private readonly PressureStreamSnapshot start;
        public PressureStreamSnapshot End { get; private set; }
        public bool Valid { get; private set; } = true;
        public double Duration => Math.Max(0, End.Seconds - start.Seconds);
        public int Parsed => End.Parsed - start.Parsed;
        public int Delivered => End.Delivered - start.Delivered;
        public int Consumed => End.Consumed - start.Consumed;
        public int Superseded => End.Superseded - start.Superseded;
        public int Dropped => End.Dropped - start.Dropped;
        public int Bad => End.Bad - start.Bad;
        public double Hertz => Duration > 0 ? Parsed / Duration : 0;
        public double ConsumedHertz => Duration > 0 ? Consumed / Duration : 0;
        public double MeanPeriodMilliseconds => Hertz > 0 ? 1000 / Hertz : 0;

        public PressureRateMeasurement(PressureStreamSnapshot start) { this.start = End = start; }

        public void Observe(PressureStreamSnapshot next)
        {
            Valid &= next.Connected && next.Port == start.Port && next.ConnectionId == start.ConnectionId
                && next.Seconds >= End.Seconds && next.Parsed >= End.Parsed
                && next.Delivered >= End.Delivered && next.Consumed >= End.Consumed;
            End = next;
        }
    }

    /// <summary>One full release arms the first press. Hysteresis, without a time debounce that hides fast taps.</summary>
    public sealed class PressurePressCounter
    {
        public float PressThreshold { get; }
        public float ReleaseThreshold { get; }
        public int Presses { get; private set; }
        public int Releases { get; private set; }
        public bool Armed { get; private set; }
        public bool Held { get; private set; }
        public float Peak { get; private set; }
        public double LongestHoldSeconds { get; private set; }
        private double holdStart;

        public PressurePressCounter(float pressThreshold, float releaseThreshold)
        {
            if (float.IsNaN(pressThreshold) || float.IsInfinity(pressThreshold) || pressThreshold <= 0
                || float.IsNaN(releaseThreshold) || releaseThreshold < 0 || releaseThreshold >= pressThreshold)
                throw new ArgumentOutOfRangeException(nameof(pressThreshold));
            PressThreshold = pressThreshold; ReleaseThreshold = releaseThreshold;
        }

        public void Observe(float pressure, double seconds)
        {
            Peak = Math.Max(Peak, pressure);
            if (Held)
            {
                LongestHoldSeconds = Math.Max(LongestHoldSeconds, seconds - holdStart);
                if (pressure <= ReleaseThreshold) { Held = false; Releases++; }
            }
            else if (pressure <= ReleaseThreshold) Armed = true;
            else if (Armed && pressure >= PressThreshold)
            {
                Held = true; Presses++; holdStart = seconds;
            }
        }
    }
}
