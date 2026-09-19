using UnityEngine;
using UnityEngine.Rendering;

namespace DiceTale
{
    /// <summary>
    /// 与地面平行的 4 顶点面片（类似 SpriteRenderer，但面片躺在 XZ 地面上、法线朝上 +Y）。
    /// 用法：把组件挂到任意物体上，**只需在 Inspector 往 <see cref="sprite"/> 拖一张图即可显示**；
    /// 不需要手动摆 MeshFilter / MeshRenderer / 材质——Awake（或编辑器里改字段时）自动构建。
    /// 面片尺寸自动跟随纹理宽高比：**宽度 = 比例 × 1、高度固定 1**（纹理不被拉伸，保持原比例）；
    /// 想整体放大缩小用 Transform 的 localScale（保持比例放大）。
    ///
    /// 与项目惯例一致（FogOfWar 等地面网格）：**不用内置 Quad**——其原生朝向是 XY 平面、
    /// 要贴地面必须旋转；这里代码自建 4 顶点 XZ 网格（法线朝上、无需旋转），UV 方向与格子/贴图一致。
    /// 材质用项目自建 Shader "DiceTale/GroundSprite"（tex × 顶点色，straight alpha），
    /// 支持带透明通道的 PNG，不受场景光照影响。
    /// 染色走**顶点色**（mesh.colors，与 SpriteRenderer 同路线）：built-in legacy Unlit/Transparent 的
    /// constantColor 染色在 URP 下不生效，顶点色在 built-in / URP 下都稳定。
    ///
    /// 生命周期：自建的 Mesh / Material 归本组件所有（owned* 字段 + HideFlags.DontSave 不入库），
    /// 换图重建成销毁旧对象，组件销毁（OnDestroy）时统一释放，不产生编辑器/运行时资源泄漏。
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(MeshFilter))]
    [RequireComponent(typeof(MeshRenderer))]
    public class GroundSpriteRenderer : MonoBehaviour
    {
        private const string MeshName = "GroundSpritePlane";
        private const string ShaderName = "DiceTale/GroundSprite";

        [SerializeField, Tooltip("要显示的图（拖 Sprite；用纹理资源直接拖也兼容——取整张图，转成 Sprite 更可控）")]
        private Sprite sprite;

        [SerializeField, Tooltip("整体染色（默认白色 = 原图）")]
        private Color color = Color.white;

        [SerializeField, Tooltip("离地高度（略抬离地面，防与地图底图 z-fighting）")]
        private float liftHeight = 0.01f;

        [SerializeField, Tooltip("渲染排序（与战争迷雾/焦痕同一排序体系时用）")]
        private int sortingOrder;

        /// <summary>本组件创建的网格（由本组件负责销毁；用户手挂的 mesh 不属于这里）。</summary>
        private Mesh ownedMesh;

        /// <summary>本组件创建的材质（由本组件负责销毁；用户手挂的材质不属于这里）。</summary>
        private Material ownedMaterial;

        private void Awake()
        {
            Build();
        }

        /// <summary>编辑器下改字段（拖入 Sprite）立即刷新预览；运行时由 Awake 构建。</summary>
        private void OnValidate()
        {
            if (Application.isPlaying)
            {
                return;
            }

            Build();
        }

        /// <summary>组件销毁时释放自建资源（编辑器 DestroyImmediate / 运行时 Destroy，按上下文选择）。</summary>
        private void OnDestroy()
        {
            ReleaseOwnedMesh();
            ReleaseOwnedMaterial();
        }

        /// <summary>幂等构建：缺哪块补哪块；网格按纹理宽高比生成，换图（比例变化）时重建并先销毁旧网格。
        /// 自建对象都登记在 owned* 字段，构建只创建/更新它们，不产生无人管理的资源。</summary>
        private void Build()
        {
            var mf = GetComponent<MeshFilter>();
            if (mf == null)
            {
                mf = gameObject.AddComponent<MeshFilter>();
            }

            // 面片尺寸跟随纹理比例：宽度 = 高度(1) × 宽高比。无图时回退 1×1（比例 1）。
            float aspect = sprite != null ? SpriteAspect(sprite) : 1f;
            bool meshNeedsRebuild = mf.sharedMesh == null
                || mf.sharedMesh != ownedMesh
                || !Mathf.Approximately(mf.sharedMesh.bounds.size.x, aspect); // 换图导致比例变化
            if (meshNeedsRebuild)
            {
                ReleaseOwnedMesh(); // 旧的自建网格先销毁（不漏）
                ownedMesh = CreateGroundPlaneMesh(aspect, color);
                ownedMesh.hideFlags = HideFlags.DontSave; // 不入库：Editor 预览不复用/不序列化
                mf.sharedMesh = ownedMesh;
            }
            else
            {
                // 只改色不改图（换图才重建）：复用网格、只刷新顶点色（染色在顶点色上，无需重建）
                ApplyVertexColor(ownedMesh, color);
            }

            var mr = GetComponent<MeshRenderer>();
            if (mr == null)
            {
                mr = gameObject.AddComponent<MeshRenderer>();
            }

            // 材质归本组件管理：还没有自建材质（含首次构建）或渲染器上的不是我们创建的（用户手挂），
            // 就创建/换用自建材质；用户手挂的材质只换掉引用、不销毁；是我们创建的则复用并更新参数。
            if (ownedMaterial == null || mr.sharedMaterial != ownedMaterial)
            {
                ReleaseOwnedMaterial(); // 旧的自建材质先销毁（不漏；null 时直接返回）
                ownedMaterial = CreateMaterial();
                ownedMaterial.hideFlags = HideFlags.DontSave;
                mr.sharedMaterial = ownedMaterial;
            }

            ownedMaterial.mainTexture = sprite != null ? sprite.texture : null;
            mr.shadowCastingMode = ShadowCastingMode.Off;
            mr.receiveShadows = false;
            mr.sortingOrder = sortingOrder;

            transform.localPosition = new Vector3(transform.localPosition.x, liftHeight, transform.localPosition.z);
        }

        /// <summary>销毁本组件创建的网格（若尚未销毁）。</summary>
        private void ReleaseOwnedMesh()
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

        /// <summary>销毁本组件创建的材质（若尚未销毁）。</summary>
        private void ReleaseOwnedMaterial()
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

        /// <summary>把染色写进 4 个顶点（面片整体同色；Vector3 位置与 uv 之外的颜色通道无需重建网格）。</summary>
        private static void ApplyVertexColor(Mesh mesh, Color tint)
        {
            if (mesh == null)
            {
                return;
            }

            mesh.colors = new[] { tint, tint, tint, tint };
        }

        /// <summary>生成与地面平行的面片：X 宽 = aspect（按纹理宽高比，高度约束为 1）、Z 高 = 1，UV 0..1、
        /// **绕序保证法线朝 +Y**（俯视/顶视相机可见——Cull Back 剔除的是数学法线朝下的面；对照 FogOfWar.CreateGroundMesh）。
        /// 顶点色 = 染色（<see cref="color"/>），由 Shader 乘到纹理上。</summary>
        private static Mesh CreateGroundPlaneMesh(float aspect, Color tint)
        {
            var halfW = aspect * 0.5f;
            var halfH = 0.5f;
            var mesh = new Mesh { name = MeshName };
            mesh.vertices = new[]
            {
                new Vector3(-halfW, 0f, -halfH), // uv (0,0)：-Z 侧
                new Vector3(halfW, 0f, -halfH),  // uv (1,0)
                new Vector3(-halfW, 0f, halfH),  // uv (0,1)：+Z 侧
                new Vector3(halfW, 0f, halfH),   // uv (1,1)
            };
            mesh.uv = new[]
            {
                new Vector2(0f, 0f),
                new Vector2(1f, 0f),
                new Vector2(0f, 1f),
                new Vector2(1f, 1f),
            };
            // 与 FogOfWar.CreateGroundMesh 相同的绕序 {0,2,1} / {1,2,3}：叉积法线朝 +Y，
            // 俯视相机看到的是正面（否则被 Cull Back 剔除、俯视不可见）。
            mesh.triangles = new[] { 0, 2, 1, 1, 2, 3 };
            ApplyVertexColor(mesh, tint); // 染色进顶点色（shader 里 tex × 顶点色）
            mesh.RecalculateNormals(); // 按绕序重算法线（结果 = 朝上 +Y）
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>透明显示材质（DiceTale/GroundSprite，找不到时回退 Sprites/Default——它也走顶点色）。</summary>
        private static Material CreateMaterial()
        {
            var shader = Shader.Find(ShaderName);
            if (shader == null)
            {
                shader = Shader.Find("Sprites/Default");
            }

            return new Material(shader);
        }

        /// <summary>Sprite 的宽高比（宽 / 高）。优先用 textureRect（图集子图时只取子图比例），
        /// 取不到时回退整张纹理尺寸。</summary>
        private static float SpriteAspect(Sprite sprite)
        {
            if (sprite == null || sprite.texture == null)
            {
                return 1f;
            }

            //var rect = sprite.textureRect;
            //if (rect.width > 0f && rect.height > 0f)
            //{
            //    return rect.width / rect.height;
            //}

            var rect = sprite.rect;
            if (rect.width > 0f && rect.height > 0f)
            {
                return rect.width / rect.height;
            }

            var tex = sprite.texture;
            return tex != null && tex.height > 0 ? (float)tex.width / tex.height : 1f;
        }
    }
}