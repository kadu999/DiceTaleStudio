using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 输入配置的本地持久化（PlayerPrefs）：目前只有指挥 Id（CommandId，协议 key=first_contact_id）。
    /// 目的：客户端重启 / 场景重载后仍能恢复 GM 设置的值并重新上报后台——
    /// 配合后台"断开不清 inputConfig"，前后端值保持一致、GM 页刷新不丢。
    /// </summary>
    public static class InputConfigPrefs
    {
        private const string CommandIdKey = "input_config.first_contact_id";

        /// <summary>读取持久化的指挥 Id（无记录或越界返回 Unassigned）。</summary>
        public static PointerId LoadCommandId()
        {
            if (!PlayerPrefs.HasKey(CommandIdKey))
            {
                return PointerId.Unassigned;
            }

            int value = Mathf.Clamp(PlayerPrefs.GetInt(CommandIdKey),
                (int)PointerId.Unassigned, (int)PointerId.MultiTouch);
            return (PointerId)value;
        }

        /// <summary>保存指挥 Id（落盘，供重启/场景重载恢复）。</summary>
        public static void SaveCommandId(PointerId value)
        {
            PlayerPrefs.SetInt(CommandIdKey, (int)value);
            PlayerPrefs.Save();
        }
    }
}