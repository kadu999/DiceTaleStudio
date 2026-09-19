using System.Collections.Generic;
using System.Reflection;
using System.Text.RegularExpressions;
using NUnit.Framework;
using NuLight.ProjectionAlignment;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.TestTools;

namespace DiceTale.Editor.Tests
{
    // Start at router contacts, then exercise the real virtual touchscreen and Input System.
    // Serial hardware is intentionally not opened by these EditMode regressions.
    public class DevicePipeInputSourceTests
    {
        private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
        private GameObject root;
        private Camera pointerCamera;
        private RenderTexture texture;
        private ProjectionAlignmentController alignment;
        private ProjectionVirtualTouchscreen touchscreen;
        private PressureInputRouter router;
        private InputSource source;
        private readonly InputFrame frame = new InputFrame();
        private Touchscreen otherTouchscreen;
        private Touchscreen previousTouchscreen;
        private InputSettings.UpdateMode previousUpdateMode;
        private object inputSystemManager;
        private bool previousRunPlayerUpdates;

        [SetUp]
        public void SetUp()
        {
            previousTouchscreen = Touchscreen.current;
            previousUpdateMode = InputSystem.settings.updateMode;
            InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsManually;
            inputSystemManager = typeof(InputSystem).GetField("s_Manager",
                BindingFlags.Static | BindingFlags.NonPublic).GetValue(null);
            var runUpdates = inputSystemManager.GetType().GetProperty("runPlayerUpdatesInEditMode");
            previousRunPlayerUpdates = (bool)runUpdates.GetValue(inputSystemManager);
            runUpdates.SetValue(inputSystemManager, true);

            root = new GameObject("DiceTale pressure regression");
            pointerCamera = Child("Camera").AddComponent<Camera>();
            pointerCamera.enabled = false;
            pointerCamera.transform.position = new Vector3(10000f, 20f, 0f);
            pointerCamera.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
            pointerCamera.orthographic = true;
            pointerCamera.orthographicSize = 10f;
            texture = new RenderTexture(1920, 1080, 0);
            pointerCamera.targetTexture = texture;

            var rig = Child("Rig");
            rig.SetActive(false);
            var hardware = rig.AddComponent<DevicePipePressureSource>();
            Set(hardware, "connectOnEnable", false);
            router = rig.AddComponent<PressureInputRouter>();
            router.Configure(hardware, null);
            alignment = rig.AddComponent<ProjectionAlignmentController>();
            touchscreen = rig.AddComponent<ProjectionVirtualTouchscreen>();
            Set(touchscreen, "suppressRenderingDebugger", false);
            touchscreen.Configure(alignment, router, pointerCamera);
            rig.SetActive(true);
            Invoke(touchscreen, "OnEnable");
            source = new DevicePipeInputSource2 { ProjectionTouchscreen = touchscreen, LogDiagnostics = false };
            SetMatRect(1);
            Frame();
        }

        [TearDown]
        public void TearDown()
        {
            if (touchscreen != null) Invoke(touchscreen, "OnDisable");
            if (otherTouchscreen != null && otherTouchscreen.added) InputSystem.RemoveDevice(otherTouchscreen);
            if (root != null) Object.DestroyImmediate(root);
            if (texture != null) Object.DestroyImmediate(texture);
            if (previousTouchscreen != null && previousTouchscreen.added) previousTouchscreen.MakeCurrent();
            InputSystem.settings.updateMode = previousUpdateMode;
            inputSystemManager.GetType().GetProperty("runPlayerUpdatesInEditMode")
                .SetValue(inputSystemManager, previousRunPlayerUpdates);
        }

        [TestCase(1)]
        [TestCase(2)]
        public void Pressure_UsesFullTexturePixelsAndCameraViewport(int boards)
        {
            SetMatRect(boards);
            var uv = new Vector2(0.2f, 0.25f);
            Frame(Contact(uv, 0.37f));

            Rect rect = alignment.InteractionRectInGameUv;
            var expectedScreen = new Vector2((rect.x + uv.x * rect.width) * 1920f,
                (1f - rect.y - uv.y * rect.height) * 1080f);
            Assert.That(frame.NewlyPressed, Has.Count.EqualTo(1));
            Assert.That(Vector2.Distance(frame.NewlyPressed[0].Screen, expectedScreen), Is.LessThan(0.01f));
            Assert.That(Vector3.Distance(frame.PressedWorldPositions[0], WorldAt(expectedScreen, 0f)), Is.LessThan(0.01f));
            Assert.That(frame.PressedPressures[0], Is.EqualTo(0.37f).Within(0.001f));
            Assert.That(frame.NewlyPressed[0].Pressure, Is.EqualTo(0.37f).Within(0.001f));
        }

