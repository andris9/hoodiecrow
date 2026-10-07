# Changelog

## [3.1.0](https://github.com/postalsys/hoodiecrow-imap/compare/v3.0.1...v3.1.0) (2026-10-07)


### Features

* support X-GM-THRID in the X-GM-EXT-1 plugin ([9724455](https://github.com/postalsys/hoodiecrow-imap/commit/9724455aa6aab12aa557fc372f26fee86bee76bb))


### Bug Fixes

* add FETCH RFC822.TEXT and stop RFC822.HEADER from setting \Seen ([14b3fa7](https://github.com/postalsys/hoodiecrow-imap/commit/14b3fa7feec101cbd7310093d529e6ff68b8f853))
* add text to status responses that only carry a response code ([7244dbb](https://github.com/postalsys/hoodiecrow-imap/commit/7244dbb84bba0b0df8282e413689bcc2ddd904e9))
* address the 2026-10-06 hoodiecrow and imap-handler review ([d0e89e2](https://github.com/postalsys/hoodiecrow-imap/commit/d0e89e28c906819754131e07641fa5b053d82341))
* advertise X-GM-EXT-1 and support .SILENT label stores ([620b52d](https://github.com/postalsys/hoodiecrow-imap/commit/620b52dfaa61bc08a8d4b866184118d20c58ebbb))
* check SEARCH strings against the declared CHARSET ([83f2180](https://github.com/postalsys/hoodiecrow-imap/commit/83f2180e9213beec6b56a742f3f35eb399ce4f10))
* enforce command states, CRLF and argument rules centrally ([98cf212](https://github.com/postalsys/hoodiecrow-imap/commit/98cf21200ce8174f01eb0fda400872dab86748f3))
* enforce the client rules of ID and ENABLE ([77b558c](https://github.com/postalsys/hoodiecrow-imap/commit/77b558c402280f03b31a2d49c6e3e55e3bc930f0))
* harden AUTHENTICATE PLAIN, XOAUTH2 and LOGIN ([5f5f901](https://github.com/postalsys/hoodiecrow-imap/commit/5f5f901b2ad1d904b2e56981d9b74270caee3737))
* harden the server core and mailbox commands ([a3d9e9a](https://github.com/postalsys/hoodiecrow-imap/commit/a3d9e9ad98bfccd03c6346299859a9fd8204fb33))
* ID client keys and NAMESPACE INBOX handling ([b1f32fb](https://github.com/postalsys/hoodiecrow-imap/commit/b1f32fba1a4d61c3bdb9f1252c4c86737cde6323))
* make ENABLE and CONDSTORE follow RFC 5161 and RFC 7162 ([1aa025c](https://github.com/postalsys/hoodiecrow-imap/commit/1aa025c7d62dda049dc4ccc30bab0ee7bbf0429f))
* MOVE checks the target mailbox and read-only state ([b01c821](https://github.com/postalsys/hoodiecrow-imap/commit/b01c821c9b3629e02b3db6cae2ede50bdd2a9d1f))
* never echo invalid tags or 8-bit octets in responses ([9c28a19](https://github.com/postalsys/hoodiecrow-imap/commit/9c28a195606652de2c1957e99b10ea786ad64a9f))
* no blank line in BODY[HEADER] of a message without body and blank line ([e4a1234](https://github.com/postalsys/hoodiecrow-imap/commit/e4a1234163431a7f2012797ba42a3151f5c48f8f))
* no SP between multipart bodies and between ENVELOPE addresses ([de221b0](https://github.com/postalsys/hoodiecrow-imap/commit/de221b053a9c8088cea894fbaefe1cf8d8ab6aef))
* notify other sessions of flag changes, include UID per RFC 7162 ([2ac1feb](https://github.com/postalsys/hoodiecrow-imap/commit/2ac1feb408119781e2bff46e9bc7ce0454c1c186))
* port WildDuck MIME parser for FETCH, ENVELOPE and BODYSTRUCTURE ([6e4b8eb](https://github.com/postalsys/hoodiecrow-imap/commit/6e4b8ebfd621f5cd35b11c99437d01fade57c0b2))
* refuse ambiguous pipelined commands (RFC 3501 section 5.5) ([78bac0d](https://github.com/postalsys/hoodiecrow-imap/commit/78bac0d1fea9458eb83e8f9ca2aebf9255bfc9b9))
* refuse literal data sent before the continuation request ([6a2ec6a](https://github.com/postalsys/hoodiecrow-imap/commit/6a2ec6a02f98f348219141fa5b8da4cde0b18a11))
* refuse STORE in a mailbox opened with EXAMINE ([57e8098](https://github.com/postalsys/hoodiecrow-imap/commit/57e8098c6804db13b5a6d165164cf9d84c43c77d))
* refuse STORE of flag keywords that are not atoms ([f0354ed](https://github.com/postalsys/hoodiecrow-imap/commit/f0354ed7f84ff6a9852638811ed3d5a398bbee30))
* require login for XTOYBIRD and stop USERADD prototype pollution ([2657db5](https://github.com/postalsys/hoodiecrow-imap/commit/2657db5a408b2f004b42ddbaefae8cb8de794ccf))
* rewrite SEARCH query parsing and matching per RFC 3501 ([b6e82cb](https://github.com/postalsys/hoodiecrow-imap/commit/b6e82cb7eaa46cbf6d54453d8de9c8a3518bd116))
* send RFC 5530 response codes for failed mailbox operations ([a22c19c](https://github.com/postalsys/hoodiecrow-imap/commit/a22c19c7117ee859eb3a7aa8fe1b033951326caf))
* share FETCH, STORE and SEARCH logic with their UID variants ([4dd1530](https://github.com/postalsys/hoodiecrow-imap/commit/4dd1530d449e8326072b67bea3fc1c546ca8fac2))
* SPECIAL-USE attributes are added to LIST attributes ([bcb03e8](https://github.com/postalsys/hoodiecrow-imap/commit/bcb03e8f05948f0c0780786052b1b77240b19801))
* stop pushing notifications after IDLE ends ([d524bfd](https://github.com/postalsys/hoodiecrow-imap/commit/d524bfdd1957991326656a752dc4322f69a05773))
* strict RFC guardrails and standards compliance test suite ([885e4de](https://github.com/postalsys/hoodiecrow-imap/commit/885e4de6f797b998574257061976be5774422273))
* UID EXPUNGE only removes messages with the \Deleted flag ([7f66a2c](https://github.com/postalsys/hoodiecrow-imap/commit/7f66a2ca5bb65b0c9009fe00aae033a952743ce2))
* update imap-handler to 1.0.1 ([005690a](https://github.com/postalsys/hoodiecrow-imap/commit/005690a23ac9db05eb6dc2868f223cca30f08609))
* update imap-handler to 1.1.0 ([f54ec34](https://github.com/postalsys/hoodiecrow-imap/commit/f54ec3493a2c9414e5c0ca582370f869e212bfc1))
* use per-session \Recent in SEARCH and FETCH, share the session snapshot lookup ([eb3f001](https://github.com/postalsys/hoodiecrow-imap/commit/eb3f0015593e243f4d8e9e6e2ad57fc404aa6df0))
* validate and dedupe plugin names at boot ([e8b6b34](https://github.com/postalsys/hoodiecrow-imap/commit/e8b6b349fc9ea564b035523bc50af20c85c234e8))
* validate APPEND flags, NO for unknown SASL mechanisms, help text ([26b4bf4](https://github.com/postalsys/hoodiecrow-imap/commit/26b4bf4430e110fa8b76897e8a894b7513264b16))
* XTOYBIRD only echoes plain user names in response text ([68622e8](https://github.com/postalsys/hoodiecrow-imap/commit/68622e83256a4eb5a5bb4949357c55cf91b47d46))

## [3.0.1](https://github.com/postalsys/hoodiecrow-imap/compare/v3.0.0...v3.0.1) (2026-10-06)


### Bug Fixes

* update imap-handler to 1.0.0 ([c105e1e](https://github.com/postalsys/hoodiecrow-imap/commit/c105e1e97df24baef90db946d979bf1e04f78779))

## [3.0.0](https://github.com/postalsys/hoodiecrow-imap/compare/v2.1.0...v3.0.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* Node.js 20 or newer is required. The CLI entry point moved to bin/hoodiecrow.js and the test suite moved from tests/ to test/.

### Features

* modernize for Node.js 20+ ([a4eabde](https://github.com/postalsys/hoodiecrow-imap/commit/a4eabdefa39791262de8161b767ccf3c9959a774))
