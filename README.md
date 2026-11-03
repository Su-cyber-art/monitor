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
| [agent](https://github.com/Su-cyber-art/agent) | Linux / Windows / macOS agent |
| [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | 内置默认主题 |
| [themes](https://github.com/monitor-probe/themes) | 主题站：收录第三方主题，提供在线预览 |

```
agent (Linux / Windows / macOS)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```

## 后台界面

后台的视觉设计参考 [WAOR/Monitor-SAO](https://github.com/WAOR/Monitor-SAO)，使用中性深浅配色、分层卡片和状态色。桌面端提供分组侧栏和节点表格，手机与平板提供顶栏菜单及节点卡片；延迟列表和升级结果会在窄屏下按字段展示。节点卡片可直接编辑，通过更多操作完成安装、续费、排序和删除。

## 批量升级 agent

后台「更新」页填写目标版本、选择在线节点，即可统一下发升级，并查看每台节点的下载、重启、成功或失败状态。进行中和失败的任务刷新后仍可查看；当前页面观察到的成功结果会在刷新页面、重新进入更新页或点击「刷新结果」后收起。升级记录仍保存在 SQLite，用于确认升级完成。只有新进程连接主控并报告目标版本，才会显示成功；10 分钟没有完成确认会显示超时。

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

## 跨平台探针

hub v1.8.0 配合 agent v1.4.0 起，面板安装、批量添加与手动升级提供 Linux、Windows、macOS 选择。Windows 在管理员 PowerShell 执行；macOS 和 Linux 以 root 执行。既有节点按上报的系统预选安装命令，卸载命令也随系统变化。

- Linux 继续使用 `/install.sh` 与 `/agent/{arch}`，兼容已有安装和升级命令。
- Windows 使用 `/install.ps1`，下载 `/agent/{arch}?os=windows`，运行原生 Windows 服务。
- macOS 使用 `/install-macos.sh`，下载 `/agent/{arch}?os=macos`，运行 launchd 服务。
- `arch` 为 `x86_64` 或 `aarch64`。下载中转同时校验发布签名与 ELF / PE / Mach-O 平台头，指定版本仍使用 `version` 查询参数。

上线时需要发布配套 agent 仓库中的六个系统/架构构建及 `.sig` 签名，再部署本主控；旧版仅有 Linux 产物的 release 无法提供 Windows/macOS 下载。主控自身仍部署在 Linux。

## 删除节点与远程卸载

后台删除弹窗默认「仅删除主控记录」，保留原有行为；也可选择「彻底删除」，远程停止 agent、清理程序、配置、服务文件和专用用户，收到卸载完成回执后才删除节点与历史数据。同机主控、主控数据库和其他探针不受影响。

远程卸载需要 **hub v1.9.0、agent v1.5.0 或更新版本**，并以 root 运行一次配套新版 `install.sh --upgrade` 安装辅助服务。仅通过面板更新 agent 二进制不会获得系统卸载权限。目前辅助服务支持 systemd；OpenRC、自定义安装和旧版本可继续执行 `install.sh --uninstall` 手动卸载。

普通 agent 只在自己的可写目录放入请求，由 `monitor-agent-uninstall.path` 启动独立的 root 辅助程序 `/opt/monitor/agent-uninstall`。这个程序由安装脚本保存，agent 不能修改；它只删除固定的本探针路径，不执行主控提供的 Shell、路径或任意命令。开始停止服务前必须向主控核对本次请求及本机配置里的节点凭证，避免同机其他实例的请求误卸载本探针；过期或伪造的请求无法执行卸载。

管理员接口为 `POST /api/nodes/{id}/removal` 和 `GET /api/agent-removals`。原有 `DELETE /api/nodes/{id}` 仍只删除记录。WebSocket 下发 `agent.uninstall`，参数 `{id}`；agent 用 `uninstall.result` 回报接收或失败，辅助服务通过 `POST /api/agent/removal` 回报停止服务、清理文件和最终结果。回调使用仅限本次卸载的随机凭证，成功回执重试不会再次删除其他节点。

彻底删除成功后，结果弹窗展示 2 秒并自动关闭，也可点击「完成」立即关闭；失败或未确认的结果保留原因。节点页的进行中任务可重新打开查看进度，失败任务可查看原因与处理。成功记录默认折叠，点击「清除成功记录」后刷新页面也不会重新出现；全部记录清除后进度区域自动收起。离线、不支持和执行失败均保留节点记录；5 分钟未收到最终回执时显示超时或「结果未确认」，不会把断线当作卸载成功。升级和卸载不能同时执行。

`DELETE /api/agent-removals` 接受 `{"ids":["请求 ID"]}`，只清除指定的成功记录，进行中、失败和未确认的任务不受影响。记录通过 `dismissed` 标记从历史中移除，完成回执仍保留，以接收辅助服务重试的最终确认；管理员列表仍提供该标记，使打开中的结果弹窗能够正常完成，即使历史已在其他页面清除。
