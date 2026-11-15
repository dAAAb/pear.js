# Progress: feetech

The Feetech STS3215 protocol over an abstract transport (`src/feetech/`) and the SO-101's servo layer on it
(`src/so101/hardware/`). Reference: lerobot 0.6.1 with feetech-servo-sdk 1.0.0 (`scservo_sdk`), and PEAR at the
pinned commit.

## Done

| File | Ports |
| --- | --- |
| `src/feetech/protocol.ts` | `scservo_sdk`: `scservo_def.py`, `protocol_packet_handler.py` (packets, `txPacket`, `rxPacket`, `txRxPacket`, `ping`, `readTxRx`, `readRx`, `writeTxRx`, `syncReadTx`, `syncWriteTxOnly`, the result and error texts), the parameter lists of `group_sync_read.py` and `group_sync_write.py`. `StatusPacketReader` is `rxPacket`'s loop as a stream parser |
| `src/feetech/transport.ts` | Not in PEAR: `Transport` (write; read at most n bytes within a timeout; close), `Clock`, `ManualClock`, `WebSerialTransport` (the DOM library of this toolchain has no Web Serial types: `SerialPortLike` declares the part used). From pyserial 3.5: `SerialException`, which the transport throws for a port that was closed, lost or failed. The transport reads on from the port's new stream after a line error the port survives (the Web Serial specification's §4.6 readable), counting them in `lineErrors`; `close()` resolves whatever state the port is in |
| `src/feetech/tables.ts` | lerobot `motors/feetech/tables.py` for the STS3215, the constants and enumerations of `feetech.py`, the sign-magnitude encoding of `motors/encoding_utils.py` |
| `src/feetech/bus.ts` | lerobot `motors/motors_bus.py` (`SerialMotorsBus`) and `motors/feetech/feetech.py` (`FeetechMotorsBus`): connect with handshake, disconnect, ping, read, write, sync read, sync write, normalize and unnormalize, torque, `configure_motors`, calibration read, write and check; the SDK's `port_handler.py` timing with lerobot's `patch_setPacketTimeout` |
| `src/feetech/sim.ts` | Not in PEAR: `SimServo`, `SimServoChain`, a chain of simulated STS3215 behind `Transport` (a goal reached at once or at a set speed; lost and corrupt answers, absent servos, an echoing line) |
| `src/so101/hardware/motors.ts` | The joints' and servos' names and order (PEAR `layout.py`), ids and units (lerobot `so_follower.py`) |
| `src/so101/hardware/follower.ts` | lerobot `robots/so_follower/so_follower.py` and `config_so_follower.py` (`configure()`, `disconnect()`), the calibration file of `robots/robot.py` (`parseCalibration`, `serializeCalibration`) |
| `src/so101/hardware/arms.ts` | PEAR `hardware/arms.py`: `SO101Hardware` (open, read, readForRecovery, send, close, `busPosition`) |
| `src/so101/hardware/driver.ts` | PEAR `hardware/driver.py`: `SO101Driver` (a bus glitch keeps the last reading; a goal is the target plus the feedforward's offset inside the bounds; a held target is sent again only when its offset changed). The feedforward itself (`joint/feedforward.py`) is an interface it is given |
| `src/so101/hardware/startup.ts` | PEAR `hardware/startup.py`: `connectChecked`, `servoFaults`, the Status bits |
| `src/so101/hardware/arm_state.ts` | PEAR `hardware/arm_state.py` with the fields and the feedback of `joint/arm_state.py` |
| `src/so101/hardware/sim.ts` | Not in PEAR: `simulatedArm`, six simulated servos holding a calibration |

## How it was verified

`tools/fixtures/feetech_fixtures.py` runs the reference Python and writes seven files (465 KB) to
`tests/fixtures/feetech/`. It opens no serial port: inside the SDK's port handler pyserial's `Serial` is replaced
by a fake, behind which a small chain of servos (the script's own, plain register tables) answers; the SDK's clock
advances only when a read finds nothing, PEAR's monotonic clock is a counter. Two runs give identical files.

```bash
<work dir>/envs/station/bin/python tools/fixtures/feetech_fixtures.py   # regenerate
npx vitest run tests/feetech                                            # 7 files, 82 tests
npm run typecheck
```

Equal to the reference, compared exactly (bytes, numbers bit for bit, messages):

- `tables.json`: the control table (56 registers), sign bits, baud rates, model numbers, the SDK's 32 constants, its
  texts for 12 results and 256 error bytes, lerobot's packet timeout for 6 lengths.
- `packets.json`: 210 instruction packets built by the SDK (ping, read, write, sync read, sync write; ids past the
  last servo's, an id given twice, a sync write too long for a packet), 52 values to bytes, 81 values to sign and
  magnitude and 72 back.
- `status.json`: 185 byte streams (25 named, 160 random: packets back to back, noise, wrong checksums, cut packets,
  fields out of range, lengths too short, echoed instructions) and what every call of the SDK's `rxPacket` makes of
  them; the TypeScript reads each whole, one byte at a time and in uneven pieces.
- `bus.json`: 8 scenarios, 176 operations of lerobot's bus with the 533 packets they exchanged and the timeout of
  each: the TypeScript bus must send the same bytes in the same order and return the same value or fail the same
  way. Lost, corrupt and cut answers with and without retries, absent servos, error bytes, noise, another servo's
  late answer, an echoing line, handshake failures, no calibration.
- `normalize.json`: 5 calibrations (joint offsets, half-step middles, inverted drive modes, a narrow gripper):
  80 raw readings to lerobot's degrees and percent to PEAR's joint vector; 80 joint vectors through PEAR's
  `send()` to the goals given to the bus, their steps and the sync write packet, and 10 vectors it refuses; 40
  rows of the -100..100 unit. numpy's `radians` and `degrees` and the TypeScript products agree to the last bit.
- `so101.json`: lerobot's calibration file text; PEAR's `servo_faults` for all 256 Status values of a joint and of
  the gripper; 7 sessions of PEAR's `SO101Hardware` (the real `__init__`, `read`, `read_for_recovery`, `send`,
  `close`) with 70 operations and 731 packets: enabling, the Status and torque polls, a servo fault, lost torque,
  a servo that misses the first goal, a silent bus, a calibration mismatch, a fault at start and at close; the
  readings, velocities, servo status and feedback of each.
- `driver.json`: PEAR's `SO101Driver` on a scripted arm, without a feedforward (24 steps) and with a scripted one
  (22 steps): the reading returned, the goal sent, what the feedforward was asked, for each step.

Also tested, without a fixture: the bus on the simulated chain (goal at once and at a speed, retries, Status in
every answer, calls made at once taking turns), the simulated chain against the fixture script's chain on PEAR's
own traffic (388 packets), a whole PEAR session on the simulated chain, `WebSerialTransport` on fake streams; the
bus and PEAR's arm when an answer comes late (`stalled_host.test.ts`, 7 tests, on a simulated arm behind
`LateAnswerTransport` and the test's clock); `WebSerialTransport` when the page does not run while a read waits
when the port is closed, lost or refuses a write, when a line error fails the stream and the port offers a new
one, and when `close()` is called on a port that is already gone (`web_serial.test.ts`, 13 tests, on fake streams
and a port of the Web Serial specification's shape, on Node's event loop). The late-answer tests and the
SerialException tests are described under "Deliberate differences"; the stream-resilience and close tests below.

The replays of `bus.json` and `so101.json` read the line as the SDK does, late answers kept: `ReplayTransport`
sets the bus's `PortHandler.discardsInput` to false, because a recording holds what the SDK made of a late answer.
`PEAR_JS_REPLAY_DISCARDS=1 npx vitest run tests/feetech` runs them with the bus as it is by itself: the 7 sessions
of `so101.json` (731 packets) and 7 of the 8 scenarios of `bus.json` pass as they are, and `operations` stops at
its step 77, the first of the three outcomes listed under "Deliberate differences".

Not verified: anything on a real servo or a real serial port, and a browser's event loop. That Chrome reports a
line error by failing and replacing the readable stream, as the Web Serial specification says (§4.6): the
transport reads on from a new stream, but whether Chrome offers one after a framing error, a break or a buffer
overrun is not seen here. In particular the simulated servos and the fixture script's chain put the Status
register in the error byte of every status packet; that is the protocol manual's description, not a measurement.

## What the SDK tolerates on the line (and the echo)

- Bytes before a header are dropped; a header with an id above 0xFD, a length above 250 or an error byte above 0x7F
  is not a status packet and the search goes on one byte later; a status packet of another servo is skipped.
- The SDK never discards received bytes: its `clearPort()` is pyserial's `flush()`, which waits for the output.
  A late answer of the same servo is taken for the next exchange's answer, and that exchange's own answer for the
  one after: from then on every answer is one exchange old. It also gives a packet up as soon as its time is up
  and bytes are missing, without reading the port once more. pear.js differs in both ("Deliberate differences",
  late answers).
- A retry is immediate: no pause. lerobot's `DEFAULT_TIMEOUT_MS` (1000) plays no part in an exchange: each sets
  its own timeout, 50 ms plus the bytes' time, and a sync read's covers all answers together.
- **Echo: not handled.** The echo of an instruction to one servo has a status packet's form and a valid checksum,
  so it is taken for the answer: a read returns its own address and length with error byte 2 and lerobot raises
  "Angle sen error". Only the echo of a broadcast packet (sync read, sync write: id 0xFE) is skipped. pear.js is
  the same, on purpose; an adapter that echoes needs a transport that drops its own bytes. In the SDK the real
  answer then stays in the port and shifts every later exchange (in `bus.json`, after the echo of a read, a later
  read returns the value read before although the servo now reports an error; after the echo of a write, the
  next read fails on a packet without data and the next write is taken for acknowledged although the servo
  reports an error). pear.js discards that answer before its next packet, so that only the echoed exchange itself
  is wrong.
- lerobot raises on any error byte in the answer to a read, a write or a ping, and ignores it in a sync read.

## What PEAR checks and configures at start-up (for the station port)

In the order of `SO101Hardware.__init__`; the packets of each step are in `so101.json`, session "a session".

1. `require_commissioned()`: the settings have no placeholder, a hardware section and a calibration file. (config)
2. `lock_bus()`: a lock file so that two station processes never share the serial device. (not applicable)
3. lerobot's follower: `use_degrees=True`, `position_p_coefficient` from the settings (8 to 64, 16 by default), no
   cameras, the calibration file `<calibration_dir>/<calibration_id>.json`.
4. `connect_checked()`: a calibration must exist; `connect(handshake=True)` pings ids 1 to 6 and reads each
   Model_Number (777, no error byte), then each Firmware_Major_Version and Firmware_Minor_Version (all equal);
   `is_calibrated` reads Min_Position_Limit, Max_Position_Limit and Homing_Offset of each servo, which must equal
   the file's (the drive mode is not compared), else the bus is closed with torque as found.
5. `_enable()`, up to 3 attempts on a communication error: sync read Present_Position (steps), sync write
   Goal_Position with it, sync read Goal_Position and require it equal (a sync write gets no answer); then
   lerobot's `configure()`: every servo Torque_Enable 0 and Lock 0; every servo Return_Delay_Time 0,
   Maximum_Acceleration 254, Acceleration 254, Phase read and its bit 0x10 cleared if set; every servo
   Operating_Mode 0, P_Coefficient (16), I_Coefficient 0, D_Coefficient 32, and the gripper Max_Torque_Limit 500,
   Protection_Current 250, Overload_Torque 25; every servo Torque_Enable 1 and Lock 1. Most of these are EEPROM
   writes, at every start.
6. `_check_servos()`: sync read Torque_Enable (all 1) and Status (no bit of 0x01 voltage, 0x02 encoder,
   0x04 temperature, 0x08 current, 0x20 overload; the gripper may show 0x08 and 0x20), else `ServoFault`, torque
   off and the bus closed.
7. Running: `read()` is one sync read of Present_Position (1 retry) and, every `status_poll_ticks` reads, a sync
   read of Status, half a cycle later of Torque_Enable; `send()` is one sync write of Goal_Position.
8. `close()`: every servo Torque_Enable 0 and Lock 0 (5 retries each), then the port is closed.
9. `driver.py` on top: the feedforward is built after the arm is enabled (a failure closes the arm); a failed read
   before the first command raises, after it the last reading is kept and ages; a `ServoFault` always raises; a
   goal is the target plus the offset, never further past a bound than the target.
10. `preflight()` (`pear-station so101 check`): Present_Position, Torque_Enable, Status, Present_Temperature and
    Present_Voltage (tenths of a volt) of every servo, torque left as found.

To decide in the station port: when a servo reports an error, lerobot's `disable_torque` stops at that servo (its
write raises on the error byte), so `close()` leaves the servos after it with torque on and the port open. The
session "a servo reports an error when the arm is closed" shows it. pear.js does the same today.

## Deliberate differences

- The calls are async. Python's block, so two never overlap; here every packet exchange with its retries waits
  for the one before (`FeetechMotorsBus.exchange`). The SDK would answer the second with COMM_PORT_BUSY.
- `PortHandler.isPacketTimeout()` compares the clock with the packet's deadline and reaching it is enough (the SDK:
  time since the start, strictly more than the timeout), so that a wait of exactly the time left ends whatever the
  rounding. The SDK's guard against a clock that runs backwards is dropped: the clock is monotonic.
