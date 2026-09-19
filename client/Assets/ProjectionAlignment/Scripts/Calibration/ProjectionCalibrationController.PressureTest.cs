using System;
using UnityEngine;
using Stopwatch = System.Diagnostics.Stopwatch;

namespace NuLight.ProjectionAlignment
{
    public sealed partial class ProjectionCalibrationController
    {
        private enum PressureTestKind { Frequency, TenTaps, Rapid, Hold }
        private PressureTestKind pressureTestKind;
        private DevicePipePressureSource diagnosticSource;
        private PressureRateMeasurement pressureMeasurement;
        private PressurePressCounter rawPressCounter, contactPressCounter;
        private PressureStreamSnapshot pressureTestSnapshot;
        private bool pressureTestActive, pressureTestPending;
        private int pressureTestSlot, pressureExpected = 10;
        private float pressureTestThreshold = 12, pressureReleaseThreshold = 5;
        private float diagnosticRawPeak, diagnosticContactPeak;
        private double pressureTestReadyAt, operatorRateStart;
        private int operatorRateFrames;
        private double operatorUnityHz;
        private string pressureTestStatus = "选择测试，连接真实垫子后开始。";
        private static double DiagnosticSeconds => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;

        private void UpdatePressureDiagnostics()
        {
            double now = DiagnosticSeconds;
            if (operatorRateStart == 0) operatorRateStart = now;
            operatorRateFrames++;
            if (now - operatorRateStart >= 1)
            {
                operatorUnityHz = operatorRateFrames / (now - operatorRateStart);
                operatorRateFrames = 0; operatorRateStart = now;
            }

            var source = showOperatorUi && !OperatorModalOpen && OperatorPage == ProjectionOperatorPage.PressureTest
                && pressureInput != null ? pressureInput.HardwareSource : null;
            if (diagnosticSource != source)
            {
                StopPressureTest("测试界面已离开，本轮提前结束。");
                if (diagnosticSource != null) diagnosticSource.DiagnosticFrameReceived -= ObserveDiagnosticFrame;
                diagnosticSource = source;
                diagnosticRawPeak = 0;
                if (source != null) source.DiagnosticFrameReceived += ObserveDiagnosticFrame;
            }
            if (source == null) return;

            bool available = source.TryGetStreamSnapshot(pressureTestSlot, out var snapshot) && snapshot.Connected;
            diagnosticContactPeak = 0;
            if (available && !pressureInput.UsingSimulation)
                foreach (var contact in pressureInput.Contacts)
                    if (contact.boardIndex == pressureTestSlot)
                        diagnosticContactPeak = Mathf.Max(diagnosticContactPeak, contact.pressure);

            if (!pressureTestActive) return;
            if (!available || snapshot.ConnectionId != pressureTestSnapshot.ConnectionId || snapshot.Port != pressureTestSnapshot.Port)
            {
                StopPressureTest("连接中断或板顺序改变，本轮无效，请重新开始。");
                pressureMeasurement = null;
                return;
            }
            if (pressureTestPending)
            {
                if (now < pressureTestReadyAt) return;
                if (pressureTestKind != PressureTestKind.Frequency
                    && (!rawPressCounter.Armed || diagnosticRawPeak > pressureReleaseThreshold || diagnosticContactPeak > pressureReleaseThreshold))
                {
                    pressureTestStatus = "等待完全松手、移走板上物品；必要时调高测试阈值后重开。";
                    return;
                }
                pressureTestPending = false;
                pressureMeasurement = new PressureRateMeasurement(snapshot);
                rawPressCounter = new PressurePressCounter(pressureTestThreshold, pressureReleaseThreshold);
                contactPressCounter = new PressurePressCounter(pressureTestThreshold, pressureReleaseThreshold);
                // Only arm after a real released matrix has been observed during the countdown.
                if (pressureTestKind != PressureTestKind.Frequency) rawPressCounter.Observe(diagnosticRawPeak, now);
                pressureTestStatus = "开始！按说明操作，完全松手后点击「结束并核对」。";
            }
            contactPressCounter.Observe(diagnosticContactPeak, now);
            pressureMeasurement.Observe(snapshot);
            if (!pressureMeasurement.Valid) StopPressureTest("计数器重置或连接变化，本轮无效。");
            else if (pressureTestKind == PressureTestKind.Frequency && pressureMeasurement.Duration >= 15)
                StopPressureTest("15 秒采样完成。可重复三轮，并在游戏运行时复测。");
        }