        [Test]
        public void MapLoadedAndMovedAfterSourceInstallation_UsesCurrentPlane()
        {
            Frame(Contact(new Vector2(0.2f, 0.3f)));
            var first = frame.PressedWorldPositions[0];
            Assert.That(first.x, Is.GreaterThan(9900f), "No map at startup must not collapse every press to zero.");

            var grid = Child("Map loaded later").AddComponent<GridMap>();
            grid.transform.position = new Vector3(10000f, 3f, 0f);
            Frame(Contact(new Vector2(0.8f, 0.7f)));
            Assert.That(frame.PressedWorldPositions[0].y, Is.EqualTo(3f).Within(0.001f));
            Assert.That(Vector3.Distance(first, frame.PressedWorldPositions[0]), Is.GreaterThan(1f));
            grid.transform.position += Vector3.up * 2f;
            Frame(Contact(new Vector2(0.8f, 0.7f)));
            Assert.That(frame.PressedWorldPositions[0].y, Is.EqualTo(5f).Within(0.001f));
        }

        [Test]
        public void DragAcrossLargeWorldDistance_DoesNotCreateAnotherPress_ReleaseAllowsRepress()
        {
            pointerCamera.orthographicSize = 100f;
            Frame(Contact(new Vector2(0.3f, 0.3f)));
            var first = frame.PressedWorldPositions[0];
            Assert.That(frame.NewlyPressed, Has.Count.EqualTo(1));
            Frame(Contact(new Vector2(0.32f, 0.3f)));
            Assert.That(Vector3.Distance(first, frame.PressedWorldPositions[0]), Is.GreaterThan(0.5f));
            Assert.That(frame.NewlyPressed, Is.Empty);
            Frame();
            Assert.That(frame.PressedWorldPositions, Is.Empty);
            Frame(Contact(new Vector2(0.32f, 0.3f)));
            Assert.That(frame.NewlyPressed, Has.Count.EqualTo(1));
        }

        [Test]
        public void MultiTouchMarker_ReportsAllPressedContacts()
        {
            // 多点触屏标记（7）= 全触点口径：两点同时按下都进入输入帧，Id 按本帧按压顺序编号
            source = new DevicePipeInputSource2
            {
                ProjectionTouchscreen = touchscreen,
                LogDiagnostics = false,
                CommandId = PointerId.MultiTouch,
            };
            Frame(Contact(new Vector2(0.2f, 0.3f), 0.2f), Contact(new Vector2(0.8f, 0.7f), 0.8f));
            Assert.That(frame.NewlyPressed, Has.Count.EqualTo(2));
            Assert.That(frame.NewlyPressed[0].Id, Is.EqualTo(PointerId.Player1));
            Assert.That(frame.NewlyPressed[1].Id, Is.EqualTo(PointerId.Player2));
            Assert.That(frame.PressedWorldPositions, Has.Count.EqualTo(2));
            Assert.That(frame.PressedScreenPositions, Has.Count.EqualTo(2));
            Assert.That(frame.PressedIds, Is.EqualTo(new[] { PointerId.Player1, PointerId.Player2 }));
        }

        [Test]
        public void SinglePointMode_OnlyMaxPressureContact_WithOverrideId()
        {
            // 非多点标记（如拍照）= 单点指挥：两点同时按下只触发压力最大的那一个（0.8），Id = 覆盖值
            source = new DevicePipeInputSource2
            {
                ProjectionTouchscreen = touchscreen,
                LogDiagnostics = false,
                CommandId = PointerId.Photo,
            };
            Frame(Contact(new Vector2(0.2f, 0.3f), 0.2f), Contact(new Vector2(0.8f, 0.7f), 0.8f));
            Assert.That(frame.NewlyPressed, Has.Count.EqualTo(1));
            Assert.That(frame.NewlyPressed[0].Id, Is.EqualTo(PointerId.Photo));
            Assert.That(frame.PressedWorldPositions, Has.Count.EqualTo(1));
            Assert.That(frame.PressedPressures, Is.EqualTo(new[] { 0.8f }).Within(0.001f));
        }

