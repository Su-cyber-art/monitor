/// <reference types="node" />
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { agentCommand, agentPlatform, badIfaceName, behind, changes, configFields, configForm, configOverrides, configSections, configValues, currentIface, fits, GIB, groupsOf, ifaceChoice, ifaceSpec, inGroup, loopbackOrigin, outdatedAgents, provisioningSite, provisionRefusal, shortAddress, trafficCorrection, visibleUpgradeResults, type AgentUpgrade } from "./api.ts"

assert.deepEqual(changes({ public: true, price: 5 }, { price: 20 }), { price: 20 })
assert.deepEqual(changes({ total_rx: "100", month_tx: "2" }, { total_rx: "100", month_tx: "3" }), { month_tx: "3" })
assert.deepEqual(changes({ expires_at: "2030-01-01" as string | null }, { expires_at: null }), { expires_at: null })
assert.equal(provisioningSite("https://monitor.example.com:8443/"), "https://monitor.example.com:8443")
for (const site of ["http://monitor.example.com", "https://127.0.0.1", "https://[::1]", "https://2130706433", "https://0x7f000001", "https://localhost", "https://user@monitor.example.com", "https://monitor.example.com/path"]) {
  assert.equal(provisioningSite(site), "", site)
}
// A tunnelled panel: the hub allows it alongside --site, so the panel must read
// the same addresses as loopback, and a name merely beginning with one as not.
for (const origin of ["http://127.0.0.1:9911", "http://localhost:9911", "http://[::1]:9911", "https://127.0.0.1"]) {
  assert.equal(loopbackOrigin(origin), true, origin)
}
for (const origin of ["https://monitor.example.com", "http://127.0.0.1.example.com", "ftp://127.0.0.1", "nonsense"]) {
  assert.equal(loopbackOrigin(origin), false, origin)
}
// The refusal names the cause the operator can act on, as the hub decides it.
// A loopback --site is a bad --site, not a missing one.
for (const [origin, site, cause] of [
  ["https://monitor.example.com", "", ""],
  ["https://monitor.example.com", "https://hub.example.com", ""],
  ["http://127.0.0.1:9911", "https://hub.example.com", ""],
  ["http://127.0.0.1:9911", "", "加 --site"],
  ["http://127.0.0.1:9911", "http://127.0.0.1:28080", "不是 https 域名"],
  ["https://monitor.example.com", "https://198.51.100.1", "不是 https 域名"],
  ["http://198.51.100.1:28080", "https://hub.example.com", "请通过 HTTPS 域名"],
]) {
  const refusal = provisionRefusal(origin, site)
  assert.ok(cause ? refusal.includes(cause) : refusal === "", `${origin} ${site}: ${refusal}`)
}
// A node that never reported carries no version, an unreachable GitHub leaves no
// published one, and a locally built agent ahead of the release is not one to
// upgrade: none of the three is an upgrade to offer.
const fleet = [{ agent_version: "1.1.0" }, { agent_version: "1.0.9" }, { agent_version: "" }, { agent_version: "1.1.1" }]
assert.deepEqual(outdatedAgents(fleet, "1.1.0"), [{ agent_version: "1.0.9" }])
assert.deepEqual(outdatedAgents(fleet, ""), [])
assert.deepEqual(outdatedAgents([{ agent_version: "1.2" }], "1.2.0"), [])
assert.deepEqual(outdatedAgents([{ agent_version: "1.2.0-dev" }], "1.2.0"), [{ agent_version: "1.2.0-dev" }])
// The hub's own version goes through the same comparison.
assert.equal(behind("1.2.0", "1.10.0"), true)
assert.equal(behind("1.3.0", "1.2.0"), false)
assert.equal(behind("1.2.0", ""), false)

const upgradeJob = (id: string, node_id: number, status: AgentUpgrade["status"]): AgentUpgrade => ({
  id, node_id, status, version: "1.4.0", message: "", started_at: 1, updated_at: 2,
})
const pastSuccess = upgradeJob("past", 1, "succeeded")
const waiting = upgradeJob("waiting", 2, "queued")
const downloading = upgradeJob("download", 3, "downloading")
const restarting = upgradeJob("restart", 4, "restarting")
const failure = upgradeJob("failed", 5, "failed")
const fetched = [pastSuccess, waiting, downloading, restarting, failure]
assert.deepEqual(visibleUpgradeResults([], fetched), [waiting, downloading, restarting, failure], "refresh retains unfinished and failed tasks, not past successes")
const liveSuccess = { ...waiting, status: "succeeded" as const }
const observed = visibleUpgradeResults([waiting, failure], [pastSuccess, liveSuccess, failure])
assert.deepEqual(observed, [liveSuccess, failure], "a completion observed on this page must be shown")
assert.deepEqual(visibleUpgradeResults(observed, [pastSuccess, liveSuccess, failure]), observed, "automatic polling keeps the current result visible")
assert.deepEqual(visibleUpgradeResults(observed.filter((job) => job.status !== "succeeded"), [pastSuccess, liveSuccess, failure]), [failure], "manual refresh clears successful results without losing failures")
assert.deepEqual(visibleUpgradeResults([], [pastSuccess, liveSuccess], [2]), [liveSuccess], "a newly requested task can finish before the start response arrives")
assert.deepEqual(visibleUpgradeResults([liveSuccess], [upgradeJob("another-attempt", 2, "succeeded")]), [], "a new request cannot inherit an old request's visibility just by sharing a node")

