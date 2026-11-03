import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy, LoaderCircle, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { agentPlatform, api, type Node } from "@/lib/api"

type Removal = {
  node_id: number
  id: string
  node_name: string
  status: "queued" | "accepted" | "stopping" | "removing" | "succeeded" | "failed" | "unconfirmed"
  message: string
  started_at: number
  updated_at: number
  dismissed: boolean
}

const LABELS = {
  queued: "等待节点响应", accepted: "节点已接收", stopping: "正在停止服务", removing: "正在清理文件",
  succeeded: "彻底删除完成", failed: "删除失败，记录已保留", unconfirmed: "结果未确认，记录已保留",
}
const running = (job: Removal) => ["queued", "accepted", "stopping", "removing"].includes(job.status)

export function useRemovals() {
  const [jobs, setJobs] = useState<Removal[]>([])
  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [clearing, setClearing] = useState(false)
  const revision = useRef(0)
  const load = useCallback(() => {
    const request = ++revision.current
    return api<{ removals: Removal[] }>("/agent-removals")
      .then((data) => {
        if (request === revision.current) {
          setJobs(data.removals)
          setError("")
          setLoaded(true)
        }
      })
      .catch((e: Error) => { if (request === revision.current) setError(e.message) })
  }, [])
  const active = jobs.some(running)
  useEffect(() => {
    load()
    const timer = setInterval(load, active ? 1500 : 10000)
    return () => clearInterval(timer)
  }, [active, load])

  async function start(node: number) {
    ++revision.current
    const job = await api<Removal>(`/nodes/${node}/removal`, { method: "POST" })
    ++revision.current
    setJobs((current) => [job, ...current.filter((item) => item.node_id !== node)])
    setError("")
    return job
  }

  async function clearCompleted() {
    const ids = jobs.filter((job) => job.status === "succeeded" && !job.dismissed).map((job) => job.id)
    setClearing(true)
    ++revision.current
    try {
      const { cleared } = await api<{ cleared: number }>("/agent-removals", {
        method: "DELETE", body: JSON.stringify({ ids }),
      })
      ++revision.current
      // Keep the receipt available to an open result dialog, including when
      // another tab clears history before this tab observes the completion.
      setJobs((current) => current.map((job) => ids.includes(job.id) ? { ...job, dismissed: true } : job))
      return cleared
    } finally {
      setClearing(false)
    }
  }
  return { jobs, error, loaded, load, start, clearCompleted, clearing }
}

type Removals = ReturnType<typeof useRemovals>

function Progress({ job }: { job: Removal }) {
  const steps = ["下发卸载指令", "节点接收指令", "停止 agent 服务", "清理程序、配置与服务文件", "删除主控记录并完成"]
  const index = { queued: 0, accepted: 1, stopping: 2, removing: 3, succeeded: 5, failed: -1, unconfirmed: -1 }[job.status]
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <p className={`text-sm font-medium ${index < 0 ? "text-destructive" : ""}`}>{LABELS[job.status]}</p>
      {index >= 0 && <ol className="space-y-2 text-sm">
        {steps.map((step, i) => <li key={step} className={`flex items-start gap-2 ${i > index ? "text-muted-foreground" : ""}`}>
          {i < index ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            : i === index ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" />
              : <span className="mt-1 size-3 shrink-0 rounded-full border" />}
          <span>{step}</span>
        </li>)}
      </ol>}
      {job.message && <p className="break-words text-sm text-muted-foreground">{job.message}</p>}
    </div>
  )
}

