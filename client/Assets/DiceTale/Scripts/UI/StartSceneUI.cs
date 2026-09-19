using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 开始场景（Scene000）人数选择 UI（继承 <see cref="UIWindow"/>，由 UIManager 统一管理；
    /// Game000 经 UIManager.OpenWindow 按 Resources/StartSceneUI 实例化加载）。
    /// 参考 PlayerSwitcherUI 模式：视觉结构（Canvas + 按钮行 + 返回按钮）烘焙在 prefab 里，
    /// 本脚本只负责绑定（找节点、挂回调）与按钮行/返回按钮的显示切换，不触碰场景内容；
    /// 场景相关的角色位显示、视频播完计数、流程命令执行由 Game000 订阅本窗口事件处理。
    ///
    /// 交互：4 个按钮选人数（1-4）→ 隐藏按钮行、显示返回按钮、触发 PlayerCountSelected；
    /// 「返回」按钮（右上角，选完人数后出现）→ 恢复人数选择、触发 BackClicked。
    /// 本阶段不创建玩家。
    /// </summary>
    public class StartSceneUI : UIWindow
    {
        /// <summary>玩家人数已选择（参数 = 人数 1-4）。场景侧逻辑（显示角色位/视频/流程）由 Game000 订阅处理。</summary>
        public event System.Action<int> PlayerCountSelected;

        /// <summary>返回人数选择（用户点了「返回」）。场景侧重置（隐藏角色位/停视频/重置流程）由 Game000 订阅处理。</summary>
        public event System.Action BackClicked;

        private Canvas canvas;
        private Transform buttonRow;
        private Transform backButton;

        protected override void Awake()
        {
            base.Awake(); // UIWindow：向 UIManager 注册
            BindUI();
        }

        /// <summary>绑定 prefab 里的节点并挂点击回调（结构烘焙在 Resources/StartSceneUI.prefab）。</summary>
        private void BindUI()
        {
            canvas = GetComponentInParent<Canvas>();
            // 结构烘焙在 prefab 根下（UIManager 统一 Canvas，实例挂其下）
            buttonRow = transform.Find("ButtonRow");
            backButton = transform.Find("BackButton");

            if (buttonRow == null)
            {
                Debug.LogWarning("[StartSceneUI] ButtonRow 不在 prefab 中，人数选择不可用");
                return;
            }

            // 人数按钮（约定名 PlayerCount_1..4）
            for (int i = 1; i <= 4; i++)
            {
                var count = i;
                var node = buttonRow.Find("PlayerCount_" + count);
                if (node == null)
                {
                    continue;
                }

                var btn = node.GetComponent<Button>();
                if (btn != null)
                {
                    btn.onClick.AddListener(() => OnPlayerCountSelected(count));
                }
            }

            // 返回按钮：右上角，选完人数后显示
            if (backButton != null)
            {
                backButton.gameObject.SetActive(false);
                var backBtn = backButton.GetComponent<Button>();
                if (backBtn != null)
                {
                    backBtn.onClick.AddListener(OnBackClicked);
                }
            }
        }

        /// <summary>人数按钮点击：隐藏按钮行、显示返回按钮、通知订阅者（Game000 负责场景侧处理）。</summary>
        private void OnPlayerCountSelected(int count)
        {
            if (buttonRow != null)
            {
                buttonRow.gameObject.SetActive(false);
            }

            if (backButton != null)
            {
                backButton.gameObject.SetActive(true);
            }

            PlayerCountSelected?.Invoke(count);
        }

        /// <summary>返回：隐藏返回按钮、重新显示人数按钮行、通知订阅者（Game000 负责重置角色位/视频/流程）。</summary>
        private void OnBackClicked()
        {
            if (backButton != null)
            {
                backButton.gameObject.SetActive(false);
            }

            if (buttonRow != null)
            {
                buttonRow.gameObject.SetActive(true);
            }

            BackClicked?.Invoke();
        }
    }
}
