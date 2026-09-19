# DiceTaleStudio

跑团（TRPG）编辑工具：**Web 编辑器 + 服务端 + Unity 前端**，用于编辑地图网格、场景对象与对象上的动作，
并可在运行状态下连接前端触发这些动作。

**数据在后端，前端只做显示**：对象 / 动作 / 组件 / 场景数据都由后端拥有并下发，
前端不再上报数据、也不再按 id 寻址动作（旧模型已整层删除，见 `client/docs/`）。

## 仓库结构

```
DiceTaleStudio/
├── server/     # 编辑器与服务端（开发范围，详见 server/README.md）
└── client/     # Unity 前端：显示层 + 输入采集 + WebSocket 传输骨架（详见 client/README.md）
```

资源（地图数据、图片、配置、道具库、项目文件）统一归口在 `server/resources/`，代码不硬编码任何资源路径。