- The transport is given open and `disconnect()` closes it; `connect()` opens nothing. Baud rate changes, the
  port scan, the broadcast ping and `setup_motor` are not ported.
- Only the STS3215 and protocol 0.
- `txPacket` and `rxPacket` release the port's busy flag when the transport throws; the SDK would leave it set.
- A sync write whose data is shorter than the register throws; the SDK sends a malformed packet.
- Exceptions: every error of this layer has the name of the Python class raised at its place and extends the
  library's class of that name (`src/python/errors.ts`; the places are listed in `docs/progress/common.md`,
  part 3). lerobot's ConnectionError of a failed exchange is `FeetechCommError`, a `ConnectionError` under that
  name that also keeps the SDK's result; its RuntimeError for an error byte is `FeetechStatusError`, a
  `RuntimeError` that keeps the byte; `DeviceAlreadyConnectedError` and `DeviceNotConnectedError` (lerobot's, both
  `ConnectionError`s) and `ServoFault` (PEAR's, a `RuntimeError`) have their own names; the rest are the library's
  `ValueError`, `OverflowError`, `NotImplementedError`, `KeyError`, `IndexError`, `StopIteration` and
  `RuntimeError`. The messages are lerobot's, except "has no calibration registered" (lerobot prints the whole bus
  before it), dictionaries always on one line, and the seven messages in pear.js's own words that
  `docs/progress/common.md` lists ("What turned out to differ", 2). JavaScript's own errors remain where no Python
  is ported: the simulated servos, the two guards of `protocol.ts` that the SDK does not have, `parseCalibration`,
  the number of joint offsets, a port that has no streams after it was opened.
