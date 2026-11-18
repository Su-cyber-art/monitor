import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUpCircle, ChevronRight, Copy, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"

import { Command, copy, OptionRow } from "@/components/common"
import { agentCommand, type AgentPlatform, type AgentUpgrade, visibleUpgradeResults, api, behind, type Node, outdatedAgents } from "@/lib/api"
import { PlatformOption } from "@/pages/Install"
import { NodePicker } from "@/components/pickers"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type Versions = { hub: string; hub_latest: string; agent_latest: string; notice: boolean }

/**
 * What is running and what is published. Read once per panel load: the hub holds
 * the answer for six hours, so this costs a GitHub lookup a few times a day at
 * most, and nothing at all while nobody opens the panel.
 *
 * A hub that cannot reach github.com answers with empty latest fields, which
 * render as no update rather than as an error.
 */
export function useVersions() {
  const [versions, setVersions] = useState<Versions | null>(null)
  const load = useCallback(() => api<Versions>("/version").then(setVersions).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  return { versions, reload: load }
}

const releaseUrl = (repo: string, version: string) => `https://github.com/Su-cyber-art/${repo}/releases/tag/v${version}`

/** `v1.2.0 → v1.3.0` when something is published, the running version alone otherwise. */
function VersionPair({ current, latest }: { current: string; latest: string }) {
  if (!behind(current, latest)) {
    return <span className="text-xs text-muted-foreground">{latest ? `已是最新 v${current}` : `当前 v${current}`}</span>
  }
  return (
    <span className="text-xs text-muted-foreground">
      v{current} <span className="px-0.5">→</span>
      <span className="ml-0.5 font-medium text-foreground">v{latest}</span>
    </span>
  )
}

/** Outdated nodes grouped by the version they run, oldest first. */
function byVersion(nodes: Node[]): [string, Node[]][] {
  const groups = new Map<string, Node[]>()
  for (const n of nodes) groups.set(n.agent_version, [...(groups.get(n.agent_version) ?? []), n])
  return [...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
}

/**
 * What is published for the hub and the agents. Its own route rather than a
 * banner on the node list; the dot in the navigation is what says there is
 * something here.
 *
 * The hub card names the release alone: how to take it depends on how the hub
 * was installed, script or container, which the hub cannot tell.
 */
export function Update({ versions, reload, nodes, site, refusal }: {
  versions: Versions | null
  reload: () => void
  nodes: Node[]
  site: string
  refusal: string
}) {
  const [saving, setSaving] = useState(false)
  const [platform, setPlatform] = useState<AgentPlatform>("linux")
  if (!versions) return null
  const outdated = outdatedAgents(nodes, versions.agent_latest)
  const bootstrap = outdated.filter((node) => !node.can_upgrade)
  const offline = outdated.filter((n) => !n.online).length
  const upgrade = refusal ? "" : agentCommand(site, platform, ["--upgrade"])
  const unreachable = !versions.hub_latest && !versions.agent_latest

  // Applied on the spot: one switch, and the navigation changes with it.
  async function setNotice(on: boolean) {
    setSaving(true)
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ update_notice: on ? "on" : "off" }) })
      reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {unreachable && (
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">
            查不到最新版本：这台 hub 连不上 api.github.com。GitHub 代理不作用于这一项。
          </p>
        </Card>
      )}

      <Card className="gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">hub</h3>
          <div className="flex items-center gap-3">
            <VersionPair current={versions.hub} latest={versions.hub_latest} />
            {behind(versions.hub, versions.hub_latest) && (
              <Button size="sm" variant="ghost" asChild>
                <a href={releaseUrl("monitor", versions.hub_latest)} target="_blank" rel="noreferrer">
                  发布说明
                </a>
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">agent</h3>
          <span className="text-xs text-muted-foreground">
            {versions.agent_latest
              ? outdated.length
                ? <>最新 v{versions.agent_latest} · <span className="font-medium text-foreground">{outdated.length} 台待升级</span></>
                : `全部已是最新 v${versions.agent_latest}`
              : "查不到版本"}
          </span>
        </div>
        <AgentUpgrades nodes={nodes} latest={versions.agent_latest} />
        {(bootstrap.length > 0 || !versions.agent_latest) && (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              旧版 agent 首次接入：用新版安装脚本更新一次，启用远程升级。下面的命令不含凭证，沿用机器上已有的设置，不会新建节点；之后可直接在本页批量升级。
            </p>
            {upgrade ? (
              <>
                <PlatformOption value={platform} onChange={setPlatform} />
                <Command>{upgrade}</Command>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => copy(upgrade)}>
                    <Copy className="size-4" /> 复制命令
                  </Button>
                  {versions.agent_latest && (
                    <Button size="sm" variant="ghost" asChild>
                      <a href={releaseUrl("agent", versions.agent_latest)} target="_blank" rel="noreferrer">
                        发布说明
                      </a>
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" asChild>
                    <a href="https://monitor-document.pages.dev/install/batch" target="_blank" rel="noreferrer">
                      批量升级的做法
                    </a>
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{refusal}</p>
            )}
            {/* Collapsed until asked for, grouped by version, and bounded in height
                once open, so any number of nodes stays one line on the page. */}
            {outdated.length > 0 && (
              <details className="group border-t pt-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-1.5">
                    <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                    待升级的节点
                  </span>
                  {offline > 0 && <span>其中 {offline} 台离线</span>}
                </summary>
                <div className="mt-3 max-h-60 space-y-3 overflow-auto">
                  {byVersion(outdated).map(([version, group]) => (
                    <div key={version} className="space-y-1.5">
                      <div className="text-xs text-muted-foreground">v{version} · {group.length} 台</div>
                      <div className="flex flex-wrap gap-1.5">
                        {group.map((n) => (
                          <Badge
                            key={n.id}
                            variant="secondary"
                            className={`font-normal ${n.online ? "" : "opacity-50"}`}
                            title={n.online ? undefined : "离线"}
                          >
                            {n.name}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </Card>

      <OptionRow
        title="更新提醒"
        hint="有新版本时在导航的「更新」旁显示小圆点。关闭只是不再显示圆点，这一页照常检查"
        toggle
      >
        <Switch checked={versions.notice} disabled={saving} onCheckedChange={setNotice} />
      </OptionRow>
    </div>
  )
}

const UPGRADE_LABELS = { queued: "等待响应", downloading: "下载中", restarting: "重启并确认版本", succeeded: "升级成功", failed: "升级失败" }
const upgradeRunning = (job: AgentUpgrade) => !["succeeded", "failed"].includes(job.status)

function AgentUpgrades({ nodes, latest }: { nodes: Node[]; latest: string }) {
  const [jobs, setJobs] = useState<AgentUpgrade[]>([])
  const [error, setError] = useState("")
  const [typedTarget, setTarget] = useState<string | null>(null)
  const target = typedTarget ?? latest
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState(new Set<number>())
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const load = useCallback(() => {
    const request = ++revision.current
    return api<{ upgrades: AgentUpgrade[] }>("/agent-upgrades")
      .then((data) => { if (request === revision.current) { setJobs((previous) => visibleUpgradeResults(previous, data.upgrades)); setError("") } })
      .catch((e: Error) => { if (request === revision.current) setError(e.message) })
  }, [])
  useEffect(() => { load() }, [load])
  const running = jobs.some(upgradeRunning)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [running, load])

  const activeIds = new Set(jobs.filter(upgradeRunning).map((job) => job.node_id))
  const pending = outdatedAgents(nodes, target.trim())
  const bootstrap = pending.filter((node) => node.online && !node.can_upgrade)
  const offline = pending.filter((node) => !node.online)
  const eligible = pending.filter((node) => node.online && node.can_upgrade && !activeIds.has(node.id))
  const selected = eligible.filter((node) => chosen.has(node.id))
  const visibleJobs = jobs.filter((job) => nodes.some((node) => node.id === job.node_id))

  function refreshResults() {
    setJobs((previous) => previous.filter((job) => job.status !== "succeeded"))
    load()
  }

  async function start() {
    const ids = selected.map((node) => node.id)
    setBusy(true)
    ++revision.current
    try {
      const data = await api<{ started: number; upgrades: AgentUpgrade[] }>("/agent-upgrades", {
        method: "POST", body: JSON.stringify({ ids, version: target.trim() }),
      })
      ++revision.current
      setJobs((previous) => visibleUpgradeResults(previous, data.upgrades, ids))
      setError("")
      setOpen(false)
      if (data.started) toast.success(`已向 ${data.started} 台节点下发升级，请查看每台节点的结果`)
      else toast.error("没有节点接受升级，请查看结果中的原因")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="agent-upgrade-version">目标版本</Label>
          <Input id="agent-upgrade-version" className="w-40" placeholder="例如 1.3.0" value={target} disabled={busy || open} onChange={(event) => setTarget(event.target.value)} />
        </div>
        <Button disabled={!eligible.length || busy || !target.trim()} onClick={() => { setChosen(new Set(eligible.map((node) => node.id))); setOpen(true) }}>
          <ArrowUpCircle /> 选择节点升级
        </Button>
        <Button variant="ghost" size="sm" onClick={refreshResults}><RefreshCw /> 刷新结果</Button>
      </div>
      <div className="upgrade-availability" role="status">
        <strong>{eligible.length} 台可远程升级</strong>
        {bootstrap.length > 0 && <span>{bootstrap.length} 台需先用安装脚本更新</span>}
        {offline.length > 0 && <span>{offline.length} 台离线</span>}
        {!target.trim() ? <span>请填写目标版本</span> : !pending.length && <span>暂无待升级节点</span>}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        可选择单台或多台在线节点升级，沿用每台机器的 token、网卡和上报间隔。下载期间继续监控，切换版本时短暂重连；新版本连接主控后才显示成功。
        {!latest && " 暂时查不到最新版本，可填写已发布的版本号。"}
      </p>
      {error && <p className="text-sm text-destructive" role="alert">升级结果加载失败：{error}</p>}
      {visibleJobs.length > 0 && (
        <div className="responsive-table overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader><TableRow><TableHead>节点</TableHead><TableHead>目标版本</TableHead><TableHead>状态</TableHead><TableHead>说明</TableHead></TableRow></TableHeader>
            <TableBody>
              {visibleJobs.map((job) => (
                <TableRow key={job.node_id}>
                  <TableCell data-label="节点" className="font-medium">{nodes.find((node) => node.id === job.node_id)!.name}</TableCell>
                  <TableCell data-label="目标版本">v{job.version}</TableCell>
                  <TableCell data-label="状态"><Badge variant={job.status === "failed" ? "destructive" : "secondary"}>{UPGRADE_LABELS[job.status]}</Badge></TableCell>
                  <TableCell data-label="说明" className="max-w-80 whitespace-normal text-xs text-muted-foreground">{job.message || (job.status === "succeeded" ? "已收到目标版本的连接确认" : "—")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {open && (
        <Dialog open onOpenChange={(next) => { if (!next && !busy) setOpen(false) }}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>升级 agent 到 v{target.trim()}</DialogTitle>
              <DialogDescription>已选 {selected.length} 台节点。升级会短暂断开监控连接；下载或校验失败时保留原版本，切换后无法连接主控时恢复原版本。</DialogDescription>
            </DialogHeader>
            <NodePicker nodes={eligible} chosen={chosen} disabled={busy} onPick={(list, on) => setChosen((previous) => {
              const next = new Set(previous)
              for (const node of list) { if (on) next.add(node.id); else next.delete(node.id) }
              return next
            })} />
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
              <Button disabled={busy || !selected.length} onClick={start}>{busy ? "正在下发…" : `开始升级（${selected.length} 台）`}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
