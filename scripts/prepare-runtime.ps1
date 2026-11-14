# 重新准备 AirPlay 运行时（GPLv3 组件）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/prepare-runtime.ps1
#
# 默认下载 uxplay-windows 2.0.0.1736 便携包（Qt 引擎，CPU 可移植，不需要 AVX2），
# 解压到 runtime/qt/。该包是纯 ZIP，不写注册表、不装系统服务。
# 加 -IncludeLegacy 会额外准备旧的命令行版 uxplay.exe（需 AVX2 CPU，仅供新机器使用）。

[CmdletBinding()]
param(
    [switch] $Force,
    [switch] $IncludeLegacy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $root '.cache'
$runtime = Join-Path $root 'runtime'
$qtTarget = Join-Path $runtime 'qt'
$qtEngine = Join-Path $qtTarget 'uxplay-windows.exe'

New-Item -ItemType Directory -Force -Path $cache, $runtime | Out-Null

if ((Test-Path $qtEngine) -and -not $Force) {
    Write-Host "Qt 引擎已存在：$qtEngine"
    Write-Host '如需重新下载解压，请加 -Force。'
} else {
    $url = 'https://github.com/leapbtw/uxplay-windows/releases/download/2.0.0.1736/uxplay-windows.zip'
    $zip = Join-Path $cache 'uxplay-windows-2.0.zip'
    if (-not (Test-Path $zip)) {
        Write-Host '下载 uxplay-windows 2.0.0.1736 便携包（约 113 MB）…'
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    Write-Host '解压到 runtime/qt …'
    New-Item -ItemType Directory -Force -Path $qtTarget | Out-Null
    Expand-Archive -Path $zip -DestinationPath $qtTarget -Force
    if (-not (Test-Path $qtEngine)) { throw '解压后未找到 uxplay-windows.exe' }
    Write-Host "Qt 引擎就绪：$qtEngine"
}

if ($IncludeLegacy) {
    $legacyUrl = 'https://github.com/leapbtw/uxplay-windows/releases/download/1.72.1-3/uxplay-windows-installer-v1.72.1-3.exe'
    $installer = Join-Path $cache 'uxplay-installer-1.72.1-3.exe'
    $extract = Join-Path $cache 'installed'
    $legacyEngine = Join-Path $runtime 'bin\uxplay.exe'
    if ((Test-Path $legacyEngine) -and -not $Force) {
        Write-Host "命令行引擎已存在：$legacyEngine"
    } else {
        if (-not (Test-Path $installer)) {
            Write-Host '下载旧版安装包（约 65 MB）…'
            Invoke-WebRequest -Uri $legacyUrl -OutFile $installer -UseBasicParsing
        }
        New-Item -ItemType Directory -Force -Path $extract | Out-Null
        Write-Host '静默解包到 .cache/installed（安装器会写卸载注册表项）…'
        $setupArgs = @(
            '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NOICONS', '/TASKS=',
            "/DIR=$extract", "/LOG=$extract\install.log"
        )
        & $installer @setupArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "旧版解包失败，退出码 $LASTEXITCODE" }
        $source = Join-Path $extract '_internal'
        if (-not (Test-Path (Join-Path $source 'bin\uxplay.exe'))) { throw '安装包内未找到 uxplay.exe' }
        New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'bin'), (Join-Path $runtime 'lib') | Out-Null
        Copy-Item -Path (Join-Path $source 'bin\*') -Destination (Join-Path $runtime 'bin') -Recurse -Force
        Copy-Item -Path (Join-Path $source 'lib\*') -Destination (Join-Path $runtime 'lib') -Recurse -Force

        # libgstcurl.dll 依赖分发包里没有的 libngtcp2，禁用它以免每次启动报警告
        $disabled = Join-Path $runtime 'lib\disabled'
        New-Item -ItemType Directory -Force -Path $disabled | Out-Null
        $curlPlugin = Join-Path $runtime 'lib\gstreamer-1.0\libgstcurl.dll'
        if (Test-Path $curlPlugin) {
            Move-Item -Path $curlPlugin -Destination (Join-Path $disabled 'libgstcurl.dll') -Force
        }
        Write-Host "命令行引擎就绪（需 AVX2）：$legacyEngine"
    }
}

Write-Host ''
Write-Host '提示：AirPlay 服务发现依赖 Bonjour Service（本机通常已随 iTunes/Apple 软件安装）。'
Write-Host '接下来执行 npm run check 与 node scripts/smoke-test.js。'
