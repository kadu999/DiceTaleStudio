using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 玩家身份字段（2026-09-02）：角色显示名 + 职业。数值属性（生命/理智/幸运/CoC 属性/检定）
    /// 已迁到 <see cref="AttributeList"/> 通用属性表（同一物体上，供后台 set_int 修改与 UI 动态渲染）。
    /// 挂在 Player.prefab 上，与 BackendObject / Backpack / AttributeList 同物体。
    /// </summary>
    public class PlayerStats : MonoBehaviour
    {
        [SerializeField, Tooltip("角色显示名（面板显示用；空则回退 BackendObject.DisplayName 的 Player_N）")]
        private string displayName = "张远志";

        [SerializeField, Tooltip("职业（角色卡身份行，如 摄影记者·调查员）")]
        private string role = "摄影记者·调查员";

        /// <summary>角色显示名（空则 UI 回退 GM 的 Player_N 占位名）。</summary>
        public string DisplayName => displayName;

        /// <summary>职业。</summary>
        public string Role => role;

        /// <summary>设置玩家身份（创建角色时按玩家序号写入：显示名 = Player_{N}、职业位 = 角色 ID Character00N）。
        /// 修复默认值固定（张远志/摄影记者·调查员）导致多玩家面板全部显示同一身份的问题。</summary>
        public void SetIdentity(string name, string role)
        {
            if (name != null)
            {
                displayName = name;
            }

            if (role != null)
            {
                this.role = role;
            }
        }
    }
}
