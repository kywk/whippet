"""Observe VAL-2 on the production JPEG viewer without saving any images."""

from base64 import b64encode
from datetime import datetime, timezone
import json
import time
from urllib.parse import urlsplit

from playwright.sync_api import TimeoutError, expect


HOLD_MS = 3000
PALETTE = {"before": [0, 119, 255], "sensitive": [255, 0, 170], "after": [0, 170, 85]}
SCAN_MARKERS = """(image, palette) => {
  const canvas = new OffscreenCanvas(160, 90);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return Object.entries(palette).filter(([name, rgb]) => {
    let matches = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (rgb.every((value, channel) => Math.abs(value - data[i + channel]) <= 32) && ++matches >= 8) return true;
    }
    return false;
  }).map(([name]) => name);
}"""


def scan_frames(page, frames):
    results = []
    for offset in range(0, len(frames), 16):
        encoded = [b64encode(frame).decode("ascii") for frame in frames[offset:offset + 16]]
        results.extend(page.evaluate(f"""async ({{encoded, palette}}) => {{
          const scan = {SCAN_MARKERS};
          const results = [];
          for (const payload of encoded) {{
            try {{
              const bytes = Uint8Array.from(atob(payload), byte => byte.charCodeAt(0));
              if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('expected JPEG');
              const image = await createImageBitmap(new Blob([bytes], {{type: 'image/jpeg'}}));
              try {{ results.push(scan(image, palette)); }} finally {{ image.close(); }}
            }} catch {{ results.push(null); }}
          }}
          return results;
        }}""", {"encoded": encoded, "palette": PALETTE}))
    return results


def calibrate(page, fixture, evidence):
    page.goto(fixture + "/login")
    before = page.screenshot(type="jpeg", quality=55)
    page.get_by_label("Password").fill("val2-detector-control")
    expect(page.locator('[data-marker="sensitive"]')).to_be_visible()
    marked = page.screenshot(type="jpeg", quality=55)
    negative, positive = scan_frames(page, [before, marked])
    evidence.update(before=negative, during=positive)
    if negative != ["before"] or positive != ["sensitive"]:
        raise AssertionError("the unmasked fixture JPEGs must validate the marker detector")


def login_script(origin, role):
    return f'''import {{ expect, test }} from '@playwright/test';
import {{ loginAs }} from 'whippet/login';
test('synthetic customer can log in', async ({{ page }}) => {{
  await page.goto({json.dumps(origin + '/login')});
  const waitForPhase = (phase: string) => page.waitForFunction(async phase => {{
    const response = await fetch('/val2/phase');
    return (await response.json()).phase === phase;
  }}, phase, {{ polling: 250, timeout: 50000 }});
  await waitForPhase('login');
  await loginAs(page, {json.dumps(role)}, '[name="username"]', '[name="password"]', 'button[type="submit"]');
  const outcome = page.getByTestId('val2-outcome');
  await expect(outcome).toBeVisible();
  await waitForPhase('finished');
  await expect(outcome).toHaveText('Authenticated synthetic customer', {{ timeout: 1000 }});
}});'''


def advance(request, fixture, phase):
    response = request.post(f"{fixture}/val2/advance/{phase}", timeout=5000)
    if response.status != 204:
        raise AssertionError(f"VAL-2 fixture cannot advance from {phase} (HTTP {response.status})")


def fixture_phase(request, fixture):
    response = request.get(fixture + "/val2/phase", timeout=5000)
    if response.status != 200:
        raise AssertionError(f"VAL-2 fixture phase unavailable (HTTP {response.status})")
    return response.json()


def wait_for_rendered_marker(page, phase, timeout):
    page.wait_for_function(f"""({{phase, palette}}) => {{
      const image = document.querySelector('[data-testid="live-jpeg"]');
      return image && !image.hidden && image.complete && image.naturalWidth &&
        ({SCAN_MARKERS})(image, palette).includes(phase);
    }}""", arg={"phase": phase, "palette": PALETTE}, timeout=timeout, polling=200)


