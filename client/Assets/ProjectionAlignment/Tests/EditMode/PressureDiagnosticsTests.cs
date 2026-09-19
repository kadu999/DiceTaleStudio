using NUnit.Framework;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class PressureDiagnosticsTests
    {
        private static PressureStreamSnapshot Snapshot(double time, int frames, int consumed = 0) => new PressureStreamSnapshot
        {
            Port = "test-port", ConnectionId = 10, Connected = true, Seconds = time,
            Parsed = frames, Delivered = frames, Consumed = consumed
        };

        [Test]
        public void OneHundredHzInputIsDistinctFromSixtyHzGameConsumption()
        {
            var rate = new PressureRateMeasurement(Snapshot(50, 500, 300));
            // Repeated UI reads cannot change a counter/time measurement.
            for (int i = 1; i <= 900; i++) rate.Observe(Snapshot(50 + i / 60.0, 500 + i * 100 / 60, 300 + i));
            Assert.That(rate.Hertz, Is.EqualTo(100).Within(0.001));
            Assert.That(rate.ConsumedHertz, Is.EqualTo(60).Within(0.001));
            Assert.That(rate.MeanPeriodMilliseconds, Is.EqualTo(10).Within(0.001));
            Assert.That(rate.Parsed, Is.EqualTo(1500));
        }

        [Test]
        public void CountsUseActualElapsedTimeAndIncludeIdleFrames()
        {
            var rate = new PressureRateMeasurement(Snapshot(0, 0));
            rate.Observe(Snapshot(15.2, 912));
            Assert.That(rate.Hertz, Is.EqualTo(60).Within(0.001));
            Assert.That(rate.Duration, Is.EqualTo(15.2));
        }

        [TestCase("disconnect")] [TestCase("reconnect")] [TestCase("reset")] [TestCase("swap")]
        public void ConnectionChangesInvalidateTheWholeMeasurement(string change)
        {
            var rate = new PressureRateMeasurement(Snapshot(10, 100));
            var end = Snapshot(11, 200);
            if (change == "disconnect") end.Connected = false;
            if (change == "reconnect") end.ConnectionId++;
            if (change == "reset") end.Parsed = 0;
            if (change == "swap") end.Port = "other-port";
            rate.Observe(end);
            rate.Observe(Snapshot(12, 300));
            Assert.That(rate.Valid, Is.False, "A later good frame must not hide a discontinuity.");
        }

        [Test]
        public void RepeatedHeldFramesCountOnceAndExtraEleventhPressIsVisible()
        {
            var counter = new PressurePressCounter(12, 5);
            counter.Observe(0, 0);
            for (int press = 0; press < 11; press++)
            {
                for (int frame = 0; frame < 50; frame++) counter.Observe(20, press + frame * .01);
                counter.Observe(0, press + .5);
            }
            Assert.That(counter.Presses, Is.EqualTo(11));
            Assert.That(counter.Releases, Is.EqualTo(11));
        }

        [Test]
        public void MustReleaseBeforeStartingAndHysteresisDoesNotInventPresses()
        {
            var counter = new PressurePressCounter(12, 5);
            counter.Observe(20, 0); counter.Observe(13, .1);
            Assert.That(counter.Presses, Is.Zero);
            counter.Observe(5, .2); counter.Observe(12, .3);
            counter.Observe(11, .4); counter.Observe(6, .5); counter.Observe(13, .6);
            Assert.That(counter.Presses, Is.EqualTo(1));
            counter.Observe(5, .7); counter.Observe(12, .8);
            Assert.That(counter.Presses, Is.EqualTo(2));
        }

        [Test]
        public void PressAndReleaseWithinOneRenderFrameRemainVisibleInDeliveredStream()
        {
            var delivered = new PressurePressCounter(12, 5);
            var latest = new PressurePressCounter(12, 5);
            delivered.Observe(0, 0); latest.Observe(0, 0);
            // A batched dispatcher can give identical timestamps; time debounce would hide this edge.
            delivered.Observe(20, .016); delivered.Observe(0, .016);
            latest.Observe(0, .016);
            Assert.That(delivered.Presses, Is.EqualTo(1));
            Assert.That(latest.Presses, Is.Zero);
        }

        [Test]
        public void StableHoldAndDropoutHaveDifferentResults()
        {
            var counter = new PressurePressCounter(12, 5);
            counter.Observe(0, 0); counter.Observe(20, 1); counter.Observe(20, 6); counter.Observe(0, 6.01);
            Assert.That(counter.Presses, Is.EqualTo(1));
            Assert.That(counter.Releases, Is.EqualTo(1));
            Assert.That(counter.LongestHoldSeconds, Is.EqualTo(5.01).Within(.001));
            counter.Observe(20, 6.02);
            Assert.That(counter.Presses, Is.EqualTo(2), "No debounce may conceal a dropout during the user's one hold.");
        }
    }
}
