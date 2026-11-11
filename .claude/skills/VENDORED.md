# Vendored skills

These skills are copied verbatim from third-party repositories, reviewed, and
pinned to one commit. Update them by copying a newer reviewed commit in a PR,
never with `npx skills update`.

| Skill | Source | Commit | License |
| --- | --- | --- | --- |
| `tdd/` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd` | `59db609eb1e18aaf59b63284d0e52255aff0c63c` | MIT (`tdd/LICENSE`) |
| `diagnosing-bugs/` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/diagnosing-bugs` | `59db609eb1e18aaf59b63284d0e52255aff0c63c` | MIT (`diagnosing-bugs/LICENSE`) |
| `node/` | [mcollina/skills](https://github.com/mcollina/skills) `skills/node` | `c75d70dbfbe991d8cec42aeda0b64ff14fbb9ac7` | MIT (`node/LICENSE`) |

Review notes for `tdd` and `diagnosing-bugs` (2026-10-27): both are markdown plus one interactive Bash
template (`diagnosing-bugs/scripts/hitl-loop.template.sh`) that only prompts
and reads answers; no network calls, installs or file access. The upstream
`agents/openai.yaml` files are left out. `tdd` mentions `codebase-design` and
`code-review` skills from the same repository; `codebase-design` is not
vendored here.

Review notes for `node` (2026-11-09): `SKILL.md` and the `rules/*.md` files are prose and
examples only; no scripts, network calls or installs run from the skill. The
upstream `tile.json` and `rules/assets/*.ts` examples (which import an
uninstalled package) are left out; no copied file refers to them. Its library
suggestions (pino, close-with-grace, lru-cache, …) are general advice, not
approval to add dependencies: new packages still need the user's approval, and
reconstructed runtime code still follows the evidence-only rule in
`PROVENANCE.md`.

`jarvis-debug/` is this repository's own skill.
