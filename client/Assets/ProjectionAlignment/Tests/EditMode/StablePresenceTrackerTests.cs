using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class StablePresenceTrackerTests
    {
        StablePresenceTracker<int> _tracker;
        readonly HashSet<int> _sample = new HashSet<int>();
        readonly List<int> _placed = new List<int>();
        readonly List<int> _lifted = new List<int>();

        [SetUp]
        public void SetUp()
        {
            _tracker = new StablePresenceTracker<int>(0.5f);
            _sample.Clear();
            _placed.Clear();
            _lifted.Clear();
        }

        void Sample(float time)
            => _tracker.Sample(_sample, time, (key, _) => _placed.Add(key), key => _lifted.Add(key));

        [Test]
        public void ContactShorterThanHalfSecond_ProducesNoEdges()
        {
            _sample.Add(7);
            Sample(0f);
            Sample(0.49f);
            _sample.Clear();
            Sample(0.50f);

            CollectionAssert.IsEmpty(_placed);
            CollectionAssert.IsEmpty(_lifted);
        }

        [Test]
        public void StableContact_EmitsPlaceOnce_ThenLiftOnce()
        {
            _sample.Add(7);
            Sample(1f);
            Sample(1.5f);
            Sample(8f);
            _sample.Clear();
            Sample(8.01f);
            Sample(9f);

            CollectionAssert.AreEqual(new[] { 7 }, _placed);
            CollectionAssert.AreEqual(new[] { 7 }, _lifted);
        }

        [Test]
        public void ReappearingContact_MustConfirmAgain()
        {
            _sample.Add(3);
            Sample(0f);
            Sample(0.5f);
            _sample.Clear();
            Sample(0.6f);
            _sample.Add(3);
            Sample(0.7f);
            Sample(1.19f);
            Sample(1.2f);

            CollectionAssert.AreEqual(new[] { 3, 3 }, _placed);
            CollectionAssert.AreEqual(new[] { 3 }, _lifted);
        }

        [Test]
        public void MultipleKeys_KeepIndependentTimers()
        {
            _sample.Add(1);
            Sample(0f);
            _sample.Add(2);
            Sample(0.3f);
            Sample(0.5f);
            Sample(0.8f);

            CollectionAssert.AreEqual(new[] { 1, 2 }, _placed);
        }
    }

    public sealed class StablePressureIncreaseTrackerTests
    {
        StablePressureIncreaseTracker<int> _tracker;
        readonly List<int> _confirmed = new List<int>();

        [SetUp]
        public void SetUp()
        {
            _tracker = new StablePressureIncreaseTracker<int>
            {
                RequiredIncrease = 0.22f,
                MinimumPressure = 0.55f,
                HoldSeconds = 0.12f,
                ResetRatio = 0.45f,
                BaselineRisePerSecond = 0.08f,
                BaselineFallPerSecond = 0.50f
            };
            _confirmed.Clear();
            _tracker.SetBaseline(7, 0.30f, 0f);
        }

        void Sample(float pressure, float time)
            => _tracker.Sample(7, pressure, time, (key, _, __) => _confirmed.Add(key));

        [Test]
        public void ShortSpike_DoesNotConfirm()
        {
            Sample(0.62f, 0.01f);
            Sample(0.31f, 0.08f);
            CollectionAssert.IsEmpty(_confirmed);
        }

        [Test]
        public void DeliberateIncrease_HeldLongEnough_ConfirmsOnce()
        {
            Sample(0.60f, 0.01f);
            Sample(0.61f, 0.12f);
            Sample(0.62f, 0.14f);
            Sample(0.70f, 0.50f);
            CollectionAssert.AreEqual(new[] { 7 }, _confirmed);
        }

        [Test]
        public void Confirmation_RearmsOnlyAfterPressureRelease()
        {
            Sample(0.60f, 0.01f);
            Sample(0.60f, 0.14f);
            Sample(0.70f, 0.30f);
            Sample(0.32f, 0.40f);
            Sample(0.60f, 0.41f);
            Sample(0.60f, 0.54f);
            CollectionAssert.AreEqual(new[] { 7, 7 }, _confirmed);
        }

        [Test]
        public void RelativeDeltaAndAbsoluteFloor_MustBothBeCleared()
        {
            Sample(0.53f, 0.01f); // baseline + delta, but below 0.55 absolute floor
            Sample(0.54f, 0.20f);
            CollectionAssert.IsEmpty(_confirmed);
        }

        [Test]
        public void ProductDefaults_ConfirmAReachableHeldPress()
        {
            var tracker = new StablePressureIncreaseTracker<int>();
            bool confirmed = false;
            tracker.SetBaseline(7, 0.08f, 0f);

            tracker.Sample(7, 0.20f, 0.01f, (_, __, ___) => confirmed = true);
            tracker.Sample(7, 0.20f, 0.14f, (_, __, ___) => confirmed = true);

            Assert.That(confirmed, Is.True);
        }
    }

    public sealed class NormalizedPressureAccumulatorTests
    {
        [Test]
        public void ContactsOnSameCell_AreSummed()
        {
            float pressure = NormalizedPressureAccumulator.Add(0f, 0.24f);
            pressure = NormalizedPressureAccumulator.Add(pressure, 0.18f);

            Assert.That(pressure, Is.EqualTo(0.42f).Within(0.0001f));
        }

        /// <summary>
        /// The press-to-confirm gesture compares a cell against itself, so the reading it uses
        /// must survive above full scale. A miniature makes one peak contact that already reads
        /// near 1.0 at rest; if the contact itself were clamped, "baseline + required increase"
        /// would sit above anything the sensor can ever report and pressing could never confirm.
        /// </summary>
        [Test]
        public void ContactAboveFullScale_KeepsRatioWhileNormalizedClamps()
        {
            var source = new PressureContact(new Vector2(10f, 10f), 3f, 240f);
            var contact = new BoardContact(new Vector2(0.1f, 0.1f), source, 2.4f);

            Assert.That(contact.normalizedPressure, Is.EqualTo(1f));
            Assert.That(contact.pressureRatio, Is.EqualTo(2.4f).Within(0.0001f));
        }

        [Test]
        public void SummedPressure_IsClampedToNormalizedRange()
        {
            float pressure = NormalizedPressureAccumulator.Add(0.72f, 0.61f);

            Assert.That(pressure, Is.EqualTo(1f));
        }
    }
}
