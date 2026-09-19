namespace DiceTale
{
    /// <summary>Scene001 场景脚本：第一张游戏地图（古堡大厅）。</summary>
    public class Game001 : GameScene
    {
        public override string SceneId => "Scene001";

        /// <summary>下一传送目标：Scene002（标记 001）。</summary>
        public override SceneLink NextTarget => new SceneLink("Scene002", "001");

        /// <summary>进入游戏场景：确保玩家信息面板已创建（Scene000 角色创建场景不创建）；并播本场景背景音乐。</summary>
        public override void OnSceneLoaded(GameSceneManager manager)
        {
            base.OnSceneLoaded(manager);
        }
    }
}