using System.IO;
using DiceTale;
using NUnit.Framework;

namespace DiceTale.Editor.Tests
{
    /// <summary>
    /// Replay 链路格式对齐测试：录音必须产出 16kHz / 单声道 / 16bit PCM WAV
    /// （sidecar Seed ASR 请求体 rate=16000, channel=1, bits=16；声纹模型 16k），
    /// 录音文件应可直接进入后续 ASR/说话人识别流程，无需二次重采样。
    /// </summary>
    public class RecordingFormatTests
    {
        [Test]
        public void TargetConstants_MatchReplayLinkChain()
        {
            Assert.AreEqual(16000, RecordingManager.TargetSampleRate, "采样率必须为 16kHz（ASR/声纹链路要求）");
            Assert.AreEqual(1, RecordingManager.TargetChannels, "声道必须为单声道（ASR 请求 channel=1）");
        }

        [Test]
        public void DownmixToMono_StereoAveragesChannels()
        {
            // 2 声道交错 [L0,R0, L1,R1, ...]，帧数 = 3
            var stereo = new float[] { 1f, 0f, 0.5f, 0.5f, 0f, 1f };
            var mono = RecordingManager.DownmixToMono(stereo, 2, 3);

            Assert.AreEqual(3, mono.Length, "帧数不变");
            Assert.AreEqual(0.5f, mono[0], 1e-6f); // (1+0)/2
            Assert.AreEqual(0.5f, mono[1], 1e-6f); // (0.5+0.5)/2
            Assert.AreEqual(0.5f, mono[2], 1e-6f); // (0+1)/2
        }

        [Test]
        public void DownmixToMono_QuadChannelsAveragesAll()
        {
            // 4 声道，1 帧
            var quad = new float[] { 0.1f, 0.2f, 0.3f, 0.4f };
            var mono = RecordingManager.DownmixToMono(quad, 4, 1);
            Assert.AreEqual(1, mono.Length);
            Assert.AreEqual(0.25f, mono[0], 1e-6f);
        }

        [Test]
        public void DownmixToMono_MonoTrimsToRecordedFrames()
        {
            var data = new float[] { 1f, 2f, 3f, 4f, 5f };
            // 实际只录了 3 帧
            var mono = RecordingManager.DownmixToMono(data, 1, 3);
            Assert.AreEqual(3, mono.Length);
            Assert.AreEqual(1f, mono[0]);
            Assert.AreEqual(3f, mono[2]);
        }

        [Test]
        public void EncodedWav_ReportsMono16kHeader()
        {
            // 单声道 16kHz：编码后 WAV 头应是 1ch / 16000Hz / 16bit
            var frames = 1600; // 0.1s
            var mono = new float[frames];
            for (int i = 0; i < frames; i++) mono[i] = 0.5f;
            var bytes = WavEncoder.Encode16BitPcm(mono, 1, 16000, frames);

            Assert.AreEqual(1, System.BitConverter.ToInt16(bytes, 22), "channels=1");
            Assert.AreEqual(16000, System.BitConverter.ToInt32(bytes, 24), "sample rate=16000");
            Assert.AreEqual(16, System.BitConverter.ToInt16(bytes, 34), "bits=16");
            Assert.AreEqual(frames * 2, System.BitConverter.ToInt32(bytes, 40), "data 块 = 帧数*2 字节");
        }

        [Test]
        public void EndToEnd_StereoClipEncodesAsMono16kWav()
        {
            // 模拟立体声麦克风：2ch 16k，走「降混 + 编码」产出单声道 WAV
            var frames = 800; // 0.05s
            var stereo = new float[frames * 2];
            for (int i = 0; i < frames; i++)
            {
                stereo[i * 2] = 0.3f;
                stereo[i * 2 + 1] = 0.5f; // 两声道不同
            }
            var mono = RecordingManager.DownmixToMono(stereo, 2, frames);
            var bytes = WavEncoder.Encode16BitPcm(mono, 1, 16000, frames);

            Assert.AreEqual(1, System.BitConverter.ToInt16(bytes, 22), "输出必须单声道");
            Assert.AreEqual(16000, System.BitConverter.ToInt32(bytes, 24), "输出必须 16kHz");
            // 每个采样 = (0.3+0.5)/2 = 0.4 → 0.4*32767
            var s0 = System.BitConverter.ToInt16(bytes, 44);
            Assert.AreEqual((short)(0.4f * short.MaxValue), s0);
        }
    }
}