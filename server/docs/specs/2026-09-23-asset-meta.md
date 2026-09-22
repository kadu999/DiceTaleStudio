# 素材 meta：图片的导入设置与切分（文档 v23）

> 状态：**进行中**（2026-09-23 定稿；范围：**只做图片**，音频/视频/场景沿用现状）。
> 三条已定的口径：
> 1. **每个素材一个 `<素材>.meta`**（对齐 Unity，不搞"每目录一个索引文件"）；
> 2. **引用走 GUID**，**下发给前端的载荷仍换算回路径 ID**（协议与 Unity 客户端零改动）；
> 3. GUID 化**先只覆盖图片**（精灵 / 贴图的导入设置与切分）。

## 一句话

精灵（子图）那套数据不再按"路径 ID"塞在 `project.json` 里，改成**每个素材旁边一个 `<素材>.meta`**：
里面是**稳定 GUID** + 导入设置 + 切分。素材与它的 `.meta` 成对改名 → GUID 不变 → 场景引用照样有效；
**下发给前端的载荷照旧是路径 ID**，前端一个字节都不用改。

## 为什么改（这次真实踩到的坑）

现在这三份数据都以**文件名/路径为键**，外部一改名就同时失联：

| 数据 | 现在住在哪 | 键 |
|---|---|---|
| 切分（几列几行） | `project.json` 的 `spriteSheets` | 图片路径 ID |
| 导入设置（Sprite / Default / Single / Multiple） | `project.json` 的 `spriteSettings` | 图片路径 ID |
| 对象取第几格 | 场景文件里 `SpriteLayer.data` | 图片路径 ID（`ImageRef.id`） |

实测：`20260922-1410xx.png` 在磁盘上被改名成 `A/B/C/D.png` 之后，`spriteSheets`/`spriteSettings`
留下三条孤儿键（旧名），场景里那个精灵对象还指着 `…/20260922-141038.png` —— 图、切分、格子引用三份全断。
**Unity 不会这样**：它的资产身份是 `.meta` 里的 GUID，改名/移动由编辑器把 `.meta` 一起搬，引用不受影响。

## 文件形态

```
Assets/images/A.png          ← 素材（外部提交；编辑器只读它）
Assets/images/A.png.meta     ← 它的元数据（这份是编辑器写的）
```

```json
{
  "formatVersion": 1,
  "guid": "6f1c2b3a9d4e47f0b8c5a1d2e3f40516",
  "importer": "texture",
  "sprite": { "mode": "Multiple", "sheet": { "columns": 2, "rows": 1 } }
}
```

- `sprite` **缺省 = Default**（普通图片）：`{ type: "Default" }` 那种"开过又关掉"的空壳不再写文件
  （这正是之前 `project.json` 里堆积的噪声）；
- `mode` 缺省 = `Single`；
- **1×1 = 整图**（`sheet` 不写），与 `setSpriteSheet` 现在的规矩一致；
- 只有**图片**有 `.meta`（本次范围）；以后音频/视频/场景按同一套扩；
- `.meta` **不进资源树、也不进素材清单**：与 `project.json` / `.gitkeep` / `.dts-tmp` 同一档处理；
- `guid`：32 位十六进制，**生成一次永不变**；编辑器在需要时补写（迁移 / 首次设精灵 / 首次挑图）。

## 身份与引用

- `ImageRef`（对象身上那份图片引用）多一项 **`guid`**：
  **有 guid 就以 guid 为准**；`id`（路径 ID）保留，用于显示、老文件兜底与推送换算。
- 编辑器读盘后建一份内存索引 `AssetMetas`（`guid → meta` 与 `id → meta` 两个方向）。
  画布、属性面板、资源面板、校验、推送**一律经它解析**，路径只做显示。
- **推送**：`resolveSceneSprites` 把 `guid` 换算回路径 ID 再下发 —— 协议与前端不变
  （这也是"wire 保持路径 ID"那条口径的落点）。
- **改名**：素材与它的 `.meta` 成对改名 → GUID 不变 → 场景引用、切分、导入设置全都还在。
  只改素材、不改 `.meta`（在编辑器外改名）会变成"孤儿 meta"，与 Unity 一样由人去纠正。

## 迁移（文档 v22 → v23）

1. 读 `project.json`：把 `spriteSheets` / `spriteSettings` 按路径找到对应素材，写进各自的 `.meta`
   （没有 meta 就新建，含新 GUID）；两项从工程文件里删掉，版本 +1 并回写一次；
2. **找不到素材的键（改名留下的孤儿）丢弃并报 warning**——不猜（Unity 也不会猜）；
3. 场景文件里的图片引用补 `guid`（按路径查索引）；查不到的保留原样 + warning；
4. 老前端不受影响：迁移只动文档与新增的 `.meta` 文件，协议载荷形状不变。

## 改动清单

| 层 | 改动 |
|---|---|
| `packages/resources` | `.meta` 后缀 + `metaIdOf` / `isMetaId` 助手；`list()` 过滤 `.meta` |
| `apps/backend` | `GET /api/projects/meta?name=`（一个项目一次拿全）；写 meta 走现有 `/api/resources/text` |
| `packages/document` | 新增 `asset-meta.ts`（类型 / schema / 解析 / 序列化 / 生成 GUID）；`ProjectDoc` 去掉 `spriteSheets` / `spriteSettings`（v23）；`ImageRef.guid`；`sprites.ts` 改成按索引查；新增 v22→v23 迁移；校验（重复 GUID、悬空引用） |
| `apps/editor` | store 多一条 `metas` 轨道（可撤销；落盘 = 写各自 `.meta`）；打开项目时装配索引并补迁移；资源面板 / 画布 / 属性面板 / 推送改走索引 |
| 协议 / Unity 客户端 | **不变** |
| 测试 / 文档 | 迁移、改名不丢精灵、meta 读写、`.meta` 不出现在面板；README「资源布局」与版本历史 |

## 分步落地（每步跑完测试都保持绿）

1. **资源 + 文档层**：`.meta` id 助手与过滤、`asset-meta.ts`（类型 / schema / 解析 / 生成 GUID）——纯加法；
2. **迁移**：v22→v23（把两份表搬进 meta、工程文件回写）；
3. **装配**：编辑器打开项目时读全部 meta、建索引、把 `ProjectDoc` 的旧字段清干净；
4. **写路径**：切分 / 导入设置改成写 meta（第三条撤销轨道 + 去抖落盘）；
5. **引用**：`ImageRef.guid` + 推送换算 + 画布/属性面板改走索引；
6. **文档**：README 的资源布局与版本历史补齐。
