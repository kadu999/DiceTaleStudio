Shader "DiceTale/FogOfWar"
{
    Properties
    {
        _FogMask ("Fog Mask", 2D) = "white" {}
        _FogColor ("Fog Color", Color) = (0, 0, 0, 1)
    }

    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" }
        LOD 100

        Pass
        {
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _FogMask;
            float4 _FogColor;

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float mask = tex2D(_FogMask, i.uv).r;
                float fogAlpha = pow(saturate(1.0 - mask), 0.7);
                return fixed4(_FogColor.rgb, fogAlpha * _FogColor.a);
            }
            ENDCG
        }
    }
}
