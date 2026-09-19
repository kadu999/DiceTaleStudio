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
    }

    /// <summary>声音对象的数据：前端播的就是 <see cref="picked"/> 那一条。</summary>
    public class MirrorSound
    {
        public readonly List<string> clips = new List<string>();
        public string picked = "";
        public string layer = "sfx";
    }
}
