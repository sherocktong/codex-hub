export const BASH_COMPLETION = `_codx_profile_names() {
  local profiles_file="\${CODEX_PROFILES_FILE:-\$HOME/.codex/profiles.json}"
  if [[ -f "$profiles_file" ]]; then
    command python3 -c "
import json
data = json.load(open('$profiles_file'))
for name in data.get('profiles', {}):
    print(name)
" 2>/dev/null
  fi
}

_codx_profiles() {
  COMPREPLY=($(compgen -W "$(_codx_profile_names)" -- "\${cur}"))
}

_codx_models_for_profile() {
  local profile_name="$1"
  local profiles_file="\${CODEX_PROFILES_FILE:-\$HOME/.codex/profiles.json}"
  if [[ -f "$profiles_file" && -n "$profile_name" ]]; then
    local models
    models=$(command python3 -c "
import json
data = json.load(open('$profiles_file'))
p = data.get('profiles', {}).get('$profile_name', {})
models = p.get('models')
if isinstance(models, list):
    for m in models:
        if m:
            print(m)
else:
    m = p.get('model')
    if m:
        print(m)
" 2>/dev/null)
    COMPREPLY=($(compgen -W "$models" -- "\${cur}"))
  fi
}

_codx() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="profile use run unproxy provider hook session codex-version completion help"

  local profile_subcmds="add update list view remove rename"
  local provider_types="kimi qianwen"
  local hooks_subcmds="list add remove enable disable"
  local session_subcmds="list show search ps stats clean troubleshoot"
  local codex_version_subcmds="list pin unpin"

  # Top-level command
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$commands" -- "$cur"))
    return 0
  fi

  local cmd="\${COMP_WORDS[1]}"

  case "$cmd" in
    profile)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$profile_subcmds" -- "$cur"))
      elif [[ "$prev" == "view" || "$prev" == "remove" ]]; then
        _codx_profiles
      elif [[ "$prev" == "rename" ]]; then
        _codx_profiles
      elif [[ "$prev" == "profile" ]]; then
        COMPREPLY=($(compgen -W "$profile_subcmds" -- "$cur"))
      elif [[ "\${COMP_WORDS[2]}" == "update" && \${COMP_CWORD} -eq 3 ]]; then
        _codx_profiles
      elif [[ "\${COMP_WORDS[2]}" == "update" ]]; then
        if [[ "$prev" == "--provider" || "$prev" == "-p" ]]; then
          COMPREPLY=($(compgen -W "$provider_types" -- "$cur"))
        elif [[ "$prev" == "--model" || "$prev" == "-m" || "$prev" == "--delete-model" || "$prev" == "-d" ]]; then
          _codx_models_for_profile "\${COMP_WORDS[3]}"
        else
          local update_opts="--model -m --delete-model -d --token -t --url -u --provider -p"
          COMPREPLY=($(compgen -W "$update_opts" -- "$cur"))
        fi
      fi
      ;;
    use|run)
      _codx_profiles
      ;;
    hook)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$hooks_subcmds" -- "$cur"))
      fi
      ;;
    session)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$session_subcmds" -- "$cur"))
      elif [[ "\${COMP_WORDS[2]}" == "troubleshoot" ]]; then
        if [[ "$prev" == "--interactive" || "$prev" == "-i" ]]; then
          :
        else
          local troubleshoot_opts="--interactive -i"
          COMPREPLY=($(compgen -W "$troubleshoot_opts" -- "$cur"))
        fi
      fi
      ;;
    codex-version)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$codex_version_subcmds" -- "$cur"))
      elif [[ "\${COMP_WORDS[2]}" == "pin" ]]; then
        if [[ "$prev" == "--clear" ]]; then
          :
        else
          local pin_opts="--clear"
          COMPREPLY=($(compgen -W "$pin_opts" -- "$cur"))
        fi
      fi
      ;;
  esac

  return 0
}

complete -F _codx codx
`;