// An emptied traffic field means the counter is not to be corrected. Sent as 0
// it would clear a lifetime total, which must never decrease.
const shown = { total_rx: "1.5", total_tx: "2", month_rx: "0.25", month_tx: "1" }
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "" }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "   " }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "0" }), { total_rx: 0 })
assert.deepEqual(trafficCorrection(shown, { ...shown, total_tx: "3" }), { total_tx: 3 * GIB })
assert.deepEqual(trafficCorrection(shown, shown), {})
// A long IPv6 keeps two groups each side; short ones and IPv4 are left whole,
// and a :: in what is kept survives.
assert.equal(shortAddress("2605:52c0:1:ca9:be24:11ff:fe84:2c48"), "2605:52c0…fe84:2c48")
assert.equal(shortAddress("2604:a880:800:10::7a1:e001"), "2604:a880…7a1:e001")
assert.equal(shortAddress("2a0e:1d80:ffff:ffff::1234"), "2a0e:1d80…ffff::1234")
assert.equal(shortAddress("2001:db8:1054:84::a4"), "2001:db8:1054:84::a4")
assert.equal(shortAddress("203.0.113.84"), "203.0.113.84")
console.log("partial edits, traffic corrections, provisioning and upgrade result checks passed")

// --iface from the two lists the install dialogs show, and back.
assert.equal(ifaceSpec({ only: " eth1, pppoe-wan ", skip: "" }), "eth1,pppoe-wan")
assert.equal(ifaceSpec({ only: "", skip: "vxlan100, nebula1" }), "-vxlan100,-nebula1")
assert.equal(ifaceSpec({ only: "enp1s0", skip: "enp5s0" }), "enp1s0,-enp5s0")
assert.equal(ifaceSpec({ only: "", skip: "" }), "", "both empty restores the default rules")
// Each of these the agent would refuse, or would match nothing without a word.
for (const bad of ["eth0 eth1", "eth*", "-eth0", "eth0;reboot", "eth0'"]) {
  assert.equal(ifaceSpec({ only: bad, skip: "" }), null, bad)
  assert.equal(ifaceSpec({ only: "", skip: bad }), null, bad)
}
// The dialog names the offender and marks the field it sits in.
assert.deepEqual(badIfaceName({ only: "eth0", skip: "vxlan100, eth*" }), { list: "skip", name: "eth*" })
assert.equal(badIfaceName({ only: "eth0", skip: "vxlan100" }), undefined)
assert.deepEqual(ifaceChoice("eth1,-vxlan100,pppoe-wan"), { only: "eth1,pppoe-wan", skip: "vxlan100" })
assert.equal(ifaceSpec(ifaceChoice("enp1s0,-enp5s0")), "enp1s0,-enp5s0")
// A node not reporting tells nothing; an agent predating --iface runs the default rules.
assert.equal(currentIface({ metrics: null }), undefined)
assert.equal(currentIface({ metrics: {} as never }), "")
assert.equal(currentIface({ metrics: { iface: "eth1,-eth0" } as never }), "eth1,-eth0")

// Groups follow the node order, and the filter keeps ungrouped nodes apart from
// a group whose name merely resembles a sentinel.
const fleet2 = [{ group: "东京" }, { group: "" }, { group: "none" }, { group: "东京" }, {}]
assert.deepEqual(groupsOf(fleet2), ["东京", "none"])
assert.equal(inGroup(fleet2, "all").length, 5)
assert.equal(inGroup(fleet2, "none").length, 2)
assert.deepEqual(inGroup(fleet2, "=none"), [{ group: "none" }])
assert.equal(inGroup(fleet2, "=东京").length, 2)

