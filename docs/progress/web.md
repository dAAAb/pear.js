# Progress: web

The page a person opens to use pear.js with their own SO-101 (`web/`). With a real arm it is read-only on purpose:
it connects to the arm over Web Serial, shows that it is the arm PEAR expects, reads it live, shows the wrist
camera and the frame a turn would send, and checks the model service; it never enables torque and never writes to
a servo. A simulated arm lets anyone try it, and a machine test it, without hardware; on that simulated arm, and
only there, the second version's stage A runs PEAR's station in a Worker of the page, driven by hand ("The
station in a Worker, on a simulated arm" below).

State: published. The first, read-only version on 2026-11-15; the second version's stage A on 2026-11-16.

Checked on 2026-11-16, on the files as published: `npm run typecheck` passes; `npm run build:web` gives three
files; 1,272 browser checks pass in 25 parts, 0 failed; `npx vitest run` passes (76 files, 9,180 tests).
**Nothing here has met a real adapter, a real servo, a real camera, a browser with a visible window or macOS**;
"First try on a real arm" below is how that is to happen.

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
  frame). It is never handed a port. It answers the requests of `web/src/station_protocol.ts` (enable, stop,
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

- A real USB adapter, a real servo, a real camera, macOS, Chrome's port chooser and its permission prompts.
- That real STS3215 servos answer a broadcast PING one after another (the simulated ones do; lerobot's broadcast
  ping relies on this).
- Reopening a real adapter at other baud rates.
- `SerialPort.getInfo()` and `navigator.userAgentData` on Chrome for macOS.
- That a servo's status packet carries its Status register in the error byte (as the simulated servos do), which
  "a servo reports an error" rests on.
- That Chrome reports line errors by failing and replacing the stream (the specification says so), and what it
  does when the servos have no power.
- Chrome's own refusal of a camera (NotAllowedError): a headless browser refuses otherwise; the message was shown
  through a stand-in. A camera without a 640 x 480 mode: Chromium's fake camera has one.
- A running vLLM server or gateway; only GET `/v1/models` is checked, not that POST is allowed across origins.
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
8. With the arm connected press "Measure timing" (half a minute).
9. Pull the USB cable: "The connection to the arm was lost". Plug it in, Connect: reading again.
10. Send back: the log ("Copy the log"; it holds no key and no address of the service), the step that did not
    fit, and a screenshot of the box if there was one.

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
- `web/tests/build_check.mjs`: on the second version only its comparison of names was run, in a checkout
  without the installed packages (1,316 references; the one it did not find is a file of an installed
  package). Its clean build was not run; the job's steps (install, type check, tests, build) were run on
  Linux instead.