- A port that was closed, was unplugged or failed throws `SerialException` from `WebSerialTransport.read()` and
  `write()`: pyserial's class of that name, an `OSError` as there (pyserial 3.5, checked in PEAR's environment:
  `SerialException`, `OSError`, `Exception`, `BaseException`, `object`), with the browser's own message and the
  browser's error as its `cause`. Before, the transport threw a plain `Error` or the browser's error as it came.
  `connect()` makes lerobot's ConnectionError ("Could not connect on port") of it, as of any `OSError`; a read or
  a write passes it on, as lerobot does. `tests/feetech/web_serial.test.ts`, "a port that is closed, unplugged or
  fails": 4 tests, all 4 fail without it.
- **Stream resilience.** The Web Serial specification (§4.6 readable, "Handling closing the readable stream") says
  a recoverable error (framing, parity, break, buffer overrun) errors the readable stream and nulls the port's
  `[[readable]]` slot; the getter creates a new stream on the next access. A lost device sets `[[readFatal]]` and
  the getter returns null. `WebSerialTransport.pump()` tells the two apart: after a stream fails, if
  `port.readable` is not null and not the same stream object, the port survived and the pump reads the new stream;
  otherwise reading is over. `lineErrors` counts what the port survived. After each error the pump pauses (20 ms
  per error in a row, 500 ms limit), as the page's `ResilientPort` does. What is taken from the specification and
  not seen on a real adapter: that Chrome replaces the stream after a line error. `tests/feetech/web_serial.test.ts`,
  "a line error the port survives": 4 tests, all 4 fail without the stream loop (the pump stops at the first
  error).
