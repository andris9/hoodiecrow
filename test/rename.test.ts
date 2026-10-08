import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('Rename', () => {
    const ctx = setupServer(() => ({
        storage: {
            '': {
                folders: {
                    level1: {
                        folders: {
                            level2: {
                                folders: {
                                    level3: {
                                        folders: {
                                            level4: {
                                                folders: {}
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    level5: {
                        folders: {
                            level6: {
                                folders: {}
                            }
                        }
                    }
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.'
            },
            '#juke?': {
                type: 'shared',
                separator: '?'
            }
        }
    }));

    it('Rename success', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 RENAME level1/level2 level5/level2', 'A4 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "level1"\r\n') >= 0);
            assert.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "level5/level2/level3/level4"\r\n') >= 0);
            done();
        });
    });
});

describe('Rename message processing', () => {
    let processed = 0;
    const ctx = setupServer(() => ({
        plugins: [
            server => {
                server.messageHandlers.push(() => processed++);
            }
        ],
        storage: {
            INBOX: {},
            '': {
                folders: {
                    source: {
                        messages: ['Subject: hello\r\n\r\nWorld']
                    }
                }
            }
        }
    }));

    it('RENAME does not run message handlers again', (t, done) => {
        const before = processed;
        const cmds = ['A1 LOGIN testuser testpass', 'A2 RENAME source target', 'A3 SELECT target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0, resp);
            assert.ok(resp.indexOf('\r\n* 1 EXISTS\r\n') >= 0, resp);
            assert.strictEqual(ctx.server.getMailbox('target')!.path, 'target');
            assert.strictEqual(processed, before);
            done();
        });
    });
});
