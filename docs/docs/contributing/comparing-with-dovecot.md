---
title: Comparing with Dovecot
sidebar_position: 2
description: Replay the same IMAP commands against ImapKit and a real Dovecot server and see where the responses differ.
---

# Comparing with Dovecot

`compare/` holds a development aid, not a test suite. It replays the same IMAP commands against ImapKit and a real Dovecot 2.4 server and shows where the responses differ. Use it when building or fixing a feature, to see what RFC compliant input and output look like in practice.

Dovecot is the most spec compliant server around, but it has its own bugs, quirks and extensions. Treat a difference as a hint to check the RFC (from `https://www.rfc-editor.org/rfc/rfcNNNN.txt`), not as proof that ImapKit is wrong, and do not copy Dovecot behavior that the RFC does not require. ImapKit is [strict by design](../guides/strict-by-design.md), so it refuses input Dovecot accepts in many places.

## Starting Dovecot

The tool needs Docker. Dovecot runs as a long-running container named `imapkit-dovecot` (image `dovecot/dovecot:2.4.4`) with plain IMAP on `127.0.0.1:32143`:

```bash
npm run dovecot:start
npm run dovecot:stop
bash compare/dovecot.sh status    # also: restart, logs
```

`compare/dovecot.conf` is mounted as a drop-in. It allows cleartext login, turns off FTS so SEARCH is plain substring matching, stops auto-creating special-use mailboxes, and turns on QUOTA (count driver, 10M and 1000 messages), APPENDLIMIT (5M), ACL (vfile) and METADATA for comparison.

| Variable                   | What it changes                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `IMAPKIT_DOVECOT_IMAGE`    | the image to run                                                                       |
| `IMAPKIT_DOVECOT_PLATFORM` | the platform, e.g. `linux/amd64`. Forcing `linux/amd64` on Apple Silicon does not work |
| `IMAPKIT_DOVECOT_PORT`     | the host port, read by both `dovecot.sh` and the compare tool (default `32143`)        |
| `IMAPKIT_DOVECOT_HOST`     | the host the compare tool connects to (default `127.0.0.1`)                            |

## Running a comparison

```bash
npm run compare -- compare/scenarios/fetch.txt
node --import tsx compare/compare.ts -c 'SELECT INBOX' -c 'FETCH 1 BODYSTRUCTURE'
node --import tsx compare/compare.ts --plugin IDLE,MOVE compare/scenarios/basic.txt
```

Every run starts an in-process ImapKit on a random port, and logs into Dovecot as a brand-new user (static passdb, password `pass`), so runs never see each other's mail. The new user is seeded from the same storage JSON through a hidden setup connection: CREATE, SUBSCRIBE, and APPEND with flags and internal date. Only personal namespaces with `/` as separator are seeded and `\Recent` is dropped. A warning is shown when Dovecot assigns other UIDs than the storage specifies.

For each step the output shows `= same` (with the ImapKit output dimmed), or both outputs one after the other. The last line counts the steps that differ (or says that all steps match). The exit code is 0 even when steps differ, it is 1 only when the run fails (for example when Dovecot is not reachable).

### Options

