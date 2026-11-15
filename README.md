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

**The page: <https://daaab.github.io/pear.js/>.** Its first version only reads: it connects to an SO-101 over Web
Serial, shows the arm as PEAR would read it, captures the wrist camera's frame and checks a model service. It never
writes to a servo, so it cannot move the arm. "Try without an arm" runs it on a simulated one. It has not been
tried on a real arm yet either; if you try it, the page's log (it holds no key) is what to send back.

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
| `src/feetech`, `src/so101/hardware` | The Feetech STS3215 serial protocol, lerobot's bus on it and PEAR's SO-101 servo layer, over an abstract transport; a Web Serial transport; a simulated servo chain | Ported. Packets, bus exchanges and unit conversions equal the reference Python's on the fixtures. Two additions for a browser, which change no packet: bytes left over from an answer that came late are dropped before the next command (in the reference a host that stalls once reads every later answer one behind), and the Web Serial transport reads on after a line error. Never run on a real servo or a real serial port |
| `src/ruckig` | The trajectory generator PEAR's station calls every control period: a port of [Ruckig](https://github.com/pantor/ruckig) 0.15.3, community edition | Ported. Given the reference's C library values, every number equals the reference module's to the last bit: 1,454 calculations and 24 sessions of updates in the fixtures, 109,050 and 1,800 in a larger run. With the JavaScript engine's own `cbrt` and trigonometry, durations agree within 5e-11 relative |
| `src/station/joint`, `src/so101/joint` | The joint layer without its control loop: configuration, limits, stability and tracking monitors, action guard, snapshot checks, friction feedforward | Ported. Equal to PEAR's own classes on the fixtures (246 tests); gravity torques within 2e-15 N·m of PEAR's |
| `src/agent` | The model client (an OpenAI-compatible Chat Completions service, streamed) and the turn loop | Ported. Requests, events, results and error texts equal PEAR's on 26 client scenarios and 19 tasks run with PEAR's own stand-ins (574 tests). No real model server has been contacted |
| `src/python` | What PEAR's texts take from Python itself, in one place for every part: the built-in exceptions under Python's class names, and how Python writes a number, a string and JSON | Ported. Compared with CPython 3.12's own output (`tests/python`) |
| `tests/sim-bridge` | pear.js's servo layer on a simulated SO-101 servo chain over TCP, beside PEAR's Python on the same chain (the chain is not part of this repository) | Of 1,888 instruction packets PEAR's Python sends in ten scripted sessions, pear.js sends the same 1,888 in the same order; the 331 readings are equal to the last bit and the 12 refusals carry the same error class. Recorded as the reference for the whole station: PEAR's own robot on that chain, 8 sessions of 652 steps, the same bytes at every run ([docs/progress/station-reference.md](docs/progress/station-reference.md)) |
| station: the control loop | The 50 Hz loop on the trajectory generator, the operations it runs, recovery, gripper outcomes (`trajectory`, `operations`, `control_loop`, `recovery` under `src/station/joint`; `control_loop`, `grippers` under `src/so101/joint`) | Written, **not verified**: the comparison with PEAR's loop, tick by tick, is in progress. Do not rely on it |
| station: motion, the robot | Planning and executing an action, Home, the robot the turn loop drives | in progress |
| `web/` | The page: Web Serial, the wrist camera, a check of the model service, a simulated arm for trying it without hardware. First version, read-only | Published at <https://daaab.github.io/pear.js/>. In headless Chromium on a simulated arm: 1,013 checks in 24 parts, none failed. Every byte to the port passes a guard that lets only PING, READ and SYNC READ through (`tests/web`). Never tried with a real adapter, arm or camera, nor on macOS |
| a real SO-101 | by a person at the arm | not yet |

What each ported part covers, how it was compared with PEAR and what it leaves out is in `docs/progress/`.
The parts are not joined yet: nothing here can execute a model's action from end to end, and the page cannot move
an arm. In a browser, the page and a replay of 901 fixture cases have run in headless Chromium only.

## Develop

```bash
npm install
npm test            # compares pear.js with the committed fixtures
npm run typecheck
npm run build:web   # builds the page into dist-web/
npm run check:web   # the built page in headless Chromium; needs Python with Playwright (web/tests/run_check.sh)
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
目前是早期開發階段，還沒有在實體手臂上執行過。網頁第一版在 <https://daaab.github.io/pear.js/>：只讀取手臂的狀態、
相機畫面並檢查模型服務，不會對馬達寫入任何東西，所以不會讓手臂動；沒有手臂也可以按「沒有手臂，先用模擬的試試」看模擬的樣子。
本專案是非官方的獨立專案。
