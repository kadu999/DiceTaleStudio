using System;
using System.Collections.Generic;
using DeviceLink;
using DevicePipe;
using DeviceViz;
using UnityEngine;
using Stopwatch = System.Diagnostics.Stopwatch;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// One or two pressure mats, presented as a single sensor.
    ///
    /// Two mats are tiled left to right into one wide frame and analysed as one image, so
    /// everything downstream keeps seeing a single rectangular board whose UV runs 0..1
    /// across the whole interactive area. Analysing the tiled frame rather than each mat
    /// separately is what lets a finger pressed on the seam read as one contact instead of
    /// two half-contacts.
    ///
    /// This does not use DevicePipe's own <c>DualSerialPressureReader</c>. Its merge writes
    /// a correct row-major tile, but both places that consume it pass the two size arguments
    /// the other way round (<c>OnFrame(merged, _row, _col*2)</c> and
    /// <c>PressureAnalyzer.GetPressureInfo(merged, _row, _col*2)</c>), so the tile is read
    /// back with half the stride it was written with and the two mats come out interleaved
    /// row by row. It also shares one <see cref="ProtocolConfig"/> between both readers,
    /// which breaks bit-depth auto-detection when the two mats are different generations.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-80)]
    public sealed class DevicePipePressureSource : MonoBehaviour, IPressureBoardSource
    {
        [Header("Sensor")]
        [SerializeField, Min(1)] private int rowCount = 100;
        [SerializeField, Min(1)] private int columnCount = 100;
        [SerializeField, Min(0)] private int minimumPressure = 3;
        [SerializeField] private RadiusMode radiusMode = RadiusMode.Direction;

        [Header("Axis Convention")]
        [Tooltip("DevicePipe's PressureInfo.x is the ROW index and .y is the COLUMN index "
            + "(PressureAnalyzer indexes data[row * ColCount + col], and DeviceViz's own "
            + "TouchMarkerLayer draws at (t.y, t.x)). Keep this on so rawPosition is "
            + "(horizontal, vertical) like every other source. Turn off only if the firmware "
            + "turns out to scan the other way.")]
        [SerializeField] private bool swapRowColumn = true;

        [Header("Mats")]
        [Tooltip("How many mats to look for. Fewer are used if fewer are plugged in — the count "
            + "that ends up connected is what the rest of the rig calibrates against.")]
        [SerializeField, Range(1, 2)] private int maximumBoards = 2;

        [Tooltip("Which connected mat is the left one. The ports enumerate in whatever order the "
            + "OS lists them, which says nothing about how the mats are laid out on the table, so "
            + "this gets decided during calibration (or by hand with key 6).")]
        [SerializeField] private bool swapBoards;

        [Tooltip("Which sensor axis the mats are tiled along — the axis the seam is perpendicular to. "
            + "Driven by PressureInputRouter from the orientation flags, because the two answer the "
            + "same question: whichever sensor axis ends up horizontal in board UV is the one the "
            + "pair is long along. Do not set by hand; press 1 (SwapXY) to change it.")]
        [SerializeField] private bool tileAlongRows;

        [Tooltip("The dead strip between two mats, in sensor cells (one cell = 5 mm). It is each "
            + "mat's bezel plus whatever air is left between them, so it is never zero even when "
            + "the mats are pushed together. Tiling without it claims the two sensing grids are "
            + "continuous, which puts everything on the far mat a whole seam width out of place "
            + "and smears the error across the entire area. Measure it or let calibration estimate "
            + "it; adjust on site with 7 / 8.")]
        [SerializeField, Min(0)] private int seamGapCells;

        [Header("Serial")]
        [SerializeField] private bool connectOnEnable = true;
        [Tooltip("Optional override for the first mat's port. Leave empty to auto-detect.")]
        [SerializeField] private string portName = string.Empty;
        [Tooltip("Optional override for the second mat's port. Leave empty to auto-detect.")]
        [SerializeField] private string secondaryPortName = string.Empty;
        [SerializeField] private int baudRate = 460800;
        [SerializeField, Min(0.5f)] private float reconnectInterval = 2f;
        [SerializeField] private bool skipChecksum = true;

        [Header("Optional DeviceViz Output")]
        [SerializeField] private MatrixHeatmap debugHeatmap;
        private ProjectionPressureHeatmap debugHeatmapView;

        private sealed class BoardLink
        {
            public SerialPressureReader reader;
            public string port = string.Empty;
            public int[] latestFrame;
            public PressureBoardConnectionState connection;
            public long openedTicks;
            public int scanOrder;
            public ProtocolConfig config;
            public int delivered, consumed, superseded, lastConsumed;
            public double rateStart;
            public int rateCount;
            public double recentHz;

            public bool IsOpen => reader != null && reader.IsOpen;
            public bool IsConnected => connection != null && connection.IsConnected(IsOpen, Stopwatch.GetTimestamp());
            public float FrameRate => IsConnected ? (float)recentHz : 0f;
        }

        private readonly List<BoardLink> boards = new List<BoardLink>(2);
        private readonly List<BoardLink> pendingBoards = new List<BoardLink>(4);
        private int scanCursor;
        private readonly List<PressureContact> contacts = new List<PressureContact>(16);
        private int[] tiledFrame;
        private float nextReconnectTime;
        private ProjectionGameCameraBinder gameCameraBinder;

        /// <summary>Every delivered protocol frame, before Update keeps only the newest matrix.
        /// Called on the decoder's main-thread dispatcher; its time is delivery time, not sensor time.</summary>
        public event Action<string, int[], double> DiagnosticFrameReceived;

        public bool TryGetStreamSnapshot(int slot, out PressureStreamSnapshot snapshot)
        {
            snapshot = default;
            int index = ReaderIndexForSlot(slot);
            if (slot < 0 || slot >= boards.Count || index < 0 || index >= boards.Count) return false;
            BoardLink link = boards[index];
            var reader = link.reader;
            snapshot = new PressureStreamSnapshot
            {
                Port = link.port, ConnectionId = link.openedTicks,
                Seconds = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency,
                Connected = link.IsConnected, ChecksumEnabled = !skipChecksum,
                BitsPerSample = link.config.BitsPerSample,
                FrameBytes = 8 + rowCount * columnCount * (link.config.BitsPerSample / 8), BaudRate = baudRate,
                Parsed = reader?.FrameCount ?? 0, Delivered = link.delivered, Consumed = link.consumed,
                Superseded = link.superseded, Dropped = reader?.DroppedFrameCount ?? 0,
                Bad = reader?.BadFrameCount ?? 0, Queued = reader?.QueuedFrames ?? 0,
                RecentHz = link.FrameRate, QueueMilliseconds = (reader?.LastFrameLatency.queueUs ?? 0) / 1000.0
            };
            return true;
        }

        public string SourceName
        {
            get
            {
                if (boards.Count == 0)
                {
                    return "DevicePipe";
                }

                return boards.Count == 1
                    ? $"DevicePipe ({boards[0].port})"
                    : $"DevicePipe ×{boards.Count} ({string.Join(" + ", DescribePorts())})";
            }
        }

        public bool IsReady => ConnectedBoardCount > 0;

        /// <summary>Currently streaming, protocol-confirmed mats. Neither the fallback layout nor open COM ports count.</summary>
        public int ConnectedBoardCount
        {
            get
            {
                if (!isActiveAndEnabled) return 0;
                int count = 0;
                for (int index = 0; index < boards.Count; index++)
                {
                    if (boards[index].IsConnected)
                    {
                        count++;
                    }
                }

                return count;
            }
        }

        /// <summary>How many cells the mats are tiled across, seams included.</summary>
        private int TiledSpan => MatSpanCells * BoardCount + seamGapCells * (BoardCount - 1);

        /// <summary>One mat's cell count along the tiling axis.</summary>
        private int MatSpanCells => tileAlongRows ? rowCount : columnCount;

        /// <summary>Cell pitch from one mat's start to the next mat's start, seam included.</summary>
        private int MatPitchCells => MatSpanCells + seamGapCells;

        /// <summary>Sensor rows across the whole tiled frame — more than one mat's worth only when tiling along rows.</summary>
        public int TotalRows => tileAlongRows ? TiledSpan : rowCount;

        /// <summary>Sensor columns across the whole tiled frame.</summary>
        public int TotalColumns => tileAlongRows ? columnCount : TiledSpan;

        /// <summary>Which sensor axis the mats are tiled along. See <see cref="SetTileAlongRows"/>.</summary>
        public bool TileAlongRows => tileAlongRows;

        /// <summary>One sensor cell in cm — the mat's physical edge divided by its cell count.</summary>
        public float CellSizeCm => ProjectionCoordinateMapper.MatEdgeCm / Mathf.Max(1, MatSpanCells);

        /// <summary>The dead strip between two mats, in cm.</summary>
        public float SeamGapCm => seamGapCells * CellSizeCm;

        public int SeamGapCells => seamGapCells;

        /// <summary>
        /// Sets the dead strip between mats. Given in cm because that is what a ruler reads and
        /// what calibration estimates; it is stored in whole cells so the tiled frame stays an
        /// exact integer grid.
        /// </summary>
        public void SetSeamGapCm(float centimetres)
        {
            int cells = Mathf.Max(0, Mathf.RoundToInt(centimetres / Mathf.Max(0.0001f, CellSizeCm)));
            if (cells == seamGapCells)
            {
                return;
            }

            seamGapCells = cells;
            tiledFrame = null;
        }

        public Vector2Int SensorResolution => swapRowColumn
            ? new Vector2Int(TotalColumns, TotalRows)
            : new Vector2Int(TotalRows, TotalColumns);

        /// <summary>
        /// Confirmed mat layout, not current connection count. A mat that
        /// drops out mid-session must not silently resize the interactive area and throw the
        /// calibration away — it just stops reporting contacts until it comes back.
        /// </summary>
        public int BoardCount => Mathf.Max(1, boards.Count);

        /// <summary>True once protocol frames confirmed this layout. For live presence use ConnectedBoardCount.</summary>
        public bool HasBoards => boards.Count > 0;

        public float HighestPressureSeen { get; private set; }
        public int MinimumPressure => minimumPressure;
        public bool SwapRowColumn => swapRowColumn;
        public bool SwapBoards => swapBoards;
        public IReadOnlyList<PressureContact> Contacts => contacts;
        public string ConnectedPort => boards.Count > 0 ? boards[0].port : string.Empty;
        public string LastError { get; private set; } = string.Empty;
        public float FrameRate => boards.Count > 0 ? boards[0].FrameRate : 0f;
        public int DetectedSerialPortCount { get; private set; } = -1;
        // Candidate ports reserve their half of the image while the pressure protocol is being
        // confirmed. This display count does not promote them to connected hardware.
        public int DebugHeatmapBoardCount => Mathf.Clamp(Mathf.Max(boards.Count, DetectedSerialPortCount), 1, maximumBoards);

        /// <summary>Per-mat status for the diagnostics panel, ordered left to right on the table.</summary>
        public string DescribeBoard(int slot)
        {
            int index = ReaderIndexForSlot(slot);
            if (index < 0 || index >= boards.Count)
            {
                return "—";
            }

            BoardLink board = boards[index];
            return board.IsConnected
                ? $"{board.port}  协议解析 {board.FrameRate:F1} Hz"
                : $"{board.port}  已断开";
        }

        public void Configure(MatrixHeatmap heatmap, bool shouldConnectOnEnable = true)
        {
            debugHeatmap = heatmap;
            connectOnEnable = shouldConnectOnEnable;
        }

        private void Awake()
        {
            gameCameraBinder = GetComponent<ProjectionGameCameraBinder>();
        }

        private void OnEnable()
        {
            ReportHardwareConnection();
            nextReconnectTime = Time.unscaledTime;
            if (connectOnEnable)
            {
                TryConnect();
            }
        }

        private void Update()
        {
            UpdateConnections();
            double now = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
            foreach (BoardLink link in boards)
            {
                if (!link.IsConnected) continue;
                if (link.rateStart == 0) { link.rateStart = now; link.rateCount = link.reader.FrameCount; }
                if (now - link.rateStart >= 1)
                {
                    int count = link.reader.FrameCount;
                    link.recentHz = (count - link.rateCount) / (now - link.rateStart);
                    link.rateStart = now; link.rateCount = count;
                }
                if (link.delivered == link.lastConsumed) continue;
                link.superseded += Math.Max(0, link.delivered - link.lastConsumed - 1);
                link.consumed++;
                link.lastConsumed = link.delivered;
            }

            // Keep looking while any mat is missing: they enumerate at their own pace, and a
            // rig that came up with one mat should pick up the second one when it appears.
            if (connectOnEnable
                && ConnectedBoardCount < maximumBoards
                && Time.unscaledTime >= nextReconnectTime)
            {
                TryConnect();
            }

            UpdateDebugHeatmaps();

            if (!IsReady)
            {
                contacts.Clear();
                return;
            }

            TileFrames();
            contacts.Clear();

            PressureInfo[] pressureInfo = boards.Count == 1
                ? boards[0].reader.GetPressureInfo(radiusMode)
                : AnalyseTiledFrame();
            if (pressureInfo == null)
            {
                return;
            }

            int[] frame = boards.Count > 1 ? tiledFrame : boards[0].latestFrame;
            int lastSlot = Mathf.Max(0, boards.Count - 1);
            for (int index = 0; index < pressureInfo.Length; index++)
            {
                PressureInfo touch = pressureInfo[index];
                if (touch.pressure < minimumPressure)
                {
                    continue;
                }

                HighestPressureSeen = Mathf.Max(HighestPressureSeen, touch.pressure);

                // PressureInfo.x is the row, .y the column, both across the whole tiled frame —
                // and both whole cells, the peak of the smoothed frame. The fraction is read
                // back off the raw cells around that peak.
                Vector2 peak = ContactRefinement.Refine(
                    frame, TotalRows, TotalColumns, Mathf.RoundToInt(touch.x), Mathf.RoundToInt(touch.y));
                Vector2 raw = swapRowColumn
                    ? new Vector2(peak.y, peak.x)
                    : new Vector2(peak.x, peak.y);
                // Which mat, by cell pitch. A peak can land inside the seam strip when a blob
                // straddles it — the analyser smooths across the dead cells — so this rounds to
                // the nearer mat instead of pretending the strip belongs to one of them.
                float alongTiling = tileAlongRows ? touch.x : touch.y;
                int slot = Mathf.Clamp(
                    Mathf.RoundToInt((alongTiling - MatSpanCells * 0.5f) / Mathf.Max(1, MatPitchCells)),
                    0,
                    lastSlot);
                contacts.Add(new PressureContact(
                    raw, touch.radius, Mathf.Max(0f, touch.pressure), slot));
            }

        }

        private void UpdateDebugHeatmaps()
        {
            if (debugHeatmap == null) return;
            if (debugHeatmapView == null)
            {
                debugHeatmapView = debugHeatmap.GetComponent<ProjectionPressureHeatmap>();
                if (debugHeatmapView == null)
                    debugHeatmapView = debugHeatmap.gameObject.AddComponent<ProjectionPressureHeatmap>();
                debugHeatmapView.Configure(debugHeatmap);
            }
            debugHeatmapView.SetBoardCount(DebugHeatmapBoardCount);
            BoardLink first = DebugLinkForSlot(0);
            BoardLink second = debugHeatmapView.BoardCount == 2 ? DebugLinkForSlot(1) : null;
            debugHeatmapView.UpdateFrames(first?.latestFrame, second?.latestFrame, columnCount, rowCount,
                DebugBoardStatus(first), DebugBoardStatus(second));
        }

        private static string DebugBoardStatus(BoardLink link) => link == null ? "WAITING FOR SERIAL DATA"
            : link.port + (link.IsConnected ? $"  {link.FrameRate:F1} Hz" : "  WAITING / OFFLINE");

        private BoardLink DebugLinkForSlot(int slot)
        {
            if (slot < boards.Count) return boards[ReaderIndexForSlot(slot)];
            int pendingSlot = slot - boards.Count;
            foreach (BoardLink candidate in pendingBoards)
            {
                if (boards.Exists(board => board.port == candidate.port)) continue;
                if (pendingSlot-- == 0) return candidate;
            }
            return null;
        }

        /// <summary>
        /// Runs the vendor analyser over the tiled frame with the argument order its own
        /// indexing implies: it transposes its two size parameters on entry and then reads
        /// <c>data[x * height + y]</c>, so a row-major frame needs (columns, rows) and comes
        /// back with x = row, y = column — the same convention a single mat reports.
        /// </summary>
        private PressureInfo[] AnalyseTiledFrame()
        {
            if (tiledFrame == null)
            {
                return null;
            }

            return PressureAnalyzer.GetPressureInfo(tiledFrame, TotalColumns, TotalRows, radiusMode);
        }

        /// <summary>
        /// Lays the mats out into one row-major frame, along whichever axis they are butted
        /// together. Tiling along rows is a plain append — a mat's frame is already row-major,
        /// so its rows land after the previous mat's. Tiling along columns has to interleave
        /// row by row. A mat with no frame yet contributes zeros rather than stale data, so a
        /// mat that drops out goes quiet instead of freezing a stale print on the table.
        /// </summary>
        private void TileFrames()
        {
            if (boards.Count < 2)
            {
                return;
            }

            int cells = rowCount * columnCount;
            int totalColumns = TotalColumns;
            int required = TotalRows * totalColumns;

            // The seam strip is never written to, so a fresh (zeroed) buffer is what keeps it
            // reading as dead space rather than as whatever was there before.
            if (tiledFrame == null || tiledFrame.Length != required)
            {
                tiledFrame = new int[required];
            }

            for (int slot = 0; slot < boards.Count; slot++)
            {
                BoardLink link = boards[ReaderIndexForSlot(slot)];
                int[] source = link.IsConnected ? link.latestFrame : null;
                bool usable = source != null && source.Length >= cells;
                int offset = slot * MatPitchCells;

                if (tileAlongRows)
                {
                    int destination = offset * columnCount;
                    if (usable)
                    {
                        Array.Copy(source, 0, tiledFrame, destination, cells);
                    }
                    else
                    {
                        Array.Clear(tiledFrame, destination, cells);
                    }

                    continue;
                }

                for (int row = 0; row < rowCount; row++)
                {
                    int destination = row * totalColumns + offset;
                    if (usable)
                    {
                        Array.Copy(source, row * columnCount, tiledFrame, destination, columnCount);
                    }
                    else
                    {
                        Array.Clear(tiledFrame, destination, columnCount);
                    }
                }
            }
        }

        /// <summary>
        /// Sets which sensor axis the mats are tiled along. Not a free choice: whichever axis
        /// ends up horizontal in board UV has to be the axis the pair is long along, or the
        /// interactive area is described as 50 x 100 cm while it is drawn as 100 x 50. The
        /// router derives it from the orientation flags and keeps the two in step.
        /// </summary>
        public void SetTileAlongRows(bool value)
        {
            if (tileAlongRows == value)
            {
                return;
            }

            tileAlongRows = value;
            tiledFrame = null;
        }

        private int ReaderIndexForSlot(int slot)
        {
            if (boards.Count < 2 || !swapBoards)
            {
                return slot;
            }

            return boards.Count - 1 - slot;
        }

        private IEnumerable<string> DescribePorts()
        {
            for (int slot = 0; slot < boards.Count; slot++)
            {
                yield return boards[ReaderIndexForSlot(slot)].port;
            }
        }

        public void SetSwapRowColumn(bool value)
        {
            swapRowColumn = value;
        }

        /// <summary>Swaps which connected mat counts as the left one.</summary>
        public void SetSwapBoards(bool value)
        {
            swapBoards = value;
        }

        public void ResetHighestPressureSeen()
        {
            HighestPressureSeen = 0f;
        }

        private void OnDisable()
        {
            Disconnect();
        }

        private void OnApplicationQuit()
        {
            Disconnect();
        }

        public void TryConnect()
        {
            nextReconnectTime = Time.unscaledTime + reconnectInterval;

            try
            {
                SerialBridge.ClearCachedPortNames();
                List<string> ports = PickLikelySerialPorts(SerialBridge.GetPortNames());
                ApplyPortOverrides(ports);
                ReportDetectedSerialPortCount(ports.Count);

                if (ports.Count == 0)
                {
                    if (boards.Count == 0)
                    {
                        LastError = "未连接压感垫。";
                    }

                    return;
                }

                for (int index = 0; index < ports.Count && pendingBoards.Count < 4 && ConnectedBoardCount < maximumBoards; index++)
                {
                    string port = ports[scanCursor++ % ports.Count];
                    if (IsAlreadyOpen(port))
                    {
                        continue;
                    }

                    OpenBoard(port, ports.IndexOf(port));
                }

                ReportHardwareConnection();
            }
            catch (Exception exception)
            {
                ReportDetectedSerialPortCount(0);
                LastError = exception.Message;
                Debug.LogWarning($"[ProjectionAlignment] Pressure board connection failed: {exception.Message}", this);
            }
        }

        private void ReportDetectedSerialPortCount(int count)
        {
            DetectedSerialPortCount = Mathf.Max(0, count);
        }

        private void ReportHardwareConnection()
        {
            if (gameCameraBinder == null)
            {
                gameCameraBinder = GetComponent<ProjectionGameCameraBinder>();
            }

            if (gameCameraBinder != null)
            {
                gameCameraBinder.SetConnectedBoardCount(ConnectedBoardCount);
            }
            if (ConnectedBoardCount > 0) LastError = string.Empty;
            else LastError = pendingBoards.Count > 0
                ? "尚未连接压感垫，正在等待候选串口返回有效压感帧。"
                : "未连接压感垫。";
        }

        private void UpdateConnections()
        {
            for (int index = pendingBoards.Count - 1; index >= 0; index--)
            {
                BoardLink link = pendingBoards[index];
                if (link.IsConnected)
                {
                    // Reuse this port's own slot first, so a returning right-hand mat cannot
                    // occupy the missing left-hand mat's calibrated position.
                    int replacement = boards.FindIndex(b => b.port == link.port);
                    if (replacement < 0) replacement = boards.FindIndex(b => !b.IsConnected);
                    if (replacement >= 0)
                    {
                        link.scanOrder = boards[replacement].scanOrder;
                        boards[replacement].reader?.Close(); boards[replacement] = link;
                    }
                    else if (boards.Count < maximumBoards) boards.Add(link);
                    else { link.reader.Close(); pendingBoards.RemoveAt(index); continue; }
                    pendingBoards.RemoveAt(index);
                    boards.Sort((left, right) => left.scanOrder.CompareTo(right.scanOrder));
                    Debug.Log($"[ProjectionAlignment] 压感协议已确认：{link.port}，已连接 {ConnectedBoardCount} 块压感垫。", this);
                }
                else if (!link.IsOpen || (Stopwatch.GetTimestamp() - link.openedTicks) / (double)Stopwatch.Frequency > 5)
                {
                    link.reader?.Close(); pendingBoards.RemoveAt(index);
                }
            }
            foreach (BoardLink link in boards)
            {
                if (link.IsConnected) continue;
                link.reader?.Close(); link.reader = null; link.latestFrame = null;
            }
            // Keep the established geometry while an individual mat is missing. Live presence is a separate count.
            ReportHardwareConnection();
        }

        private bool IsAlreadyOpen(string port)
        {
            for (int index = 0; index < boards.Count; index++)
            {
                if (boards[index].IsOpen && string.Equals(boards[index].port, port, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return pendingBoards.Exists(link => link.port == port);
        }

        private void OpenBoard(string port, int scanOrder)
        {
            // A config per mat, never a shared one: AutoDetectBitsPerSample writes the
            // detected depth back into it, and the two mats can be different generations
            // (the green FA001_V8.0 streams 8-bit, the older blue board 16-bit).
            var config = new ProtocolConfig
            {
                HeaderHex = "A55A01",
                // Fallback only. The blue board streams 16-bit samples (frame =
                // 6 + 100*100*2 + 2 = 20008 B); the green FA001_V8.0 board streams
                // 8-bit (frame = 10008 B). Hardcoding 16 makes the 8-bit board
                // decode two adjacent cells as one sample, which halves the row
                // stride — one press then shows up twice, 50 columns apart, and
                // the frame boundary leaks in as a stuck cell at [50,0].
                BitsPerSample = 16,
                AutoDetectBitsPerSample = true,
                HeaderByteLength = 3,
                HeadLen = 6,
                Checksum = ChecksumType.CRC16_Modbus,
                RowCount = rowCount,
                ColCount = columnCount,
                SkipChecksum = skipChecksum
            };

            var link = new BoardLink
            {
                port = port, scanOrder = scanOrder, openedTicks = Stopwatch.GetTimestamp(),
                connection = new PressureBoardConnectionState(rowCount, columnCount), config = config
            };
            link.reader = new SerialPressureReader(config);
            link.reader.OnFrame += (data, rows, columns) =>
            {
                long ticks = Stopwatch.GetTimestamp();
                if (link.connection.ObserveDecodedFrame(data, rows, columns, ticks))
                {
                    link.latestFrame = data;
                    link.delivered++;
                    DiagnosticFrameReceived?.Invoke(link.port, data, ticks / (double)Stopwatch.Frequency);
                }
            };
            try { link.reader.Open(port, baudRate); }
            catch { link.reader.Close(); throw; }

            if (!link.reader.IsOpen)
            {
                link.reader.Close();
                LastError = $"无法打开压力板串口 {port}。";
                return;
            }

            pendingBoards.Add(link);
        }

        /// <summary>
        /// Real USB serial devices, in a stable order. macOS lists dozens of pseudo-terminals
        /// (/dev/ttyp0../dev/ttywf) that a naive pick would take, and it lists each real device
        /// twice — /dev/tty.X and /dev/cu.X are the same hardware, so counting both would
        /// report two mats where one is plugged in. Only usb-ish names qualify, /dev/cu.*
        /// wins over its /dev/tty.* twin, and Windows COM ports pass through as they are.
        /// </summary>
        public static List<string> PickLikelySerialPorts(string[] ports)
        {
            var result = new List<string>(2);
            if (ports == null)
            {
                return result;
            }

            var claimedDevices = new HashSet<string>(StringComparer.Ordinal);
            for (int pass = 0; pass < 2; pass++)
            {
                bool wantCu = pass == 0;
                for (int index = 0; index < ports.Length; index++)
                {
                    string port = ports[index];
                    if (string.IsNullOrEmpty(port))
                    {
                        continue;
                    }

                    string lower = port.ToLowerInvariant();
                    bool looksReal = lower.Contains("usb")
                        || lower.Contains("wch")
                        || lower.Contains("slab")
                        || lower.Contains("acm")
                        || lower.StartsWith("com")
                        || lower.Contains("\\\\.\\com");
                    if (!looksReal)
                    {
                        continue;
                    }

                    bool isCu = lower.StartsWith("/dev/cu.");
                    if (isCu != wantCu && (isCu || lower.StartsWith("/dev/tty.")))
                    {
                        continue;
                    }

                    if (claimedDevices.Add(DeviceIdentity(port)))
                    {
                        result.Add(port);
                    }
                }
            }

            return result;
        }

        /// <summary>The hardware behind a port name, so /dev/cu.X and /dev/tty.X collapse into one.</summary>
        private static string DeviceIdentity(string port)
        {
            const string cuPrefix = "/dev/cu.";
            const string ttyPrefix = "/dev/tty.";
            if (port.StartsWith(cuPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return port.Substring(cuPrefix.Length);
            }

            if (port.StartsWith(ttyPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return port.Substring(ttyPrefix.Length);
            }

            return port;
        }

        /// <summary>Hand-set ports go to the front of the queue, in the order they are written.</summary>
        private void ApplyPortOverrides(List<string> ports)
        {
            PromotePort(ports, secondaryPortName);
            PromotePort(ports, portName);
        }

        private static void PromotePort(List<string> ports, string requested)
        {
            if (string.IsNullOrWhiteSpace(requested))
            {
                return;
            }

            string trimmed = requested.Trim();
            ports.RemoveAll(existing => string.Equals(existing, trimmed, StringComparison.Ordinal));
            ports.Insert(0, trimmed);
        }

        public void Disconnect()
        {
            for (int index = 0; index < boards.Count; index++)
            {
                boards[index].reader?.Close();
            }

            boards.Clear();
            foreach (BoardLink link in pendingBoards) link.reader?.Close();
            pendingBoards.Clear();
            contacts.Clear();
            tiledFrame = null;
            ReportHardwareConnection();
            if (debugHeatmapView != null) UpdateDebugHeatmaps();
        }
    }
}
