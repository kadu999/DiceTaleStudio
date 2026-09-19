Shader "DiceTale/FogCombine"
{
    Properties
    {
        _FogTex ("Fog Base (blurred)", 2D) = "white" {}
        _MaskTex ("Reveal Mask", 2D) = "white" {}
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

            sampler2D _FogTex;
            sampler2D _MaskTex;

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
                fixed4 fog = tex2D(_FogTex, i.uv);
                fixed mask = tex2D(_MaskTex, i.uv).a;

                // 已揭示区域 mask=0 -> 雾整块消失；未揭示 mask=1 -> 显示羽化后的雾
                fixed4 col = fog;
                col.a *= mask;
                return col;
            }
            ENDCG
        }
    }
}
