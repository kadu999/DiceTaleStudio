using UnityEngine;
using UnityEngine.Rendering;

namespace DiceTale
{
    /// <summary>
    /// 指挥光圈：挂在 Player 预设根上。当前输入源（<see cref="DevicePipeInputSource2"/>）的
    /// <c>CommandId</c> 指向的玩家脚底下显示一个发光圆环（**运行时自建平行于地面的面片** +
    /// 项目专属 Shader "DiceTale/SelectionRing"：黑白光环图做高光、_Color 染色、透明混合写在 shader 内，
    /// 不依赖 UGUI/运行时材质关键字，无需旋转）；改指向其它玩家/拍照/未分配，光圈自动切换或全部隐藏。
    /// **总开关**：<see cref="ShowSelectionRing"/> 默认 true = 按覆盖显示指挥光圈；
    /// 真机联调想临时屏蔽时置 false（只影响光环显示，覆盖/逻辑切换等保留）。
    /// 直径默认取网格 CellSize × 4（0 表示自动），并带**远距离保底**：摄像机拉远时按屏幕占比放大
    /// （<see cref="minScreenFraction"/>），保证离远了仍然可见；近距离保持世界直径不变。
    /// 光环黑白图由 Tools/generate_selection_ring.py 生成（Resources/Textures/SelectionRing.png）。
    /// </summary>
    public class PlayerSelectionRing : MonoBehaviour
    {
        private const string RingTexturePath = "Textures/SelectionRing"; // Resources 相对路径

        [SerializeField]
        private Camera playerCamera;

        [SerializeField, Tooltip("光环颜色（含透明度）")]
        private Color ringColor = new Color(0.95f, 0.9f, 0.35f, 0.85f);

        [SerializeField, Tooltip("高光强度（放大黑白图的白色发光）")]
        [Range(0.5f, 4f)]
        private float glowIntensity = 1.5f;

        [SerializeField, Tooltip("光环直径（世界单位）；0=自动取网格 CellSize × 4")]
        private float ringDiameter;

        [SerializeField, Tooltip("远距离最小屏幕占比（光环直径占视口高度的比例）。摄像机拉远时放大到该值，"
            + "保证光环始终可见；0=关闭保底（纯世界尺寸）。")]
        [Range(0f, 0.5f)]
        private float minScreenFraction = 0.08f;

        [SerializeField, Tooltip("光环离地高度（防与地面 z-fighting）")]
        private float liftHeight = 0.05f;

        private GameObject ringObject;
        private float resolvedDiameter = 10f;
        private bool notified;

        /// <summary>指挥光圈总开关（静态）：默认 true = 按 CommandId 显示光圈；
        /// 真机联调想临时屏蔽时置 false。屏蔽只影响光环显示，不影响覆盖/逻辑切换等。</summary>
        public static bool ShowSelectionRing = true;

        private void Awake()
        {
            BuildRing();
        }

        private void Update()
        {
            if (ringObject == null)
            {
                return;
            }

            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            var self = GetComponent<BackendObject>();
            bool show = ShowSelectionRing && manager != null && self != null && IsOverrideTarget(manager, self);
            ringObject.SetActive(show);

            // 一次性诊断日志：确认「覆盖判定 + 光环显示」代码路径真的跑了（排查用，确认后移除）
            if (show && !notified)
            {
                notified = true;
                Debug.Log($"[PlayerSelectionRing] {name} 指挥光圈已显示（直径 {resolvedDiameter:F2}）");
            }
        }

        /// <summary>当前输入源（DevicePipeInputSource2）的 CommandId 是否指向自己：
        /// 指向玩家 1..5 → 只有该玩家显示光圈；未分配 / 拍照 / 多点标记 / 非 v2 输入源 → 全部隐藏。</summary>
        private static bool IsOverrideTarget(CharacterManager manager, BackendObject self)
        {
            var input = Game.Instance != null ? Game.Instance.InputManager : null;
            if (input == null || !(input.CurrentInputSource is DevicePipeInputSource2 v2))
            {
                return false;
            }

            int playerIndex = v2.CommandId.ToPlayerIndex();
            return playerIndex >= 0 && manager.GetPlayer(playerIndex) == self;
        }

