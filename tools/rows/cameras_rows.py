"""Prints the rows of tests/station-robot/cameras.test.ts: what PEAR's CameraFeed and WristCamera do when calls overlap.
The test file's expectations are written by hand, because no record of PEAR holds calls that overlap; its header gives
the rows of this script's run.

It runs PEAR's own CameraFeed (control/cameras.py) with threads, over readers that hold a read or a close until they
are let go, and PEAR's own WristCamera (robots/so101/hardware/cameras.py) over a stand-in for the camera it reads,
whose reader reuses its buffer. It prints the sections a to h and w that the test file's header names: the order of
the readers' calls, what each call returned or raised, the feed's reader after them, and which arrays the wrist
camera's reads share.

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, so that the rows are that commit's:

    <work dir>/envs/station/bin/python tools/rows/cameras_rows.py

It takes no argument, needs no camera, no device and no GPU, and writes nothing: the rows go to the standard output,
and no test reads them. Each thread is given 0.05 s to get inside its call, or to wait for the feed's lock, before the
next one is started: on a machine too busy to start a thread in that time the lines can come in another order.
"""

import threading
import time

import numpy as np

from pear.deploy.station.control.cameras import CameraFeed, CameraSource
from pear.deploy.station.control.robots.so101.hardware.cameras import WristCamera


class Reader(CameraSource):
    def __init__(self, name, log):
        self.name, self.log = name, log
        self.hold_read = None  # an Event that a read waits for
        self.hold_close = None
        self.close_raises = False
        self.read_raises = False
        self.inside = 0
        self.most = 0

    def read_preview(self):
        self.inside += 1
        self.most = max(self.most, self.inside)
        self.log.append(f"{self.name}.read begins")
        if self.hold_read is not None:
            self.hold_read.wait(5)
        self.log.append(f"{self.name}.read ends")
        self.inside -= 1
        if self.read_raises:
            self.read_raises = False
            raise OSError("the camera did not read")
        return {"wrist": {"rgb": self.name, "received_monotonic_s": 0.0, "frame_number": 1}}, {}

    def close(self):
        self.log.append(f"{self.name}.close begins")
        if self.hold_close is not None:
            self.hold_close.wait(5)
        self.log.append(f"{self.name}.close ends")
        if self.close_raises:
            raise OSError("the camera did not close")


def start(call):
    out = {}

    def run():
        try:
            out["value"] = call()
        except Exception as error:
            out["error"] = f"{type(error).__name__}: {error}"

    thread = threading.Thread(target=run)
    thread.start()
    time.sleep(0.05)  # the thread is now inside its call, or waits for the feed's lock
    return thread, out


def shown(out):
    if "error" in out:
        return "raised " + out["error"]
    value = out.get("value")
    if isinstance(value, dict):
        return "frames of " + value["wrist"]["rgb"]
    if isinstance(value, tuple):
        return "preview of " + value[0]["wrist"]["rgb"]
    return f"returned {value!r}"


def name(reader):
    return None if reader is None else reader.name


print("== a: two reads at once")
log = []
a = Reader("A", log)
a.hold_read = threading.Event()
feed = CameraFeed(a)
t1, o1 = start(feed.read)
t2, o2 = start(feed.read_preview)
print("  while the first is under way:", log, "most at once", a.most)
a.hold_read.set()
t1.join(); t2.join()
print("  ", log, "most at once", a.most, "|", shown(o1), "|", shown(o2))

print("== a2: the first of two reads fails")
log = []
a = Reader("A", log)
a.hold_read = threading.Event()
a.read_raises = True
feed = CameraFeed(a)
t1, o1 = start(feed.read)
t2, o2 = start(feed.read)
a.hold_read.set()
t1.join(); t2.join()
print("  ", shown(o1), "|", shown(o2), "| most at once", a.most)

print("== b: a read while a close is pending")
log = []
a = Reader("A", log)
a.hold_close = threading.Event()
feed = CameraFeed(a)
t1, o1 = start(feed.close)
t2, o2 = start(feed.read)
t3, o3 = start(feed.read_preview)
print("  while the close is pending:", log, "reader", name(feed.reader))
a.hold_close.set()
t1.join(); t2.join(); t3.join()
print("  ", log, "| close", shown(o1), "| read", shown(o2), "| preview", shown(o3), "| reader", name(feed.reader))

