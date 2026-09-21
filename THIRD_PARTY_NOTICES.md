# Third-party notices

FloeBrowser is distributed under the MIT License. Third-party projects retain
their own licenses and attribution. Chromium is acquired separately through
Playwright and is not included in the npm package.

| Component                                                                              | Use                                             | License      | Upstream                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| rrweb, rrweb-snapshot, rrdom, @rrweb/record, @rrweb/replay, @rrweb/types, @rrweb/utils | DOM capture and reconstruction                  | MIT          | https://github.com/rrweb-io/rrweb                                                       |
| Playwright / playwright-core                                                           | Chromium and CDP adapter                        | Apache-2.0   | https://github.com/microsoft/playwright                                                 |
| PostCSS / postcss-value-parser                                                         | CSS resource rewriting                          | MIT          | https://github.com/postcss/postcss                                                      |
| postcss-safe-parser                                                                    | Tolerant stylesheet parsing                     | MIT          | https://github.com/postcss/postcss-safe-parser                                          |
| postcss-selector-parser                                                                | Inert link selector rewriting                   | MIT          | https://github.com/postcss/postcss-selector-parser                                      |
| cssesc / util-deprecate                                                                | CSS selector parser dependencies                | MIT          | https://github.com/mathiasbynens/cssesc / https://github.com/TooTallNate/util-deprecate |
| ws                                                                                     | Optional loopback WebSocket carrier             | MIT          | https://github.com/websockets/ws                                                        |
| Zod                                                                                    | Control message validation                      | MIT          | https://github.com/colinhacks/zod                                                       |
| @xstate/fsm                                                                            | rrweb replay state machine                      | MIT          | https://github.com/statelyai/xstate                                                     |
| mitt                                                                                   | rrweb event emitter                             | MIT          | https://github.com/developit/mitt                                                       |
| @types/css-font-loading-module                                                         | Font loading type definitions                   | MIT          | https://github.com/DefinitelyTyped/DefinitelyTyped                                      |
| base64-arraybuffer                                                                     | rrweb binary conversion                         | MIT          | https://github.com/niklasvh/base64-arraybuffer                                          |
| fflate                                                                                 | rrweb compression support                       | MIT          | https://github.com/101arrowz/fflate                                                     |
| nanoid                                                                                 | PostCSS dependency                              | MIT          | https://github.com/ai/nanoid                                                            |
| picocolors                                                                             | PostCSS dependency                              | ISC          | https://github.com/alexeyraspopov/picocolors                                            |
| source-map-js                                                                          | PostCSS dependency                              | BSD-3-Clause | https://github.com/7rulnik/source-map-js                                                |
| Inter, via @fontsource/inter                                                           | Development fixture and preview screenshot only | OFL-1.1      | https://github.com/rsms/inter                                                           |

The packaged source media helper additionally links Pion WebRTC and its Go
protocol dependencies (MIT), mediacommon (MIT), google/uuid (BSD-3-Clause),
wlynxg/anet (MIT), golang.org/x modules (BSD-3-Clause), and the Go runtime
(BSD-3-Clause). Exact compiled module versions and their original license texts
are included in `dist/THIRD_PARTY_LICENSES.txt` at build time. Pion's transitive
STUN/TURN libraries do not enable external ICE servers in this product.

rrweb copyright: Copyright (c) 2018 Contributors
(https://github.com/rrweb-io/rrweb/graphs/contributors).

Playwright copyright: Copyright (c) Microsoft Corporation. Licensed under the
Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0.

Builds retain dependency legal comments and include original available license
and notice files in `dist/THIRD_PARTY_LICENSES.txt`. Installed npm dependencies carry their
license files where supplied by their maintainers. Development tooling is not
included in the shipped browser bundle.

The development-only Flowersec transport qualification uses the MIT-licensed
`@floegence/flowersec-core` 5.2.3 and
`github.com/floegence/flowersec/flowersec-go/v5` v5.2.2 from
https://github.com/floegence/flowersec. They are not runtime dependencies or
included in the FloeBrowser media helper.

## MIT license (rrweb and MIT components)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
