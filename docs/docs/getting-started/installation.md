---
sidebar_position: 1
title: Installation
---

# Installation

ImapKit needs Node.js 20 or newer. It also runs on the latest [Bun](https://bun.sh/) and [Deno](https://deno.com/) releases (`npm:imapkit` in Deno).

## As a library

```bash
npm install --save-dev imapkit
```

The package ships ES modules and CommonJS, each with type declarations:

```javascript
import imapkit from 'imapkit';
// or with CommonJS: const imapkit = require('imapkit');
```

## As a standalone server

```bash
npm install -g imapkit
imapkit -p 1143
```

Point your IMAP client to `localhost:1143` and log in with user name `testuser` and password `testpass`. Run `imapkit --help` to see all options.

## Optional SMTP listener

The SMTP listener (`--smtpPort`, or the `smtp` option) appends every message it receives to INBOX. It needs the [smtp-server](https://www.npmjs.com/package/smtp-server) package, which is not installed with ImapKit:

```bash
npm install smtp-server
```
