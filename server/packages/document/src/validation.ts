import { PAINTABLE_MASKS, decodeRle } from "@dts/grid";
import { componentKindMismatchOf, isKnownComponentType } from "./components";
import {
  canRepairObjectComponent,
  fogOf,
  imageOf,
  isFogEnabled,
  magnifierDataOf,
  mapDataOf,
  soundDataOf,
  teleportDataOf,
  videoBlendDataOf,
  videoDataOf,
} from "./access";
import type { AssetMetaDoc, AssetMetas } from "./asset-meta";
import { DEFAULT_SLOT_COMPONENT, supportsFog } from "./presets";
import { spriteSheetOf } from "./sprites";
import type {
  AudioTagTableDoc,
  ProjectDoc,
  ProjectSettingsDoc,
  SceneDoc,
  GameObjectDoc,
} from "./types";

/** 结构性校验（场景 / 对象 / 组件 / 项目级数据）。 */

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  readonly level: IssueLevel;
  /** 定位路径，例如 `scenes/Map001/objects/door_01`。 */
  readonly path: string;
  readonly message: string;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}

/**
 * `validateScene` 的可选输入：**跨文件的知识**。
 *
 * 场景文件里只有「引用哪张图 + 第几格」，而「几行几列」住在**素材自己的 `.meta`** 里——
 * 不把那份索引（`AssetMetas`）传进来，就只能校验格子是非负整数（schema 那一层已经做了），
 * 查不出「格子超出这张图的切分」。不传 = 跳过这条（只读场景文件、手上没有 meta 的调用方
 * 不必伪造一份）。
 */
export interface SceneValidationOptions {
  readonly metas?: AssetMetas;
}

/**
 * 子图引用的校验（v20）：格子必须落在那张图的切分范围内。
 *
 * 越界**不算错**：切分可能先被改小（改的是素材的 `.meta`，对象留在场景文件里没动），
 * 而渲染与推送会统一夹到最后一格——所以这里只提醒「你看到的不是你要的那一格」。
 * 带网格的贴图那一份由 `validateObject` 里「带网格的贴图不支持子图」管。
 */
function validateObjectSprite(
  object: GameObjectDoc,
  path: string,
  metas: AssetMetas | undefined,
  issues: ValidationIssue[],
): void {
  if (metas === undefined) {
    return;
  }

  const image = imageOf(object);
  const sprite = image?.sprite;
  if (image === undefined || sprite === undefined) {
    return;
  }

  // 按引用查（guid 优先）：素材改过名时引用上的路径是旧的，切分在 guid 那一份上
  const sheet = spriteSheetOf(metas, image);
  if (sprite.column >= sheet.columns || sprite.row >= sheet.rows) {
    issues.push({
      level: "warning",
      path: `${path}/image/sprite`,
      message: `子图 (${sprite.column}, ${sprite.row}) 超出这张图的切分 ${sheet.columns}×${sheet.rows}（按最后一格显示）`,
    });
  }
}

function checkPosition(
  position: { x: number; y: number },
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    issues.push({ level: "error", path, message: "位置不是有限数值" });
  }

  // 世界坐标的范围就是场景范围（±宽/2、±高/2），而校验拿不到场景尺寸；
  // 这里**不**给坐标设上下限——越界的对象在画布上看得见，比静默拒绝更有用。
}

/**
 * 单个对象的校验。
 *
 * `sceneName` 只有一处用得上：传送阵的「目标就是自己所在的场景」是个没意义的配置
 * （按下去什么都不会发生）——别的规则都只看对象自己。
 */
