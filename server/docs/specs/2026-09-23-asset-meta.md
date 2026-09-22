# 素材 meta：每种素材一份 `<素材>.meta`（文档 v24）

> 状态：**已落地**（2026-09-23；v23 只做图片，**v24 扩到音频 / 视频 / 场景**）。
> 四条已定的口径：
> 1. **每个素材一个 `<素材>.meta`**（对齐 Unity，不搞"每目录一个索引文件"）——
>    v24 起**每个素材都有一份**，缺的由编辑器打开项目 / 刷新资源树时补；
> 2. **引用走 GUID**，**下发给前端的载荷仍换算回路径 ID**（协议与 Unity 客户端零改动）；
> 3. **按文件记的数据一律住在它自己的 meta 里**：图片是 `sprite`（导入设置 + 切分），
>    音频是 `audio`（显示名 + 标签 ID，v24 从工程文件的 `audioMeta` 搬来），
>    视频 / 场景暂时只有身份；
> 4. **项目级数据留在 `project.json`**：`audioTags`（标签表：下标 = tag ID）是**项目级**的，
>    不是某一个文件的属性，所以它不跟着文件走。

## 一句话

素材级数据不再以"路径 / 文件名"为键散在工程文件里，而是**每个素材旁边一份 `<素材>.meta`**：
里面是**稳定 GUID** + 该种类的设置（图片的导入设置与切分、音频的显示名与标签）。
素材与它的 `.meta` 成对改名 → GUID 不变 → 场景引用照样有效；
**下发给前端的载荷照旧是路径 ID**，前端一个字节都不用改。

## 为什么改（这次真实踩到的坑）

这些数据原来都以**文件名 / 路径为键**，外部一改名就同时失联：

| 数据 | 现在住在哪 | 键 |
|---|---|---|
| 切分（几列几行） | `Assets/images/A.png.meta` 的 `sprite.sheet` | 素材 GUID（v22 及更早：`project.json` 的 `spriteSheets`，键是图片路径 ID） |
| 导入设置（Sprite / Default / Single / Multiple） | 同上，`sprite.mode` | 同上（v22 及更早：`project.json` 的 `spriteSettings`） |
| 对象取第几格 | 场景文件里 `SpriteLayer.data` | 图片路径 ID（`ImageRef.id`）+ 可选 `guid` |
| 音频的显示名 / 标签 | `Assets/audio/x.mp3.meta` 的 `audio` | 素材（v23 及更早：`project.json` 的 `audioMeta`，键是音频路径 ID） |
| 标签表 | `project.json` 的 `audioTags` | **项目级**（下标 = tag ID），不搬 |

实测：`20260922-1410xx.png` 在磁盘上被改名成 `A/B/C/D.png` 之后，`spriteSheets`/`spriteSettings`
留下三条孤儿键（旧名），场景里那个精灵对象还指着 `…/20260922-141038.png` —— 图、切分、格子引用三份全断。
**Unity 不会这样**：它的资产身份是 `.meta` 里的 GUID，改名/移动由编辑器把 `.meta` 一起搬，引用不受影响。

## 文件形态

```
Assets/images/A.png          ← 素材（外部提交；编辑器只读它）
Assets/images/A.png.meta     ← 它的元数据（这份是编辑器写的）
Assets/audio/theme.mp3       ← 素材
Assets/audio/theme.mp3.meta  ← 它的元数据（显示名 + 标签在这里）
Assets/scenes/场景1.json      ← 素材
Assets/scenes/场景1.json.meta ← 它的元数据（只有身份 + 导入器）
```

```json
{
  "formatVersion": 1,
  "guid": "6f1c2b3a9d4e47f0b8c5a1d2e3f40516",
  "importer": "texture",
  "sprite": { "mode": "Multiple", "sheet": { "columns": 2, "rows": 1 } }
}
```

```json
{
  "formatVersion": 1,
  "guid": "04810aa3bddfc24129b4ceb6bf09cd0c",
  "importer": "audio",
  "audio": { "name": "战斗曲", "tags": [0, 2] }
}
```

- `importer` 是素材的**种类**，也是"哪一段设置有意义"的路由：`texture` / `audio` / `video` / `scene`。
  由编辑器按**项目内相对路径**判定（后缀那一张表与资源面板的图标同源；`.json` 必须落在
  `Assets/scenes/` 里才算场景——`Assets/config/` 下的 `.json` 是项目配置，不是素材，不配 meta）；
- **设置段整段缺省**就是"没整理过"：图片缺 `sprite` = `Default`（普通图片）、音频缺 `audio` =
  用素材文件名、还没打标签。「开过又关掉」的空壳不再写文件（这正是之前 `project.json` 里堆积的噪声）；
- `sprite.mode` 缺省 = `Single`；**1×1 = 整图**（`sheet` 不写），与 `setSpriteSheet` 的规矩一致；
- `audio.tags` 里是**整数 ID**（工程文件 `audioTags` 的下标），去重升序，改标签名不动这里一个字节；
- `.meta` **不进资源树、也不进素材清单**：与 `project.json` / `.gitkeep` / `.dts-tmp` 同一档处理
  （`FsResourceProvider.list` 过滤）；
- `guid`：32 位十六进制（**只认小写**），**生成一次永不变**；缺 guid 的 meta 由
  `parseAssetMetaFile` 补一个并让调用方回写一次。

## 每个素材一份：谁在什么时候补

