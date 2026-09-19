using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 鍦烘櫙鐘舵€佹爣璁帮細鎸傚湪鍦烘櫙涓綔涓恒€屼竴涓姸鎬併€嶇殑 GameObject 鏍硅妭鐐逛笂锛堝悓涓€鍦烘櫙鍙寕澶氫釜锛夈€?    /// <see cref="GameScene"/> 鏀堕泦鍦烘櫙鍐呭叏閮?SceneState 浣滀负鍦烘櫙鐘舵€佸垪琛ㄤ笂鎶ョ粰 GM 椤甸潰
    /// 锛堝湴鍥句笅鏂逛粠宸﹀埌鍙虫樉绀猴級锛涢€変腑鏌愮姸鎬佸悗瀹㈡埛绔縺娲昏 GameObject銆侀殣钘忎笂涓€涓姸鎬?    /// 锛堝悓涓€鏃跺埢浠呬竴涓姸鎬佹縺娲伙級銆?    /// </summary>
    public class SceneState : MonoBehaviour
    {
        [SerializeField, Tooltip("鐘舵€佹樉绀哄悕锛圙M 椤甸潰鐘舵€佹寜閽枃瀛楋紱绌哄洖閫€鐗╀綋鍚嶏級")]
        private string displayName;

        /// <summary>鐘舵€佹樉绀哄悕锛圙M 椤甸潰鏄剧ず鐢級銆?/summary>
        public string DisplayName => string.IsNullOrEmpty(displayName) ? gameObject.name : displayName;
    }
}