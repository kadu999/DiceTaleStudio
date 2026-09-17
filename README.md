# DiceTaleStudio

跑团（TRPG）编辑工具：**Web 编辑器 + 服务端**，用于编辑地图网格、场景对象与对象上的动作，并可在运行状态下连接前端触发这些动作。

## 仓库结构

```
DiceTaleStudio/
├── server/     # 编辑器与服务端（当前开发范围，详见 server/README.md）
└── client/     # Unity 前端（尚未并入本仓库）
```

资源（地图数据、图片、配置、道具库、项目文件）统一归口在 `server/resources/`，代码不硬编码任何资源路径。
