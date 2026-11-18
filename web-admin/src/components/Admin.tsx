import { AdminLayout } from "@/components/AdminLayout"
import { behind, type Node, outdatedAgents } from "@/lib/api"
import { Data } from "@/pages/Data"
import { Nodes } from "@/pages/Nodes"
import { Notify } from "@/pages/Notify"
import { Ping } from "@/pages/Ping"
import { Security } from "@/pages/Security"
import { SettingsTab } from "@/pages/Settings"
import { Themes } from "@/pages/Themes"
import { Update, useVersions } from "@/pages/Update"

export function Admin({
  navigationOpen,
  onNavigationChange,
  path,
  go,
  nodes,
  refresh,
  site,
  refusal,
  reloadMe,
}: {
  navigationOpen: boolean
  onNavigationChange: (open: boolean) => void
  path: string
  go: (to: string) => void
  nodes: Node[]
  refresh: () => void
  site: string
  refusal: string
  reloadMe: () => void
}) {
  const { versions, reload } = useVersions()
  // One dot for both; the page separates them. Absent when switched off on that
  // page, or when the lookup failed and the page has nothing to say.
  const updates =
    !!versions?.notice
    && (behind(versions.hub, versions.hub_latest) || outdatedAgents(nodes, versions.agent_latest).length > 0)
  return (
    <AdminLayout path={path} go={go} updates={updates} navigationOpen={navigationOpen} onNavigationChange={onNavigationChange}>
      {path === "/admin/ping" ? (
        <Ping nodes={nodes} />
      ) : path === "/admin/notify" ? (
        <Notify nodes={nodes} refresh={refresh} />
      ) : path === "/admin/data" ? (
        <Data />
      ) : path === "/admin/themes" ? (
        <Themes />
      ) : path === "/admin/security" ? (
        <Security site={site} />
      ) : path === "/admin/settings" ? (
        <SettingsTab onSaved={reloadMe} />
      ) : path === "/admin/update" ? (
        <Update versions={versions} reload={reload} nodes={nodes} site={site} refusal={refusal} />
      ) : (
        <Nodes nodes={nodes} refresh={refresh} site={site} refusal={refusal} />
      )}
    </AdminLayout>
  )
}
