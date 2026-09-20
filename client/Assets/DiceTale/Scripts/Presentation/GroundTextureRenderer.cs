using UnityEngine;
using UnityEngine.Rendering;

namespace DiceTale
{
    /// <summary>
    /// 与地面平行的 4 顶点面片，**直接显示一张运行时纹理**（镜像对象专用的渲染器）。
    ///
    /// 与它的前身 `GroundSpriteRenderer` 的区别：那个是给 Inspector 用的（拖一张 `Sprite` 字段、
    /// `OnValidate` 即时预览、自己管序列化资源），而镜像是**运行时数据驱动**的——
    /// 贴图来自后台推下来的资源逻辑 ID、要么从本地资源包读、要么从服务端取，
    /// 根本没有「在 Inspector 里拖图」这回事。所以这里**只认 <see cref="Texture2D"/>**：
    /// 没有 `Sprite` 字段、没有序列化字段、没有编辑器预览逻辑。
    ///
    /// 尺寸口径：**宽高直接烘进网格顶点，不靠 Transform 缩放**。调用方给的就是世界单位下的
    /// 宽与高，顶点摆在 `±宽/2` / `±高/2`，因此 `transform.localScale` 应当保持 `(1,1,1)`
    /// （<see cref="Apply"/> 会把它校正回 1）。这样「对象多大」只有一处来源——网格自己，
    /// 不会出现「网格比例 × 缩放」两处都能改大小、改错一个就变形的问题。
    ///
    /// 地面网格**不用内置 Quad**：它原生躺在 XY 平面、要贴地面必须旋转；这里代码自建 XZ 网格
    /// （法线朝上 +Y、无需旋转），绕序与 `FogOfWar` 的地面网格一致（俯视相机看到正面）。
    /// 材质用项目自建 Shader `DiceTale/GroundSprite`（纹理 × 顶点色、straight alpha），
    /// 支持带透明通道的 PNG，不受场景光照影响；染色走**顶点色**（与 `SpriteRenderer` 同路线）。
    ///
    /// 生命周期：自建的 Mesh / Material 归本组件所有（换尺寸重建、销毁旧对象，`HideFlags.DontSave` 不入库），
    /// `OnDestroy` 统一释放。**纹理不归它管**——那张图由 <see cref="ResourceImageLoader"/> 缓存并复用，
    /// 在这里销毁会把别的对象还在用的图弄没。
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(MeshFilter))]
    [RequireComponent(typeof(MeshRenderer))]
    public class GroundTextureRenderer : MonoBehaviour
    {
        private const string MeshName = "GroundTexturePlane";
        private const string ShaderName = "DiceTale/GroundSprite";

        private Mesh ownedMesh;
        private Material ownedMaterial;

        /// <summary>当前网格烘进去的尺寸与染色（变了才重建 / 重刷）。</summary>
        private float builtWidth = -1f;
        private float builtHeight = -1f;
        private Color builtTint = new Color(-1f, -1f, -1f, -1f);

        /// <summary>
        /// 应用一次显示参数（每次收到新数据都调，幂等）。
        ///
        /// - <paramref name="texture"/>：要显示的图；`null` = 还没有图，显示 <paramref name="tint"/> 纯色占位
        ///   （保证每个对象都看得见，而不是一片透明）；
        /// - <paramref name="width"/> / <paramref name="height"/>：**世界单位**下的面片尺寸，
        ///   直接烘进网格顶点；`&lt;= 0` 按 1 处理；
        /// - <paramref name="tint"/>：染色（有图时给白色 = 原图）；
        /// - <paramref name="order"/>：`MeshRenderer.sortingOrder`（决定谁盖谁）；
        /// - <paramref name="lift"/>：离地高度（避免与地图底图共面闪烁）。
        ///
        /// 顺带把 `localScale` 校正回 `(1,1,1)`：尺寸已经由网格决定，缩放再参与进来只会让
        /// 「实际多大」变成两个来源相乘。摆位置与旋转仍由调用方负责（本组件不碰）。
        /// </summary>
        public void Apply(Texture2D texture, float width, float height, Color tint, int order, float lift)
        {
            var safeWidth = width <= 0f ? 1f : width;
            var safeHeight = height <= 0f ? 1f : height;

            EnsureMesh(safeWidth, safeHeight, tint);
            EnsureMaterial();

            ownedMaterial.mainTexture = texture;

            var renderer = GetComponent<MeshRenderer>();
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            renderer.sortingOrder = order;

            if (transform.localScale != Vector3.one)
            {
                transform.localScale = Vector3.one;
            }

            // y 只用来离地，x/z 保持外面摆的位置（镜像用 world position 摆对象）
            var position = transform.localPosition;
            transform.localPosition = new Vector3(position.x, lift, position.z);
        }

        private void Awake()
        {
            EnsureMesh(1f, 1f, Color.white);
            EnsureMaterial();
        }

        private void OnDestroy()
        {
            ReleaseMesh();
            ReleaseMaterial();
        }

        /// <summary>缺哪块补哪块；尺寸或染色变了才重建网格（只改染色时刷顶点色即可）。</summary>
        private void EnsureMesh(float width, float height, Color tint)
        {
            var filter = GetComponent<MeshFilter>();
            if (filter == null)
            {
                filter = gameObject.AddComponent<MeshFilter>();
            }

            var sizeChanged = !Mathf.Approximately(builtWidth, width) || !Mathf.Approximately(builtHeight, height);
            var tintChanged = !Approximately(builtTint, tint);
            if (filter.sharedMesh == ownedMesh && ownedMesh != null && !sizeChanged)
            {
                if (tintChanged)
                {
                    ApplyVertexColor(ownedMesh, tint);
                    builtTint = tint;
                }

                return;
            }

            ReleaseMesh();
            ownedMesh = CreateGroundPlaneMesh(width, height, tint);
            ownedMesh.hideFlags = HideFlags.DontSave;
            filter.sharedMesh = ownedMesh;
            builtWidth = width;
            builtHeight = height;
            builtTint = tint;
        }

        /// <summary>材质归本组件管理：没有就创建（渲染器上挂了别人的材质也不动它，直接换用自建的）。</summary>
        private void EnsureMaterial()
        {
            var renderer = GetComponent<MeshRenderer>();
            if (renderer == null)
            {
                renderer = gameObject.AddComponent<MeshRenderer>();
            }

            if (ownedMaterial == null)
            {
                var shader = Shader.Find(ShaderName);
                if (shader == null)
                {
                    // 兜底：Sprites/Default 也走顶点色，效果接近（正常情况下 Resources/Shaders 里的自建 shader 找得到）
                    shader = Shader.Find("Sprites/Default");
                }

                ownedMaterial = new Material(shader) { hideFlags = HideFlags.DontSave };
            }

            if (renderer.sharedMaterial != ownedMaterial)
            {
                renderer.sharedMaterial = ownedMaterial;
            }
        }

        private static bool Approximately(Color left, Color right)
        {
            return Mathf.Approximately(left.r, right.r)
                && Mathf.Approximately(left.g, right.g)
                && Mathf.Approximately(left.b, right.b)
                && Mathf.Approximately(left.a, right.a);
        }

        private void ReleaseMesh()
        {
            if (ownedMesh == null)
            {
                return;
            }

            if (Application.isPlaying)
            {
                Destroy(ownedMesh);
            }
            else
            {
                DestroyImmediate(ownedMesh);
            }

            ownedMesh = null;
        }

        private void ReleaseMaterial()
        {
            if (ownedMaterial == null)
            {
                return;
            }

            if (Application.isPlaying)
            {
                Destroy(ownedMaterial);
            }
            else
            {
                DestroyImmediate(ownedMaterial);
            }

            ownedMaterial = null;
        }

        /// <summary>染色写进 4 个顶点（面片整体同色；shader 里 纹理 × 顶点色）。</summary>
        private static void ApplyVertexColor(Mesh mesh, Color tint)
        {
            if (mesh != null)
            {
                mesh.colors = new[] { tint, tint, tint, tint };
            }
        }

        /// <summary>
        /// 生成面片：X 跨 ±width/2、Z 跨 ±height/2（**尺寸烘进顶点**，配合 localScale = 1），
        /// UV 0..1；绕序 {0,2,1}/{1,2,3} 保证法线朝 +Y（俯视可见）。
        /// </summary>
        private static Mesh CreateGroundPlaneMesh(float width, float height, Color tint)
        {
            var halfWidth = width * 0.5f;
            var halfHeight = height * 0.5f;

            var mesh = new Mesh { name = MeshName };
            mesh.vertices = new[]
            {
                new Vector3(-halfWidth, 0f, -halfHeight),
                new Vector3(halfWidth, 0f, -halfHeight),
                new Vector3(-halfWidth, 0f, halfHeight),
                new Vector3(halfWidth, 0f, halfHeight),
            };
            mesh.uv = new[]
            {
                new Vector2(0f, 0f),
                new Vector2(1f, 0f),
                new Vector2(0f, 1f),
                new Vector2(1f, 1f),
            };
            mesh.triangles = new[] { 0, 2, 1, 1, 2, 3 };
            ApplyVertexColor(mesh, tint);
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}
