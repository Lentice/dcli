// Deliberately narrow lint gate.
//
// This exists for exactly one class of defect: code that is syntactically valid
// but references a name that does not exist at runtime. A `const` declared
// inside a try block and used after it (see the a1bf61f regression, where every
// codex job died on `ReferenceError: child is not defined`) is invisible to
// `node --check`, invisible to the test suite when the path is mocked out, and
// caught by `no-undef` in under a second.
//
// Keep this config narrow and keep it green. A wide, permanently-red lint gate
// is decoration — nobody reads it, so it stops catching anything. Full
// `tsc --checkJs` on this codebase reports 20+ implicit-any errors in a single
// adapter file; that signal-to-noise ratio is why it is not used here.
//
// Adding a rule is a real decision: it must be green across the whole repo in
// the same commit that introduces it.

const { defineConfig } = require('eslint/config');
const globals = require('globals');

module.exports = defineConfig([
  {
    // Global ignores: this object intentionally has no other keys, so the
    // patterns are inherited by every config object below.
    ignores: [
      'node_modules/',
      'native/windows-job-helper/bin/',
      'native/windows-job-helper/obj/',
      // Generated + installed copies; the checked-in source of truth is linted.
      '.dcli-state/',
      '.live-smoke-state-*/',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      // Injects require/module/exports/__dirname on top of the Node globals.
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      // A stale disable comment is a rule that silently stopped applying.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // The rule this file exists for.
      'no-undef': 'error',

      // NOT YET ENABLED -- 91 existing violations, and they are not all noise.
      // Roughly a dozen are unasserted variables in tests (a value computed and
      // then never checked, e.g. `allOk`/`anyFailed` in core/doctor.test.js) --
      // the same false-green class this gate exists to catch, so they need
      // reading one at a time, not a blind delete. The rest are dead requires.
      // Enable in the commit that clears them; do not enable it red.
      //   npx eslint . --rule '{"no-unused-vars":["error",{"args":"none"}]}'
      'no-unused-vars': 'off',

      // Code after a return/throw. Always a mistake, never a style choice.
      'no-unreachable': 'error',

      // NOT ENABLED -- 16 false positives, all in cli/dcli.js, where every
      // `case` ends in `process.exit(...)`. ESLint cannot know that terminates
      // and offers no option to teach it; the only escape is 16 marker
      // comments. Not worth it.
      'no-fallthrough': 'off',

      // Assigning to a const, or to a function declaration's name.
      'no-const-assign': 'error',
      'no-func-assign': 'error',

      // Duplicate object keys / class members: the second silently wins, which
      // matters for the argv builders and the status.json field maps.
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-args': 'error',

      // `await` / `return` inside a loop condition typo, and comparing against
      // NaN -- both produce silently-always-false conditions.
      'use-isnan': 'error',
    },
  },
]);
