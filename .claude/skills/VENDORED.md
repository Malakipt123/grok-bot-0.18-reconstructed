# Vendored skills

These skills are copied verbatim from third-party repositories, reviewed, and
pinned to one commit. Update them by copying a newer reviewed commit in a PR,
never with `npx skills update`.

| Skill | Source | Commit | License |
| --- | --- | --- | --- |
| `tdd/` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd` | `59db609eb1e18aaf59b63284d0e52255aff0c63c` | MIT (`tdd/LICENSE`) |
| `diagnosing-bugs/` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/diagnosing-bugs` | `59db609eb1e18aaf59b63284d0e52255aff0c63c` | MIT (`diagnosing-bugs/LICENSE`) |

Review notes (2026-10-27): both are markdown plus one interactive Bash
template (`diagnosing-bugs/scripts/hitl-loop.template.sh`) that only prompts
and reads answers; no network calls, installs or file access. The upstream
`agents/openai.yaml` files are left out. `tdd` mentions `codebase-design` and
`code-review` skills from the same repository; `codebase-design` is not
vendored here.

`jarvis-debug/` is this repository's own skill.
