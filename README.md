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

**The page: <https://daaab.github.io/pear.js/>.** With a real SO-101 it only reads: it connects over Web Serial,
shows the arm as PEAR would read it, captures the wrist camera's frame and checks a model service; it never writes
to a servo, so it cannot move a real arm. With an arm, the camera and a model service it can ask the model once:
it sends what PEAR's turn loop would send as a task's first turn (the arm's measured state, the camera's frame,
your instruction) and shows the answer and the action the model asks for; the action is not executed. "Try
without an arm" gives it a simulated one, and that one it can move: PEAR's station (the robot, its 50 Hz control
loop, its driver) runs in a Worker of the page and drives the simulated arm by hand, one small action at a time,
with Home and a Stop. No model drives an arm yet. The read-only part has been tried once with a real arm
(2026-11-16: an SO-101 on a Mac, in a Chromium 157 browser; the adapter, the six servos, their calibration and the
wrist camera read as expected). A real PEAR model has answered the published page once (headless Chromium, the
simulated arm). With a real arm the page also offers a check that only reads: the station's Worker takes the
arm's serial line, reads the servos, measures the control loop's timing on it and hands the line back. That check
has not run on a real arm yet. Nothing in the page moves a real arm. If you try it, the page's log (it holds no
key) is what to send back.

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
| `tests/sim-bridge` | pear.js's servo layer on a simulated SO-101 servo chain over TCP, beside PEAR's Python on the same chain (the chain is not part of this repository) | Of 1,888 instruction packets PEAR's Python sends in ten scripted sessions, pear.js sends the same 1,888 in the same order; the 331 readings are equal to the last bit and the 12 refusals carry the same error class. Recorded as the reference for the whole station: PEAR's own robot on that chain, 8 sessions of 652 steps, the same bytes at every run ([docs/progress/station-reference.md](docs/progress/station-reference.md)). **pear.js's whole station on that chain**, its robot on its real driver, run through the same script with the clock stepped one control period at a time: given PEAR's kinematics' answers and the reference's C library values, nothing differs from PEAR's run in any of the 652 steps: the same 25,502 instruction packets and 87,210 answers, every result, report and turn text, every number in every bit. With pear.js's own kinematics every step ends the same and the model reads the same texts; planned targets differ in their last bits, and in one Home one joint's goal by one encoder count (26 of the 25,502 packets) ([docs/progress/station-chain.md](docs/progress/station-chain.md)). That run needs the chain and is skipped without it. What runs in every `npm test`, and so in continuous integration, is the same station on the recorded line of PEAR's run, replayed in process from `station_reference.result.json.gz`: each of the 25,502 instruction packets pear.js sends must be the one PEAR sent, and every value the station returns is compared with PEAR's in every bit; the servo side there is the recording and proves nothing. **In real time** (pear.js's own loop on its own clock, the chain's arm on the wall clock; in Node, not in a browser) the station went through the same script four times a session: every step returns or raises as in PEAR's stepped run and as in PEAR's two real-time runs, every action's result has the same status, settled, reached, gripper outcome and error, and every report text is the same; once the test's own calls of the chain's controls were made quick, the station also takes PEAR's number of control periods and logs what PEAR's logs. Where the arm stops when a fault interrupts a motion differs from run to run, in PEAR's runs and in these: PEAR polls the servos' Status and Torque_Enable once in 10 reads of the positions each, so a fault is noticed 1 to 10 control periods after it arrives (up to 0.2 s), and the port keeps that. Those runs need the chain too |
| station: the control loop | The 50 Hz loop on the trajectory generator, the operations it runs, recovery, gripper outcomes (`trajectory`, `operations`, `control_loop`, `recovery` under `src/station/joint`; `control_loop`, `grippers` under `src/so101/joint`) | Ported. Stepped one control period at a time on the stand-ins PEAR's own tests use (a clock and an arm that are not real), every period gives PEAR's own record, to the last bit given the reference's C library values: 362 scenarios of 22,569 control periods and 310 trajectory cases. Of the 1,453 tests, 705 compare with PEAR's record; 691 compare pear.js with itself, because a page has one thread where PEAR has a lock: a call that arrives while a period is under way must act as the same call made before or after that period; 57 are written by hand. A second, independent reader checked the code against PEAR's, and the tests by breaking the code on purpose ([docs/progress/loop.md](docs/progress/loop.md)). In real time, in Node only: on a stand-in arm, made without a clock, the loop is enabled in half a second and keeps its 20 ms period (on Node for Windows with a busy thread, and 1 step of about 120 took longer than 25 ms); under the whole station on the simulated servo chain it kept 20.003 ms on average over 11,599 periods, as PEAR's loop does there (the row above). In a Worker of the page, in headless Chromium, it kept its period on the page's simulated arm (the row of `web/`). Not verified: a visible browser window, macOS, a serial line, a real arm. Only the robot below runs on it, on stand-ins, on a simulated servo chain and on the page's simulated arm |
| station: motion, the robot | Planning and executing an action, Home, the cameras, and the robot the turn loop drives (`src/station/motion`, `src/station/robot.ts`, `src/station/cameras.ts`, `src/so101/motion`, `src/so101/robot.ts`) | Ported. On the stepped rig of PEAR's own tests (a stand-in arm, clock and cameras; no real time) pear.js's robot gives PEAR's own robot's record, to the last bit given the reference's C library values and PEAR's kinematics' answers, and within 1e-9 with pear.js's own kinematics: 73 sessions of 1,657 steps and 11,920 control periods, 1,738 cases of the parts, and the 19 tasks of the turn loop. The action models take and refuse what PEAR's pydantic models do, with their texts, but for two cases JavaScript cannot avoid and one that is open (a string that holds a lone surrogate). Of the 5,049 tests, 130 are written by hand, most of them from a run of PEAR's own classes, for what the recorded sessions cannot hold: calls that arrive while a control period is under way, calls of the cameras that overlap, handlers that take time, a close during an action. A second, independent reader checked the code against PEAR's and made 225 breaks of its own; after its findings were answered, 214 of the 221 that can still be made fail a test, and for the other 7 nothing outside the port can differ ([docs/progress/robot.md](docs/progress/robot.md)). In real time it has run on the simulated servo chain, in Node (the row of `tests/sim-bridge`), and in a Worker of the page on the page's simulated arm (the row of `web/`). Not verified: a serial line, a real camera, a real arm |
| `src/console` | PEAR's operator console (`deploy/station/gui/console`): the console itself (`console.py`: the state the page shows, the events, the operator's stop, the one operation that runs at a time on its worker), the operator's commands (`commands.py`: start, pause, resume, clear, STOP MOTION and its reset, enable, disable, Home and its confirmation, the recovery of control, the cameras' reconnection, the model, the recording), the watchdog that pauses the robot when the browser in control, the recording, the cameras or the control fail (`watchdog.py`, `periodic_thread.py`), the review of a Home plan (`home_review.py`), the lease of the one browser tab that commands the robot (`lease.py`), and the loop that runs a task's turns one after another (`task_run.py`: it asks again after an action out of reach, ends the run after an action that did not complete and settle, records an operator's pause as the turn's failed result, reconciles a robot fault) | In progress. Four replays of records of PEAR's own classes, each comparing every part of every step: `TaskRun` in fifteen scripted scenarios (52 calls), on pear.js's real robot on the stepped stand-in arm with a scripted model (the same but, in two scenarios, the last digits of some measured joints: the fixtures hold no answers of PEAR's kinematics for three actions; at most 1e-12 rad apart); `Console`, `HomeReview` and `ControlLease` in twenty scenarios (174 steps); `Commands` and `Watchdog` in thirty (258 steps; 119 commands, 60 of them refused). These two stand on scripted stand-ins for the robot and the task run. The fourth runs the three ported parts together, the commands running a task that the console runs on its worker with its own task run on pear.js's real robot, in four scenarios (20 steps): a task started, paused, resumed, cleared and started again, with the watchdog's check between; `clear` while the task runs; STOP MOTION while an action moves the arm, with its reset and the resume after it. Every part is the same as PEAR's, with PEAR's kinematics' answers given and no tolerance; the three parts together have no record of a turn that fails yet. Each port and its fixtures were written without sight of each other, and no port needed a fix from the records (one comparison in `emit` was corrected from a reading of PEAR). What the records do not reach (a Home that is admitted, with its confirmation and a robot's choice of arm and grippers; when the watchdog's loop waits; four single lines of the commands; two things of `emit`) is held by tests written by hand, which compare with nothing of PEAR's. Changes made to the ports on purpose: 19, 29, 34 and 38 fail the four replays; the 8 that passed the commands' replay, and 15 more in the parts it does not reach, fail the tests written by hand ([docs/progress/console.md](docs/progress/console.md)). Not here: the camera preview, and the page's service, which gives the commands one at a time. The page does not use it yet |
| `web/` | The page: Web Serial, the wrist camera, a check of the model service, a simulated arm for trying it without hardware. With a real arm it is read-only. Second version: PEAR's station in a Worker of the page, driving the simulated arm by hand (stage A); the camera's frames reach that station, and the page can ask a model once without executing the answer (stage B, first parts); a check that hands a real arm's serial line to the Worker and back, reads only | Published at <https://daaab.github.io/pear.js/>. In headless Chromium: 1,578 checks in 27 parts, none failed. Every byte to a serial port passes a guard that lets only PING, READ and SYNC READ through, in the window and in the Worker; the Worker opens a real arm's port only for the hand-over check, which reads, and the station's robot is given no real port: it drives an arm the Worker makes itself (checked with a stand-in port that answers as a real arm: the station stays disabled, and nothing but reads is written). In the Worker the robot is enabled after a timing self-check, runs actions of the model's format and Home and gives PEAR's results and report texts, brakes into a hold on Stop and when the page is hidden, and keeps its 20 ms period ([docs/progress/web.md](docs/progress/web.md)). Tried once with a real arm, read-only (2026-11-16: macOS, a Chromium 157 browser in a visible window; the adapter, the six servos, their calibration registers and the wrist camera read as expected). A real PEAR model has answered the published page once, with the simulated arm. Never tried: the hand-over check on a real arm, anything that writes to a real servo, a tab that is really hidden |
| a real SO-101 | by a person at the arm | not yet |

What each ported part covers, how it was compared with PEAR and what it leaves out is in `docs/progress/`.
The parts are joined on stand-ins and on a simulated servo chain only: the turn loop drives the robot on the
stand-in arm of PEAR's own tests, and the robot drives a simulated SO-101 through its real driver and the Feetech
protocol over TCP; both give PEAR's results with a clock that is stepped, and on the chain the station has also run in real time, in Node, where it keeps what PEAR's own real-time runs keep. No real model, serial port
or arm has been part of such a run. The page uses the robot on a simulated arm only: with a real arm it reads and cannot move it. In a browser, the page and a replay of 901 fixture cases have run in headless
Chromium only.

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
目前是早期開發階段，還沒有在實體手臂上執行過。網頁在 <https://daaab.github.io/pear.js/>：接上實體手臂時只讀取手臂的狀態、
相機畫面並檢查模型服務，不會對馬達寫入任何東西，所以不會讓實體手臂動；沒有手臂可以按「沒有手臂，先用模擬的試試」，
再到步驟 4 讓 PEAR 的 station 在頁面的 Worker 裡驅動模擬手臂（啟用、一次移動一小步、回 Home、停止）。
本專案是非官方的獨立專案。
