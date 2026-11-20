#!/usr/bin/env bash
# Create the GitHub repository and push main.
#
# Run this once the machine can reach api.github.com (the sandbox blocked it the
# first time). The token is read from ~/.dsh/publish-tokens.txt; it is never
# written to the repository.
#
#   bash scripts/push-repo.sh            # create repo + push
#   bash scripts/push-repo.sh --retry    # repo exists, just push
set -euo pipefail

OWNER=Dongze502
NAME=preflight-eta-chime
DESCRIPTION='Pre-send estimate, live ETA and a completion chime for DeepSeek Harness'
TOKEN_FILE="${HOME}/.dsh/publish-tokens.txt"

if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "missing ${TOKEN_FILE}" >&2
  exit 1
fi

# The file has trailing whitespace after the value; a stray space breaks Basic
# auth with a 401 and a malformed-URL error.
GH_TOKEN="$(grep -m1 '^github=' "${TOKEN_FILE}" | cut -d= -f2- | sed 's/[[:space:]]*$//')"
if [[ -z "${GH_TOKEN}" ]]; then
  echo "no github= token in ${TOKEN_FILE}" >&2
  exit 1
fi

export GH_TOKEN
API="https://api.github.com"
CURL=(curl -sS --ssl-no-revoke --http1.1 -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")

if [[ "${1:-}" != "--retry" ]]; then
  "${CURL[@]}" -X POST "${API}/user/repos" \
    -d "{\"name\":\"${NAME}\",\"description\":\"${DESCRIPTION}\",\"homepage\":\"https://github.com/${OWNER}/${NAME}\",\"private\":false,\"has_issues\":true,\"has_wiki\":false}" \
    -o /tmp/repo-create.json -w 'create http=%{http_code}\n'
fi

"${CURL[@]}" -X PUT "${API}/repos/${OWNER}/${NAME}/topics" \
  -d '{"names":["dsh-plugin","deepseek-harness","eta","cordis"]}' \
  -o /dev/null -w 'topics http=%{http_code}\n'

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${OWNER}/${NAME}.git"

# schannel drops the connection on this host; HTTP/1.1 plus a non-interactive
# credential helper is the combination that worked when the network was up. The
# system helper is the interactive selector, so it has to be cleared first.
git -c http.sslVerify=false -c http.version=HTTP/1.1 \
    -c credential.helper= \
    -c 'credential.helper=!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f' \
    push -u origin main

echo "done: https://github.com/${OWNER}/${NAME}"
