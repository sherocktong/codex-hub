export const POWERSHELL_COMPLETION = `Register-ArgumentCompleter -Native -CommandName codex-hub -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @(
    'profile:Manage Codex CLI profiles'
    'use:Set a profile as the default'
    'run:Launch Codex CLI using the default or a specified profile'
    'unproxy:Stop all running provider proxies'
    'provider:List configured providers'
    'hook:Manage Codex CLI hooks in settings.json'
    'session:Manage Codex CLI sessions'
    'cache:Manage Codex CLI cache and backup files'
    'codex-version:Manage Codex CLI versions'
    'completion:Print shell completion functions'
    'help:Display help for a command'
  )

  $profileSubcmds = @('add', 'update', 'list', 'view', 'remove', 'rename', 'default')
  $hookSubcmds = @('list', 'add', 'remove', 'enable', 'disable')
  $sessionSubcmds = @('list', 'show', 'search', 'ps', 'stats', 'clean', 'troubleshoot')
  $cacheSubcmds = @('restore')
  $codexVersionSubcmds = @('list', 'pin', 'unpin')

  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }

  if ($tokens.Count -eq 1 -or ($tokens.Count -eq 2 -and $wordToComplete -ne '')) {
    $commands | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
    return
  }

  $cmd = $tokens[1]

  switch ($cmd) {
    'profile' {
      if ($tokens.Count -eq 2 -or ($tokens.Count -eq 3 -and $wordToComplete -ne '')) {
        $profileSubcmds | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
        return
      }
    }
    'provider' {
      return
    }
    'hook' {
      if ($tokens.Count -eq 2 -or ($tokens.Count -eq 3 -and $wordToComplete -ne '')) {
        $hookSubcmds | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
        return
      }
    }
    'session' {
      if ($tokens.Count -eq 2 -or ($tokens.Count -eq 3 -and $wordToComplete -ne '')) {
        $sessionSubcmds | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
        return
      }
    }
    'cache' {
      if ($tokens.Count -eq 2 -or ($tokens.Count -eq 3 -and $wordToComplete -ne '')) {
        $cacheSubcmds | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
        return
      }
    }
    'codex-version' {
      if ($tokens.Count -eq 2 -or ($tokens.Count -eq 3 -and $wordToComplete -ne '')) {
        $codexVersionSubcmds | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
        return
      }
      if ($tokens[2] -eq 'pin' -and $tokens.Count -ge 3) {
        $opts = @('--clear')
        $opts | ForEach-Object { if ($_ -like "$wordToComplete*") { $_ } }
      }
    }
    'use' {
      return
    }
    'run' {
      return
    }
  }
}`;
