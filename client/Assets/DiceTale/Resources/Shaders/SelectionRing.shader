// 选中光环 Shader：水平 Quad + 黑白光环图（白=光环/高光，黑=透明）。
// 片元阶段把图的白色当高光强度（_Intensity 放大），乘 _Color 染色输出；
// 透明混合写死在 shader 内，与管线下配材质无关。
Shader "DiceTale/SelectionRing"
{
    Properties
    {
        _Color ("光环颜色 (RGBA)", Color) = (0.95, 0.9, 0.35, 0.85)
        _Intensity ("高光强度", Range(0.5, 4)) = 1.5
        _MainTex ("光环黑白图 (R 通道)", 2D) = "black" {}
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" }
        Blend SrcAlpha OneMinusSrcAlpha
        Cull Off
        ZWrite Off

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_ST;
            float4 _Color;
            float _Intensity;

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
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                // 黑白图：白色做高光（强度放大），黑色透明
                float highlight = saturate(tex2D(_MainTex, i.uv).r * _Intensity);
                return fixed4(_Color.rgb * highlight, highlight * _Color.a);
            }
            ENDCG
        }
    }
}