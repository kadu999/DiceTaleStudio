using System.Collections.Generic;

namespace DiceTale
{
    /// <summary>
    /// 前端镜像里的场景：与后端文档模型（`SceneDoc`）同构。
    ///
    /// **后台有什么对象，前端就有什么对象**：服务端推下来一份场景，前端按 `id` 建 / 改 / 删自己的
    /// GameObject，并把这份模型留在内存里（命令要用它取数据，例如声音对象该播哪一条）。
    /// 字段只收前端用得上的：`components` / `locked` 这类编辑器侧的东西不镜像。
    /// </summary>
    public class MirrorScene
    {
        public string name = "";
        public readonly List<MirrorObject> objects = new List<MirrorObject>();
    }

    /// <summary>镜像里的一个场景对象（世界坐标：x 向右、y 向上，单位像素，原点 = 场景中心）。</summary>
    public class MirrorObject
    {
        public string id = "";
        public string name = "";
        /// <summary>
        /// 对象种类。**只是「创建原型」标签**（占位色 / 排查用）：v9 起「这个对象有什么」
        /// 一律看 <see cref="components"/>，行为不再由 kind 决定（见 <see cref="SceneObjectView.NeedsView"/>）。
        ///
        /// 后台那边 `SceneObject` 是**抽象基类**（v22 起），精灵 `Sprite` 与贴图 `Image` 都继承它，
        /// 而它自己不落进数据——所以这里的缺省值取具体类型 `Sprite`，
        /// <see cref="SceneObjectView.KindColor"/> 也只为具体类型配色。
        /// </summary>
        public string kind = "Sprite";

        /// <summary>是否激活：不激活的对象前端也不显示（与编辑器那个勾选框同一件事）。</summary>
        public bool active = true;

        /// <summary>显示顺序：大的画在前面（映射到 MeshRenderer.sortingOrder）。</summary>
        public int sortingOrder;

        /// <summary>世界里没落位的对象（`position: null`）不建视图。</summary>
        public bool hasPosition;
        public float x;
        public float y;

        public float rotation;
        public float scale = 1f;

        /// <summary>对象自己要显示的图（精灵与贴图都用它；地图的图在 <see cref="map"/> 里）。</summary>
        public MirrorImage image;

        /// <summary>
        /// 这张图是**精灵**那一份（`SpriteLayer` 组件）还是**贴图**那一份（`ImageLayer`）。
        ///
        /// 两者显示的是同一件事（对象自己那张图），数据形状也一样，所以都填进 <see cref="image"/>；
        /// 差别只在**精灵会取图集里的一格**。真正的读取点在 <see cref="SceneObjectView.Create"/>：
        /// 据此决定挂 `SpriteLayer` 还是 `ImageLayer`（后者省略时以 <see cref="MirrorImage.sprite"/>
        /// 兜底）；其余（占位色、诊断日志）也跟着这一个事实走，不用再翻组件表。
        /// </summary>
        public bool hasSpriteLayer;

        /// <summary>由 `GridMap` 组件填（v9 起；老版本是对象上的 `map` 字段）。</summary>
        public MirrorMap map;

        /// <summary>由 `PlaySound` 组件填（v9 起；老版本是对象上的 `sound` 字段）。</summary>
        public MirrorSound sound;

        /// <summary>
        /// 地图 / 贴图能带视频（`Map` / `Image`，v21 起）：加进来的视频 + 选中的那条 + 循环 / 声音。
        ///
        /// 为 null = 这个对象不放视频（没加过，或这份场景来自还没这个字段的旧编辑器）。
        /// </summary>
        public MirrorVideo video;

        /// <summary>要显示的图（地图对象取 <c>map.image</c>）。</summary>
        public MirrorImage DisplayImage => image ?? map?.image;

        /// <summary>
        /// 对象身上的组件（协议 v9 起）。
        ///
        /// **原始数据一律留着**：已知的特性组件会同时填进上面那几个强类型字段
        /// （`map` / `image` / `sound` / `video`），未知类型只留在这里备查——
        /// 编辑器加一个新组件时，老前端不该整份场景解析失败，它只是不认那一个组件而已。
        ///
        /// **加新字段的规矩**：用 <see cref="ComponentBool"/> / <see cref="ComponentString"/> /
        /// <see cref="ComponentNumber"/> 就地读，**不要**再扩那几个强类型镜像类，
        /// 也不要再往 <see cref="SceneParser"/> 里加解析行（理由见 <see cref="ComponentData"/>）。
        /// </summary>
        public readonly List<MirrorComponent> components = new List<MirrorComponent>();