        private void ObserveDiagnosticFrame(string port, int[] data, double seconds)
        {
            if (diagnosticSource == null || !diagnosticSource.TryGetStreamSnapshot(pressureTestSlot, out var snapshot)
                || snapshot.Port != port) return;
            float peak = 0;
            for (int i = 0; i < data.Length; i++) peak = Mathf.Max(peak, data[i]);
            diagnosticRawPeak = peak;
            if (pressureTestActive) rawPressCounter.Observe(peak, seconds);
        }

        private void BeginPressureTest()
        {
            if (IsCalibrating || diagnosticSource == null
                || !diagnosticSource.TryGetStreamSnapshot(pressureTestSlot, out var snapshot) || !snapshot.Connected) return;
            pressureTestSnapshot = snapshot;
            pressureMeasurement = null;
            rawPressCounter = new PressurePressCounter(pressureTestThreshold, pressureReleaseThreshold);
            contactPressCounter = new PressurePressCounter(pressureTestThreshold, pressureReleaseThreshold);
            pressureTestActive = pressureTestPending = true;
            pressureTestReadyAt = DiagnosticSeconds + 3;
            pressureTestStatus = "准备中：清空所选垫子，完全松手。";
            operatorScroll = Vector2.zero;
        }

        private void StopPressureTest(string reason)
        {
            if (!pressureTestActive) return;
            pressureTestActive = pressureTestPending = false;
            pressureTestStatus = reason;
        }

        private void ReleasePressureDiagnostics()
        {
            StopPressureTest("装置已停用，本轮结束。");
            if (diagnosticSource != null) diagnosticSource.DiagnosticFrameReceived -= ObserveDiagnosticFrame;
            diagnosticSource = null;
        }

