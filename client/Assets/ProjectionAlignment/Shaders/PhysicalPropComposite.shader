Shader "NuLight/ProjectionAlignment/PhysicalPropComposite"
{
    // 实物层的合成（2026-09-08，见 PhysicalPropLayer 类注释）。
    // 对投影仪每个输出像素 P：B = H(P) 是它落在垫面的哪一点；实物层的两台相机 NDC ≡ 板 UV，
    // 所以直接在 B 采样 —— 颜色取「站在镜头位置 C 渲整个场景」那张，alpha 取「只渲实物」那张的覆盖。
    // 光线打在实物上的地方盖住底下的正交画面，其余地方一个像素都不动。
    Properties
    {
        _MainTex("Unused (RawImage)", 2D) = "black" {}
        _PropTex("Prop Camera", 2D) = "black" {}
        _MaskTex("Mask Camera", 2D) = "black" {}
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
            Name "PhysicalPropComposite"
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

            TEXTURE2D(_PropTex);
            SAMPLER(sampler_PropTex);
            TEXTURE2D(_MaskTex);
            SAMPLER(sampler_MaskTex);

            // 标定单应：投影帧 UV（y 朝下）→ 板 UV。与 HomographyWarp 用同一份矩阵；单机预览时是单位阵。
            float4x4 _ProjectorToBoard;

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
                if (boardUv.x < 0.0 || boardUv.x > 1.0 || boardUv.y < 0.0 || boardUv.y > 1.0)
                {
                    return half4(0, 0, 0, 0);
                }

                // 板 V 朝下、纹理 v 朝上。
                float2 texUv = float2(boardUv.x, 1.0 - boardUv.y);
                half3 color = SAMPLE_TEXTURE2D(_PropTex, sampler_PropTex, texUv).rgb;
                half mask = SAMPLE_TEXTURE2D(_MaskTex, sampler_MaskTex, texUv).a;
                return half4(color, mask);
            }
            ENDHLSL
        }
    }
}