export function RemovalHistory({ removals, nodes, onInspect }: {
  removals: Removals
  nodes: Node[]
  onInspect: (node: Node) => void
}) {
  const visible = removals.jobs.filter((job) => !job.dismissed)
  const pending = visible.filter((job) => job.status !== "succeeded")
  const completed = visible.filter((job) => job.status === "succeeded")
  if (!visible.length && !removals.error) return null

  async function clear() {
    try {
      const count = await removals.clearCompleted()
      toast.success(count ? `已清除 ${count} 条成功记录` : "成功记录已清除")
    } catch (e) { toast.error((e as Error).message) }
  }

  return <Card className="space-y-3 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">删除进度</h2>
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={removals.load}>刷新结果</Button>
        {completed.length > 0 && <Button variant="ghost" size="sm" onClick={clear} disabled={removals.clearing}>
          {removals.clearing && <LoaderCircle className="size-4 animate-spin" />}
          清除成功记录
        </Button>}
      </div>
    </div>
    {removals.error && <p role="alert" className="text-sm text-destructive">进度读取失败：{removals.error}</p>}
    <div className="divide-y">
      {pending.map((job) => {
        const node = nodes.find((item) => item.id === job.node_id)
        return <div key={job.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="break-all font-medium">{job.node_name}</span>
            <Badge variant={running(job) ? "secondary" : "destructive"}>
              {running(job) && <LoaderCircle className="mr-1 size-3 animate-spin" />}{LABELS[job.status]}
            </Badge>
          </div>
          {job.message && <p className="break-words text-xs text-muted-foreground">{job.message}</p>}
          {node && <Button variant="outline" size="sm" onClick={() => onInspect(node)}>
            {running(job) ? "查看进度" : "查看原因与处理"}
          </Button>}
        </div>
      })}
    </div>
    {completed.length > 0 && <details className="rounded-lg border px-3 py-2">
      <summary className="cursor-pointer text-sm text-muted-foreground">已完成（{completed.length}）</summary>
      <ul className="mt-3 space-y-2 text-sm">
        {completed.map((job) => <li key={job.id} className="flex items-start gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <span className="break-all">{job.node_name}</span>
        </li>)}
      </ul>
    </details>}
  </Card>
}

function Command({ title, command }: { title: string; command: string }) {
  if (!command) return null
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium">{title}</span>
      <Button variant="ghost" size="sm" onClick={async () => {
        try { await navigator.clipboard.writeText(command); toast.success("已复制") }
        catch { toast.error("复制失败，请手动选择命令") }
      }}><Copy className="size-4" />复制</Button>
    </div>
    <pre className="whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs">{command}</pre>
  </div>
}

export function NodeDeleteDialog({ node, removals, uninstall, bootstrap, onClose, onDeleted }: {
  node: Node
  removals: Removals
  uninstall: string
  bootstrap: string
  onClose: () => void
  onDeleted: () => void
}) {
  const [complete, setComplete] = useState(false)
  const [busy, setBusy] = useState(false)
  const job = removals.jobs.find((item) => item.node_id === node.id)
  const working = job !== undefined && running(job)
  const succeeded = job?.status === "succeeded"
  const unconfirmed = job?.status === "unconfirmed"
  const platform = agentPlatform(node.os)
  const reason = !node.online ? "节点已离线，无法下发卸载指令。" : node.can_uninstall ? ""
    : platform !== "linux" ? "此系统暂不支持远程卸载，可使用下方命令手动卸载。"
      : "此节点尚未启用远程卸载，需要新版 agent 和卸载辅助服务。"
  useEffect(() => {
    if (!succeeded) return
    toast.success(`已彻底删除「${node.name}」`, { id: `node-removal-${node.id}` })
    const timer = setTimeout(onClose, 2000)
    return () => clearTimeout(timer)
  }, [succeeded, node.id, node.name, onClose])

  async function remove() {
    setBusy(true)
    try {
      if (complete) {
        const result = await removals.start(node.id)
        if (result.status === "failed") toast.error(result.message)
      } else {
        await api(`/nodes/${node.id}`, { method: "DELETE" })
        toast.success("节点记录已删除")
        onDeleted()
        onClose()
      }
    } catch (e) { toast.error((e as Error).message) }
    finally { setBusy(false) }
  }

  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="sm:max-w-lg" onCloseAutoFocus={(event) => {
      // A successful deletion removes the original button from the node list.
      if (succeeded) {
        const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索节点"]')
        if (search) { event.preventDefault(); search.focus() }
      }
    }}>
      <DialogHeader>
        <DialogTitle className="break-words px-5 leading-snug">删除节点「{node.name}」</DialogTitle>
        <DialogDescription className="leading-relaxed">
          {working ? "正在执行彻底删除，关闭弹窗后仍会继续，可在节点页查看进度。"
            : succeeded ? "agent 已卸载，主控记录、历史数据和凭证已删除。2 秒后自动关闭。"
              : "请选择删除方式。主控记录、历史数据和凭证删除后不可恢复。"}
        </DialogDescription>
      </DialogHeader>
      {!working && !succeeded && <fieldset disabled={busy} className="space-y-2">
        <legend className="sr-only">删除方式</legend>
        <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${!complete ? "border-primary bg-primary/5" : ""}`}>
          <input type="radio" name="delete-mode" checked={!complete} onChange={() => setComplete(false)} className="mt-1 accent-primary" />
          <span className="space-y-1"><span className="block text-sm font-medium">仅删除主控记录</span>
            <span className="block text-xs leading-relaxed text-muted-foreground">保留节点上的 agent 程序和服务，原 token 将失效。</span></span>
        </label>
        <label className={`flex items-start gap-3 rounded-lg border p-3 ${reason || unconfirmed ? "opacity-60" : "cursor-pointer"} ${complete ? "border-destructive bg-destructive/5" : ""}`}>
          <input type="radio" name="delete-mode" checked={complete} disabled={Boolean(reason) || unconfirmed} onChange={() => setComplete(true)} className="mt-1 accent-destructive" />
          <span className="space-y-1"><span className="block text-sm font-medium">彻底删除</span>
            <span className="block text-xs leading-relaxed text-muted-foreground">远程停止并卸载此 agent，清理程序、配置和服务文件；确认完成后删除主控记录。</span>
            {reason && <span className="block text-xs leading-relaxed">{reason}</span>}
          </span>
        </label>
      </fieldset>}
      {job && <div className="rounded-lg border p-3"><Progress job={job} /></div>}
      {removals.error && <p role="alert" className="text-sm text-destructive">进度读取失败：{removals.error}</p>}
      {!working && !succeeded && (uninstall || bootstrap) && <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm">{platform === "linux" ? "手动卸载与启用远程卸载" : "手动卸载 agent"}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{platform === "windows" ? "在对应节点的管理员 PowerShell 中执行。" : "在对应节点以 root 执行。"}远程卸载目前支持 Linux/systemd；其他安装方式可手动卸载。</p>
          <Command title="手动卸载此 agent" command={uninstall} />
          {!node.can_uninstall && <Command title="更新并安装卸载辅助服务" command={bootstrap} />}
        </div>
      </details>}
      <DialogFooter className="border-t pt-4">
        <Button variant="ghost" onClick={onClose} disabled={busy}>{working ? "关闭，后台继续" : succeeded ? "完成" : "取消"}</Button>
        {!working && !succeeded && <Button variant="destructive" onClick={remove}
          disabled={busy || (complete && (!removals.loaded || Boolean(reason) || unconfirmed))}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          {busy ? "正在提交…" : complete ? "彻底删除" : "删除节点记录"}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
