// 擦除遮罩填充 Shader（配合 Graphics.Blit 使用，挂在擦除遮罩材质上）：
//   每次 Graphics.Blit(null, maskRT, 本材质) 把一条"进度边界"画进遮罩 RenderTexture：
//     _WipeProgress：0~1 擦除进度（0 = 全部未覆盖，1 = 全部覆盖）
//     _Direction：0 = 从左到右（覆盖侧在左），1 = 从右到左（覆盖侧在右）
//     _BlendWidth：交界混合带宽（UV 单位，0 = 硬边；带宽内纹理1/纹理2 平滑交叉混合）
//   输出 = 覆盖度（写满各通道，合成端读 mask.r）。
//   使用前先用 GL.Clear 把 maskRT 清成黑色。
Shader "DiceTale/WipeMask"
{
    Properties
    {
        _WipeProgress ("擦除进度 (0~1)", Range(0, 1)) = 0
        _Direction ("方向 (0=左→右, 1=右→左)", Float) = 0
        _BlendWidth ("交界混合带宽 (UV)", Range(0, 0.5)) = 0.1
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" }
        Blend Off
        Cull Off
        ZWrite Off

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            float _WipeProgress;
            float _Direction;
            float _BlendWidth;

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
                // 方向归一：_Direction=0 用 uv.x（覆盖侧在左），=1 用 1-uv.x（覆盖侧在右）
                float x = lerp(i.uv.x, 1.0 - i.uv.x, saturate(_Direction));
                float p = saturate(_WipeProgress);
                float w = max(_BlendWidth, 1e-4); // 防止 smoothstep 上下沿相等产生除零

                // 交界混合：x < p-w 全覆盖（=1），x > p+w 未覆盖（=0），带宽内平滑过渡
                float coverage = 1.0 - smoothstep(p - w, p + w, x);
                return fixed4(coverage, coverage, coverage, coverage);
            }
            ENDCG
        }
    }
}
