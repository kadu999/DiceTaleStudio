using DevicePipe;
using DeviceViz;
using UnityEngine;
using UnityEngine.UI;

public class QuickTest : MonoBehaviour
{
    public MatrixHeatmap heatmap;
    public int row = 100, col = 100;
    public string serialPort;

    SerialPressureReader _reader;
    float _smoothBuf;
    float _smoothQueued;
    float _smoothParse, _smoothQueue, _smoothDispatch, _smoothTotal;

    // Timer — auto-starts on Awake, powered by Stopwatch for maximum precision
    System.Diagnostics.Stopwatch _stopwatch;

    double TimerElapsed => _stopwatch.Elapsed.TotalSeconds;

    string TimerFormatted
    {
        get
        {
            long ticks = _stopwatch.ElapsedTicks;
            long totalUs = ticks * 1_000_000L / System.Diagnostics.Stopwatch.Frequency;

            int minutes = (int)(totalUs / 60_000_000L);
            int seconds = (int)((totalUs % 60_000_000L) / 1_000_000L);
            int millis  = (int)((totalUs % 1_000_000L) / 1_000L);
            int micros  = (int)(totalUs % 1_000L);
            return $"{minutes:D2}:{seconds:D2}.{millis:D3}:{micros:D3}";
        }
    }

    // --- Accurate rolling FPS ---
    const int FPS_SAMPLE_COUNT = 60;
    double[] _fpsTimestamps = new double[FPS_SAMPLE_COUNT];
    int _fpsIndex;
    int _fpsFilled;

    /// <summary>Rolling-average FPS over the last 60 frames — true arithmetic mean.</summary>
    float RollingFPS
    {
        get
        {
            if (_fpsFilled < 2) return 0f;

            int newest = (_fpsIndex - 1 + FPS_SAMPLE_COUNT) % FPS_SAMPLE_COUNT;
            int oldest = _fpsFilled < FPS_SAMPLE_COUNT ? 0
                       : _fpsIndex % FPS_SAMPLE_COUNT;

            double span = _fpsTimestamps[newest] - _fpsTimestamps[oldest];
            int count = _fpsFilled < FPS_SAMPLE_COUNT ? _fpsFilled - 1 : FPS_SAMPLE_COUNT - 1;

            return span > 0 ? (float)(count / span) : 0f;
        }
    }

    /// <summary>Unity's built-in smoothed FPS (1 / smoothDeltaTime).</summary>
    float UnityFPS => Time.smoothDeltaTime > 0f ? 1f / Time.smoothDeltaTime : 0f;

    // ─── UGUI ──────────────────────────────

    Canvas _canvas;
    Text _timerText;
    Text _fpsText;
    Text _statsText;
    bool _testUIVisible = true;

    // ────────────────────────────────────────

    void Awake()
    {
        QualitySettings.vSyncCount = 0;
        Application.targetFrameRate = -1;  // unlimited
        _stopwatch = System.Diagnostics.Stopwatch.StartNew();
        BuildUI();
    }

    void Start()
    {
        _reader = new SerialPressureReader(row, col);
        _reader.OnFrame += OnFrame;
        _reader.Open(portName: serialPort);
    }

    void Update()
    {
        // Record timestamp for accurate rolling FPS
        _fpsTimestamps[_fpsIndex] = _stopwatch.Elapsed.TotalSeconds;
        _fpsIndex = (_fpsIndex + 1) % FPS_SAMPLE_COUNT;
        if (_fpsFilled < FPS_SAMPLE_COUNT) _fpsFilled++;

        // UGUI updates (replaces OnGUI — no immediate-mode overhead)
        UpdateTimerPanel();
        UpdateStatsPanel();

        if (UnityEngine.InputSystem.Keyboard.current?.escapeKey.wasPressedThisFrame == true)
        {
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }

        if (UnityEngine.InputSystem.Keyboard.current?.f1Key.wasPressedThisFrame == true)
        {
            ToggleTestUI();
        }
    }

