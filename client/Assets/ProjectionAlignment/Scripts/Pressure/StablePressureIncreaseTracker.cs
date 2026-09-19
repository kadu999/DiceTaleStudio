using System;
using System.Collections.Generic;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Detects a deliberate pressure increase above a key's current resting baseline.
    /// A press must clear both an absolute floor and a relative delta for a continuous hold,
    /// then remains latched until released. The caller owns the clock for deterministic tests.
    ///
    /// Pressure here is a **cell force total with no ceiling**, not a 0..1 reading. The test is
    /// "this cell against itself a moment ago", so clamping the input at 1.0 silently kills it:
    /// a resting miniature sums to ~0.94, `baseline + 0.12` is then 1.06, and a clamped reading
    /// can never get there. <see cref="MinimumPressure"/> stays a 0..1 floor — it only rejects
    /// feather touches, it is never the binding threshold on an occupied cell.
    /// </summary>
    public sealed class StablePressureIncreaseTracker<TKey>
    {
        struct Entry
        {
            public float Baseline;
            public float LastSampleAt;
            public float CandidateSince;
            public bool Candidate;
            public bool Latched;
        }

        readonly Dictionary<TKey, Entry> _entries;

        public StablePressureIncreaseTracker(IEqualityComparer<TKey> comparer = null)
        {
            _entries = new Dictionary<TKey, Entry>(
                comparer ?? EqualityComparer<TKey>.Default);
        }

        public float RequiredIncrease { get; set; } = 0.12f;
        public float MinimumPressure { get; set; } = 0.20f;
        public float HoldSeconds { get; set; } = 0.12f;
        public float ResetRatio { get; set; } = 0.45f;
        public float BaselineRisePerSecond { get; set; } = 0.08f;
        public float BaselineFallPerSecond { get; set; } = 0.50f;

        public void Reset() => _entries.Clear();

        public void Remove(TKey key) => _entries.Remove(key);

        public void SetBaseline(TKey key, float pressure, float now)
        {
            _entries[key] = new Entry
            {
                Baseline = AtLeastZero(pressure),
                LastSampleAt = now,
                CandidateSince = now,
                Candidate = false,
                Latched = false
            };
        }

        public bool TryGetBaseline(TKey key, out float pressure)
        {
            if (_entries.TryGetValue(key, out Entry entry))
            {
                pressure = entry.Baseline;
                return true;
            }
            pressure = 0f;
            return false;
        }

        public void Sample(
            TKey key,
            float pressure,
            float now,
            Action<TKey, float, float> onConfirmed)
        {
            pressure = AtLeastZero(pressure);
            if (!_entries.TryGetValue(key, out Entry entry))
            {
                SetBaseline(key, pressure, now);
                return;
            }

            float required = Math.Max(0.001f, RequiredIncrease);
            float deltaTime = Math.Max(0f, now - entry.LastSampleAt);
            entry.LastSampleAt = now;

            if (entry.Latched)
            {
                float resetThreshold = entry.Baseline
                    + required * Clamp01(ResetRatio);
                if (pressure <= resetThreshold)
                {
                    entry.Latched = false;
                    entry.Candidate = false;
                    entry.Baseline = pressure;
                }
                _entries[key] = entry;
                return;
            }

            float trigger = Math.Max(Clamp01(MinimumPressure), entry.Baseline + required);
            if (pressure >= trigger)
            {
                if (!entry.Candidate)
                {
                    entry.Candidate = true;
                    entry.CandidateSince = now;
                }

                if (now - entry.CandidateSince + 1e-6f >= Math.Max(0f, HoldSeconds))
                {
                    entry.Latched = true;
                    entry.Candidate = false;
                    _entries[key] = entry;
                    onConfirmed?.Invoke(key, entry.Baseline, pressure);
                    return;
                }

                _entries[key] = entry;
                return;
            }

            entry.Candidate = false;
            float rate = pressure > entry.Baseline
                ? Math.Max(0f, BaselineRisePerSecond)
                : Math.Max(0f, BaselineFallPerSecond);
            entry.Baseline = MoveTowards(entry.Baseline, pressure, rate * deltaTime);
            _entries[key] = entry;
        }

        static float Clamp01(float value)
            => value < 0f ? 0f : value > 1f ? 1f : value;

        /// <summary>Force totals have no upper bound — only NaN and negatives are nonsense.</summary>
        static float AtLeastZero(float value)
            => float.IsNaN(value) || value < 0f ? 0f : value;

        static float MoveTowards(float current, float target, float maxDelta)
        {
            if (Math.Abs(target - current) <= maxDelta) return target;
            return current + Math.Sign(target - current) * maxDelta;
        }
    }
}
