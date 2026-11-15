# PEAR's prompt files

These two files are PEAR's own, unchanged, from [PEAR](https://github.com/mit-han-lab/pear) at commit
`f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087` (Apache-2.0; see [NOTICE](../../../NOTICE)). The model was trained
against their exact text, line breaks (LF) included.

| File | Path in PEAR | SHA-256 |
| --- | --- | --- |
| `system_prompt.md` | `pear/deploy/station/agent_loop/system_prompt.md` | `de3e97a8829d4027c8f8e362b66292ee9c5183e5a1bcedc71f3bd713f1fbb1e3` |
| `single_arm_pose.md` | `pear/deploy/station/control/robots/so101/prompts/single_arm_pose.md` | `7384a11eb4c7757d2102d668afa41cdbd380b229bc592e929a8d3318787fbe26` |

- `system_prompt.md` is the station's template: `{environment}` takes the action format's facts as an ENVIRONMENT
  section, `{instruction}` the task.
- `single_arm_pose.md` holds the facts of the SO-101's `single_arm_pose` format; PEAR strips the whitespace around it.

`src/protocol/prompts.ts` embeds both, so that a bundle for a browser carries them. Do not edit either copy:
`tools/fixtures/protocol_fixtures.py --sync-prompts` copies the files from a PEAR station environment and writes
the embedding module, and `tests/protocol/prompts.test.ts` checks the bytes and the hashes above.