    void OnFrame(int[] data, int width, int height)
    {
        heatmap?.UpdateData(data, width, height);
    }

    // ─── UGUI build ─────────────────────────

    void BuildUI()
    {
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        // Canvas
        var canvasGo = new GameObject("QuickTestUI", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        canvasGo.transform.SetParent(transform);
        _canvas = canvasGo.GetComponent<Canvas>();
        _canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = canvasGo.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1920, 1080);

        // ── Timer panel (right-middle) ──
        {
            var panel = new GameObject("TimerPanel", typeof(RectTransform), typeof(Image));
            panel.transform.SetParent(canvasGo.transform, false);
            var prt = panel.GetComponent<RectTransform>();
            prt.anchorMin = prt.anchorMax = new Vector2(1, 0.5f);
            prt.pivot = new Vector2(1, 0.5f);
            prt.anchoredPosition = new Vector2(-20, 0);
            prt.sizeDelta = new Vector2(620, 150);
            panel.GetComponent<Image>().color = new Color(0, 0, 0, 0.5f);

            // Timer text (top of panel)
            {
                var go = new GameObject("TimerText", typeof(RectTransform), typeof(Text));
                go.transform.SetParent(panel.transform, false);
                var rt = go.GetComponent<RectTransform>();
                rt.anchorMin = new Vector2(0, 0);
                rt.anchorMax = new Vector2(1, 1);
                rt.offsetMin = new Vector2(10, 50);
                rt.offsetMax = new Vector2(-10, -10);
                _timerText = go.GetComponent<Text>();
                _timerText.font = font;
                _timerText.fontSize = 72;
                _timerText.fontStyle = FontStyle.Bold;
                _timerText.alignment = TextAnchor.MiddleCenter;
                _timerText.color = Color.white;
            }

            // FPS text (bottom of panel)
            {
                var go = new GameObject("FpsText", typeof(RectTransform), typeof(Text));
                go.transform.SetParent(panel.transform, false);
                var rt = go.GetComponent<RectTransform>();
                rt.anchorMin = new Vector2(0, 0);
                rt.anchorMax = new Vector2(1, 1);
                rt.offsetMin = new Vector2(10, 10);
                rt.offsetMax = new Vector2(-10, -100);
                _fpsText = go.GetComponent<Text>();
                _fpsText.font = font;
                _fpsText.fontSize = 28;
                _fpsText.fontStyle = FontStyle.Bold;
                _fpsText.alignment = TextAnchor.MiddleCenter;
                _fpsText.color = new Color(0.6f, 0.85f, 1f);
            }
        }

        // ── Stats panel (right-top) ──
        {
            var panel = new GameObject("StatsPanel", typeof(RectTransform), typeof(Image));
            panel.transform.SetParent(canvasGo.transform, false);
            var prt = panel.GetComponent<RectTransform>();
            prt.anchorMin = prt.anchorMax = new Vector2(1, 1);
            prt.pivot = new Vector2(1, 1);
            prt.anchoredPosition = new Vector2(-10, -10);
            prt.sizeDelta = new Vector2(260, 260);
            panel.GetComponent<Image>().color = new Color(0, 0, 0, 0.6f);

            {
                var go = new GameObject("StatsText", typeof(RectTransform), typeof(Text));
                go.transform.SetParent(panel.transform, false);
                var rt = go.GetComponent<RectTransform>();
                rt.anchorMin = Vector2.zero;
                rt.anchorMax = Vector2.one;
                rt.offsetMin = new Vector2(10, 30);
                rt.offsetMax = new Vector2(-10, -6);
                _statsText = go.GetComponent<Text>();
                _statsText.font = font;
                _statsText.fontSize = 16;
                _statsText.fontStyle = FontStyle.Bold;
                _statsText.alignment = TextAnchor.MiddleLeft;
            }
        }

        // ── Toggle test UI button (bottom-right, tiny) ──
        {
            var btnGo = new GameObject("ToggleBtn", typeof(RectTransform), typeof(Image), typeof(Button));
            btnGo.transform.SetParent(canvasGo.transform, false);
            var rt = btnGo.GetComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = new Vector2(1, 0);
            rt.pivot = new Vector2(1, 0);
            rt.anchoredPosition = new Vector2(-10, 10);
            rt.sizeDelta = new Vector2(40, 22);
            btnGo.GetComponent<Image>().color = new Color(0.15f, 0.15f, 0.15f, 0.7f);

            var btnLabel = new GameObject("Lbl", typeof(RectTransform), typeof(Text));
            btnLabel.transform.SetParent(btnGo.transform, false);
            var lrt = btnLabel.GetComponent<RectTransform>();
            lrt.anchorMin = Vector2.zero;
            lrt.anchorMax = Vector2.one;
            lrt.offsetMin = Vector2.zero;
            lrt.offsetMax = Vector2.zero;
            var lt = btnLabel.GetComponent<Text>();
            lt.text = "×";
            lt.font = font;
            lt.fontSize = 14;
            lt.color = Color.white;
            lt.alignment = TextAnchor.MiddleCenter;
            lt.raycastTarget = false;

            btnGo.GetComponent<Button>().onClick.AddListener(ToggleTestUI);
        }
    }

