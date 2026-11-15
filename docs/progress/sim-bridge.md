# Progress: sim-bridge

pear.js's hardware layer (`src/feetech/`, `src/so101/hardware/`) talking, byte for byte, to a simulated SO-101 servo
chain reachable over TCP, not part of this repository; and the parity check: one scripted run by pear.js and by
PEAR's own Python on the same chain, their bytes compared. Step 3 of the verification ladder had only met this
repository's own simulated chain before.

Nothing under `src/` was changed for it.

## Result

On the same simulated arm, freshly reset before each of 10 scripted sessions (447 steps), pear.js puts on the wire
exactly the instruction packets PEAR's Python does, in the same order: **1888 of 1888, 0 differing**. When the
simulated arm ages with the packets alone, so that timing cannot change an answer, everything else is equal too:
the 4742 status packets, all 331 readings to the last bit, the 12 refusals' messages and the 2 warnings.
No defect was found in `src/feetech` or `src/so101/hardware`. What else was found, one thing of it to reconcile
(the errors' class names), is under "Found".

## Done

| File | What it is |
| --- | --- |
| `tests/sim-bridge/tcp_transport.ts` | `TcpTransport`: the bus's `Transport` on a TCP socket (Node's `net`); under `tests/` because `src/` has no Node-only API |
| `tests/sim-bridge/bridge_control.ts` | `BridgeControl`: the chain's test controls over HTTP; `bridgeAddress()` reads the environment |
| `tests/sim-bridge/make_session.py`, `session.json` | The scripted sessions, as data both runners read: every target is a number in the file, never computed twice (standard library only; `python tests/sim-bridge/make_session.py` writes the file again) |
| `tests/sim-bridge/session.ts` | `runSessions()`: runs the sessions with `SO101Follower`, `SO101Hardware.open`, `SO101Driver`, and records what every step returned or threw, the warnings, and the packets the chain saw |
| `tests/sim-bridge/compare.ts` | `compareResults()`: two runs compared, nothing tolerated: every difference is counted |
| `tests/sim-bridge/timing.ts` | The times of the read and the send of a control period |
| `tests/sim-bridge/transport.test.ts` | 7 tests, always run: the transport against a server of its own on 127.0.0.1; the hardware layer over a socket on pear.js's own simulated arm |
| `tests/sim-bridge/compare.test.ts` | 9 tests, always run: the comparison finds a changed byte, a missing, extra or misplaced packet, a reading off by counts, another message, class or warning |
| `tests/sim-bridge/sim-bridge.test.ts` | 4 tests, run only with `PEAR_JS_SIM_BRIDGE` set: the bus's handshake on the chain, the sessions, the comparison with the reference, the timing |

## What the servo chain must offer

- **The line**, TCP on 127.0.0.1: the raw bytes of the Feetech protocol in both directions, one client at a time.
  Six STS3215 with ids 1 to 6 that answer PING, READ, WRITE, SYNC READ and SYNC WRITE and hold a calibration.
