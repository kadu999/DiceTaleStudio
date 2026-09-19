using System;
using System.IO;
using DiceTale;
using NUnit.Framework;

namespace DiceTale.Editor.Tests
{
    /// <summary>
    /// 录音存储布局测试：一局一个文件夹、一段一个文件（按录音开始时间命名）、
    /// 同秒多段不互相覆盖（一局允许多个录音文件，不能因重名丢数据）。
    /// </summary>
    public class RecordingLayoutTests
    {
        private string folder;

        [SetUp]
        public void SetUp()
        {
            folder = Path.Combine(Path.GetTempPath(), "dicetale_rec_layout_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(folder))
            {
                Directory.Delete(folder, true);
            }
        }

        [Test]
        public void SessionFolderName_UsesGameStartTime()
        {
            var name = RecordingManager.SessionFolderName(new DateTime(2026, 2, 14, 15, 30, 0));
            Assert.AreEqual("2026-02-14_15-30-00", name);
        }

        [Test]
        public void SegmentFilePath_UsesRecordingStartTime()
        {
            var path = RecordingManager.BuildSegmentFilePath(folder, new DateTime(2026, 2, 14, 15, 30, 0));
            Assert.AreEqual("2026-02-14_15-30-00.wav", Path.GetFileName(path));
            Assert.IsTrue(path.StartsWith(folder), "录音文件必须落在本局文件夹内");
        }

        [Test]
        public void SegmentsInSameSecond_DoNotOverwriteEachOther()
        {
            var start = new DateTime(2026, 2, 14, 15, 30, 0);

            var first = RecordingManager.BuildSegmentFilePath(folder, start);
            File.WriteAllBytes(first, new byte[] { 1 });
            var second = RecordingManager.BuildSegmentFilePath(folder, start);
            File.WriteAllBytes(second, new byte[] { 2 });
            var third = RecordingManager.BuildSegmentFilePath(folder, start);
            File.WriteAllBytes(third, new byte[] { 3 });

            Assert.AreEqual("2026-02-14_15-30-00.wav", Path.GetFileName(first));
            Assert.AreEqual("2026-02-14_15-30-00_2.wav", Path.GetFileName(second));
            Assert.AreEqual("2026-02-14_15-30-00_3.wav", Path.GetFileName(third));

            // 一局内多段录音各存一份：同秒三段就是三个文件
            Assert.AreEqual(3, Directory.GetFiles(folder).Length);
        }

        [Test]
        public void SegmentsInDifferentSeconds_EachNamedByItsOwnStart()
        {
            var t0 = new DateTime(2026, 2, 14, 15, 30, 0);
            var p1 = RecordingManager.BuildSegmentFilePath(folder, t0);
            var p2 = RecordingManager.BuildSegmentFilePath(folder, t0.AddSeconds(5));
            var p3 = RecordingManager.BuildSegmentFilePath(folder, t0.AddMinutes(2));

            Assert.AreEqual("2026-02-14_15-30-00.wav", Path.GetFileName(p1));
            Assert.AreEqual("2026-02-14_15-30-05.wav", Path.GetFileName(p2));
            Assert.AreEqual("2026-02-14_15-32-00.wav", Path.GetFileName(p3));
        }
    }
}