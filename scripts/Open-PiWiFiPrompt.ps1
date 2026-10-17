# Opens the bounded interactive Wi-Fi helper through authenticated SSH.
# Requires the Pi helper's wifi-connect-ask action. No password argument.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({
        $parsedPiAddress = $null
        if ([System.Net.IPAddress]::TryParse($_, [ref]$parsedPiAddress)) { return $true }
        if ($_ -match '^[A-Za-z0-9][A-Za-z0-9.-]*$') { return $true }
        throw 'Use a hostname or IP address, including a numeric scope for link-local IPv6.'
    })]
    [string]$PiAddress,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z_][a-z0-9_-]*$')]
    [string]$PiUser,
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$IdentityFile,
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$KnownHostsFile,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,31}$')]
    [string]$DroneSsid = 'ANAFI-H084882'
)

$ErrorActionPreference = 'Stop'
$sshClient = Get-Command ssh.exe -ErrorAction Stop
$sshArguments = @(
    '-tt', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-i', (Resolve-Path -LiteralPath $IdentityFile).Path,
    '-o', ('UserKnownHostsFile=' + (Resolve-Path -LiteralPath $KnownHostsFile).Path),
    '-l', $PiUser, $PiAddress,
    ('sudo -n /usr/local/sbin/emberwatch-maintenance wifi-connect-ask "{0}"' -f $DroneSsid)
)

if ($PSCmdlet.ShouldProcess("$PiUser@$PiAddress", "Connect wlan0 to $DroneSsid with an interactive Wi-Fi password prompt")) {
    Write-Host "Connecting the Pi Wi-Fi to $DroneSsid. Keep the Ethernet cable attached."
    Write-Host 'Enter only the drone Wi-Fi password when the Pi asks for it here.'
    Write-Host 'At Password (...): click inside this window, type the Wi-Fi password, then press Enter.'
    Write-Host 'Characters may stay hidden while typing. The connection attempt allows two minutes.'
    Write-Host 'Do not put the password in chat, a script, or a command argument.'
    Write-Host 'The command ends when the connection succeeds or fails.'
    & $sshClient.Source @sshArguments
}
