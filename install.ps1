# Copix CLI installer (Windows)
# irm https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = if ($env:COPIX_REPO) { $env:COPIX_REPO } else { 'https://github.com/EJH-BAE/Copix.git' }
$Branch = if ($env:COPIX_BRANCH) { $env:COPIX_BRANCH } else { 'main' }
$InstallDir = if ($env:COPIX_INSTALL_DIR) { $env:COPIX_INSTALL_DIR } else { Join-Path $HOME '.copix' }
$BinDir = if ($env:COPIX_BIN_DIR) { $env:COPIX_BIN_DIR } else { Join-Path $HOME '.local\bin' }

Write-Host 'Copix CLI — standalone installer (Windows)'
Write-Host ''

function Assert-Command($Name, $Hint) {
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		Write-Error "$Name is required. $Hint"
	}
}

Assert-Command 'node' 'Install Node.js 18+ from https://nodejs.org'
Assert-Command 'git' 'Install Git from https://git-scm.com'

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) {
	Write-Error "Copix CLI requires Node.js 18+ (found $(node -v))."
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

function Install-OrUpdate {
	if (Test-Path (Join-Path $InstallDir '.git')) {
		Write-Host "Updating Copix in $InstallDir …"
		git -C $InstallDir fetch --depth 1 origin $Branch
		git -C $InstallDir checkout -B $Branch "origin/$Branch"
		git -C $InstallDir reset --hard "origin/$Branch"
		git -C $InstallDir clean -fd
	} else {
		Write-Host "Installing Copix into $InstallDir …"
		if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
		git clone --depth 1 --branch $Branch $Repo $InstallDir
	}
}

try {
	Install-OrUpdate
} catch {
	Write-Host "Git update failed — re-cloning $InstallDir …"
	if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
	git clone --depth 1 --branch $Branch $Repo $InstallDir
}

$CopixJs = Join-Path $InstallDir 'cli\bin\copix.js'
$AgentRouter = Join-Path $InstallDir 'cli\agent\models\router.ts'
if (-not (Test-Path $CopixJs)) { Write-Error "Install failed: $CopixJs missing." }
if (-not (Test-Path $AgentRouter)) { Write-Error 'Install failed: standalone agent missing under cli/agent.' }

Write-Host 'Installing CLI dependencies …'
npm install --prefix (Join-Path $InstallDir 'cli') --omit=dev --silent

$Shim = Join-Path $BinDir 'copix.cmd'
@"
@echo off
node "$CopixJs" %*
"@ | Set-Content -Encoding ASCII $Shim

$CopixHome = Join-Path $HOME 'Copix'
New-Item -ItemType Directory -Force -Path $CopixHome | Out-Null
$Settings = Join-Path $CopixHome 'settings.json'
if (-not (Test-Path $Settings)) {
	@'
{
  "model": {
    "provider": "ollama",
    "apiKey": "",
    "selection": "auto",
    "modelId": "qwen2.5:3b",
    "lowVram": false
  },
  "workspace": { "homeDirectory": "" },
  "agentMode": "code"
}
'@ | Set-Content -Encoding UTF8 $Settings
}

# Add BinDir to user PATH if missing
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -and ($_ -ieq $BinDir) })) {
	[Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $BinDir), 'User')
	$env:Path = "$BinDir;$env:Path"
	Write-Host ''
	Write-Host "Added to user PATH: $BinDir"
	Write-Host 'Open a new terminal for PATH changes to apply everywhere.'
}

Write-Host ''
Write-Host "Installed: $Shim"
Write-Host 'No account required. Copix CLI talks to local Ollama.'
Write-Host ''
Write-Host 'Next:'
Write-Host '  ollama pull qwen2.5:3b'
Write-Host '  copix doctor'
Write-Host '  copix'
Write-Host '  copix "summarize this repo"'
Write-Host ''
Write-Host 'macOS / Linux install:'
Write-Host '  curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash'
