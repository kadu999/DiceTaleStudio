using System.Collections.Generic;

namespace DiceTale
{
    /// <summary>
    /// 把服务端推下来的**项目级全局设置**（`project_settings` 的 `settings` 节点）解析成
    /// <see cref="MirrorSettings"/>。
    ///
    /// 与 <see cref="SceneParser"/> 同一套口径：字段可选、可能为 `null`，缺项一律用**与编辑器一致的缺省值**
    /// （三档音量 0.6 / 0.8 / 1）。解析失败返回 `null`，调用方只记一条日志——
    /// 一份坏设置不该让整个会话崩掉（大不了这一场用不上音量）。
    ///
    /// v16 起这里**只有三档音量**：背景音乐的歌单 / 默认曲 / 循环已经从协议里拿掉
    /// （清单就是编辑器弹框里列的项目音频，放哪一首由 `play_bgm{clip}` 命令说）。
    /// </summary>
    public static class SettingsParser
    {
        /// <summary>解析设置节点；节点为空（`settings: null` = 没打开项目）时返回 null。</summary>
        public static MirrorSettings Parse(Dictionary<string, object> node)
        {
            if (node == null)
            {
                return null;
            }

            var settings = new MirrorSettings();
            var audio = JsonParser.GetObject(node, "audio");
            if (audio == null)
            {
                return settings;
            }

            var bgm = JsonParser.GetObject(audio, "bgm");
            if (bgm != null)
            {
                settings.audio.bgm.volume = (float)JsonParser.GetNumber(bgm, "volume", 0.6);
            }

            var sfx = JsonParser.GetObject(audio, "sfx");
            if (sfx != null)
            {
                settings.audio.sfxVolume = (float)JsonParser.GetNumber(sfx, "volume", 0.8);
            }

            var voice = JsonParser.GetObject(audio, "voice");
            if (voice != null)
            {
                settings.audio.voiceVolume = (float)JsonParser.GetNumber(voice, "volume", 1);
            }

            settings.ClampVolumes();
            return settings;
        }
    }
}