| Option                  | What it does                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c`, `--command <cmd>` | A command to run, repeatable, instead of a scenario file.                                                                                                                     |
| `--storage <file>`      | The ImapKit storage JSON, also seeded into Dovecot. Default `compare/storage.json`.                                                                                           |
| `--plugin <names>`      | ImapKit plugins, comma separated, repeatable.                                                                                                                                 |
| `--target <name>`       | `both` (default), `imapkit` or `dovecot`. `--target imapkit` needs no Docker.                                                                                                 |
| `--manual-login`        | Do not log in automatically, the scenario logs in with `$USER` and `$PASS`.                                                                                                   |
| `--keep-text`           | Also compare the human readable text of OK, NO, BAD and BYE responses and `+` continuations.                                                                                  |
| `--exact`               | Do not sort LIST responses and flag lists, and do not unquote mailbox names, before comparing.                                                                                |
| `--timeout <ms>`        | How long to wait for a tagged response. Default 3000.                                                                                                                         |
| `--settle <ms>`         | How long to wait after each step for extra output. Default 100.                                                                                                               |
| `-v`, `--verbose`       | Also show greetings, login and seeding notes.                                                                                                                                 |
| `--json`                | Machine readable results: the warnings per target, and for every step the line, session, what was sent, whether both sides matched (`same`) and the responses of each target. |

`node --import tsx compare/compare.ts --help` prints the same list.

## Scenario files

Scenario files in `compare/scenarios/*.txt` hold one step per line:

| Line              | What it does                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SELECT INBOX`    | A command, sent with an automatic tag (`A1`, `A2`, ...).                                                                                 |
| `2: SELECT INBOX` | A command on session 2. Sessions open and log in on first use, the default is session 1.                                                 |
| `> DONE`          | Sent verbatim with no tag (also `2:> DONE`). Waits for the tagged response of the command a continuation left open (IDLE, AUTHENTICATE). |
| `!wait 500`       | Pauses, then collects whatever the sessions received.                                                                                    |
| `# comment`       | Ignored, as are blank lines.                                                                                                             |

Inside commands and verbatim lines:

- the four characters `\r\n` become CRLF
- `{file:path}` and `{file+:path}` become a synchronizing or non-synchronizing literal with the contents of the file, line endings converted to CRLF. The path is relative to the scenario file, sample messages are in `compare/messages/`
- `~{file:path}` and `~{file+:path}` become a literal8 ([RFC 3516](https://www.rfc-editor.org/rfc/rfc3516)) with the file's octets as they are, binary samples are in `compare/messages/literal8/`
- `$USER` and `$PASS` expand to the credentials of each server, for `--manual-login`
- `$UIDVALIDITY` expands to the last UIDVALIDITY the server sent, for `SELECT INBOX (QRESYNC ($UIDVALIDITY 1))`

Synchronizing literals wait for the `+` continuation. After a tagged OK to `COMPRESS DEFLATE` a session compresses, and its output is compared decompressed (`compare/scenarios/compress.txt`).

A scenario saved in `compare/scenarios/`, run with `--plugin IDLE`:

```text title="compare/scenarios/my-idle.txt"
# a second session adds a message while the first one idles
SELECT INBOX
IDLE
2: APPEND INBOX {file:../messages/simple.eml}
!wait 1000
> DONE
```

Some scenarios need their own storage or plugins, the comment at the top of the file says how to run them. For example `compare/scenarios/sort-thread.txt` runs against `compare/storage-sort-thread.json`:

```bash
npm run compare -- --storage compare/storage-sort-thread.json \
    --plugin SORT,SORT=DISPLAY,THREAD=REFERENCES,THREAD=ORDEREDSUBJECT \
    compare/scenarios/sort-thread.txt
```

## Normalization

Both outputs are normalized before they are compared, so only meaningful differences show:

- Dovecot's `(0.001 + 0.000 secs)` timings are removed
- the human readable text of OK, NO, BAD and BYE responses and of `+` continuations is dropped, unless `--keep-text` is set
- UIDVALIDITY values are masked, also inside COPYUID and APPENDUID
- LIST and LSUB responses and flag lists are sorted, and quoted mailbox names that are valid atoms are unquoted, unless `--exact` is set

## Known differences

Many differences are expected and are not ImapKit bugs. The main groups:

- **Capabilities and extensions.** Dovecot advertises many more extensions, and some (IMAP4rev2, CONDSTORE) change its output once enabled. Dovecot does not support OBJECTID, PARTIAL or MULTISEARCH. Dovecot advertises COMPRESS=DEFLATE only after login.
- **Values that differ by design.** Lowercase BODYSTRUCTURE strings, INTERNALDATE in UTC, its own mod-sequences, UIDs when seeding, `\Recent` for the first session that selects a seeded mailbox, and quota limits from its own config.
- **Timing.** IDLE and NOTIFY notifications can arrive late in Dovecot, so put a `!wait 1000` after the step that triggers them.
- **Places where Dovecot is lenient.** Dovecot accepts input that ImapKit refuses with `BAD` or `NO` because the RFC grammar or a MUST forbids it: for example relative CATENATE URLs, `REVERSE REVERSE` in SORT, items RFC 9051 removed after `ENABLE IMAP4rev2`, and 8-bit headers in APPEND before `ENABLE UTF8=ACCEPT`.
- **Places where Dovecot differs from an RFC.** For example `* OK [CLOSED]` on every mailbox switch, SEARCH answered without ESEARCH after `ENABLE IMAP4rev2`, missing UID in unsolicited NOTIFY flag updates, and `NO` instead of `BAD` for a second COMPRESS.

The full list, with the RFC sections behind each difference, is in the "Comparing with Dovecot" section of [CLAUDE.md](https://github.com/postalsys/imapkit/blob/master/CLAUDE.md). Add to it when you find a new difference that is not an ImapKit bug.

## Tests of the tool

`test/compare.test.ts` covers the tool's scenario parsing, normalizing and seeding against ImapKit only, so `npm test` stays Docker-free.
