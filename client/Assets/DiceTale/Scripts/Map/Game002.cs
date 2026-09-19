namespace DiceTale
{
    /// <summary>Scene002 场景脚本：第二张游戏地图。</summary>
    public class Game002 : GameScene
    {
        public override string SceneId => "Scene002";

        /// <summary>下一传送目标：Scene003（标记 001）。</summary>
        public override SceneLink NextTarget => new SceneLink("Scene003", "001");

        /// <summary>进入游戏场景：确保玩家信息面板已创建；并播本场景背景音乐。</summary>
        public override void OnSceneLoaded(GameSceneManager manager)
        {
            base.OnSceneLoaded(manager);
        }
    }
}