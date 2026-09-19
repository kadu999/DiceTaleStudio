# 前端（Unity 客户端）对接契约

> ⚠️ **已被 [`2026-09-19-runtime-mirror-protocol.md`](2026-09-19-runtime-mirror-protocol.md) 取代（2026-09-19）。**
> 本文件描述的是**老模型**——「前端拥有对象 / 动作 / 条件，后台上报并按 id 寻址」
> （`register_*` / `report_*` / `invoke_action` / 原子命令 / `sync_state`）。
> 那套协议已**整层删除**：新方向是「后台是唯一真源、前端只做镜像与播放」。
> 留在这里只为追溯当时的设计取舍，**不要照它实现**。

> 状态：**已废弃**。前端当前未开放，本文件是编辑器侧已经依赖、前端侧需要补齐的最小契约。
> 编辑器侧已经通过 Mock 前端（`apps/backend/src/mock-client`）与端到端测试
> （`apps/backend/test/runtime-hub.test.ts`）把这条链路锁住，前端落地后应能直接对接。

## 1. 背景：现在缺什么

现状（对照 DiceTale `client/Assets/DiceTale/Scripts`）：

- 动作（`BackendChangeAction` 子类）挂在 `BackendComponent.actions` 列表上，只在组件 `NotifyChanged()` 时**在客户端本地**执行；
- 条件（`ComponentCondition`）也只在客户端本地求值；
- 服务端下行的命令只有**原子值变更**：`set_option` / `set_bool` / `set_int` / `set_float` /
  `set_object_items` / `set_mask_image` / `erase_mask` / `teleport_player` / `set_map` / `sync_state`；
- 上报里只有 `componentData`，**没有动作清单**，而且动作**没有稳定 id**。

因此编辑器**无法寻址、也无法触发任何一个动作**。下面三件事补上即可。

## 2. 契约一：动作要有稳定 `actionId`

`BackendChangeAction` 增加可序列化字段：

```csharp
[SerializeField, Tooltip("稳定动作 ID：供后台/编辑器远程寻址（留空时按「组件ID+序号」自动生成）")]
private string actionId;
```

要求：

- 跨会话稳定（同一 prefab 多次打开、多次上报都得到同一个 id）；
- 同一地图内唯一（编辑器会在进入运行态前校验，重名会阻止进入）；
- 建议在 Inspector 里可见可改，便于策划手动命名。

## 3. 契约二：注册上报动作清单

新增上行消息（`packages/protocol` 已定义并校验）：

```json
{
  "type": "register_actions",
  "objectId": "door_01",
  "componentId": "OptionValue",
  "actions": [
    {
      "actionId": "act_door_video",
      "type": "PlayVideo",
      "displayName": "开门播放过场",
      "paramSummary": "播放 tv_01 的第 1 个视频",
      "conditionSummary": "String = 打开"
    }
  ]
}
```

- 触发时机：与 `register_map_objects` 相同的时机（连接建立、地图加载、对象变化），
  也可以在 `register_map_objects` 的每个 object 里带 `actions` 字段（协议两者都支持）。
- `displayName` / `paramSummary` / `conditionSummary` 都是可选的展示用文本；
  编辑器只把它们显示在运行面板上，不参与寻址。
- 服务端的行为：`register_actions` 会与已有动作清单**合并**（地图重载不会丢失），
  并对**未知 objectId 返回失败**（不会凭空造出幽灵对象）。

## 4. 契约三：`invoke_action` 命令与 `action_result` 回执

服务端 → 前端：

```json
{ "type": "invoke_action", "requestId": "act-xxxx", "objectId": "door_01", "actionId": "act_door_video" }
```

前端 → 服务端：

```json
{
  "type": "action_result",
  "requestId": "act-xxxx",
  "objectId": "door_01",
  "actionId": "act_door_video",
  "ok": true,
  "effects": ["PlayVideo 已执行"]
}
```

失败时：

```json
{ "type": "action_result", "requestId": "act-xxxx", "objectId": "door_01", "actionId": "act_door_video",
  "ok": false, "reason": "该对象上没有这个动作" }
```

实现要点：

- `ServerCommandDispatcher.Dispatch` 增加 `invoke_action` 分支；
- **注意**：现有 `BackendObject.DispatchCommand(commandType, msg)` 是「按命令类型路由到能力组件」，
  而动作挂在组件上、并不由组件自己处理命令。因此 `invoke_action` 需要一条
  **按 `actionId` 定位动作的旁路**（遍历对象上的组件 → 遍历 `actions` → 命中 `actionId`），
  **不要**改动现有组件命令路由的语义；
- 命中后直接调用该动作的 `OnComponentChanged(component)`（条件由动作基类内部评估，语义不变）；
- **无论成功失败都要回 `action_result`**，否则编辑器只能在 5s 超时后报错，体验很差。

## 5. 契约四：认「播放声音」动作对象

编辑器现在能在场景里放**动作对象**（新建对象 →「动作」→「播放声音」）。它和实体一样摆在世界里
（有位置 / 缩放 / 激活 / 锁定 / 显示顺序，画布上画一枚**固定的内置音频图标**——图标不给换，
也不参与协议），在此之上只声明**告诉前端播什么**——编辑器不播放、不解码音频，
只把这份清单写进场景文件：

