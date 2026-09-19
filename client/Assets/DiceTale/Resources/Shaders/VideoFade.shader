// 视频交叉淡化 Shader：
//   用于 SmartVideoPlayer.PlayWithFade —— 淡化期间把目标 quad 的材质整体换成此材质：
//   _FromTex = 上一视频最后一帧（冻结帧），_ToTex = 新视频渲染目标（RenderTexture），
//   _Alpha 从 0 → 1 时画面从上一帧平滑过渡到新视频（per-pixel lerp）。
//   输出不透明（alpha=1）：它替代了原视频材质，无需与场景做 alpha 混合。
Shader "DiceTale/VideoFade"
{
    Properties
    {
        _FromTex ("上一帧", 2D) = "black" {}
        _MainTex ("新视频", 2D) = "black" {}
        _Alpha ("淡化进度 (0=上一帧, 1=新视频)", Range(0, 1)) = 0
    }
    SubShader
    {
        Tags { "Queue"="Geometry" "RenderType"="Opaque" }
        Cull Off
        ZWrite On

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _FromTex;
            sampler2D _MainTex;
            float _Alpha;

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
                fixed4 from = tex2D(_FromTex, i.uv);
                fixed4 to = tex2D(_MainTex, i.uv);
                fixed4 c = lerp(from, to, saturate(_Alpha));
                c.a = 1.0; // 不透明输出
                return c;
            }
            ENDCG
        }
    }
    Fallback Off
}