function validateObject(
  object: GameObjectDoc,
  path: string,
  issues: ValidationIssue[],
  sceneName?: string,
): void {
  if (object.position !== null) {
    checkPosition(object.position, `${path}/position`, issues);
  }

  // 缩放：画布按「矩形尺寸 × 缩放」画，0 / 负数 / NaN 都画不出来（渲染端会退回 1，
  // 但那是兜底，不是数据正确——所以这里明确报错，别让坏数据悄悄留在文件里）。
  //
  // v8 起是等比的 `scale`，v11 起还可以有**可选**的单轴 `scaleX` / `scaleY`：
  // 三个字段各自按同一个规则查（缺省的单轴字段本身就是合法写法，不报错），
  // 路径分别写出来，才知道是哪一个数坏了。
  if (!Number.isFinite(object.scale) || object.scale <= 0) {
    issues.push({
      level: "error",
      path: `${path}/scale`,
      message: `缩放必须是正数（现在 ${String(object.scale)}）`,
    });
  }

  for (const axis of ["scaleX", "scaleY"] as const) {
    const value = object[axis];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      issues.push({
        level: "error",
        path: `${path}/${axis}`,
        message: `单轴缩放必须是正数（现在 ${String(value)}）`,
      });
    }
  }

  // 网格（v28 起是贴图上的可选组件）：有网格就校验格子数据；没有 = 普通贴图，不报错
  const map = mapDataOf(object);
  if (map !== undefined) {
    try {
      decodeRle(map.cells.runs, map.grid.width * map.grid.height);
    } catch (error) {
      issues.push({
        level: "error",
        path: `${path}/map/cells`,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // 带网格的贴图不支持子图（v20）：网格的格子是按**整张**贴图算好的，取一块会让已经画好的
    // 格子标注含义静默改变。编辑器与前端都按整图渲染（见 `sprites.ts` 的 `displaySpriteOf`），
    // 所以这里要说出来——不然「明明切了却不生效」无从排查
    const gridImage = imageOf(object);
    if (gridImage?.sprite !== undefined) {
      issues.push({
        level: "warning",
        path: `${path}/components/ImageLayer/sprite`,
        message: "带网格的贴图不支持子图（取一块会让已有格子错位），这一项会被忽略",
      });
    }
  }

  // 战争雾（v27 起是独立的 `Fog` 对象；开关与雾区住它自己的 `FogOfWar` 组件里）
  const fog = fogOf(object);
  if (fog === undefined && supportsFog(object)) {
    issues.push({
      level: "error",
      path,
      message: "战争雾对象缺少雾数据（引用哪张地图 / 开关 / 雾区）",
    });
  }

  if (fog !== undefined) {
    // 指定的雾区位必须是可绘制的区域位：手写文件里写了别的值（0、3、256…），
    // 编辑器会把它丢掉，所以这里得说出来——不然「明明指定了却不生效」无从排查
    const fogRegions = fog.regions;
    const unknownRegions = fogRegions.filter((bit) => !PAINTABLE_MASKS.some((value) => value === bit));
    if (unknownRegions.length > 0) {
      issues.push({
        level: "warning",
        path: `${path}/components/FogOfWar/regions`,
        message: `战争雾指定的 ${unknownRegions.join(", ")} 不是可绘制的区域位（会被忽略）`,
      });
    }

    // 「开关开着但一个雾区都没指定」= 前端不会建雾层，也不会有雾：这不是错，
    // 但画面上什么都不会发生，得说一句（属性面板 → 战争雾 → 指定雾区）
    if (isFogEnabled(object) && fogRegions.length === 0) {
      issues.push({
        level: "warning",
        path: `${path}/components/FogOfWar/regions`,
        message: "战争雾开着但没指定雾区（不会有雾）",
      });
    }

    // 反过来同理：开关关着时绑定是留着的（再打开就回来），但「现在没有雾」这件事要说清
    if (!isFogEnabled(object) && fogRegions.length > 0) {
      issues.push({
        level: "warning",
        path: `${path}/components/FogOfWar/enabled`,
        message: "战争雾关着：指定的雾区不会生成雾（打开开关才生效）",
      });
    }
  }
  // 声音对象（动作对象）：基础属性与实体一样，另加声音数据——缺了就是个什么都不播的空壳
  const sound = soundDataOf(object);
  if (sound === undefined && canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.sound)) {
    issues.push({ level: "error", path, message: "声音对象缺少声音数据（音频列表 / 层级）" });
  }
  if (sound !== undefined) {
    /*
      背景音乐不再属于对象（顶栏「音乐」弹框管：清单就是项目 `Assets/audio/` 下的音频）。
      schema 仍然认 `bgm`（老文件里对象可能写着它，协议里它也是声道名），
      但界面上不再给这个选项——所以这里明确提醒作者把这条改成音效或旁白。
    */
    if (sound?.layer === "bgm") {
      issues.push({
        level: "warning",
        path: `${path}/sound/layer`,
        message: "背景音乐已改成顶栏「音乐」弹框（play_bgm 那一组）：请把这条改成音效或旁白",
      });
    }

    if (sound !== undefined && sound.clips.some((clip) => clip.trim().length === 0)) {
      issues.push({
        level: "warning",
        path: `${path}/sound/clips`,
        message: "音频列表里有空条目（会被忽略）",
      });
    }

    // 选中的那条必须落在音频列表里：对不上就是数据坏了，按「还没选」处理（播放按钮点不了）
    if (sound?.picked !== undefined && !sound.clips.includes(sound.picked)) {
      issues.push({
        level: "warning",
        path: `${path}/sound/picked`,
        message: "选中的那条音频不在音频列表里（按还没选处理）",
      });
    }

    // 它画的是**固定的内置图标**（不给换贴图），所以 `image` 字段没有意义
    if (imageOf(object) !== undefined) {
      issues.push({
        level: "warning",
        path: `${path}/image`,
        message: "声音对象用固定的内置图标（不允许改贴图），多余的 image 字段会被忽略",
      });
    }
  }

  // 传送阵（动作对象）：基础属性与实体一样，另加「候选目标场景 + 选中的那一个」
  const teleport = teleportDataOf(object);
  if (teleport === undefined && canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.teleport)) {
    issues.push({ level: "error", path, message: "传送阵缺少传送数据（候选目标场景）" });
  }
  if (teleport !== undefined) {
    // 还没勾任何目标是**合法状态**（刚建出来就是这样），但要提醒：那时传送按钮点不了
    if (teleport.targets.length === 0) {
      issues.push({
        level: "warning",
        path: `${path}/teleport/targets`,
        message: "传送阵还没加目标场景（面板上点不了「传送」）",
      });
    }

    if (teleport.picked === undefined) {
      if (teleport.targets.length > 0) {
        issues.push({
          level: "warning",
          path: `${path}/teleport/picked`,
          message: "传送阵还没选要传送到哪一张场景（面板上点不了「传送」）",
        });
      }
    } else if (!teleport.targets.includes(teleport.picked)) {
      // 对不上就是数据坏了，按「还没选」处理（传送按钮点不了）
      issues.push({
        level: "warning",
        path: `${path}/teleport/picked`,
        message: "选中的目标场景不在候选里（按还没选处理）",
      });
    } else if (teleport.picked === sceneName) {
      // 自己传自己 = 按下去什么都不发生，多半是选错了
      issues.push({
        level: "warning",
        path: `${path}/teleport/picked`,
        message: "传送阵的目标就是它自己所在的场景（按下去不会换图）",
      });
    }
  }

  /*
    放大镜（动作对象，v30）：图片列表 + 当前展示的那一张。
    与传送阵那几条同一个口径——错了都是「按没加 / 按没选处理」，所以只报警告不拦运行：
    一条都没加、加了但没选，都是**合法状态**（刚建出来就是这样），但那时窗口里没图可放。
  */
  const magnifier = magnifierDataOf(object);
  if (magnifier === undefined && canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.magnifier)) {
    issues.push({ level: "error", path, message: "放大镜缺少图片数据（图片列表 + 当前展示的那一张）" });
  }
  if (magnifier !== undefined) {
    if (magnifier.images.length === 0) {
      issues.push({
        level: "warning",
        path: `${path}/magnifier/images`,
        message: "放大镜还没加图片（窗口中间没有图可放）",
      });
    }

    if (magnifier.picked === undefined) {
      if (magnifier.images.length > 0) {
        issues.push({
          level: "warning",
          path: `${path}/magnifier/picked`,
          message: "放大镜还没选要展示哪一张（窗口中间没有图可放）",
        });
      }
    } else if (magnifier.picked >= magnifier.images.length) {
      // 对不上就是数据坏了（列表被改短 / 手写文件），按「还没选」处理
      issues.push({
        level: "warning",
        path: `${path}/magnifier/picked`,
        message: "要展示的那一张不在图片列表里（按还没选处理）",
      });
    }
  }

  /*
    视频列表（v14 起）：**挂载 VideoOverlay 的对象**能带；kind 只用于缺组件旧对象的迁移期诊断。
    与声音那几条同一个口径——错了都是「按没加 / 按没选处理」，所以只报警告不拦运行。
    旧 kind 与显式组件不一致时保留组件，并在组件遍历处给迁移提示；不因 kind 忽略其数据。
    **扩展名不在这里校验**：webm 在 Windows 上多半解不了属于「这台机器的解码器」问题，
    提醒放在界面上（选择器 / 面板），免得每次打开场景都报一遍。
  */
  const video = videoDataOf(object);
  if (video !== undefined) {
    if (video.clips.some((clip) => clip.trim().length === 0)) {
      issues.push({
        level: "warning",
        path: `${path}/video/clips`,
        message: "视频列表里有空条目（会被忽略）",
      });
    }

    if (video.picked !== undefined && !video.clips.includes(video.picked)) {
      issues.push({
        level: "warning",
        path: `${path}/video/picked`,
        message: "选中的那条视频不在视频列表里（按还没选处理）",
      });
    }
  }

  /*
    视频混合（v17，可选）：**两路素材**（每路是图片或视频，见 `VideoBlendChannelDoc`）。
    遮罩不在文档里（纯运行态），所以这里没有可校验的遮罩。

    「视频」与「视频混合」**互斥**（`access.ts` 的准入层直接拒绝同时添加），所以这里报的是
    手写文件里的损坏数据——**error**（读取不拦，让人去摘掉一个）。

    素材引用本身校验不了：「这个 ID 存不存在 / 是不是 `kind` 说的那一种」要查素材表，
    那在编辑器手里，不在文档校验的范围里。
  */
  if (videoBlendDataOf(object) !== undefined && video !== undefined) {
    issues.push({
      level: "error",
      path: `${path}/components`,
      message: "同时挂了「视频」与「视频混合」：二者互斥、不能共存（请摘掉一个）",
    });
  }

  const componentIds = new Set<string>();
  for (const component of object.components) {
    const componentPath = `${path}/components/${component.id}`;
    if (componentIds.has(component.id)) {
      issues.push({ level: "error", path: componentPath, message: `组件 id 重复: ${component.id}` });
    }

    componentIds.add(component.id);

    if (!isKnownComponentType(component.type)) {
      issues.push({
        level: "warning",
        path: componentPath,
        message: `未知组件类型: ${component.type}（数据将原样保留）`,
      });
      continue;
    }

    if (componentKindMismatchOf([component], object.kind)) {
      issues.push({
        level: "warning",
        path: componentPath,
        message: `组件 ${component.type} 与 kind=${object.kind} 的旧模板不一致；组件数据仍保留并按组件生效`,
      });
    }
  }
}

