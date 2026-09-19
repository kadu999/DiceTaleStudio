// 墙面火焰（俯视 2D，单面中间镂空）：
// 一块覆盖整个房间的 Quad，shader 按 UV 只在四条墙边（宽 = wallThickness）内画火焰，
// 房间中间镂空（透明）。火焰用"周长坐标系"：沿房间边缘是一整条连续环，
// 噪声/蔓延/闪烁全部沿环采样（环形坐标），四个角是环的一部分 → 转角天然连续，
// 没有两条边相交的"十字"接缝，也不会凸出。
// 每条边的火舌从墙线（内缩留白处）向房间内舔。加色混合，程序化噪声驱动，无贴图依赖。
Shader "DiceTale/FlameStrip"
{
    Properties
    {
        _ColorA ("Flame Outer", Color) = (1, 0.35, 0.06, 1)
        _ColorB ("Flame Core", Color) = (1, 0.85, 0.4, 1)
        _Intensity ("Intensity", Float) = 1.6
        _Height ("Flame Fill Height", Range(0, 1)) = 0.9
        _Spread ("Global Brightness", Range(0, 1)) = 1
        _WallFade ("Wall Edge Fade (Fraction of Band)", Range(0, 0.5)) = 0.25
        _EdgeMargin ("Edge Margin (Fraction of Wall)", Range(0, 0.9)) = 0.15
        _CornerRadius ("Corner Radius (x Wall Thickness)", Range(0, 3)) = 1.5
        _Speed ("Anim Speed", Float) = 1.0
        _Seed ("Seed", Float) = 0.0
        _RoomSize ("Room Size (Width, Height)", Vector) = (3, 3, 0, 0)
        _WallThickness ("Wall Thickness", Float) = 0.45
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
            Name "FlameForward"
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
            float4 _ColorA;
            float4 _ColorB;
            float _Intensity;
            float _Height;
            float _Spread;
            float _WallFade;
            float _EdgeMargin;
            float _CornerRadius;
            float _Speed;
            float _Seed;
            float4 _RoomSize;
            float _WallThickness;
            CBUFFER_END

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float u = input.uv.x;
                float v = input.uv.y;

                // 圆角矩形 SDF（世界单位）：外边界 = 墙线内缩矩形 + 角半径（cornerRadius × 墙厚）。
                // 火焰带 = 外边界向内 wallThickness 厚；等值线全程圆角弧线 → 角上无直角、无对角线。
                float2 pWorld = (float2(u, v) - 0.5) * _RoomSize.xy;
                float halfW = _RoomSize.x * 0.5 - _EdgeMargin * _WallThickness;
                float halfH = _RoomSize.y * 0.5 - _EdgeMargin * _WallThickness;
                float cr = _CornerRadius * _WallThickness;
                cr = min(cr, min(halfW, halfH)); // 房间过小时钳制
                float2 q = abs(pWorld) - float2(halfW, halfH) + cr;
                float sdf = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - cr;
                float hLocal = saturate(-sdf / _WallThickness);
                if (hLocal >= 1.0)
                {
                    return half4(0.0, 0.0, 0.0, 1.0); // 房间中间镂空
                }

                // 周长坐标：沿房间边缘逆时针 0..4（下 u→ / 右 v→ / 上 u← / 左 v←），
                // 四个角处两边坐标相同 → 连续过角，没有"十字"接缝
                float duW = min(pWorld.x + halfW, halfW - pWorld.x); // 到左右墙线的距离
                float dvW = min(pWorld.y + halfH, halfH - pWorld.y); // 到上下墙线的距离
                float p;
                if (dvW <= duW)
                {
                    p = v < 0.5 ? u : 2.0 + (1.0 - u);       // 下墙 0..1 / 上墙 2..3
                }
                else
                {
                    p = u < 0.5 ? 3.0 + (1.0 - v) : 1.0 + v; // 左墙 3..4 / 右墙 1..2
                }
                // 环形采样坐标：噪声/蔓延沿整个环连续（过角无跳变）
                float ang = p * 1.5708; // p*0.25*2π
                float2 ring = float2(cos(ang), sin(ang));

                float t = _Time.y * _Speed + _Seed * 7.13;
                // 火焰高低：沿环的低频起伏 + 高频细节（环形采样 → 转角连续）
                float n1 = noise(ring * 3.0 + float2(t * 0.9, _Seed));
                float n2 = noise(ring * 7.0 + float2(t * 1.9 + 5.0, _Seed * 2.0));
                float top = _Height * (0.5 + 0.5 * n1) + 0.05 * n2;
                top = clamp(top, 0.03, 0.97);

                float body = 1.0 - smoothstep(top * 0.3, top, hLocal);
                // 闪烁用环形坐标采样（与噪声一致）：环的闭合角处 0 与 2π 是同一个点，
                // 不会在对角线处出现亮度台阶
                float flicker = 0.72 + 0.28 * noise(ring * 2.5 + float2(t * 3.7, _Seed));
                float wallFade = smoothstep(0.0, _WallFade, hLocal);

                // 无空间蔓延：整圈同时燃烧，_Spread 作为整体亮度（C# 时间线驱动 0→1）
                float flame = body * flicker * wallFade * saturate(_Spread);
                float3 col = lerp(_ColorA.rgb, _ColorB.rgb, pow(flame, 1.5)) * flame * _Intensity;
                return half4(col, 1.0);
            }
            ENDHLSL
        }
    }
}