- **Controls**, HTTP with JSON on 127.0.0.1: `GET /state` (the clock, the true joints), `GET /calibration` (in
  lerobot's calibration file format), `GET /traffic` (the packets of both directions since the last reset, in
  order, in the segments the marks start); `POST /reset` (the arm as after power-up), `POST /mark {label}`,
  `POST /wait {seconds}` (the simulated arm ages), `POST /inject` with any of `status {motor: bits}`,
  `registers {motor: {name: value}}` (behind the bus's back), `absent [motor]`, `lose_reads n`,
  `lose_replies {skip, count}`, `silent`, `clear`.
- **Two clocks.** `realtime`: the arm ages with the wall clock. `packets`: it ages only by a fixed step before each
  instruction packet and by `/wait`, so what the servos answer depends on the packets alone and two hosts that
  send the same bytes must read the same bytes.
- A control call must follow an exchange that a servo answers, never directly a sync write, which may still be on
  its way when the call arrives. `make_session.py` checks the sessions for it.

The reference is PEAR's `SO101Driver`, made as PEAR's robot makes it from a station file, with lerobot, the Feetech
SDK and pyserial unchanged below it; it opens a serial device whose bytes are relayed to the same line. Its runner
is not in this repository; it writes a result of the form `session.ts` writes (`RunResult`).

## How to run

```bash
npx vitest run tests/sim-bridge                   # without a chain: 16 tests pass, 4 are skipped
PEAR_JS_SIM_BRIDGE=127.0.0.1:18931 \
PEAR_JS_SIM_BRIDGE_REFERENCE=<the reference's result file> \
PEAR_JS_SIM_BRIDGE_OUT=<a directory for this run's result, comparison and timing> \
  npx vitest run tests/sim-bridge/sim-bridge.test.ts
```

`PEAR_JS_SIM_BRIDGE_CONTROL=host:port` names the controls if they are not on the line's host at the next port.
Without a reference the sessions run and are timed, and nothing is compared.

## The sessions

One long session and nine short ones, each after a reset:

- **nominal** (361 steps, 1229 instruction packets): start-up; 12 readings; a move from the folded rest pose to
  PEAR's Home in 150 control periods and one aside in 100, each period a read and a send, then held; readings at
  rest after each; 200 periods without a pause; then, while running: a servo's Status reports overload, an unknown
  Status bit, a servo loses its torque, the jaw reports load (no fault), one lost answer (saved by the retry), two
  lost answers after the first command (the last reading is kept); close.
- a servo is missing at start-up; the line is silent at start-up; an answer is lost during the handshake; one
  answer is lost while enabling; a whole enable attempt is lost; a servo reports an error at start-up; the servos'
  calibration differs from the file; the line is silent while running (before the first command); a servo reports
  an error when the arm is closed.

What PEAR's Python sent in them, by recording: PING 60, READ 264, WRITE 431, SYNC READ 676, SYNC WRITE 457, and no
other instruction.

## How it was verified

2026-11-15. pear.js: Node v24.18.1 on Windows, `TcpTransport` to 127.0.0.1. Reference: PEAR at f32aa1f7, lerobot
0.6.1, feetech-servo-sdk 1.0.0, pyserial 3.5, Python 3.12.15. Each side ran on a chain started anew with a byte
log of its own. The numbers below are from the chain's raw byte logs, cut into packets again by a comparison tool
on the chain's side, and from the two result files; `compare.ts` gives the same counts inside the test.

**`packets` clock (nothing may differ):**

| | reference | pear.js | differing |
| --- | --- | --- | --- |
| instruction packets, host to servo | 1888 | 1888 | 0 |
| status packets, servo to host | 4742 | 4742 | 0 |
| positions in answers to sync reads of Present_Position | 3221 | 3221 | 0 (largest difference 0 counts) |
| readings returned by read and read_for_recovery | 80 | 80 | 0 (identical in every bit) |
| readings returned in the control periods | 251 | 251 | 0 (identical in every bit) |
| steps, by kind of outcome (returned, threw, skipped) | 447 | 447 | 0 |
| refusals, message | 12 | 12 | 0 |
| warnings | 2 | 2 | 0 |

The 4 gated tests pass; each run's packets cut from its byte log equal the chain's own record (6630 packets, 0
differing).

**`realtime` clock:** instruction packets 1888 against 1888, 0 differing. Status packets: 139 of 4742 differ. 134
are positions read while the arm moves, in the two moves: by at most 7 encoder counts (104 of 906 answers in the
first move, 30 of 606 in the second). The other 5 are the gripper's position, one count apart (1933 against 1934),
in three start-ups right after torque went on: the closed jaw rests on a count's edge, below its calibrated range,
and both layers return the same opening for either. In every segment without a command all 432 positions are
equal, and all 80 readings between commands are identical in every bit: within one encoder count, as required.
What the clock alone does was measured by running PEAR's Python twice more: 150 and 253 of 4742 status packets
differ between two of its own runs, by at most 7 counts, with the same 1888 instruction packets. pear.js against
PEAR is inside that. A repeat of the whole pair with the final files: 1888 against 1888, 0 differing; 180 status
packets differing, by at most 7 counts; the positions without a command and the 80 readings equal again.

**The refusals** (12, messages equal after each side's own name of its line is put aside, which appears in three):

| Session, step | PEAR's Python | pear.js | Message |
| --- | --- | --- | --- |
| nominal, read at the Status poll | ServoFault | ServoFault | `Servo error: elbow_flex: overload` |
| nominal, read_for_recovery | ServoFault | ServoFault | `Servo error: elbow_flex: overload` |
| nominal, read_for_recovery | ServoFault | ServoFault | `Servo error: shoulder_pan: 0x40` |
| nominal, read at the torque poll | ServoFault | ServoFault | `Servo torque is off: wrist_roll` |
| nominal, read_for_recovery | ServoFault | ServoFault | `Servo torque is off: wrist_roll` |
| a servo is missing, open | RuntimeError | Error | `FeetechMotorsBus motor check failed on port '...': Missing motor IDs: - 3 ...` |
| the line is silent at start-up, open | RuntimeError | Error | the same check, all six ids missing |
| an answer is lost during the handshake, open | ConnectionError | FeetechCommError | `Could not connect on port '...'. Make sure ...` |
| a servo reports an error at start-up, open | RuntimeError | Error | the motor check, id 3 missing |
| the calibration differs, open | RuntimeError | Error | `Servo calibration registers differ from the calibration file` |
| the line is silent while running, read | ConnectionError | FeetechCommError | `Failed to sync read 'Present_Position' on ids=[1, 2, 3, 4, 5, 6] after 2 tries. [TxRxResult] There is no status packet!` |
| an error when the arm is closed, close | RuntimeError | FeetechStatusError | `Failed to write 'Torque_Enable' on id_=3 with '0' after 6 tries. [RxPacketError] Overload error!` |

The class name is the same string in 5 of 12; in the other 7 pear.js throws the class `docs/progress/feetech.md`
lists for the Python one (12 of 12). The two warnings, equal on both sides: `Enable attempt 1 failed, retrying:
Failed to sync read 'Present_Position' ... after 3 tries. ...` and `feedback read failed: Failed to sync read
'Present_Position' ... after 2 tries. ...`.

**A second run from nothing**, later the same day and by another hand (both chains started anew, `packets` clock):
1888 against 1888 instruction packets and 4742 against 4742 status packets, 0 differing; 80 and 251 readings
identical in every bit; 12 refusals with the same messages; the 4 gated tests pass.

**The comparison can fail.** `compare.test.ts` changes one thing at a time in a copy of a run and requires it found
(9 tests). On the real runs: with one bit of one goal changed in one packet of a copy of the reference's result, the
gated test fails with `host to servo packets: reference 1888, candidate 1888, differing 1` and names the segment
and the packet. The tool on the chain's side was given nine changed copies (a goal's bit, a packet removed, two
exchanged, a status packet's position one count higher; a refusal's message, its class, a reading two counts off,
a warning removed, a packet of the recorded traffic): it failed on each and passed on the untouched pair.

## Timing

`realtime` clock, Node on Windows to the chain through the loopback, 50 control periods a second:

| pear.js | median | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| read + send, 250 paced periods | 0.98 ms | 1.47 ms | 1.78 ms | 2.29 ms |
| read alone (with the Status or torque poll every 5th) | 0.86 ms | 1.35 ms | 1.56 ms | 2.11 ms |
| send alone | 0.11 ms | 0.18 ms | 0.24 ms | 0.48 ms |
| period achieved | 20.005 ms | 20.006 ms | 20.011 ms | 20.064 ms |
| read + send, 200 periods without a pause | 0.42 ms | 0.82 ms | 0.88 ms | 0.89 ms |

(A repeat: 1.03 ms at the median, 2.20 ms at most; 0.45 ms and 1913 cycles a second without a pause.)
A cycle takes about 5 % of the 20 ms period; without a pause the line carries about 2000 cycles a second. PEAR's
Python on its relayed serial device: 1.11 ms (paced) and 0.43 ms (no pause), 2015 cycles a second. So 50 Hz is not
limited by pear.js's bus code. It says nothing about a real line: the chain answers at once, where six servos at
1 Mbaud need about 0.6 ms for a sync read's bytes alone, and a USB adapter and Web Serial add their own latency.

## Found

1. **Error classes (to reconcile, not a difference in bytes).** PEAR reports a failed action as
   `{"code": type(error).__name__, "message": str(error)}` (`control/motion/results.py`), and DESIGN.md says a
   JavaScript error class carries the Python class name. The kinematics do (`ValueError`, `UnreachablePoseError`);
   the hardware layer does not: of the 12 refusals above, 7 would read `FeetechCommError`, `FeetechStatusError` or
   `Error` where PEAR's code is `ConnectionError` or `RuntimeError`. If the station port builds `code` from
   `error.name`, the model's view differs for these. `compare.ts` (`jsErrorName`) holds the mapping.
2. **Timers under Node on Windows are about 16 ms coarse** (measured: `setTimeout(1)` took 15.9 ms at the median,
   `setTimeout(50)` 63.3 ms). Bytes that arrive wake a read at once, so no exchange is slower; but a missing answer
   costs about 63 ms instead of about 51 ms (a read whose two tries are lost: 125.2 ms against PEAR's 103.7 ms; one
   lost try and its retry: 65.5 ms against 51.3 ms), and a loop paced by timers cannot hold 20 ms. `session.ts`
   paces by turns of the event loop. A page's timers have their own clamps: to measure when the station's loop is
   ported.
3. **A relay between the bus and a serial line must not delay small packets.** The first run showed 44 ms for every
   read that followed a sync write (0.3 ms otherwise): the loopback relay of the machine gathered small writes
   (Nagle) and the chain's side delayed its acknowledgement of the unanswered sync write. It was the path, not
   pear.js: fixed on the chain's side, the read takes 0.3 ms. Any socket bridge to a real adapter needs the same care.
4. **A servo side that stalls 82 ms** (found once, a pause of the simulated chain's own process, since removed)
   made pear.js miss one status packet in a start-up: it reported `Enable attempt 1 failed, retrying: Failed to
   write 'D_Coefficient' on id_=2 with '32' after 1 tries. [TxRxResult] There is no status packet!`, enabled torque
   again as lerobot's `torque_disabled` does, and passed on the second attempt. PEAR's Python on the same pause was
   not recorded.

## Not verified

- Anything on a real servo, a real adapter or Web Serial. The simulated chain puts the Status register in the
  error byte of every status packet, answers at once and always: its reading of the protocol, as this repository's
  own simulated chain's, not a measurement.
- A feedforward: the reference ran PEAR's default (all zeros), pear.js with none; both send the target itself.
- Joint offsets other than zero and a status poll other than every 10 reads on this chain (the fixtures of
  `tests/feetech` cover offsets, without a chain).
- Velocities returned by a reading (they depend on each side's clock) were recorded, not compared.
- REG WRITE and ACTION: PEAR never sent them here.
- Only Node on Windows ran pear.js. The reference's times for open and close include a garbage collection of its
  runner and are not comparable; the cycles' are.

## Notes on the runners

- PEAR's driver makes its arm itself; `session.ts` opens the arm, then gives it to the driver.
- Each side names its line in three messages (`Could not connect on port '...'`); the comparison puts that name
  aside and nothing else.
- After a close that failed, both runners close their port themselves. lerobot's destructor would otherwise
  disconnect once more when Python drops the robot; pear.js does that only after a failed open, as PEAR's start-up
  needs (the packets are equal there: sessions 2 to 4 and 7).

## Left

- Decide where the reference runner should live (it needs only PEAR's station environment, a serial device and the
  controls' address); today the public repository holds the sessions, pear.js's runner and the comparison.
- The error codes of the hardware layer, for the station port (Found, 1).
- A feedforward other than zero on the same chain. (The station's own loop on it, ladder step 4, has been run
  since: `station-chain.md`.)
