#!/usr/bin/env python3
"""Screenshot index.html?card=1 to card.png (4:3, for Messages and most apps) and index.html?card=x to card-x.png
(2:1, the shape X/Twitter crops link previews to)."""
import functools
import http.server
import os
import threading

from playwright.sync_api import sync_playwright


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory="."))
threading.Thread(target=server.serve_forever, daemon=True).start()

with sync_playwright() as p:
    # CARD_BROWSER=chrome uses an installed Google Chrome (GitHub's runners have one), so no browser download or system
    # packages are needed; otherwise Playwright's own Chromium (the Mac's venv has it).
    channel = os.environ.get("CARD_BROWSER")
    browser = p.chromium.launch(channel=channel) if channel else p.chromium.launch()
    for mode, size, out in (("1", (1200, 900), "card.png"), ("x", (1200, 628), "card-x.png")):
        page = browser.new_page(viewport={"width": size[0], "height": size[1]}, color_scheme="dark")
        page.goto(f"http://127.0.0.1:{server.server_port}/index.html?card={mode}", wait_until="networkidle", timeout=60000)
        page.wait_for_function("window.cardReady === true", timeout=30000)
        page.wait_for_timeout(2500)  # let the last map tiles paint
        page.screenshot(path=out)
        page.close()
        print(f"{out} written")
    browser.close()
