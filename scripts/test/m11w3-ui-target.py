#!/usr/bin/env python3
"""Deterministic browser target for the M11 Wave 3 real Agent UI journey.

This serves a page for the external Agent to explore and test. It does not call
Whippet APIs, produce a script, or stand in for an MCP Agent.
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PAGE = """<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wave3 QA 訂單查詢</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; }
    label { display: block; margin: 1.5rem 0 .5rem; }
    input, button { font: inherit; padding: .55rem .8rem; }
    button { margin-left: .5rem; cursor: pointer; }
    #result { margin-top: 1.5rem; padding: 1rem; border: 1px solid #aaa; border-radius: .4rem; }
  </style>
</head>
<body>
  <main>
    <h1>訂單查詢</h1>
    <p>輸入訂單編號，查詢目前狀態。</p>
    <form id="order-form">
      <label for="order-id">訂單編號</label>
      <input id="order-id" name="orderId" autocomplete="off" required>
      <button type="submit">查詢訂單</button>
    </form>
    <section id="result" aria-label="查詢結果" role="status" hidden></section>
  </main>
  <script>
    const form = document.querySelector('#order-form');
    const result = document.querySelector('#result');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const orderId = document.querySelector('#order-id').value.trim();
      result.replaceChildren();
      const heading = document.createElement('h2');
      const detail = document.createElement('p');
      if (orderId === 'W3-OK') {
        heading.textContent = '訂單已完成';
        detail.textContent = '訂單編號 W3-OK，應付總額 NT$320。';
      } else {
        heading.textContent = '查無訂單';
        detail.textContent = '請確認訂單編號後再試一次。';
      }
      result.append(heading, detail);
      result.hidden = false;
    });
  </script>
</body>
</html>
""".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/healthz":
            body, content_type, status = b"ok", "text/plain; charset=utf-8", 200
        elif self.path in ("/", "/index.html"):
            body, content_type, status = PAGE, "text/html; charset=utf-8", 200
        else:
            body, content_type, status = b"not found", "text/plain; charset=utf-8", 404
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        print("READY=true", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("STOPPED=true", flush=True)


if __name__ == "__main__":
    main()
