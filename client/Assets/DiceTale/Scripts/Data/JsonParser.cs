using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 轻量 JSON 解析器。Unity 的 JsonUtility 不支持字典反序列化
    /// （服务器 sync_state 的 objects 是 objectId -> 状态的映射），因此接收消息统一用它解析。
    /// 支持：对象、数组、字符串、数字、布尔、null。
    /// </summary>
    public static class JsonParser
    {
        public static Dictionary<string, object> ParseObject(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            try
            {
                var parser = new Parser(json);
                return parser.ParseValue() as Dictionary<string, object>;
            }
            catch (FormatException ex)
            {
                // 非法 JSON 不抛给调用方，返回 null；打日志便于排查「整条消息被静默丢弃」的根因
                Debug.LogWarning($"[JsonParser] JSON 解析失败（消息已丢弃）: {ex.Message}");
                return null;
            }
            catch (OverflowException ex)
            {
                // 数字溢出（如 1e999）在不同运行时可能抛 OverflowException 而非 FormatException
                Debug.LogWarning($"[JsonParser] JSON 数字溢出（消息已丢弃）: {ex.Message}");
                return null;
            }
        }

        // ---- 类型安全取值辅助 ----

        public static string GetString(Dictionary<string, object> obj, string key)
        {
            if (obj != null && obj.TryGetValue(key, out var value) && value is string s)
            {
                return s;
            }

            return null;
        }

        public static bool GetBool(Dictionary<string, object> obj, string key, bool fallback = false)
        {
            if (obj != null && obj.TryGetValue(key, out var value) && value is bool b)
            {
                return b;
            }

            return fallback;
        }

        public static double GetNumber(Dictionary<string, object> obj, string key, double fallback = 0)
        {
            if (obj != null && obj.TryGetValue(key, out var value) && value is double d)
            {
                return d;
            }

            return fallback;
        }

        public static Dictionary<string, object> GetObject(Dictionary<string, object> obj, string key)
        {
            if (obj != null && obj.TryGetValue(key, out var value) && value is Dictionary<string, object> d)
            {
                return d;
            }

            return null;
        }

        public static List<object> GetArray(Dictionary<string, object> obj, string key)
        {
            if (obj != null && obj.TryGetValue(key, out var value) && value is List<object> list)
            {
                return list;
            }

            return null;
        }

        // ---- 内部解析器 ----

        private sealed class Parser
        {
            /// <summary>最大嵌套深度：抵御恶意/异常深嵌套导致栈溢出（StackOverflow 不可捕获，会直接崩进程）。</summary>
            private const int MaxDepth = 128;

            private readonly string text;
            private int pos;
            private int depth;

            public Parser(string text)
            {
                this.text = text;
            }

            public object ParseValue()
            {
                SkipWhitespace();
                if (pos >= text.Length)
                {
                    return null;
                }

                switch (text[pos])
                {
                    case '{':
                        return ParseObject();
                    case '[':
                        return ParseArray();
                    case '"':
                        return ParseString();
                    case 't':
                        Expect("true");
                        return true;
                    case 'f':
                        Expect("false");
                        return false;
                    case 'n':
                        Expect("null");
                        return null;
                    default:
                        return ParseNumber();
                }
            }

            private Dictionary<string, object> ParseObject()
            {
                EnterDepth();
                var result = new Dictionary<string, object>();
                pos++; // '{'

                SkipWhitespace();
                if (Peek() == '}')
                {
                    pos++;
                    LeaveDepth();
                    return result;
                }

                while (true)
                {
                    SkipWhitespace();
                    var key = ParseString();
                    SkipWhitespace();
                    ExpectChar(':');
                    var value = ParseValue();
                    result[key] = value;

                    SkipWhitespace();
                    var c = NextChar();
                    if (c == '}')
                    {
                        break;
                    }

                    if (c != ',')
                    {
                        throw new FormatException($"Unexpected char '{c}' in object at position {pos}");
                    }
                }

                LeaveDepth();
                return result;
            }

            private List<object> ParseArray()
            {
                EnterDepth();
                var result = new List<object>();
                pos++; // '['

                SkipWhitespace();
                if (Peek() == ']')
                {
                    pos++;
                    LeaveDepth();
                    return result;
                }

                while (true)
                {
                    result.Add(ParseValue());
                    SkipWhitespace();
                    var c = NextChar();
                    if (c == ']')
                    {
                        break;
                    }

                    if (c != ',')
                    {
                        throw new FormatException($"Unexpected char '{c}' in array at position {pos}");
                    }
                }

                LeaveDepth();
                return result;
            }

            private void EnterDepth()
            {
                depth++;
                if (depth > MaxDepth)
                {
                    throw new FormatException($"JSON 嵌套过深（超过 {MaxDepth} 层）");
                }
            }

            private void LeaveDepth()
            {
                depth--;
            }

            private string ParseString()
            {
                var sb = new StringBuilder();
                pos++; // '"'

                while (pos < text.Length)
                {
                    var c = text[pos++];
                    if (c == '"')
                    {
                        return sb.ToString();
                    }

                    if (c == '\\')
                    {
                        if (pos >= text.Length)
                        {
                            throw new FormatException("Unterminated escape sequence");
                        }

                        var e = text[pos++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (pos + 4 > text.Length)
                                {
                                    throw new FormatException("Invalid \\u escape");
                                }

                                var hex = text.Substring(pos, 4);
                                sb.Append((char)int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                                pos += 4;
                                break;
                            default:
                                throw new FormatException($"Invalid escape sequence '\\{e}'");
                        }
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }

                throw new FormatException("Unterminated string");
            }

            private double ParseNumber()
            {
                var start = pos;
                while (pos < text.Length && "-+0123456789.eE".IndexOf(text[pos]) >= 0)
                {
                    pos++;
                }

                if (pos == start)
                {
                    throw new FormatException($"Unexpected char '{text[pos]}' at position {pos}");
                }

                var token = text.Substring(start, pos - start);
                return double.Parse(token, CultureInfo.InvariantCulture);
            }

            private char Peek()
            {
                return pos < text.Length ? text[pos] : '\0';
            }

            private char NextChar()
            {
                if (pos >= text.Length)
                {
                    throw new FormatException("Unexpected end of JSON");
                }

                return text[pos++];
            }

            private void ExpectChar(char c)
            {
                var actual = NextChar();
                if (actual != c)
                {
                    throw new FormatException($"Expected '{c}' but found '{actual}' at position {pos - 1}");
                }
            }

            private void Expect(string word)
            {
                if (pos + word.Length > text.Length || text.Substring(pos, word.Length) != word)
                {
                    throw new FormatException($"Expected '{word}' at position {pos}");
                }

                pos += word.Length;
            }

            private void SkipWhitespace()
            {
                // char.IsWhiteSpace 不涵盖 UTF-8 BOM（\uFEFF）：显式跳过，防止带头 BOM 的 JSON 被当作非法字符整条作废
                while (pos < text.Length && (char.IsWhiteSpace(text[pos]) || text[pos] == '\uFEFF'))
                {
                    pos++;
                }
            }
        }
    }
}
