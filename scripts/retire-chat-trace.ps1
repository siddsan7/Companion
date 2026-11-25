$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'TraceRetirement.cs')
    $plan = [Console]::In.ReadToEnd() | ConvertFrom-Json
    [CompanionTraceRetirement]::Remove($plan.root, [TraceEntry[]]$plan.entries)
} catch {
    [Console]::Error.WriteLine('Trace cleanup incomplete. Remaining entries were preserved.')
    exit 1
}
