namespace DiceTale
{
    /// <summary>Scene003 场景脚本：终点场景（无下一传送目标）。</summary>
    public class Game003 : GameScene
    {
        public override string SceneId => "Scene003";

        /// <summary>进入游戏场景：确保玩家信息面板已创建；并播本场景背景音乐。</summary>
        public override void OnSceneLoaded(GameSceneManager manager)
        {
            base.OnSceneLoaded(manager);
        }
    }
}