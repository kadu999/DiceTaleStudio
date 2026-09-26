// 视频混合面片 Shader：两张视频纹理（A 盖住 / B 擦开露出）+ 一张 Mask 逐像素混合。
//
// 与 ImageLayer.shader 同一套：顶点色染色、straight alpha 混合、Cull Off / ZWrite Off，
// 只多两张贴图。mask.a = 1 → A；mask.a = 0 → B（擦开的地方露出 B）。
//
// Mask 由 C# 侧（VideoBlend）按**与编辑器 Mask 窗口同一张尺寸**画出来（软边圆刷，只改 alpha），
// 所以投影上擦出来的范围与编辑器预览一致。
//
// 这里 **不做羽化**：Mask 是软边圆刷画的（不像战争雾那样按格子填方块），
// 双线性过滤已经够柔，不需要再跑一条模糊链。
Shader "DiceTale/VideoBlend"
{
    Properties
    {
        _Color ("整体染色 (默认白,一般不用)", Color) = (1, 1, 1, 1)
        // GroundLayer 会往 `mainTexture` 写一份（视频层给它 null）——留个 `_MainTex` 免得 Unity 报警告
        _MainTex ("(未用)", 2D) = "white" {}
        _TexA ("视频 A（盖住）", 2D) = "white" {}
        _TexB ("视频 B（擦开露出）", 2D) = "black" {}
        _Mask ("遮罩（alpha 决定显示哪条）", 2D) = "white" {}
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

            sampler2D _TexA;
            sampler2D _TexB;
            sampler2D _Mask;
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
                o.uv = v.uv;
                o.color = v.color * _Color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 a = tex2D(_TexA, i.uv);
                fixed4 b = tex2D(_TexB, i.uv);
                float m = tex2D(_Mask, i.uv).a;
                return lerp(b, a, m) * i.color;
            }
            ENDCG
        }
    }
}