// A theme's form: malformed fields drop out one by one, a saved value the field
// can no longer hold shows the default, and only changes from a default are stored.
const entries = [
  { type: "title", label: "外观" },
  { key: "notice", type: "text", default: "" },
  { key: "layout", type: "select", default: "grid", options: [{ value: "grid" }, { value: "table" }] },
  { key: "refresh", type: "number", default: 5, min: 1, max: 60 },
  { key: "dark", type: "boolean", default: false },
  { key: "notice", type: "string", default: "duplicate" },
  { key: "odd", type: "color", default: "#000" },
  { key: "bare", type: "select", default: "a" },
  { key: "blank", type: "select", default: "", options: [{ value: "" }, { value: "a" }] },
  { key: "wrong", type: "boolean", default: "yes" },
  { key: "range", type: "number", default: 0, min: 1 },
  { key: "i18n", type: "string", default: "", label: { zh: "公告", en: "Notice" } },
  { key: "hinted", type: "boolean", default: true, help: 1 },
  { key: "labelled", type: "select", default: "a", options: [{ value: "a", label: { zh: "甲" } }] },
  "not a field",
  { type: "title" },
  { type: "title", label: "空" },
  { type: "title", label: "末尾" },
]
assert.deepEqual(configForm(entries).map((f) => (f.type === "title" ? `# ${f.label}` : f.key)), ["# 外观", "notice", "layout", "refresh", "dark"])
const form = configFields(entries)
assert.deepEqual(form.map((f) => f.key), ["notice", "layout", "refresh", "dark"])
assert.deepEqual(configFields({ notice: "x" }), [])
const saved = { layout: "cards", refresh: 10, legacy: 1 }
const initial = configValues(form, saved)
assert.deepEqual(initial, { notice: "", layout: "grid", refresh: 10, dark: false })
assert.equal(fits(form[2], 61), false)
assert.deepEqual(configOverrides(form, saved, { ...initial, refresh: 5, dark: true }), { legacy: 1, dark: true })
// 恢复默认 builds on nothing, so undeclared keys go with the overrides.
assert.deepEqual(configOverrides(form, {}, Object.fromEntries(form.map((f) => [f.key, f.default]))), {})
// Headings split the form; leading fields get a section, empty headings none.
assert.deepEqual(
  configSections(configForm([{ key: "a", type: "string", default: "" }, { type: "title", label: "空" }, { type: "title", label: "外观" }, { key: "b", type: "boolean", default: true }]))
    .map((s) => [s.label, s.fields.map((f) => f.key)]),
  [["通用", ["a"]], ["外观", ["b"]]],
)


// Platform selection and shell quoting keep adapter names literal.
assert.equal(agentPlatform("Microsoft Windows 11"), "windows")
assert.equal(agentPlatform("macOS 15.0"), "macos")
assert.equal(agentPlatform("Ubuntu 24.04"), "linux")
assert.equal(ifaceSpec({ only: "Ethernet 2,vEthernet (WSL)", skip: "Wi-Fi" }, "windows"), "Ethernet 2,vEthernet (WSL),-Wi-Fi")
assert.equal(ifaceSpec({ only: "Ethernet 2", skip: "" }), null)
const winCommand = agentCommand("https://monitor.example.com", "windows", ["--server", "https://monitor.example.com", "--token", "abc", "--iface", "Ethernet 2,O'Reilly $(test)"])
assert.ok(winCommand.includes("/install.ps1"))
assert.ok(winCommand.includes("-Iface 'Ethernet 2,O''Reilly $(test)'"))
assert.ok(agentCommand("https://monitor.example.com", "windows", ["--iface", ""]).endsWith("-Iface ''"))
assert.ok(agentCommand("https://monitor.example.com", "macos", ["--upgrade"]).includes("/install-macos.sh"))
assert.equal(agentCommand("http://monitor.example.com", "windows", ["--upgrade"]), "")

if (process.platform === "win32") {
  // Execute the generated command against an inert installer, so PowerShell's
  // own parser checks quoting, switches, spaces and clearing a saved value.
  const mock = `function Invoke-WebRequest {
    param($Uri, [switch]$UseBasicParsing)
    [pscustomobject]@{ Content = @'
param([string]$Server, [string]$Token, [AllowEmptyString()][string]$Iface, [switch]$Upgrade)
$PSBoundParameters | ConvertTo-Json -Compress
'@ }
  }\n`
  for (const iface of ["", "Ethernet 2,O'Reilly $(throw 'must not run')"]) {
    const command = agentCommand("https://monitor.example.com", "windows", ["--server", "https://monitor.example.com", "--token", "literal-token", "--iface", iface])
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", mock + command], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    const received = JSON.parse(result.stdout)
    assert.equal(received.Iface, iface)
    assert.equal(received.Token, "literal-token")
  }
}
