import { agentCommand, type AgentPlatform, provisioningSite } from "./api.ts"

// Built here rather than fetched: the install dialog reads the token on its own,
// so viewing an install command is a read rather than an action. Reissuing one to
// display it would take the running agent offline.
export function installCommand(site: string, token: string, seconds: number | undefined, iface: string | undefined, platform: AgentPlatform) {
  return agentCommand(site, platform, ["--server", provisioningSite(site), "--token", token, ...intervalArg(seconds), ...ifaceArg(iface)])
}

// Left out untouched, as an untouched --iface is: a rerun then keeps what the
// machine already has.
function intervalArg(seconds: number | undefined) {
  return seconds === undefined ? [] : ["--interval", String(seconds)]
}

// An explicit empty argument clears a saved value. agentCommand quotes it for
// the selected shell, including Windows adapter names with spaces.
function ifaceArg(iface: string | undefined) {
  return iface === undefined ? [] : ["--iface", iface]
}

// One command for a batch of machines. The key belongs to the hub, is valid only
// within the window it opened, and each machine exchanges it for a token of its
// own, so unlike an install command this text is no one's credential and can be
// sent to every machine as it is.
export function registerCommand(site: string, key: string, seconds: number | undefined, iface: string | undefined, platform: AgentPlatform) {
  return agentCommand(site, platform, ["--server", provisioningSite(site), "--register", key, ...intervalArg(seconds), ...ifaceArg(iface)])
}
