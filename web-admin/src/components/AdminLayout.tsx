import type { ReactNode } from "react"
import { ArrowUpCircle, Bell, ChevronRight, Database, Palette, Radio, Server, Settings, Shield } from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const SECTIONS = [
  { path: "/admin/nodes", label: "节点", title: "节点管理", description: "掌握节点状态，管理你的每一台服务器。", icon: Server, group: "监控管理" },
  { path: "/admin/ping", label: "延迟", title: "延迟监控", description: "配置探测目标，持续了解节点的网络连接。", icon: Radio, group: "监控管理" },
  { path: "/admin/notify", label: "通知", title: "通知与提醒", description: "设置通知渠道，及时收到节点与用量提醒。", icon: Bell, group: "监控管理" },
  { path: "/admin/data", label: "数据", title: "数据管理", description: "查看存储情况，管理历史数据与备份。", icon: Database, group: "系统设置" },
  { path: "/admin/themes", label: "主题", title: "主题管理", description: "为公开状态页选择合适的外观。", icon: Palette, group: "系统设置" },
  { path: "/admin/security", label: "安全", title: "安全设置", description: "管理登录方式与当前会话。", icon: Shield, group: "系统设置" },
  { path: "/admin/settings", label: "设置", title: "站点设置", description: "调整站点信息与运行设置。", icon: Settings, group: "系统设置" },
  { path: "/admin/update", label: "更新", title: "版本更新", description: "检查主控版本，管理节点升级进度。", icon: ArrowUpCircle, group: "系统设置" },
]

export function AdminLayout({ path, go, updates, navigationOpen, onNavigationChange, children }: {
  path: string
  go: (path: string) => void
  updates: boolean
  navigationOpen: boolean
  onNavigationChange: (open: boolean) => void
  children: ReactNode
}) {
  const current = SECTIONS.find((section) => section.path === path) ?? SECTIONS[0]
  const navigation = (mobile: boolean) => (
    <nav aria-label={mobile ? "手机后台导航" : "后台导航"} className="admin-navigation">
      {["监控管理", "系统设置"].map((group) => (
        <div key={group} className="admin-nav-group">
          <p className="admin-nav-label">{group}</p>
          {SECTIONS.filter((section) => section.group === group).map(({ path: to, label, icon: Icon }) => (
            <button key={to} type="button" aria-current={path === to ? "page" : undefined}
              onClick={() => { go(to); onNavigationChange(false) }} className="admin-nav-item">
              <Icon aria-hidden="true" className="size-[18px]" />
              <span className="whitespace-nowrap">{label}</span>
              {to === "/admin/update" && updates && <span className="update-indicator" aria-label="有新版本" />}
              {path === to && <ChevronRight aria-hidden="true" className="admin-nav-chevron ml-auto size-4 opacity-60" />}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-heading"><Server className="size-4" /> 管理控制台</div>
        {navigation(false)}
        <p className="admin-sidebar-note">Monitor<span>轻量监控 · 实时掌握</span></p>
      </aside>
      <div className="admin-content">
        <div className="admin-page-heading">
          <div className="min-w-0">
            <p className="admin-eyebrow">管理控制台 / {current.label}</p>
            <h1>{current.title}</h1>
            <p className="admin-page-description">{current.description}</p>
          </div>
        </div>
        {children}
      </div>
      <Dialog open={navigationOpen} onOpenChange={onNavigationChange}>
        <DialogContent id="admin-navigation-dialog" className="admin-mobile-menu" onCloseAutoFocus={(event) => {
          event.preventDefault()
          document.getElementById("admin-navigation-trigger")?.focus()
        }}>
          <DialogHeader>
            <DialogTitle>管理控制台</DialogTitle>
            <DialogDescription>选择要管理的功能</DialogDescription>
          </DialogHeader>
          {navigation(true)}
        </DialogContent>
      </Dialog>
    </div>
  )
}
