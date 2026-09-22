// 地面贴图面片 Shader:与地面平行的 4 顶点面片(ImageLayer / SpriteLayer 共用)。
// 片元 = 纹理 × 顶点色;顶点色由组件写入 mesh.colors(GroundLayer 的染色参数),
// 因此染色不依赖材质 _Color —— legacy built-in Unlit/Transparent 的 constantColor 染色
// 在 URP 下不生效,而顶点色这条路径在 built-in / URP 下都稳定(与 SpriteRenderer 同路线)。
// _Color 默认白色仅作备用额外染色口,组件不使用它。
// straight alpha 混合(Blend SrcAlpha OneMinusSrcAlpha),支持带透明通道的 PNG。
Shader "DiceTale/ImageLayer"
{
    Properties
    {
        _Color ("整体染色 (默认白,一般不用)", Color) = (1, 1, 1, 1)
        _MainTex ("贴图", 2D) = "white" {}
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

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
                float4 vertex : SV_POSITION;
            };

            v2f vert(appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                o.color = v.color * _Color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                return tex2D(_MainTex, i.uv) * i.color;
            }
            ENDCG
        }
    }
}