using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Moves the player window onto the projector, and remembers which screen that was.
    ///
    /// A fullscreen macOS player opens on whatever the OS calls the main display, which on
    /// a laptop plugged into a projector is the laptop. Rather than making the operator
    /// rearrange displays in System Settings before every session, this cycles the window
    /// across the attached screens on a key and stores the choice by name, so the next
    /// launch goes straight there.
    ///
    /// The display is stored by name rather than index because index order changes when a
    /// screen is unplugged, and landing on the wrong screen silently is worse than not
    /// restoring at all.
    ///
    /// Editor-only caveat: the move API acts on the player window, so in the editor this
    /// reports what it would do instead of doing it.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-90)]
    public sealed class ProjectionDisplayRouter : MonoBehaviour
    {
        private const string PreferenceKey = "ProjectionAlignment.DisplayName";

        [SerializeField] private ProjectionAlignmentController alignment;

        [Tooltip("Restore the remembered screen on startup. Off means the window opens wherever "
            + "the OS puts it and M has to be pressed every session.")]
        [SerializeField] private bool restoreRememberedDisplay = true;

        private readonly List<DisplayInfo> displays = new List<DisplayInfo>();
        private bool moving;

        public string StatusMessage { get; private set; } = string.Empty;

        public void Configure(ProjectionAlignmentController configuredAlignment)
        {
            alignment = configuredAlignment;
        }

        /// <summary>Screens currently attached, refreshed on every call.</summary>
        public int DisplayCount
        {
            get
            {
                Screen.GetDisplayLayout(displays);
                return displays.Count;
            }
        }

        public string CurrentDisplayName => Screen.mainWindowDisplayInfo.name;

        private void Start()
        {
            Screen.GetDisplayLayout(displays);
            DescribeCurrent();
            LogLayout("startup");

            if (!restoreRememberedDisplay)
            {
                return;
            }

            string remembered = PlayerPrefs.GetString(PreferenceKey, string.Empty);
            if (string.IsNullOrEmpty(remembered) || remembered == CurrentDisplayName)
            {
                return;
            }

            int index = IndexOfDisplayNamed(remembered);
            if (index < 0)
            {
                StatusMessage = $"记住的显示器「{remembered}」没接着，窗口留在 {CurrentDisplayName}。按 M 切换。";
                return;
            }

            MoveToDisplay(index);
        }

        /// <summary>Moves the window to the next attached screen and remembers it.</summary>
        public void CycleDisplay()
        {
            Screen.GetDisplayLayout(displays);
            if (displays.Count < 2)
            {
                StatusMessage = "只有一块屏幕，没有可切换的目标。把投影仪接上再按 M。";
                return;
            }

            int current = IndexOfDisplayNamed(CurrentDisplayName);
            int next = current < 0 ? 0 : (current + 1) % displays.Count;
            MoveToDisplay(next);
        }

        public void MoveToDisplay(int index)
        {
            Screen.GetDisplayLayout(displays);
            if (index < 0 || index >= displays.Count)
            {
                StatusMessage = $"没有第 {index} 块屏幕。";
                return;
            }

            if (moving)
            {
                return;
            }

            DisplayInfo target = displays[index];
            PlayerPrefs.SetString(PreferenceKey, target.name);
            PlayerPrefs.Save();

            if (Application.isEditor)
            {
                StatusMessage = $"编辑器里不能移动播放器窗口。已记住「{target.name}」"
                    + $"（{target.width}×{target.height}），打包版启动时会自己过去。";
                return;
            }

            StartCoroutine(MoveRoutine(target));
        }

        /// <summary>
        /// Fullscreen windows cannot be relocated, so this drops to windowed, moves, then
        /// goes fullscreen again on the target.
        ///
        /// Every wait here is real time with a timeout rather than a fixed frame count.
        /// macOS animates the fullscreen transition over roughly a second, and a move issued
        /// while that animation is still running is silently dropped — the window simply
        /// stays where it was, with no error to notice.
        /// </summary>
        private IEnumerator MoveRoutine(DisplayInfo target)
        {
            moving = true;
            StatusMessage = $"正在移到「{target.name}」…";

            bool wasCalibrated = alignment != null && alignment.HasValidCalibration;
            string targetName = target.name;

            // Windowed, and deliberately smaller than either screen so the window cannot be
            // clamped back onto the one it is leaving.
            Screen.SetResolution(1280, 720, FullScreenMode.Windowed);
            yield return WaitUntilRealtime(() => !Screen.fullScreen, 3f);
            yield return new WaitForSecondsRealtime(0.35f);

            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (!TryFindDisplayNamed(targetName, out DisplayInfo current))
                {
                    break;
                }

                AsyncOperation move = Screen.MoveMainWindowTo(in current, Vector2Int.zero);
                float deadline = Time.realtimeSinceStartup + 3f;
                while (move != null && !move.isDone && Time.realtimeSinceStartup < deadline)
                {
                    yield return null;
                }

                yield return new WaitForSecondsRealtime(0.35f);
                if (Screen.mainWindowDisplayInfo.name == targetName)
                {
                    break;
                }
            }

            bool arrived = Screen.mainWindowDisplayInfo.name == targetName;
            DisplayInfo final = Screen.mainWindowDisplayInfo;
            Screen.SetResolution(final.width, final.height, FullScreenMode.FullScreenWindow);
            yield return WaitUntilRealtime(() => Screen.fullScreen, 3f);

            moving = false;
            DescribeCurrent();
            LogLayout(arrived ? "after move" : "MOVE FAILED");

            if (!arrived)
            {
                StatusMessage = $"移到「{targetName}」失败，窗口仍在 {Screen.mainWindowDisplayInfo.name}。"
                    + "改用系统设置把投影仪设为主显示器。";
                yield break;
            }

            if (wasCalibrated)
            {
                // The homography was solved against the old window geometry; on a different
                // screen it describes nothing real.
                StatusMessage += "  换屏后原有标定已失效，按 C 重新标定。";
            }
        }

        private static IEnumerator WaitUntilRealtime(System.Func<bool> condition, float timeoutSeconds)
        {
            float deadline = Time.realtimeSinceStartup + timeoutSeconds;
            while (!condition() && Time.realtimeSinceStartup < deadline)
            {
                yield return null;
            }
        }

        private bool TryFindDisplayNamed(string name, out DisplayInfo info)
        {
            Screen.GetDisplayLayout(displays);
            for (int index = 0; index < displays.Count; index++)
            {
                if (displays[index].name == name)
                {
                    info = displays[index];
                    return true;
                }
            }

            info = default;
            return false;
        }

        /// <summary>
        /// Which screen the window landed on is the first thing to check when the projector
        /// shows nothing, and on a rig nobody wants to open a panel to find out — so it goes
        /// in the player log.
        /// </summary>
        private void LogLayout(string reason)
        {
            var text = new System.Text.StringBuilder();
            text.Append("[ProjectionAlignment] Window on '")
                .Append(Screen.mainWindowDisplayInfo.name)
                .Append("' (").Append(reason).Append("). Displays:");
            for (int index = 0; index < displays.Count; index++)
            {
                text.Append(" [").Append(index).Append("] ").Append(displays[index].name)
                    .Append(' ').Append(displays[index].width).Append('x').Append(displays[index].height);
            }

            Debug.Log(text.ToString(), this);
        }

        private void DescribeCurrent()
        {
            DisplayInfo current = Screen.mainWindowDisplayInfo;
            Screen.GetDisplayLayout(displays);
            StatusMessage = $"当前显示器：{current.name}（{current.width}×{current.height}）"
                + $"，共 {displays.Count} 块。按 M 切换。";
        }

        private int IndexOfDisplayNamed(string name)
        {
            for (int index = 0; index < displays.Count; index++)
            {
                if (displays[index].name == name)
                {
                    return index;
                }
            }

            return -1;
        }
    }
}
