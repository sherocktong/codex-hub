export const ZSH_COMPLETION = `#compdef codx

_codx() {
  local -a commands
  commands=(
    'profile:Manage Codex CLI profiles'
    'use:Set a profile as the default'
    'run:Launch Codex CLI using the default or a specified profile'
    'proxy:Manage provider proxy daemons'
    'provider:List configured providers'
    'hook:Manage Codex CLI hooks in settings.json'
    'session:Manage Codex CLI sessions'
    'codex-version:Manage Codex CLI versions'
    'completion:Print shell completion functions'
    'help:Display help for a command'
  )

  local -a proxy_subcmds
  proxy_subcmds=(
    'start:Start a proxy daemon for a profile'
    'stop:Stop a proxy daemon'
    'restart:Restart a proxy daemon for a profile'
    'status:Show status of proxy daemons'
    'log:Show recent logs for a proxy daemon'
    'list:List running proxy daemons'
  )

  local -a profile_subcmds
  profile_subcmds=(
    'add:Add or update a profile'
    'update:Update fields of an existing profile'
    'list:List all profiles'
    'view:View full details of a profile'
    'remove:Remove a profile'
    'rename:Rename a profile'
  )

  local -a hooks_subcmds
  hooks_subcmds=(
    'list:List all hooks'
    'add:Add a hook to settings.json'
    'remove:Remove a hook by its global index'
    'enable:Enable one or more disabled hooks'
    'disable:Disable one or more hooks'
  )

  local -a session_subcmds
  session_subcmds=(
    'list:List all Codex CLI project sessions'
    'show:Show session files for a project'
    'search:Search conversation history across all projects'
    'ps:Show active Codex CLI processes'
    'stats:Show summary statistics'
    'clean:Delete session JSONL files older than N days'
    'troubleshoot:Launch Codex CLI to troubleshoot a session file'
  )

  local -a codex_version_subcmds
  codex_version_subcmds=(
    'list:List available Codex CLI versions'
    'pin:Pin Codex CLI to a specific version'
    'unpin:Remove the Codex CLI version pin'
  )

  _codx_profiles() {
    local profiles_file="\${CODEX_PROFILES_FILE:-\$HOME/.codex/profiles.json}"
    if [[ -f "$profiles_file" ]]; then
      local -a names
      names=(\${(f)"$(command jq -r '.profiles | keys[]' "$profiles_file" 2>/dev/null)"})
      _describe -t profiles 'profile' names
    fi
  }

  _codx_models_for_profile() {
    local profile_name="$1"
    local profiles_file="\${CODEX_PROFILES_FILE:-\$HOME/.codex/profiles.json}"
    if [[ -f "$profiles_file" && -n "$profile_name" ]]; then
      local -a models
      models=(\${(f)"$(command jq -r --arg p "$profile_name" '(.profiles[$p].models // [ .profiles[$p].model ] )[]? // empty' "$profiles_file" 2>/dev/null)"})
      _describe -t models 'model' models
    fi
  }

  _arguments -C \\
    '1: :->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'codx command' commands
      ;;
    args)
      case $words[1] in
        profile)
          if (( CURRENT == 2 )); then
            _describe -t profile-subcmds 'profile subcommand' profile_subcmds
          elif [[ $words[2] == "view" || $words[2] == "remove" ]]; then
            _codx_profiles
          elif [[ $words[2] == "rename" ]]; then
            if (( CURRENT == 3 )); then
              _codx_profiles
            fi
          elif [[ $words[2] == "update" ]]; then
            if (( CURRENT == 3 )); then
              _codx_profiles
            else
              words=("stub" $words[3,-1])
              (( CURRENT-- ))
              _arguments -C -S \\\\
                '1:profile:_codx_profiles' \\\\
                '(-m --model)*'{-m,--model}'[Model ID]:model:->profileModel' \\\\
                '(-d --delete-model)*'{-d,--delete-model}'[Remove model ID]:model:->profileModel' \\\\
                '(-t --token)'{-t,--token}'[API key / token]:token:' \\\\
                '(-u --url)'{-u,--url}'[Base URL]:url:' \\\\
                '(-p --provider)'{-p,--provider}'[Provider type]:provider:(kimi qianwen)'
              case $state in
                profileModel)
                  _codx_models_for_profile $line[1]
                  ;;
              esac
            fi
          fi
          ;;
        use|run)
          '*:profile:_codx_profiles'
          ;;
        proxy)
          if (( CURRENT == 2 )); then
            _describe -t proxy-subcmds 'proxy subcommand' proxy_subcmds
          elif [[ $words[2] == "start" || $words[2] == "restart" || $words[2] == "status" || $words[2] == "log" || $words[2] == "stop" ]]; then
            _codx_profiles
          fi
          ;;
        provider)
          ;;
        hook)
          if (( CURRENT == 2 )); then
            _describe -t hooks-subcmds 'hook subcommand' hooks_subcmds
          fi
          ;;
        session)
          if (( CURRENT == 2 )); then
            _describe -t session-subcmds 'session subcommand' session_subcmds
          elif [[ $words[2] == "troubleshoot" ]]; then
            _arguments -C -S \\
              '(-i --interactive)'{-i,--interactive}'[Open an interactive Codex CLI window instead of a one-shot prompt]'
          fi
          ;;
        codex-version)
          if (( CURRENT == 2 )); then
            _describe -t codex-version-subcmds 'codex-version subcommand' codex_version_subcmds
          elif [[ $words[2] == "pin" ]]; then
            _arguments -C -S \\
              '--clear[Remove the version pin]' \\
              '*:version:'
          fi
          ;;
      esac
      ;;
  esac
}

compdef _codx codx
`;