        [Test]
        public void Calibration_ClearsPressImmediatelyBeforeQueuedCancelIsProcessed()
        {
            var contact = Contact(new Vector2(0.3f, 0.4f));
            Frame(contact);
            touchscreen.SetSuspended(true);
            source.Sample(frame, false, pointerCamera);
            Assert.That(frame.NewlyPressed, Is.Empty);
            Assert.That(frame.PressedWorldPositions, Is.Empty);
            InputSystem.Update();
            touchscreen.SetSuspended(false);
            Frame(contact);
            Assert.That(frame.NewlyPressed, Has.Count.EqualTo(1));
            source.Sample(frame, true, pointerCamera);
            Assert.That(frame.PressedWorldPositions, Is.Empty);
        }

        [Test]
        public void AnotherCurrentTouchscreen_DoesNotReplaceThePressureMat()
        {
            Frame(Contact(new Vector2(0.3f, 0.4f), 0.43f));
            otherTouchscreen = InputSystem.AddDevice<Touchscreen>("Unrelated touchscreen");
            InputSystem.QueueStateEvent(otherTouchscreen, new TouchState
            {
                touchId = 1, position = new Vector2(5f, 5f), pressure = 1f,
                phase = UnityEngine.InputSystem.TouchPhase.Began
            });
            InputSystem.Update();
            otherTouchscreen.MakeCurrent();
            source.Sample(frame, false, pointerCamera);
            Assert.That(frame.PressedWorldPositions, Has.Count.EqualTo(1));
            Assert.That(frame.PressedPressures[0], Is.EqualTo(0.43f).Within(0.001f));
        }

        [Test]
        public void MissingCamera_WarnsOnceAndProducesNoInput()
        {
            Frame(Contact(new Vector2(0.3f, 0.4f)));
            LogAssert.Expect(LogType.Warning, new Regex("\\[DevicePipe\\] 缺少游戏指针相机"));
            source.Sample(frame, false, null);
            source.Sample(frame, false, null);
            Assert.That(frame.PressedWorldPositions, Is.Empty);
        }

        private void SetMatRect(int boards)
        {
            float width = 0.75f * 1080f / 1920f * boards;
            var rect = new Rect((1f - width) / 2f, 0.125f, width, 0.75f);
            alignment.SetInteractionRect(rect);
            pointerCamera.rect = new Rect(rect.x, 1f - rect.yMax, rect.width, rect.height);
        }

        private void Frame(params BoardContact[] contacts)
        {
            var buffer = (List<BoardContact>)typeof(PressureInputRouter).GetField("contacts", PrivateInstance).GetValue(router);
            buffer.Clear();
            buffer.AddRange(contacts);
            Invoke(touchscreen, "Update");
            InputSystem.Update();
            source.Sample(frame, false, pointerCamera);
        }

        private Vector3 WorldAt(Vector2 screen, float height)
        {
            var plane = new Plane(Vector3.up, Vector3.up * height);
            var ray = pointerCamera.ScreenPointToRay(screen);
            Assert.That(plane.Raycast(ray, out float distance), Is.True);
            return ray.GetPoint(distance);
        }

        private static BoardContact Contact(Vector2 uv, float pressure = 0.6f)
        {
            return new BoardContact(uv, new PressureContact(uv * 100f, 1f, pressure), pressure);
        }

        private GameObject Child(string name)
        {
            var child = new GameObject(name);
            child.transform.SetParent(root.transform, false);
            return child;
        }

        private static void Set(object target, string field, object value)
        {
            target.GetType().GetField(field, PrivateInstance).SetValue(target, value);
        }

        private static void Invoke(object target, string method)
        {
            target.GetType().GetMethod(method, PrivateInstance).Invoke(target, null);
        }
    }
}