        private void DrawPressureTestPage()
        {
            var hardware = pressureInput != null ? pressureInput.HardwareSource : null;
            PressureStreamSnapshot current = default;
            bool available = hardware != null && hardware.TryGetStreamSnapshot(pressureTestSlot, out current)
                && current.Connected;
            OperatorNote("清空所选板，在同一位置用一根手指按压。测试中压感只计数，不点击菜单；用鼠标结束，或 H / Esc 退出。");
            GUILayout.BeginHorizontal();
            OperatorButton("板 1", () => SelectPressureTestSlot(0), !pressureTestActive);
            OperatorButton("板 2", () => SelectPressureTestSlot(1), !pressureTestActive && hardware != null && hardware.BoardCount > 1);
            GUILayout.EndHorizontal();
            OperatorNote(available ? $"所选板 {pressureTestSlot + 1} · {current.Port} · 协议 {current.RecentHz:F1} Hz · Unity {operatorUnityHz:F1} FPS"
                : $"板 {pressureTestSlot + 1} 未连接：真实测试不可开始。模拟输入不计入硬件结果。");
            if (pressureTestActive)
            {
                OperatorNote(pressureTestPending && DiagnosticSeconds < pressureTestReadyAt
                    ? $"准备 {Math.Ceiling(pressureTestReadyAt - DiagnosticSeconds):0} 秒 · 请松手" : pressureTestStatus);
                if (!pressureTestPending && pressureTestKind != PressureTestKind.Frequency)
                {
                    GUILayout.Label($"逐帧 {rawPressCounter.Presses}  ·  输入层 {contactPressCounter.Presses}  /  {pressureExpected}", operatorTitle);
                    DrawPressureCountLights(rawPressCounter.Presses, pressureExpected);
                    OperatorNote($"{(pressureTestKind == PressureTestKind.Hold ? "保持按住约 5 秒，再松手" : "按目标次数手动完成，每次完全松手")}\n矩阵峰值 {diagnosticRawPeak:0} · 输入触点峰值 {diagnosticContactPeak:0}");
                }
                if (pressureMeasurement != null && pressureTestKind == PressureTestKind.Frequency)
                    GUILayout.Label($"{pressureMeasurement.Hertz:F2} Hz  ·  {pressureMeasurement.Duration:F1} / 15 秒", operatorTitle);
                OperatorButton("结束并核对", () => StopPressureTest("已手动结束，请与自己实际按下的次数核对。"));
                if (pressureMeasurement != null) DrawPressureTestResult();
                return;
            }

            GUILayout.BeginHorizontal();
            DrawPressureTestChoice("15 秒测频率", PressureTestKind.Frequency, 0);
            DrawPressureTestChoice("十次点按", PressureTestKind.TenTaps, 10);
            GUILayout.EndHorizontal();
            GUILayout.BeginHorizontal();
            DrawPressureTestChoice("20 次连击", PressureTestKind.Rapid, 20);
            DrawPressureTestChoice("长按 5 秒", PressureTestKind.Hold, 1);
            GUILayout.EndHorizontal();

            switch (pressureTestKind)
            {
                case PressureTestKind.Frequency:
                    OperatorNote("静置或轻压均可。3 秒准备后自动采样 15 秒；每块板分别做三轮。约 100 Hz 对应 15 秒约 1500 帧；约 60 Hz 对应约 900 帧。");
                    break;
                case PressureTestKind.TenTaps:
                    OperatorNote("准备结束后手动按 10 下，每秒约一下，每次完全抬手；最后松手再结束。重复触发不会在第 10 下被截断。");
                    break;
                case PressureTestKind.Rapid:
                    OperatorNote("同点连续按 20 下。先约 2 下/秒，再开新一轮试 4、6 下/秒；每轮自己数满 20 下、松手再结束。界面帧率不作为节拍基准。");
                    break;
                case PressureTestKind.Hold:
                    OperatorNote("只按下一次，保持稳定约 5 秒，再松开并结束。理想值是 1 次按下、1 次松开；多次按下提示阈值抖动或接触断续。");
                    break;
            }

            if (pressureTestKind != PressureTestKind.Frequency)
            {
                OperatorNumber("按下阈值", "test-press", pressureTestThreshold, 1, 1, 255,
                    value => { pressureTestThreshold = value; pressureReleaseThreshold = Mathf.Min(pressureReleaseThreshold, value - 1); }, !pressureTestActive);
                OperatorNumber("松开阈值", "test-release", pressureReleaseThreshold, 1, 0, pressureTestThreshold - 1,
                    value => pressureReleaseThreshold = value, !pressureTestActive);
                OperatorNote($"测试阈值不改游戏配置。当前：矩阵峰值 {diagnosticRawPeak:0} · 输入触点峰值 {diagnosticContactPeak:0}");
            }
            GUILayout.BeginHorizontal();
            OperatorButton(pressureMeasurement == null ? "开始测试" : "重新测试", BeginPressureTest,
                available && !pressureTestActive && !IsCalibrating, operatorPrimary);
            OperatorButton("结束并核对", () => StopPressureTest("已手动结束，请与自己实际按下的次数核对。"), pressureTestActive);
            GUILayout.EndHorizontal();
            OperatorNote(pressureTestPending && DiagnosticSeconds < pressureTestReadyAt
                ? $"准备 {Math.Ceiling(pressureTestReadyAt - DiagnosticSeconds):0} 秒 · 请松手" : pressureTestStatus);
            if (pressureMeasurement == null) return;
            DrawPressureTestResult();
        }

        private void SelectPressureTestSlot(int slot)
        {
            pressureTestSlot = slot; pressureMeasurement = null; diagnosticRawPeak = diagnosticContactPeak = 0;
            pressureTestStatus = "已切换板，请重新开始。";
        }

        private void DrawPressureTestChoice(string label, PressureTestKind kind, int expected)
        {
            OperatorButton((pressureTestKind == kind ? "● " : "") + label, () =>
            {
                pressureTestKind = kind; pressureExpected = expected; pressureMeasurement = null;
                pressureTestStatus = "已选择测试，请按说明开始。";
            }, !pressureTestActive);
        }

