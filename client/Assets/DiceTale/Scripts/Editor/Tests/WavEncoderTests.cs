using System;
using System.IO;
using DiceTale;
using NUnit.Framework;
using UnityEngine;

namespace DiceTale.Editor.Tests
{
    public class WavEncoderTests
    {
        [Test]
        public void Encodes44ByteHeaderWithCorrectFields()
        {
            var samples = new float[4];
            var bytes = WavEncoder.Encode16BitPcm(samples, 1, 44100, 4);

            Assert.AreEqual(44 + 4 * 2, bytes.Length);
            // RIFF / WAVE 标识
            Assert.AreEqual("RIFF", Ascii(bytes, 0, 4));
            Assert.AreEqual("WAVE", Ascii(bytes, 8, 4));
            Assert.AreEqual("fmt ", Ascii(bytes, 12, 4));
            Assert.AreEqual("data", Ascii(bytes, 36, 4));
            // fmt 字段：PCM=1、单声道、采样率、位深
            Assert.AreEqual(1, BitConverter.ToInt16(bytes, 20));
            Assert.AreEqual(1, BitConverter.ToInt16(bytes, 22));
            Assert.AreEqual(44100, BitConverter.ToInt32(bytes, 24));
            Assert.AreEqual(16, BitConverter.ToInt16(bytes, 34));
            // data 块大小 = 采样数 * 2
            Assert.AreEqual(4 * 2, BitConverter.ToInt32(bytes, 40));
        }

        [Test]
        public void ClampsSamplesToShortRange()
        {
            // +1.0 → 32767；-1.0 → -32768（short.MinValue 近似，见编码截断）
            var samples = new[] { 1f, -1f };
            var bytes = WavEncoder.Encode16BitPcm(samples, 1, 44100, 2);

            var s0 = BitConverter.ToInt16(bytes, 44);
            var s1 = BitConverter.ToInt16(bytes, 46);
            Assert.AreEqual(short.MaxValue, s0);
            Assert.That(Math.Abs(s1 - short.MinValue) <= 1, "负半轴 -1.0 应编码为接近 -32768");
        }

        [Test]
        public void InterleavesStereoChannels()
        {
            // 双声道交错：帧 = [L, R]
            var samples = new float[] { 0.5f, -0.5f, 0.25f, -0.25f };
            var bytes = WavEncoder.Encode16BitPcm(samples, 2, 48000, 4);

            Assert.AreEqual(2, BitConverter.ToInt16(bytes, 22)); // channels
            Assert.AreEqual(48000, BitConverter.ToInt32(bytes, 24));
            Assert.AreEqual(2 * 2, BitConverter.ToInt16(bytes, 32)); // block align = 4

            // L0 = 0.5 * 32767
            Assert.AreEqual((short)(0.5f * short.MaxValue), BitConverter.ToInt16(bytes, 44));
            // R0 = -0.5 * 32767
            Assert.AreEqual((short)(-0.5f * short.MaxValue), BitConverter.ToInt16(bytes, 46));
        }

        [Test]
        public void RecordedSamplesTruncatesData()
        {
            var samples = new float[10];
            var bytes = WavEncoder.Encode16BitPcm(samples, 1, 44100, 3);
            Assert.AreEqual(44 + 3 * 2, bytes.Length);
        }

        [Test]
        public void EmptyInputReturnsEmptyBytes()
        {
            Assert.AreEqual(0, WavEncoder.Encode16BitPcm(null, 1, 44100, 0).Length);
            Assert.AreEqual(0, WavEncoder.Encode16BitPcm(new float[0], 1, 44100, 0).Length);
        }

        [Test]
        public void WrittenFileIsReadableByWaveHeader()
        {
            // 端到端：写入临时文件，校验头部可被标准 WAV 头解析（长度 + RIFF 标识）
            var samples = new float[1600];
            var bytes = WavEncoder.Encode16BitPcm(samples, 1, 8000, 1600);
            var tmp = Path.Combine(Path.GetTempPath(), "dice_tale_rec_test.wav");
            File.WriteAllBytes(tmp, bytes);

            try
            {
                var fileSize = new FileInfo(tmp).Length;
                Assert.AreEqual(bytes.Length, fileSize);
                using var fs = File.OpenRead(tmp);
                var header = new byte[44];
                fs.Read(header, 0, 44);
                Assert.AreEqual("RIFF", Ascii(header, 0, 4));
                Assert.AreEqual("WAVE", Ascii(header, 8, 4));
                // RIFF 声明的文件大小（自身后全部内容）与文件实际大小一致
                var declared = BitConverter.ToInt32(header, 4) + 8;
                Assert.AreEqual(bytes.Length, declared);
            }
            finally
            {
                File.Delete(tmp);
            }
        }

        private static string Ascii(byte[] buffer, int offset, int length)
        {
            return System.Text.Encoding.ASCII.GetString(buffer, offset, length);
        }
    }
}