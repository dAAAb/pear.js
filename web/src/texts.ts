// The page's words, in English and in Traditional Chinese as written in Taiwan. A text may hold {names} that
// i18n.ts fills in. Words that are PEAR's or lerobot's own (a joint's name, a servo's status bit, an error
// message of the library) are shown as they are in both languages: they are what a person will search for.

export const EN = {
  "page.title": "pear.js: PEAR's robot station in the browser",
  "page.tagline": "PEAR's robot station in the browser, for a LeRobot SO-101.",
  "page.notice":
    "pear.js is an unofficial, experimental port of PEAR's robot station (MIT Han Lab). This version moves only a simulated arm, in a Worker of this page. With a real arm connected it only reads: it shows your arm, your camera and your model service, and it cannot move the real arm.",
  "page.skip": "Skip to the arm",
  "page.language": "Language",
  "page.noscript": "This page needs JavaScript.",

  "arm.title": "Arm",
  "arm.lead":
    "Plug the SO-101's USB cable into this computer and switch on the servos' power supply. Then press Connect and choose the arm's serial port. The page only reads from the servos, and you can move the arm by hand while it does.",
  "arm.connect": "Connect",
  "arm.sim": "Try without an arm",
  "arm.retry": "Try the same port again",
  "arm.disconnect": "Disconnect",
  "arm.status.idle": "Not connected.",
  "arm.status.opening": "Opening the port…",
  "arm.status.handshake": "Looking for the six servos…",
  "arm.status.probing":
    "Not all six servos answered. Looking for servos with other ids and at other baud rates; this can take about ten seconds…",
  "arm.status.registers": "Reading the servos' registers…",
  "arm.status.reading": "Connected. The joints are read about ten times a second.",
  "arm.status.readingSim": "Connected to the simulated arm. The joints are read about ten times a second.",
  "arm.status.driven":
    "The station drives the simulated arm. This section shows what the station's Worker tells of it, about ten times a second. To connect an arm here, disable the station first.",
  "arm.driven.note":
    "While the station drives, the joints, the state and the turn's text here come from the Worker's status. The servos' steps and the marks against the limits are not in that status, so they are not shown.",
  "sim.driven": "The station drives this arm now: the sliders, the fault and the cable are disabled until the station is disabled.",
  "arm.status.stalled": "The servos have stopped answering. Is their power supply still on? The page keeps trying.",
  "arm.status.failed": "Not connected. The reason is below.",
  "arm.readings": "reading {count}",

  "fail.insecure.title": "This page cannot use Web Serial here",
  "fail.insecure.body":
    "A browser offers Web Serial only to a page served over https, from localhost, or opened from a folder on this computer. Open this page in one of these ways. The simulated arm works here all the same.",
  "fail.noSerial.title": "This browser has no Web Serial",
  "fail.noSerial.body":
    "The page reaches the arm through Web Serial. Chrome, Edge and Opera have it on a computer (macOS, Windows, Linux, ChromeOS). Firefox and Safari do not, and neither do the browsers of an iPhone or iPad. Open this page in Chrome or Edge. The simulated arm works here all the same.",
  "fail.noPort.title": "No port was chosen",
  "fail.noPort.body":
    "Press Connect again and pick the arm's USB adapter in the browser's list. It appears once the arm's USB cable is plugged in: pull the cable and plug it back while the list is open, and you see which entry it is. If nothing appears, try another USB cable (some carry power only) or another USB socket.",
  "fail.open.title": "The port could not be opened",
  "fail.open.body":
    "Another program is probably using it. Close whatever else talks to the arm (a lerobot script such as calibrate or teleoperate, a serial monitor, another tab with this page) and try again. If it still fails, pull the USB cable, plug it back in and press Connect.",
  "fail.silent.title": "Nothing answers on this port",
  "fail.silent.body": "The port opened, but none of the six servos answered. The usual reasons:",
  "fail.silent.power":
    "The servos have no power. The USB cable powers only the adapter board; the servos need their own power supply, plugged into the board and switched on.",
  "fail.silent.port": "This is not the arm's port. Press Connect and choose another entry.",
  "fail.silent.setup":
    "The servos were never set up. lerobot's motor setup gives each servo its ID (1 to 6) and sets 1,000,000 baud; servos fresh from the box all have ID 1.",
  "fail.silent.cable": "The cable from the adapter board to the first servo is loose.",
  "fail.silent.scanned":
    "The page also asked every servo at once, at 1,000,000 baud and at each other baud rate a servo can be set to, so that servos with other ids or another baud rate would have shown: nothing answered.",
  "fail.silent.notUsb":
    "The port you chose is not a USB adapter: it has no USB vendor id. It is most likely not the arm's port (on a Mac, the Bluetooth port is such an entry). Press Connect and choose another entry.",
  "fail.partial.title": "Some servos answer and some do not",
  "fail.partial.body": "Answering: {answering}. Not answering: {missing}.",
  "fail.partial.advice":
    "The servos are chained one after another, from the base to the gripper. Check the three-wire cable on both sides of the first servo that does not answer ({first}) and push its plugs all the way in. If one servo in the middle is silent and the ones after it answer, its ID may be wrong or it may be damaged.",
  "fail.partial.others":
    "Servos with other ids answer as well: {others}. A servo of this arm may have been given a wrong id; lerobot's motor setup sets it.",
  "fail.garbled.title": "The answers are damaged",
  "fail.garbled.body":
    "Something answers, but the bytes make no valid packets. Most often several servos share one ID (servos fresh from the box all have ID 1: run lerobot's motor setup first). It may also be another device than the arm on this port: then press Connect and choose another entry. The log at the bottom of the page shows the bytes.",
  "fail.ids.title": "Servos answer, but not as the ids 1 to 6",
  "fail.ids.body":
    "None of the ids 1 to 6 answered when asked by itself, yet when every servo was asked at once these ids answered: {found}. PEAR expects six servos with the ids 1 to 6, from the base to the gripper; lerobot's motor setup gives each servo its id. If the ids listed are among 1 to 6, the line is unreliable or several servos share an id: check the cables and the power supply.",
  "fail.baud.title": "The servos are set to another baud rate",
  "fail.baud.body":
    "Nothing answered at 1,000,000 baud, but at {baud} baud these ids answered when every servo was asked at once: {found}. PEAR and lerobot talk to the servos at 1,000,000 baud; lerobot's motor setup sets each servo to it.",
  "fail.echo.title": "The adapter sends the page's own bytes back",
  "fail.echo.body":
    "The page received what it had just sent. The servos use one wire for both directions, and this adapter does not take its own bytes off the line. pear.js cannot work with such an adapter yet. The adapter board that comes with the SO-101 does not do this.",
  "fail.model.title": "These are not the servos PEAR expects",
  "fail.model.body": "PEAR drives Feetech STS3215 servos, whose model number is 777. Found: {found}.",
  "fail.lost.title": "The connection to the arm was lost",
  "fail.lost.body":
    "The USB cable was pulled, or the adapter disappeared. Plug it back in and press Connect. The page does not need to be reloaded.",
  "fail.unexpected.title": "Something unexpected happened",
  "fail.unexpected.body": "This is probably a defect in pear.js. Please copy the log at the bottom of the page and report it.",
  "fail.browserSaid": "The browser said: {detail}",
  "fail.detail": "Detail: {detail}",

  "warn.servoError.title": "A servo reports an error",
  "warn.servoError.body":
    "{faults}. PEAR does not start while a servo reports an error. Look at the voltage and temperature in the table: “voltage” usually means a power supply of the wrong voltage or one that sags, “overload” that a joint was blocked, “temperature” that a servo is hot. Switching the servos' power off and on clears most errors.",
  "warn.firmware":
    "The servos run different firmware versions ({versions}). lerobot refuses such an arm; update the servos with Feetech's software until all run the same version.",
  "warn.handshake":
    "The first handshake failed, but every servo answered when asked again. The connection may be unreliable: check the cables. lerobot said: {message}",
  "warn.torque":
    "Torque is on for {motors}. Another program left it on, so these joints resist your hand. This page does not change it; switching the servos' power off and on releases them.",
  "warn.uncalibrated.title": "This arm was never calibrated",
  "warn.uncalibrated.body":
    "All six servos hold the values they left the factory with (offset 0, range 0 to 4095). PEAR needs lerobot's calibration: run lerobot's calibration of the SO-101 follower once (it stores the values in the servos and writes a calibration file), then connect again. Until then the page can show raw positions only.",
  "warn.partlyFactory":
    "{motors} hold factory values (offset 0, range 0 to 4095) while the other servos are calibrated. The calibration looks incomplete: run lerobot's calibration again.",
  "warn.bounds.title": "A joint is outside PEAR's limits",
  "warn.bounds.body":
    "PEAR would refuse to move from this pose: {message}. Move the marked joint back inside its limits. If the arm rests outside them whatever you do, its calibration is probably off.",
  "warn.reading": "The joint values cannot be computed from these registers: {message}",
  "warn.line":
    "The serial line reported an error ({name}; {count} so far) and reading went on. This happens when the servos' power is switched on or off, or when a plug moves. If it keeps happening, check the power supply and the cables.",

  "servos.title": "Servos",
  "servos.id": "ID",
  "servos.joint": "Joint",
  "servos.answer": "Answer",
  "servos.model": "Model",
  "servos.firmware": "Firmware",
  "servos.status": "Status",
  "servos.voltage": "Voltage",
  "servos.temperature": "Temperature",
  "servos.torque": "Torque",
  "servos.answer.ok": "answers",
  "servos.answer.silent": "no answer",
  "servos.answer.garbled": "damaged answer",
  "servos.answer.error": "answers with an error",
  "servos.status.ok": "no error",
  "servos.torque.on": "on",
  "servos.torque.off": "off",

  "cal.title": "Calibration",
  "cal.lead":
    "lerobot's calibration stores each servo's homing offset and range in the servo itself and in a calibration file. The table shows what the servos hold, read from the arm just now, and the joint values below are computed from it: this page needs no file. PEAR's own station also loads the file and starts only when the two are equal, so you can load yours here to compare them.",
  "cal.id": "ID",
  "cal.joint": "Joint",
  "cal.offset": "Homing offset",
  "cal.range": "Range (steps)",
  "cal.file": "In the file",
  "cal.same": "Same?",
  "cal.same.yes": "same",
  "cal.same.no": "differs",
  "cal.same.missing": "not in the file",
  "cal.fileLabel": "lerobot calibration file (.json), optional",
  "cal.fileHint":
    "lerobot keeps it under ~/.cache/huggingface/lerobot/calibration/robots/, in a folder named after the robot type, as <id>.json. In the macOS file dialog press Cmd+Shift+G to type that path; folders that begin with a dot are hidden, and Cmd+Shift+. shows them. The file stays on this computer.",
  "cal.remove": "Remove the file",
  "cal.verdict.equal": "{name} is equal to the servos' registers. PEAR's start-up check passes.",
  "cal.verdict.different":
    "{name} differs from the servos' registers. PEAR would stop with “Servo calibration registers differ from the calibration file”. Either this is another arm's file, or the arm was calibrated again after the file was written. Use the file of the last calibration, or calibrate again.",
  "cal.verdict.missing": "The file has no entry for: {motors}.",
  "cal.verdict.unchecked": "{name} could not be compared: {problem}",
  "cal.verdict.waiting": "{name} is loaded. It is compared as soon as an arm is read.",
  "cal.verdict.invalid": "This is not a lerobot calibration file: {problem}",

  "joints.title": "Joints, live",
  "joints.lead":
    "Move the arm by hand and the numbers follow. PEAR's value of a joint is lerobot's reading in radians; the gripper's is its opening, from 0 (closed) to 1 (open).",
  "joints.joint": "Joint",
  "joints.raw": "Raw position (steps)",
  "joints.value": "PEAR's value",
  "joints.limits": "PEAR's limits",
  "joints.within": "Within the limits?",
  "joints.unit.rad": "rad",
  "joints.unit.opening": "opening",
  "joints.mark.inside": "inside",
  "joints.mark.tolerated": "outside, within tolerance",
  "joints.mark.outside": "outside",

  "state.title": "What the model would be shown",
  "state.lead":
    "The fingertip's position in cm, its pitch and roll in rad, and the gripper's width, as PEAR computes them from these joints. The width assumes PEAR's default jaw, 0 to 6 cm; a station measures its own.",
  "state.none": "Not available without calibrated joint values.",
  "state.turn": "The text of the turn",

  "sim.title": "Simulated arm",
  "sim.lead":
    "Six simulated servos behind a simulated serial port. The page reads them exactly as it reads a real arm. The sliders move the servos directly, as your hand would.",
  "sim.scenario": "What is wrong with it",
  "sim.scenario.normal": "Nothing: a calibrated arm",
  "sim.scenario.missing": "One servo does not answer (elbow_flex)",
  "sim.scenario.error": "One servo reports an error (wrist_flex: overload)",
  "sim.scenario.factory": "Never calibrated (factory registers)",
  "sim.scenario.silent": "Nothing answers (servo power off)",
  "sim.scenario.ids": "The servos have other ids (11 to 16)",
  "sim.scenario.baud": "The servos are set to 115,200 baud",
  "sim.scenario.echo": "The adapter sends bytes back",
  "sim.scenarioHint": "Choosing one connects again.",
  "sim.unplug": "Pull the USB cable",
  "sim.plug": "Plug the cable back in",
  "sim.steps": "{value} steps",

  "guard.line": "Read-only: {sent} packets sent to the servos, every one a ping or a read ({detail}). Writes refused: {refused}.",
  "guard.idle": "Read-only: nothing has been sent to a servo yet.",
  "guard.selftest":
    "Self-test of the read-only guard when the page loaded: {reading} of {readingTried} kinds of reading packets passed, {writing} of {writingTried} writing or malformed ones refused.",
  "guard.broken.title": "The read-only guard failed its self-test",
  "guard.broken.body": "Do not connect an arm with this page. {failures}",

  "camera.title": "Camera",
  "camera.lead":
    "PEAR looks through one camera on the wrist. It asks the camera for 640 × 480 at 30 frames a second, and each turn it sends the model one frame as a JPEG of quality 90, neither rotated nor cropped.",
  "camera.select": "Camera",
  "camera.option.default": "The browser's choice",
  "camera.option.unnamed": "Camera {number}",
  "camera.option.test": "Test picture (no camera needed)",
  "camera.start": "Start the camera",
  "camera.stop": "Stop the camera",
  "camera.capture": "Capture a frame",
  "camera.hint":
    "The wrist camera is usually the one in the list that is not your laptop's own. The browser asks for permission the first time.",
  "camera.status.off": "The camera is off.",
  "camera.status.starting": "Starting the camera…",
  "camera.status.live": "{label}: {width} × {height}{rate}.",
  "camera.status.rate": ", {fps} frames a second",
  "camera.status.test": "Test picture",
  "camera.status.unnamed": "Camera",
  "camera.size.ok": "This is the frame size PEAR asks for.",
  "camera.size.rescaled":
    "This camera has no 640 × 480 mode of its own: the browser crops and scales its picture to that size. PEAR's own station would refuse this camera.",
  "camera.size.other":
    "This camera delivers {width} × {height}, not the 640 × 480 PEAR asks for. A captured frame keeps the camera's size. PEAR's own station would refuse this camera.",
  "camera.preview": "Preview",
  "camera.captured": "The frame a turn would send",
  "camera.capturedNone": "No frame captured yet.",
  "camera.info": "JPEG, {width} × {height}, {bytes} bytes, quality {quality}, {subsampling}",
  "camera.encoder":
    "The frame is encoded by this browser; PEAR encodes with PIL. Size and quality setting are the same, the bytes are not.",
  "camera.fail.unavailable":
    "This page cannot use a camera here: a browser offers cameras only to a page served over https, from localhost, or opened from a folder on this computer. The test picture works all the same.",
  "camera.fail.NotAllowedError":
    "The camera was not allowed. Allow it for this page in the browser (the camera icon in the address bar, or the site's settings). On macOS the browser itself needs permission too: System Settings › Privacy & Security › Camera.",
  "camera.fail.NotFoundError": "No camera was found. Plug in the wrist camera's USB cable; it then appears in the list.",
  "camera.fail.NotReadableError":
    "The camera could not be started. Another program is probably using it (a video call, lerobot, another tab): close it and try again.",
  "camera.fail.TrackEnded":
    "The camera stopped delivering frames. Was its cable pulled? Plug it back in and start the camera again.",
  "camera.fail.other": "The camera could not be started: {name}: {message}",
  "camera.captureProblem": "No frame could be captured: {problem}",

  "model.title": "Model",
  "model.lead":
    "pear.js needs a service that serves a PEAR model through the OpenAI-compatible API, such as PEAR's own vLLM server. Check here that this page can reach it.",
  "model.baseUrl": "Base URL",
  "model.baseUrlHint": "The address up to the API version, ending in /v1.",
  "model.name": "Model name (optional)",
  "model.nameHint": "The name the service serves the model under. Leave it empty if the service serves one model.",
  "model.key": "API key",
  "model.keyHint":
    "Kept in this page's memory only, until you close or reload it. It is never stored and never written to the log. Leave it empty for a service that asks for none.",
  "model.check": "Check",
  "model.checking": "Checking…",
  "model.unchecked": "Not checked yet.",
  "model.ok": "The service answers, accepts the key and serves {model}.",
  "model.okFound": "The name was taken from the service's own list.",
  "model.notServed": "The service answers and accepts the key, but serves no model named {model}. It serves:",
  "model.choose": "The service answers and accepts the key. It serves several models; choose one:",
  "model.none": "The service answers and accepts the key, but its list of models is empty.",
  "model.use": "Use {model}",
  "model.key.refused":
    "The service refused the key (HTTP {status}). Check the key. For a service that asks for none, leave the field empty.",
  "model.notFound":
    "The address answers, but there is no model list at {where} (HTTP 404). A base URL usually ends in /v1.",
  "model.http": "The service answered with an error (HTTP {status}).",
  "model.timeout":
    "No answer within 3 seconds. The service may still be starting, be overloaded, or be out of reach of this computer.",
  "model.blocked.title": "The service is there, but the browser withheld its answer",
  "model.blocked.body":
    "Something answers at this address, yet the browser did not let this page read the answer, and a browser does not say why. There are two usual reasons:",
  "model.blocked.origin":
    "The service does not allow this page's origin ({origin}). Its operator must allow requests from that origin: the methods GET and POST, the headers Authorization and Content-Type, and the browser's preflight request (OPTIONS) without a key. A vLLM server allows every origin unless it was started with --allowed-origins.",
  "model.blocked.key":
    "The key is wrong. A vLLM server refuses a wrong key without the header a browser needs before it shows a refusal to a page, so from here a wrong key looks exactly like this.",
  "model.blocked.folder":
    "This page was opened from a folder, so its origin is “null”: only a service that allows every origin (*) can be reached from it.",
  "model.unreachable.title": "Nothing answers at this address",
  "model.unreachable.body":
    "The browser could not reach {where}. Check the address and the port, that the service is running, and that this computer can reach it (same network, VPN, firewall).",
  "model.mixed.title": "This page is on https, and the address is plain http",
  "model.mixed.body":
    "The browser gave this page no answer from {where}. A page loaded over https is normally not allowed to ask a plain http address on another machine: the browser refuses the request before it is sent, and tells the page only that it failed. There are two ways out:",
  "model.mixed.https":
    "Give the service an https:// address, for example with a reverse proxy or a tunnel that has a certificate, and enter that.",
  "model.mixed.same":
    "Or open this page on the same machine as the service and enter http://127.0.0.1 or http://localhost with the service's port: a browser lets an https page ask this computer itself.",
  "model.mixed.local":
    "This address is on a local network. Newer versions of Chrome let an https page ask such an address when it is written as numbers, once you allow the page to reach the local network; other browsers refuse it.",
  "model.permission.prompt":
    "If the service is on this computer, on your local network or behind a VPN, Chrome asks whether this page may connect to devices on the local network. Allow it. If the question did not appear or you closed it, press Check again.",
  "model.permission.denied":
    "Chrome's permission for this page to connect to devices on the local network is set to block. Open the site's settings (the icon to the left of the address), allow it and press Check again.",
  "model.refused": "This address or key cannot be used. Give an http:// or https:// address without a user name or password in it.",
  "model.notService":
    "The address answers, but not as a model service does: {where} did not return a list of models. Is the address right?",
  "model.clientSaid": "The client said: {message}",

  "task.title": "Task",
  "task.notice":
    "This version moves only a simulated arm, in a Worker of this page. With a real arm connected it only reads and cannot move the real arm. It can ask a model once and show the answer: it does not execute the action the model asks for, and no model drives an arm yet. On the simulated arm you can try the station by hand below: enable it, move it one small step at a time, send it Home and stop it.",
  "task.instruction": "Instruction",
  "task.placeholder": "Put the red block into the box.",
  "task.start": "Start",
  "ask.title": "Ask the model once",
  "ask.lead":
    "Sends the model what the first turn of a task would send: PEAR's system prompt with the instruction above, the arm's state as step 1 shows it, and the camera's frame of this moment. The answer is shown as it arrives. The action the model asks for is shown and not executed: nothing is sent to the arm.",
  "ask.button": "Ask the model once",
  "ask.cancel": "Cancel",
  "ask.need.station": "The station is driving the simulated arm, so this window does not read it. Disable the station first.",
  "ask.need.arm": "Missing: an arm this window reads. Start the simulated arm or connect an arm in step 1.",
  "ask.need.reading":
    "Missing: a complete reading of the arm. This window is connected to an arm, but has no complete reading of it yet; step 1 shows what it reads and what it lacks.",
  "ask.need.camera": "Missing: a running camera. Start one in step 2.",
  "ask.noFrame":
    "The model was not asked: the camera runs, but it gave no fresh frame at this moment. Look at the picture in step 2; when it shows the camera's view again, ask once more.",
  "ask.need.model":
    "Missing: a checked model service. Check it in step 3; after a change of the address, the name or the key, check again.",
  "ask.need.instruction": "Missing: an instruction. Write one above.",
  "ask.status.asking": "Asking the model…",
  "ask.status.action": "The model answered after {seconds} s, and its answer ends in an action.",
  "ask.status.noAction": "The model answered after {seconds} s, but its answer holds no action.",
  "ask.status.cancelled": "Cancelled after {seconds} s.",
  "ask.status.failed": "The request failed after {seconds} s.",
  "ask.sent": "What was sent",
  "ask.sent.sizes":
    "PEAR's system prompt with the instruction ({system} characters), the text below ({text} characters) and one image (JPEG {size}, {bytes} bytes).",
  "ask.phase": "The model:",
  "ask.reasoning": "Reasoning",
  "ask.answer": "Answer",
  "ask.usage": "Tokens:",
  "ask.performance": "Timings:",
  "ask.action": "The action the model asked for",
  "ask.sentence":
    "In words: move the fingertip by x {x} cm, y {y} cm, z {z} cm (+x forward, +y left, +z up), turn it by pitch {pitch} rad and roll {roll} rad, and {gripper} (gripper.width {width}).",
  "ask.gripper.open": "open the gripper",
  "ask.gripper.close": "close the gripper",
  "ask.gripper.hold": "hold the gripper as it is",
  "ask.explain.noAction": "The format reads no action of this answer. PEAR's words:",
  "ask.explain.cancelled": "The request was stopped. PEAR's words:",
  "ask.explain.failed": "The model service gave no answer. PEAR's words:",
  "ask.explain.withheld":
    "The service is there, but the browser withheld its answer from this page, and a browser does not say why. There are two usual reasons: the key is wrong (a vLLM server refuses a wrong key without the header a browser needs before it shows a refusal to a page), or the service does not allow this page's origin ({origin}). Check the service again in step 3. PEAR's words:",
  "ask.notSent":
    "Nothing was sent to the arm. This page does not execute the action; the client is closed, and the next ask is a new conversation.",
  "task.stop": "Stop",
  "task.stopNote": "Stop brakes the arm and holds it where it is. It works whenever the station holds an arm; in this version that is only the simulated arm.",

  "station.title": "The station, by hand",
  "station.lead":
    "PEAR's robot station runs in a Worker of this page: the robot, its control loop at 50 Hz and its driver. Here it drives a simulated arm that the Worker makes itself. It is never given a serial port, so nothing here can reach a real arm.",
  "station.enable": "Enable",
  "station.disable": "Disable",
  "station.disableNote":
    "Disable closes the station. On a real arm that switches the torque off, and an arm that nothing supports falls: stop with Stop, and use Disable only when the arm is parked or held.",
  "station.why.noArm": "Connect the simulated arm in step 1 first: the station starts from where that arm stands.",
  "station.why.realArm":
    "A real arm is connected. This version only reads a real arm and never writes to it, so the station cannot be enabled on it. Disconnect it and use the simulated arm to try the station.",
  "station.why.scenario": "The simulated arm is set to a fault ({scenario}). Choose the arm that works in step 1 to try the station.",
  "station.why.busy": "The arm in step 1 is still being read for the first time. Wait until its joints are shown.",
  "station.why.ready": "Enable ends the reading in step 1 and hands the simulated arm, where it stands, to the station.",
  "station.why.lost": "The station's Worker is gone. Reload the page to start again.",
  "station.status.off": "The station is off.",
  "station.status.enabling": "Enabling: checking the timing for three seconds, then opening the robot…",
  "station.timing":
    "Timing self-check before enabling (reads only): {periods} control periods, mean {mean} ms, longest {max} ms, {over} over 25 ms, longest read {read} ms: {verdict}.",
  "station.timing.passed": "passed",
  "station.timing.failed": "failed, so the station was not enabled ({failures})",
  "station.timing.fail.period": "a period took {value} ms (limit {limit} ms)",
  "station.timing.fail.over25": "{value} periods took over 25 ms (limit {limit})",
  "station.timing.fail.mean": "the mean period was {value} ms (limit {limit} ms)",
  "station.timing.fail.read": "a read took {value} ms (limit {limit} ms)",
  "station.timing.fail.unanswered": "{value} reads were not answered by every servo",
  "station.timing.fail.hidden": "the page is not visible",
  "station.timing.fail.join": "; ",
  "station.status.disabling": "Disabling…",
  "station.status.on": "Robot {robot}, control loop {control}.",
  "station.status.fault": "Robot FAULT: {fault}",
  "station.status.lostSilent": "The station's Worker does not answer ({detail}). The page cannot tell what the arm does now. If it stays so, reload the page to start again.",
  "station.status.lostDied": "The station's Worker died ({detail}). Reload the page to start again.",
  "station.periods":
    "Control periods in the last second: {count}, mean {mean} ms, longest {max} ms, {over} over 25 ms. Steps since enabling: {steps}.",
  "station.clock":
    "The Worker's clock since enabling: {sleeps} sleeps ({timers} timers, {yields} turns without a timer), {spin} ms in busy waits; a sleep ended {lateMean} ms late on average and {lateMax} ms at most; a timer fired at most {timerLate} ms late; margin {margin} ms.",
  "station.camera.arriving":
    "The wrist camera as the station sees it: frames arrive, {rate} in the last second; the last one was {age} ms old when this was told.",
  "station.camera.waiting": "The wrist camera as the station sees it: the camera runs, but no frame arrived in the last second.",
  "station.camera.stopped":
    "The wrist camera as the station sees it: no frames arrive, because the camera in step 2 does not run; the last one came {seconds} s ago. Without a fresh frame the station runs no action: start the camera in step 2 (with the simulated arm the test picture is enough).",
  "station.camera.never":
    "The wrist camera as the station sees it: no frames arrive, because the camera in step 2 does not run; none has come since enabling. Without a fresh frame the station runs no action: start the camera in step 2 (with the simulated arm the test picture is enough).",
  "station.camera.gaps":
    "Since enabling, while the camera ran, the longest time between two frames was {gap} ms; times over 200 ms, after which a frame is too old for the station: {over}.",
  "station.frame.alt": "The frame the last observation held",
  "station.frame.caption":
    "The frame the last observation held: frame {number} of those the station's camera has seen, {width} x {height}, JPEG, {bytes} bytes, {age} ms old at the observation.",
  "station.hidden": "The page was hidden: the station stopped, and it starts no action until the page is visible again.",
  "station.wasHidden":
    "The page was hidden for a while: the station stopped then. The page is visible again, and actions can be started.",
  "station.enableFailed": "The station could not be enabled: {error}",
  "station.enableFailed.timing":
    "The station could not be enabled: the timing self-check failed. Its line above gives the reasons.",
  "station.disableFailed": "The station could not be disabled: {error}",
  "station.stopFailed": "Stop got no answer: {error}",
  "station.jogTitle": "One action at a time",
  "station.jogLead":
    "Each button is one action in the model's format (single_arm_delta: centimetres and radians), executed as a turn executes it: the arm at rest, an observation, then the action from that observation. An observation holds the joints, the control state and the wrist camera's frame as the station sees it; without a fresh frame the action is not run.",
  "station.jog.open": "Gripper: open",
  "station.jog.close": "Gripper: close",
  "station.home": "Home",
  "station.planTitle": "Home: the plan",
  "station.planLead": "PEAR shows its plan before anything moves. Approve it and the arm goes Home; refuse it and nothing moves.",
  "station.approve": "Approve",
  "station.refuse": "Refuse",
  "station.action.running": "{action}: {phase}",
  "station.action.resting": "waiting for the arm to rest",
  "station.action.done": "{action}: {status}",
  "station.action.failed": "{action} did not run: {error}",
  "station.action.noFrame":
    "The station did not run this action, because it had no fresh frame of the wrist camera (a frame is fresh for 0.2 s after it arrived). If the camera in step 2 does not run, start it (with the simulated arm the test picture is enough); if it runs, run the action again: the camera's line above tells whether frames arrive.",
  "station.action.homed": "Home is done: {stages}.",
  "station.action.stopped": "{action}: you pressed Stop while it ran, so it ended there. PEAR's result is {status}.",
  "station.action.stoppedHidden":
    "{action}: the page was hidden while it ran, so the station stopped it. PEAR's result is {status}.",
  "station.action.homeStopped":
    "{action}: you pressed Stop before it was done, so it ended there. The robot says: {error}",
  "station.action.homeStoppedHidden":
    "{action}: the page was hidden before it was done, so the station stopped it. The robot says: {error}",
  "station.homeResultLead": "Home's stages, and PEAR's result for each joint:",
  "station.stateTitle": "What the station measures",
  "station.joints": "Joints, rad: {joints}",
  "station.reportTitle": "The report of the last action",
  "station.reportLead": "The sentence the model would read of it in its next turn, and below it that whole turn.",
  "station.record": "PEAR's record of the result",

  "log.title": "Log",
  "log.lead":
    "What the page did and what it found, for a report when something does not work. It holds no key and no address of your model service. The log is in English.",
  "log.copy": "Copy the log",
  "log.copied": "Copied.",
  "log.copyFailed": "Could not copy. Select the text and copy it yourself.",
  "log.label": "Log",
  "timing.button": "Measure timing",
  "timing.lead":
    "Measures how long a read of the six positions takes and how regular a 20 ms timer is in this browser. It takes about half a minute, and the numbers go to the log.",
  "timing.running": "Measuring… ({step})",
  "timing.needsArm": "Connect an arm first; the simulated one will do.",
  "timing.done": "Done. The numbers are in the log.",

  "footer.about":
    "pear.js is an independent, unofficial project. It is not affiliated with or endorsed by the PEAR project or its authors. Experimental software, provided without warranty, under the Apache-2.0 licence.",
  "footer.network":
    "This page loads nothing from other sites and sends nothing anywhere, except its requests to the model service you name.",
  "footer.commit": "pear.js build {build}. Ports PEAR at commit {commit}.",
  "footer.pearjs": "pear.js on GitHub",
  "footer.pear": "PEAR on GitHub",
} as const;

