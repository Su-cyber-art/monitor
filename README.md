# monitor

文档：[monitor-document.pages.dev](https://monitor-document.pages.dev)，安装、配置、反向代理与主题开发都在这里。

主题站：[monitor-themes.pages.dev](https://monitor-themes.pages.dev)，在线预览各个公开页主题，复制地址即可在面板安装。

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook

## 组成

| 仓库 | 说明 |
|---|---|
| [monitor](https://github.com/Su-cyber-art/monitor) | hub：后台、API、公开页宿主 |
| [agent](https://github.com/Su-cyber-art/agent) | Linux agent |
| [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | 内置默认主题 |
| [themes](https://github.com/monitor-probe/themes) | 主题站：收录第三方主题，提供在线预览 |

```
agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```

## 后台界面

后台的视觉设计参考 [WAOR/Monitor-SAO](https://github.com/WAOR/Monitor-SAO)，使用中性深浅配色、分层卡片和状态色。桌面端提供分组侧栏和节点表格，手机与平板提供顶栏菜单及节点卡片；延迟列表和升级结果会在窄屏下按字段展示。节点卡片可直接编辑，通过更多操作完成安装、续费、排序和删除。

## 批量升级 agent

后台「更新」页填写目标版本、选择在线节点，即可统一下发升级，并查看每台节点的下载、重启、成功或失败状态。升级记录保存在 SQLite，刷新页面不会丢失。只有新进程连接主控并报告目标版本，才会显示成功；10 分钟没有完成确认会显示超时。

需要配套的 **agent v1.3.0 或更新版本**，并用本仓库的新版 `install.sh` 安装。旧版 agent 无法接收升级指令，首次需要通过批量 SSH 等方式运行一次新版安装脚本的 `--upgrade`；后续即可在后台完成。先发布包含自更新能力的 agent，再更新主控及旧节点的安装布局。

安装脚本将实际二进制放在 `/opt/monitor/agent/monitor-agent`，保留 `/opt/monitor/monitor-agent` 为链接。只有该 agent 目录归 `monitor-agent` 用户所有，主控、凭证文件和服务定义仍由各自原有用户管理。systemd 仅为该目录开放写权限，OpenRC 继续使用独立普通用户运行。

升级复用主控的发布文件中转与签名验证，固定下载指定版本，不下发 shell 命令。agent 下载期间继续上报，校验架构和版本后原子替换自身；新进程无法连接主控，或在确认前被服务管理器重启时，恢复之前的二进制并回报失败。

管理员 API：

```http
POST /api/agent-upgrades
Content-Type: application/json

{"ids":[1,2],"version":"1.3.1"}
```

`GET /api/agent-upgrades` 返回各节点最近一次升级及其状态。重复提交不会重复执行正在进行的升级，离线或不支持自更新的节点会返回明确失败原因。以上接口沿用后台会话鉴权和同源写入检查。

WebSocket 命令为 `agent.upgrade`，参数为 `{id, version}`；agent 使用 `upgrade.result` 回报 `downloading`、`restarting` 或 `failed`，新进程在 `hello` 中带回 `upgrade_id` 与实际 `agent_version`。`can_upgrade` 表明该会话已启用自更新，仅管理后台可见。

验证真实升级链路时，准备两个不同版本、支持自更新的 Linux agent 构建，然后运行：

```sh
sh scripts/e2e-upgrade.sh /absolute/old/monitor-agent /absolute/new/monitor-agent
```

该测试使用临时主控和测试签名验证真实进程的批量替换、持续上报、失败保留和服务重启回退，不需要生产发布私钥。
