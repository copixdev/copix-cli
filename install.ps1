# Copix CLI installer (Windows) — permanent user install, PATH updated automatically.
# irm https://raw.githubusercontent.com/EJH-BAE/Copix/refs/heads/main/cli/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = if ($env:COPIX_REPO) { $env:COPIX_REPO } else { 'https://github.com/EJH-BAE/Copix.git' }
$Branch = if ($env:COPIX_BRANCH) { $env:COPIX_BRANCH } else { 'main' }
$InstallDir = if ($env:COPIX_INSTALL_DIR) { $env:COPIX_INSTALL_DIR } else { Join-Path $HOME '.copix' }

Write-Host 'Copix CLI — standalone installer (Windows)'
Write-Host ''

function Assert-Command($Name, $Hint) {
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		Write-Error "$Name is required. $Hint"
	}
}

Assert-Command 'node' 'Install Node.js 18+ from https://nodejs.org'
Assert-Command 'git' 'Install Git from https://git-scm.com'
Assert-Command 'npm' 'npm comes with Node.js — reinstall Node from https://nodejs.org'

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) {
	Write-Error "Copix CLI requires Node.js 18+ (found $(node -v))."
}

function Install-OrUpdate {
	if (Test-Path (Join-Path $InstallDir '.git')) {
		Write-Host "Updating Copix in $InstallDir …"
		git -C $InstallDir fetch --depth 1 origin $Branch
		git -C $InstallDir checkout -B $Branch "origin/$Branch"
		git -C $InstallDir reset --hard "origin/$Branch"
		git -C $InstallDir clean -ffd
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

$Installed = $null
$Method = ''

# 1) Prefer npm global (usually already on user PATH)
try {
	npm install -g $InstallDir\cli --silent 2>$null
	$npmPrefix = (npm prefix -g).Trim()
	$npmShim = Join-Path $npmPrefix 'copix.cmd'
	$npmShimPs = Join-Path $npmPrefix 'copix'
	if (Test-Path $npmShim) {
		$Installed = $npmShim
		$Method = 'npm-global'
	} elseif (Test-Path $npmShimPs) {
		$Installed = $npmShimPs
		$Method = 'npm-global'
	}
} catch {
	# fall through
}

# 2) Fallback: permanent user bin + User PATH (no manual export)
if (-not $Installed) {
	$BinDir = if ($env:COPIX_BIN_DIR) { $env:COPIX_BIN_DIR } else { Join-Path $HOME '.local\bin' }
	New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
	$Shim = Join-Path $BinDir 'copix.cmd'
	@"
@echo off
node "$CopixJs" %*
"@ | Set-Content -Encoding ASCII $Shim
	$Installed = $Shim
	$Method = 'user-bin'

	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	if (-not $userPath) { $userPath = '' }
	$parts = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() })
	if (-not ($parts | Where-Object { $_ -ieq $BinDir })) {
		$newPath = if ($userPath.Trim()) { "$userPath;$BinDir" } else { $BinDir }
		[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
		Write-Host "Permanently added to user PATH: $BinDir"
	}
	$env:Path = "$BinDir;$env:Path"
}

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

Write-Host ''
Write-Host "Installed permanently: $Installed"
Write-Host "Method: $Method"
Write-Host 'No account required. Copix CLI talks to local Ollama.'
Write-Host ''
Write-Host 'Next (new terminal if PATH just changed):'
Write-Host '  ollama pull qwen2.5:3b'
Write-Host '  copix doctor'
Write-Host '  copix'
Write-Host ''
Write-Host 'macOS / Linux install:'
Write-Host '  curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/refs/heads/main/cli/install.sh | bash'
