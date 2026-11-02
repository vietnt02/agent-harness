#!/usr/bin/env node
/**
 * Backward-compatible wrapper for worktree tests.
 *
 * Canonical test suite:
 *   .claude/skills/ak-worktree/scripts/worktree.test.cjs
 *
 * ak-worktree is a core skill the engineer kit inherits through
 * `extends: core` rather than duplicating in its own `skills/` tree, so the
 * sibling path below only exists once a kit install/composition step has
 * materialized `.claude/skills/ak-worktree/` next to this wrapper. Running
 * this file straight out of the repo (e.g. from a test runner that walks
 * `kits/**` source) has no such sibling, so fall back to the tracked core
 * source so the suite still runs pre-composition.
 */

const fs = require('fs');
const path = require('path');

const emittedPath = path.join(__dirname, '../skills/ak-worktree/scripts/worktree.test.cjs');
const sourcePath = path.join(__dirname, '../../core/skills/ak-worktree/scripts/worktree.test.cjs');

require(fs.existsSync(emittedPath) ? emittedPath : sourcePath);
