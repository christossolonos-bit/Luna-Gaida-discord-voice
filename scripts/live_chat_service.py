#!/usr/bin/env python3
"""YouTube live chat reader (pytchat) for Luna — JSON lines over stdio, read-only."""

from __future__ import annotations

import json
import re
import sys
import time
import traceback
import urllib.request


def _respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _resolve_live_video_id(check_url: str) -> str | None:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    req = urllib.request.Request(check_url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="ignore")
        final_url = resp.geturl()

    patterns = [
        r'"videoId":"([a-zA-Z0-9_-]{11})"',
        r'"externalVideoId":"([a-zA-Z0-9_-]{11})"',
        r'watch\?v=([a-zA-Z0-9_-]{11})',
        r'"url":"https://www\.youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})"',
    ]
    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            return match.group(1)

    match = re.search(r"v=([a-zA-Z0-9_-]{11})", final_url)
    return match.group(1) if match else None


def main() -> int:
    if len(sys.argv) < 2:
        _respond({"type": "error", "message": "missing config json argument"})
        return 1

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as error:
        _respond({"type": "error", "message": f"invalid config json: {error}"})
        return 1

    check_url = config.get("check_url", "").strip()
    poll_sec = float(config.get("poll_sec", 0.5))
    if not check_url:
        _respond({"type": "error", "message": "check_url is required"})
        return 1

    try:
        import pytchat
    except ImportError:
        _respond({"type": "error", "message": "pytchat is not installed (pip install pytchat)"})
        return 1

    video_id = None
    seen_ids: set[str] = set()
    chat = None

    _respond({"type": "starting", "check_url": check_url})

    while True:
        try:
            if chat is None or not chat.is_alive():
                if chat is not None:
                    _respond({"type": "offline", "video_id": video_id})
                    chat = None
                    seen_ids.clear()
                    time.sleep(10)

                video_id = _resolve_live_video_id(check_url)
                if not video_id:
                    _respond({"type": "waiting", "message": "no live stream found"})
                    time.sleep(15)
                    continue

                chat = pytchat.create(video_id=video_id)
                _respond({"type": "ready", "video_id": video_id})

            data = chat.get()
            items = data.sync_items() if hasattr(data, "sync_items") else data.items
            for item in items:
                message_id = getattr(item, "id", "") or ""
                if not message_id or message_id in seen_ids:
                    continue
                seen_ids.add(message_id)
                author = getattr(item.author, "name", "") if getattr(item, "author", None) else ""
                message = getattr(item, "message", "") or ""
                if not message.strip():
                    continue
                _respond(
                    {
                        "type": "chat",
                        "platform": "youtube",
                        "id": message_id,
                        "author": author,
                        "text": message.strip(),
                        "timestamp": getattr(item, "timestamp", None),
                    }
                )

            time.sleep(max(0.2, poll_sec))
        except KeyboardInterrupt:
            break
        except Exception as error:
            _respond({"type": "error", "message": str(error), "trace": traceback.format_exc()[-500:]})
            chat = None
            time.sleep(10)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
