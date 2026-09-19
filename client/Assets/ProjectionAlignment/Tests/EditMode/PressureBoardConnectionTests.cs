using System.Diagnostics;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class PressureBoardConnectionTests
    {
        [Test]
        public void OpenPortAloneAndOneFrameDoNotConfirmHardware()
        {
            var connection = new PressureBoardConnectionState(100, 100);
            long now = Stopwatch.GetTimestamp();
            Assert.That(connection.IsConnected(true, now), Is.False);
            Assert.That(connection.ObserveDecodedFrame(new int[10000], 100, 100, now), Is.True);
            Assert.That(connection.IsConnected(true, now), Is.False);
        }

        [Test]
        public void TwoIdleFramesConfirmHardwareWithoutRequiringPressure()
        {
            var connection = new PressureBoardConnectionState(100, 100);
            long now = Stopwatch.GetTimestamp();
            connection.ObserveDecodedFrame(new int[10000], 100, 100, now);
            connection.ObserveDecodedFrame(new int[10000], 100, 100, now + 1);
            Assert.That(connection.IsConnected(true, now + 1), Is.True);
            Assert.That(connection.IsConnected(false, now + 1), Is.False);
            Assert.That(connection.IsConnected(true, now + 4 * Stopwatch.Frequency), Is.False);
            connection.ObserveDecodedFrame(new int[10000], 100, 100, now + 4 * Stopwatch.Frequency);
            Assert.That(connection.IsConnected(true, now + 4 * Stopwatch.Frequency), Is.False, "Stale connections need fresh confirmation.");
        }

        [Test]
        public void WrongSizeOrDimensionsCannotConfirmAPressureBoard()
        {
            var connection = new PressureBoardConnectionState(100, 100);
            long now = Stopwatch.GetTimestamp();
            Assert.That(connection.ObserveDecodedFrame(new int[10000], 200, 50, now), Is.False);
            Assert.That(connection.ObserveDecodedFrame(new int[10], 100, 100, now), Is.False);
            Assert.That(connection.ObserveDecodedFrame(null, 100, 100, now), Is.False);
            Assert.That(connection.IsConnected(true, now), Is.False);
        }

        [Test]
        public void SimulationLayoutDoesNotReportHardwareOrOverwriteSavedGeometry()
        {
            var root = new GameObject("Pressure connection regression"); root.SetActive(false);
            try
            {
                var hardware = root.AddComponent<DevicePipePressureSource>();
                var simulator = root.AddComponent<MousePressureSource>();
                var router = root.AddComponent<PressureInputRouter>(); router.Configure(hardware, simulator);
                Assert.That(router.BoardCount, Is.EqualTo(1), "Simulation still needs usable geometry.");
                Assert.That(router.ConnectedBoardCount, Is.Zero);
                Assert.That(router.HasConnectedHardware, Is.False);
                Assert.That(hardware.IsReady, Is.False);
                var alignment = root.AddComponent<ProjectionAlignmentController>();
                alignment.SetMatLayout(2, 2);
                var calibration = root.AddComponent<ProjectionCalibrationController>();
                var flags = BindingFlags.Instance | BindingFlags.NonPublic;
                typeof(ProjectionCalibrationController).GetField("alignment", flags).SetValue(calibration, alignment);
                typeof(ProjectionCalibrationController).GetField("pressureInput", flags).SetValue(calibration, router);
                typeof(ProjectionCalibrationController).GetField("appliedBoardCount", flags).SetValue(calibration, 2);
                typeof(ProjectionCalibrationController).GetMethod("SyncBoardLayout", flags).Invoke(calibration, null);
                Assert.That(alignment.BoardCount, Is.EqualTo(2), "The simulator must not masquerade as a newly connected single mat.");
            }
            finally { Object.DestroyImmediate(root); }
        }
    }
}
