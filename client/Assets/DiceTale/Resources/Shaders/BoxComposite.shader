// 双纹理框选合成 Shader + 场景灯光影响（URP 版本）：
//   两种用法：
//   a) 直接挂到输出 MeshRenderer 的材质上（推荐，输出到 MeshRenderer）：
//      _MainTex = 背景纹理（纹理1）、_StaticTex = 效果纹理（纹理2）、_MaskTex = 框遮罩（RectMask 画出的 RT），
//      mesh 直接渲染合成结果，无需额外合成 RT。
//   b) 配合 Graphics.Blit(背景纹理, 目标, 本材质) 使用（_MainTex 由 Blit 自动传入源纹理）。
//   一对一混合：两张纹理都按同一套 quad UV 采样，遮罩 alpha 直接作为混合权重——
//              mask.a = 0（擦除/覆盖侧）显示效果纹理（纹理2），mask.a = 1（黑/未覆盖侧）显示背景纹理（纹理1），
//              中间值 = 半透明边缘：两张图在羽化带内按 alpha 线性交叉混合，融合自然。
//   边缘羽化由各遮罩生成端负责（RectMask._EdgeSoftness / WipeMask._BlendWidth / MaskEraseStamp._StampSoftness）；
//   _MaskEdgeSoftness 只做端点截止：0 = 完全线性跟随遮罩（默认），越大混合带越窄，0.5 = 退化为硬边。
//
//   灯光影响（2026-09 新增，URP）：合成结果接收场景灯光——
//     主光（方向光，GetMainLight）+ 附加光（聚光灯/点光，GetAdditionalLights，含距离/角度衰减）+
//     环境光（SampleSH，强度 _AmbientStrength 可调）。
//     _LightMode：
//       0 = 亮度模式（默认）：不依赖法线朝向，点光/聚光靠近变亮、方向光按强度整体照亮，
//           适合贴图/合成面板（平放的盒子顶面也能清楚看到被灯照亮/变暗）；
//       1 = 漫反射模式：按网格法线与光方向点积做明暗（法线朝灯的面向更亮，背面更暗）。
//     _LightStrength = 0 时退化为原合成无光照。
Shader "DiceTale/BoxComposite"
{
    Properties
    {
        _MainTex ("背景纹理 (纹理1)", 2D) = "white" {}
        _StaticTex ("静态纹理 (纹理2)", 2D) = "white" {}
        _MaskTex ("框遮罩", 2D) = "black" {}
        _BackgroundTint ("背景纹理颜色", Color) = (1, 1, 1, 1)
        _StaticTint ("静态纹理颜色", Color) = (1, 1, 1, 1)
        _MaskEdgeSoftness ("遮罩端点截止比例 (0=线性, 0.5=硬边)", Range(0, 0.5)) = 0.05
        _LightStrength ("灯光强度 (0=无光照)", Range(0, 2)) = 1
        _AmbientStrength ("环境光强度 (调低让明暗更明显)", Range(0, 1)) = 0.4
        _LightMode ("光照模式 (0=亮度, 1=漫反射)", Float) = 0
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" }
        Blend SrcAlpha OneMinusSrcAlpha
        Cull Off
        ZWrite Off

        Pass
        {
            Tags { "LightMode"="UniversalForward" "RenderType"="Transparent" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // URP 光照变体（与官方 Lit.shader 一致）：
            //   Forward 路径 → _ADDITIONAL_LIGHTS（逐物体附加光）
            //   Forward+ 路径 → _CLUSTER_LIGHT_LOOP（光簇附加光，URP 运行时全局开关）
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHT_SHADOWS
            #pragma multi_compile _ _CLUSTER_LIGHT_LOOP
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);
            TEXTURE2D(_StaticTex);
            SAMPLER(sampler_StaticTex);
            TEXTURE2D(_MaskTex);
            SAMPLER(sampler_MaskTex);

            half4 _BackgroundTint;
            half4 _StaticTint;
            float _MaskEdgeSoftness;
            float _LightStrength;
            float _AmbientStrength;
            float _LightMode;

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float3 normal : NORMAL;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                float3 positionWS : TEXCOORD1;
                float3 normalWS : TEXCOORD2;
                float4 positionCS : SV_POSITION;
            };

            v2f vert(appdata v)
            {
                v2f o;
                VertexPositionInputs posInputs = GetVertexPositionInputs(v.vertex.xyz);
                o.positionCS = posInputs.positionCS;
                o.uv = v.uv;
                o.positionWS = posInputs.positionWS;
                o.normalWS = TransformObjectToWorldNormal(v.normal);
                return o;
            }

            // 合成背景与效果纹理（遮罩 alpha 为混合权重）
            half4 Composite(float2 uv)
            {
                half4 mask = SAMPLE_TEXTURE2D(_MaskTex, sampler_MaskTex, uv);
                half4 bg = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv) * _BackgroundTint;
                half4 fx = SAMPLE_TEXTURE2D(_StaticTex, sampler_StaticTex, uv) * _StaticTint;

                float edge = saturate(_MaskEdgeSoftness);
                float t = saturate((mask.a - edge) / max(1.0 - 2.0 * edge, 1e-4));
                float coverage = 1.0 - t;
                return lerp(fx, bg, coverage);
            }

            half4 frag(v2f i) : SV_Target
            {
                half4 col = Composite(i.uv);

                // 法线：网格自身法线；Blit/无法线（0）时兜底朝屏幕外（漫反射模式用）
                float3 N = i.normalWS;
                if (dot(N, N) < 1e-4)
                {
                    N = float3(0.0, 0.0, 1.0);
                }
                N = normalize(N);

                // 环境光（球谐，单独乘 _AmbientStrength，避免环境光淹没灯的明暗）
                half3 lighting = SampleSH(N) * _AmbientStrength;

                // 主方向光
                Light mainLight = GetMainLight();
                if (_LightMode < 0.5)
                {
                    // 亮度模式：方向光按强度整体照亮，不依赖法线朝向
                    lighting += mainLight.color * mainLight.distanceAttenuation * mainLight.shadowAttenuation;
                }
                else
                {
                    // 漫反射模式：按法线与光方向点积
                    lighting += mainLight.color * mainLight.distanceAttenuation * mainLight.shadowAttenuation
                              * saturate(dot(N, mainLight.direction));
                }

                // 附加光：聚光灯/点光源（含距离/角度衰减 + 阴影），逐灯累加（URP 标准 LIGHT_LOOP）。
                // Forward+（cluster）：LIGHT_LOOP_BEGIN 用 inputData 做光簇查询遍历聚光/点光；
                // Forward（per-object）：同一宏按 _ADDITIONAL_LIGHTS 逐物体遍历。
                // pixelLightCount 先取计数（cluster 下返回 0、宏忽略该参数走位图遍历；非 cluster 下作为循环上限）。
                uint pixelLightCount = GetAdditionalLightsCount();
                InputData inputData = (InputData)0;
                inputData.positionWS = i.positionWS;
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
                LIGHT_LOOP_BEGIN(pixelLightCount)
                    Light light = GetAdditionalLight(lightIndex, i.positionWS);
                    if (_LightMode < 0.5)
                    {
                        // 亮度模式：只按距离/角度衰减（聚光锥内亮、锥外暗；点光近亮远暗）
                        lighting += light.color * light.distanceAttenuation * light.shadowAttenuation;
                    }
                    else
                    {
                        lighting += light.color * light.distanceAttenuation * light.shadowAttenuation
                                  * saturate(dot(N, light.direction));
                    }
                LIGHT_LOOP_END

                // 按强度混合：_LightStrength = 0 时结果不变（lerp 到 1 = 原合成无光照）
                col.rgb *= lerp(1.0, lighting, saturate(_LightStrength));
                return col;
            }
            ENDHLSL
        }
    }
    Fallback Off
}