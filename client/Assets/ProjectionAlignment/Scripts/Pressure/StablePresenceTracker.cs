using System;
using System.Collections.Generic;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Debounces a set of keys into stable present / absent edges. The caller owns the clock so
    /// this can use unscaled Unity time in play mode and deterministic values in EditMode tests.
    /// </summary>
    public sealed class StablePresenceTracker<TKey>
    {
        struct Entry
        {
            public float FirstSeenAt;
            public bool Stable;
        }

        readonly Dictionary<TKey, Entry> _entries;
        readonly HashSet<TKey> _sample = new HashSet<TKey>();
        readonly List<TKey> _keys = new List<TKey>();

        public StablePresenceTracker(float confirmationSeconds, IEqualityComparer<TKey> comparer = null)
        {
            ConfirmationSeconds = Math.Max(0f, confirmationSeconds);
            _entries = new Dictionary<TKey, Entry>(comparer ?? EqualityComparer<TKey>.Default);
        }

        public float ConfirmationSeconds { get; set; }

        public bool IsStable(TKey key)
            => _entries.TryGetValue(key, out Entry entry) && entry.Stable;

        public void Reset() => _entries.Clear();

        /// <summary>
        /// Samples all keys that are present now. A key emits <paramref name="onBecamePresent"/>
        /// once after the confirmation interval, and <paramref name="onBecameAbsent"/> only if
        /// it had reached that stable state before disappearing.
        /// </summary>
        public void Sample(
            IEnumerable<TKey> presentKeys,
            float now,
            Action<TKey, float> onBecamePresent,
            Action<TKey> onBecameAbsent)
        {
            _sample.Clear();
            if (presentKeys != null)
            {
                foreach (TKey key in presentKeys)
                {
                    if (!_sample.Add(key)) continue;
                    if (!_entries.TryGetValue(key, out Entry entry))
                    {
                        _entries.Add(key, new Entry { FirstSeenAt = now, Stable = false });
                        continue;
                    }

                    if (entry.Stable) continue;
                    if (now < entry.FirstSeenAt) entry.FirstSeenAt = now;
                    float elapsed = now - entry.FirstSeenAt;
                    if (elapsed + 1e-6f < Math.Max(0f, ConfirmationSeconds))
                    {
                        _entries[key] = entry;
                        continue;
                    }

                    entry.Stable = true;
                    _entries[key] = entry;
                    onBecamePresent?.Invoke(key, elapsed);
                }
            }

            _keys.Clear();
            foreach (TKey key in _entries.Keys) _keys.Add(key);
            for (int i = 0; i < _keys.Count; i++)
            {
                TKey key = _keys[i];
                if (_sample.Contains(key)) continue;
                Entry entry = _entries[key];
                _entries.Remove(key);
                if (entry.Stable) onBecameAbsent?.Invoke(key);
            }
        }
    }
}
