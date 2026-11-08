$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.name -notmatch '^Companion-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$') { throw 'Invalid Companion task identity.' }
  if ($request.operation -notin @('enable','inspect','pause','resume','disable','repair')) { throw 'Unsupported task operation.' }
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $task = $null
  try { $task = $folder.GetTask($request.name) }
  catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    if (($failure.HResult -band 0xffff) -ne 2) { throw }
  }
  if ($null -ne $task) {
    $definition = $task.Definition
    $registeredUser = $definition.Principal.UserId
    if ($registeredUser -match '^S-\d+(?:-\d+)+$') { $registeredSid = [System.Security.Principal.SecurityIdentifier]::new($registeredUser).Value }
    else { $registeredSid = [System.Security.Principal.NTAccount]::new($registeredUser).Translate([System.Security.Principal.SecurityIdentifier]).Value }
    if ($definition.RegistrationInfo.Description -cne $request.owner -or $registeredSid -ne $sid -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1) { throw 'Task ownership or principal differs. Preserve the task for explicit repair.' }
    $action = $definition.Actions.Item(1)
    if ($action.Type -ne 0 -or $action.Path -ine $request.executable -or $action.Arguments -cne $request.arguments -or $action.WorkingDirectory -ine $request.directory) { throw 'Task launch action differs. Preserve the task for explicit repair.' }
  }
  if ($request.operation -eq 'disable') {
    if ($null -ne $task) { $folder.DeleteTask($request.name, 0) }
    @{ task = $null } | ConvertTo-Json -Compress
    exit 0
  }
  if ($request.operation -in @('pause','resume')) {
    if ($null -eq $task) { throw 'Daily intake task is missing. Use Repair daily intake.' }
    $task.Enabled = $request.operation -eq 'resume'
  }
  if ($request.operation -in @('enable','repair')) {
    if (!(Test-Path -LiteralPath $request.executable -PathType Leaf) -or !(Test-Path -LiteralPath $request.directory -PathType Container)) { throw 'Installed worker executable or directory is unavailable.' }
    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = $request.owner
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $trigger = $definition.Triggers.Create(1)
    $trigger.StartBoundary = $request.firstDue
    $trigger.Repetition.Interval = 'PT24H'
    $trigger.Repetition.StopAtDurationEnd = $false
    $trigger.Enabled = $true
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.StartWhenAvailable = $true
    $definition.Settings.WakeToRun = $false
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.RunOnlyIfNetworkAvailable = $false
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.AllowHardTerminate = $false
    $definition.Settings.Enabled = if ($request.operation -eq 'enable') { $true } else { [bool]$request.enabled }
    $action = $definition.Actions.Create(0)
    $action.Path = $request.executable
    $action.Arguments = $request.arguments
    $action.WorkingDirectory = $request.directory
    $flags = if ($null -eq $task) { 2 } else { 4 }
    $task = $folder.RegisterTaskDefinition($request.name, $definition, $flags, $sid, $null, 3)
  }
  if ($null -eq $task) { @{ task = $null } | ConvertTo-Json -Compress }
  else {
    $effective = $task.Definition
    $policy = @{ triggerCount = $effective.Triggers.Count; triggerType = $null; triggerEnabled = $null; firstDue = $null; interval = $null; repetitionDuration = $null; endBoundary = $null; stopAtDurationEnd = $null }
    if ($effective.Triggers.Count -eq 1) {
      $actualTrigger = $effective.Triggers.Item(1)
      $policy.triggerType = $actualTrigger.Type
      $policy.triggerEnabled = $actualTrigger.Enabled
      $policy.firstDue = $actualTrigger.StartBoundary
      $policy.endBoundary = [string]$actualTrigger.EndBoundary
      $policy.interval = $actualTrigger.Repetition.Interval
      $policy.repetitionDuration = [string]$actualTrigger.Repetition.Duration
      $policy.stopAtDurationEnd = $actualTrigger.Repetition.StopAtDurationEnd
    }
    $policy.name = $task.Name
    $policy.enabled = $task.Enabled
    $policy.startWhenAvailable = $effective.Settings.StartWhenAvailable
    $policy.wakeToRun = $effective.Settings.WakeToRun
    $policy.multipleInstances = $effective.Settings.MultipleInstances
    $policy.state = $task.State
    $policy.lastRun = $task.LastRunTime.ToString('o')
    $policy.lastResult = $task.LastTaskResult
    $policy.nextRun = $task.NextRunTime.ToString('o')
    $policy.xml = $task.Xml
    @{ task = $policy } | ConvertTo-Json -Compress -Depth 4
  }
} catch {
  @{ error = "Windows Task Scheduler: $($_.Exception.Message)" } | ConvertTo-Json -Compress
  exit 1
}
