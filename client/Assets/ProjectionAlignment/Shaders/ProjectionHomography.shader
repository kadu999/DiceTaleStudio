Shader "NuLight/ProjectionAlignment/HomographyWarp"
{
    Properties
    {
        _GameTexture("Game Texture", 2D) = "black" {}
        _ContentMode("Content Mode", Float) = 0
        _InteractionRect("Interaction Rect in Game UV", Vector) = (0.21875, 0, 0.5625, 1)
        _ShowBoardGrid("Show Board Grid", Float) = 0
        _CalibrationMarkerVisible("Calibration Marker Visible", Float) = 0
        _CalibrationMarkerProjectorUv("Calibration Marker Projector UV", Vector) = (0.5, 0.5, 0, 0)
        _CalibrationMarkerColor("Calibration Marker Color", Color) = (1, 0.2, 0.05, 1)
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Overlay"
        }

        Pass
        {
            Name "ProjectionHomography"
            ZWrite Off
            ZTest Always
            Cull Off
            Blend Off

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

            TEXTURE2D(_GameTexture);
            SAMPLER(sampler_GameTexture);

            float4x4 _ProjectorToBoard;
            float _ContentMode;
            float4 _InteractionRect;
            float _ShowBoardGrid;
            float _CalibrationMarkerVisible;
            float4 _CalibrationMarkerProjectorUv;
            float4 _CalibrationMarkerColor;

            Varyings Vert(Attributes input)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }

            bool Inside01(float2 uv)
            {
                return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
            }

            float2 BoardToSource(float2 boardUv)
            {
                // The pressure mat occupies only this configurable region of the
                // complete 16:9 game. Board UV may be outside [0,1]; that is how
                // the rest of the game frame continues around the input region.
                return _InteractionRect.xy + boardUv * _InteractionRect.zw;
            }

            half4 Frag(Varyings input) : SV_Target
            {
                float2 projectorUv = float2(input.uv.x, 1.0 - input.uv.y);
                float4 homogeneousBoard = mul(
                    _ProjectorToBoard,
                    float4(projectorUv.x, projectorUv.y, 1.0, 0.0));

                half4 color = half4(0, 0, 0, 1);
                if (abs(homogeneousBoard.z) > 1e-6)
                {
                    float2 boardUv = homogeneousBoard.xy / homogeneousBoard.z;
                    float2 sourceUv = BoardToSource(boardUv);
                    bool interactionOnlyDebug = _ContentMode > 0.5;
                    bool mayRender = !interactionOnlyDebug || Inside01(boardUv);

                    // In the normal mode the 16:9 game continues outside the
                    // square pressure-input region. Black is used only outside
                    // the full 16:9 source image, not outside the board.
                    if (mayRender && Inside01(sourceUv))
                    {
                        float2 textureUv = float2(sourceUv.x, 1.0 - sourceUv.y);
                        color = SAMPLE_TEXTURE2D(_GameTexture, sampler_GameTexture, textureUv);
                    }

                    if (_ShowBoardGrid > 0.5 && Inside01(boardUv))
                    {
                        float2 cellUv = frac(boardUv * 10.0);
                        float2 distanceToGrid = min(cellUv, 1.0 - cellUv);
                        float gridLine = 1.0 - smoothstep(0.008, 0.022, min(distanceToGrid.x, distanceToGrid.y));
                        float2 edgeDistance = min(boardUv, 1.0 - boardUv);
                        float edge = 1.0 - smoothstep(0.002, 0.008, min(edgeDistance.x, edgeDistance.y));
                        half3 gridColor = half3(0.05, 0.85, 1.0);
                        color.rgb = lerp(color.rgb, gridColor, saturate(gridLine * 0.45 + edge));
                    }
                }

                if (_CalibrationMarkerVisible > 0.5)
                {
                    // A ring wider than a fingertip, and a dot to aim a piece base by. The
                    // finger goes inside the ring with the ring still showing all round, so
                    // what gets centred is the contact patch. Covering a solid disc instead
                    // puts the disc under the tip and the pressure peak behind it — a bias
                    // every sample shares and no validation round can see.
                    float2 markerDelta = projectorUv - _CalibrationMarkerProjectorUv.xy;
                    markerDelta.x *= 16.0 / 9.0;
                    float markerDistance = length(markerDelta);
                    float ring = smoothstep(0.021, 0.024, markerDistance)
                        * (1.0 - smoothstep(0.029, 0.032, markerDistance));
                    float centre = 1.0 - smoothstep(0.003, 0.005, markerDistance);
                    half4 marker = _CalibrationMarkerColor;
                    color = lerp(color, marker, ring * marker.a);
                    color = lerp(color, half4(1, 1, 1, 1), centre * marker.a);
                }

                return color;
            }
            ENDHLSL
        }
    }
}
