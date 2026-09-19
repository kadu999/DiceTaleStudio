Shader "ProjectionAlignment/Skybox/Equirectangular"
{
    Properties
    {
        [NoScaleOffset] _MainTex ("Panorama (2:1 Equirectangular)", 2D) = "white" {}
        _Tint ("Tint", Color) = (1, 1, 1, 1)
        _Exposure ("Exposure", Range(0, 8)) = 1
        _Rotation ("Rotation", Range(0, 360)) = 0
        _HorizontalScale ("Horizontal Panorama Scale", Range(0.25, 4)) = 1
        _VerticalScale ("Vertical Panorama Scale", Range(0.25, 4)) = 3
        _FocalPoint ("Forward Focal Point (UV)", Vector) = (0.5, 0.5, 0, 0)
        _Saturation ("Saturation", Range(0, 3)) = 1
        _Contrast ("Contrast", Range(0.5, 2)) = 1
        _LeftTint ("Left Mint Tint", Color) = (0.35, 0.75, 0.58, 1)
        _RightTint ("Right Champagne Tint", Color) = (1.0, 0.82, 0.65, 1)
        _SideTintStrength ("Side Tint Strength", Range(0, 1)) = 0.55
        _CenterGlowColor ("Center Warm Glow", Color) = (0.90, 0.76, 0.60, 1)
        _CenterGlowStrength ("Center Warm Glow Strength", Range(0, 1)) = 0.35
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Background"
            "RenderType" = "Background"
            "PreviewType" = "Skybox"
            "RenderPipeline" = "UniversalPipeline"
        }

        Cull Off
        ZWrite Off

        Pass
        {
            Name "Skybox"

            HLSLPROGRAM
            #pragma target 3.0
            #pragma vertex Vert
            #pragma fragment Frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                half4 _Tint;
                half _Exposure;
                float _Rotation;
                float _HorizontalScale;
                float _VerticalScale;
                float4 _FocalPoint;
                float _Saturation;
                float _Contrast;
                half4 _LeftTint;
                half4 _RightTint;
                float _SideTintStrength;
                half4 _CenterGlowColor;
                float _CenterGlowStrength;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 directionWS : TEXCOORD0;
            };

            Varyings Vert(Attributes input)
            {
                Varyings output;
                VertexPositionInputs positionInputs = GetVertexPositionInputs(input.positionOS.xyz);
                output.positionCS = positionInputs.positionCS;
                output.directionWS = TransformObjectToWorldDir(input.positionOS.xyz);
                return output;
            }

            half4 Frag(Varyings input) : SV_Target
            {
                const float kPi = 3.14159265359;
                const float kTwoPi = 6.28318530718;

                float3 direction = normalize(input.directionWS);
                float screenSide = saturate(direction.x * 1.5 + 0.5);
                float centerGlow = exp2(-(direction.x * direction.x * 7.0 + direction.y * direction.y * 9.0));
                float angle = radians(_Rotation);
                float sineAngle = sin(angle);
                float cosineAngle = cos(angle);
                direction.xz = float2(
                    direction.x * cosineAngle - direction.z * sineAngle,
                    direction.x * sineAngle + direction.z * cosineAngle
                );

                float2 uv;
                float longitude = atan2(direction.x, direction.z) / kTwoPi;
                float latitude = asin(clamp(direction.y, -1.0, 1.0)) / kPi;
                uv.x = frac(longitude * _HorizontalScale + _FocalPoint.x);
                uv.y = saturate(latitude * _VerticalScale + _FocalPoint.y);

                half4 panorama = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);
                float luminance = dot(panorama.rgb, float3(0.2126, 0.7152, 0.0722));
                float3 graded = lerp(luminance.xxx, panorama.rgb, _Saturation);
                graded = max(0.0, (graded - 0.18) * _Contrast + 0.18);
                float sideAmount = abs(screenSide - 0.5) * 2.0 * _SideTintStrength;
                graded *= lerp(1.0.xxx, lerp(_LeftTint.rgb, _RightTint.rgb, screenSide), sideAmount);
                graded = lerp(graded, max(graded, _CenterGlowColor.rgb), centerGlow * _CenterGlowStrength);
                return half4(graded * _Tint.rgb * _Exposure, 1.0);
            }
            ENDHLSL
        }
    }

    Fallback Off
}
