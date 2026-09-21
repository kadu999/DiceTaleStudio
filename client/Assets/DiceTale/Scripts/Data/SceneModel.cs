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
        /// <summary>对象种类。**动作对象（`PlaySound` / `Teleport`）只留在镜像里、不建视图**（见 <see cref="SceneObjectView.NeedsView"/>）。</summary>
        public string kind = "SceneObject";

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

        /// <summary>对象自己要显示的图（精灵用它；地图的图在 <see cref="map"/> 里）。</summary>
        public MirrorImage image;

        /// <summary>仅 <c>kind == "Map"</c>：贴图 + 网格数据。</summary>
        public MirrorMap map;

        /// <summary>仅 <c>kind == "PlaySound"</c>：加进来的音频 + 当前选中的那条 + 层级。</summary>
        public MirrorSound sound;

        /// <summary>
        /// 仅地图 / 精灵（`Map` / `SceneObject`）：加进来的视频 + 选中的那条 + 循环 / 声音。
        ///
        /// 为 null = 这个对象不放视频（没加过，或这份场景来自还没这个字段的旧编辑器）。
        /// </summary>
        public MirrorVideo video;

        /// <summary>要显示的图（地图对象取 <c>map.image</c>）。</summary>
        public MirrorImage DisplayImage => image ?? map?.image;
    }

    /// <summary>图片引用：资源逻辑 ID + 声明的宽高（世界像素；实际尺寸还要乘对象 scale）。</summary>
    public class MirrorImage
    {
        public string id = "";
        public int width;
        public int height;
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
    /// 地图 / 精灵上的**视频**（v14 起）：一组视频 + 选中的那条 + 循环 / 声音两个开关。
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

        /// <summary>加进来的视频（资源逻辑 ID，如 `project:C/Assets/video/opening.mp4`）。</summary>
        public readonly List<string> clips = new List<string>();

        /// <summary>当前选中的那一条（空 = 还没选，前端会拒掉 `play_video`）。</summary>
        public string picked = "";

        /// <summary>循环播放（缺省 false = 放完停在最后一帧）。</summary>
        public bool loop;

        /// <summary>是否放视频自带的声音（缺省 false = 静音）。</summary>
        public bool audio;
    }
}