        private void DrawPressureTestResult()
        {
            var m = pressureMeasurement;
            if (!m.Valid) { OperatorNote("本轮无效：连接或计数器发生变化，请重测。"); return; }
            OperatorSection(pressureTestActive ? "实时结果" : "本轮结果（已冻结）");
            OperatorNote($"{m.End.Port} · 采样 {m.Duration:F2} 秒\n协议解析 {m.Hertz:F2} Hz · 平均周期 {m.MeanPeriodMilliseconds:F2} ms\n游戏新矩阵取样 {m.ConsumedHertz:F2} Hz\n解析 {m.Parsed} 帧 · 逐帧回调 {m.Delivered} · 游戏取样 {m.Consumed}\n队列丢弃 {m.Dropped} · 被更新矩阵覆盖 {m.Superseded} · 当前排队 {m.End.Queued}");
            if (pressureTestKind != PressureTestKind.Frequency)
            {
                GUILayout.Label($"逐帧按下  {rawPressCounter.Presses}  /  {pressureExpected}", operatorTitle);
                GUILayout.Label($"输入层按下  {contactPressCounter.Presses}  /  {pressureExpected}", operatorTitle);
                DrawPressureCountLights(rawPressCounter.Presses, pressureExpected);
                OperatorNote($"逐帧松开 {rawPressCounter.Releases} · 输入层松开 {contactPressCounter.Releases}\n最长连续按住：逐帧 {rawPressCounter.LongestHoldSeconds:F2} s · 输入层 {contactPressCounter.LongestHoldSeconds:F2} s");
                if (rawPressCounter.Held || contactPressCounter.Held) OperatorNote("仍检测到按住；请先完全松手，确认松开计数再结束。");
                if (!pressureTestActive)
                {
                    OperatorNote($"以你确实按了 {pressureExpected} 次为前提：逐帧差额 {rawPressCounter.Presses - pressureExpected:+0;-0;0}，输入层差额 {contactPressCounter.Presses - pressureExpected:+0;-0;0}。负值是少计，正值是多计。");
                    OperatorNote(rawPressCounter.Presses == pressureExpected && contactPressCounter.Presses == pressureExpected
                        ? "本轮次数吻合。仍需检查松开次数、长按断续，并重复三轮；次数吻合可能掩盖等量漏计与多计。"
                        : "逐帧也少计：检查按压幅度、松手、阈值及传输；逐帧正确但输入层少计：检查最新帧覆盖和触点识别。多计：检查压力抖动与误触。");
                }
                OperatorNote("逐帧计数使用整板矩阵峰值；输入层使用触点分析后的峰值，两者有平滑差异。这里不是 TableBand 音符命中数，也未测物理触摸到声光的延迟。");
            }
            else
            {
                OperatorNote(m.Duration < 10 ? "不足 10 秒，只作预览，请完成 15 秒采样再判断。"
                    : m.Hertz >= 95 && m.Hertz <= 105 ? "本轮接收频率接近 100 Hz（±5% 仅作现场比较带），支持主机端每秒约收到 100 帧。"
                    : m.Hertz >= 57 && m.Hertz <= 63 ? "本轮接收频率接近 60 Hz（±5% 仅作现场比较带）；这不等于垫子内部只扫描 60 次。"
                    : "按实际 Hz 记录并重复三轮，与供应商确认同一分辨率、固件及输出模式下的指标。");
                OperatorNote($"协议 {m.End.BitsPerSample}-bit · {m.End.FrameBytes} 字节/帧 · 配置波特率 {m.End.BaudRate}\n校验 {(m.End.ChecksumEnabled ? "已开启" : "已跳过，坏帧 0 不能证明无传输错误")} · 报告坏帧 {m.Bad}");
                OperatorNote("该协议未提供已验证的设备采样时间戳/序号；接收 Hz 不能证明独立扫描 Hz，也不能判断相同数据是否重复发送。静置时相同矩阵仍是有效接收帧。");
            }
            if (m.Dropped > 0) OperatorNote("存在队列丢帧：逐帧按压统计并不完整，本轮不能据此判定垫子漏按。关闭重负载后复测。");
            OperatorNote("被更新矩阵覆盖：已送到主线程，却在游戏取样前被下一帧替代。100 Hz 输入配合 60 FPS 游戏时可能出现。未统计设备端或串口上游丢帧。");
        }

        private void DrawPressureCountLights(int count, int target)
        {
            Rect rect = GUILayoutUtility.GetRect(10, 30, GUILayout.ExpandWidth(true));
            int dots = Mathf.Clamp(target, 1, 20);
            float step = rect.width / dots;
            for (int i = 0; i < dots; i++)
                OperatorFill(new Rect(rect.x + i * step, rect.y + 5, step - 3, 18), i < count ? OperatorAccent : OperatorRaised);
        }
    }
}
