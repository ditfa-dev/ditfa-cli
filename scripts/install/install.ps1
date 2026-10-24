# Ditfa CLI installer for Windows.
#
#   irm https://github.com/ditfa-dev/ditfa-cli/releases/latest/download/install.ps1 | iex
#
# Environment:
#   DITFA_VERSION      release to install, e.g. 0.2.0 (default: latest)
#   DITFA_INSTALL_DIR  where the binaries go (default: %LOCALAPPDATA%\Programs\Ditfa\bin)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$Repo = "ditfa-dev/ditfa-cli"
$Version = if ($env:DITFA_VERSION) { $env:DITFA_VERSION } else { "latest" }
$InstallDir = if ($env:DITFA_INSTALL_DIR) {
    $env:DITFA_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA "Programs\Ditfa\bin"
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message"
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($arch) {
    "X64" { $Target = "x86_64-pc-windows-msvc" }
    "Arm64" { $Target = "aarch64-pc-windows-msvc" }
    default { throw "Unsupported CPU architecture: $arch" }
}

$Archive = "ditfa-$Target.zip"
if ($Version -eq "latest") {
    $Base = "https://github.com/$Repo/releases/latest/download"
} elseif ($Version.StartsWith("v")) {
    $Base = "https://github.com/$Repo/releases/download/$Version"
} else {
    $Base = "https://github.com/$Repo/releases/download/v$Version"
}

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("ditfa-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Step "Downloading Ditfa CLI ($Version) for $Target"
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Archive" -OutFile (Join-Path $Temp $Archive)
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Temp "SHA256SUMS")

    $line = Get-Content (Join-Path $Temp "SHA256SUMS") | Where-Object { $_ -match "\s$([regex]::Escape($Archive))$" } | Select-Object -First 1
    if (-not $line) { throw "No checksum for $Archive in SHA256SUMS." }
    $Expected = ($line -split "\s+")[0].ToLowerInvariant()
    $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temp $Archive)).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) { throw "Checksum mismatch for $Archive (expected $Expected, got $Actual)." }

    $Extracted = Join-Path $Temp "ditfa"
    Expand-Archive -Path (Join-Path $Temp $Archive) -DestinationPath $Extracted -Force
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -Path $Extracted -Filter "*.exe" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $InstallDir $_.Name) -Force
    }

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Entries = if ($UserPath) { $UserPath -split ";" } else { @() }
    if ($Entries -notcontains $InstallDir) {
        $NewPath = (@($Entries | Where-Object { $_ }) + $InstallDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
        $env:Path = "$env:Path;$InstallDir"
        Write-Step "Added $InstallDir to your user PATH (open a new terminal to pick it up)"
    }

    $Installed = & (Join-Path $InstallDir "ditfa.exe") --version
    Write-Step "Installed $Installed to $InstallDir"
    Write-Host ""
    Write-Host "Get started:"
    Write-Host '  $env:DITFA_API_KEY = "dt-..."   # from https://chat.ditfa.com/api-keys'
    Write-Host "  ditfa"
} finally {
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
