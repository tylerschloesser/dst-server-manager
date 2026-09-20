# Spike: CloudFront OAC in front of a Lambda Function URL (AWS_IAM)

**Date:** 2026-09-19
**Account / region:** `063257577013` / `us-east-1` (profile `admin`)
**Stack:** `dst-spike-oac` (throwaway, deployed and destroyed — see [Ledger](#resource-ledger--teardown-proof))
**CDK:** `aws-cdk-lib` 2.270.0, Node 22, bootstrap v30 (used as-is, not re-bootstrapped)

## Verdict

**Keep the planned design: one CloudFront distribution, `/api/*` → Lambda Function URL with
`AuthType: AWS_IAM` behind an OAC of type `lambda` (`SigningBehavior: always`, `SigningProtocol: sigv4`).**
It works cleanly. Do **not** fall back to `AuthType: NONE` + secret header.

Three things must be true, and all three are cheap:

1. The Lambda resource policy needs **both** `lambda:InvokeFunctionUrl` **and** `lambda:InvokeFunction`
   for `cloudfront.amazonaws.com`. CDK 2.270's `FunctionUrlOrigin.withOriginAccessControl()` only grants
   the first — you must add the second by hand or every request 403s.
2. Browser `POST`s **with a body** must send `x-amz-content-sha256: <hex sha256 of body bytes>`
   (~10-line `fetch` wrapper, below).
3. `POST`s with **no body need nothing at all** — CloudFront defaults to the empty-string hash, which
   matches. Path-encoded bodyless verbs (`POST /api/server/start`) sidestep the wrapper entirely.

The decisive argument over the fallback: with `AWS_IAM`, unauthorized requests are rejected by the
Lambda *service* and **never invoke (or bill) the function**. With `AuthType: NONE`, the function URL is
openly reachable, every scanner request runs your code and costs money before the secret check, and the
shared secret lives in plaintext in the CloudFront origin config with no rotation story.

---

## Test matrix (actual results through `https://drk7b34jr10su.cloudfront.net`)

| # | Test | Result |
|---|------|--------|
| a | GET `/api/echo?openid.mode=id_res&openid.sig=abc%2B%2F%3D&openid.return_to=https%3A%2F%2F…` | **200.** `rawQueryString` arrives **byte-for-byte identical**. No signature issue from `.`, `+`, `/`, `=`, `,` (encoded or not). Also verified with a full-length Steam-shaped callback on `/api/auth/steam/callback`. |
| b | POST JSON body, **no** `x-amz-content-sha256` | **403**, `x-amzn-errortype: InvalidSignatureException`, body: `{"message":"The request signature we calculated does not match the signature you provided. …"}` |
| c | POST JSON body **with** correct hex SHA-256 | **200.** Body delivered intact, `isBase64Encoded: false`. |
| d | POST **empty body, no header** | **200.** CloudFront defaults `x-amz-content-sha256` to the SHA-256 of the empty string and signs with it; the empty body matches. **No header needed for bodyless POSTs.** |
| d′ | POST empty body **with** `e3b0c442…b855` (sha256 of `""`) | **200.** Equivalent to the above. |
| d″ | POST (empty or non-empty) with `x-amz-content-sha256: UNSIGNED-PAYLOAD` | **403 InvalidSignatureException.** The literal `UNSIGNED-PAYLOAD` sentinel is **not** accepted — a real hex digest is mandatory. |
| e | POST with a wrong hash (valid hex, or garbage like `notahash`) | **403 InvalidSignatureException** in both cases. Fails closed. |
| f | `Set-Cookie` out / `Cookie` in | **Both work.** `set-cookie: __Host-spike=1; Path=/; Secure; HttpOnly; SameSite=Lax` reaches the viewer unmodified. Inbound `Cookie` reaches the Lambda both as `headers.cookie` and as the parsed `event.cookies` array. |
| g | Direct call to the function URL, no sigv4 | **403** `{"Message":"Forbidden"}` for GET and POST. Function is **not** invoked (no log entry, no billing). |
| h | Host / viewer IP | `headers.host` = the **origin** hostname (`…lambda-url.us-east-1.on.aws`) — OAC must rewrite it for sigv4. Real viewer IP is in `x-forwarded-for` and `cloudfront-viewer-address`. `requestContext.http.sourceIp` is **CloudFront's** IP (`52.46.63.x`) — **do not use it**. The original viewer host is **not** forwarded and there is no `x-forwarded-host`. |
| i | Latency | Warm through CloudFront: ~0.09–0.23 s (median ~0.21 s). Warm direct to a function URL from the same client: ~0.20–0.21 s. **CloudFront adds ≈0 ms** (the extra hop is offset by CloudFront's warm keep-alive to the origin). Cold start: 0.53 s total, i.e. ~320 ms of Lambda init, unrelated to OAC. |

Extra checks run beyond the brief:

| Test | Result |
|------|--------|
| Custom origin header **alongside** OAC signing | **Works.** `customHeaders: { 'x-dst-viewer-host': 'dst.ty.ler.dev' }` on the OAC origin arrives intact on both GET and signed POST. CloudFront includes its injected headers in the signature. This is the fix for (h). |
| UTF-8 multibyte body (`"Głóg — ünïcode 😀"`, 53 bytes) with hash over **bytes** | **200**, body byte-exact, `isBase64Encoded: false`. Hash must be over UTF-8 **bytes**, not UTF-16 code units — `TextEncoder` + `crypto.subtle.digest` does the right thing. |
| Fallback origin (`AuthType: NONE` + `x-spike-secret` custom origin header) on `/fallback/*` | **200** with no client changes. Confirmed the fallback is viable — just not preferable. |

### Viewer headers that do reach the Lambda

With `AllViewerExceptHostHeader`, the Lambda sees `origin`, `referer`, `cookie`, `content-type`,
`user-agent`, `accept`, the full `cloudfront-viewer-*` set (`-address`, `-country`, `-city`, `-asn`,
`-latitude/-longitude`, `-postal-code`, `-time-zone`, `-tls`, `-http-version`, the
`cloudfront-is-*-viewer` flags), `x-forwarded-for/-port/-proto`, plus the sigv4 headers CloudFront adds:
`x-amz-content-sha256`, `x-amz-date`, `x-amz-security-token`, `x-amz-source-account`, `x-amz-source-arn`.

---

## The permission gap (the one real trap)

**Symptom.** Deploy exactly what CDK generates and *every* request 403s — including a plain GET with no
body — with:

```
x-amzn-errortype: AccessDeniedException
{"Message":"Forbidden. For troubleshooting Function URL authorization issues, see: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html"}
```

Note the error **types** differ and that is the diagnostic:

- `AccessDeniedException` → resource-policy / authorization problem (this bug).
- `InvalidSignatureException` → signature problem (a missing or wrong `x-amz-content-sha256`).

Signature is checked *before* authorization, which is why a bodyless GET surfaces the permission bug
while a POST without the hash masks it behind a signature error.

**Cause.** Since **October 2025** AWS requires "dual auth" on newly created function URLs: the caller
needs both `lambda:InvokeFunctionUrl` *and* `lambda:InvokeFunction`. Function URLs created before that
date still work with only `InvokeFunctionUrl` (Tyler's existing `CdkCoreSite` / `YahnSite`
distributions in this account use lambda OAC and are unaffected). CDK 2.270 knows about dual auth for
`AuthType: NONE` — it emits both actions there — but `FunctionUrlOrigin.withOriginAccessControl()` still
emits only `InvokeFunctionUrl` (aws-cdk issue #35872).

**Working policy** (verified with `aws lambda get-policy` after the fix):

```
lambda:InvokeFunctionUrl | {"Service":"cloudfront.amazonaws.com"} | ArnLike AWS:SourceArn arn:aws:cloudfront::063257577013:distribution/E31DACPYCMINNI
lambda:InvokeFunction    | {"Service":"cloudfront.amazonaws.com"} | ArnLike AWS:SourceArn arn:aws:cloudfront::063257577013:distribution/E31DACPYCMINNI
```

---

## Working CDK (copy this)

`aws-cdk-lib` 2.270.0. The `env` is explicit as required.

```ts
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';

const fn = new lambda.Function(this, 'Api', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
});

const fnUrl = fn.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.AWS_IAM,   // never NONE
});

// Emits AWS::CloudFront::OriginAccessControl with
//   OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always', SigningProtocol: 'sigv4'
// and wires OriginAccessControlId onto the origin. Custom headers are safe to add
// and are covered by the signature.
const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl, {
  customHeaders: { 'x-dst-viewer-host': 'dst.ty.ler.dev' },   // optional; see "viewer host" below
});

const apiBehavior: cloudfront.BehaviorOptions = {
  origin: apiOrigin,
  allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,                    // 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER, // b689b0a8-53d0-40ab-baf2-68738e2966ac
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
};

const dist = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin: s3Origin /* the SPA bucket, via OAC */ },
  additionalBehaviors: { '/api/*': apiBehavior },
});

// REQUIRED (AWS "dual auth", Oct 2025). withOriginAccessControl() does NOT add this.
// Without it every request returns 403 AccessDeniedException.
fn.addPermission('OacInvokeFunction', {
  principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
  action: 'lambda:InvokeFunction',
  sourceArn: dist.distributionArn,
});
```

`CachingDisabled` + `AllViewerExceptHostHeader` are **confirmed correct**, and
`AllViewerExceptHostHeader` is *mandatory*, not merely recommended: forwarding the viewer's `Host`
would contradict the host CloudFront signs with and break sigv4. Do not use `ALL_VIEWER`.

Response-side note: the Lambda returns cookies via the payload-2.0 `cookies: [...]` array (or a
`Set-Cookie` header); both reach the viewer untouched. Keep `Cache-Control: no-store` on API responses.

### Recovering the viewer host

`AllViewerExceptHostHeader` strips `Host` and nothing replaces it, so the Lambda cannot learn
`dst.ty.ler.dev` from the request. For building the Steam OpenID `return_to`/`realm`, either inject a
custom origin header as shown above (proven to work with OAC) or just put the domain in a Lambda
environment variable. The env var is simpler when the domain is fixed; the origin header is better if
you ever run a preview distribution off the same function.

---

## Browser fetch wrapper

`x-amz-content-sha256` is **not** a forbidden header name (forbidden names are `Host`, `Cookie`,
`Content-Length`, `Connection`, `Sec-*`, `Proxy-*`, …), so `fetch` may set it freely. The SPA and the
API are same-origin (`https://dst.ty.ler.dev`), so **no CORS and no preflight are involved** — the
header is simply sent. `crypto.subtle` requires a secure context, which HTTPS satisfies.

```js
export async function apiFetch(path, { method = 'GET', json } = {}) {
  const headers = new Headers();
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    headers.set('content-type', 'application/json');
    headers.set('x-amz-content-sha256',
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
  return fetch(path, { method, headers, body, credentials: 'same-origin' });
}
```

The digest must cover exactly the bytes on the wire. Passing the same `body` string to both
`TextEncoder` and `fetch` guarantees that (verified with a multibyte UTF-8 payload).

**Simplification available:** if start/stop become bodyless — `apiFetch('/api/server/start', { method: 'POST' })`
with the target in the path — the hash is never needed and the wrapper degrades to a plain `fetch`.
Given only two mutating endpoints, that is a legitimate way to avoid the whole issue. Keep the wrapper
anyway so adding a JSON body later doesn't silently 403.

## Why not the `AuthType: NONE` + secret-header fallback

It was deployed and does work (`/fallback/*` returned 200 with the secret header intact and no client
changes). Rejected because:

- **Billing/abuse surface.** `AuthType: NONE` means anyone who learns the `*.lambda-url.on.aws`
  hostname invokes your function directly; you pay for every scan and DoS attempt, and the secret check
  runs *inside* your code. With `AWS_IAM` the Lambda service 403s them for free (test g).
- **Secret management.** The value sits in plaintext in the distribution config and in the function's
  env, with rotation requiring a coordinated two-sided deploy.
- **The cost it avoids is small.** One ~10-line wrapper, or bodyless POSTs and nothing at all.

The one genuine downside of OAC+IAM is the **opaque failure**: forget the header and you get a bare 403
`InvalidSignatureException` with no hint that a payload hash was missing. But it fails *closed*, and
it's a deterministic build-time bug — it either always works or always fails for a given endpoint, so it
surfaces on the first manual test, never as a production flake. Write the `InvalidSignatureException` →
"missing `x-amz-content-sha256`" mapping into the project README and it costs one debugging session
once, ever.

---

## Resource ledger & teardown proof

Everything was created by CloudFormation stack `dst-spike-oac`
(`arn:aws:cloudformation:us-east-1:063257577013:stack/dst-spike-oac/a5456750-b492-11f1-8c0e-0ef6f923ea19`),
tagged `project=dst-server-manager` and `purpose=spike`. Nothing pre-existing was touched: no Route 53,
no ACM, no other distribution, no change to `CDKToolkit`.

| Resource | Physical ID | Deleted |
|---|---|---|
| `AWS::CloudFront::Distribution` | `E31DACPYCMINNI` (`drk7b34jr10su.cloudfront.net`) | yes |
| `AWS::CloudFront::OriginAccessControl` | `E1X80DV577OAAX` | yes |
| `AWS::Lambda::Function` | `dst-spike-oac-api` | yes |
| `AWS::Lambda::Url` (AWS_IAM) | `…:function:dst-spike-oac-api` | yes |
| `AWS::Lambda::Permission` ×2 (InvokeFunctionUrl, InvokeFunction) | `…DistOrigin1InvokeFrom…-ju8gSSa27Qzy`, `…ApiOacInvokeFunction…-jaEDMlKFJrb7` | yes |
| `AWS::IAM::Role` | `dst-spike-oac-ApiServiceRole1BD550DA-wD2U3WL32oKz` | yes |
| `AWS::Logs::LogGroup` | `/aws/lambda/dst-spike-oac-api` | yes |
| `AWS::Lambda::Function` (fallback) | `dst-spike-oac-open` | yes |
| `AWS::Lambda::Url` (NONE, fallback) | `…:function:dst-spike-oac-open` | yes |
| `AWS::Lambda::Permission` ×2 (fallback) | `…Openinvokefunction…-v9Dg80Fd9FqH`, `…Openinvokefunctionurl…-Edyj727tVzao` | yes |
| `AWS::IAM::Role` (fallback) | `dst-spike-oac-OpenServiceRoleEA36C539-119IJoo7FoFJ` | yes |
| `AWS::Logs::LogGroup` (fallback) | `/aws/lambda/dst-spike-oac-open` | yes |

**Proof of deletion** — `cdk destroy` exited 0 (`✅ dst-spike-oac: destroyed`), then verified by API:

```
$ aws cloudformation describe-stacks --stack-name dst-spike-oac --region us-east-1
  ValidationError: Stack with id dst-spike-oac does not exist
$ aws lambda list-functions --region us-east-1 \
    --query "Functions[?starts_with(FunctionName,'dst-spike')].FunctionName"
  []
$ aws lambda get-function-url-config --function-name dst-spike-oac-api  --region us-east-1
  ResourceNotFoundException: The resource you requested does not exist.
$ aws lambda get-function-url-config --function-name dst-spike-oac-open --region us-east-1
  ResourceNotFoundException: The resource you requested does not exist.
$ aws cloudfront get-distribution --id E31DACPYCMINNI
  NoSuchDistribution: The specified distribution does not exist.
$ aws cloudfront get-origin-access-control --id E1X80DV577OAAX
  NoSuchOriginAccessControl: The specified origin access control does not exist.
$ aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='dst-spike-oac'].Id"
  []
$ aws iam list-roles --query "Roles[?starts_with(RoleName,'dst-spike-oac')].RoleName"
  []
$ aws logs describe-log-groups --log-group-name-prefix /aws/lambda/dst-spike \
    --region us-east-1 --query 'logGroups[].logGroupName'
  []                       # log groups had RemovalPolicy.DESTROY; no manual cleanup needed
$ aws cloudformation list-stacks --region us-east-1 --query "…starts_with(StackName,'dst-spike')…"
  (empty)
$ curl https://drk7b34jr10su.cloudfront.net/api/echo
  curl: (6) Could not resolve host: drk7b34jr10su.cloudfront.net
```

**Deliberately not deleted (not created by this spike):** IAM role `dst-spike-instance`, an **EC2**
instance role tagged `project=dst-server-manager` / `purpose=spike`, created by a *sibling* spike
running in parallel. This spike created no EC2 resources; that role belongs to whoever ran the
game-server spike and is theirs to clean up.



**CDK assets.** The Lambda code zips were published to the shared bootstrap bucket
`cdk-hnb659fds-assets-063257577013-us-east-1` (asset hash `e7956f6a…`, template `059bd6d6…`). These are
a few KB, are garbage-collected by `cdk gc`, and are shared with other stacks' tooling, so they were
left in place rather than risk touching the toolkit bucket. Spike source lived entirely outside the
repo in a scratch directory.
