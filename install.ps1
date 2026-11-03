# Run in an elevated PowerShell. Downloads are verified by the hub's signed relay.
[CmdletBinding()]
param(
    [string]$Server, [string]$Token, [string]$Register, [string]$Name,
    [Nullable[int]]$Interval, [AllowEmptyString()][string]$Iface,
    [string]$Binary, [switch]$Upgrade, [switch]$Uninstall, [switch]$Insecure
)
$ErrorActionPreference = 'Stop'
$serviceName = 'monitor-agent'
$rootDir = Join-Path $env:ProgramData 'monitor'
$agentDir = Join-Path $rootDir 'agent'
$agentExe = Join-Path $agentDir 'monitor-agent.exe'
$configFile = Join-Path $rootDir 'agent.json'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw 'Run this script in an Administrator PowerShell.'
}
if ($Uninstall) {
    if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
        Stop-Service $serviceName
        (Get-Service $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        & sc.exe delete $serviceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the agent service.' }
    }
    # Remove only files this installer and updater own; the parent can hold a hub.
    foreach ($file in @('monitor-agent.exe', 'monitor-agent.old.exe', 'monitor-agent.download.exe', 'monitor-agent.previous.exe', 'monitor-agent.failed.exe', 'monitor-agent.upgrade.json', 'monitor-agent.upgrade.tmp')) {
        Remove-Item -LiteralPath (Join-Path $agentDir $file) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $agentDir) -and -not (Get-ChildItem -LiteralPath $agentDir -Force)) { Remove-Item -LiteralPath $agentDir }
    Write-Output 'monitor-agent uninstalled'
    return
}
$held = @{}
if (Test-Path -LiteralPath $configFile) {
    $saved = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $held[$property.Name] = [string]$property.Value }
}
if ($Upgrade) {
    if ($Token -or $Register) { throw '-Upgrade reuses the installed credentials; omit -Token and -Register.' }
    $Token = $held['MONITOR_TOKEN']
    if (-not $Server) { $Server = $held['MONITOR_SERVER'] }
    if (-not $Token -or -not $Server) { throw 'No installed agent configuration; use the install command from the panel.' }
}
if (-not $Server -or (-not $Token -and -not $Register)) { throw 'Supply -Server and either -Token or -Register.' }
if ($Token -and $Register) { throw 'Supply only one of -Token and -Register.' }
if ($Name -and $Token) { throw '-Name applies only with -Register.' }
if (-not $PSBoundParameters.ContainsKey('Interval')) { $Interval = if ($held['MONITOR_INTERVAL']) { [int]$held['MONITOR_INTERVAL'] } else { 1 } }
if ($Interval -lt 1 -or $Interval -gt 3600) { throw 'Interval must be from 1 to 3600 seconds.' }
if (-not $PSBoundParameters.ContainsKey('Iface')) { $Iface = $held['MONITOR_IFACE'] }
foreach ($entry in ($Iface -split ',')) {
    if ($entry.Trim() -and $entry.Trim() -notmatch '^-?[^\x00-\x1f\x7f,-][^\x00-\x1f\x7f,]*$') { throw "Invalid interface name: $entry" }
}
if ($Upgrade -and $held['MONITOR_INSECURE'] -eq '1') { $Insecure = $true }
if ($Server -notmatch '^[a-zA-Z]+://') { $Server = 'https://' + $Server }
$uri = [Uri]$Server
if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'Use an HTTP(S) hub URL without credentials, query or fragment.' }
if ($uri.Scheme -ne 'https' -and -not $uri.IsLoopback -and -not $Insecure) { throw 'Use HTTPS, or explicitly pass -Insecure for a hub without TLS.' }
$Server = $uri.AbsoluteUri.TrimEnd('/')
$machineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($machineArch) { 'AMD64' { 'x86_64' } 'ARM64' { 'aarch64' } default { throw "Unsupported architecture: $machineArch" } }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Set-AgentAcl([string]$Path, [bool]$Writable) {
    $directory = (Get-Item -LiteralPath $Path).PSIsContainer
    $acl = if ($directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')) {
        $rights = if ($sid -eq 'S-1-5-19' -and -not $Writable) { 'ReadAndExecute' } else { 'FullControl' }
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

New-Item -ItemType Directory -Path $rootDir -Force | Out-Null
Set-AgentAcl $rootDir $false
$staged = Join-Path $rootDir ('agent-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    if ($Binary) { Copy-Item -LiteralPath $Binary -Destination $staged }
    else { Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/${arch}?os=windows" -OutFile $staged -TimeoutSec 300 }
    $bytes = [IO.File]::ReadAllBytes($staged)
    if ($bytes.Length -lt 64 -or $bytes.Length -gt 16MB -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) { throw 'Download is not a Windows agent executable.' }
    $offset = [BitConverter]::ToUInt32($bytes, 60)
    $machine = if ($arch -eq 'aarch64') { 0xaa64 } else { 0x8664 }
    if ([long]$offset + 26 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $offset) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes, $offset + 4) -ne $machine -or [BitConverter]::ToUInt16($bytes, $offset + 24) -ne 0x20b) { throw 'Download does not match this Windows architecture.' }
    $version = & $staged --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^monitor-agent [0-9]') { throw 'Agent version check failed.' }
    if (-not $Token) {
        $headers = @{ Authorization = "Bearer $Register" }
        if ($held['MONITOR_SERVER'] -eq $Server -and $held['MONITOR_TOKEN']) { $headers['X-Node-Token'] = $held['MONITOR_TOKEN'] }
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/agent/register" -Method Post -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($Name)) -TimeoutSec 30
        $Token = $response.Content.Trim()
        if (-not $Token) { throw 'The hub returned no token.' }
    }
    $config = @{
        MONITOR_SERVER = $Server; MONITOR_TOKEN = $Token; MONITOR_IFACE = [string]$Iface
        MONITOR_INTERVAL = [string]$Interval; MONITOR_ALLOW_UPGRADE = '1'
        MONITOR_INSECURE = $(if ($Insecure) { '1' } else { '0' })
    }
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    Set-AgentAcl $agentDir $true
    $existing = Get-Service $serviceName -ErrorAction SilentlyContinue
    if ($existing) { Stop-Service $serviceName; $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    $backup = Join-Path $agentDir 'monitor-agent.old.exe'
    if (Test-Path -LiteralPath $agentExe) { Copy-Item -LiteralPath $agentExe -Destination $backup -Force }
    $oldConfig = if (Test-Path -LiteralPath $configFile) { [IO.File]::ReadAllBytes($configFile) } else { $null }
    try {
        Move-Item -LiteralPath $staged -Destination $agentExe -Force
        [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Set-AgentAcl $configFile $false
        foreach ($file in @('monitor-agent.upgrade.json', 'monitor-agent.upgrade.tmp', 'monitor-agent.previous.exe', 'monitor-agent.failed.exe', 'monitor-agent.download.exe')) {
            Remove-Item -LiteralPath (Join-Path $agentDir $file) -Force -ErrorAction SilentlyContinue
        }
        if (-not $existing) { New-Service -Name $serviceName -BinaryPathName ('"' + $agentExe + '" --service') -DisplayName 'Monitor Agent' -StartupType Automatic | Out-Null }
        & sc.exe config $serviceName obj= 'NT AUTHORITY\LocalService' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not configure the service account.' }
        & sc.exe failure $serviceName reset= 86400 actions= 'restart/5000/restart/5000/restart/5000' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not configure service recovery.' }
        Start-Service $serviceName
        (Get-Service $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
        Start-Sleep -Seconds 3
        if ((Get-Service $serviceName).Status -ne 'Running') { throw 'Agent exited after starting.' }
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } catch {
        Stop-Service $serviceName -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $backup) {
            Move-Item -LiteralPath $backup -Destination $agentExe -Force
            if ($oldConfig) { [IO.File]::WriteAllBytes($configFile, $oldConfig) }
            Start-Service $serviceName
        }
        throw
    }
    Write-Output "monitor-agent installed ($arch); service: $serviceName"
} finally {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
}
