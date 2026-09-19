// 地面燃烧（俯视 2D，单 shader 单 pass）——标准溶解/烧灼模式：
//   波纹图噪声 n + 时间驱动阈值 threshold（随时间下降 = 扩散）：
//     n > threshold → 已烧（黑色）；
//     n ≈ threshold → 燃烧边缘（HDR 黄橘火焰，闪烁）；
//     n 略低于 threshold → 灰色过渡；
//     n 低 → 透明（显示原始地板）。
// 贴图 Clamp 铺满房间一次；alpha 混合，_BurnLevel 同时驱动渐入与扩散。
Shader "DiceTale/ScorchFloor"
{
    Properties
    {
        _BlackColor ("Burned Black", Color) = (0.03, 0.02, 0.02, 1)
        _FlameColor ("Flame HDR Color", Color) = (1.5, 0.6, 0.08, 1)
        _FlameIntensity ("Flame Intensity", Float) = 1.6
        _GrayColor ("Gray Transition", Color) = (0.42, 0.4, 0.37, 1)
        _BurnLevel ("Burn Level (0-1)", Range(0, 1)) = 0
        _Spread ("Time Spread Amount", Range(0, 2)) = 0.9
        _CharTex ("Ripple Map", 2D) = "white" {}
        _TimeScale ("Time Scale", Float) = 1.0
    }
    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "Queue" = "Transparent"
            "IgnoreProjector" = "True"
            "RenderPipeline" = "UniversalPipeline"
        }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off

        Pass
        {
            Name "ScorchFire"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "FireNoise.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            CBUFFER_START(UnityPerMaterial)
            float4 _BlackColor;
            float4 _FlameColor;
            float4 _GrayColor;
            float _FlameIntensity;
            float _BurnLevel;
            float _Spread;
            float _TimeScale;
            CBUFFER_END

            TEXTURE2D(_CharTex);
            SAMPLER(sampler_CharTex);

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.uv;
                float t = _Time.y * _TimeScale;

                // 波纹图噪声（山峰高、湖泊低）
                float n = SAMPLE_TEXTURE2D(_CharTex, sampler_CharTex, uv).r;
                // 时间驱动阈值：从 1（全透明）随 _BurnLevel 下降到 1-扩散量（几乎全烧）
                float threshold = 1.0 - _Spread * _BurnLevel;

                // 已烧（n > threshold）：黑色
                float burned = smoothstep(threshold - 0.04, threshold + 0.04, n);
                // 燃烧边缘（n ≈ threshold）：HDR 黄橘火焰 + 闪烁
                float edge = smoothstep(threshold - 0.1, threshold - 0.02, n)
                           * (1.0 - smoothstep(threshold + 0.02, threshold + 0.1, n));
                // 灰色过渡（未烧一侧的羽化带）
                float gray = (1.0 - burned) * smoothstep(threshold - 0.35, threshold - 0.1, n);

                float flicker = 0.78 + 0.22 * noise(float2(t * 1.7, uv.x * 5.0));
                edge *= flicker;

                // 从透明往上叠：灰 → 火焰 → 黑
                float3 col = float3(1.0, 1.0, 1.0);
                float a = 0.0;
                col = lerp(col, _GrayColor.rgb, gray);
                a = max(a, gray * 0.7);
                col = lerp(col, _FlameColor.rgb * _FlameIntensity, edge);
                a = max(a, edge);
                col = lerp(col, _BlackColor.rgb, burned);
                a = max(a, burned); // 已烧 = 实心（alpha 1 盖住地图），未烧 = 透明（alpha 0 露出地图）

                return half4(col, a);
            }
            ENDHLSL
        }
    }
}
