// Mint a VS Code Marketplace access token from this workflow run's GitHub
// OIDC identity, and print it on stdout.
//
// Why this exists rather than `vsce publish --azure-credential`. That flag
// resolves a token through @vscode/vsce/out/auth.js, which builds a fixed
// ChainedTokenCredential of EnvironmentCredential, AzureCliCredential,
// ManagedIdentityCredential, AzurePowerShellCredential and
// AzureDeveloperCliCredential. WorkloadIdentityCredential -- the only
// credential in @azure/identity that consumes a federated token directly --
// is not in that chain, even though @azure/identity ships it. So on vsce
// 3.9.2 the flag can reach Entra only through an `az login` (there is no az
// CLI here, and putting one on the runner image is work in another
// repository) or through a long-lived client secret (a stored credential
// that expires, which is the property that disqualified the Azure DevOps
// PAT this replaced). The exchange below is the same OIDC federation the
// flag cannot reach, done directly.
//
// It is safe to hand the result to vsce because vsce does not care where
// the token came from: out/publish.js's getPAT() returns options.pat when
// -p or VSCE_PAT is given and the Entra access token when --azure-credential
// is, into the same variable, used the same way.
//
// WHEN VSCE IS NEXT BUMPED, re-read TWO files and check THREE things.
//
// out/auth.js, for whether WorkloadIdentityCredential has joined the chain.
// If it has, delete this file and use --azure-credential with
// AZURE_FEDERATED_TOKEN_FILE instead.
//
// out/auth.js again, for whether the scope it requests is still
// 499b84ac-1321-427f-aa17-267ca6975798/.default. MARKETPLACE_SCOPE below is
// a copy of that value, so a change there would otherwise first surface as
// a failed release.
//
// out/publish.js's getPAT(), for whether -p (and so VSCE_PAT) still accepts
// an Entra access token. That seam is the more fragile of the two: a
// release could split the auth handler so the flag sends a bearer token and
// -p sends a PAT, which would leave the flag surface identical and this
// file broken with no signal from auth.js at all.
//
// Reading both is the check; release notes are not.
//
// Usage: node tools/marketplace-token.mjs
// Requires node 18 or newer for global fetch; the container this runs in is
// pinned to node 22 by tools/publish-marketplace.sh.

// The Marketplace's own resource id. Copied from the scope auth.js requests
// rather than taken from documentation, which makes it right today but does
// not keep it right: nothing re-reads auth.js at runtime. The bump
// checklist above is what keeps it honest.
const MARKETPLACE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

// The audience Entra requires on a GitHub OIDC token presented as a client
// assertion. It must match the audience configured on the federated
// credential; see RELEASE-SETUP.md.
const EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange';

function required(name) {
  const value = process.env[name];
  if (!value) {
    // Named individually rather than as "check the environment", because
    // the four come from three different places: two from the release
    // environment's variables, two from GitHub's OIDC plumbing, which is
    // absent unless the job declares `permissions: id-token: write`.
    throw new Error(`${name} is not set`);
  }
  return value;
}

// Both calls time out rather than hanging. The publish job has a
// 15-minute budget and a stalled connection to login.microsoftonline.com
// would spend all of it before failing, which is a worse diagnostic than a
// refused connection.
const TIMEOUT_MS = 30_000;

// Errors from either endpoint are reported by status and body. Neither body
// carries the assertion or the access token -- Entra returns an error code
// and a correlation id -- and the caller masks the token in the Actions log
// with ::add-mask:: before anything else runs, so a body that surprises us
// is safe to print.
async function postForm(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${body}`);
  }
  // Parsed inside a guard: a 200 carrying something that is not JSON -- a
  // captive portal, an outage page -- would otherwise surface as a bare
  // "Unexpected token" with the body discarded, losing the one diagnostic
  // the rest of this function works to preserve.
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `${url} returned ${response.status} with a non-JSON body: ${body.slice(0, 200)}`,
    );
  }
}

async function githubIdToken() {
  // ACTIONS_ID_TOKEN_REQUEST_URL already carries a query string, so the
  // audience is appended with & rather than ?.
  const requestUrl = required('ACTIONS_ID_TOKEN_REQUEST_URL');
  const url = `${requestUrl}&audience=${encodeURIComponent(EXCHANGE_AUDIENCE)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`the GitHub OIDC endpoint returned ${response.status}: ${body}`);
  }
  // Guarded the same way postForm is, and for the same reason: a 200
  // carrying something that is not JSON would otherwise surface as a bare
  // parser error with the body discarded.
  let value;
  try {
    ({ value } = JSON.parse(body));
  } catch {
    throw new Error(`the GitHub OIDC endpoint returned a non-JSON body: ${body.slice(0, 200)}`);
  }
  if (!value) {
    throw new Error('the GitHub OIDC endpoint returned no token');
  }
  return value;
}

async function main() {
  const tenant = required('AZURE_TENANT_ID');
  const assertion = await githubIdToken();
  const token = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    client_id: required('AZURE_CLIENT_ID'),
    scope: MARKETPLACE_SCOPE,
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });
  if (!token.access_token) {
    throw new Error('Entra returned no access_token');
  }
  // No trailing newline handling beyond this: the caller captures stdout
  // through $(...), which strips it, and then masks the result.
  process.stdout.write(token.access_token);
}

main().catch((error) => {
  // error.cause carries the useful half of a fetch failure -- "fetch
  // failed" alone does not distinguish DNS from TLS from a refused
  // connection, and this runs where nobody can attach a debugger.
  const cause = error.cause ? ` (${error.cause})` : '';
  console.error(`marketplace-token: ${error.message}${cause}`);
  // exitCode rather than exit(): process.exit can truncate a pending write
  // to stderr, losing the message this line exists to print.
  process.exitCode = 1;
});