- **打开项目 / 刷新资源树**时，编辑器遍历资源树，给**还没有 meta 的素材**各建一份
  （新 GUID + 按路径定的 `importer`）并立刻落盘（`project-slice.ts` 的 `loadAssetMetas`）；
- 只补**缺的**：已经有 meta 的素材一个字节都不动（素材与 `.meta` 成对改名之后按新路径 ID 找到它，guid 照旧）；
- 写盘失败（磁盘只读 / 没权限）**只报 warning**：补 meta 是"整理"，不该让项目打不开；
- 素材在编辑器外被加进来 → 下一次刷新资源树时补上；被删掉 → 它那份 `.meta` 成了
  **孤儿 meta**（与 Unity 一样，由人去清；见 README 的已知缺口）。

## 身份与引用

- `ImageRef`（对象身上那份图片引用）多一项 **`guid`**：
  **有 guid 就以 guid 为准**；`id`（路径 ID）保留，用于显示、老文件兜底与推送换算。
- 编辑器读盘后建一份内存索引 `AssetMetas`（`guid → meta` 与 `id → meta` 两个方向）。
  画布、属性面板、资源面板、校验、推送**一律经它解析**，路径只做显示。
- **推送**：`resolveSceneSprites` 把 `guid` 换算回路径 ID 再下发 —— 协议与前端不变
  （这也是"wire 保持路径 ID"那条口径的落点）。
- **音频引用一直是路径 ID**（`sound.clips` / `sound.picked` / `play_bgm{clip}`），v24 不引入音频 guid：
  显示名与标签只是编辑器里给人看的，不参与播放，协议一个字节都不用改。
- **改名**：素材与它的 `.meta` 成对改名 → GUID 不变 → 场景引用、切分、导入设置、音频标注全都还在。
  只改素材、不改 `.meta`（在编辑器外面改名）会变成"孤儿 meta"，与 Unity 一样由人去纠正。

## 迁移（文档 v22 → v23 → v24）

1. **v22 → v23**（图片）：读 `project.json`，把 `spriteSheets` / `spriteSettings` 按路径找到对应素材，
   写进各自的 `.meta`（没有 meta 就新建，含新 GUID）；两项从工程文件里删掉，版本 +1 并回写一次；
2. **v23 → v24**（音频）：读 `project.json` 的 `audioMeta`，按路径写进那个音频文件的 `.meta` 的
   `audio` 段（标签 ID 按 `audioTags` 归一化：越界 / 指向已删的洞 / 重复的一律丢掉）；
   `audioMeta` 从工程文件里删掉，`audioTags` **留着**；版本 +1 并回写一次。
   搬完既没名字也没标签的空壳**不为它写 meta**（缺的那一份由"每个素材一份"那一趟补）；
3. **找不到素材的键（改名留下的孤儿）丢弃并报 warning**——不猜（Unity 也不会猜）；
4. 场景文件里的图片引用补 `guid`（按路径查索引）；查不到的保留原样 + warning；
5. 老前端不受影响：迁移只动文档与新增的 `.meta` 文件，协议载荷形状不变。

## 改动清单

| 层 | 改动 |
|---|---|
| `packages/resources` | `.meta` 后缀 + `assetMetaIdOf` / `isAssetMetaPath` 助手；`list()` 过滤 `.meta` |
| `apps/backend` | `GET /api/projects/meta?name=`（一个项目一次拿全，**所有素材**）；写 meta 走现有 `/api/resources/text` |
| `packages/document` | `asset-meta.ts`（类型 / schema / 解析 / 序列化 / 生成 GUID / `withMetaAudio*`）；`ProjectDoc` 去掉 `spriteSheets` / `spriteSettings`（v23）与 `audioMeta`（v24）；`ImageRef.guid`；`sprites.ts` 改成按索引查；v22 → v23 与 v23 → v24 两条迁移；`validateAssetMetas`（音频标签引用） |
| `apps/editor` | 那条 `metas` 轨道（可撤销；落盘 = 写各自 `.meta`）覆盖**所有素材**；打开项目 / 刷新资源树时补齐缺失的 meta；音频标注的写路径改走 meta 轨道；资源面板 / 画布 / 属性面板 / 推送改走索引 |
| 协议 / Unity 客户端 | **不变** |
| 测试 / 文档 | 迁移、改名不丢精灵、meta 读写、每个素材一份、`.meta` 不出现在面板；README「资源布局」与版本历史 |

## 分步落地（每步跑完测试都保持绿）

1. **资源 + 文档层**：`.meta` id 助手与过滤、`asset-meta.ts`（类型 / schema / 解析 / 生成 GUID）——纯加法；
2. **迁移**：v22→v23（把两份表搬进 meta、工程文件回写）；
3. **装配**：编辑器打开项目时读全部 meta、建索引、把 `ProjectDoc` 的旧字段清干净；
4. **写路径**：切分 / 导入设置改成写 meta（第三条撤销轨道 + 去抖落盘）；
5. **引用**：`ImageRef.guid` + 推送换算 + 画布/属性面板改走索引；
6. **文档**：README 的资源布局与版本历史补齐；
7. **v24**：`importer` 扩成四种、`audio` 段与 `withMetaAudio*`、v23 → v24 迁移搬 `audioMeta`、
   "每个素材一份"的补齐、音频标注改走 meta 轨道、仓库里的测试项目补上全部 `.meta`。
