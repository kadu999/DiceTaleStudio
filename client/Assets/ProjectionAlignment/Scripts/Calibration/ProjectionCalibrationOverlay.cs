using UnityEngine;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// The calibration layer that covers the running game.
    ///
    /// It lives on Game Camera A's canvas, so it goes through the same pre-warp as the
    /// game and lands upright on the table where the person doing the calibration is
    /// standing — unlike the operator's IMGUI panel, which stays on the laptop screen.
    /// The precise markers are not here: they are drawn by the warp shader in projector
    /// coordinates, which is the only place a point can be placed exactly.
    ///
    /// It is two objects rather than one, at opposite ends of the canvas: the dimming
    /// backdrop is the first child so the alignment guides stay bright on top of it, and
    /// the instruction panel is the last child so nothing can cover the instructions.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ProjectionCalibrationOverlay : MonoBehaviour
    {
        [SerializeField] private GameObject backdrop;
        [SerializeField] private GameObject messagePanel;
        [SerializeField] private Text titleText;
        [SerializeField] private Text bodyText;
        [SerializeField] private Text progressText;

        public bool IsVisible => messagePanel != null && messagePanel.activeSelf;

        public void Configure(
            GameObject overlayBackdrop,
            GameObject overlayMessagePanel,
            Text title,
            Text body,
            Text progress)
        {
            backdrop = overlayBackdrop;
            messagePanel = overlayMessagePanel;
            titleText = title;
            bodyText = body;
            progressText = progress;
        }

        public void SetVisible(bool visible)
        {
            SetBackdropVisible(visible);
            if (messagePanel != null && messagePanel.activeSelf != visible)
            {
                messagePanel.SetActive(visible);
            }
        }

        /// <summary>
        /// Drops the veil but keeps the text, for reporting the outcome of a calibration
        /// over a game that has already resumed.
        /// </summary>
        public void SetBackdropVisible(bool visible)
        {
            if (backdrop != null && backdrop.activeSelf != visible)
            {
                backdrop.SetActive(visible);
            }
        }

        public void SetMessage(string title, string body, string progress)
        {
            if (titleText != null)
            {
                titleText.text = title ?? string.Empty;
            }

            if (bodyText != null)
            {
                bodyText.text = body ?? string.Empty;
            }

            if (progressText != null)
            {
                progressText.text = progress ?? string.Empty;
            }
        }

        private void Awake()
        {
            SetVisible(false);
        }
    }
}
