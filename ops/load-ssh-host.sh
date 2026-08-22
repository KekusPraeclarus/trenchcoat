# Sets HOST to an SSH config Host alias.
# Source from ops scripts. Do not execute.
#
# Precedence:
#   1. TRENCHCOAT_SSH_HOST
#   2. $REPO_ROOT/.trenchcoat-local/ssh-host (gitignored)
#   3. $HOME/.trenchcoat/ssh-host (outside the repo)
#
# The alias never belongs in git. Copy ops/ssh-host.example to the local file.

_tc_host_from_file() {
  _tc_f="$1"
  [ -f "$_tc_f" ] || return 1
  while IFS= read -r _tc_line || [ -n "${_tc_line:-}" ]; do
    case "$_tc_line" in
      ""|\#*) continue ;;
    esac
    HOST=$(printf "%s" "$_tc_line" | tr -d "[:space:]")
    unset _tc_line _tc_f
    [ -n "$HOST" ] && return 0
  done < "$_tc_f"
  unset _tc_line _tc_f
  return 1
}

HOST="${TRENCHCOAT_SSH_HOST:-}"
if [ -z "$HOST" ]; then
  if [ -n "${REPO_ROOT:-}" ]; then
    _tc_host_from_file "$REPO_ROOT/.trenchcoat-local/ssh-host" || true
  fi
fi
if [ -z "$HOST" ] && [ -n "${HOME:-}" ]; then
  _tc_host_from_file "$HOME/.trenchcoat/ssh-host" || true
fi
unset -f _tc_host_from_file
