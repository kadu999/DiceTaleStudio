using System;
using System.IO;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// GM 后台控制的录音管理器（挂在 Game 宿主上，生命周期与宿主一致 = 「一局游戏」）。
    ///
    /// 录音模型：
    /// - 一局一个文件夹：宿主创建（进游戏）时按「游戏开始时间」建本局录音目录
    ///   （Recordings/yyyy-MM-dd_HH-mm-ss/），宿主销毁（退出游戏）时停掉录音并收尾；
    /// - 一段一个文件：GM 每次「开始录音」→「停止录音」生成一个 WAV 文件，
    ///   文件名 = 该段录音的开始时间（yyyy-MM-dd_HH-mm-ss.wav），存进本局文件夹；
    /// - 中途可断开再继续：GM 反复开关录音即可，一局内会累积多个按时间命名的文件。
    ///
    /// 采集用 Unity Microphone（默认录音设备），停止时把 AudioClip 数据编码成
    /// 16bit PCM WAV 写入磁盘（见 <see cref="WavEncoder"/>）。
    /// </summary>
    public class RecordingManager : MonoBehaviour
    {
        /// <summary>录音根目录（构建产物旁的 Recordings/，方便直接取走文件）。</summary>
        private static string RecordingsRoot
        {
            get
            {
                // Application.dataPath 在编辑器/构建下都指 …_Data 目录，取它的上级 + Recordings
                var baseDir = Path.GetDirectoryName(Application.dataPath);
                return Path.Combine(baseDir ?? Directory.GetCurrentDirectory(), "Recordings");
            }
        }

        /// <summary>本局录音文件夹（宿主创建时建立；null = 未就绪）。</summary>
        public string SessionFolder { get; private set; }

        public bool IsRecording => activeClip != null;

        /// <summary>
        /// Replay 链路要求的统一录音格式：16kHz / 单声道 / 16bit PCM（WAV）——
        /// 与 sidecar Seed ASR 请求体（rate=16000, channel=1, bits=16）及声纹模型（16k）对齐，
        /// 录音文件可直接进入后续 ASR/说话人识别/图文生成流程，无需二次重采样。
        /// </summary>
        public const int TargetSampleRate = 16000;
        public const int TargetChannels = 1;

        /// <summary>录音采样率：优先用目标 16kHz（Replay 链路要求）；设备不支持时回退设备上限。</summary>
        private const int FallbackSampleRate = 16000;

        /// <summary>当前采集中的 AudioClip（null = 未在录音）。</summary>
        private AudioClip activeClip;

        /// <summary>本段录音开始的本地时间（停止时用于命名文件与记录时长）。</summary>
        private DateTime segmentStartTime;

        /// <summary>录音设备名（null = 系统默认设备）。</summary>
        private string deviceName;

        private void Awake()
        {
            // 一局开始：建立本局录音文件夹
            try
            {
                SessionFolder = Path.Combine(RecordingsRoot, SessionFolderName(DateTime.Now));
                Directory.CreateDirectory(SessionFolder);
                Debug.Log($"[RecordingManager] 本局录音目录: {SessionFolder}");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[RecordingManager] 无法创建录音目录: {ex.Message}");
                SessionFolder = null; // 目录不可用时录音会被拒绝（见 StartRecording）
            }
        }

        private void OnDestroy()
        {
            // 一局结束：正在录的段也停止（不丢数据）
            StopRecording();
        }

        /// <summary>开始录音：开启麦克风采集。目录未就绪或已在录音时忽略，返回是否成功开始。</summary>
        public bool StartRecording()
        {
            if (activeClip != null)
            {
                Debug.LogWarning("[RecordingManager] 已在录音中，忽略重复开始");
                return false;
            }

            if (string.IsNullOrEmpty(SessionFolder))
            {
                Debug.LogError("[RecordingManager] 录音目录未就绪（本局文件夹创建失败？），无法开始录音");
                return false;
            }

            if (Microphone.devices.Length == 0)
            {
                Debug.LogError("[RecordingManager] 未检测到录音设备，无法开始录音");
                return false;
            }

            deviceName = null; // null = 默认设备
            var sampleRate = GetSampleRate(deviceName);
            // 开始时间在启动设备「之前」取：Microphone.Start 可能耗时数百毫秒，
            // 先取才是本段录音真正的开始时刻（也是文件名的依据）
            segmentStartTime = DateTime.Now;
            // 长时间录音：clip 长度设为 3600s，防止 Microphone 循环覆盖；停止时按实际录到的时长截取
            activeClip = Microphone.Start(deviceName, false, 3600, sampleRate);
            if (activeClip == null)
            {
                Debug.LogError("[RecordingManager] Microphone.Start 返回 null，无法开始录音");
                return false;
            }

            Debug.Log($"[RecordingManager] 开始录音 @ {FormatStamp(segmentStartTime)} (samplerate={sampleRate})");
            return true;
        }

        /// <summary>停止录音：把本段音频编码成 WAV 写入本局文件夹，文件名 = 录音开始时间。
        /// 未在录音时忽略；正在录音则停止采集、保存文件，返回保存的文件路径（失败返回 null）。</summary>
        public string StopRecording()
        {
            if (activeClip == null)
            {
                return null;
            }

            // 先在 End 前取录制位置（End 后 GetPosition 可能返回 -1/失效），再停设备
            var position = Microphone.GetPosition(deviceName);
            Microphone.End(deviceName);
            var clip = activeClip;
            var startTime = segmentStartTime;
            activeClip = null;

            if (string.IsNullOrEmpty(SessionFolder))
            {
                Debug.LogError("[RecordingManager] 录音目录未就绪，无法保存录音");
                return null;
            }

            // 实际录到的采样数：Microphone 的 clip 按固定长度创建，用 position 截断到实际录制长度
            var recordedSamples = position > 0 ? position : clip.samples;
            var filePath = BuildFilePath(startTime);
            try
            {
                var data = new float[clip.samples * clip.channels];
                clip.GetData(data, 0);
                // Replay 链路要求 16kHz 单声道：麦克风若返回立体声/多声道，先降混成单声道再编码
                var mono = DownmixToMono(data, clip.channels, recordedSamples);
                var bytes = WavEncoder.Encode16BitPcm(mono, TargetChannels, clip.frequency, recordedSamples);
                File.WriteAllBytes(filePath, bytes);
                Debug.Log($"[RecordingManager] 已保存录音: {filePath} ({recordedSamples} samples {clip.frequency}Hz → {TargetChannels}ch {TargetSampleRate}Hz目标, 原始 {clip.channels}ch @{clip.frequency}Hz)");

                // 本局 Replay 会话就绪时，自动把该分段上传到后端（异步，失败保留本地文件）
                var replay = Game.Instance != null ? Game.Instance.ReplayClient : null;
                if (replay != null)
                {
                    replay.QueueUploadSegment(filePath);
                }

                return filePath;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[RecordingManager] 保存录音失败: {ex.Message}");
                return null;
            }
            finally
            {
                Destroy(clip);
            }
        }

        /// <summary>
        /// 交错多声道 float 采样 → 单声道（每帧取各声道均值）。帧数 = recordedSamples（已按录制位置截断）。
        /// 输入 data 长度为 frames * channels；单声道时原样返回数据段（避免拷贝）。
        /// public：编辑器测试程序集（Assembly-CSharp-Editor）与运行时分离，必须公开才能被单测访问。
        /// </summary>
        public static float[] DownmixToMono(float[] data, int channels, int frames)
        {
            if (channels <= 1)
            {
                // 单声道：直接截断到实际录制帧数
                if (frames == data.Length)
                {
                    return data;
                }

                var trim = new float[frames];
                Array.Copy(data, trim, frames);
                return trim;
            }

            var mono = new float[frames];
            for (int f = 0; f < frames; f++)
            {
                float sum = 0f;
                for (int c = 0; c < channels; c++)
                {
                    sum += data[f * channels + c];
                }
                mono[f] = sum / channels;
            }
            return mono;
        }

        /// <summary>
        /// 生成本段录音的文件路径：文件名 = 录音开始时间（yyyy-MM-dd_HH-mm-ss.wav）。
        /// 同一秒内开始的多段录音会撞名，此时追加 _2、_3… 递增后缀避免互相覆盖
        ///（一局允许多个录音文件，绝不能因重名丢数据）。
        /// </summary>
        private string BuildFilePath(DateTime startTime)
        {
            return BuildSegmentFilePath(SessionFolder, startTime);
        }

        /// <summary>
        /// 依据「本局文件夹 + 录音开始时间」生成本段录音文件路径（纯函数，便于单元测试）。
        /// 撞名（同一秒内多段录音）时追加 _2、_3… 递增后缀，保证一局内多段录音互不覆盖。
        /// </summary>
        public static string BuildSegmentFilePath(string sessionFolder, DateTime startTime)
        {
            var stamp = FormatStamp(startTime);
            var path = Path.Combine(sessionFolder, stamp + ".wav");
            if (!File.Exists(path))
            {
                return path;
            }

            for (int i = 2; i < 1000; i++)
            {
                var candidate = Path.Combine(sessionFolder, $"{stamp}_{i}.wav");
                if (!File.Exists(candidate))
                {
                    Debug.LogWarning($"[RecordingManager] 文件名 {stamp}.wav 已存在（同秒内多段录音），改用 {stamp}_{i}.wav");
                    return candidate;
                }
            }

            // 极端情况（同秒 1000 段）：退回带毫秒的命名，保证不覆盖
            return Path.Combine(sessionFolder, startTime.ToString("yyyy-MM-dd_HH-mm-ss-fff") + ".wav");
        }

        /// <summary>本局文件夹命名：游戏开始时间（yyyy-MM-dd_HH-mm-ss）。</summary>
        public static string SessionFolderName(DateTime sessionStart)
        {
            return FormatStamp(sessionStart);
        }

        /// <summary>取设备采样率：优先 Replay 链路目标 16kHz；设备不支持时取支持范围内最接近的值。</summary>
        private static int GetSampleRate(string device)
        {
            try
            {
                Microphone.GetDeviceCaps(device, out int min, out int max);
                // min/max 都为 0 表示设备未报告采样率范围（部分虚拟设备如此），回退默认
                if (min <= 0 || max <= 0)
                {
                    return FallbackSampleRate;
                }

                // Replay 链路统一要求 16kHz（ASR/声纹/分钟分析均按 16k 配置）：设备支持则锁定用
                if (min <= TargetSampleRate && TargetSampleRate <= max)
                {
                    return TargetSampleRate;
                }

                // 设备不支持 16kHz：取支持范围内最接近的边界（录音仍可保存，喂链路前需重采样）
                return TargetSampleRate < min ? min : max;
            }
            catch
            {
                return FallbackSampleRate;
            }
        }

        private static string FormatStamp(DateTime time)
        {
            return time.ToString("yyyy-MM-dd_HH-mm-ss");
        }
    }

    /// <summary>
    /// 把 float PCM 采样编码为 16bit PCM WAV 字节（文件头 + 数据块）。
    /// 纯静态工具，便于单元测试（不依赖 Unity 音频运行时）。
    /// </summary>
    public static class WavEncoder
    {
        /// <summary>
        /// 编码为 16bit PCM WAV。
        /// </summary>
        /// <param name="samples">交错采样（channels 个声道按帧交错，长度 = totalFrames * channels）。</param>
        /// <param name="channels">声道数（≥1）。</param>
        /// <param name="sampleRate">采样率（>0）。</param>
        /// <param name="recordedSamples">实际录到的采样数（≤ samples.Length；超出按全部处理）。</param>
        public static byte[] Encode16BitPcm(float[] samples, int channels, int sampleRate, int recordedSamples)
        {
            if (samples == null || samples.Length == 0)
            {
                return new byte[0];
            }

            channels = Mathf.Max(1, channels);
            sampleRate = Mathf.Max(1, sampleRate);
            var count = Mathf.Clamp(recordedSamples, 0, samples.Length);

            var dataSize = count * 2; // 16bit = 2 bytes / sample
            var bytes = new byte[44 + dataSize]; // 44 = WAV 头固定长度

            // RIFF 头
            WriteAscii(bytes, 0, "RIFF");
            WriteInt32(bytes, 4, 36 + dataSize);
            WriteAscii(bytes, 8, "WAVE");

            // fmt 块
            WriteAscii(bytes, 12, "fmt ");
            WriteInt32(bytes, 16, 16);          // fmt 块大小
            WriteInt16(bytes, 20, 1);           // PCM 格式
            WriteInt16(bytes, 22, (short)channels);
            WriteInt32(bytes, 24, sampleRate);
            WriteInt32(bytes, 28, sampleRate * channels * 2); // byte rate
            WriteInt16(bytes, 32, (short)(channels * 2));     // block align
            WriteInt16(bytes, 34, 16);          // bits per sample

            // data 块
            WriteAscii(bytes, 36, "data");
            WriteInt32(bytes, 40, dataSize);

            // 采样数据（交错写入）
            for (int i = 0; i < count; i++)
            {
                var v = samples[i];
                // float [-1,1] → 16bit short；裁到 [-1,1] 防溢出
                if (v > 1f) v = 1f;
                if (v < -1f) v = -1f;
                var s = (short)(v * short.MaxValue);
                bytes[44 + i * 2] = (byte)(s & 0xFF);
                bytes[44 + i * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }

            return bytes;
        }

        private static void WriteAscii(byte[] buffer, int offset, string text)
        {
            for (int i = 0; i < text.Length; i++)
            {
                buffer[offset + i] = (byte)text[i];
            }
        }

        private static void WriteInt16(byte[] buffer, int offset, short value)
        {
            buffer[offset] = (byte)(value & 0xFF);
            buffer[offset + 1] = (byte)((value >> 8) & 0xFF);
        }

        private static void WriteInt32(byte[] buffer, int offset, int value)
        {
            buffer[offset] = (byte)(value & 0xFF);
            buffer[offset + 1] = (byte)((value >> 8) & 0xFF);
            buffer[offset + 2] = (byte)((value >> 16) & 0xFF);
            buffer[offset + 3] = (byte)((value >> 24) & 0xFF);
        }
    }
}