#!/usr/bin/env python3
"""Screenshot index.html?card=1 to card.png: the preview image texting apps show when the page link is shared."""
import functools
import http.server
import threading

from playwright.sync_api import sync_playwright


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory="."))
threading.Thread(target=server.serve_forever, daemon=True).start()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 1200}, color_scheme="dark")
    page.goto(f"http://127.0.0.1:{server.server_port}/index.html?card=1", wait_until="networkidle", timeout=60000)
    page.wait_for_function("window.cardReady === true", timeout=30000)
    page.wait_for_timeout(2500)  # let the last map tiles paint
    page.screenshot(path="card.png")
    browser.close()
print("card.png written")
