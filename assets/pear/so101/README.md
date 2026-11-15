# SO-101 robot description (PEAR's file, unchanged)

| File | Path in PEAR at `f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087` | sha256 |
| --- | --- | --- |
| `so101_new_calib.urdf` | `pear/deploy/station/control/robots/so101/description/so101_new_calib.urdf` | `faed6e0bc0ecee5dda46ce4769a4f5f643effb1e1c5b97840c70975f1425506e` |

The hash is of the file with LF line endings, as PEAR's repository stores it (8142 bytes). A checkout that converts
line endings to CRLF gives another hash; this repository keeps LF (`.gitattributes`).

## Where PEAR took it from

PEAR's `description/README.md` states it as follows. The file is from
[TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100) at commit
`a758567c3978dfeefe282ede0500085a48fe8f78`, path `Simulation/SO101/`, licensed under Apache-2.0. PEAR made one
change: the `<visual>` and `<collision>` elements of every link, and the comments that name their parts, are removed,
so the description needs none of the mesh files. The sha256 of the file as SO-ARM100 has it is
`3a65d2d35e68a8d2f0c2cc176d19b884506543c93ba72980145b80abe276022c` (PEAR's statement; not checked here).

- Zero convention: "new calibration". Each joint's zero is the middle of its range, which matches lerobot's
  `use_degrees=True` normalization.
- End-effector frame: `gripper_frame_link`. The arm joints are `shoulder_pan`, `shoulder_lift`, `elbow_flex`,
  `wrist_flex` and `wrist_roll`.

## How pear.js uses it

pear.js does not parse the file at run time. `src/so101/kinematics/chain.ts` holds the origins and the axes of the
joints between `base_link` and `gripper_frame_link`, transcribed from this file, and
`tests/so101-kinematics/chain.test.ts` parses this file and fails if the two differ. The joint limits in the file are
not used: like PEAR, pear.js takes the limits from the station's settings.