    // ─── UGUI update ────────────────────────

    void UpdateTimerPanel()
    {
        _timerText.text = TimerFormatted;
        _fpsText.text = $"滚动FPS {RollingFPS:F1}  |  Unity FPS {UnityFPS:F1}";
    }

    void UpdateStatsPanel()
    {
        if (_reader == null) return;

        float fps = _reader.FrameRate;
        float alpha = 0.03f; // heavy smoothing for stable display
        _smoothQueued += ((float)_reader.QueuedFrames - _smoothQueued) * alpha;
        _smoothBuf    += ((float)_reader.BufferedBytes - _smoothBuf)    * alpha;

        // Color heuristic: red if dropping frames or buffer bloated
        int dropped = _reader.DroppedFrameCount;
        Color statsColor;
        if (dropped > 0 || _smoothQueued > 5 || _smoothBuf > 20000)
            statsColor = Color.red;
        else if (_smoothQueued > 2 || _smoothBuf > 5000)
            statsColor = new Color(1f, 0.85f, 0f);
        else
            statsColor = fps > 0 ? Color.green : Color.gray;

        var lat = _reader.LastFrameLatency;
        _smoothParse    += (lat.parseUs    / 1000f - _smoothParse)    * alpha;
        _smoothQueue    += (lat.queueUs    / 1000f - _smoothQueue)    * alpha;
        _smoothDispatch += (lat.dispatchUs / 1000f - _smoothDispatch) * alpha;
        _smoothTotal    += (lat.totalUs    / 1000f - _smoothTotal)    * alpha;

        // Derive actual frame byte size from FPS and baud
        float fpsVal = fps > 0 ? fps : _reader.FrameCount > 0 ? fps : 0;
        int estFrameBytes = fpsVal > 0 ? (int)(46080f / fpsVal) : 0; // 46080 = 460800/10

        float wireFps = _reader.WireFrameRate;

        _statsText.color = statsColor;
        _statsText.text = string.Join("\n",
            $"  Parsed:  {fps:F1} fps",
            $"  Wire:    {wireFps:F1} fps",
            $"  frames:  {_reader.FrameCount}",
            $"  bad:     {_reader.BadFrameCount}",
            $"  dropped: {dropped}",
            $"  queued:  {_smoothQueued:F1}",
            $"  buf:     {_smoothBuf / 1024f:F1} KB",
            $"",
            $"  ── latency ──",
            $"  parse:   {_smoothParse:F2} ms",
            $"  queue:   {_smoothQueue:F2} ms",
            $"  dispatch:{_smoothDispatch:F2} ms",
            $"  total:   {_smoothTotal:F2} ms");
    }

    void ToggleTestUI()
    {
        _testUIVisible = !_testUIVisible;
        _canvas.enabled = _testUIVisible;
    }

    void OnDestroy()
    {
        _reader?.Close();
    }
}
