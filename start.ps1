param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = [System.IO.Path]::GetFullPath($Root)
if (-not $Root.EndsWith('\')) { $Root += '\' }

function Start-LocalListener {
    param([int]$Port)
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
    try {
        $listener.Start()
        return $listener
    } catch {
        try { $listener.Stop() } catch { }
        return $null
    }
}

function Get-MimeType {
    param([string]$Path)
    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' }
        '.js' { 'text/javascript; charset=utf-8' }
        '.json' { 'application/json; charset=utf-8' }
        '.svg' { 'image/svg+xml' }
        '.png' { 'image/png' }
        '.jpg' { 'image/jpeg' }
        '.jpeg' { 'image/jpeg' }
        '.ico' { 'image/x-icon' }
        '.txt' { 'text/plain; charset=utf-8' }
        '.map' { 'application/json; charset=utf-8' }
        '.woff' { 'font/woff' }
        '.woff2' { 'font/woff2' }
        default { 'application/octet-stream' }
    }
}

function Test-BlockedRelative {
    param([string]$Relative)
    foreach ($part in ($Relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($part)) { continue }
        if ($part -eq '.' -or $part -eq '..' -or $part.StartsWith('.') -or $part -eq 'node_modules') { return $true }
    }
    return $false
}

function Send-Response {
    param(
        $Stream,
        [int]$Code,
        [string]$Reason,
        [string]$ContentType,
        [byte[]]$Body,
        [bool]$WriteBody
    )
    if ($null -eq $Body) { $Body = [byte[]]@() }
    $header = "HTTP/1.1 $Code $Reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($WriteBody -and $Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

$server = Start-LocalListener -Port 8080
$port = 8080
if (-not $server) {
    $server = Start-LocalListener -Port 8081
    $port = 8081
}
if (-not $server) {
    Write-Host 'Ports 8080 and 8081 are both in use.'
    exit 1
}

$utf8 = [System.Text.Encoding]::UTF8
Write-Host (-join (@(0x6703, 0x8B70, 0x8A18, 0x9304, 0x5DF2, 0x958B, 0x555F) | ForEach-Object { [char]$_ }))
Write-Host "http://127.0.0.1:$port/"
Write-Host 'Press Ctrl+C to stop.'
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port/" }

try {
    while ($true) {
        $client = $server.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 8000
            $client.SendTimeout = 20000
            $stream = $client.GetStream()
            $buffer = New-Object byte[] 8192
            $received = New-Object System.IO.MemoryStream
            $headerEnd = -1
            while ($headerEnd -lt 0 -and $received.Length -lt 65536) {
                $read = $stream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $received.Write($buffer, 0, $read)
                $ascii = [System.Text.Encoding]::ASCII.GetString($received.ToArray())
                $headerEnd = $ascii.IndexOf("`r`n`r`n")
            }
            $raw = [System.Text.Encoding]::ASCII.GetString($received.ToArray())
            $requestLine = ($raw -split "`r`n", 2)[0]
            $match = [regex]::Match($requestLine, '^(GET|HEAD)\s+(\S+)\s+HTTP/1\.[01]$')
            if (-not $match.Success) {
                Send-Response $stream 405 'Method Not Allowed' 'text/plain; charset=utf-8' $utf8.GetBytes('Method not allowed') $true
                continue
            }
            $method = $match.Groups[1].Value
            $target = $match.Groups[2].Value
            $query = $target.IndexOf('?')
            if ($query -ge 0) { $target = $target.Substring(0, $query) }
            if (-not $target.StartsWith('/')) {
                Send-Response $stream 400 'Bad Request' 'text/plain; charset=utf-8' $utf8.GetBytes('Bad request') ($method -eq 'GET')
                continue
            }
            $decoded = [System.Uri]::UnescapeDataString($target)
            if ($decoded -eq '/') { $decoded = '/index.html' }
            $relative = $decoded.TrimStart('/').Replace('/', '\')
            if ($relative -eq 'favicon.ico') { $relative = 'favicon.svg' }
            $full = [System.IO.Path]::GetFullPath((Join-Path $Root $relative))
            $blocked = (Test-BlockedRelative $relative) -or $decoded.Contains(':') -or -not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)
            if ($blocked -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
                Write-Host "$method $decoded -> 404"
                Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' $utf8.GetBytes('Not found') ($method -eq 'GET')
                continue
            }
            $bytes = [System.IO.File]::ReadAllBytes($full)
            Write-Host "$method $decoded -> 200"
            Send-Response $stream 200 'OK' (Get-MimeType $full) $bytes ($method -eq 'GET')
        } catch {
            Write-Host 'Request failed.'
        } finally {
            if ($client) { $client.Close() }
        }
    }
} finally {
    $server.Stop()
}
