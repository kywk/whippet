#!/usr/bin/env python3
"""E2E-only bridge: receive an ephemeral token over a private local socket."""
import argparse
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/local-mcp'))
from bridge import Bridge, BridgeError, MAX_FRAME, MAX_TOKEN, error_frame


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--url', required=True)
    p.add_argument('--token-socket', required=True)
    a = p.parse_args()
    def read_token(*_):
        try:
            with socket.socket(socket.AF_UNIX) as sock:
                sock.settimeout(5)
                sock.connect(a.token_socket)
                data = bytearray()
                while len(data) <= MAX_TOKEN:
                    part = sock.recv(MAX_TOKEN + 1 - len(data))
                    if not part:
                        break
                    data.extend(part)
                if not data or len(data) > MAX_TOKEN or any(c < 33 or c > 126 for c in data):
                    raise ValueError()
                return data.decode('ascii')
        except Exception:
            raise BridgeError('keychain_unavailable') from None
    bridge = Bridge(a.url, 'ephemeral', 'agent', token_reader=read_token)
    while True:
        frame = sys.stdin.buffer.readline(MAX_FRAME + 2)
        if not frame:
            break
        if len(frame) > MAX_FRAME + 1:
            while frame and not frame.endswith(b'\n'):
                frame = sys.stdin.buffer.readline(MAX_FRAME + 2)
            reply = error_frame('frame_too_large')
        else:
            reply = bridge.process(frame.rstrip(b'\r\n'))
        if reply is not None:
            sys.stdout.buffer.write(reply + b'\n')
            sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
