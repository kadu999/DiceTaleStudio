// 框遮罩填充 Shader（配合 Graphics.Blit 使用，挂在遮罩材质上）：
//   每次 Graphics.Blit(null, maskRT, 本材质) 把一个框画进遮罩 RenderTexture：
//     输出 = 框覆盖度（边缘羽化后的 0~1，写满各通道；合成端读 mask.r）。
//   多个框多次 Blit，BlendOp Max 取并集（顺序无关、数量无上限）。
//   使用前先用 GL.Clear 把 maskRT 清成黑色。
Shader "DiceTale/RectMask"
{
    Properties
    {
        _RectCenter ("框中心 (UV)", Vector) = (0.5, 0.5, 0, 0)
        _RectSize ("框大小 (UV)", Vector) = (0.5, 0.5, 0, 0)
        _EdgeSoftness ("边缘羽化 (UV)", Range(0, 0.5)) = 0.02
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" }
        BlendOp Max
        Blend One One
        Cull Off
        ZWrite Off

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            float4 _RectCenter;
            float4 _RectSize;
            float _EdgeSoftness;

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                float4 vertex : SV_POSITION;
            };

            v2f vert(appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                float2 uv = i.uv;

                // 框判定（UV 空间）：框内 edgeDist < 0，框外 > 0
                float2 halfSize = max(_RectSize.xy * 0.5, 1e-5);
                float2 d = abs(uv - _RectCenter.xy) - halfSize;
                float edgeDist = max(d.x, d.y);
                float soft = max(_EdgeSoftness, 1e-4); // 防止 smoothstep 上下沿相等产生除零
                float inside = 1.0 - smoothstep(-soft, soft, edgeDist);

                // 只写覆盖度（写满各通道，R8/ARGB32 遮罩都可用）
                return fixed4(inside, inside, inside, inside);
            }
            ENDCG
        }
    }
}