        /// <summary>这个对象带某个类型的组件吗（v9 起「这个对象有什么」都看组件）。</summary>
        public bool HasComponent(string type)
        {
            foreach (var component in components)
            {
                if (component.type == type)
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// 某个组件实例的**原始数据**（没挂这个组件时 `null`）。
        ///
        /// 上面那几个强类型字段（`map` / `image` / `sound` / `video`）是给**已知字段**用的便利层，
        /// 它们不是必需的第二份真相——<see cref="MirrorComponent.data"/> 本来就是原样的那一份。
        /// 所以**新字段一律用下面这几个读取器读**，不要再往 `MirrorXxx` 上加字段、也不要再改
        /// <see cref="SceneParser"/>：那样每加一个布尔都要手抄两处（镜像字段 + 解析行），
        /// 而泛型这条路一直是通的。
        ///
        /// 例：`obj.ComponentBool("VideoOverlay", "autoPlay")`。
        /// </summary>
        public Dictionary<string, object> ComponentData(string type)
        {
            foreach (var component in components)
            {
                if (component.type == type)
                {
                    return component.data;
                }
            }

            return null;
        }

        /// <summary>
        /// 读某个组件上的布尔字段；组件没挂 / 字段没写 / 值不是布尔时返回 `fallback`。
        ///
        /// 判据与 <see cref="JsonParser.GetBool"/> 逐字一致（类型不对就当没写），所以「老编辑器不发
        /// 这一项」与「手写载荷写错类型」都落到同一个兜底上。
        /// </summary>
        public bool ComponentBool(string type, string key, bool fallback = false)
        {
            return JsonParser.GetBool(ComponentData(type), key, fallback);
        }

        /// <summary>读某个组件上的字符串字段；缺失时返回 `null`（与 `JsonParser.GetString` 同口径）。</summary>
        public string ComponentString(string type, string key)
        {
            return JsonParser.GetString(ComponentData(type), key);
        }

        /// <summary>
        /// 读某个组件上的数字字段；缺失时返回 `fallback`。
        ///
        /// JSON 里的数字一律解析成 `double`（见 <see cref="JsonParser"/>），所以这里也是 `double`
        /// ——要整数请在调用处自己转，别在这里悄悄取整（那会把「1.5」变成「1」而没人发现）。
        /// </summary>
        public double ComponentNumber(string type, string key, double fallback = 0)
        {
            return JsonParser.GetNumber(ComponentData(type), key, fallback);
        }
    }

    /// <summary>
    /// 一个组件实例（协议 v9 起）：`type` 决定它是什么，`data` 是它的数据。
    ///
    /// 前端只解释它认识的那 5 种（解析时已经填进 <see cref="MirrorObject"/> 的强类型字段），
    /// 其余的留着不解释。
    /// </summary>
    public class MirrorComponent
    {
        public string type = "";
        public Dictionary<string, object> data;
    }

    /// <summary>图片引用：资源逻辑 ID + 声明的宽高（世界像素；实际尺寸还要乘对象 scale）。</summary>
    public class MirrorImage
    {
        public string id = "";
        public int width;
        public int height;

        /// <summary>
        /// **子图**（v10）：显示的是这张图集里的哪一格；`null` = 整张图（与 v9 同义）。
        ///
        /// 只有精灵会带它（贴图对象的图组件是 `ImageLayer`，界面不给切图入口），
        /// 但地图 / 手写载荷里出现它也照常解析——前端「收到的就是事实」，多认一种形状没有坏处。
        /// </summary>
        public MirrorSprite sprite;
    }

    /// <summary>
    /// 图集里的一个子图（v10 起）：几列几行、取第几格。
    ///
    /// **格序数从左上数**（`column: 0` = 最左、`row: 0` = 最上），且**只存格序数不存像素**——
    /// 像素矩形 = 格子 ÷ 加载到的纹理尺寸（见 <see cref="SpriteLayer"/>）。
    /// 存像素就会与事实不一致（服务端那边同一条规矩）。
    /// </summary>
    public class MirrorSprite
    {
        public int columns = 1;
        public int rows = 1;
        public int column;
        public int row;
    }

    /// <summary>地图对象的数据：贴图 + 网格（格子已从 RLE 解成掩码数组）。</summary>
    public class MirrorMap
    {
        public MirrorImage image;
        public int gridWidth;
        public int gridHeight;

        /// <summary>按行序 bottom-up 展开的格子掩码（`gridWidth * gridHeight` 个）。</summary>
        public int[] cells = new int[0];

        /// <summary>被指定为战争雾的区域位（空 = 没指定）。</summary>
        public int[] fogRegions = new int[0];

        /// <summary>
        /// 战争雾的**总开关**（`map.fog.enabled`）：**只有开着才建那一层雾**。
        ///
        /// 缺省算开（老场景里「有 fog」就等于「开着」——那时候还没有这个字段）。
        /// </summary>
        public bool fogEnabled = true;
    }

    /// <summary>声音对象的数据：前端播的就是 <see cref="picked"/> 那一条。</summary>
    public class MirrorSound
    {
        public readonly List<string> clips = new List<string>();
        public string picked = "";
        public string layer = "sfx";
    }

    /// <summary>
    /// 地图 / 贴图上的**视频**（v14 起）：一组视频 + 选中的那条 + 循环 / 声音两个开关。
    ///
    /// 前端放的永远是 <see cref="picked"/> 那一条（命令 `play_video` 只给 `objectId`）：
    /// 命令是触发器，数据在镜像里。视频画面盖在**这个对象自己的矩形**上，见
    /// <see cref="VideoOverlay"/>。
    /// </summary>
    public class MirrorVideo
    {
        /// <summary>
        /// **总开关**（`video.enabled`）：关着 = 这个对象现在不放视频（前端连那一层都不建，
        /// 播放类命令会被明确拒掉）。缺省算开（老编辑器不发这一项，而「有 video 字段」本来
        /// 就等于「在用」——与 `map.fog.enabled` 同一个口径）。
        /// </summary>
        public bool enabled = true;

        /// <summary>Play the selected clip when this scene is activated.</summary>
        public bool autoPlay;

        /// <summary>加进来的视频（资源逻辑 ID，如 `project:C/Assets/video/opening.mp4`）。</summary>
        public readonly List<string> clips = new List<string>();

        /// <summary>当前选中的那一条（空 = 还没选，前端会拒掉 `play_video`）。</summary>
        public string picked = "";

        /// <summary>循环播放（缺省 false = 放完停在最后一帧）。</summary>
        public bool loop;

        /// <summary>是否放视频自带的声音（缺省 false = 静音）。</summary>
        public bool audio;
    }

    /// <summary>
    /// 项目级**全局设置**（v7 起）：前端不解释业务，照着调三档音量。
    ///
    /// 它**不在场景里**（跨场景有效、换场景不该丢），由服务端单独一条 `project_settings` 下发，
    /// 通常比 `scene_sync` 先到。目前只有音频；后面加别的全局参数就挂在这里。
    /// </summary>
    public class MirrorSettings
    {
        public MirrorAudioSettings audio = new MirrorAudioSettings();

        /// <summary>把三档音量夹进 `0..1`（手写文件 / 旧版本可能给出界值；Unity 的 `AudioSource.volume` 也只要这一段）。</summary>
        public void ClampVolumes()
        {
            audio.bgm.volume = Clamp01(audio.bgm.volume);
            audio.sfxVolume = Clamp01(audio.sfxVolume);
            audio.voiceVolume = Clamp01(audio.voiceVolume);
        }

        private static float Clamp01(float value)
        {
            if (float.IsNaN(value))
            {
                return 0f;
            }

            return value < 0f ? 0f : value > 1f ? 1f : value;
        }
    }

    /// <summary>三档音频参数：背景音乐音量 + 音效 / 旁白各自的音量。</summary>
    public class MirrorAudioSettings
    {
        public readonly MirrorBgmSettings bgm = new MirrorBgmSettings();

        /// <summary>音效通道音量（缺省 0.8，与编辑器那边同一份缺省值）。</summary>
        public float sfxVolume = 0.8f;

        /// <summary>旁白通道音量（缺省 1）。</summary>
        public float voiceVolume = 1f;
    }

    /// <summary>
    /// 全局背景音乐通道：**只剩音量**（v16 起）。
    ///
    /// 歌单 / 默认曲 / 循环都不再进文档：曲目清单就是编辑器弹框里列出来的项目音频，
    /// 点一首就发一条 `play_bgm{clip}`——放哪一首由**命令**说（`Logic/CommandRouter.cs` 接），
    /// 前端自己**不自动播**（单一真源，不会双播）。背景音乐**恒循环**，响到被换掉 / 停掉为止。
    /// </summary>
    public class MirrorBgmSettings
    {
        /// <summary>背景音乐通道音量（缺省 0.6）。</summary>
        public float volume = 0.6f;
    }
}