/** 校验单个场景。 */
export function validateScene(
  scene: SceneDoc,
  options: SceneValidationOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = `scenes/${scene.name}`;

  if (scene.name.trim().length === 0) {
    issues.push({ level: "error", path: base, message: "场景名不能为空" });
  }

  // 对象（地图也只是其中之一）
  const objectIds = new Set<string>();
  for (const object of scene.objects) {
    const path = `${base}/objects/${object.id}`;
    if (objectIds.has(object.id)) {
      issues.push({ level: "error", path, message: `对象 id 重复: ${object.id}` });
    }

    objectIds.add(object.id);
    if (object.id.trim().length === 0) {
      issues.push({ level: "error", path, message: "对象 id 不能为空" });
    }

    validateObject(object, path, issues, scene.name);
    validateObjectSprite(object, path, options.metas, issues);
  }

  // 战争雾对象：引用的「带网格的贴图」必须真实存在、且一个最多一个雾对象
  const fogByMap = new Map<string, string>();
  for (const object of scene.objects) {
    if (fogOf(object) === undefined) {
      continue;
    }

    const path = `${base}/objects/${object.id}`;
    const mapId = fogOf(object)?.mapId ?? "";
    const map = mapId.length === 0 ? undefined : scene.objects.find((item) => item.id === mapId);
    if (map === undefined || mapDataOf(map) === undefined) {
      issues.push({
        level: "error",
        path: `${path}/components/FogOfWar/mapId`,
        message:
          mapId.length === 0
            ? "战争雾还没选引用的网格"
            : `战争雾引用的对象不存在或没有网格：${mapId}`,
      });
      continue;
    }

    if (fogByMap.has(mapId)) {
      issues.push({
        level: "error",
        path: `${path}/components/FogOfWar/mapId`,
        message: `这个网格已经有战争雾了（一个网格最多一个）`,
      });
      continue;
    }

    fogByMap.set(mapId, object.id);
  }

  return issues;
}

