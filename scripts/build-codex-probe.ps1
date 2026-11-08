param(
  [string]$MsvcRoot = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.44.35207',
  [string]$SdkRoot = 'C:\Program Files (x86)\Windows Kits\10',
  [string]$SdkVersion = '10.0.26100.0'
)
$ErrorActionPreference = 'Stop'
function Get-TextDigest([string]$File) {
  # Git checkouts can use CRLF. Pin text with LF normalization; executable bytes stay exact.
  $text = [IO.File]::ReadAllText($File).Replace("`r`n", "`n")
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
$repository = Split-Path -Parent $PSScriptRoot
$nativeDirectory = Join-Path $repository 'app\native'
$buildDirectory = Join-Path $nativeDirectory '.build'
New-Item -ItemType Directory -Force -Path $buildDirectory | Out-Null
$source = Join-Path $nativeDirectory 'codex-read-probe.c'
$object = Join-Path $buildDirectory 'codex-read-probe.obj'
$binary = Join-Path $nativeDirectory 'codex-read-probe.exe'
$compiler = Join-Path $MsvcRoot 'bin\Hostx64\x64\cl.exe'
$linker = Join-Path $MsvcRoot 'bin\Hostx64\x64\link.exe'
& $compiler /nologo /c /GS- /Zl /Oi /O1 /W4 /WX /Brepro "/I$MsvcRoot\include" "/I$SdkRoot\Include\$SdkVersion\um" "/I$SdkRoot\Include\$SdkVersion\shared" "/I$SdkRoot\Include\$SdkVersion\ucrt" "/Fo$object" $source
if ($LASTEXITCODE -ne 0) { throw 'Native probe compilation failed.' }
& $linker /nologo /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE /MACHINE:X64 /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /Brepro "/OUT:$binary" $object "$SdkRoot\Lib\$SdkVersion\um\x64\kernel32.lib"
if ($LASTEXITCODE -ne 0) { throw 'Native probe link failed.' }
$manifest = [ordered]@{
  schema = 1
  platform = 'win32'
  arch = 'x64'
  textNormalization = 'LF'
  sourceSha256 = Get-TextDigest $source
  binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  buildScriptSha256 = Get-TextDigest $PSCommandPath
  compiler = 'MSVC ' + (Split-Path -Leaf $MsvcRoot)
  sdk = $SdkVersion
}
[IO.File]::WriteAllText((Join-Path $nativeDirectory 'codex-read-probe.json'), ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$manifest | ConvertTo-Json
