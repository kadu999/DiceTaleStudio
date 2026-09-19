using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NuLight.ProjectionAlignment
{
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-80)]
    public sealed class MousePressureSource : MonoBehaviour, IPressureBoardSource
    {
        [SerializeField] private Vector2Int sensorResolution = new Vector2Int(100, 100);
        [SerializeField, Range(1f, 20f)] private float simulatedRadius = 4f;
        [SerializeField, Range(1f, 255f)] private float simulatedPressure = 128f;
        [SerializeField] private Vector2 keyboardBoardUv = new Vector2(0.5f, 0.5f);
        [SerializeField, Range(0.001f, 0.1f)] private float keyboardMoveSpeed = 0.01f;

        private readonly List<PressureContact> contacts = new List<PressureContact>(1);

        public string SourceName => "Mouse / Keyboard Simulator";
        public bool IsReady => true;
        public Vector2Int SensorResolution => sensorResolution;

        /// <summary>The simulator is one notional mat; the pointer sweeps whatever area the rig is set to.</summary>
        public int BoardCount => 1;

        public IReadOnlyList<PressureContact> Contacts => contacts;
        public Vector2 OperatorPoint => keyboardBoardUv;
        private bool operatorControl;
        private bool operatorPressed;

        public void SetOperatorControl(bool active)
        {
            operatorControl = active;
            if (!active) operatorPressed = false;
        }

        public void MoveOperatorPoint(Vector2 delta)
        {
            keyboardBoardUv = new Vector2(Mathf.Clamp01(keyboardBoardUv.x + delta.x), Mathf.Clamp01(keyboardBoardUv.y + delta.y));
        }

        public void SetOperatorPressed(bool pressed) => operatorPressed = operatorControl && pressed;

        private void Update()
        {
            contacts.Clear();
            if (operatorControl)
            {
                if (operatorPressed) AddContact(keyboardBoardUv);
                return;
            }

            Keyboard keyboard = Keyboard.current;
            if (keyboard != null)
            {
                Vector2 movement = Vector2.zero;
                if (keyboard.leftArrowKey.isPressed) movement.x -= 1f;
                if (keyboard.rightArrowKey.isPressed) movement.x += 1f;
                if (keyboard.upArrowKey.isPressed) movement.y -= 1f;
                if (keyboard.downArrowKey.isPressed) movement.y += 1f;
                keyboardBoardUv = new Vector2(
                    Mathf.Clamp01(keyboardBoardUv.x + movement.x * keyboardMoveSpeed * Time.unscaledDeltaTime * 60f),
                    Mathf.Clamp01(keyboardBoardUv.y + movement.y * keyboardMoveSpeed * Time.unscaledDeltaTime * 60f));

                if (keyboard.spaceKey.isPressed)
                {
                    AddContact(keyboardBoardUv);
                    return;
                }
            }

            Mouse mouse = Mouse.current;
            if (mouse != null && mouse.leftButton.isPressed && Screen.width > 0 && Screen.height > 0)
            {
                Vector2 screen = mouse.position.ReadValue();
                AddContact(new Vector2(
                    Mathf.Clamp01(screen.x / Screen.width),
                    Mathf.Clamp01(1f - screen.y / Screen.height)));
            }
        }

        private void AddContact(Vector2 boardUv)
        {
            Vector2 raw = new Vector2(
                boardUv.x * Mathf.Max(1, sensorResolution.x - 1),
                boardUv.y * Mathf.Max(1, sensorResolution.y - 1));
            contacts.Add(new PressureContact(raw, simulatedRadius, simulatedPressure));
        }
    }
}