/**
 * 全局设置里的「音频」那一份（v15 起；v16 起背景音乐也只剩音量）。
 *
 * v16 之前这里还要校验歌单 / 默认曲 / 名字——那些字段已经不在文档里了（曲目清单就是
 * 项目 `Assets/audio/` 下的音频，由编辑器弹框列出来），所以这里只剩三档音量。
 *
 * 音量越界单独说一句：前端会按 `0..1` 用，写 `1.5` 的人多半以为能放大声音。
 */
function validateAudioSettings(
  settings: ProjectSettingsDoc | undefined,
  issues: ValidationIssue[],
): void {
  const volumes: ReadonlyArray<readonly [string, number | undefined]> = [
    ["settings/audio/bgm/volume", settings?.audio?.bgm?.volume],
    ["settings/audio/sfx/volume", settings?.audio?.sfx?.volume],
    ["settings/audio/voice/volume", settings?.audio?.voice?.volume],
  ];

  for (const [path, volume] of volumes) {
    if (volume === undefined) {
      // 手搭的文档可能没有这一项（schema 会给默认值），不算问题
      continue;
    }

    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      issues.push({
        level: "warning",
        path,
        message: `音量应在 0..1（现在 ${String(volume)}，会被夹进范围内）`,
      });
    }
  }
}

