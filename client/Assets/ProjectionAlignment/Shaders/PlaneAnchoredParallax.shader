Shader "NuLight/ProjectionAlignment/PlaneAnchoredParallax"
{
    // 实物上色层的合成 shader（2026-08-31，取代「位姿反解 + 直通叠加」那条路）。
    //
    // 对投影仪的每个输出像素 P：
    //   ① 用标定单应查这个像素落在垫面的哪一点 B = H(P)（与预畸变链同一张矩阵）；
    //   ② 把 B 换成世界坐标里的桌面点 M，投进「站在镜头位置 C 的 rig 相机」取色。
    //
    // 数学依据：真实投影仪里经过像素 P 的那条光线，必然穿过 C 和 M —— 所以 rig 相机
    // 在 M 的像素方向上看到的第一个表面，就是这条光线在现实里照到的表面。整条链
    // **不需要投影仪的内参**：镜头焦距、lens shift、乃至机内没关干净的数字形变，
    // 全部被 H 吸收；唯一的未知量是 C 的三维位置（3 个数，手拧或卷尺量）。
    // 桌面上（h=0）的内容按构造精确等于单应，和预畸变链不可能漂。
    Properties
    {
        _MainTex("Rig Camera", 2D) = "black" {}
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Overlay"
        }

        Pass
        {
            Name "PlaneAnchoredParallax"
            ZWrite Off
            ZTest Always
            Cull Off
            Blend SrcAlpha OneMinusSrcAlpha

            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            // 标定单应：投影帧 UV（y 朝上）→ 板 UV。与 HomographyWarp 用同一份矩阵。
            float4x4 _ProjectorToBoard;
            // 板 UV（高度 0）→ rig 相机裁剪空间：proj * view * boardUvToWorld，CPU 每帧组好。
            float4x4 _BoardToRigClip;

            Varyings Vert(Attributes input)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }

            half4 Frag(Varyings input) : SV_Target
            {
                float2 projectorUv = float2(input.uv.x, 1.0 - input.uv.y);
                float4 homogeneousBoard = mul(
                    _ProjectorToBoard,
                    float4(projectorUv.x, projectorUv.y, 1.0, 0.0));
                if (abs(homogeneousBoard.z) < 1e-6)
                {
                    return half4(0, 0, 0, 0);
                }

                float2 boardUv = homogeneousBoard.xy / homogeneousBoard.z;
                float4 clip = mul(_BoardToRigClip, float4(boardUv.x, boardUv.y, 0.0, 1.0));
                // w ≤ 0 = 这一点在 rig 相机背后。少了这一道，齐次除法会把符号吃掉，
                // 「桌面在相机背后」也能算出貌似合法的 UV（位姿链上被同一个坑骗过一次）。
                if (clip.w <= 1e-5)
                {
                    return half4(0, 0, 0, 0);
                }

                // NDC y 朝上 → 纹理 v 朝上，与预畸变 shader 采样 GameTexture 的约定一致。
                float2 rigUv = clip.xy / clip.w * 0.5 + 0.5;
                if (rigUv.x < 0.0 || rigUv.x > 1.0 || rigUv.y < 0.0 || rigUv.y > 1.0)
                {
                    return half4(0, 0, 0, 0);
                }

                return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, rigUv);
            }
            ENDHLSL
        }
    }
}
