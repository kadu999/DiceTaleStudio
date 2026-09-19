Shader "ProjectionAlignment/GridFloor/MintChampagne"
{
    Properties
    {
        _Background ("Near Floor", Color) = (0.34, 0.49, 0.42, 1)
        _HorizonColor ("Horizon Haze", Color) = (0.72, 0.69, 0.56, 1)
        _WarmSideColor ("Champagne Side", Color) = (0.86, 0.70, 0.52, 1)
        _CenterGlowColor ("Center Glow", Color) = (0.96, 0.80, 0.64, 1)
        [HDR] _GridColor ("Grid Color", Color) = (0.11, 0.20, 0.20, 1)
        [HDR] _MajorColor ("Major Grid Color", Color) = (0.20, 0.34, 0.33, 1)
        _GridScale ("Grid Scale", Float) = 1
        _HorizonStart ("Horizon Start", Float) = 4
        _HorizonEnd ("Horizon End", Float) = 19
        _HorizonStrength ("Horizon Strength", Range(0, 1)) = 0.72
        _WarmSideStrength ("Champagne Side Strength", Range(0, 1)) = 0.36
        _CenterGlowStrength ("Center Glow Strength", Range(0, 1)) = 0.55
    }

    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Opaque" "Queue"="Geometry" }

        Pass
        {
            Name "PastelGridFloor"
            Tags { "LightMode"="UniversalForward" }
            Cull Back
            ZWrite On

            HLSLPROGRAM
            #pragma target 3.5
            #pragma vertex Vert
            #pragma fragment Frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _Background;
                float4 _HorizonColor;
                float4 _WarmSideColor;
                float4 _CenterGlowColor;
                float4 _GridColor;
                float4 _MajorColor;
                float _GridScale;
                float _HorizonStart;
                float _HorizonEnd;
                float _HorizonStrength;
                float _WarmSideStrength;
                float _CenterGlowStrength;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
            };

            Varyings Vert(Attributes input)
            {
                Varyings output;
                VertexPositionInputs positionInputs = GetVertexPositionInputs(input.positionOS.xyz);
                output.positionCS = positionInputs.positionCS;
                output.positionWS = positionInputs.positionWS;
                return output;
            }

            float GridLine(float2 coordinate)
            {
                float2 derivative = max(fwidth(coordinate), 0.0001);
                float2 distanceToLine = abs(frac(coordinate - 0.5) - 0.5) / derivative;
                return 1.0 - saturate(min(distanceToLine.x, distanceToLine.y));
            }

            half4 Frag(Varyings input) : SV_Target
            {
                float2 coordinate = input.positionWS.xz * _GridScale;
                float minor = GridLine(coordinate);
                float major = GridLine(coordinate / 5.0);

                float cameraDistance = length(input.positionWS.xz - _WorldSpaceCameraPos.xz);
                float horizon = smoothstep(_HorizonStart, max(_HorizonStart + 0.01, _HorizonEnd), cameraDistance);
                float warmSide = smoothstep(-2.0, 11.0, input.positionWS.x);
                float centerGlow = exp2(-input.positionWS.x * input.positionWS.x * 0.020) * horizon;

                float3 color = lerp(_Background.rgb, _HorizonColor.rgb, horizon * _HorizonStrength);
                color = lerp(color, _WarmSideColor.rgb, warmSide * _WarmSideStrength * (0.75 + 0.25 * horizon));
                color = lerp(color, _CenterGlowColor.rgb, centerGlow * _CenterGlowStrength);

                float gridVisibility = lerp(1.0, 0.34, horizon);
                color += _GridColor.rgb * minor * gridVisibility;
                color += _MajorColor.rgb * major * gridVisibility;
                return half4(color, 1.0);
            }
            ENDHLSL
        }
    }
    FallBack Off
}
