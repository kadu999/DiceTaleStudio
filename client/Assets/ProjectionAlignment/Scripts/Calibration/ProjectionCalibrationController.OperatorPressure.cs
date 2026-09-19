using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    public sealed partial class ProjectionCalibrationController
    {
        private readonly OperatorPressurePointer operatorPressurePointer = new OperatorPressurePointer();
        private bool operatorAwaitPressureRelease;
        private bool showOperatorOutputBorder;

        private bool OperatorHasPressure
        {
            get
            {
                if (pressureInput == null || !pressureInput.HasConnectedHardware || pressureInput.UsingSimulation) return false;
                foreach (var contact in pressureInput.Contacts)
                    if (contact.normalizedPressure >= .025f) return true;
                return false;
            }
        }

        private void UpdateOperatorPressure()
        {
            if (operatorAwaitPressureRelease && !OperatorHasPressure) operatorAwaitPressureRelease = false;
            bool enabled = showOperatorUi && !OperatorModalOpen && !pressureTestActive
                && pressureInput != null && pressureInput.HasConnectedHardware && !pressureInput.UsingSimulation && alignment != null;
            int count = 0;
            Vector2 point = default;
            if (enabled)
            {
                float threshold = operatorPressurePointer.Pressed ? .025f : .05f;
                foreach (var contact in pressureInput.Contacts)
                {
                    if (contact.normalizedPressure < threshold) continue;
                    count++;
                    if (!TryOperatorPressurePixel(alignment.BoardToProjectorMatrix, contact.boardUv,
                        new Vector2(Screen.width, Screen.height), out point)) enabled = false;
                }
            }
            operatorPressurePointer.Sample(enabled, count, point);
        }

        /// <summary>IMGUI is drawn on the raw projector output: use top-left output pixels, never Camera A's cropped RT pixels.</summary>
        public static bool TryOperatorPressurePixel(Matrix4x4 boardToProjector, Vector2 boardUv, Vector2 outputSize, out Vector2 pixel)
        {
            pixel = default;
            if (!HomographyUtility.TryApply(boardToProjector, boardUv, out Vector2 uv)
                || !float.IsFinite(uv.x) || !float.IsFinite(uv.y)
                || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return false;
            pixel = Vector2.Scale(uv, outputSize);
            return true;
        }

        private void ResolveOperatorWindow(out float scale, out Rect pixels)
        {
            Vector2 output = new Vector2(Screen.width, Screen.height);
            scale = Mathf.Max(.1f, Mathf.Min(1.35f, output.x / 600f, output.y / 750f));
            Vector2 size = new Vector2(580f, 720f);
            Vector2 center = output * .5f;
            // Keep the whole menu on the physical touch surface when calibration is available.
            // The game image may be cropped/rotated; operator controls remain unwarped and use their own fit.
            if (alignment != null && alignment.HasValidCalibration && pressureInput != null && pressureInput.HasConnectedHardware
                && TryOperatorPressurePixel(alignment.BoardToProjectorMatrix, Vector2.one * .5f, output, out Vector2 matCenter))
            {
                center = matCenter;
                float low = 0, high = scale;
                for (int i = 0; i < 16; i++)
                {
                    float candidate = (low + high) * .5f;
                    var rect = new Rect(center - size * (candidate * .5f), size * candidate);
                    if (OperatorWindowFitsMat(rect, output, alignment.ProjectorToBoardMatrix)) low = candidate;
                    else high = candidate;
                }
                if (low >= .1f) scale = low;
                else center = output * .5f;
            }
            pixels = new Rect(center - size * (scale * .5f), size * scale);
        }

        public static bool OperatorWindowFitsMat(Rect rect, Vector2 output, Matrix4x4 projectorToBoard)
        {
            if (output.x <= 0 || output.y <= 0 || rect.xMin < 0 || rect.yMin < 0 || rect.xMax > output.x || rect.yMax > output.y) return false;
            for (int corner = 0; corner < 4; corner++)
            {
                Vector2 uv = new Vector2((corner % 2 == 0 ? rect.xMin : rect.xMax) / output.x,
                    (corner < 2 ? rect.yMin : rect.yMax) / output.y);
                if (!HomographyUtility.TryApply(projectorToBoard, uv, out Vector2 board)
                    || !float.IsFinite(board.x) || !float.IsFinite(board.y)
                    || board.x < .02f || board.x > .98f || board.y < .02f || board.y > .98f) return false;
            }
            return true;
        }

        private void DrawOperatorPressureCursor(float scale)
        {
            if (!operatorPressurePointer.Pressed || pressureTestActive || Event.current.type != EventType.Repaint) return;
            Vector2 point = operatorPressurePointer.Position / scale;
            OperatorFill(new Rect(point.x - 10, point.y - 2, 20, 4), OperatorAccent);
            OperatorFill(new Rect(point.x - 2, point.y - 10, 4, 20), OperatorAccent);
        }

        public static Rect OperatorOutputBorderEdge(Vector2 size, int edge, float thickness = 5f)
        {
            float t = Mathf.Clamp(thickness, 0, Mathf.Min(size.x, size.y) * .5f);
            switch (edge)
            {
                case 0: return new Rect(0, 0, size.x, t);
                case 1: return new Rect(0, size.y - t, size.x, t);
                case 2: return new Rect(0, t, t, size.y - 2 * t);
                default: return new Rect(size.x - t, t, t, size.y - 2 * t);
            }
        }

        private void DrawOperatorOutputBorder()
        {
            if (!showOperatorOutputBorder || Event.current.type != EventType.Repaint) return;
            Matrix4x4 previousMatrix = GUI.matrix;
            int previousDepth = GUI.depth;
            try
            {
                GUI.matrix = Matrix4x4.identity;
                GUI.depth = -10500;
                var size = new Vector2(Screen.width, Screen.height);
                float thickness = Mathf.Max(3f, 5f * Screen.height / 1080f);
                for (int edge = 0; edge < 4; edge++)
                    OperatorFill(OperatorOutputBorderEdge(size, edge, thickness), new Color(1f, .78f, .12f, 1f));
            }
            finally { GUI.matrix = previousMatrix; GUI.depth = previousDepth; }
        }
    }
}
