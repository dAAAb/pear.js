# Progress: feetech

The Feetech STS3215 protocol over an abstract transport (`src/feetech/`) and the SO-101's servo layer on it
(`src/so101/hardware/`). Reference: lerobot 0.6.1 with feetech-servo-sdk 1.0.0 (`scservo_sdk`), and PEAR at the
pinned commit.

## Done

| File | Ports |
| --- | --- |
| `src/feetech/protocol.ts` | `scservo_sdk`: `scservo_def.py`, `protocol_packet_handler.py` (packets, `txPacket`, `rxPacket`, `txRxPacket`, `ping`, `readTxRx`, `readRx`, `writeTxRx`, `syncReadTx`, `syncWriteTxOnly`, the result and error texts), the parameter lists of `group_sync_read.py` and `group_sync_write.py`. `StatusPacketReader` is `rxPacket`'s loop as a stream parser |
| `src/feetech/transport.ts` | Not in PEAR: `Transport` (write; read at most n bytes within a timeout; close), `Clock`, `ManualClock`, `WebSerialTransport` (the DOM library of this toolchain has no Web Serial types: `SerialPortLike` declares the part used) |
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
npx vitest run tests/feetech                                            # 5 files, 62 tests
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
own traffic (388 packets), a whole PEAR session on the simulated chain, `WebSerialTransport` on fake streams.

Not verified: anything on a real servo or a real serial port. In particular the simulated servos and the fixture
script's chain put the Status register in the error byte of every status packet; that is the protocol manual's
description, not a measurement.

## What the SDK tolerates on the line (and the echo)

- Bytes before a header are dropped; a header with an id above 0xFD, a length above 250 or an error byte above 0x7F
  is not a status packet and the search goes on one byte later; a status packet of another servo is skipped.
- The SDK never discards received bytes: its `clearPort()` is pyserial's `flush()`, which waits for the output.
  A late answer of the same servo is taken for the next exchange's answer.
- A retry is immediate: no pause, nothing cleared. lerobot's `DEFAULT_TIMEOUT_MS` (1000) plays no part in an
  exchange: each sets its own timeout, 50 ms plus the bytes' time, and a sync read's covers all answers together.
- **Echo: not handled.** The echo of an instruction to one servo has a status packet's form and a valid checksum,
  so it is taken for the answer: a read returns its own address and length with error byte 2 and lerobot raises
  "Angle sen error"; the real answer stays in the port and shifts every later exchange (in `bus.json` the next
  read fails on a short packet and the one after returns stale data). Only the echo of a broadcast packet (sync
  read, sync write: id 0xFE) is skipped. pear.js is the same, on purpose; an adapter that echoes needs a transport
  that drops its own bytes.
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
- Exceptions: ConnectionError is `FeetechCommError`; a RuntimeError for an error byte is `FeetechStatusError`,
  any other an `Error`; ValueError and IndexError are `RangeError`; the StopIteration of a sync read or write
  of no motor is an `Error`. The messages are lerobot's, except "has no calibration registered" (lerobot prints
  the whole bus before it) and dictionaries always on one line.
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

## To reconcile with the other modules

- Done: `JOINTS`, `MOTORS`, `VECTOR_LENGTH` and `GRIPPER_INDEX` are those of `src/so101/layout.ts`, re-exported by
  `motors.ts`; `src/index.ts` exports the modules.
- `driver.ts` still defines `ARM` itself, and takes the position bounds as `PositionBounds` (`lowerBounds`,
  `upperBounds`), which are the limits of `config.py`.
- `SO101HardwareOptions` (`jointOffsets`, `statusPollTicks`, `stateTimeoutS`) and `FollowerConfig`
  (`positionPCoefficient`) are what `HardwareConfig` and `ControlConfig` hold in `config.py`; their range checks
  (offsets within 0.2 rad, 2 to 100 ticks, P from 8 to 64) are not repeated here.
- `SO101ArmState` has camelCase fields; `armFeedback()` and `ServoStatus` keep PEAR's keys, because they go into a
  snapshot as they are.
