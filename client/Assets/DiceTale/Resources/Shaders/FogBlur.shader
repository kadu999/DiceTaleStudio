// 战争雾的羽化：把「遮罩」过一遍 3x3 高斯，雾的边缘就不再是方格。
//
// 出处：参考实现 `backend_diceTale` / `LLMNPC_NEWLIGHT_EX` 的 `DiceTale/FogBlur`
// （那边的 `FogOfWar.cs` 用一条模糊链把格子分辨率的雾刷成软边）。
// 本项目的用法见 `Presentation/FogOfWar.cs`：遮罩仍是**像素级**的（编辑器 Mask 窗口同一张尺寸），
// 模糊链跑在**每格 4 个纹素**的 RT 上、跑 4 遍——于是羽化宽度约一格，
// 而 GM 擦出来的形状仍然按遮罩的实际分辨率给（只是边缘同样柔化）。
//
// 与参考实现的两处有意不同（都写在下面代码里）：
// 1. **去掉了「地图边界 2 格内不模糊」的保护**：那边假定最外圈没有雾（雾在第 2 圈），
//    而这里的雾区是 GM 自己绑的区域位，完全可能直接贴着地图边——保护 2 格会让那两圈
//    又露出方格。边界不溢出这件事由 RT 的 `wrapMode = Clamp` 保证（采样夹住，不会向外扩散）；
// 2. **「已擦掉」的判据收紧到 alpha ≈ 0**：战争雾的笔刷是软边的，擦过的地方 alpha 是 0~1 的
//    渐变，那些纹素要照常参与模糊，否则笔刷边缘会被切成硬边（参考实现那张遮罩是二值的，
//    0.5 的判据在那边没这个问题）。
Shader "DiceTale/FogBlur"
{
    Properties
    {
        _MainTex ("Fog State", 2D) = "white" {}
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
            float4 _MainTex_TexelSize;

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

            /// 雾曾经在、现在已经被擦掉的纹素：alpha≈0（只改 alpha，RGB 留着雾色当标记）。
            /// 它们保持透明，并且**不参与模糊**——否则相邻的雾会把它们回填回去。
            bool isClearedFog(fixed4 c)
            {
                return c.a <= 0.02 && (c.r + c.g + c.b) > 0.1;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 center = tex2D(_MainTex, i.uv);
                if (isClearedFog(center))
                {
                    return fixed4(center.r, center.g, center.b, 0);
                }

                // 3x3 高斯（1 遍只羽化约 1 个纹素；链上跑几遍 = 羽化几个纹素，见 FogOfWar.blurPasses）
                float2 texel = _MainTex_TexelSize.xy;
                float weights[3][3] =
                {
                    { 1.0, 2.0, 1.0 },
                    { 2.0, 4.0, 2.0 },
                    { 1.0, 2.0, 1.0 }
                };

                fixed4 col = 0.0;
                float total = 0.0;
                for (int dy = -1; dy <= 1; dy++)
                {
                    for (int dx = -1; dx <= 1; dx++)
                    {
                        fixed4 neighbor = tex2D(_MainTex, i.uv + float2(dx, dy) * texel);
                        if (isClearedFog(neighbor))
                        {
                            continue;
                        }

                        col += neighbor * weights[dy + 1][dx + 1];
                        total += weights[dy + 1][dx + 1];
                    }
                }

                if (total > 0.0)
                {
                    col /= total;
                }

                return col;
            }
            ENDCG
        }
    }
}
