$ErrorActionPreference = 'Stop'
$root = (Resolve-Path '.').Path
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$config = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
$expectedUpgrade = '3f4f99df-849f-5d73-9a7d-b7991d83bac5'
if ($config.identifier -ne 'com.pos.dailys') { throw 'Unexpected Tauri identifier.' }
if ($config.bundle.windows.wix.upgradeCode.ToLowerInvariant() -ne $expectedUpgrade) { throw 'Unexpected MSI UpgradeCode.' }
if ($config.productName -ne 'Swift Till UNVERIFIED TEST CANDIDATE') { throw 'Candidate is missing unverified installer branding.' }

$builtMsis = @(Get-ChildItem -LiteralPath (Join-Path $root 'src-tauri\target\release\bundle\msi') -Filter '*.msi' -File)
if ($builtMsis.Count -ne 1) { throw "Expected exactly one WiX-validated MSI, found $($builtMsis.Count)." }
$sourceMsi = $builtMsis[0].FullName
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($sourceMsi, 0)
function Read-MsiProperty([object]$Db, [string]$Name) {
  $query = "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$Name'"
  $view = $Db.OpenView($query)
  $null = $view.Execute()
  $record = $view.Fetch()
  if ($null -eq $record) { throw "MSI property $Name is missing." }
  $value = $record.StringData(1)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "MSI property $Name is empty." }
  return $value.Trim()
}
$msiVersion = Read-MsiProperty $database 'ProductVersion'
$upgradeCode = Read-MsiProperty $database 'UpgradeCode'
if ($msiVersion -ne $version) { throw "MSI version mismatch: $msiVersion" }
if ($upgradeCode.TrimStart('{').TrimEnd('}').ToLowerInvariant() -ne $expectedUpgrade) { throw 'Built MSI UpgradeCode mismatch.' }

$fileView = $database.OpenView('SELECT `FileName` FROM `File`')
$null = $fileView.Execute()
$hasExecutable = $false
while ($record = $fileView.Fetch()) {
  $fileName = $record.StringData(1).Split('|')[-1]
  if ($fileName -ieq 'app.exe') { $hasExecutable = $true; break }
}
if (-not $hasExecutable) { throw 'MSI payload does not contain app.exe.' }

$out = Join-Path $root 'ci-output'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$commit = $env:GITHUB_SHA
if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'GitHub commit SHA is unavailable or invalid.' }
$candidateName = "Swift-Till-UNVERIFIED-TEST-CANDIDATE-$version-$commit.msi"
$candidatePath = Join-Path $out $candidateName
Copy-Item -LiteralPath $sourceMsi -Destination $candidatePath
$hash = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  label = 'UNVERIFIED TEST CANDIDATE'
  version = $version
  sourceCommit = $commit
  sourceRef = $env:GITHUB_REF_NAME
  artifact = $candidateName
  sha256 = $hash
  synchronizationEnabled = $true
  supabaseProjectRef = 'ncbyahoyhrbmunqkisuq'
  applicationIdentifier = $config.identifier
  upgradeCode = $config.bundle.windows.wix.upgradeCode
  msiProductVersion = $msiVersion
  msiUpgradeCode = $upgradeCode
  wixIceValidationDisabled = $false
  certifiedCustomerRelease = $false
  installedUpgradeVerified = $false
  freshManarScopedVerificationPassed = $false
  productionDataModified = $false
  customerInstallationModified = $false
  notes = @('Build and automated checks only. Do not install over an existing POS.', 'Fresh manar-scoped production verification and isolated installed-upgrade testing remain mandatory.')
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $out 'BUILD-MANIFEST.json') -Encoding utf8
@("$hash  $candidateName") | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt') -Encoding ascii
Write-Output ($manifest | ConvertTo-Json -Depth 5)