/**
 * 音频标签表（v18 起）：空名字、重名。
 *
 * 重名**不拦**（与 Unity 一致：可以有两个同名标签，只是显示上分不清），只报 warning 提醒整理。
 */
function validateAudioTags(table: ProjectDoc["audioTags"], issues: ValidationIssue[]): void {
  if (table === undefined) {
    return;
  }

  const seen = new Map<string, number>();
  for (const [id, name] of table.entries()) {
    if (name === null) {
      // 洞：删掉的标签留的位置，正常
      continue;
    }

    // 空名字 = **还没起名字的槽位**（序号预先定好、只填名字的界面会留下这种），不是脏数据
    if (name.trim().length === 0) {
      continue;
    }

    const trimmed = name.trim();
    const first = seen.get(trimmed);
    if (first !== undefined) {
      issues.push({
        level: "warning",
        path: `audioTags/${id}`,
        message: `标签名与 #${first} 重复: ${trimmed}（建议改成不同的名字）`,
      });
      continue;
    }

    seen.set(trimmed, id);
  }
}

/**
 * **素材 meta** 的校验（v24 起）：音频那一段里的标签引用是否还站得住。
 *
 * 这些原来长在 `validateProject` 里（v17–v23，那条 `audioMeta` 住在工程文件里）：
 * v24 把「哪个文件用了哪个标签」搬进**那个文件自己的 `.meta`** 之后，工程文件那一边
 * 已经无从校验，所以校验跟着数据一起搬过来——`tags` 参数就是工程文件里的那张表。
 *
 * 全部只报 **warning**：这些是「数据对不上」，不该把项目拦在门外；界面上会把这些引用
 * **忽略掉**照常显示其它标签，作者在「标签」窗口里改一下就好。
 * guid 的重复 / 悬空引用暂不在这里查（那要看整份 meta 表，见 README 的已知缺口）。
 */
