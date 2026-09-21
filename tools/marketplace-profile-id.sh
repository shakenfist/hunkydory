#!/bin/bash
#
# Print the Azure DevOps profile id of the Entra application that publishes
# this extension.
#
# That id -- not the client id, not the service principal's object id, not
# an Azure resource id -- is the only identifier the Marketplace publisher's
# member picker resolves. It appears nowhere in the Entra portal, and can
# only be read by presenting a token minted as the application itself.
#
# Step 4 of RELEASE-SETUP.md is the only caller. This is a one-time setup
# step run by hand on a workstation; nothing in CI runs it, and it is
# needed again only if the app registration is ever recreated.
#
# Usage:
#   AZURE_CLIENT_ID=... AZURE_TENANT_ID=... tools/marketplace-profile-id.sh
#
# It prompts for a client secret. That secret exists only to hold a token
# outside GitHub Actions: the application's federated credential trusts
# GitHub's issuer alone, so there is no way to authenticate as it from a
# workstation without one. Delete it as soon as this has printed.

set -euo pipefail

# The Marketplace's Entra resource id. tools/marketplace-token.mjs carries
# the same constant as MARKETPLACE_SCOPE; the two must agree.
MARKETPLACE_RESOURCE='499b84ac-1321-427f-aa17-267ca6975798'

die() {
    echo "$*" >&2
    exit 1
}

[ -n "${AZURE_CLIENT_ID:-}" ] || die 'AZURE_CLIENT_ID is not set'
[ -n "${AZURE_TENANT_ID:-}" ] || die 'AZURE_TENANT_ID is not set'
command -v node >/dev/null 2>&1 || die 'node is required and was not found'

read -r -s -p 'Client secret (input hidden): ' secret
echo
[ -n "${secret}" ] || die 'no client secret was given'

# The access token is a publishing credential for as long as it lives, so it
# is never echoed -- only the profile id below is printed.
token=$(curl --silent --show-error --fail-with-body \
    "https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token" \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=${AZURE_CLIENT_ID}" \
    --data-urlencode "client_secret=${secret}" \
    --data-urlencode "scope=${MARKETPLACE_RESOURCE}/.default" \
    | node -e 'let s="";
process.stdin.on("data", c => s += c).on("end", () => {
    let d;
    try { d = JSON.parse(s); } catch { console.error("token endpoint did not return JSON: " + s); process.exit(1); }
    if (!d.access_token) { console.error(d.error_description || s); process.exit(1); }
    process.stdout.write(d.access_token);
});')

[ -n "${token}" ] || die 'the token endpoint returned no access token'

curl --silent --show-error --fail-with-body \
    --header "Authorization: Bearer ${token}" \
    'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1' \
    | node -e 'let s="";
process.stdin.on("data", c => s += c).on("end", () => {
    let d;
    try { d = JSON.parse(s); } catch { console.error("profile API did not return JSON: " + s); process.exit(1); }
    if (!d.id) { console.error("profile API returned no id: " + s); process.exit(1); }
    console.log("");
    console.log("Profile id:   " + d.id);
    console.log("Display name: " + d.displayName);
    console.log("");
    console.log("Paste the profile id into the publisher Members list, then");
    console.log("delete the client secret you just created.");
});'