print("== c: a read while a close that fails is pending")
log = []
a = Reader("A", log)
a.hold_close = threading.Event()
a.close_raises = True
feed = CameraFeed(a)
t1, o1 = start(feed.close)
t2, o2 = start(feed.read)
a.hold_close.set()
t1.join(); t2.join()
print("  ", log, "| close", shown(o1), "| read", shown(o2), "| reader", name(feed.reader))

print("== d: a reader set while a read is under way")
log = []
a, b = Reader("A", log), Reader("B", log)
a.hold_read = threading.Event()
feed = CameraFeed(a)
t1, o1 = start(feed.read)
t2, o2 = start(lambda: feed.set_reader(b))
print("  while the read is under way: reader", name(feed.reader), "set_reader returned", "value" in o2)
a.hold_read.set()
t1.join(); t2.join()
print("  ", log, "| read", shown(o1), "| reader", name(feed.reader), "| next read", shown({"value": feed.read()}))

print("== e: a reader set while a close is pending")
log = []
a, b = Reader("A", log), Reader("B", log)
a.hold_close = threading.Event()
feed = CameraFeed(a)
t1, o1 = start(feed.close)
t2, o2 = start(lambda: feed.set_reader(b))
print("  while the close is pending: reader", name(feed.reader), "set_reader returned", "value" in o2)
a.hold_close.set()
t1.join(); t2.join()
print("  ", log, "| close", shown(o1), "| reader", name(feed.reader), "| next read", shown({"value": feed.read()}))

print("== f: a close while a read is under way")
log = []
a = Reader("A", log)
a.hold_read = threading.Event()
feed = CameraFeed(a)
t1, o1 = start(feed.read)
t2, o2 = start(feed.close)
print("  while the read is under way:", log, "reader", name(feed.reader))
a.hold_read.set()
t1.join(); t2.join()
print("  ", log, "| read", shown(o1), "| close", shown(o2), "| reader", name(feed.reader))

print("== g: two closes at once")
log = []
a = Reader("A", log)
a.hold_close = threading.Event()
feed = CameraFeed(a)
t1, o1 = start(feed.close)
t2, o2 = start(feed.close)
a.hold_close.set()
t1.join(); t2.join()
print("  ", log, "|", shown(o1), "|", shown(o2), "| reader", name(feed.reader))

print("== h: a feed without a reader")
feed = CameraFeed(None)
for call in (feed.read, feed.read_preview, feed.close):
    _, out = start(call)
    print("  ", call.__name__, shown(out))


class FakeThread:
    def is_alive(self):
        return True


class FakeCamera:
    def __init__(self):
        self.thread = FakeThread()
        self.frame_lock = threading.Lock()
        self.latest_frame = None
        self.latest_timestamp = None
        self.is_connected = True


print("== w: the wrist camera over a reader that reuses its buffer")
camera = FakeCamera()
wrist = object.__new__(WristCamera)
wrist.role, wrist.camera, wrist._last_frame_stamp, wrist._frame_count = "wrist", camera, None, 0
buffer = np.full((2, 3, 3), 1, dtype=np.uint8)
camera.latest_frame, camera.latest_timestamp = buffer, time.monotonic()
first = wrist.read_preview()[0]["wrist"]
again = wrist.read_preview()[0]["wrist"]
print("  the frame is the reader's buffer:", first["rgb"] is buffer, "| two reads of one frame give one array:", again["rgb"] is first["rgb"])
print("  numbers", first["frame_number"], again["frame_number"], "| equal", bool((first["rgb"] == buffer).all()), "| type", type(first["rgb"]).__name__, first["rgb"].dtype, first["rgb"].shape)
buffer[:] = 2
camera.latest_timestamp = time.monotonic()
second = wrist.read_preview()[0]["wrist"]
print("  after the reader wrote the next frame into its buffer: first", int(first["rgb"][0, 0, 0]), "again", int(again["rgb"][0, 0, 0]), "second", int(second["rgb"][0, 0, 0]), "number", second["frame_number"])
first["rgb"][:] = 7
print("  after a holder wrote 7 into the first read's frame: buffer", int(buffer[0, 0, 0]), "again", int(again["rgb"][0, 0, 0]), "second", int(second["rgb"][0, 0, 0]))