```json
{ "id": "sound_x", "name": "脚步", "kind": "PlaySound", "position": { "x": 0, "y": 0 },
  "sound": { "clips": ["project:项目/Assets/audio/step1.mp3", "project:项目/Assets/audio/step2.mp3"],
             "picked": "project:项目/Assets/audio/step2.mp3",
             "names": { "project:项目/Assets/audio/step1.mp3": "雷雨" }, "layer": "sfx" } }
```

（`clips` 是这条对象**加进来的**全部音频，`picked` 是**当前选中的那条**——编辑器面板上那些小方块
就是在切换它，缺省 = 还没选；`sound.names` 是「文件 → 显示名」的标签表——**可选、不参与播放**。）

前端要做的两件事：

- **认这个 kind**：`BackendObjectKind` 增加 `PlaySound`（那枚图标只是编辑器的画法，
  不参与协议；前端按自己的表现来）；
- **按层播放**：`layer` 是声道分组（`bgm` 背景音乐 / `ambient` 环境音 / `sfx` 音效 / `voice` 语音）——
  **同层同时只响一条，播新的顶掉旧的**；要播的就是 `picked` 那条（编辑器一次只播一条，
  `clips` 只用来在编辑器里切换）。

什么时候播由前端/后续的触发机制决定（本契约不涉及）；编辑器只保证「播什么、哪一层」这份数据是对的。

## 6. 契约五：接收后台下发的声音命令（**新方向的样板**）

前面的契约一~四都是**老模型**：数据（对象、动作、清单）在前端，后台按 id 寻址。
声音这一套走**新方向**——**数据在后台，前端只是播放效果**：后台把要播的内容整份推下来，
前端不回头查场景数据、也不上报数据。前端要实现的就两条命令 + 一条回执：

```json
{ "type": "play_sound", "requestId": "snd-xxx", "objectId": "sound_x",
  "layer": "sfx", "clips": ["project:项目/Assets/audio/step1.mp3"] }

{ "type": "stop_sound", "requestId": "snd-yyy", "layer": "sfx" }
```

实现要点：

- `play_sound`：按 `layer` 占用声源（**同层同时只响一条，播新的顶掉旧的**），
  播 `clips` 里的那条（编辑器目前**只发选中的那一条**，所以列表长度是 1；
  真给了多条就从中挑一条即可）；`objectId` 只用于排查，不必据此查数据；
- `stop_sound`：停掉该层当前在响的那条（同层只响一条，所以按层停就够）；
- **无论成功失败都要回**：

```json
{ "type": "command_result", "requestId": "snd-xxx", "ok": true, "effects": ["已播放 step1.mp3"] }
```

- 不回执的话，编辑器会在 **5 秒后**报「命令回执超时（5000ms）：前端可能未实现 play_sound」——
  这条链路刻意**不静默失败**；
- 前端未连接时服务端直接回 `editor_error`（`reason: "前端未连接，无法下发声音命令"`）；
- 编辑器**不播放**：它只负责下发；音频解码与出声全在前端（命令里带的就是要播的那条音频，
  前端不必回头查场景数据）；

**编辑器侧的记账与补发**（前端要知道的一点）：

- 编辑器把「哪一层现在该播什么」记在自己的运行态里（不写文档、不进撤销栈）；
  前端不在时点播放**不会丢**——前端（重新）连上的那一刻，编辑器会把记着的每层**补发**一遍；
- 因此前端**可能收到重复的 `play_sound`**（同一条音频、同一层）：按「同层顶替」处理即可，
  已经在播的那条可以忽略、也可以从头重播——**由前端定**（编辑器不做「续播」这种承诺）；
- 前端断开时编辑器把「前端在不在」置为未知（不再显示成已连接），下次连上同样会补发。

## 7. 服务端侧的行为（已实现）

- 编辑器在 `/editor` 上发 `invoke_action` → 服务端原样转发到 `/client`，并按 `requestId` 关联回执；
- 前端未连接时立刻回 `editor_error`（`reason: "前端未连接，无法触发动作"`）；
- 5 秒内没有收到 `action_result` 会回 `editor_error`（提示前端可能未实现本命令），**不会静默挂起**；
- `action_result` 会广播给所有已连接的编辑器，并写入运行日志。

## 8. 兼容与降级

- 前端未实现 `invoke_action` 时，编辑器仍可用**原子命令直通**（`set_option` 等）触发副作用：
  组件改值 → 客户端本地动作链自然执行；
- 因此前端可以分步落地：先上报动作清单（只读展示），再实现 `invoke_action`；
- 声音命令（契约五）与这套老模型**互不依赖**：前端只要实现了 `play_sound` / `stop_sound`
  与 `command_result`，属性面板的 ▶ / ■ 就能直接用，不需要先做动作清单。

## 9. 验收

前端落地后，以下链路应能直接跑通（编辑器侧测试已经在跑同样的链路，只是对端是 Mock）：

1. 启动后端与编辑器，编辑器切到运行态；
2. 运行面板出现对象与动作清单（说明契约二生效）；
3. 点击某个动作的「触发」，前端执行并回执，编辑器日志出现「执行成功」；
4. 触发一个不存在的 actionId，编辑器日志出现「执行失败：…」而不是超时；
5. 场景里放一个「播放声音」对象（加进来的音频 + 选中的那条 + 层级）后，前端能按层播放：
   同层再播一条时，前一条停（契约四）；
6. 编辑器切到运行态、选中声音对象 →「▶ 播放」：前端出声并回 `command_result`，
   运行日志出现「声音命令执行成功」；「■ 停止」同理（契约五）。
