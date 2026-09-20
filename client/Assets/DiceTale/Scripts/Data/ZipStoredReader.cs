using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace DiceTale
{
    /// <summary>
    /// 读 **STORED（不压缩）zip** 的最小实现——用来解开服务端下发的资源包。
    ///
    /// **为什么不直接用 `System.IO.Compression.ZipArchive`**：在 Unity 2023+/6 里它被类型转发到
    /// `System.IO.Compression.dll`，而这个程序集**不在 Unity 的受管程序集里**（`Editor/Data/Managed`
    /// 与 `Managed/UnityEngine` 都没有它）。用了就是 `error CS1069 / 缺少程序集`，运行期还会
    /// `TypeLoadException`。绕开它有三条路：加 NuGet 包（引入二进制依赖 + IL2CPP 风险）、
    /// 换 deflate 实现（没必要）、或**自己读**。
    ///
    /// 而服务端的包是**刻意 STORED 的**（素材本身已是压缩格式），所以「解压」只是
    /// 「按中央目录的偏移把字节搬出来」——不需要 deflate，也就没有任何依赖。
    ///
    /// 校验：逐条比对中央目录里记的 **CRC32**，数据被截断 / 写坏会当场抛错，
    /// 不会把坏文件当好的写进本地包。
    /// </summary>
    public static class ZipStoredReader
    {
        private const uint LocalHeaderSignature = 0x04034b50;
        private const uint CentralHeaderSignature = 0x02014b50;
        private const uint EndOfCentralSignature = 0x06054b50;

        private const int LocalHeaderLength = 30;
        private const int CentralHeaderLength = 46;
        private const int EndOfCentralLength = 22;

        /// <summary>包内一个条目。</summary>
        public readonly struct Entry
        {
            /// <summary>条目名（服务端写的是 UTF-8，即 `Assets/images/Map001.png` 这种项目根相对路径）。</summary>
            public readonly string Name;

            internal readonly long DataOffset;
            internal readonly int Size;
            internal readonly uint Crc;

            internal Entry(string name, long dataOffset, int size, uint crc)
            {
                Name = name;
                DataOffset = dataOffset;
                Size = size;
                Crc = crc;
            }
        }

        /// <summary>
        /// 读出中央目录里的全部条目（只读元数据，不搬字节）。
        ///
        /// `zip` 必须是**可 Seek** 的流（本地文件都满足）。返回的条目顺序即包内写入顺序。
        /// </summary>
        public static IReadOnlyList<Entry> ReadEntries(Stream zip)
        {
            if (zip == null || !zip.CanSeek)
            {
                throw new ArgumentException("需要一个可 Seek 的 zip 流", nameof(zip));
            }

            var endOffset = FindEndOfCentralDirectory(zip);
            var total = ReadUInt16(zip, endOffset + 10);
            var centralOffset = ReadUInt32(zip, endOffset + 16);

            var entries = new List<Entry>(total);
            var cursor = (long)centralOffset;

            for (var index = 0; index < total; index++)
            {
                if (ReadUInt32(zip, cursor) != CentralHeaderSignature)
                {
                    throw new InvalidDataException($"第 {index} 条中央目录签名不对（偏移 {cursor}）");
                }

                var method = ReadUInt16(zip, cursor + 10);
                if (method != 0)
                {
                    throw new InvalidDataException(
                        $"条目压缩方式不是 STORED（0）：{method}——资源包应当是未压缩的");
                }

                var crc = ReadUInt32(zip, cursor + 16);
                var size = (int)ReadUInt32(zip, cursor + 24);
                var nameLength = ReadUInt16(zip, cursor + 28);
                var extraLength = ReadUInt16(zip, cursor + 30);
                var commentLength = ReadUInt16(zip, cursor + 32);
                var localOffset = ReadUInt32(zip, cursor + 42);

                zip.Position = cursor + CentralHeaderLength;
                var name = ReadUtf8(zip, nameLength);

                // 本地头：数据紧跟在它的 name/extra 之后
                if (ReadUInt32(zip, localOffset) != LocalHeaderSignature)
                {
                    throw new InvalidDataException($"条目「{name}」的本地头签名不对");
                }

                var localNameLength = ReadUInt16(zip, localOffset + 26);
                var localExtraLength = ReadUInt16(zip, localOffset + 28);
                var dataOffset = (long)localOffset + LocalHeaderLength + localNameLength + localExtraLength;

                if (size < 0)
                {
                    throw new InvalidDataException($"条目「{name}」大小非法：{size}");
                }

                entries.Add(new Entry(name, dataOffset, size, crc));
                cursor += CentralHeaderLength + nameLength + extraLength + commentLength;
            }

            return entries;
        }

        /// <summary>
        /// 把整包解到 <paramref name="destinationRoot"/>（目录会按条目名自动建）。
        ///
        /// **顺带挡住 zip slip**：条目名里带 `..` 试图写出目标目录时抛错，不落盘。
        /// </summary>
        public static int ExtractAll(Stream zip, string destinationRoot)
        {
            return ExtractAll(zip, destinationRoot, null);
        }

        /// <summary>
        /// 同上，但可以把**包内条目名**映射成**本地相对路径**再落盘。
        ///
        /// 资源包用得上：服务端的条目名是 `Assets/images/Map001.png`（那是服务端项目内的目录名），
        /// 而客户端本地不保留 `Assets/` 这一层，由 <see cref="LocalResourceStore.LocalRelativePathOfZipEntry"/>
        /// 剥掉。映射返回 null 的条目会被**跳过**（不在预期内的条目宁可不要，也不乱落盘）。
        /// </summary>
        public static int ExtractAll(Stream zip, string destinationRoot, Func<string, string> mapEntryName)
        {
            var entries = ReadEntries(zip);
            var root = Path.GetFullPath(destinationRoot);
            var prefix = root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? root
                : root + Path.DirectorySeparatorChar;
            var written = 0;

            foreach (var entry in entries)
            {
                // 目录条目（以 / 结尾）没有内容
                if (entry.Name.Length == 0 || entry.Name.EndsWith("/", StringComparison.Ordinal))
                {
                    continue;
                }

                var relative = mapEntryName == null ? entry.Name : mapEntryName(entry.Name);
                if (string.IsNullOrEmpty(relative))
                {
                    continue;
                }

                var target = Path.GetFullPath(
                    Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(prefix, StringComparison.Ordinal))
                {
                    throw new InvalidDataException($"条目越出解压目录：{entry.Name}");
                }

                var directory = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                WriteEntry(zip, entry, target);
                written++;
            }

            return written;
        }

        /// <summary>解开单条（写文件 + 校验 CRC）。</summary>
        private static void WriteEntry(Stream zip, Entry entry, string target)
        {
            zip.Position = entry.DataOffset;
            var crc = 0xffffffffu;
            var buffer = new byte[Math.Min(entry.Size, 128 * 1024)];
            var remaining = entry.Size;

            using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                while (remaining > 0)
                {
                    var want = Math.Min(remaining, buffer.Length);
                    var read = zip.Read(buffer, 0, want);
                    if (read <= 0)
                    {
                        throw new InvalidDataException($"条目「{entry.Name}」数据不足（期望 {entry.Size} 字节）");
                    }

                    output.Write(buffer, 0, read);
                    for (var index = 0; index < read; index++)
                    {
                        crc = CrcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >> 8);
                    }

                    remaining -= read;
                }
            }

            var actual = crc ^ 0xffffffffu;
            if (actual != entry.Crc)
            {
                throw new InvalidDataException(
                    $"条目「{entry.Name}」CRC 校验失败（期望 {entry.Crc:x8}，实得 {actual:x8}）");
            }
        }

        /// <summary>从尾部往前找 EOCD（注释最长 65535 字节，所以最多回退这么远）。</summary>
        private static long FindEndOfCentralDirectory(Stream zip)
        {
            var length = zip.Length;
            var minimum = Math.Max(0, length - EndOfCentralLength - 65535);

            for (var offset = length - EndOfCentralLength; offset >= minimum; offset--)
            {
                if (ReadUInt32(zip, offset) == EndOfCentralSignature)
                {
                    return offset;
                }
            }

            throw new InvalidDataException("找不到 zip 的中央目录结尾（EOCD）——这不是一个 zip");
        }

        private static ushort ReadUInt16(Stream zip, long offset)
        {
            zip.Position = offset;
            var low = zip.ReadByte();
            var high = zip.ReadByte();
            if (low < 0 || high < 0)
            {
                throw new InvalidDataException("zip 数据意外结束");
            }

            return (ushort)(low | (high << 8));
        }

        private static uint ReadUInt32(Stream zip, long offset)
        {
            zip.Position = offset;
            var value = 0u;
            for (var index = 0; index < 4; index++)
            {
                var next = zip.ReadByte();
                if (next < 0)
                {
                    throw new InvalidDataException("zip 数据意外结束");
                }

                value |= (uint)next << (8 * index);
            }

            return value;
        }

        private static string ReadUtf8(Stream zip, int length)
        {
            var bytes = new byte[length];
            var read = 0;
            while (read < length)
            {
                var chunk = zip.Read(bytes, read, length - read);
                if (chunk <= 0)
                {
                    throw new InvalidDataException("zip 数据意外结束");
                }

                read += chunk;
            }

            return Encoding.UTF8.GetString(bytes);
        }

        /// <summary>CRC32（与 zip 用的同一个多项式）。自己算，不依赖任何程序集。</summary>
        private static readonly uint[] CrcTable = BuildCrcTable();

        private static uint[] BuildCrcTable()
        {
            var table = new uint[256];
            for (uint index = 0; index < 256; index++)
            {
                var value = index;
                for (var bit = 0; bit < 8; bit++)
                {
                    value = (value & 1) != 0 ? 0xedb88320u ^ (value >> 1) : value >> 1;
                }

                table[index] = value;
            }

            return table;
        }
    }
}