- **Robust close.** `close()` sets a closing flag so the pump exits at its next check, cancels the reader, waits
  for the pump, releases the writer's lock and catches `port.close()`'s rejection. A port that was lost or already
  closed throws `InvalidStateError` on `port.close()`, which is now caught. A second `close()` returns at once.
  `tests/feetech/web_serial.test.ts`, "close() on a port that is already gone": 3 tests, 2 fail without the
  catch (the third tests double close, which is guarded by the flag).
- **Late answers are neither missed nor kept.** The SDK's behaviour and how it was found are in
  `docs/progress/station-reference.md`, "Found: a stalled control thread leaves the Feetech SDK one answer
  behind". In a browser a pause longer than a packet's 50 ms is ordinary: a busy page, a garbage collection.
  Three changes, none in what is sent:
  1. `PortHandler.clearPort()` (`bus.ts`), which the packet layer calls before it writes an instruction packet,
     discards what waits in the input: `Transport.read(n, 0)` until it gives nothing. Such bytes answer an
     earlier packet. In an exchange that goes well nothing waits there. `PortHandler.discardsInput = false`
     gives the SDK's behaviour back; the replays of the SDK's recordings set it.
  2. `rxPacket()` (`protocol.ts`) gives a packet up only when a read made after its time was up finds nothing
     more; the SDK gives up at once. An answer that arrived while the host did not run is taken, and nothing is
     asked twice.
  3. `WebSerialTransport.read()` (`transport.ts`) waits one more turn of the event loop when its timer ended the
     wait with nothing. After a pause the timer and the bytes the port received meanwhile are due in the same
     turn; when the timer runs first, the bytes are not yet where the read of 2., which does not wait, could
     find them. A read that gets nothing ends one turn later than before.

  What the bus did before, on a simulated arm read every 20 ms whose host is away for 100 ms during read 3 while
  the six answers (48 bytes) arrive in time (`tests/feetech/stalled_host.test.ts` on the unchanged code: its 6
  tests of the bus and the arm failed):
  - without a retry the read fails, "Failed to sync read 'Present_Position' on ids=[1, 2, 3, 4, 5, 6] after 1
    tries. [TxRxResult] There is no status packet!", with the 48 bytes waiting;
  - with PEAR's one retry it succeeds with a second packet (12 packets where 11 are needed), and each of the
    reads 4 to 9, 6 of 6, returns the positions of the read before;
  - the Status poll that follows returns 12, 153, 38, 239, 1, 21 where every servo's Status is 0: the low bytes
    of the positions of read 9, which PEAR names "shoulder_pan: temperature, current; shoulder_lift: voltage,
    current; elbow_flex: encoder, temperature, overload; wrist_flex: voltage, encoder, temperature, current,
    overload; wrist_roll: voltage; gripper: voltage, temperature";
  - the position read after it returns -31488, -31232, -30976, -30720, -30464 and -30208 steps, made of each
    Status packet's status byte and checksum, and 48 bytes still wait at the end;
  - through `SO101Hardware`, the stall in read 7 and the Status poll in read 10: reads 8 and 9 are one read old,
    read 10 ends with `ServoFault`, "Servo error: shoulder_pan: voltage, temperature, current; shoulder_lift:
    encoder, current; elbow_flex: voltage, encoder, temperature, overload; wrist_flex: overload; wrist_roll:
    encoder; gripper: encoder, temperature", read 11 is no reading of the arm, read 12 is one read old.

  Now every read is the arm's own, the Status reads 0 and 11 packets are sent. The same when the answer is not
  there when the time is up and comes once the read has been tried again (12 packets): the retry takes it, and
  the retry's own answer is discarded before the next packet.

  Each change taken out alone, `tests/feetech`, `tests/sim-bridge`, `tests/modules.test.ts` and `tests/python`
  run (260 pass with all in place), and the file written back with its hash compared:

  | Taken out | Failing | Which |
  | --- | --- | --- |
  | 1, the input discarded | 4 | `stalled_host.test.ts`: an answer that comes after the bus gave up on it (bus, arm); a slow answer to a read that is not tried again; the SDK's recordings |
  | 2, the read after the time is up | 2 | `stalled_host.test.ts`: a stalled read without a retry; nine reads and a poll (12 packets where 11 are needed) |
  | 3, one more turn of the event loop | 2 | `web_serial.test.ts`: the bytes that are due with the read's timer; a bus read on such a port |

  Against the SDK's recordings (`stalled_host.test.ts`, "the SDK's recordings, with what waits in the input
  discarded"): the bus as it is by itself sends 533 of the 533 packets of `bus.json` as recorded and has 173 of
  its 176 outcomes as recorded. The three others follow the recording's two echoes (`operations`, steps 74 and
  96), after which the SDK answers one exchange late. Step 77, a read: 2040 in the SDK, here lerobot's
  RuntimeError "Input voltage error!", which is what the servo answered. Step 97, a read: IndexError in the SDK,
  here 2000. Step 98, a write: acknowledged in the SDK, here RuntimeError "OverEle error!", which is what the
  servo answered.

  Not done: refusing a status packet whose length is not the one the instruction asked for (the SDK takes any
  packet with the right id). It is not certain: no real servo's packets have been seen here, and a servo that
  ever answers a read with another number of bytes would read as silent. It is not simple: tried, it changes a
  recorded outcome (`operations`, step 96: the echo of a write is skipped and the write passes, while the echo
  of a two-byte read, step 74, has the answer's length and is still taken). And it would only help in the case
  below, and there only when the lengths differ.

  What remains of the SDK's behaviour: an answer that arrives after the next instruction packet has been written
  is taken for that packet's answer, once, and nothing stays behind (`stalled_host.test.ts`, "a slow answer to a
  read that is not tried again ..."). A status packet does not say which instruction it answers. When the next
  packet asks for another register, the late answer is read as that register.
- `SO101Hardware.open()` stands for the constructor. No device lock and no `require_commissioned()`. When it
  fails with the bus still connected it disconnects once more, errors ignored: that is what lerobot's
  `Robot.__del__` does when Python drops the follower, and the fixtures hold those packets. A retry of the enable
  is reported through `onWarning`, not logged. The message for a missing calibration is pear.js's own.
- `SO101Driver` is given the arm and the feedforward; PEAR's builds both. It reports a kept reading and a hold
  without its gravity offset through `onWarning`, not a logger.
- Integers never come out as negative zero.

## Left

- The feedforward itself (`joint/feedforward.py`, the gravity model on the URDF): `SO101Driver` takes it as the
  interface `Feedforward`; PEAR's driver also builds it and closes the arm if that fails, which the caller does here.
- `startup.py`: `preflight()` (its report rounds with Python's `round`), `inventory()`.
- lerobot's calibration procedure (`reset_calibration`, `set_half_turn_homings`, `record_ranges_of_motion`,
  `calibrate()`) and motor setup.
- REG WRITE and ACTION, in the protocol and in the simulated servos.
- A real servo, a real adapter (does it echo?), Web Serial's latency against the 50 ms timeout.
- A browser's event loop: whether one more turn is enough for a port to hand over the bytes that came during a
  pause. The test puts the read's timer first on Node's loop; in a browser the order of the two is the browser's.
  If the turn is not enough the read is tried again, and what comes late is discarded before the next packet.
- Whether Chrome replaces the readable stream after a line error, as the specification says. The transport handles
  it, but the tests use a scripted port, not a browser's.

## To reconcile with the other modules

- Done: `JOINTS`, `MOTORS`, `VECTOR_LENGTH` and `GRIPPER_INDEX` are those of `src/so101/layout.ts`, re-exported by
  `motors.ts`; `src/index.ts` exports the modules.
- Done since (`docs/progress/common.md`, part 4): `ARM` is the layout's, which `driver.ts` re-exports; the driver's
  `PositionBounds` are the bounds of the joint layer's `JointLimitValues`, so a robot's `jointLimits()` is given as
  it is; `SO101Driver` extends the joint layer's `JointDriver`.
- Done since (part 4): the arm, its follower and the driver are also made from the checked settings
  (`SO101Hardware.fromConfig`, `makeFollower`, `SO101Driver.fromConfig`), where `HardwareSection` and
  `ControlConfig` have checked the offsets (within 0.2 rad), the ticks (2 to 100), the P gain (8 to 64) and the
  state timeout. `SO101HardwareOptions` and `FollowerConfig` remain the plain entries, unchecked.
- Done since (part 4): `SO101ArmState` is a class that extends the joint layer's `ArmState` (camelCase fields, as
  that class has them); its `feedback()` and `ServoStatus` keep PEAR's keys, because they go into a snapshot as
  they are; `armFeedback()` is that method.
- Done since (part 3): every error of this layer has the name of the Python class raised at its place and extends
  the library's class of that name (`src/python/errors.ts`); `FeetechCommError` is a `ConnectionError` and
  `FeetechStatusError` a `RuntimeError` under those names. The bullet "Exceptions" under "Deliberate differences"
  above says so now; the table of places is in `docs/progress/common.md`, part 3.
- Done since (`docs/progress/common.md`, "What turned out to differ", 5): a Web Serial port that closes or is lost
  throws pyserial's `SerialException`, an `OSError`.