class ViewerCapture:
    def __init__(self, page, run_id, evidence):
        self.page = page
        self.path = f"/api/runs/{run_id}/live"
        self.started = time.monotonic()
        self.frames = []
        self.signals = []
        self.sockets = []
        self.closed = []
        self.errors = 0
        self.evidence = evidence
        evidence.update(startedAt=datetime.now(timezone.utc).isoformat(), timesMs={})

    def elapsed(self):
        return round((time.monotonic() - self.started) * 1000, 2)

    def attach(self, socket):
        if urlsplit(socket.url).path != self.path:
            return
        self.sockets.append(socket)
        socket.on("framereceived", self.receive)
        socket.on("close", lambda _: self.closed.append(self.elapsed()))
        socket.on("socketerror", self.socket_error)

    def socket_error(self, _):
        self.errors += 1

    def receive(self, payload):
        received = self.elapsed()
        if isinstance(payload, bytes):
            self.frames.append((received, payload))
            return
        try:
            message = json.loads(payload)
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        if message.get("type") == "ready":
            self.signals.append(("ready", received, message.get("viewerId")))
        elif message.get("type") == "state" and message.get("state") == "waiting" and message.get("transport") == "jpeg":
            reason = message.get("reason")
            if reason in ("sensitive_input", "sensitive_input_complete"):
                self.signals.append((reason, received, message.get("viewerId")))

    def summarize(self):
        times = self.evidence["timesMs"]
        started, held, released, stop = (times.get(name) for name in ("loginReleased", "sensitiveObserved", "submitReleased", "viewerCloseRequested"))
        _, ready, viewer_id = next((row for row in self.signals if row[0] == "ready"), (None, None, None))
        pause = next((at for reason, at, viewer in self.signals if reason == "sensitive_input" and viewer == viewer_id), None)
        resume = next((at for reason, at, viewer in self.signals if reason == "sensitive_input_complete" and viewer == viewer_id), None)
        continuous = bool(ready is not None and started is not None and ready < started and viewer_id and
                          len(self.sockets) == 1 and stop is not None and
                          not self.errors and all(at >= stop for at in self.closed))
        frames = list(self.frames)
        self.evidence.update(received=len(frames), socketCount=len(self.sockets), socketErrors=self.errors,
                             continuous=continuous, socketClosedMs=list(self.closed), readyMs=ready,
                             pauseMs=pause, resumeMs=resume)
        decoded = scan_frames(self.page, [frame for _, frame in frames])
        samples = [{"atMs": at, "markers": marks} for (at, _), marks in zip(frames, decoded, strict=True)]
        before = [row for row in samples if started is not None and row["atMs"] < started]
        sensitive = [row for row in samples if held is not None and held <= row["atMs"] and
                     (released is None or row["atMs"] < released)]
        after = [row for row in samples if released is not None and row["atMs"] >= released]
        paused = [row for row in samples if pause is not None and pause <= row["atMs"] and
                  (resume is None or row["atMs"] < resume)]
        marker_hits = sum("sensitive" in (marks or []) for marks in decoded)
        decode_errors = decoded.count(None)
        duration = round(released - held, 2) if held is not None and released is not None else None
        stopped = bool(started is not None and pause is not None and resume is not None and duration is not None and
                       duration >= HOLD_MS and started <= pause <= released <= resume and not sensitive and not paused)
        behavior = "frames_received" if sensitive or paused else "unconfirmed"
        if stopped:
            behavior = "stopped"
        self.evidence.update(samples=samples, inspected=len(decoded), decodeErrors=decode_errors, markerHits=marker_hits,
                             frameCounts={"before": len(before), "sensitive": len(sensitive), "after": len(after),
                                          "transition": len(samples) - len(before) - len(sensitive) - len(after)},
                             sensitiveDurationMs=duration, sensitiveBehavior=behavior)
        normal_before = any("before" in (row["markers"] or []) for row in before)
        normal_after = resume is not None and any(row["atMs"] >= resume and "after" in (row["markers"] or []) for row in after)
        self.evidence["passed"] = bool(continuous and stopped and normal_before and normal_after and
                                       self.evidence.get("cleared") and self.evidence.get("recovered") and
                                       not marker_hits and not decode_errors)


def watch_login(page, request, fixture, run_id, watch_button, trial):
    evidence = trial["viewer"] = {"transport": "jpeg"}
    capture = ViewerCapture(page, run_id, evidence)
    times = evidence["timesMs"]
    page.on("websocket", capture.attach)
    try:
        watch_button.click()
        panel = page.get_by_role("region", name="唯讀監看")
        expect(panel.get_by_text(run_id, exact=True)).to_be_visible()
        jpeg = panel.locator('[data-transport="jpeg"]')
        if not jpeg.is_visible():
            try:
                panel.get_by_role("button", name="切換 JPEG 備援", exact=True).click(timeout=3000)
            except TimeoutError:
                expect(jpeg).to_be_visible()
        wait_for_rendered_marker(page, "before", 25000)
        times["loginReleased"] = capture.elapsed()
        advance(request, fixture, "before")

        # The fixture acknowledges a painted marker independently of the LiveView signals.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if fixture_phase(request, fixture)["phase"] == "sensitive":
                break
            page.wait_for_timeout(150)
        else:
            raise AssertionError("VAL-2 fixture did not enter the marked input phase")
        times["sensitiveObserved"] = capture.elapsed()
        page.wait_for_timeout(HOLD_MS)
        evidence["cleared"] = panel.evaluate("""panel => {
          const image = panel.querySelector('[data-testid="live-jpeg"]');
          const video = panel.querySelector('[data-testid="live-video"]');
          return image.hidden && !image.getAttribute('src') && video.hidden && video.srcObject === null;
        }""")
        times["submitReleased"] = capture.elapsed()
        advance(request, fixture, "sensitive")

        try:
            wait_for_rendered_marker(page, "after", 15000)
            times["afterRendered"] = capture.elapsed()
            evidence["recovered"] = True
        except TimeoutError:
            evidence["recovered"] = False
        times["viewerCloseRequested"] = capture.elapsed()
        panel.get_by_role("button", name="關閉監看面板", exact=True).click()
        panel.wait_for(state="detached")
        trial["siteStatus"] = fixture_phase(request, fixture)["loginStatus"]
    finally:
        page.remove_listener("websocket", capture.attach)
        capture.summarize()
