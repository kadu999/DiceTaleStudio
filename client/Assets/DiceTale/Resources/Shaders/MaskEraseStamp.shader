// 遮罩笔刷 stamp Shader（MaskObject 内部用 Graphics.Blit 沿轨迹打点，不用于显示材质）：
//   软边擦除（与 GM 画布预览同一公式）：
//     全擦核半径 core = radius × (1 - softness)：核内全擦（alpha=1），
//     核外 core ~ radius 线性渐隐到 0——离中心越远擦除越小。
//     softness=0 → 核=radius → 硬边；softness=1 → 核=0 → 全程线性衰减（无平顶核）。
//   幂等擦除：输出 min(当前 alpha, 1-擦除强度)——同一位置擦 N 次 = 擦 1 次，
//   渐变带不会被反复擦除叠加成硬边（与 GM 画布预览同一公式）。
//   _MainTex = 当前遮罩（Blit 时自动绑定源 maskRT）——必须采样它作为基底。
Shader "DiceTale/MaskEraseStamp"
{
    Properties
    {
        _MainTex ("当前遮罩", 2D) = "white" {}
        _StampCenter ("中心 (纹理像素)", Vector) = (0, 0, 0, 0)
        _StampRadius ("半径 (纹理像素)", Float) = 10
        _StampSoftness ("软边带比例 (0=硬边, 1=全程衰减)", Float) = 1
        _MaskSize ("纹理尺寸", Vector) = (960, 540, 0, 0)
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

            sampler2D _MainTex;
            float4 _StampCenter;
            float _StampRadius;
            float _StampSoftness;
            float4 _MaskSize;

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
                fixed4 base = tex2D(_MainTex, i.uv); // 当前遮罩（Blit 源）

                float2 pos = i.uv * _MaskSize.xy; // 纹理像素坐标（非正方形纹理上仍是正圆）
                float d = distance(pos, _StampCenter.xy);

                // 软边擦除（与 GM 画布预览同一公式）：
                //   核内（d < core）全擦，core ~ radius 线性渐隐——离中心越远擦除越小；
                //   softness=0 → 硬边（核=radius）；softness=1 → 无核全程线性衰减。
                float s = saturate(_StampSoftness);
                float core = _StampRadius * (1.0 - s);
                float stampAlpha = 1.0 - saturate((d - core) / max(_StampRadius - core, 1e-5));

                base.a = min(base.a, 1.0 - stampAlpha); // 幂等擦除：重复擦不加深，渐变带保留（与 GM 预览一致）
                return base;
            }
            ENDCG
        }
    }
}