export function validateAssetMetas(
  entries: ReadonlyArray<{ readonly id: string; readonly meta: AssetMetaDoc }>,
  tags: AudioTagTableDoc | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const { id, meta } of entries) {
    const name = meta.audio?.name;
    if (name !== undefined && name.trim().length === 0) {
      issues.push({
        level: "warning",
        path: `${id}/audio/name`,
        message: "显示名是空的（会退回素材文件名）",
      });
    }

    validateTagIdList(`${id}/tags`, meta.tags, tags, issues);
    validateTagIdList(`${id}/audio/tags`, meta.audio?.tags, tags, issues);
  }

  return issues;
}

/** 查一份标签 ID 列表（顶层 `tags` 与音频旧段 `audio.tags` 同一套规矩，路径不同而已）。 */
function validateTagIdList(
  path: string,
  ids: readonly number[] | undefined,
  tags: AudioTagTableDoc | undefined,
  issues: ValidationIssue[],
): void {
  if (ids === undefined) {
    return;
  }

  if (ids.length === 0) {
    issues.push({
      level: "warning",
      path,
      message: "标签列表是空的（会被忽略）",
    });
    return;
  }

  const seen = new Set<number>();
  for (const [index, tagId] of ids.entries()) {
    if (!Number.isInteger(tagId) || tagId < 0 || tagId >= (tags?.length ?? 0)) {
      issues.push({
        level: "warning",
        path: `${path}/${index}`,
        message: `标签 ID ${String(tagId)} 不在标签表里（会被忽略）`,
      });
      continue;
    }

    if (tags?.[tagId] === null) {
      issues.push({
        level: "warning",
        path: `${path}/${index}`,
        message: `标签 ID ${tagId} 已经被删掉了（会被忽略）`,
      });
      continue;
    }

    if (seen.has(tagId)) {
      issues.push({
        level: "warning",
        path: `${path}/${index}`,
        message: `标签 ID ${tagId} 重复（会被去掉）`,
      });
      continue;
    }

    seen.add(tagId);
  }
}

/**
 * 校验工程文件里的项目级数据。
 *
 * 场景已各自成文件、由 `validateScene` 逐个校验，所以这里不再遍历场景；
 * 场景名唯一性也由文件系统保证（同名即同文件）。
 * **音频文件的标注不在这里**：v24 起它住在各素材的 `.meta` 里，由 `validateAssetMetas` 查。
 */
export function validateProject(doc: ProjectDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (doc.items.count !== doc.items.items.length) {
    issues.push({
      level: "warning",
      path: "items/count",
      message: `道具库 count=${doc.items.count} 与实际条目数 ${doc.items.items.length} 不一致`,
    });
  }

  validateAudioSettings(doc.settings, issues);
  validateAudioTags(doc.audioTags, issues);

  return issues;
}

/** 把问题列表整理成可读多行文本（进入运行态被阻止时展示）。 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.level === "error" ? "✗" : "!"} ${issue.path}: ${issue.message}`)
    .join("\n");
}