        /// <summary>创建/定位光环物体（不销毁已有，幂等）。</summary>
        private void BuildRing()
        {
            ringObject = transform.Find("SelectionRing")?.gameObject;
            if (ringObject == null)
            {
                // 自建 XZ 平面面片（平行于地面，无需旋转 Quad）
                ringObject = new GameObject("SelectionRing");
                ringObject.transform.SetParent(transform, false);

                var meshFilter = ringObject.AddComponent<MeshFilter>();
                meshFilter.sharedMesh = CreateGroundPlaneMesh();

                var renderer = ringObject.AddComponent<MeshRenderer>();
                renderer.shadowCastingMode = ShadowCastingMode.Off;
                renderer.receiveShadows = false;
                renderer.sharedMaterial = CreateRingMaterial();
                renderer.sortingOrder = 1;
            }

            ringObject.transform.localPosition = new Vector3(0f, liftHeight, 0f);
            ringObject.transform.localRotation = Quaternion.identity; // 面片本身平行地面（法线朝上）
            ringObject.transform.localScale = new Vector3(resolvedDiameter, 1f, resolvedDiameter);
        }

        /// <summary>生成与地面平行的单位面片（XY 平面旋转到 XZ：顶点在 XZ、法线朝上 +Y，UV 0..1）。</summary>
        private static Mesh CreateGroundPlaneMesh()
        {
            var mesh = new Mesh { name = "SelectionRingPlane" };
            mesh.vertices = new[]
            {
                new Vector3(-0.5f, 0f, -0.5f),
                new Vector3(0.5f, 0f, -0.5f),
                new Vector3(0.5f, 0f, 0.5f),
                new Vector3(-0.5f, 0f, 0.5f),
            };
            mesh.uv = new[]
            {
                new Vector2(0f, 0f),
                new Vector2(1f, 0f),
                new Vector2(1f, 1f),
                new Vector2(0f, 1f),
            };
            mesh.triangles = new[] { 0, 1, 2, 0, 2, 3 };
            mesh.normals = new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up };
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>相机移动后更新光环尺寸：**远距离保底**——按相机距离把直径放大到不小于
        /// 「视口高度 × <see cref="minScreenFraction"/>」的屏幕投影，保证离开远仍可见；
        /// 近距离（世界直径更大）保持原尺寸。透视相机用视锥高度换算，正交相机直接用视口高度。</summary>
        private void LateUpdate()
        {
            if (ringObject == null || minScreenFraction <= 0f)
            {
                return;
            }

            var camera = playerCamera != null ? playerCamera : Camera.main;
            if (camera == null)
            {
                return;
            }

            float requiredDiameter = resolvedDiameter;
            if (camera.orthographic)
            {
                // 正交：视口高度（世界单位）直接换算目标尺寸
                requiredDiameter = Mathf.Max(resolvedDiameter, camera.orthographicSize * 2f * minScreenFraction);
            }
            else
            {
                // 透视：屏幕占比 = 直径 / (2 * 距离 * tan(fov/2)) → 直径 = 占比 * 2 * 距离 * tan(fov/2)
                float distance = Vector3.Distance(camera.transform.position, ringObject.transform.position);
                float halfFovTan = Mathf.Tan(camera.fieldOfView * 0.5f * Mathf.Deg2Rad);
                requiredDiameter = Mathf.Max(resolvedDiameter, distance * halfFovTan * 2f * minScreenFraction);
            }

            if (!Mathf.Approximately(ringObject.transform.localScale.x, requiredDiameter))
            {
                ringObject.transform.localScale = new Vector3(requiredDiameter, 1f, requiredDiameter);
            }
        }

        /// <summary>光环材质：DiceTale/SelectionRing + 黑白光环图（白色做高光）。</summary>
        private Material CreateRingMaterial()
        {
            var shader = Shader.Find("DiceTale/SelectionRing");
            if (shader == null)
            {
                Debug.LogError($"[PlayerSelectionRing] Shader DiceTale/SelectionRing 未找到，光环不可见");
                shader = Shader.Find("Sprites/Default");
            }

            var texture = Resources.Load<Texture2D>(RingTexturePath);
            if (texture == null)
            {
                Debug.LogError($"[PlayerSelectionRing] 光环图未找到: Resources/{RingTexturePath}，请运行 Tools/generate_selection_ring.py 生成");
            }

            var material = new Material(shader);
            material.SetColor("_Color", ringColor);
            material.SetFloat("_Intensity", glowIntensity);
            if (texture != null)
            {
                material.SetTexture("_MainTex", texture);
            }

            return material;
        }
    }
}