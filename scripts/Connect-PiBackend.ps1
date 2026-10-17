# Opens an encrypted path from the Pi's loopback port to the laptop backend.
# Run on the Windows laptop. Does not install software or change network settings.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({
        $parsedPiAddress = $null
        if ([System.Net.IPAddress]::TryParse($_, [ref]$parsedPiAddress)) { return $true }
        if ($_ -match '^[A-Za-z0-9][A-Za-z0-9.-]*$') { return $true }
        throw 'Use a hostname or IP address. IPv6 addresses may include a numeric interface scope, such as fe80::1234%38.'
    })]
    [string]$PiAddress,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z_][a-z0-9_-]*$')]
    [string]$PiUser,

    [ValidateRange(1024, 65535)]
    [int]$BackendPort = 8787,

    [ValidateRange(1024, 65535)]
    [int]$PiPort = 8787,

    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$IdentityFile,

    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$KnownHostsFile
)

$ErrorActionPreference = 'Stop'
$sshClient = Get-Command ssh.exe -ErrorAction Stop
$destination = '{0}@{1}' -f $PiUser, $PiAddress
$forward = '127.0.0.1:{0}:127.0.0.1:{1}' -f $PiPort, $BackendPort
$sshArguments = @(
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=ask',
    '-R', $forward
)
if ($IdentityFile) {
    $sshArguments += @('-i', (Resolve-Path -LiteralPath $IdentityFile).Path, '-o', 'IdentitiesOnly=yes')
}
if ($KnownHostsFile) {
    $sshArguments += @('-o', ('UserKnownHostsFile=' + (Resolve-Path -LiteralPath $KnownHostsFile).Path))
}
$sshArguments += @('-l', $PiUser, $PiAddress)

if ($PSCmdlet.ShouldProcess($destination, "Forward Pi loopback port $PiPort to laptop loopback port $BackendPort")) {
    Write-Host "Keep this window open. Stop the tunnel with Ctrl+C."
    Write-Host "On the Pi, use backend URL http://127.0.0.1:$PiPort ."
    Write-Host "Verify the Pi's SSH host fingerprint before accepting a first connection."
    & $sshClient.Source @sshArguments
    if ($LASTEXITCODE -ne 0) {
        throw "SSH tunnel ended with exit code $LASTEXITCODE. Check the Pi address, SSH access and port availability."
    }
}
