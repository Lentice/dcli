# Findings corpus — real-model-style fixtures

Each file is a synthetic fixture representing a real model output from one of
the three backends. Used by tests to assert parser stability.

## Files

| File | Backend | Description | Expected status |
|---|---|---|---|
| clean-opencode.md | opencode | Clean review with two findings | ok |
| clean-codex.md | codex | Clean review with one finding | ok |
| clean-claude.md | claude | Clean review, no findings | ok |
| preamble-opencode.md | opencode | Extra preamble text before marker | ok |
| truncated-codex.md | codex | JSON truncated mid-object | malformed |
| duplicate-claude.md | claude | Two markers present | malformed |
