// 地面燃烧火光（俯视 2D，加色层，单 pass）：
// 整块地板均匀火光（无墙边/中心梯度），焦深的地方火光更旺（焦痕贴图 R 调制），
// 整体闪烁；_BurnLevel 控制强度渐强。
Shader "DiceTale/EmberFloor"
{
    Properties
    {
        _EmberColor ("Ember Color", Color) = (1, 0.28, 0.04, 1)
        _BurnLevel ("Burn Level (0-1)", Range(0, 1)) = 0
        _EmberStrength ("Ember Strength", Range(0, 2)) = 0.6
        _CharTex ("Char Texture", 2D) = "white" {}
        _CharTiling ("Char Tiling", Float) = 4.0
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
        Blend One One
        ZWrite Off
        Cull Off

        Pass
        {
            Name "EmberFloorForward"
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
            float4 _EmberColor;
            float _BurnLevel;
            float _EmberStrength;
            float _CharTiling;
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
                // 均匀火光：整块地板同一火光强度，焦深的地方更旺（贴图调制）
                float burn = 0.25 + 0.75 * _BurnLevel; // 点燃初期也有微弱火光
                float glow = burn;
                float charDetail = SAMPLE_TEXTURE2D(_CharTex, sampler_CharTex, uv * _CharTiling).r;
                glow *= lerp(0.7, 1.35, charDetail);
                float flicker = 0.75 + 0.25 * noise(float2(t * 1.5, uv.x * 3.0));
                float3 col = _EmberColor.rgb * glow * _EmberStrength * flicker;
                return half4(col, 1.0);
            }
            ENDHLSL
        }
    }
}
