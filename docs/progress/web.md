# Progress: web

The page a person opens to use pear.js with their own SO-101 (`web/`). With a real arm it is read-only on purpose:
it connects to the arm over Web Serial, shows that it is the arm PEAR expects, reads it live, shows the wrist
camera and the frame a turn would send, and checks the model service; it never enables torque and never writes to
a servo. A simulated arm lets anyone try it, and a machine test it, without hardware; on that simulated arm, and
only there, the second version's stage A runs PEAR's station in a Worker of the page, driven by hand ("The
station in a Worker, on a simulated arm" below).

State: published. The first, read-only version on 2026-11-15; the second version's stage A on 2026-11-16, and on
the same day stage B's first two parts (the camera's frames reach the station; ask the model once) and the
read-only hand-over of a real arm's line to the Worker.

Checked on 2026-11-16, on the files as published: `npm run typecheck` passes; `npm run build:web` gives three
files; 1,578 browser checks pass in 27 parts, 0 failed; `npx vitest run` passes (86 files, 9,349 tests).
The read-only part met a real adapter, real servos, a real camera, a browser with a visible window and macOS
once, on 2026-11-16 ("What the first try showed" below). **Nothing that writes to a servo has met a real arm.** A
real model service has answered the published page once, with the simulated arm ("The first answer of a real
model" below).

A session that restarts continues from "Left" and changes the files it finds in place.

## Done

| File | What it is |
| --- | --- |
| `web/vite.config.ts` | Root `web/`, output `dist-web/`, relative base; one classic script and one style sheet, so that the built folder opens from any path and from a `file://` URL. It gives the page the PEAR commit of `src/index.ts` and the commit it is built from |
| `web/index.html`, `web/src/style.css` | The markup and the look: system fonts, light and dark by the system's setting, one column, a Stop bar that stays in view |
| `web/src/main.ts` | Joins the parts to the markup and renders them; `window.pearjs` gives a check the page's own objects (every byte to the servos still passes the guard) |
| `web/src/texts.ts`, `i18n.ts` | Every text in English and in Traditional Chinese as written in Taiwan; the first language follows the browser, `?lang=en` or `?lang=zh-TW` pins it |
| `web/src/readonly.ts` | `ReadOnlyTransport`: a packet passes only when it is, provably, a PING, a READ or a SYNC READ; anything else throws `ReadOnlyViolation` with nothing sent. `guardSelfTest()` runs at page load and a failure blocks Connect |
| `web/src/serial_port.ts` | `ResilientPort`: goes on reading after an error of the line that a Web Serial port survives (see Found, 1) |
| `web/src/sim_port.ts` | `SimSerialPort`, `SimArm`: an object with the shape of a Web Serial port (open, readable, writable, close) on `src/feetech/sim.ts`, with the faults a person may meet: a servo missing, a servo in error, factory registers, a silent line, an echoing adapter, a pulled cable, a line error |
| `web/src/arm.ts` | `ArmSession`: open at 1,000,000 baud, `WebSerialTransport`, the guard, lerobot's follower, the bus's handshake; when that fails, each servo asked by itself; the calibration registers; a calibration file compared as PEAR's start-up does; the periodic read; loss of the port |
| `web/src/camera.ts` | `CameraSession`: the video inputs, the preview, one frame as PEAR's wrist camera hands it to a turn; `TestPicture`, a drawn picture as a camera's stream |
| `web/src/model.ts` | `checkModel`: the library's `HealthChecks` on a `VLLMClient`, and what a browser hides of a failure |
| `web/src/timing.ts` | Measurements for the control loop of a later version, from a button, so that they can be made on a real arm |
| `web/src/log.ts` | The page's log (English, no key, no address of the model service) and its copy button; the first three lines (build stamp, browser, page origin) stay when older lines are dropped |
| `web/src/trace.ts` | `LineTrace`, `TracedTransport`: a record of the bytes that go over the serial line, with timing; the hex excerpt in a failure's log |
| `web/src/probe.ts` | `pingToAll` at a given baud rate (a broadcast PING, wait for every answer); `OTHER_BAUD_RATES` from the library's table |
| `web/tests/browser_check.py`, `run_check.sh` | The check of the built page in headless Chromium; `run_node.mjs` runs a TypeScript entry in Node through Vite: `expected_entry.ts` (what the library gives for servo positions), `transport_probe_entry.ts` (Found, 1 and 2), `stamp_entry.ts` (the pinned PEAR commit) |
| `web/tests/build_check.mjs` | Case-sensitive comparison of every import and reference with the disk (for Linux's case-sensitive file system), and a clean-copy build with `npm run typecheck` and `npm run build:web` with and without `GITHUB_SHA` |
| `web/tests/jpeg_compare.py`, `jpeg_reference.py` | The browser's JPEG encoder against PIL's |
| `web/selftest.html`, `web/src/selftest.ts`, `web/vite.selftest.config.ts` | A page that replays committed fixtures (feetech packets, kinematics poses, protocol turn text, Ruckig with the libm oracle) in the browser and compares the counts with Node's (`web/tests/selftest_expected.ts`); 901 cases across 5 suites. Built with a separate Vite config (IIFE, `emptyOutDir: false`) to the same `dist-web/` |

What the page shows comes from the library: `WebSerialTransport`, `FeetechMotorsBus` (`connect(true)`, `ping`,
`syncRead`, `readCalibration`, `isCalibrated`, `normalize`), `SO101Follower`, `parseCalibration`, `servoFaults`,
`SO101Hardware.busPosition`, `SO101Kinematics.quantities`, `JointLimits.checkPositions`,
`SINGLE_ARM_POSE_FORMAT.turnText`, `SO101_DEFAULT_CONFIG.camera`, `JPEG_QUALITY`, `HealthChecks`, `VLLMClient`.

## The station in a Worker, on a simulated arm

The page's second version begins with the station driving a simulated arm; no real arm can move. With a real
arm connected the page is as before: read-only through the guard, and the station's Enable is disabled with a
sentence that says why.

- `web/src/station_host.ts`: the station as the Worker runs it. It makes its own simulated arm (the library's
  `simulatedArm` on `SIM_CALIBRATION`, at 3,072 steps a second) and PEAR's robot on it (`SO101Robot` with the
  control loop, the driver and the bus; no camera, so an observation holds the joints, the control snapshot and no
  frame). The robot is never handed a real port; the Worker itself opens a real arm's port only for the hand-over
  check, behind the read-only guard ("The hand-over of a real arm's line to the Worker, reads only" below). It
  answers the requests of `web/src/station_protocol.ts` (enable, stop,
  disable, jog, home, approve, visibility), each started when it arrives, so that a Stop is taken while an action
  is under way; and it tells its status ten times a second (the robot's status, the control state, the fault, the
  joints, the targets, the model's state, the turn's text, the loop's periods over the last second), what the
  robot logs as warnings and errors, an action's phases, the Home plan and the timing self-check's numbers.
- Before enabling, the timing self-check: 150 control periods of one SYNC READ of the positions and a wait, on
  the clock the loop uses. Enabling is refused when a period is over 40 ms, more than 3 are over 25 ms, the mean
  is over 20.5 ms, a read takes over 15 ms, or the page is hidden.
- A jog is one action of the model's format (`single_arm_delta`, centimetres and radians; the gripper's command
  +1 or -1), run as a turn of PEAR's agent loop runs it: `waitStationary`, `observe`, `execute` with that
  observation as its reference; the page shows the format's `resultFeedback` of the result, which is what the
  model would read, and the next turn's text. Home is the robot's `home` with its approval: the plan is shown and
  the person approves or refuses it; a plan that gets no answer in two minutes counts as refused.
- Stop (the stop bar) is the robot's `stop()`. Disable is the robot's `close()`. A hidden page: `stop()`, and no
  action is started until it is visible again; the loop goes on and nothing is closed.
- `web/src/station_worker.ts` is the Worker's entry and `web/src/station_client.ts` the window's side: requests
  with an id and a time limit each, and a Worker that died or tells nothing for two seconds is shown as that.
  The client imports the entry with `?worker&inline`: the build puts the Worker's bundle into the page's one
  script as a text and starts the Worker from a Blob URL, so the built folder is still one page, one script and
  one style sheet, and it works from a folder.
- One arm, two phases: Enable ends the window's reading of the simulated arm and starts the Worker's arm where
  that one stood; Disable hands it back where the station left it.
- While the station drives, step 1 shows the driven arm from the Worker's status, about ten times a second: it
  says that the station drives the simulated arm and shows the six joints (PEAR's values against PEAR's limits),
  the model's state and the turn's text. The servos' steps and the marks against the limits are not in the
  status: they are left out, with a sentence. The simulated arm's sliders, its fault choice and its cable button
  are disabled from Enable to Disable, with a sentence.
- The Worker's clock, for a measurement: the status carries `realTimeClock().stats()` since enabling (`sleeps`,
  `timers`, `yields`, `spinMs`, `lateMeanMs`, `lateMaxMs`, `timerLateMaxMs`, `marginMs`; the times rounded to
  0.001 ms; the clock's counts are reset when the robot opens, so the self-check's sleeps are not in them) and
  the control periods since enabling (count, mean, longest, how many over 25 ms and over 40 ms). The panel shows
  the clock as one line, in both languages. At Stop, at Disable and when the page becomes hidden the page writes
  one line to its log, `Station: clock {...}`: JSON with `at` ("stop", "disable" or "hidden"), `steps`,
  `periods`, `clock` and `timing` (the self-check's numbers), taken from the last status told, which is at most
  about a tenth of a second old.
- What an action did is in the report panel: first the page's own line about how the last action ended; then
  what the model would read of it (an action of the format), or Home's stages and PEAR's result for each joint,
  or, for an action that did not run (refused by the Worker or by the robot), nothing but that line, which
  carries the station's own words. An action ended by the page's Stop, or by the page being hidden, keeps PEAR's
  result as it is (`failed`, "Action cancelled by stop or another operation": that is what the model would
  read); the page's own line says, in the page's language, that the person pressed Stop, or that the page was
  hidden. Visible again, the hidden-page warning speaks in the past and no longer says that no action starts. A
  failed timing self-check is told under its line in the page's language; the Worker's English error goes to
  the log only.
- The text the Worker is started from names none of `navigator.serial`, `requestPort`, `getPorts`: the browser
  check reads the Blob behind the Worker's URL and looks for the three names.

- The self-check's verdict is a pure function, `timingVerdict(numbers, limits, isHidden)`: the reasons to refuse,
  each with its number and its limit. The Worker's error names them in English (`timingFailureText`); the page
  has its own sentence for each in both languages.
- The page says what it can move, at the top and in step 4, in both languages: this version moves only a
  simulated arm, in a Worker of the page; with a real arm connected it only reads and cannot move it.

What a stopped action's result is: PEAR's robot gives it the status `failed` with the error "Action cancelled by
stop or another operation", and that is what the page shows. A refused Home plan ends as "HomeFailed: Home
cancelled before execution".

### Stage A on 2026-11-16: what is proven, what is not

Stage A is the station in a Worker driving a simulated arm, with a real arm left read-only. It is **published
on 2026-11-16 without one thing that was meant for it**: a fault while driving has no Recover control (see "Not
done" below). Runs of 2026-11-16 on the files as published (Windows: Node 24.18.1; WSL: headless Chromium):

- The whole browser check in one run: 1,272 checks in 25 parts, 0 failed. The part `station` (254
  checks): Enable, the
  status, Stop, the button `z +1 cm`, an action out of reach, Stop during a move, Home refused and approved, a
  page that says it is hidden, Disable; served, from a folder and under a path; a Worker that is gone; a failed
  self-check said in the page's sentence in both languages; a real arm (below); and, new on this day: step 1
  while the station drives (22 checks), the Worker's text without the three names of Web Serial (1; the text
  has 243,742 characters), the clock in the status, in the panel's line in both languages and in the log's
  entries at Stop, at Disable and when the page becomes hidden (12), the report panel with the page's own
  lines (8), each of the twelve action buttons (26), a Home that the person's Stop ends (9), and what the
  review before publication changed (14; the last item below).
- The clock on this machine (headless Chromium on Linux), in the log's entry at Stop, 96 steps after enabling:
  95 periods, mean 20 ms, longest 20.2 ms, none over 25 ms; 120 sleeps, 121 timers, 12,318 turns without a
  timer, 179.3 ms in busy waits, a sleep 0.01 ms late on average and 0.1 ms at most, a timer at most 0.3 ms
  late, margin 1.5 ms. On macOS nothing was measured.
- A real arm keeps the station disabled: a stand-in for `navigator.serial` that answers as six calibrated
  STS3215 is read through the guard like any port. Enable is disabled with the real-arm sentence in both
  languages, Stop is disabled, no Worker runs, the station's client refuses a request; and with the Worker
  started by hand all the same, enable, one action and disable run on the Worker's own simulated arm while the
  port is given only PING, READ and SYNC READ and the guard refuses nothing (17 checks).
- `npx vitest run`: 76 files passed, 3 skipped; 9,180 tests passed, 11 skipped. `tests/web/station_host.test.ts`
  runs 11 tests that need no time (the refusals before Enable in the robot's words, the UUIDs, the periods'
  count, the self-check's verdict at each limit and its sentences in both languages) in 0.4 s; the session on
  real time (enable, one action, out of reach, Stop during a move, Home, Disable) runs only with
  `PEAR_JS_REAL_TIME=1` (12 passed in 11.6 s), so `npm test` does not depend on the machine's speed.
- The checks can fail (breaks in a scratch copy): the two notices put back or cut: 5 of `load`'s and 2 of
  `languages`' checks failed; `stationWhy()` without the real-arm sentence: 4 failed; the Worker started at page
  load: 4 failed and the part stopped; a browser's port taken for the simulated one, Stop and the action
  buttons never disabled: 18 failed, 8 of them of the real arm; the Worker telling no reasons: 2 failed; three
  breaks of the verdict's function: 9 of the 11 Node tests failed. Not shown to fail: 6 of the 17 real-arm
  checks (the Worker's own session by hand, "only PING, READ and SYNC READ reached the port", the page reading
  on meanwhile, the port opened once and not closed, the guard refusing nothing, its self-test), which would
  need a page that writes to the port.
- The checks of step 1 while the station drives, of the Worker's text, of the clock and of the report panel can
  fail too (three more scratch copies, the part `station` on each). Step 1 not rendered at a status event, its
  sentence never hidden again, the simulated arm's controls left disabled, the Worker telling the gripper's
  joint 0.01 off: 184 checks, 10 failed (the four checks of step 1 that an earlier break run had not reached,
  three of them at each of the three Enables or Disables). The station's code naming `navigator.serial`, one of
  the clock's numbers never a number, the Chinese line begun otherwise, no entry at Stop, the periods counted
  twice: 197 checks, 13 failed, which are the 13 checks of the Worker's text and of the clock. Home's result
  never shown, an action that did not run not told in the report panel, Stop and the hidden page not kept, the
  warning never in the past, a failed self-check told with the Worker's English error: 205 checks, 8 failed,
  which are the 8 checks of the report panel.
- All twelve action buttons. After Home the check clicks each button once (x, y and z by 1 cm, pitch and roll
  by 0.05 rad, the gripper closed and then opened) and reads a status that the Worker told after the action
  had ended. For each button PEAR's record says `completed`, and the quantity that the button names, in the
  model's state the Worker tells, changed by the button's amount with its sign: 1 cm within 0.15, 0.05 rad
  within 0.02, which a wrong sign or another quantity cannot meet (in the runs each change was 1.0 cm or
  0.05 rad as told, to 0.1 cm and 0.01 rad). The gripper's command is a direction and not an amount: the
  simulated arm stands open at 6 cm after Home; on `width` -1 PEAR's record says `completed` with
  `gripper_outcome` "closed", the report the model reads says `"gripper": "closed"` and the width is 0; on +1
  they say "open" and the width is 6 again. The check asserts that (26 checks). They can fail: in a scratch
  copy with `roll -0.05` negated, the quantities of `x +1` and `y +1` swapped and the number of Open negated,
  5 of the part's 231 checks failed: the quantity's check of each of those three arm buttons, and of Open the
  change's and the outcome's; the checks of the other eight buttons passed.
- A Home that the person's Stop ends. Home keeps what of the page ended it, as an action of the model's
  format does. The page's own line, which the report panel shows, then says "Home: you pressed Stop before it
  was done, so it ended there. The robot says: " and the robot's error as it is (`station.action.homeStopped`;
  for a page that was hidden `station.action.homeStoppedHidden`; both in English and in Chinese). The robot's
  error is "HomeFailed: Home cancelled before execution" when Stop comes while the plan waits for an answer,
  and "HomeFailed: Action cancelled by stop or another operation" when it comes while Home moves the arm.
  Checks (9): Stop while the plan waits: the line's key is the new one and the line ends with the robot's
  words, the plan is no longer shown, nothing moved. Stop while Home moves the arm (lowered by 4 cm first;
  Stop is pressed once the tip has moved 0.3 cm): the same line, also in Chinese; the tip had left where it
  stood and braked short of Home (in the run at z 18.2 cm on the way from 17.8 to Home's 20.9); the station
  is still on with the robot READY in HOLD; half a second later the state is the same; an action runs after
  it. They can fail: in a scratch copy in which Home does not keep what ended it, 3 of the part's 240 checks
  failed (the line of each case and the Chinese line). The other six were not shown to fail, and no check
  hides the page during a Home: the sentence for a hidden page was not seen in a run.
- Found in the review before publication, and changed. While the station drove, Connect and Try without an arm
  in step 1 could still be pressed: Try made the window read its own simulated arm again beside the station, and
  Connect would have opened a real arm for reading while the station was enabled, against the sentence that a
  real arm keeps the station disabled. Nothing could have been written to it: the guard and the Worker are as
  they were. Now Connect, Try without an arm and Retry are disabled from Enable until the station is disabled,
  and step 1 says "To connect an arm here, disable the station first" (in both languages). A Worker that does
  not answer or has died is said with what to do, since no arm can be connected then: reload the page. Checks
  (14): at each of the three Enables the two buttons are disabled, a click on Try connects nothing and the
  sentence is shown; after each of the three Disables they can be used again; with the Worker gone the status
  line says to reload and the two buttons stay disabled. They can fail (three scratch copies, the part
  `station` on each): Try left enabled and the sentence cut: 10 of the part's 254 checks failed
  (after the click the window read the arm again); the buttons left disabled after Disable:
  3 failed; the sentence about reloading cut: 1 failed. On the way one check of the part was
  made exact: "the loop steps about 50 times a second" took its first count from a status read some checks
  earlier, so that every check put between them raised the rate it computed (56.6 with these); it now reads
  the count when it starts its clock. And an Enable of the check that does not reach READY now reports what
  the page says of it, not only a timeout: once, when two runs of the part were started at the same moment
  while another check ran, both timed out at Enable, and the cause was not found; alone, and one after the
  other, the part passes.

Not done in stage A: a fault while driving has no Recover control (the page shows the fault; Disable and Enable
begin again, which no run has tried in FAULT); and while the Worker is gone, step 1 still shows the last status
it told. Not verified: a browser with
a visible window, macOS (the clock's numbers are there to be measured on it), a real arm, a real adapter, a page
that is really hidden, a slow machine. The check of the Worker's text is a check of three names in a text: it
does not show that no other way to a port exists. Whether the Worker's scope has `navigator.serial` in this
browser was not looked at in a run (the Web Serial specification gives a dedicated Worker `getPorts`). A Home
that ends because the page was hidden has its own sentence, which no run has shown: no check hides the page
during a Home.

### Stage B, first part, on 2026-11-16: the camera's frames reach the station

Stage B will let a model drive the simulated arm turn by turn, as PEAR's turn loop does. Its first part is the
camera: the station's robot in the Worker has its wrist camera, and every observation holds the frame a turn
would send. The model, the task and the turn loop are not in it.

What it is:

- A Worker cannot open a camera, so the camera stays in the window (step 2). While the station is enabled and
  the camera runs, the window sends the Worker the camera's frames: each the JPEG a turn would send (640 x 480
  at PEAR's quality 90, made by the function step 2 captures with), every 50 ms, as a message without an id
  whose bytes are transferred, not copied. Nothing answers a frame. The window also tells the Worker when the
  camera starts and when it stops, and sends nothing while no camera runs. (The first session sent one every
  100 ms. PEAR takes a frame for fresh up to 0.2 s after it arrived, so one frame that was late or left out
  could make an observation fail with "Camera frame is stale"; at 50 ms three in a row must fail.)
- In the Worker the frames are the frame reader of the library's `WristCamera` (`WindowFrames` in
  `web/src/station_host.ts`): the last JPEG, stamped when it arrives on the Worker's `realTimeClock()`, the
  clock the wrist camera reads; the window's clock is never used for a frame's age. The robot is made with
  `CameraFeed` over that `WristCamera` as its cameras, where stage A gave it none.
- Without a fresh frame the robot does what PEAR's does. Seen in runs: with the camera stopped, and with no
  camera told at all, the observation fails with `Camera unavailable: {'wrist': 'Camera reader stopped;
  reconnect the camera'}`, the loop brakes into a hold, and the action's result is PEAR's failed result with
  that error; the station still holds the arm, and with the camera started again the next action completes.
  The page shows the error byte for byte in the report the model would read, and the camera's line of the
  station's panel says what to do, in both languages. Since the second session the page's own sentence also
  stands at the report of the action that was not run (whenever the result's error begins with "Camera
  unavailable"): that the station had no fresh frame, and what to do; PEAR's result and report are unchanged
  beside it, and it is gone with the next report.
- The status carries six numbers of the camera (whether the window says it runs, the frames of the last
  second, the frames since enabling, the last frame's age and, since the second session, the longest time
  between two frames' arrivals and how many such times were over 200 ms) and no frame. The two new ones are
  measured on the Worker's clock since enabling, only between frames of one spell in which the window said
  that its camera runs; a time that is still open when a status is told (the frames have stopped and none has
  come since) is not in them: the last frame's age shows it. The camera's line of the panel tells them, and
  the log's `Station: clock {...}` entries (at Stop, at Disable, when the page is hidden) hold them under
  `camera`, with the frames that arrived and the window's own numbers: how many frames it made, how long making
  one took (mean and longest, ms: from asking the camera's function for the JPEG until it is there) and how many
  were left out because the one before was not ready. The frame an observation held is told
  once, as an event: the panel shows it as a small picture with its number among the frames the wrist camera
  has handed to observations, its size and its age. A frame's bytes never go to the log.

Runs of 2026-11-16 on the first session's files, with a frame every 100 ms (Windows: Node 24.18.1; WSL: headless
Chromium); the second session's runs follow them:

- The whole browser check in its two halves, one run after the other: 606 checks in 13 parts and 709 checks in
  12 parts, 0 failed (each count holds the five checks of a whole run: 1,310 different checks, where stage A
  had 1,272). The part `station` has 292 checks, 38 of them new: after Enable (served,
  from a folder, under a path) the status says that frames arrive (10 in the last second, the last one 80 to
  86 ms old) and its camera holds four numbers and no frame (6 checks); each of the twelve buttons is an action
  whose observation held a frame: JPEG bytes (FF D8 first, FF D9 last; 23,754 to 23,916 bytes) that the page
  decodes to 640 x 480 and shows, with a number above that of the action before (6 to 17) and 34 to 37 ms old
  at the observation (24); the camera stopped and started again while the station is on (7): the panel's line
  in both languages, an action that is not run and PEAR's error in the report, the arm still held, an action
  that completes after the start, the log's lines; and with a real arm and the Worker started by hand, no
  action runs before a camera is told (1). With the frames flowing the loop kept its period: 49 periods in the
  last second, mean 20.00 ms, longest 20.1 ms, none over 25 ms.
- With a port that is not the simulated one nothing but reads is written: the parts `guard`, `serial`,
  `diagnostics`, `selftest` and the real-arm checks of `station` pass in those runs. The built folder holds
  three files (504 KB), and the page asks no other host.
- `tests/web/station_host.test.ts` with `PEAR_JS_REAL_TIME=1` (the station's code in Node, frames sent by the
  test): 12 tests pass. Without a camera told an action fails with PEAR's error and nothing moves; with frames
  an action completes and its observation's frame is told once; the same after a stop and a start.
- `npm test`: 76 files and 9,180 tests pass (3 files and 11 tests are skipped: they need real time).
- Six breaks at once in a scratch copy made 31 of the 38 new checks fail, each for its break: the age in the
  status (3), the status's four numbers (3), the frame's bytes (12), the frame's number (11), the English
  sentence that says what to do (1), the log's lines (1). Not shown to fail on a break: the six checks of an
  action that is not run without a camera and runs again with one (the refusal is the library's, not the
  page's), and the number of the first button's frame.

The second session's runs, the same day and machine, on the files as they are now (a frame every 50 ms):

- The whole browser check in its two halves, one run after the other: 606 checks in 13 parts and 724 checks in
  12 parts, 0 failed (1,325 different checks). The part `station` has 307 checks, 15 of them new: after each
  Enable (served, from a folder, under a path) 15 to 22 frames arrived in the last second, and the camera's
  line tells the longest time between two frames and that none was over 200 ms (6, and 1 for the line in
  Chinese); the log's entry at Stop holds the camera's numbers (1), and at each Disable they say that the
  frames were never 0.2 s apart (3); with the camera stopped the page's sentence stands at the report of the
  action that was not run, in English and in Chinese, with PEAR's report and result line unchanged beside it,
  and it is gone after an action that completes (4). The entries' camera numbers are also checked for
  plausibility wherever the clock's are.
- The numbers of that run. After each Enable: 20 frames in the last second, the last one 34 to 36 ms old. The
  served station from Enable to Disable, over all the part's actions: 799 frames arrived, the longest time
  between two was 69.6 ms, none was over 200 ms; the window made 801 frames in 14.3 ms each on average, the
  longest 158.2 ms (once; one frame was left out). From a folder and under a path (a few seconds each): the
  longest time between two 52.6 ms; 12.6 and 13.4 ms a frame, the longest 18.5 and 16.9 ms, none left out.
  With twenty frames a second the loop kept its period: the first session's checks of it pass unchanged.
- `npm test`: 76 files and 9,181 tests pass (3 files and 11 tests are skipped: they need real time). The new
  test is the one of the times between frames, on a clock set by hand.
- Five breaks at once in a scratch copy made 24 checks of `station` fail, each for its break: all 15 new ones
  and 9 older ones that read the same things (a frame every 100 ms: the 3 checks of the rate; every time
  between two frames counted as one over 200 ms: the camera's line in both languages, the entries at Stop, at
  Disable and of the hidden page; a seventh thing in the status's camera: the 3 checks of its six numbers; the
  page's sentence shown exactly when it should not be, and PEAR's report left out beside it: the 4 checks of
  the sentence and the one of PEAR's error).
- With the robot given no cameras, in a scratch copy, 31 checks of `station` fail: every button's frame and
  its number (24, the first button's number among them), the action that is not run after the camera's stop
  and PEAR's error in the report, the three checks of the page's sentence, the action that completes with a
  frame after the start, and the real arm's action without a camera. So five of the seven checks that the
  first session had not shown to fail do fail there. Two still pass and were never shown to fail: "camera:
  while frames arrive the panel says so" and "camera: the station still holds the arm, at rest".
- Later on this day the sentence under "One action at a time" was corrected. It said that the station has no
  camera in this version and that an observation holds no frame. It now says that an observation holds the
  joints, the control state and the wrist camera's frame as the station sees it, and that without a fresh frame
  the action is not run (both languages; a check in the part `load` and one in `languages`; each fails in a
  scratch copy on the sentence without these words).

Not proven: two of PEAR's three reasons ("Waiting for camera frames", "Camera frame is stale") were never seen
in a run; a time over 200 ms between two frames was never seen in a browser run (that such a time is counted
is proven by a test with a clock set by hand, in `tests/web/station_host.test.ts`); a real camera (every run
used the test picture); a camera that gives another size than 640 x 480; a page that is truly hidden while its
camera runs; another machine or a browser with a visible window (the numbers above are headless Chromium's on
one machine; the log's entries are there so that they can be read elsewhere). Home takes no observation in the
page, so it shows no frame.

Changed with the ask's later session (see the second part): the one way the page takes a frame for the station
and for an ask (`CameraSession.frameBytes`) now gives no frame when the browser calls the camera's track ended
or muted, so a picture that the preview still holds of such a camera is not handed on as a frame of this
moment. Every run used the test picture, whose track is neither: the station's checks pass as before, and a
muted or ended track was not produced in a run.

### Stage B, second part, on 2026-11-16: ask the model once, and nothing moves

The first meeting of the page with a model. Under the instruction of step 4 the page has a panel "Ask the model
once" (`web/src/ask.ts`, wired in `web/src/main.ts`). It builds what PEAR's turn loop would send as the first turn
of a task, sends it with the library's own client, shows the answer as it streams, and shows the action the model
asked for. The action is not executed: the module holds no robot, no station and no bus. It runs in the window,
needs no station, and works on a real arm as on the simulated one, because it only uses what the window reads.

- It is offered when the window reads an arm, a camera runs, step 3 found the model service connected and an
  instruction is written; otherwise the page names the first of these that is missing. While the station drives
  the simulated arm the window does not read it, and the page says to disable the station first. A change of the
  address, the name or the key after step 3's check asks for a new check.
- The notice of step 4 says what is now true: the page can ask a model once and show the answer, it does not
  execute the action the model asks for, and no model drives an arm yet (both languages; a check in the part
  `load` and one in `languages`; each fails in a scratch copy on the notice without these words).
- Everything the model reads is made by the library. The client is made as PEAR's console makes one:
  `OfferedModel.newClient(systemPrompt(instruction))` with `VLLMClient`. No number is the page's own: the time-out
  is `OfferedModel`'s 300 s, the sampling and the limits are `VLLMClient`'s. The turn is
  `ObservationMessage.build` of an observation that holds the joints the window read, the state of step 1 and the
  frame of this moment as the JPEG the page already makes, with no feedback and no reference images.
- The request is `client.infer`. The page shows PEAR's word for the phase while the request runs, the reasoning
  and the answer as they stream, the tokens and the client's last report of the timings. Cancel stops the request
  as an operator's stop does (the turn's cancellation and the client's). After the answer, a failure or a
  cancellation the client is closed: every ask is a new conversation.
- Then the answer, byte for byte, and the action the format reads of it (`parseAction`): the json block as the
  model wrote it and a sentence in words (the gripper as PEAR's prompt defines its number: above zero open, below
  zero close, zero hold). For an answer without an action, a failure and a cancellation the page shows the
  error's class and message as the library gives them. Every outcome ends with the sentence that nothing was sent
  to the arm.
- The key stays in the page's memory and goes into the request only. The log gets what happened: asked, with the
  sizes; answered after how long, with how many characters; an action or not; the class of an error. It gets no
  key, no address, no instruction, no answer and no image.

What is proven, by the part `ask` of `web/tests/browser_check.py` (151 checks; headless Chromium; it runs in the
first half of the whole check, which had 746 checks in its last run on this day; the second half had 726, 0 failed
in both). The stand-in model service of the check now
answers `POST /v1/chat/completions` with a stream of server-sent events and keeps what it was sent. The answer it
streams is a recorded one: the body of the first turn of "three turns of one task" in
`tests/fixtures/agent/client.json`, piece by piece as the recording server sent it to PEAR's own client.

- On the simulated arm with the test picture: the page names what is missing step by step; the service was asked
  once, after a preflight without the key; the request's `Origin` is the page's origin and its `Authorization`
  carries the key; it asks for a stream and names the checked model; the system message holds the instruction; the
  user message's text is exactly the turn's text step 1 shows, followed by PEAR's name of the camera (`[wrist]`);
  its one image decodes to 640 x 480 and is a JPEG from its first to its last byte. The page shows the recorded
  answer and reasoning byte for byte, the recorded tokens, the action equal to the recorded one, as the JSON the
  model wrote and in a sentence, and that nothing was sent. The guard refused nothing and counts no new kind of
  packet; no Worker was started; the lines the ask added to the log hold no key, no address, no instruction, no
  answer, no state and no image.
- On a stand-in of a browser's serial port that answers as a calibrated arm of six servos: the same, and the port
  was given nothing but reads (the instructions 1, 2 and 0x82); after the answer it was written to again, so the
  reading went on.
- What can go wrong, each with what the page shows, that the client is closed, that no action is shown and that
  Ask is offered again: a wrong key answered 401 where the browser may show it (`AuthenticationError`, "Error
  code: 401"); the same refusal as a vLLM server sends it, outside its CORS middleware, which the browser
  withholds from the page ("Connection error"); an answer without an action ("ValueError: Final answer must end
  with a fenced json action"); Cancel while the answer streams (the phase "Thinking", the reasoning and the answer
  so far are on the page at that moment); a service that closes the connection without an answer ("Connection
  error"). After these the next ask is answered.
- With the station enabled on that page (the simulated arm, everything else in place) Ask is not offered and the
  page says to disable the station first; with the station disabled again it is offered (3 checks).
- Where a check asked at once what the page does a moment later, it now waits. What the page names as missing
  is waited for, at most five seconds, and then asserted. What the reading of the arm did is asked after the
  page's next read: the guard has counted packets again after the answer and, on the stand-in port, the port
  was written to again. (The first version asserted at once that the port had been written to since the click.
  The recorded answer can come faster than the page's next read of the arm, about ten a second, and one run of
  the whole check failed there.) Five runs of the part, one after the other: 134 checks, 0 failed each time;
  with the three checks of the station 137, 0 failed, in two more runs and in the whole check. One check read
  at once: that step 1 shows the same text after the ask as before it. It missed a change that the page renders
  with its next read of the arm, and its break did not make it fail. It now waits for the page's next render of
  the arm after the answer (the render that writes the text also writes the count of the readings, and the
  count's change is waited for), then compares; on that break both of its instances fail.
- Eight breaks made at once in a scratch copy make the part fail (the turn carries a feedback; the log is given
  the instruction; the answer gets one more byte; Ask is offered without an instruction; the page does not say
  that nothing was sent; the action is not shown as written; an ask starts a Worker; Cancel does nothing).
- Later breaks, again in a scratch copy: eight at once made 9 checks of `load`, `languages` and `ask` fail,
  each for its break: the notice of step 4 and the sentence under "One action at a time" without what is now
  true, in both languages (4); a camera that does not run told as a missing arm (1); a missing instruction told
  as a missing model service (3); a page that does not look whether the station drives the arm (1). The eighth
  break (step 1's text gets a mark once an ask has come to a result) made no check fail: see above. A page that
  stops reading the arm when the model is asked made 11 checks fail, among them that the arm was read again
  after the answer (both arms) and that the port was written to again after the answer.
- A later session closed what a person would meet (the part `ask` is now 151 checks; the whole check on the
  final files, in its two halves: 760 and 726 checks, 0 failed; vitest: 78 files, 9,198 tests):
  - An arm that is there and of which the window has no complete reading (it is still being connected, it was
    never calibrated, or its state cannot be made) is no longer told as "Missing: an arm this window reads".
    The page says "Missing: a complete reading of the arm" and points to step 1. Checked on the simulated arm
    as it leaves the factory (never calibrated): Ask is not offered, the page names the reading and not a
    missing arm; with the calibrated arm again Ask is offered (2 checks).
  - A camera that runs and gives no frame at the click: no request is made, and the panel says so itself ("The
    model was not asked: the camera runs, but it gave no fresh frame at this moment"), until the next click.
    The check takes the stream off the preview for the moment, clicks, waits for the note, and counts what the
    service saw (nothing); with the picture back the next ask is answered and the note is gone (6 checks).
  - A refusal the browser withholds: after a plain connection error the page asks the service's address,
    without a key, whether something answers there (the request of step 3's check, `isReachable` of
    `web/src/model.ts`). If it does, the panel says that the browser withheld the answer and names the two
    usual reasons as step 3 words them (a wrong key; an origin the service does not allow), in both languages,
    and the log says so without the address. A service that is gone is still told as "The model service gave
    no answer" (4 checks; the stand-in service, when gone, now answers no request at all).
  - Breaks, each in a scratch copy: three at once made the three checks of the first two items fail that
    read the page's words (a reading told as a missing arm; the sentence without "The model was not asked";
    the note left standing after the next click). A page that does not ask the address made the three checks
    of the withheld refusal fail (the sentence, the log's line, the Chinese sentence). Five more at once made
    13 checks fail that had never been shown to fail: the image decodes to 640 x 480 (both arms; the frame
    was made half as large), PEAR's word for the phase while the answer streams (written in small letters),
    PEAR's words of four failures (the message left out: a wrong key, a withheld refusal, an answer without
    an action, a service that is gone), "no arm is read: an arm is missing" and "a camera runs: a checked
    model service is missing" (three pages each). Three more at once (every connection error called a
    withheld answer; an empty frame instead of no ask; the same count of readings at every render) made 5
    fail: that a gone service is not called withheld, that no result is shown after a click without a frame,
    the sentence of that click again, and that step 1 was rendered again after the answer (both arms).

What is not proven:

- No real model service has been asked. The answer is one recorded answer of 8 pieces; a long answer, a slow
  one, a time-out, the phase "Compacting", a notice and the resending of images after a cache miss were not seen
  in a browser.
- Headless Chromium only: no person, no real camera, no real arm. The real-arm case is a stand-in port.
- That the client is closed is what the page records after `client.close()` returned; it is not observed from
  outside, and no break was made for it. Neither was a break made for the request's headers (`Origin`,
  `Authorization`), the guard's counts, the wording of a cancelled request, or the checks that Ask is offered
  before and after the station and that the arm was read again after the last answer of the failures' page.
- A frame that is not fresh is refused only as far as the browser says it (a track that is ended or muted, a
  preview without a picture). A camera whose frames stop while its track stays live and unmuted still gives its
  last picture, and an ask sends it. Four of the new checks were not shown to fail: the service saw no request
  (an ask with an empty frame, the break made for it, fails before a request is made), the camera is still
  called running, with a frame again the ask is answered, and with a complete reading again Ask is offered.
- The page's question whether something answers goes to the address's `/models`. If that answers while the
  ask's own connection was dropped for another reason, the panel still says that the browser withheld the
  answer; the sentence calls its two reasons the usual ones.
- The Chinese texts of the panel exist for every key; one sentence (the withheld refusal) was read in Chinese
  in a browser by a check, the others were not, and no person read the new sentences.

### The hand-over of a real arm's line to the Worker, reads only (2026-11-16)

The station that is to drive a real arm lives in the Worker, and a `SerialPort` cannot be passed from the window
to a Worker: each side opens the port itself, and only one of them can have it open. So before anything of the
page writes to a real servo, two things have to be known that no source settled: whether the browser gives a
Worker of this page the port the page was granted, and what the control loop's timing is on a real serial line.
The hand-over check finds out, on the person's own browser and arm, and writes nothing. The page's notice still
holds: this version writes nothing to a real arm.

What it is:

- In the station's panel, when the window reads a real arm whose six servos answer and hold a calibration, the
  control "Check the hand-over to the station (reads only)". On the press the window closes its session (as it
  does before it enables the station), asks the Worker for a `preflight` with the adapter's USB ids and what it
  read of the six servos (the model, Homing_Offset, the two position limits), and when the answer, an error or
  the time limit of 30 s has come it reads the same port again. A report that says the Worker did not close the
  port is the one exception: the window does not try to open it and says that reloading the page frees it.
- The Worker (`web/src/station_host.ts`, `preflight`), in this order:
  1. `navigator.serial.getPorts()`. A Worker cannot ask for a port (`requestPort` is the window's); it sees the
     ports its origin was granted. It takes the one port with the adapter's ids and stops when there is none or
     more than one, which the API cannot tell apart.
  2. The port is opened as the window opens it, with the read-only guard `ReadOnlyTransport` as the outermost
     transport. `web/src/station_port.ts` is the one file of the Worker's code that names `navigator.serial` or
     `getPorts`, and only the guard leaves the function that opens the port.
  3. The handshake of the window's read-only session: six servos, the model, one firmware.
  4. Whether these are the servos the window read. When they are not, nothing more is read.
  5. For each servo: torque, Lock, Status, voltage, temperature, the goal, Goal_Velocity, Torque_Limit and Phase;
     and every register PEAR's enable writes besides the goal, the torque and Lock, beside the value PEAR writes
     (45 rows: seven for each servo and three more for the gripper; a test holds the values to what the
     library's enable writes).
  6. 63 single READs one after another, timed: PEAR's enable leaves each servo without torque for the time of 63
     transactions, so this is how long the arm will be limp when the station is enabled on this line.
  7. The timing self-check of Enable on this line: 150 control periods of one SYNC READ of the positions. On a
     serial line an answer is awaited until its control period is over; one that is not whole by then counts as
     unanswered.
  8. The port is closed, whatever happened before. The robot is never given this line.
- The report on the page (`web/src/preflight_view.ts`, in both languages): where the Worker stopped and what the
  person can do, or that it read the six servos; two tables of the servos; what PEAR's enable would change, the
  rows of the EEPROM marked as surviving a power cycle; the limp time; the timing self-check with its verdict;
  what the guard let through and that it refused nothing (a refusal is shown as a defect to report); the line's
  errors. The log gets the whole report as one line, `Station: real-arm preflight {...}`: no key, no address.
- A preflight is refused while the station is enabled or being enabled, and Enable while a preflight runs.

What is proven in Node:

- `tests/web/station_preflight.test.ts` (13 tests, on the host with a stand-in of `navigator.serial`
  and simulated servos behind the shape of a browser's port): a whole preflight fills every field of the report,
  the port was given PING, READ and SYNC READ packets and nothing else, and it is closed at the end; each stop
  (no serial, no port, several ports, a port that does not open, a servo missing, another arm with nothing read
  after the comparison, the port unplugged on the way); the rules of state; the settings' rows against a record
  of what the library's enable writes; and, in real time, that the simulated arm's Enable still passes its
  timing self-check. Four breaks made in a scratch copy each fail tests: the bus given the transport beneath the
  guard, a write let through, the port left open, the comparison left out.
- `tests/web/preflight_view.test.ts` (32 tests): the report's rows and sentences in both languages for
  a full report, each stop, settings that differ and none, and a guard that refused something.

What is proven, by the part `preflight` of `web/tests/browser_check.py` (97 checks; headless Chromium; alone it
takes about ten seconds), of the read-only hand-over of a real arm's serial line to the page's Worker and back
(the request "preflight", the control "Check the hand-over to the station (reads only)"):

- The real path (no `?preflight=sim`), on a stand-in of a browser's serial port that answers as a calibrated arm
  of six servos: the control is offered, and pressing it runs the hand-over as on a real arm up to where a
  headless browser ends it. The Worker asks its own `navigator.serial`; the report's `ports` is an empty list and
  not null, so in this Chromium a Worker started from a Blob has Web Serial and its `getPorts()` answers. The
  report stops at `no-port` with nothing read, no packet given to the guard and `isClosed` true; the page shows
  the stop as an error with what to do, the Worker's own words under it, and that nothing was read, in English and
  in Chinese. By the port's own record: the window had opened it once and closed it once when the request went to
  the Worker, had not opened it again when the report came back, wrote nothing in between, then opened it again at
  1,000,000 baud and went on reading; every packet the port was ever given is a PING, a READ or a SYNC READ. The
  station's Enable is refused on this arm with its sentence, before and after.
- The whole hand-over (`?preflight=sim`, the page's simulated arm; the Worker takes a simulated port of its own):
  while it runs, Enable, the control, step 1's Connect and "Try without an arm" cannot be pressed, the window does
  not read the arm and the page says that the Worker has the line; asked all the same, the Worker refuses Enable
  and a second check. The log holds one line `Station: real-arm preflight {...}` whose JSON has the eleven fields
  of the protocol's report: `stop` null, `isClosed` true, `guard.refused` 0, no error of the line, six servos named
  as PEAR names them that hold the model and the calibration the window read, 45 settings (seven a servo, three
  more for the gripper) each with the place its address gives it, the limp time, and a timing self-check of 150
  periods that passed; the guard let through PING, READ and SYNC READ and nothing else. The page shows the
  report's twelve parts in their order, and the two tables of the servos, the settings' sentence and its rows
  (exactly the rows whose value differs from PEAR's), the limp time, the timing's numbers and verdict and the
  time are those of the JSON; in Chinese the same parts with the same numbers. The lines the hand-over wrote to
  the log hold neither the key nor the address of a model service checked before. After it the window reads the
  simulated arm again: the log says so, and a servo turned by hand shows in step 1.
- The gates: after a check the control and Enable are offered again; while the station drives the simulated arm
  the control is not shown and the Worker, asked all the same, refuses with "Station already open"; after Disable
  the control is offered again. With `?preflight=sim` a real arm (the stand-in port) is not offered the control
  and Enable is refused on it; without it the simulated arm is not offered the control.
- Another arm: one servo of the window's simulated arm is given another Homing_Offset behind the bus's back and
  the window connects again. The report stops at `other-arm`, names the difference ("servo 3 Homing_Offset: read
  1238, expected 1239"), reads nothing more and gives the line back; the page says so in both languages and the
  window reads its arm again.

What is not proven by it:

- Nothing here ran on a real arm or a real serial port. Whether a Worker's `getPorts()` gives the port that a
  person granted to the page, which is what the control exists to find out, is not answered: a headless Chromium
  has no granted port. The way "granted port, opened, read" has run only with the Worker's simulated port in the
  port's place.
- On the simulated arm "the same arm" is the same calibration: the window's simulated arm and the Worker's
  simulated port are two objects. That the Worker closed its port is there the Worker's own word (`isClosed`);
  a Worker that kept the port and said it had closed it would pass this part (`tests/web/station_preflight.test.ts`
  holds the close in Node). In the real path the Worker never has the stand-in port, so that the window can open
  a port the Worker really had and gave back is not shown either: only that the window closes it before the
  request and opens it after the report.
- The stops `no-serial`, `several-ports`, `open-failed`, `handshake-failed` and `line-lost`, a report with
  `isClosed` false, a request that fails and the time limit of 30 s are not reached in a browser; their sentences
  are held by `tests/web/preflight_view.test.ts` and the stops by the host's test.
- The timing's numbers are those of the simulated chain in a Worker, not of a serial line; and the settings are
  held against the report's JSON, not against PEAR's values (the host's test holds those).

What no test shows:

- Everything the check is there to find out: that the browser of the person with the arm gives the Worker the
  granted port, that the port opens in the Worker once the window has closed it and in the window again
  afterwards, and the numbers of a real line. No real port has been opened in a Worker by this page.
- That a port shows its streams as null exactly when it is closed (the Web Serial specification says so): the
  report's "the Worker closed the port" rests on it, because the library's transport does not tell whether the
  port's own `close()` failed.
- The limit of one control period for an answer in the timing self-check on a serial line is the page's choice.
- When no answer comes within 30 s the page says that the Worker does not answer and asks for a reload; it does
  not end the Worker itself, so the window's attempt to read the port again fails until the reload.
- After a hand-over check the Worker stays started although the station is off; nothing ends it but a reload.

## What the camera hands to a turn, in PEAR

`hardware/cameras.py` opens lerobot's `OpenCVCamera` with the station's `camera` settings (`config.yaml`: 640 x 480,
30 fps, `MJPG`) and lerobot's defaults: RGB, no rotation; lerobot converts BGR to RGB, neither flips nor crops, and
refuses a camera whose frames are not exactly the size asked. `agent_loop/messages.py` saves the frame with
`Image.fromarray(rgb).save(path, "JPEG", quality=90)`: baseline, 4:2:0, PIL's standard Huffman tables. The page
asks the camera for exactly 640 x 480 and ideally 30 fps, draws the frame unscaled on a canvas without an alpha
channel and encodes it with `canvas.toBlob("image/jpeg", 0.9)` (`JPEG_QUALITY / 100`).

## How it was verified

2026-11-15. Windows: Node 24.18.1, Vite 8.3.8. WSL: Playwright for Python with Chromium 159.0.8154.6 (headless
shell, GPU disabled), Python 3.12. The stand-in model service answers as vLLM 0.28.0 with Starlette 1.7.0 does,
read from the source in PEAR's server environment (no model server was started).

```
npx tsc --noEmit                      # no error on web/ and src/; tests/agent/ has errors from staged-but-uncommitted changes
npm run build:web                     # dist-web/: index.html 9 kB, one script 195 kB (69 kB gzip), one style sheet 7 kB
node web/tests/build_check.mjs --names-only  # 1032 references, 0 case problems
node web/tests/build_check.mjs --out <scratch>/buildcheck
                                      # names 0 problems; builds pass with and without GITHUB_SHA; stamp "dev" / "aeb7cf3"
                                      # note: typecheck fails on tests/agent/ (staged but uncommitted); web/ and src/ pass
PW_PYTHON=<python with playwright> NODE=<node of this checkout> bash web/tests/run_check.sh --out <scratch>/check
                                      # 1013 checks, 0 failed, about 243 s; under WSL with a Windows checkout NODE=node.exe
<python with playwright> web/tests/jpeg_compare.py --pil-python <station python> --out <scratch>/jpeg
node web/tests/run_node.mjs web/tests/transport_probe_entry.ts
```

The check serves `dist-web/` and the stand-in service on 127.0.0.1 itself and watches every request without
intercepting any (a browser whose requests are intercepted stops sending its own preflights). Chromium is started
with a proxy that does not exist, which a browser bypasses only for loopback addresses, so nothing can leave the
machine.

| Part | Checks | What is checked |
| --- | --- | --- |
| load | 21 | Unofficial, experimental; the notice and the task say that this version moves only a simulated arm, in a Worker, and only reads a real one; links to the two repositories only; the guard's self-test (3 reading kinds pass, 12 writing or malformed inputs refused); Stop visible, fixed and disabled; the key's field is a password field; no form |
| stamp | 14 | The build stamp in the footer and as the first line of the log; "dev" when built without `GITHUB_SHA`, the first 7 characters of the commit when built with one; the pinned PEAR commit in both places |
| sim | 23 | From the button to the live read-out, about ten readings a second; six servos, model 777, torque off as found; the registers shown are the servos'; a slider and the keyboard move a joint; Disconnect; `?arm=sim` |
| expected | 203 | Four poses set by the sliders: every joint value equals Node's within 1e-12 and as shown within its last digit, in rad (the gripper as an opening); the six quantities of the model's state equal Node's and show PEAR's decimals and units; the turn's text is Node's, byte for byte; the mark against PEAR's limits (inside, within the feedback tolerance, outside) with PEAR's own refusal quoted |
| guard | 23 | Six writing calls of the bus on the live connection (`write` Torque_Enable and Goal_Position, `syncWrite`, `enableTorque`, `writeCalibration`, `configureMotors`): each throws `ReadOnlyViolation`, nothing but pings and reads reaches the simulated servos, no register changes; refusals counted and logged |
| cable | 14 | The simulated cable pulled while reading: said, with a retry; a retry without the cable; reading resumes with it, without a reload; servos that stop answering are told apart from a lost port and recover; nine line errors and the arm is still read |
| faults | 19 | A servo missing (named, with where to look), a servo in error (PEAR's word for the bit; still read), factory registers (never calibrated: raw positions only), nothing answers (scanned at every baud rate), an echoing adapter; the servos received pings and reads only |
| calibration | 67 | A file equal to the registers; a range and an offset that differ, found per servo, with PEAR's refusal quoted; a motor missing from the file; three files that are no calibration; an equal file with another drive mode (the joints then follow the file, as in PEAR: equal to Node's); a file chosen before the arm |
| serial | 18 | The Connect button on a stand-in `navigator.serial`: none (which browsers have it), no port chosen, a port that cannot be opened, a port on which nothing answers (opened 1,000,000 8N1, only pings and reads written, closed, tried again at all baud rates) |
| diagnostics | 81 | First-contact log: browser and platform, port USB ids, baud rate; line trace in hex for a failed handshake and read; scenarios: silent (scanned at every baud rate), servos at another baud rate (found and named), servos with other ids (found), a missing servo with trace, a garbled answer |
| camera | 50 | Chromium's fake camera: asked for exactly 640 x 480 at 30 fps; a captured frame read back from its bytes: JPEG, baseline, 640 x 480, three components, 4:2:0; the test picture through the same path, its colour bars within 12 counts (no swapped channels); no camera; a refusal the page has no words for; NotAllowedError and NotReadableError from a stand-in `getUserMedia` |
| model | 40 | No key and no name (the one served model is found); the right key (sent as a bearer token after a preflight without it); a wrong key as vLLM refuses it (withheld by the browser: both reasons, the origin and what the operator must allow); a wrong key refused with the CORS header (401 shown); an origin not allowed, and exactly allowed; several models, none, another name; no `/v1`; another service; no answer in 3 s; nothing listening; three addresses refused before any request |
| privacy | 28 | After all of the above: `localStorage`, `sessionStorage`, cookies, IndexedDB and caches empty; the key, the wrong key and a password put into an address are not in the page's address, log, text or markup; in the recorded requests the key occurs only in the `Authorization` header of requests to the addresses given as the model service; the stand-in saw it there only; the page's own question "is the address there" carried none; gone after a reload; a line trace from a failed read contains no key |
| station | 162 | The station in the page's Worker on a simulated arm, and a real arm left read-only: see "Stage A on 2026-11-16" above |
| languages | 202 | The first language by the browser's (zh-TW, zh-HK, en-GB, ja-JP); `?lang=`; in 23 states of the page (reading, seven faults including ids-at-another-baud-rate and other-ids, probing status, limits, cable, three calibration verdicts, camera, nine outcomes of the model check) no text is empty or unfilled in either language, every message of the Chinese page holds Chinese and none of the English page does |
| keyboard | 6 | Every field has a label; only native controls; Tab reaches them in the page's order after a skip link; Enter connects; a focus ring |
| layout | 33 | English and Chinese, light and dark, 1280 x 800 and 390 x 844: nothing sticks out of the viewport before a connection, while reading, with the longest message and after a failure (tables scroll in their own box); 64 screenshots |
| folder | 9 | `dist-web/index.html` from a `file://` URL: runs, styled, reads the simulated arm, captures a frame, reaches a service that allows every origin, and says that its origin is "null" to one that does not |
| subpath | 63 | The page served under `/pear.js/` (as GitHub Pages will serve it): the simulated arm, compared with Node; redirect without a trailing slash; Chinese; nothing asked outside the path; root 404s |
| hosted | 48 | The page on an https origin: mixed-content warning for a plain http address, in both languages; local-network permission states (prompt, granted, denied); a private address (not blocked as mixed content, needs the local-network permission) |
| insecure | 7 | Served under a name that is not this machine's own: no secure context, so no Web Serial and no camera, each said; the simulated arm and the test picture still work |
| log | 4 | The first line is the build stamp; `User agent:` line; the copy button puts the log on the clipboard; the log starts with what was copied |
| transport | 6 | In Node: the page's port reads on after a line error; a lost device ends the reading |
| timing | 9 | The measurement runs and writes its numbers (below) |
| selftest | 25 | Opens `selftest.html` in headless Chromium; runs Node (`selftest_expected.ts`) for the same fixtures; compares the 5 suites' passed, failed and total counts; 901 cases: feetech/packets 210, kinematics/poses 50, protocol/turn_text 180, ruckig/a_pear 460, ruckig/libm 1 |
| whole run | 5 | No uncaught error and no console error of the page's own in any page (browser reports of the request failures the model checks cause on purpose); every request went to 127.0.0.1; requests the browser did not send (mixed content, proxy refusal) counted |

Looked at by eye: 16 of the 64 screenshots (both languages, both schemes, both sizes). Nothing overflowed and
nothing was unreadable. On a phone the wider tables scroll sideways in their own box, which was kept.

**The check can fail** (each break alone, then restored; `--only` the parts named):

| Break | Result |
| --- | --- |
| `readonly.ts`: WRITE counted as a reading instruction | 5 of 24 failed (load, sim, guard): the page's own self-test refuses to connect any arm |
| `arm.ts`: the follower given the bare transport instead of the guard | 18 of 41 failed (guard): writes reached the simulated servos and changed registers |
| `main.ts`: the joints shown in degrees | 22 of 275 failed (expected, calibration): "joint value as shown: got -46.637, expected -0.814" |
| `main.ts`: the key put into `localStorage` when checking | 1 of 72 failed (privacy): "nothing in localStorage" |
| `selftest.ts`: ping always returns null | 16 of 210 failed in feetech/packets (selftest): Node expects 210 passed but the browser shows 194 |
| `selftest.ts`: kinematics x offset by 1 | 50 of 50 failed in kinematics/poses (selftest) |
| `selftest.ts`: libm oracle skipped | 33 of 461 failed in ruckig (selftest): 32 ruckig/a_pear cases differ without the oracle, and ruckig/libm reports 999 missing lookups |

## Timing in the browser

Headless Chromium 159 under WSL, the page visible and focused, simulated arm (it answers at once), from the page's
"Measure timing" button. Three runs; the widest numbers are from the first, while other work loaded the machine.
`performance.now()` steps by 0.1 ms in a page, so a single read below that reads as zero; the mean is from the 200
reads together.

| | median | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| One read of the six positions (sync read), 200 in a row | under 0.1 ms; mean 0.054 to 0.062 ms | 0.1 to 0.2 ms | 0.5 to 0.6 ms | 0.8 ms |
| `setInterval` 20 ms, idle, 500 periods | 20.0 ms | 20.1 to 21.0 ms | 20.2 to 22.3 ms | 20.3 to 23.5 ms |
| Timer aiming at its own due times, 20 ms, 500 periods | 20.1 to 20.2 ms | 20.2 to 20.7 ms | 20.3 to 22.3 ms | 20.4 to 26.9 ms (and one short period after a late one, 4 ms) |
| `setInterval` 20 ms with a read in each period, 500 periods | 20.0 ms | 20.1 to 20.7 ms | 20.2 to 23.1 ms | 20.2 to 25.9 ms |
| The read inside those periods | 0.1 to 0.2 ms | 0.2 to 0.4 ms | 0.4 to 0.5 ms | 0.6 to 2.7 ms |

No period was skipped. For the control loop: in a visible page a 20 ms timer holds its period within about 3 ms
at the 99th percentile and 6 ms at worst here, and the bus's part of a period is negligible on a simulated line.
Not measured: a hidden tab (a browser slows its timers to once a second and less), a real adapter (USB latency
and the servos' answer time are the real cost: `docs/progress/sim-bridge.md`), macOS.

## Deliberate differences

1. **The JPEG encoder is the browser's, not PIL's.** Measured in Chromium 159 against PIL 12.3.0 on the same
   640 x 480 pixels (the canvas held exactly the pixels PIL was given): a drawn bench with sensor noise, PIL 56,087
   bytes, browser 52,594 (6.2 % smaller); the page's test picture, 28,024 against 23,507 (16.1 % smaller). Both
   baseline, 4:2:0, the same quantization tables; **the decoded pictures are identical**, pixel for pixel (PSNR
   against the source 37.513 dB and 37.514 dB for both). Only the Huffman tables differ: the browser optimizes
   them. So in this browser a model decodes the same picture and the files differ in bytes and size. Not measured:
   Chrome on macOS, other browsers, a camera's own frame.
2. **The camera comes through the browser.** The pixel format cannot be asked for (PEAR asks MJPG); the frame is
   whatever the browser's video pipeline decodes and converts. Where a camera has no 640 x 480 mode a browser may
   crop and scale to it; the page then says so and that PEAR would refuse the camera. A camera that cannot give the
   size at all is started at its own, said, and a captured frame keeps that size.
3. **The model's name is a third field**, optional. The client's check needs the served name. With none given the
   page runs the check under a name no service serves, reads the service's list off the client's own request (the
   client's `fetch` option) and takes the one name served or offers the names.
4. **PEAR's start-up is not called as a whole.** `SO101Hardware.open` writes after its checks (goal positions,
   lerobot's `configure()` with its EEPROM writes, Torque_Enable), and `connectChecked` needs the file before the
   port and closes the port on a mismatch. The page calls their reading steps itself: `bus.connect(true)`,
   `bus.readCalibration()`, `bus.isCalibrated()` with the file, `servoFaults()`. Left out: enabling, and the
   requirement that every servo holds torque (the page shows torque as found).
5. **A failed handshake is explained, and a servo in error is still read.** lerobot's handshake lists a servo that
   answers with an error byte as missing. The page pings each servo by itself, tells a silent one from one in
   error, and goes on reading with sync reads, which do not look at the error byte; PEAR stops there.
6. **One read for two numbers.** The periodic read asks for the raw steps and has `bus.normalize()` convert them;
   PEAR reads normalized. The check holds the two equal (`expected_entry.ts` reads normalized).
7. **Without a file the joints are computed with the registers' calibration** (drive mode 0, which is no
   register); with a file equal to the registers, with the file's, as PEAR does.
8. **A question PEAR does not ask.** When the check failed without an answer, the page asks the address once more
   in a way that needs no permission of the service (`mode: "no-cors"`, no key, the answer unreadable), to tell
   "nothing is there" from "the browser withheld the answer".
9. **No storage at all**: no localStorage, sessionStorage or cookie, also for the language.
10. The log shows an address of the model service without its host unless it is this computer, never a query
    string or a user name, and a service's own words with the key replaced.
11. **A broadcast PING and a baud-rate scan.** When not all six servos answered a ping of their own, the page
    sends a broadcast PING (as lerobot's broadcast ping does) and, when nothing whole comes back, closes the port
    and opens it at each other baud rate a servo can be set to. This is the same thing lerobot's scan does, read-
    only. The log shows what came back (in hex) and which baud rate answered, if any.
12. **The browser description.** `navigator.userAgentData` (brands, platform, mobile flag, full versions via
    `getHighEntropyValues`), or the user agent string when it is not available.
13. **The build stamp.** The first 7 characters of `GITHUB_SHA` at build time, or `"dev"` without it, through
    Vite's `define`. The pinned PEAR commit (`PEAR_COMMIT` of `src/index.ts`). Both in the footer and as the first
    line of the log.

## Found

1. **`WebSerialTransport` ends at the first error of the stream it reads, also for the errors a port survives.**
   The Web Serial specification reports a framing error, a parity error, a break and a buffer overrun by failing
   the port's readable stream and replacing it; only a lost device ends reading. `pump()` keeps the first error
   (`this.failure = error`) and `read()` throws it from then on. Probe (`run_node.mjs transport_probe_entry.ts`,
   on a port made after the specification): after one such error every read of the bus fails with it while the
   port offers a new, unlocked stream. On a half-duplex servo line such errors are likely when the servos' power
   is switched. The page works around it (`web/src/serial_port.ts`: the same probe then reads on, one error
   counted); it belongs in the transport. Not verified: that Chrome reports these errors on a real adapter.
2. **`WebSerialTransport.close()` rejects once the device is lost** (`port.close()` on a port that is already
   closed: InvalidStateError, in the probe), so `PortHandler.closePort()` never sets `isOpen = false` and
   `bus.disconnect()` throws. The page ignores it and drops the bus.
3. **lerobot's handshake calls a servo in error "missing"** (`Missing motor IDs: - 4`), because `ping()` returns
   null for an error byte. Faithful to lerobot; misleading for a person (difference 5).
4. **A wrong key looks like a network error from a page with a vLLM server.** vLLM 0.28.0 adds its CORS middleware
   before its authentication middleware, so the 401 is produced outside the CORS middleware and carries no
   `Access-Control-Allow-Origin`; the preflight passes without a key. Read from the source, modelled by the
   stand-in, not seen on a running server. The page names both causes.
5. A page opened from a folder reads `location.origin` as `file://` but is `null` to a service; only a service
   that allows every origin answers it.
6. `SimServoChain.received` grows with every packet; a page that reads for hours trims it (`sim_port.ts`).
7. An echoing adapter can be recognised: a broadcast packet (SYNC READ) that comes back is no servo's answer. The
   guard watches for it and the page says so; the bus still cannot work with such an adapter.
8. The reorganisation of the error classes (their `name` is now Python's) did not touch the page: it tells the
   bus's errors apart with `instanceof`.
9. **Mixed content on an https page.** Measured in Chromium 159 on an https origin: a plain http fetch to a public
   host is blocked as mixed content before sending. A fetch to a private address (192.168.x.x) is NOT blocked as
   mixed content (only a console warning); it goes to the network but needs the `local-network-access` permission.
   A fetch to 127.0.0.1/localhost needs no mixed-content exception but does need the local-network permission.
   `navigator.permissions.query` knows `loopback-network`, `local-network`, `local-network-access`.
10. **An echo must be checked even when every servo answered.** When the line echoes, the echo of a servo's ping
    looks like a status packet with a non-zero error byte; the bus counts it as an answering servo. The echo is
    detected reliably only by a sync read, where a broadcast packet returning is no servo's answer.

## Not verified

- On a real arm, anything beyond what "What the first try showed" below lists as seen; Chrome itself on macOS (the
  first try was in Brave 157, which is Chromium 157) and the text of its permission prompts.
- That real STS3215 servos answer a broadcast PING one after another (the simulated ones do; lerobot's broadcast
  ping relies on this).
- Reopening a real adapter at other baud rates.
- `SerialPort.getInfo()` and `navigator.userAgentData` on Chrome for macOS (in Brave 157 for macOS both answered:
  the adapter's USB vendor and product; the brands, the platform, its version and the architecture).
- That a servo's status packet carries its Status register in the error byte (as the simulated servos do), which
  "a servo reports an error" rests on.
- That Chrome reports line errors by failing and replacing the stream (the specification says so), and what it
  does when the servos have no power.
- Chrome's own refusal of a camera (NotAllowedError): a headless browser refuses otherwise; the message was shown
  through a stand-in. A camera without a 640 x 480 mode: Chromium's fake camera has one.
- A vLLM server reached directly from the page. The one real service that has answered ("The first answer of a
  real model" below) stood behind a gateway that answers the CORS preflight itself.
- Chrome's mixed-content and local-network-access behaviour on a public origin (only headless Chromium 159 was
  measured; what Chrome on macOS asks a person on the real GitHub Pages address is not known).
- GitHub Pages itself and the job's `npm ci` on Linux.
- Firefox and Safari (the message for a browser without Web Serial was shown by taking `navigator.serial` away
  from Chromium); a screen reader; a hidden tab.

## First try on a real arm

Before: the arm's motors set up and calibrated with lerobot; every program that talks to the arm closed; Chrome
on the Mac; the page at https://daaab.github.io/pear.js/ (or `dist-web/` opened as a file).

1. Open the page. It should show the notice and, under Arm, "Self-test of the read-only guard ...: 3 of 3 ... 12
   of 12 ...". "This browser has no Web Serial": wrong browser.
2. Optional: "Try without an arm" shows what a healthy arm looks like. Then Disconnect.
3. Plug the arm's USB cable in, switch the servos' power on, press Connect and pick the adapter in Chrome's list
   (it appears and disappears with the cable). Within two seconds: "Connected. The joints are read about ten times
   a second." and a Servos table of six rows: answers, model 777, one firmware, no error, the supply's voltage,
   torque off. Otherwise a box says what the page found: do what it says once, then send the log.
4. Calibration: six rows that are not all "0" and "0 - 4095". Load the calibration file: "... is equal to the
   servos' registers".
5. Move each joint by hand: its raw position and PEAR's value follow at once, the marks stay "inside" in ordinary
   poses, and x, y, z change by about as many cm as the fingertip moves. Close and open the jaw: 0 and 1.
6. Camera: choose the wrist camera, Start, allow. "640 x 480 ... This is the frame size PEAR asks for." Capture: a
   JPEG of 640 x 480 with its size in bytes.
7. Model: the base URL and the key, Check: "The service answers, accepts the key and serves ...".
8. With the arm connected press "Measure timing" (half a minute). Then, in step 4, "Check the hand-over to the
   station (reads only)": a few seconds in which the Worker has the arm's line and nothing is written. Its report
   says whether the Worker reached the adapter and what the control loop's timing is on this line.
9. Pull the USB cable: "The connection to the arm was lost". Plug it in, Connect: reading again.
10. Send back: the log ("Copy the log"; it holds no key and no address of the service), the step that did not
    fit, and a screenshot of the box if there was one.

### What the first try showed (2026-11-16)

One try, by the project's owner, of the page as published at 13275b2: an SO-101 follower whose servos are supplied
with 12 V, a Mac (macOS 27.2.1, arm64), Brave 157 (Chromium 157) in a visible window; steps 1, 3, 4 and 6 of the
list above. From the page's log and three screenshots:

- Step 1: the guard's self-test, 3 of 3 and 12 of 12; a secure context, Web Serial present.
- Step 3: the adapter is USB vendor 1a86, product 55d3; it opened at 1,000,000 baud, 8 data bits, no parity, 1
  stop bit; the handshake passed (six servos answer, model 777, firmware 3.10); the joints were being read about
  ten times a second (the 179th read when the screenshot was taken); the five servos in the screenshot report no
  error, 11.8 to 12.0 V and 34 to 37 °C. Not as the list expects: torque was on at all six servos, left on by an
  earlier program. The page said so, named the joints, and changed nothing.
- Step 4: the six rows hold a calibration (no factory values). No file was loaded. The three joints in the
  screenshot were inside PEAR's limits, their values computed from the registers.
- Step 6: the wrist camera gave 640 x 480 at 30 frames a second with resize mode none; the captured frame is a
  JPEG of 640 x 480, 29,353 bytes, quality 90, 4:2:0.

Not tried in it: moving the joints by hand (step 5; torque was on), a calibration file, the model (step 7),
"Measure timing" (step 8), pulling the cable (step 9). Chrome itself was not used.

What the owner asked for after it, and what was done: he took the file chooser to mean that the page cannot read
the calibration from the arm. It can and does: the table and the joint values come from the servos' registers.
The Calibration section now says that the page needs no file and that the file is optional (both languages). He
also asked for a Home of the real arm: not in this stage, the page still writes nothing to a real arm.

### The first answer of a real model (2026-11-16)

One ask, made by the project from the published page (build c2e6681) in headless Chromium 159 on Linux, with the
page's simulated arm and its test picture. The service was PEAR's own model server (the weights
`Qwen3.8-27B-PEAR-NVFP4` with their draft model, on one GPU) behind a gateway that speaks the OpenAI protocol over
HTTPS on a private network address and answers CORS for the page's origin alone.

- Step 3's check: "The service answers, accepts the key and serves ...", after 0.1 s.
- "Ask the model once" with the instruction "Pick up the green can.": the request's messages were 36,200 bytes of
  JSON (a system prompt of 4,193 characters, a turn text of 199, one JPEG of 640 x 480 and 23,599 bytes). The
  answer came after 13.0 s: 9,883 characters of reasoning, streamed, and an answer of 99 characters that ends in
  an action, which the page read and did not execute. The client reported 1,404 input and 2,639 output tokens, the
  first visible output after 1.4 s and 203 tokens a second. In its reasoning the model said that the picture is a
  test picture and holds no green can.
- The log held neither the key nor the address (it writes `https://<host>/v1/models`), and the page asked no host
  but its own and the service's.
- Chromium's Local Network Access checks were switched off for this run
  (`--disable-features=LocalNetworkAccessChecks`): the service's address is in the address space Chromium calls
  local, and a headless browser has nowhere to show the permission's prompt. With the checks on, the same page
  said "Nothing answers at this address" with its paragraph about the browser's permission, and the log held
  `local-network=prompt`. What a person is asked in a browser with a window is still not known.

## Requests

For the coordinator's files:

- `README.md`: the status rows `web` and "Nothing has been run in a browser yet"; under Develop `npm run build:web`
  and the check's command.
- `docs/DESIGN.md`: the module map's `web/ (next)`; the JPEG encoder among the deliberate differences; the timer
  numbers where it says what a page's timers add is still to be measured.
- `package.json`: a script for the check (`bash web/tests/run_check.sh`) and the build check
  (`node web/tests/build_check.mjs`) if wanted; nothing else. No dependency was added.
- `src/feetech/transport.ts`: Found 1 and 2.

## Left

- Stage A: a Recover control for a fault while driving; the page while the Worker is gone; a Home ended by a
  hidden page, seen in a run.
- The page in a browser with a visible window and on macOS (the log's lines `Station: timing self-check` and
  `Station: clock` are the measurement to send back), in a tab that is really hidden; a real arm, read-only
  first.
- Stage B: the wrist camera and the model in the Worker, so that a turn of PEAR's agent loop drives the
  simulated arm.
- A real arm: the hand-over check on one (the log's line `Station: real-arm preflight`); then the stage that
  writes, with the person beside the arm: Enable behind a second guard that lets through only what PEAR's station
  writes, Home with its approval, Stop and Disable.
- `web/tests/build_check.mjs`: on the second version only its comparison of names was run, in a checkout
  without the installed packages (1,316 references; the one it did not find is a file of an installed
  package). Its clean build was not run; the job's steps (install, type check, tests, build) were run on
  Linux instead.
