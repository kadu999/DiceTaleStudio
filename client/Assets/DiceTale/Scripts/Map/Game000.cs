using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// Scene000 场景脚本：角色创建场景（人数选择 → 创建玩家 → 进入第一个游戏场景）。
    /// 角色创建流程相关逻辑收口在本场景脚本里：
    /// 经 UIManager 打开/销毁 StartSceneUI 人数选择窗口并订阅其事件；
    /// 场景相关内容（按人数显示 Event 下角色位、视频播完计数、流程命令列表执行）都在这里处理，
    /// StartSceneUI 只负责按钮 UI；可用 useStartSceneUI 开关跳过人数选择 UI，
    /// 直接显示全部 4 个角色位，视频播完后创建角色进入下一场景。
    /// </summary>
    public class Game000 : GameScene
    {
        public override string SceneId => "Scene000";

        /// <summary>角色创建完成后进入第一个游戏场景（标记 001）。</summary>
        public override SceneLink NextTarget => new SceneLink("Scene001", "001");

        [SerializeField, Tooltip("是否使用 StartSceneUI 人数选择窗口；关闭则跳过人数选择，直接显示全部 4 个角色位，视频播完后进入下一场景")]
        private bool useStartSceneUI = true;

        private StartSceneUI startUI;    // 人数选择窗口（UIManager 统一管理，离开时销毁）

        private int lastSelectedCount;   // 最近一次选定的人数(全部视频播完后创建角色用)
        private int pendingFinishes;     // 等待播完的角色位数量(归零即触发命令列表)

        /// <summary>流程命令是否已执行（防重入：播完事件可能重复触发）。</summary>
        private bool flowExecuted;

        /// <summary>角色创建场景：经 UIManager 打开人数选择窗口（Resources/StartSceneUI），
        /// 订阅人数选择/返回事件；场景侧初始状态：隐藏 Event 下全部角色位。
        /// useStartSceneUI 关闭时：不打开窗口，直接显示全部 4 个角色位（等同选了 4 人），
        /// 视频播完后执行流程命令。</summary>
        public override void OnSceneLoaded(GameSceneManager manager)
        {
            // 隐藏所有角色
            HideCharacterSlots();

            if (!useStartSceneUI)
            {
                OnPlayerCountSelected(4);
                return;
            }

            var ui = Game.Instance != null ? Game.Instance.UIManager : null;
            if (ui == null)
            {
                return;
            }

            startUI = ui.OpenWindow<StartSceneUI>("StartSceneUI");
            if (startUI == null)
            {
                return;
            }

            startUI.PlayerCountSelected += OnPlayerCountSelected;
            startUI.BackClicked += OnBackToCountSelection;
        }

        /// <summary>离开角色创建场景：退订事件并经 UIManager 销毁人数选择窗口。</summary>
        public override void OnSceneUnloaded()
        {
            if (startUI != null)
            {
                startUI.PlayerCountSelected -= OnPlayerCountSelected;
                startUI.BackClicked -= OnBackToCountSelection;
                startUI = null;
            }

            var ui = Game.Instance != null ? Game.Instance.UIManager : null;
            if (ui != null)
            {
                ui.DestroyWindow<StartSceneUI>();
            }
        }

        /// <summary>人数已选择：按人数显示 Event 下对应数量角色位并订阅播完事件；
        /// 无任何角色位视频（pendingFinishes==0）：无需等待，直接执行流程命令
        ///（防御「只有按钮/角色位、却没有视频」的流程断裂）。</summary>
        private void OnPlayerCountSelected(int count)
        {
            ShowCharacterSlots(count);

            if (pendingFinishes == 0)
            {
                ExecuteFlowCommands();
            }
        }

        /// <summary>返回人数选择：隐藏已显示的角色位、显式停掉角色位视频（避免已播完的旧状态影响重选计数）、
        /// 退订播完事件并重置流程防重入标记。</summary>
        private void OnBackToCountSelection()
        {
            HideCharacterSlots();
            StopVideoSlots();
            UnsubscribeVideos();
            flowExecuted = false;
        }

        /// <summary>按人数显示 Event 下的角色位子物体（命名 1/2/3/4）：前 count 个激活，其余隐藏。</summary>
        private void ShowCharacterSlots(int count)
        {
            var eventT = FindEventTransform();
            if (eventT == null)
            {
                Debug.LogWarning("[Game000] 当前场景下 Event 物体不存在，无法按人数显示角色位");
                return;
            }

            lastSelectedCount = count;
            pendingFinishes = 0;
            var list = new List<GameObject>();
            for (int i = 1; i <= 4; i++)
            {
                var slot = eventT.Find(i.ToString());
                if (slot != null)
                {
                    slot.gameObject.SetActive(i <= count);
                    if (i <= count)
                    {
                        list.Add(slot.gameObject);
                        SubscribeSlotVideo(eventT, i);
                    }
                }
            }

            if (list.Count > 0)
            {
                float cardW = 5.06f;
                float maxW = cardW * 4;
                float slotW = maxW / count;

                if (list.Count == 1)
                {
                    list[0].transform.localPosition = new Vector3(0, 0, 0);
                }
                else if (list.Count == 2)
                {
                    list[0].transform.localPosition = new Vector3(slotW * -0.5f, 0, 0);
                    list[1].transform.localPosition = new Vector3(slotW * +0.5f, 0, 0);
                }
                else if (list.Count == 3)
                {
                    list[0].transform.localPosition = new Vector3(slotW * -1.0f, 0, 0);
                    list[1].transform.localPosition = new Vector3(0, 0, 0);
                    list[2].transform.localPosition = new Vector3(slotW * +1.0f, 0, 0);
                }
                else if (list.Count == 4)
                {
                    list[0].transform.localPosition = new Vector3(slotW * -1.5f, 0, 0);
                    list[1].transform.localPosition = new Vector3(slotW * -0.5f, 0, 0);
                    list[2].transform.localPosition = new Vector3(slotW * +0.5f, 0, 0);
                    list[3].transform.localPosition = new Vector3(slotW * +1.5f, 0, 0);
                }
            }

        }

        /// <summary>隐藏 Event 下所有角色位（返回人数选择时重置显示状态）。</summary>
        private void HideCharacterSlots()
        {
            var eventT = FindEventTransform();
            if (eventT == null)
            {
                return;
            }

            for (int i = 1; i <= 4; i++)
            {
                var slot = eventT.Find(i.ToString());
                if (slot != null)
                {
                    slot.gameObject.SetActive(false);
                }
            }
        }

        /// <summary>显式停掉所有角色位视频（返回人数选择时调用，避免旧播放状态影响重选）。</summary>
        private void StopVideoSlots()
        {
            var eventT = FindEventTransform();
            if (eventT == null)
            {
                return;
            }

            foreach (var svp in eventT.GetComponentsInChildren<SmartVideoPlayer>(true))
            {
                if (svp != null)
                {
                    svp.Stop();
                }
            }
        }

        /// <summary>订阅某个角色位（SmartVideoPlayer）的播完事件；全部播完后执行流程命令列表。</summary>
        private void SubscribeSlotVideo(Transform eventT, int slotIndex)
        {
            var slot = eventT.Find(slotIndex.ToString());
            if (slot == null)
            {
                return;
            }

            var svp = slot.GetComponentInChildren<SmartVideoPlayer>();
            if (svp == null)
            {
                return;
            }

            svp.PlaybackFinished -= OnSlotVideoFinished;
            svp.PlaybackFinished += OnSlotVideoFinished;
            pendingFinishes++;
        }

        /// <summary>退订所有角色位视频播完事件（返回人数选择时调用）。</summary>
        private void UnsubscribeVideos()
        {
            var eventT = FindEventTransform();
            if (eventT == null)
            {
                return;
            }

            foreach (var svp in eventT.GetComponentsInChildren<SmartVideoPlayer>(true))
            {
                svp.PlaybackFinished -= OnSlotVideoFinished;
            }

            pendingFinishes = 0;
        }

        /// <summary>一个角色位视频播完：全部播完后执行流程命令列表（创建角色 + 进入地图）。</summary>
        private void OnSlotVideoFinished(SmartVideoPlayer svp)
        {
            Debug.Log($"OnSlotVideoFinished:{pendingFinishes}");
            svp.PlaybackFinished -= OnSlotVideoFinished;
            pendingFinishes--;
            if (pendingFinishes <= 0)
            {
                pendingFinishes = 0;
                ExecuteFlowCommands();
            }
        }

        /// <summary>执行流程命令列表：优先场景中已配置的 SceneFlowCommandList；
        /// 不存在或为空时自动创建并预填默认流程（按所选人数创建角色 + 进入下一场景）。</summary>
        private void ExecuteFlowCommands()
        {
            if (flowExecuted)
            {
                return; // 防重入
            }

            flowExecuted = true;

            var cmdList = Object.FindFirstObjectByType<SceneFlowCommandList>();
            if (cmdList == null)
            {
                var go = new GameObject(nameof(SceneFlowCommandList));
                cmdList = go.AddComponent<SceneFlowCommandList>();
            }

            if (cmdList.Count == 0)
            {
                cmdList.AddCommand(new CreatePlayersCommand(lastSelectedCount));

                string targetScene = "Scene001";
                var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
                if (sceneManager != null &&
                    sceneManager.TryGetNextTarget(sceneManager.CurrentSceneName, out var nextScene, out _))
                {
                    targetScene = nextScene;
                }

                cmdList.AddCommand(new LoadSceneCommand(targetScene, "Default"));
            }

            cmdList.Execute();
        }

        /// <summary>本场景实例下按名字查找 CharacterCreationEvent 子物体（角色位容器；
        /// Game000 挂在场景根上，场景内查找等价于原 GameSceneManager.FindInCurrentScene）。</summary>
        private Transform FindEventTransform()
        {
            foreach (var t in GetComponentsInChildren<Transform>(true))
            {
                if (t.name == "CharacterCreationEvent")
                {
                    return t;
                }
            }

            return null;
        }

        /// <summary>人数已选择：按人数显示 Event 下对应数量角色位并订阅播完事件；
        /// 无任何角色位视频（pendingFinishes==0）：无需等待，直接执行流程命令
        ///（防御「只有按钮/角色位、却没有视频」的流程断裂）。</summary>
        public void OnPlayerCountSelectedHandler(BackendComponent component)
        {
            if (component is OptionValue)
            {
                var op = component as OptionValue;
                var count = op.SelectedIndex + 1;
                OnPlayerCountSelected(count);
            }
        }
    }
}
