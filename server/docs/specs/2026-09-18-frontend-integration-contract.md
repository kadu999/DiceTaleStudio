# 前端（Unity 客户端）对接契约

> 状态：**待实施**。前端当前未开放，本文件是编辑器侧已经依赖、前端侧需要补齐的最小契约。
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

## 5. 服务端侧的行为（已实现）

- 编辑器在 `/editor` 上发 `invoke_action` → 服务端原样转发到 `/client`，并按 `requestId` 关联回执；
- 前端未连接时立刻回 `editor_error`（`reason: "前端未连接，无法触发动作"`）；
- 5 秒内没有收到 `action_result` 会回 `editor_error`（提示前端可能未实现本命令），**不会静默挂起**；
- `action_result` 会广播给所有已连接的编辑器，并写入运行日志。

## 6. 兼容与降级

- 前端未实现 `invoke_action` 时，编辑器仍可用**原子命令直通**（`set_option` 等）触发副作用：
  组件改值 → 客户端本地动作链自然执行；
- 因此前端可以分步落地：先上报动作清单（只读展示），再实现 `invoke_action`。

## 7. 验收

前端落地后，以下链路应能直接跑通（编辑器侧测试已经在跑同样的链路，只是对端是 Mock）：

1. 启动后端与编辑器，编辑器切到运行态；
2. 运行面板出现对象与动作清单（说明契约二生效）；
3. 点击某个动作的「触发」，前端执行并回执，编辑器日志出现「执行成功」；
4. 触发一个不存在的 actionId，编辑器日志出现「执行失败：…」而不是超时。
