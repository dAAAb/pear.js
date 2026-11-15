# pear.js

PEAR's robot station, in TypeScript, for the browser.

[PEAR](https://github.com/mit-han-lab/pear) (MIT Han Lab) trains a reasoning model to use a robot the way a person
uses a computer. Each turn the model reads the arm's measured state and a camera frame, reasons, and answers with
one small move of the end effector; a local program, the *robot station*, turns that move into joint motion and
tells the model what happened. PEAR's station is a Python program for Linux.

pear.js is a port of that station to TypeScript, so that a web page can drive a LeRobot SO-101 over Web Serial.
The goal: an SO-101, a Chromium-based browser, and the address and key of a server that serves a PEAR model are
all it takes to try it.

> **Status: early work in progress. Nothing here has moved a real arm yet.** What exists and how far each part is
> verified is listed under [Status](#status).

pear.js is an independent, unofficial project. It is not affiliated with or endorsed by the PEAR project or its
authors.

## How it stays faithful to PEAR

The model was trained against the station's exact words: its system prompt, the text of each turn, and the report
of what an action did. A port that words any of these differently, or rounds a number differently, shows the
model something it has never seen. So:

- pear.js ports PEAR at one pinned commit (`f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`). Every source file that
  ports a Python file names it at its top.
- The tests compare pear.js with PEAR itself. Scripts under `tools/fixtures/` run PEAR's Python code at that
  commit and write what it produces to `tests/fixtures/`; the TypeScript tests must reproduce those files. The
  fixtures are committed, so the tests need only Node.
- Where a browser forces a different design (there is no hard real-time loop in a page, and the arm is reached
  through Web Serial), the difference and its reason are written down in [docs/DESIGN.md](docs/DESIGN.md).

## Status

| Part | What it is | State |
| --- | --- | --- |
| `src/protocol` | The texts the model reads and the action it writes: system prompt, turn text, answer parsing, execution feedback | Ported. Every text equals PEAR's on the fixtures (1,491 tests), PEAR's own stored texts among them |
| `src/so101/kinematics` | The SO-101's forward and inverse kinematics in PEAR's pose convention, joint limits | Ported. Poses equal PEAR's on 2,010 joint vectors. Inverse kinematics gives PEAR's answer wherever PEAR's solver converged (1,250 of 2,255 fixture cases) and on 92% of the cases where it ran out of steps, where PEAR's own answer changes with the ninth decimal of its input |
| `src/feetech`, `src/so101/hardware` | The Feetech STS3215 serial protocol, lerobot's bus on it and PEAR's SO-101 servo layer, over an abstract transport; a simulated servo chain | Ported. Packets, bus exchanges and unit conversions equal the reference Python's on the fixtures. Never run on a real servo or a real serial port |
| `src/ruckig` | The trajectory generator PEAR's station calls every control period: a port of [Ruckig](https://github.com/pantor/ruckig) 0.15.3, community edition | Ported. Given the reference's C library values, every number equals the reference module's to the last bit: 1,454 calculations and 24 sessions of updates in the fixtures, 109,050 and 1,800 in a larger run. With the JavaScript engine's own `cbrt` and trigonometry, durations agree within 5e-11 relative |
| `src/station/joint`, `src/so101/joint` | The joint layer without its control loop: configuration, limits, stability and tracking monitors, action guard, snapshot checks, friction feedforward | Ported. Equal to PEAR's own classes on the fixtures (246 tests); gravity torques within 2e-15 N·m of PEAR's |
| `src/agent` | The model client (an OpenAI-compatible Chat Completions service, streamed) and the turn loop | Ported. Requests, events, results and error texts equal PEAR's on 26 client scenarios and 19 tasks run with PEAR's own stand-ins (570 tests). No real model server has been contacted |
| `tests/sim-bridge` | pear.js's servo layer on a simulated SO-101 servo chain over TCP, beside PEAR's Python on the same chain (the chain is not part of this repository) | Of 1,888 instruction packets PEAR's Python sends in ten scripted sessions, pear.js sends the same 1,888 in the same order; the 331 readings are equal to the last bit |
| station: control loop, motion, robot | The 50 Hz control loop on the trajectory generator, recovery, gripper outcomes, Home, the robot the turn loop drives | next |
| web | Web Serial on a real adapter, camera capture, a demo page | planned |
| a real SO-101 | by a person at the arm | not yet |

What each ported part covers, how it was compared with PEAR and what it leaves out is in `docs/progress/`.
The parts are not joined yet: nothing here can execute a model's action from end to end.
Nothing has been run in a browser yet: the tests run in Node.

## Develop

```bash
npm install
npm test          # compares pear.js with the committed fixtures
npm run typecheck
```

Regenerating the fixtures needs PEAR's station environment at the pinned commit (see PEAR's
`scripts/install.sh station`); each script under `tools/fixtures/` says how to run it.

## Safety

A PEAR model does what it is asked: it is not a safety mechanism, and neither is this library's parsing of its
answers. Whatever moves the arm must bound speed and range on its own, stop when asked, and be watched by a person
who can cut the power. pear.js is experimental software, provided without warranty; use it at your own risk.

## License

Apache-2.0, like PEAR. pear.js is a derivative work of PEAR and carries its notices: see [NOTICE](NOTICE).

---

**中文簡介**：PEAR 是 MIT Han Lab 的開源專案，讓推理模型像人用電腦一樣使用機器手臂：每一回合看手臂狀態與相機畫面、
思考、回答一個小位移，再由本機的 robot station 把它變成關節動作。PEAR 的 station 是 Linux 上的 Python 程式；
pear.js 把它移植成 TypeScript，目標是只要有 SO-101、Chromium 系瀏覽器，加上 PEAR 模型服務的網址與金鑰，就能在網頁上試。
目前是早期開發階段，還沒有在實體手臂上執行過。本專案是非官方的獨立專案。