export type TextKey = keyof typeof EN;

export const ZH_TW: Record<TextKey, string> = {
  "page.title": "pear.js：在瀏覽器裡執行的 PEAR robot station",
  "page.tagline": "在瀏覽器裡執行的 PEAR robot station，搭配 LeRobot SO-101 使用。",
  "page.notice":
    "pear.js 是 PEAR（MIT Han Lab）robot station 的非官方移植，仍在實驗階段。這個版本只會讓模擬手臂動，而且是在這個頁面的 Worker 裡執行。連接真實的手臂時，它只讀不寫：會顯示手臂、攝影機與模型服務的狀態，但不會讓真實的手臂動。",
  "page.skip": "跳到手臂區塊",
  "page.language": "語言",
  "page.noscript": "這個頁面需要 JavaScript 才能運作。",

  "arm.title": "手臂",
  "arm.lead":
    "把 SO-101 的 USB 線接上這台電腦，打開伺服馬達的電源，再按「連線」並選擇手臂的序列埠。本頁只會讀取伺服馬達的資料，讀取的同時可以用手扳動手臂。",
  "arm.connect": "連線",
  "arm.sim": "沒有手臂，先用模擬的試試",
  "arm.retry": "用同一個埠再試一次",
  "arm.disconnect": "中斷連線",
  "arm.status.idle": "尚未連線。",
  "arm.status.opening": "正在開啟序列埠…",
  "arm.status.handshake": "正在尋找六顆伺服馬達…",
  "arm.status.probing": "六顆伺服馬達沒有全部回應。正在尋找其他 ID 的伺服馬達，並改用其他鮑率再問一次，大約需要十秒…",
  "arm.status.registers": "正在讀取伺服馬達的暫存器…",
  "arm.status.reading": "已連線，每秒大約讀取十次關節位置。",
  "arm.status.readingSim": "已連上模擬手臂，每秒大約讀取十次關節位置。",
  "arm.status.driven": "工作站正在驅動模擬手臂。這個區塊顯示的是工作站的 Worker 回報的狀態，每秒大約十次。要在這裡連接手臂，請先停用工作站。",
  "arm.driven.note":
    "工作站驅動手臂時，這裡的關節、狀態與回合文字都來自 Worker 的狀態回報。伺服馬達的步數和是否在限制範圍內的標記不在這份回報裡，所以不顯示。",
  "sim.driven": "這支手臂現在由工作站驅動：在停用工作站之前，滑桿、故障狀況和接線按鈕都不能用。",
  "arm.status.stalled": "伺服馬達沒有回應了。電源還開著嗎？頁面會持續重試。",
  "arm.status.failed": "沒有連上，原因請看下方。",
  "arm.readings": "第 {count} 次讀取",

  "fail.insecure.title": "這個頁面目前無法使用 Web Serial",
  "fail.insecure.body":
    "瀏覽器只讓透過 https、localhost，或直接從這台電腦的資料夾開啟的頁面使用 Web Serial。請改用其中一種方式開啟本頁。模擬手臂在這裡照樣可以用。",
  "fail.noSerial.title": "這個瀏覽器不支援 Web Serial",
  "fail.noSerial.body":
    "本頁透過 Web Serial 和手臂通訊。電腦版的 Chrome、Edge 與 Opera（macOS、Windows、Linux、ChromeOS）才有這項功能；Firefox、Safari，以及 iPhone、iPad 上的瀏覽器都沒有。請改用 Chrome 或 Edge 開啟本頁。模擬手臂在這裡照樣可以用。",
  "fail.noPort.title": "沒有選擇序列埠",
  "fail.noPort.body":
    "請再按一次「連線」，在瀏覽器跳出的清單裡選擇手臂的 USB 轉接板。接上手臂的 USB 線之後它才會出現：清單開著的時候把線拔掉再插回去，就能看出是哪一項。如果什麼都沒出現，換一條 USB 線（有些線只能充電）或換一個 USB 孔試試。",
  "fail.open.title": "無法開啟序列埠",
  "fail.open.body":
    "很可能有別的程式正在使用它。請先關掉其他會和手臂通訊的程式（lerobot 的校正或遙控腳本、序列埠監控視窗、另一個開著本頁的分頁），再試一次。還是不行的話，把 USB 線拔掉重插，再按「連線」。",
  "fail.silent.title": "這個埠沒有任何回應",
  "fail.silent.body": "序列埠開啟了，但六顆伺服馬達都沒有回應。常見的原因：",
  "fail.silent.power":
    "伺服馬達沒有電。USB 線只供電給轉接板，伺服馬達要靠另外的電源供應器：請確認它已經接上轉接板並打開開關。",
  "fail.silent.port": "選到的不是手臂的埠。請按「連線」，改選清單裡的其他項目。",
  "fail.silent.setup":
    "伺服馬達還沒有設定過。lerobot 的馬達設定（setup motors）會替每顆馬達指定 ID（1 到 6），並把鮑率設成 1,000,000；全新的馬達 ID 都是 1。",
  "fail.silent.cable": "轉接板到第一顆伺服馬達的線鬆了。",
  "fail.silent.scanned":
    "頁面也同時詢問了線上所有的伺服馬達，先用 1,000,000 的鮑率，再用伺服馬達可以設定的其他每一種鮑率；如果馬達的 ID 或鮑率不對，這樣就會現身。結果都沒有任何回應。",
  "fail.silent.notUsb":
    "你選的埠不是 USB 轉接板：它沒有 USB 廠商代碼，多半不是手臂的埠（Mac 上的藍牙埠就是這種項目）。請按「連線」，改選清單裡的其他項目。",
  "fail.partial.title": "有些伺服馬達有回應，有些沒有",
  "fail.partial.body": "有回應：{answering}。沒有回應：{missing}。",
  "fail.partial.advice":
    "伺服馬達是從底座一顆接一顆串到夾爪的。請檢查第一顆沒有回應的馬達（{first}）兩側的三線排線，把接頭壓到底。如果只有中間某一顆沒回應、後面的卻都有回應，可能是它的 ID 設錯了，或是馬達本身故障。",
  "fail.partial.others":
    "另外還有其他 ID 的伺服馬達有回應：{others}。這支手臂可能有某顆馬達的 ID 設錯了；lerobot 的馬達設定（setup motors）可以重新指定。",
  "fail.garbled.title": "收到的回應是壞的",
  "fail.garbled.body":
    "有東西在回應，但收到的位元組拼不成正確的封包。最常見的原因是好幾顆伺服馬達共用同一個 ID（全新的馬達 ID 都是 1，請先執行 lerobot 的馬達設定）。也可能這個埠接的根本不是手臂，而是別的裝置：請按「連線」，改選清單裡的其他項目。頁面最下方的紀錄裡有收到的位元組。",
  "fail.ids.title": "有伺服馬達回應，但不是 ID 1 到 6",
  "fail.ids.body":
    "逐一詢問 ID 1 到 6 時都沒有回應，但同時詢問所有伺服馬達時，有這些 ID 回應：{found}。PEAR 預期六顆伺服馬達的 ID 是 1 到 6，從底座排到夾爪；lerobot 的馬達設定（setup motors）會替每顆馬達指定 ID。如果列出的 ID 就在 1 到 6 之間，表示線路不穩，或是有好幾顆馬達共用同一個 ID：請檢查接線與電源。",
  "fail.baud.title": "伺服馬達設定的是其他鮑率",
  "fail.baud.body":
    "用 1,000,000 的鮑率詢問時沒有任何回應；改用 {baud} 的鮑率同時詢問所有伺服馬達，則有這些 ID 回應：{found}。PEAR 與 lerobot 都用 1,000,000 的鮑率和伺服馬達通訊；lerobot 的馬達設定（setup motors）會把每顆馬達設成這個鮑率。",
  "fail.echo.title": "轉接板把頁面送出的資料又傳了回來",
  "fail.echo.body":
    "頁面收到了自己剛送出去的位元組。伺服馬達收發共用同一條訊號線，而這塊轉接板不會把自己送出的資料從線上濾掉。pear.js 目前還不支援這種轉接板；SO-101 套件附的轉接板不會這樣。",
  "fail.model.title": "這不是 PEAR 預期的伺服馬達",
  "fail.model.body": "PEAR 使用的是 Feetech STS3215，型號代碼為 777。實際讀到的是：{found}。",
  "fail.lost.title": "和手臂的連線中斷了",
  "fail.lost.body": "USB 線被拔掉了，或是轉接板從系統裡消失了。請把線插回去，再按「連線」，不需要重新整理頁面。",
  "fail.unexpected.title": "發生了預期之外的狀況",
  "fail.unexpected.body": "這多半是 pear.js 本身的問題。請複製頁面最下方的紀錄並回報。",
  "fail.browserSaid": "瀏覽器回報：{detail}",
  "fail.detail": "詳細訊息：{detail}",

  "warn.servoError.title": "有伺服馬達回報錯誤",
  "warn.servoError.body":
    "{faults}。只要有伺服馬達回報錯誤，PEAR 就不會啟動。請看表格裡的電壓與溫度：「voltage」通常表示電源供應器的電壓不對或供電不穩，「overload」表示關節被卡住，「temperature」表示馬達過熱。把伺服馬達的電源關掉再打開，多數錯誤就會消失。",
  "warn.firmware":
    "伺服馬達的韌體版本不一致（{versions}）。lerobot 不接受這樣的手臂；請用 Feetech 的軟體把所有馬達更新到同一個版本。",
  "warn.handshake":
    "第一次交握（handshake）失敗，但再問一次時每顆伺服馬達都有回應。連線可能不穩定，請檢查接線。lerobot 的訊息：{message}",
  "warn.torque":
    "{motors} 的扭力目前是開著的。先前有其他程式沒把它關掉，所以這幾個關節用手扳不太動。本頁不會去更動它；把伺服馬達的電源關掉再打開，關節就會放鬆。",
  "warn.uncalibrated.title": "這支手臂還沒有校正過",
  "warn.uncalibrated.body":
    "六顆伺服馬達存的都是出廠值（偏移 0、範圍 0 到 4095）。PEAR 需要 lerobot 的校正結果：請先對 SO-101 follower 執行一次 lerobot 的校正（它會把數值寫進伺服馬達，並產生一份校正檔），再重新連線。在那之前，本頁只能顯示原始位置。",
  "warn.partlyFactory":
    "{motors} 存的是出廠值（偏移 0、範圍 0 到 4095），其他馬達則已經校正。校正看起來沒有做完，請重新執行 lerobot 的校正。",
  "warn.bounds.title": "有關節超出 PEAR 的限制範圍",
  "warn.bounds.body":
    "從這個姿勢開始，PEAR 會拒絕動作：{message}。請把標示出來的關節扳回範圍內。如果怎麼擺都在範圍外，多半是校正有偏差。",
  "warn.reading": "無法從這些暫存器算出關節值：{message}",
  "warn.line":
    "序列線路回報了錯誤（{name}，目前累計 {count} 次），頁面仍繼續讀取。開關伺服馬達的電源，或是接頭晃動時，都可能出現這種狀況；如果一直發生，請檢查電源供應器與接線。",

  "servos.title": "伺服馬達",
  "servos.id": "ID",
  "servos.joint": "關節",
  "servos.answer": "回應",
  "servos.model": "型號",
  "servos.firmware": "韌體",
  "servos.status": "狀態",
  "servos.voltage": "電壓",
  "servos.temperature": "溫度",
  "servos.torque": "扭力",
  "servos.answer.ok": "有回應",
  "servos.answer.silent": "沒有回應",
  "servos.answer.garbled": "回應損壞",
  "servos.answer.error": "有回應，但回報錯誤",
  "servos.status.ok": "沒有錯誤",
  "servos.torque.on": "開",
  "servos.torque.off": "關",

  "cal.title": "校正",
  "cal.lead":
    "lerobot 校正時，會把每顆伺服馬達的歸零偏移（homing offset）與活動範圍同時寫進馬達本身和一份校正檔。下表是剛從手臂的馬達裡讀出來的數值，下面的關節讀數就是用它換算的：本頁不需要校正檔。PEAR 原版的 station 還會載入校正檔，兩者完全一致才啟動；想比對的話，可以在這裡載入你的校正檔。",
  "cal.id": "ID",
  "cal.joint": "關節",
  "cal.offset": "歸零偏移",
  "cal.range": "範圍（步）",
  "cal.file": "校正檔裡的值",
  "cal.same": "一致嗎？",
  "cal.same.yes": "一致",
  "cal.same.no": "不同",
  "cal.same.missing": "校正檔裡沒有",
  "cal.fileLabel": "lerobot 校正檔（.json），可不選",
  "cal.fileHint":
    "lerobot 預設把它放在 ~/.cache/huggingface/lerobot/calibration/robots/ 底下、以機器人類型命名的資料夾裡，檔名是 <id>.json。在 macOS 的選檔視窗按 Cmd+Shift+G 可以直接輸入這個路徑；以點開頭的資料夾預設是隱藏的，按 Cmd+Shift+. 就會顯示。檔案只會留在這台電腦上。",
  "cal.remove": "移除校正檔",
  "cal.verdict.equal": "{name} 和伺服馬達裡的數值一致，PEAR 的啟動檢查可以通過。",
  "cal.verdict.different":
    "{name} 和伺服馬達裡的數值不一致。PEAR 會停下來並顯示「Servo calibration registers differ from the calibration file」。可能是拿到了別支手臂的校正檔，也可能是這份檔案產生之後手臂又重新校正過。請改用最後一次校正產生的檔案，或重新校正。",
  "cal.verdict.missing": "校正檔裡沒有這些項目：{motors}。",
  "cal.verdict.unchecked": "無法比對 {name}：{problem}",
  "cal.verdict.waiting": "已載入 {name}。一讀到手臂就會開始比對。",
  "cal.verdict.invalid": "這不是 lerobot 的校正檔：{problem}",

  "joints.title": "即時關節讀數",
  "joints.lead":
    "用手扳動手臂，數值會跟著變。PEAR 的關節值就是 lerobot 的讀數換算成弧度；夾爪則是開合程度，從 0（全關）到 1（全開）。",
  "joints.joint": "關節",
  "joints.raw": "原始位置（步）",
  "joints.value": "PEAR 的關節值",
  "joints.limits": "PEAR 的限制範圍",
  "joints.within": "在範圍內嗎？",
  "joints.unit.rad": "rad",
  "joints.unit.opening": "開合",
  "joints.mark.inside": "在範圍內",
  "joints.mark.tolerated": "超出，但在容許誤差內",
  "joints.mark.outside": "超出範圍",

  "state.title": "模型會看到的狀態",
  "state.lead":
    "指尖的位置（公分）、俯仰角 pitch 與翻滾角 roll（弧度），以及夾爪的開口寬度，都是 PEAR 依目前的關節值算出來的。開口寬度用的是 PEAR 預設的夾爪尺寸（0 到 6 公分），實際數值要自己量。",
  "state.none": "要有校正過的關節值才能計算。",
  "state.turn": "這一回合送給模型的文字",

  "sim.title": "模擬手臂",
  "sim.lead":
    "六顆模擬伺服馬達，接在一個模擬的序列埠後面。頁面讀取它的方式和讀取真實手臂完全相同。拉動滑桿就像用手扳動關節，會直接改變馬達的位置。",
  "sim.scenario": "要模擬的狀況",
  "sim.scenario.normal": "一切正常：已校正的手臂",
  "sim.scenario.missing": "有一顆馬達沒有回應（elbow_flex）",
  "sim.scenario.error": "有一顆馬達回報錯誤（wrist_flex：overload）",
  "sim.scenario.factory": "從未校正（暫存器是出廠值）",
  "sim.scenario.silent": "完全沒有回應（伺服馬達沒電）",
  "sim.scenario.ids": "伺服馬達的 ID 不對（11 到 16）",
  "sim.scenario.baud": "伺服馬達的鮑率設成 115,200",
  "sim.scenario.echo": "轉接板會把資料傳回來",
  "sim.scenarioHint": "選擇之後會重新連線。",
  "sim.unplug": "拔掉 USB 線",
  "sim.plug": "把 USB 線插回去",
  "sim.steps": "{value} 步",

  "guard.line": "唯讀保護：已送出 {sent} 個封包給伺服馬達，全部是 ping 或讀取（{detail}）。擋下的寫入：{refused}。",
  "guard.idle": "唯讀保護：還沒有送出任何封包給伺服馬達。",
  "guard.selftest":
    "頁面載入時對唯讀保護做的自我檢查：{readingTried} 種讀取封包放行 {reading} 種，{writingTried} 種寫入或格式錯誤的封包擋下 {writing} 種。",
  "guard.broken.title": "唯讀保護沒有通過自我檢查",
  "guard.broken.body": "請不要用這個頁面連接手臂。{failures}",

  "camera.title": "攝影機",
  "camera.lead":
    "PEAR 只用手腕上的一支攝影機。它向攝影機要求 640 × 480、每秒 30 張的畫面，每一回合把一張畫面壓成品質 90 的 JPEG 送給模型，不旋轉也不裁切。",
  "camera.select": "攝影機",
  "camera.option.default": "由瀏覽器決定",
  "camera.option.unnamed": "攝影機 {number}",
  "camera.option.test": "測試圖（不需要攝影機）",
  "camera.start": "開啟攝影機",
  "camera.stop": "關閉攝影機",
  "camera.capture": "擷取一張畫面",
  "camera.hint": "手腕攝影機通常是清單裡不屬於筆電內建鏡頭的那一支。第一次使用時，瀏覽器會詢問是否允許。",
  "camera.status.off": "攝影機尚未開啟。",
  "camera.status.starting": "正在開啟攝影機…",
  "camera.status.live": "{label}：{width} × {height}{rate}。",
  "camera.status.rate": "，每秒 {fps} 張",
  "camera.status.test": "測試圖",
  "camera.status.unnamed": "攝影機",
  "camera.size.ok": "這正是 PEAR 要求的畫面大小。",
  "camera.size.rescaled":
    "這支攝影機本身沒有 640 × 480 的模式，畫面是瀏覽器裁切、縮放出來的。PEAR 原本的 station 不會接受這支攝影機。",
  "camera.size.other":
    "這支攝影機給的是 {width} × {height}，不是 PEAR 要求的 640 × 480。擷取的畫面會維持攝影機的大小。PEAR 原本的 station 不會接受這支攝影機。",
  "camera.preview": "預覽",
  "camera.captured": "這一回合會送出的畫面",
  "camera.capturedNone": "還沒有擷取畫面。",
  "camera.info": "JPEG，{width} × {height}，{bytes} 位元組，品質 {quality}，{subsampling}",
  "camera.encoder": "畫面由這個瀏覽器編碼，PEAR 則是用 PIL。兩者的大小與品質設定相同，但位元組不會完全一樣。",
  "camera.fail.unavailable":
    "這個頁面目前無法使用攝影機：瀏覽器只讓透過 https、localhost，或直接從這台電腦的資料夾開啟的頁面使用攝影機。測試圖照樣可以用。",
  "camera.fail.NotAllowedError":
    "攝影機沒有獲得允許。請在瀏覽器裡允許本頁使用攝影機（網址列上的攝影機圖示，或網站設定）。在 macOS 上，瀏覽器本身也需要權限：系統設定 › 隱私權與安全性 › 相機。",
  "camera.fail.NotFoundError": "找不到攝影機。請接上手腕攝影機的 USB 線，它就會出現在清單裡。",
  "camera.fail.NotReadableError":
    "攝影機無法啟動。很可能有別的程式正在使用它（視訊通話、lerobot、其他分頁），請關掉之後再試一次。",
  "camera.fail.TrackEnded": "攝影機不再送出畫面。是不是線被拔掉了？請插回去，再重新開啟攝影機。",
  "camera.fail.other": "攝影機無法啟動：{name}: {message}",
  "camera.captureProblem": "無法擷取畫面：{problem}",

  "model.title": "模型",
  "model.lead":
    "pear.js 需要一個透過 OpenAI 相容 API 提供 PEAR 模型的服務，例如 PEAR 自己的 vLLM 伺服器。可以在這裡檢查本頁連不連得上它。",
  "model.baseUrl": "服務網址（Base URL）",
  "model.baseUrlHint": "寫到 API 版本為止，以 /v1 結尾。",
  "model.name": "模型名稱（可不填）",
  "model.nameHint": "服務對外提供這個模型時所用的名稱。如果服務只提供一個模型，可以留空。",
  "model.key": "API 金鑰",
  "model.keyHint":
    "只會留在這個頁面的記憶體裡，關閉或重新整理頁面就消失；不會被儲存，也不會寫進紀錄。服務不需要金鑰的話請留空。",
  "model.check": "檢查",
  "model.checking": "檢查中…",
  "model.unchecked": "尚未檢查。",
  "model.ok": "服務有回應、接受這把金鑰，而且提供 {model}。",
  "model.okFound": "模型名稱取自服務回傳的清單。",
  "model.notServed": "服務有回應，也接受這把金鑰，但沒有名為 {model} 的模型。它提供的是：",
  "model.choose": "服務有回應，也接受這把金鑰。它提供好幾個模型，請選一個：",
  "model.none": "服務有回應，也接受這把金鑰，但它的模型清單是空的。",
  "model.use": "使用 {model}",
  "model.key.refused": "服務拒絕了這把金鑰（HTTP {status}）。請檢查金鑰是否正確；如果服務不需要金鑰，請把欄位留空。",
  "model.notFound": "這個網址有回應，但 {where} 沒有模型清單（HTTP 404）。服務網址通常以 /v1 結尾。",
  "model.http": "服務回傳了錯誤（HTTP {status}）。",
  "model.timeout": "3 秒內沒有回應。服務可能還在啟動、負載過高，或是從這台電腦連不過去。",
  "model.blocked.title": "服務是通的，但瀏覽器不讓本頁讀取回應",
  "model.blocked.body": "這個網址確實有東西在回應，瀏覽器卻沒有把回應交給本頁，也不會說明原因。常見的原因有兩個：",
  "model.blocked.origin":
    "服務不允許本頁的來源（{origin}）。服務的管理者必須開放這個來源的請求：允許 GET 與 POST 方法、Authorization 與 Content-Type 標頭，並且讓瀏覽器的預檢請求（OPTIONS）不帶金鑰也能通過。vLLM 伺服器預設允許所有來源，除非啟動時加了 --allowed-origins。",
  "model.blocked.key":
    "金鑰不對。vLLM 伺服器拒絕錯誤的金鑰時，回應裡少了瀏覽器要求的標頭，瀏覽器因此不會把這個拒絕交給網頁；從這裡看起來，就和現在的狀況一模一樣。",
  "model.blocked.folder": "本頁是直接從資料夾開啟的，來源會是「null」：只有允許所有來源（*）的服務才連得上。",
  "model.unreachable.title": "這個網址沒有任何回應",
  "model.unreachable.body":
    "瀏覽器連不上 {where}。請檢查網址與連接埠、服務是否正在執行，以及這台電腦能不能連到它（是否在同一個網路、VPN、防火牆）。",
  "model.mixed.title": "本頁使用 https，但服務網址是一般的 http",
  "model.mixed.body":
    "瀏覽器沒有讓本頁取得 {where} 的回應。透過 https 載入的頁面，通常不能連到另一台電腦上的一般 http 網址：瀏覽器會在請求送出之前就擋下來，而且只告訴頁面「請求失敗」。有兩種解法：",
  "model.mixed.https": "讓服務提供 https:// 開頭的網址（例如在服務前面加一層有憑證的反向代理或通道），再把那個網址填進來。",
  "model.mixed.same":
    "或者在執行服務的那台電腦上開啟本頁，網址填 http://127.0.0.1 或 http://localhost，再加上服務的連接埠：瀏覽器允許 https 頁面連到這台電腦本身。",
  "model.mixed.local":
    "這個網址位在區域網路內。較新版本的 Chrome 在你允許本頁連線到區域網路之後，會放行以數字寫成的這類網址；其他瀏覽器則會直接擋下。",
  "model.permission.prompt":
    "如果服務就在這台電腦上、在你的區域網路裡，或是要透過 VPN 才連得到，Chrome 會詢問是否允許本頁連線到區域網路上的裝置，請選擇允許。如果沒有跳出詢問，或是你把它關掉了，請再按一次「檢查」。",
  "model.permission.denied":
    "Chrome 目前封鎖了本頁連線到區域網路上裝置的權限。請打開網站設定（網址左邊的圖示），改成允許，再按一次「檢查」。",
  "model.refused": "這個網址或金鑰無法使用。請填寫 http:// 或 https:// 開頭的網址，裡面不要帶帳號或密碼。",
  "model.notService": "這個網址有回應，但不像模型服務：{where} 回傳的不是模型清單。網址填對了嗎？",
  "model.clientSaid": "用戶端回報：{message}",

  "task.title": "任務",
  "task.notice":
    "這個版本只會讓模擬手臂動，而且是在這個頁面的 Worker 裡執行。連接真實的手臂時，它只讀取，不會讓真實的手臂動。它可以問模型一次並顯示回答，但不會執行模型要求的動作；目前還沒有模型驅動手臂。在模擬手臂上，你可以在下面親手試試工作站：啟用、一次移動一小步、回到 Home，以及停止。",
  "task.instruction": "指令",
  "task.placeholder": "把紅色積木放進盒子裡。",
  "task.start": "開始",
  "ask.title": "問模型一次",
  "ask.lead":
    "把任務第一回合會送出的內容送給模型：帶有上面指令的 PEAR 系統提示、步驟 1 顯示的手臂狀態，以及攝影機此刻的畫面。回答會邊收邊顯示。模型要求的動作只會顯示，不會執行：不會送任何東西給手臂。",
  "ask.button": "問模型一次",
  "ask.cancel": "取消",
  "ask.need.station": "工作站正在驅動模擬手臂，這個視窗讀不到手臂。請先停用工作站。",
  "ask.need.arm": "還缺：這個視窗讀得到的手臂。請在步驟 1 啟動模擬手臂或連接手臂。",
  "ask.need.reading": "還缺：手臂的完整讀數。這個視窗已連上手臂，但還沒有完整的讀數；步驟 1 會顯示目前讀到什麼、還缺什麼。",
  "ask.need.camera": "還缺：正在運作的攝影機。請在步驟 2 啟動。",
  "ask.noFrame": "沒有詢問模型：攝影機正在運作，但這一刻沒有給出新的畫面。請看步驟 2 的畫面；等它重新顯示攝影機的畫面後，再問一次。",
  "ask.need.model": "還缺：檢查過的模型服務。請在步驟 3 檢查；位址、名稱或金鑰改過之後，請再檢查一次。",
  "ask.need.instruction": "還缺：指令。請在上面寫一句。",
  "ask.status.asking": "正在詢問模型…",
  "ask.status.action": "模型在 {seconds} 秒後回答，回答的結尾是一個動作。",
  "ask.status.noAction": "模型在 {seconds} 秒後回答，但回答裡沒有動作。",
  "ask.status.cancelled": "已在 {seconds} 秒後取消。",
  "ask.status.failed": "請求在 {seconds} 秒後失敗。",
  "ask.sent": "送出的內容",
  "ask.sent.sizes": "帶有指令的 PEAR 系統提示（{system} 個字元）、下面這段文字（{text} 個字元），以及一張影像（JPEG {size}，{bytes} 位元組）。",
  "ask.phase": "模型：",
  "ask.reasoning": "推理",
  "ask.answer": "回答",
  "ask.usage": "Token：",
  "ask.performance": "時間：",
  "ask.action": "模型要求的動作",
  "ask.sentence":
    "用白話說：指尖移動 x {x} 公分、y {y} 公分、z {z} 公分（+x 向前、+y 向左、+z 向上），轉動 pitch {pitch} 弧度、roll {roll} 弧度，並且{gripper}（gripper.width {width}）。",
  "ask.gripper.open": "打開夾爪",
  "ask.gripper.close": "合上夾爪",
  "ask.gripper.hold": "讓夾爪保持不動",
  "ask.explain.noAction": "這個格式從這段回答讀不出動作。PEAR 的原話：",
  "ask.explain.cancelled": "請求已被停止。PEAR 的原話：",
  "ask.explain.failed": "模型服務沒有給出回答。PEAR 的原話：",
  "ask.explain.withheld":
    "服務是通的，但瀏覽器不讓本頁讀取回應，也不會說明原因。常見的原因有兩個：金鑰不對（vLLM 伺服器拒絕錯誤的金鑰時，回應裡少了瀏覽器要求的標頭，瀏覽器因此不會把這個拒絕交給網頁），或是服務不允許本頁的來源（{origin}）。請在步驟 3 再檢查一次。PEAR 的原話：",
  "ask.notSent": "沒有送任何東西給手臂。這個頁面不會執行動作；用戶端已關閉，下一次詢問是全新的對話。",
  "task.stop": "停止",
  "task.stopNote": "停止會讓手臂煞車，並停在原地保持不動。只要工作站握有手臂，停止鈕就能用；這個版本只有模擬手臂。",

  "station.title": "親手操作工作站",
  "station.lead":
    "PEAR 的機器人工作站在這個頁面的 Worker 裡執行：機器人、50 Hz 的控制迴圈，以及驅動程式。在這裡它驅動的是 Worker 自己建立的模擬手臂。它從來不會拿到序列埠，所以這裡沒有任何東西能碰到真實的手臂。",
  "station.enable": "啟用",
  "station.disable": "停用",
  "station.disableNote":
    "停用會關閉工作站。在真實的手臂上，這會關掉扭力，沒有東西撐住的手臂會掉下來：要停下來請按停止，只有在手臂已經收好或有人扶著時才按停用。",
  "station.why.noArm": "請先在步驟 1 連接模擬手臂：工作站會從那支手臂目前的位置開始。",
  "station.why.realArm":
    "目前連接的是真實的手臂。這個版本只會讀取真實的手臂，絕不寫入，所以不能在它上面啟用工作站。請先中斷連線，改用模擬手臂來試工作站。",
  "station.why.scenario": "模擬手臂目前設定成故障狀況（{scenario}）。請在步驟 1 選擇正常的手臂，再來試工作站。",
  "station.why.busy": "步驟 1 的手臂還在第一次讀取中。請等到關節顯示出來。",
  "station.why.ready": "啟用會結束步驟 1 的讀取，把模擬手臂連同它目前的位置交給工作站。",
  "station.why.lost": "工作站的 Worker 已經不在了。請重新載入頁面再開始。",
  "station.status.off": "工作站已關閉。",
  "station.status.enabling": "啟用中：先檢查計時三秒，再開啟機器人…",
  "station.timing":
    "啟用前的計時自我檢查（只讀取）：{periods} 個控制週期，平均 {mean} ms，最長 {max} ms，{over} 個超過 25 ms，最長的一次讀取 {read} ms：{verdict}。",
  "station.timing.passed": "通過",
  "station.timing.failed": "未通過，所以沒有啟用工作站（{failures}）",
  "station.timing.fail.period": "有一個週期花了 {value} ms（上限 {limit} ms）",
  "station.timing.fail.over25": "有 {value} 個週期超過 25 ms（上限 {limit} 個）",
  "station.timing.fail.mean": "平均週期是 {value} ms（上限 {limit} ms）",
  "station.timing.fail.read": "有一次讀取花了 {value} ms（上限 {limit} ms）",
  "station.timing.fail.unanswered": "有 {value} 次讀取沒有收到每一顆伺服馬達的回應",
  "station.timing.fail.hidden": "頁面目前沒有顯示在畫面上",
  "station.timing.fail.join": "；",
  "station.status.disabling": "停用中…",
  "station.status.on": "機器人 {robot}，控制迴圈 {control}。",
  "station.status.fault": "機器人 FAULT：{fault}",
  "station.status.lostSilent": "工作站的 Worker 沒有回應（{detail}）。頁面無法得知手臂現在的狀況。如果一直沒有回應，請重新載入頁面再開始。",
  "station.status.lostDied": "工作站的 Worker 已經停止運作（{detail}）。請重新載入頁面再開始。",
  "station.periods": "最近一秒的控制週期：{count} 個，平均 {mean} ms，最長 {max} ms，{over} 個超過 25 ms。啟用以來的步數：{steps}。",
  "station.clock":
    "啟用以來 Worker 的時鐘：睡眠 {sleeps} 次（計時器 {timers} 個，不用計時器的讓出 {yields} 次），忙碌等待共 {spin} ms；睡眠平均晚 {lateMean} ms 結束，最晚 {lateMax} ms；計時器最晚 {timerLate} ms 才觸發；餘裕 {margin} ms。",
  "station.camera.arriving": "工作站看到的手腕攝影機：畫面持續送達，最近一秒 {rate} 張；回報狀態時，最後一張是 {age} ms 前的。",
  "station.camera.waiting": "工作站看到的手腕攝影機：攝影機已啟動，但最近一秒沒有畫面送達。",
  "station.camera.stopped": "工作站看到的手腕攝影機：沒有畫面送達，因為步驟 2 的攝影機沒有在執行；最後一張是 {seconds} 秒前的。沒有新的畫面，工作站不會執行任何動作：請在步驟 2 啟動攝影機（使用模擬手臂時，測試畫面就夠了）。",
  "station.camera.never": "工作站看到的手腕攝影機：沒有畫面送達，因為步驟 2 的攝影機沒有在執行；啟用以來一張也沒有。沒有新的畫面，工作站不會執行任何動作：請在步驟 2 啟動攝影機（使用模擬手臂時，測試畫面就夠了）。",
  "station.camera.gaps": "啟用以來，在攝影機執行期間，兩張畫面之間最長間隔 {gap} ms；超過 200 ms（畫面就太舊，工作站不採用）的次數：{over}。",
  "station.frame.alt": "上一次觀測所含的畫面",
  "station.frame.caption":
    "上一次觀測所含的畫面：工作站的攝影機看到的第 {number} 張，{width} x {height}，JPEG，{bytes} 位元組，觀測時是 {age} ms 前的。",
  "station.hidden": "頁面曾被隱藏：工作站已停止，在頁面重新顯示之前不會開始任何動作。",
  "station.wasHidden": "頁面曾被隱藏一段時間：工作站當時已停止。現在頁面已重新顯示，可以再開始動作。",
  "station.enableFailed": "無法啟用工作站：{error}",
  "station.enableFailed.timing": "無法啟用工作站：計時自我檢查未通過，原因寫在上面那一行。",
  "station.disableFailed": "無法停用工作站：{error}",
  "station.stopFailed": "停止沒有得到回應：{error}",
  "station.jogTitle": "一次一個動作",
  "station.jogLead":
    "每個按鈕都是一個模型格式的動作（single_arm_delta：公分與弧度），執行方式和一個回合相同：手臂靜止、觀測一次，再從這次觀測執行動作。觀測裡有關節、控制狀態，以及工作站看到的手腕攝影機畫面；沒有新的畫面時，動作不會執行。",
  "station.jog.open": "夾爪：打開",
  "station.jog.close": "夾爪：閉合",
  "station.home": "Home",
  "station.planTitle": "Home：計畫",
  "station.planLead": "PEAR 會在任何東西移動之前先顯示計畫。核准後手臂才會回到 Home；拒絕的話什麼都不會動。",
  "station.approve": "核准",
  "station.refuse": "拒絕",
  "station.action.running": "{action}：{phase}",
  "station.action.resting": "等待手臂靜止",
  "station.action.done": "{action}：{status}",
  "station.action.failed": "{action}沒有執行：{error}",
  "station.action.noFrame":
    "工作站沒有執行這個動作，因為沒有手腕攝影機的新畫面（畫面送達後 0.2 秒內才算新）。如果步驟 2 的攝影機沒有在執行，請啟動它（使用模擬手臂時，測試畫面就夠了）；如果已經在執行，請再執行一次這個動作：上方攝影機那一行會說明畫面有沒有送達。",
  "station.action.homed": "Home 完成：{stages}。",
  "station.action.stopped": "{action}：你在它執行時按了停止，所以動作到此為止。PEAR 的結果是 {status}。",
  "station.action.stoppedHidden": "{action}：頁面在它執行時被隱藏，所以工作站把它停了下來。PEAR 的結果是 {status}。",
  "station.action.homeStopped": "{action}：你在它完成之前按了停止，所以到此為止。機器人回報：{error}",
  "station.action.homeStoppedHidden": "{action}：頁面在它完成之前被隱藏，所以工作站把它停了下來。機器人回報：{error}",
  "station.homeResultLead": "Home 的各個階段，以及 PEAR 對每個關節的結果：",
  "station.stateTitle": "工作站量到的狀態",
  "station.joints": "關節（rad）：{joints}",
  "station.reportTitle": "上一個動作的回報",
  "station.reportLead": "這是模型在下一個回合會讀到的句子，下面是那一整個回合的文字。",
  "station.record": "PEAR 對結果的紀錄",

  "log.title": "紀錄",
  "log.lead":
    "頁面做了什麼、發現了什麼，都記在這裡，遇到問題時可以附在回報裡。裡面沒有金鑰，也沒有模型服務的位址。紀錄內容是英文。",
  "log.copy": "複製紀錄",
  "log.copied": "已複製。",
  "log.copyFailed": "無法自動複製，請自行選取文字後複製。",
  "log.label": "紀錄",
  "timing.button": "測量時間",
  "timing.lead":
    "測量讀取六個位置要花多久，以及 20 毫秒的計時器在這個瀏覽器裡有多穩定。大約需要半分鐘，結果會寫進紀錄。",
  "timing.running": "測量中…（{step}）",
  "timing.needsArm": "請先連上手臂，模擬手臂也可以。",
  "timing.done": "測量完成，結果已寫進紀錄。",

  "footer.about":
    "pear.js 是獨立的非官方專案，與 PEAR 專案及其作者沒有隸屬關係，也未獲其背書。本軟體仍屬實驗性質，不提供任何擔保，以 Apache-2.0 授權釋出。",
  "footer.network": "本頁不會從其他網站載入任何東西，也不會把資料送到任何地方；唯一的例外，是送往你所填模型服務的請求。",
  "footer.commit": "pear.js 建置版本 {build}。移植自 PEAR 的 commit {commit}。",
  "footer.pearjs": "GitHub 上的 pear.js",
  "footer.pear": "GitHub 上的 PEAR",
};
