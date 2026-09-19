Shader "DiceTale/FogOfWarAccumulate"
{
    Properties
    {
        _MainTex ("Previous Mask", 2D) = "black" {}
    }

    SubShader
    {
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_TexelSize;

            float2 _GridOrigin;
            float2 _GridSize;
            float _CellSize;
            float _RevealRadius;
            float _SoftEdgeWidth;
            int _PlayerCount;
            float4 _PlayerPositions[8];

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
                float2 worldPos = _GridOrigin + i.uv * _GridSize * _CellSize;

                float innerRadius = max(0.0, _RevealRadius - _SoftEdgeWidth);
                float currentVis = 0.0;

                for (int p = 0; p < _PlayerCount; p++)
                {
                    float dist = distance(worldPos, _PlayerPositions[p].xy);
                    float v = 1.0 - smoothstep(innerRadius, _RevealRadius, dist);
                    currentVis = max(currentVis, v);
                }

                float prevMask = tex2D(_MainTex, i.uv).r;
                float result = max(prevMask, currentVis);

                return fixed4(result, result, result, 1.0);
            }
            ENDCG
        }
    }
}
