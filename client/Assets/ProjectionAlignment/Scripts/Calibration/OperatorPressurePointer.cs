using System;
using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>A private menu pointer. Never emits OS mouse, game touch, or global input events.</summary>
    public sealed class OperatorPressurePointer
    {
        private sealed class Target
        {
            public string key;
            public Rect rect;
            public Action click;
            public Action<Vector2> drag;
            public Func<Vector2, bool> hitTest;
            public bool Contains(Vector2 point) => rect.Contains(point) && (hitTest == null || hitTest(point));
        }

        private List<Target> targets = new List<Target>();
        private List<Target> building = new List<Target>();
        private Target captured;
        private bool waitForRelease = true;
        public bool Pressed { get; private set; }
        public Vector2 Position { get; private set; }

        public void Reset()
        {
            captured = null;
            Pressed = false;
            waitForRelease = true;
        }

        public void BeginTargets() => building.Clear();

        public void AddTarget(string key, Rect rect, Action click, Action<Vector2> drag = null, Func<Vector2, bool> hitTest = null)
        {
            if (rect.width > 0 && rect.height > 0)
                building.Add(new Target { key = key, rect = rect, click = click, drag = drag, hitTest = hitTest });
        }

        public void EndTargets()
        {
            var previous = targets; targets = building; building = previous;
        }

        public void Sample(bool enabled, int contactCount, Vector2 position)
        {
            if (!enabled || contactCount > 1) { Reset(); return; }
            if (contactCount == 0)
            {
                Target target = FindCaptured();
                bool click = Pressed && target != null && target.Contains(Position);
                Pressed = false; captured = null; waitForRelease = false;
                // Run only in Update, before the next IMGUI layout. Layout/Repaint never execute pressure actions.
                if (click) target.click?.Invoke();
                return;
            }
            if (waitForRelease) return;
            Position = position;
            if (!Pressed)
            {
                Pressed = true;
                for (int i = targets.Count - 1; i >= 0; i--)
                    if (targets[i].Contains(position)) { captured = targets[i]; break; }
            }
            Target current = FindCaptured();
            if (captured != null && current == null) { Reset(); return; }
            current?.drag?.Invoke(position);
        }

        private Target FindCaptured()
        {
            if (captured == null) return null;
            foreach (var target in targets)
                if (target.key == captured.key && target.rect == captured.rect) return target;
            return null;
        }
    }

    /// <summary>Registers the visible IMGUI controls for the menu's pressure pointer, retaining native mouse input.</summary>
    public static class OperatorPressureGui
    {
        private static OperatorPressurePointer pointer;
        private static Vector2 screenOrigin;
        private static Rect clip;
        private static int ordinal;

        public static void Begin(OperatorPressurePointer owner, Vector2 origin, Vector2 size)
        {
            pointer = owner; screenOrigin = origin; clip = new Rect(Vector2.zero, size); ordinal = 0;
            if (Event.current.type == EventType.Repaint) pointer.BeginTargets();
        }

        public static void End()
        {
            if (pointer != null && Event.current.type == EventType.Repaint) pointer.EndTargets();
            pointer = null;
        }

        private static Rect ToPixels(Rect rect)
        {
            // Unclip first, then scale the whole position. GUIToScreenPoint with a scaled
            // matrix leaves nested BeginArea/scroll offsets unscaled in IMGUI.
            Matrix4x4 matrix = GUI.matrix;
            try
            {
                GUI.matrix = Matrix4x4.identity;
                Vector2 min = matrix.MultiplyPoint3x4(GUIUtility.GUIToScreenPoint(rect.min) - screenOrigin);
                Vector2 max = matrix.MultiplyPoint3x4(GUIUtility.GUIToScreenPoint(rect.max) - screenOrigin);
                return Rect.MinMaxRect(min.x, min.y, max.x, max.y);
            }
            finally { GUI.matrix = matrix; }
        }

        public static Rect SetClip(Rect localRect)
        {
            Rect previous = clip;
            clip = ToPixels(localRect);
            return previous;
        }

        public static void RestoreClip(Rect pixels) => clip = pixels;

        public static void Register(string key, Rect rect, Action click, Action<Vector2> drag = null)
        {
            int index = ordinal++;
            if (pointer == null || Event.current.type != EventType.Repaint || !GUI.enabled) return;
            Rect pixels = ToPixels(rect);
            Rect visible = Rect.MinMaxRect(Mathf.Max(clip.xMin, pixels.xMin), Mathf.Max(clip.yMin, pixels.yMin),
                Mathf.Min(clip.xMax, pixels.xMax), Mathf.Min(clip.yMax, pixels.yMax));
            pointer.AddTarget(key + ":" + index, visible, click, drag);
        }

        public static void RegisterRing(Rect rect, int sector, Action click)
        {
            int index = ordinal++;
            if (pointer == null || Event.current.type != EventType.Repaint || !GUI.enabled) return;
            Rect pixels = ToPixels(rect);
            pointer.AddTarget("ring:" + sector + ":" + index, pixels, click, null,
                point => sector < 0 ? Vector2.Distance(point, pixels.center) <= pixels.width * 0.175f
                    : ProjectionCalibrationController.OperatorSectorAt(point, pixels.center, pixels.width * 0.5f) == sector);
        }

        public static void Button(string label, Action click, params GUILayoutOption[] options) => Button(label, click, GUI.skin.button, options);

        public static void Button(string label, Action click, GUIStyle style, params GUILayoutOption[] options)
        {
            bool clicked = GUILayout.Button(label, style, options);
            Register(label, GUILayoutUtility.GetLastRect(), click);
            if (clicked) click();
        }

        public static void Button(Rect rect, string label, Action click)
        {
            bool clicked = GUI.Button(rect, label);
            Register(label, rect, click);
            if (clicked) click();
        }

        public static void Toggle(string label, bool value, Action<bool> change, GUIStyle style, params GUILayoutOption[] options)
        {
            bool next = GUILayout.Toggle(value, label, style, options);
            Register(label, GUILayoutUtility.GetLastRect(), () => change(!value));
            if (next != value) change(next);
        }

        public static void Slider(string key, float value, float min, float max, Action<float> change, params GUILayoutOption[] options)
        {
            float next = GUILayout.HorizontalSlider(value, min, max, options);
            Rect rect = GUILayoutUtility.GetLastRect();
            if (Event.current.type == EventType.Repaint)
            {
                Rect pixels = ToPixels(rect);
                Register(key, rect, null, point => change(Mathf.Lerp(min, max, Mathf.InverseLerp(pixels.xMin, pixels.xMax, point.x))));
            }
            else ordinal++;
            if (!Mathf.Approximately(next, value)) change(next);
        }
    }
}
