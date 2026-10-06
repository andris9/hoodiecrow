'use strict';

module.exports = {
    // Node 20 is the supported runtime floor (see "engines" in package.json). A dependency major that
    // needs a newer Node, or that is ESM-only (this package is CommonJS), has to be capped here with
    // `target` or `reject`.
    upgrade: true
};
