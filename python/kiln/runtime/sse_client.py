# sse_client.py — minimal server-sent-events POST client, stdlib only.
# Shared by the OpenAI- and Anthropic-compatible provider adapters. Streams the
# response body line by line (http.client decodes chunked transfer as we read),
# yields (event_name, parsed_data) tuples, and stays responsive to the
# cancelled callable: the socket read timeout is dropped to a short POLL_INTERVAL
# after connect, so a stalled stream is re-checked for cancellation regularly
# instead of blocking until an idle-timeout or the server finally responds.
import json
import socket
import urllib.error
import urllib.request

CONNECT_TIMEOUT = 30      # for establishing the connection
POLL_INTERVAL = 2.0       # read timeout while streaming (also the cancel poll)
IDLE_LIMIT = 120          # hard cap on a stream that sends nothing at all


def post_sse(url, headers, payload, cancelled=None, connect_timeout=CONNECT_TIMEOUT):
    """POST json payload; yield (event_name, data) for each SSE event.

    event_name is the 'event:' label or 'data' when unlabeled (OpenAI style).
    data is the parsed JSON value, or the raw string for non-JSON payloads
    (e.g. OpenAI's terminal '[DONE]' marker).
    """
    cancelled = cancelled or (lambda: False)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    resp = None
    last_data = _now()
    try:
        resp = urllib.request.urlopen(req, timeout=connect_timeout)
        # drop the socket read timeout so cancellation is polled while idle
        try:
            resp.fp.raw._sock.settimeout(POLL_INTERVAL)
        except Exception:
            pass
        event = None
        while not cancelled():
            try:
                line = resp.readline()
            except socket.timeout:
                if _now() - last_data > IDLE_LIMIT:
                    raise RuntimeError("connection idle for %ss" % IDLE_LIMIT) from None
                continue  # nothing arrived; loop re-checks cancelled()
            if not line:
                break
            last_data = _now()
            line = line.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("event:"):
                event = line[len("event:"):].strip() or None
            elif line.startswith("data:"):
                d = line[len("data:"):].strip()
                if d == "[DONE]":
                    yield (event or "data"), "[DONE]"
                    event = None
                    continue
                try:
                    yield (event or "data"), json.loads(d)
                except (json.JSONDecodeError, ValueError):
                    yield (event or "data"), d
                event = None
            elif line == "":
                event = None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise RuntimeError("HTTP %s: %s" % (e.code, detail or e.reason)) from None
    except socket.timeout:
        raise RuntimeError("connection timed out") from None
    except OSError as e:
        # aborted because cancelled() turned true mid-read; that's a normal stop
        if not cancelled():
            raise RuntimeError("connection error: %s" % e) from None
    finally:
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass


def _now():
    import time
    return time.monotonic()
