# FloeBrowser repository guide

## Product contract

FloeBrowser projects DOM from source Chromium. Website execution, credentials,
network requests and business effects stay at the source. Do not introduce a
screen-streaming fallback or execute website JavaScript in the viewer.

The source page is authoritative. The embedding host owns browser/profile
lifecycle, authentication, site grants and target-control leases. Keep one active
controller and one serialized input path per projection. Never replay input after
an uncertain result, reconnect, navigation or takeover.

Static resources come only from observed source-browser responses. Audio/video
may additionally come from capture of individual source media elements through
a controller-authorized WebRTC connection; only media state and SDP signaling
use the DOM/control carrier. Never enqueue encoded media ahead of user input, or
capture a display, tab, camera or microphone. Media must stop on controller
revocation; signaling uses current view epochs and stream identities. Preserve
media connections across DOM-only checkpoints. The host owns ICE/TURN policy
and credentials; do not add an implicit public relay. Do not add a host
HTTP fetch fallback, expose cookies, or publish a raw CDP endpoint. Preserve the
scriptless replay sandbox and same-origin resource policy. Unsupported surfaces
must remain explicit. Do not enable rrweb's unsafe canvas replay option.

Design for a professional product: preserve selection, IME, clear loading and
disconnect states, keyboard use, accessibility labels and obvious recovery.

## Implementation

- Use released dependencies. Do not wire sibling repositories into builds.
- Keep reusable engine behavior here and product business adapters in consumers.
- Maintain public exports, source/viewer protocol compatibility and README claims
  together. Both sides must consume the same release.
- Keep DOM, credentials and input out of debug logs and persistent recordings.
- Prefer one coherent ownership model over compatibility layers or fallback paths.
- Use English for code, comments, documentation and Conventional Commit messages.
- Primary agents own implementation and testing. Do not delegate routine work.

## Git and delivery

- Develop in one dedicated feature worktree and branch, never directly on main.
- Do not create backup branches or alter another task's worktrees or stashes.
- Preserve intentional commits and integrate with a fast-forward.
- Do not push branches, create pull requests, publish packages or tag releases
  unless the user requests that delivery path.
- Before integration, run formatting, types, unit tests, the build and real-browser
  tests. Check the packed artifact when changing exports, assets or packaging.
- Keep ordinary CI source-only. Browser installation and E2E belong to explicit
  qualification runs rather than every push.

## Local checks

Node.js 26 is the baseline. Use the lockfile with npm ci.

```sh
npm run check
npm run format:check
npm test
npm run build
npm run test:e2e
```

Use PLAYWRIGHT_SKIP_BROWSER_GC=1 when installing test browsers so this task does
not remove browser caches used by other projects. Test only task-owned browser
processes and temporary contexts. Fix a failure with its smallest corresponding
check before rerunning the affected suite.
