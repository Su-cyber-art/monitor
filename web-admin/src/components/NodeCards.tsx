import type { ReactNode } from "react"
import { ArrowDownToLine, ArrowUpFromLine, Copy, Cpu, Layers, Server, ShieldCheck, Wifi, WifiOff } from "lucide-react"

import type { Node } from "@/lib/api"
import { shortAddress } from "@/lib/api"
import { bytes, FOREVER, money } from "@/lib/format"

export function NodeOverview({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((node) => node.online).length
  const statistics = [
    { label: "全部节点", value: nodes.length, caption: "已接入主控", icon: Server, tone: "purple" },
    { label: "在线节点", value: online, caption: "正在保持连接", icon: Wifi, tone: "green" },
    { label: "离线节点", value: nodes.length - online, caption: nodes.length - online ? "等待恢复连接" : "节点连接正常", icon: WifiOff, tone: "orange" },
    { label: "支持远程升级", value: nodes.filter((node) => node.online && node.can_upgrade).length, caption: "当前在线且已启用", icon: ShieldCheck, tone: "blue" },
  ]
  return (
    <div className="node-overview" aria-label="节点概况">
      {statistics.map(({ label, value, caption, icon: Icon, tone }) => (
        <div className="overview-stat" data-tone={tone} key={label}>
          <div className="overview-stat-label"><span className="overview-stat-icon"><Icon className="size-4" /></span>{label}</div>
          <div className="overview-stat-value tnum">{value}<span>台</span></div>
          <p>{caption}</p>
        </div>
      ))}
    </div>
  )
}

function Resource({ label, value, icon: Icon }: { label: string; value: number | null; icon: typeof Cpu }) {
  return (
    <div className="node-resource">
      <div><span><Icon className="size-3.5" />{label}</span><strong className="tnum">{value === null ? "未上报" : `${value.toFixed(1)}%`}</strong></div>
      {value !== null && <progress max={100} value={value} aria-label={label} />}
    </div>
  )
}

export function NodeCards({ nodes, actions, onCopy, searching }: {
  nodes: Node[]
  actions: (node: Node) => ReactNode
  onCopy: (text: string) => void
  searching: boolean
}) {
  return (
    <div className="node-card-grid">
      {nodes.map((node) => (
        <article className="node-card" key={node.id} data-node-id={node.id} aria-label={node.name}>
          <div className="node-card-heading">
            <span className="node-card-symbol"><Server className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <h2>{node.name}</h2>
              <div className="node-card-tags">
                {node.country && <span>{node.country}</span>}
                {node.group && <span>{node.group}</span>}
                {!node.public && <span>不公开</span>}
              </div>
            </div>
            <span className="node-status" data-online={node.online}>{node.online ? "在线" : "离线"}</span>
          </div>
          <div className="node-card-addresses">
            {node.addresses?.length ? node.addresses.map(({ address }) => (
              <button key={address} type="button" onClick={() => onCopy(address)} aria-label={`复制 ${address}`}>
                <span className="tnum">{shortAddress(address)}</span><Copy className="size-3.5" />
              </button>
            )) : <span className="text-sm text-muted-foreground">暂未上报地址</span>}
          </div>
          {node.online && node.metrics && (
            <div className="node-card-resources">
              <Resource label="CPU" value={node.metrics.cpu} icon={Cpu} />
              <Resource label="内存" value={node.metrics.mem_total > 0 ? node.metrics.mem_used / node.metrics.mem_total * 100 : null} icon={Layers} />
            </div>
          )}
          <dl className="node-card-details">
            <div><dt>本期流量</dt><dd className="tnum">{bytes(node.month_used)}<span> / {node.traffic_limit > 0 ? bytes(node.traffic_limit) : FOREVER}</span></dd></div>
            <div><dt>费用 / 到期</dt><dd>{node.price > 0 ? money(node.price, node.currency) : "免费"}<span> · {node.expires_at || FOREVER}</span></dd></div>
          </dl>
          <div className="node-card-footer">
            <span className="node-version">{node.agent_version ? `v${node.agent_version}` : "版本未上报"}</span>
            {node.online && node.metrics && <span className="node-throughput tnum"><ArrowDownToLine className="size-3" />{bytes(node.metrics.net_rx)}/s <ArrowUpFromLine className="size-3" />{bytes(node.metrics.net_tx)}/s</span>}
          </div>
          <div className="node-card-actions">{actions(node)}</div>
        </article>
      ))}
      {!nodes.length && <div className="node-card-empty"><Server className="size-7" /><p>{searching ? "没有匹配的节点" : "还没有节点，添加你的第一台服务器"}</p></div>}
    </div>
  )
}
