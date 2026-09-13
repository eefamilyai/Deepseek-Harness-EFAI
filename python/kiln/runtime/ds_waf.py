#!/usr/bin/env python3
"""
ds_waf — solve chat.deepseek.com's AWS WAF challenge programmatically.

Protocol (as served by DeepSeek, observed live):

  1. GET https://chat.deepseek.com/            → 202 + HTML challenge page
     containing:
       - the challenge base URL (token.awswaf.com/...)
       - window.gokuProps {key, iv, context}
  2. GET {challenge_base}/inputs?client=browser → {challenge, challenge_type, difficulty}
  3. POST {challenge_base}/mp_verify (NetworkBandwidth) or /verify (pow)
     with a fingerprint signal and the solved answer.
  4. The returned token is exactly the `aws-waf-token` cookie value: set it and
     DeepSeek serves the real app (HTTP 200, no x-amzn-waf-action).

For DeepSeek the challenge type is NetworkBandwidth, difficulty 1: the
"solution" is base64 of 1024 zero bytes. Not a real PoW; still, the
SHA256 / HashcashScrypt paths are included so other AWS WAF sites and future
DeepSeek variants keep working.
"""

import base64
import binascii
import hashlib
import json
import os
import random
import re
import time
import uuid

import ds_identity

# AES-GCM key used to encrypt the browser-fingerprint signal. This key is the
# same one AWS WAF ships in its challenge script on every protected site (both
# reference solvers hardcode it): it is a client-side obfuscation key, NOT a
# secret. Same key means same fingerprint encoding across sites.
_WAF_KEY = bytes.fromhex("6f71a512b1e035eaab53d8be73120d3fb68a0ca346b9560aab3e5cdf753d5e98")

_SITE = "https://chat.deepseek.com"
_DOMAIN = "chat.deepseek.com"

# The SAME browser ds_direct presents. A WAF signal that names a different
# browser than the request that carries it is a contradiction, not a disguise.
_UA = ds_identity.UA

_RE_CHAL_SAME = re.compile(r"(/__challenge_[A-Za-z0-9]+/[a-f0-9]+/[a-f0-9]+)")
_RE_CHAL_EXT = re.compile(
    r"(https://[a-z0-9]+\.[a-z0-9]+\.[a-z0-9-]+\.token\.awswaf\.com/[^/\s\"]+/[^/\s\"]+/[^/\s\"]+)"
)
_RE_CHAL_SDK = re.compile(
    r"(https://[a-z0-9]+\.edge\.sdk\.awswaf\.com/[a-z0-9]+/[a-z0-9]+)/challenge\.js"
)
_RE_GOKU = re.compile(r"window\.gokuProps\s*=\s*(\{.*?\})\s*;")

_ENDPOINT = {
    "HashcashScrypt": "verify",
    "SHA256": "verify",
    "NetworkBandwidth": "mp_verify",
}

_BWDTH_SIZES = {1: 1024, 2: 10240, 3: 102400, 4: 1048576, 5: 10485760}

# A couple of plausible WebGL GPU signatures. The challenge script evaluates
# this fingerprint for bot signals, so the values must look like a real
# browser; these two were captured from real Chrome sessions.
_GPU_POOL = [{"vendor": "Google Inc. (NVIDIA Corporation)", "model": "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 5070/PCIe/SSE2, OpenGL ES 3.2)", "extensions": ["ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_clip_control", "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_disjoint_timer_query", "EXT_float_blend", "EXT_frag_depth", "EXT_polygon_offset_clamp", "EXT_shader_texture_lod", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic", "EXT_texture_mirror_clamp_to_edge", "EXT_sRGB", "KHR_parallel_shader_compile", "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear", "OES_vertex_array_object", "WEBGL_blend_func_extended", "WEBGL_color_buffer_float", "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_lose_context", "WEBGL_multi_draw", "WEBGL_polygon_mode"]}, {"vendor": "Google Inc. (Microsoft)", "model": "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)", "extensions": ["ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_clip_control", "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_float_blend", "EXT_frag_depth", "EXT_polygon_offset_clamp", "EXT_shader_texture_lod", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic", "EXT_texture_mirror_clamp_to_edge", "EXT_sRGB", "KHR_parallel_shader_compile", "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear", "OES_vertex_array_object", "WEBGL_blend_func_extended", "WEBGL_color_buffer_float", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_draw_buffers", "WEBGL_lose_context", "WEBGL_multi_draw", "WEBGL_polygon_mode"]}]

_PLUGINS = [
    {"name": "PDF Viewer", "str": "PDF Viewer "},
    {"name": "Chrome PDF Viewer", "str": "Chrome PDF Viewer "},
    {"name": "Chromium PDF Viewer", "str": "Chromium PDF Viewer "},
    {"name": "Microsoft Edge PDF Viewer", "str": "Microsoft Edge PDF Viewer "},
    {"name": "WebKit built-in PDF", "str": "WebKit built-in PDF "},
]
_PLUGIN_STR = "".join(p["str"] for p in _PLUGINS)
_SCREEN = "1920-1080-1080-24-*-*-*"
_MATH = {"tan": "-1.4214488238747245", "sin": "0.8178819121159085",
         "cos": "-0.5753861119575491"}

_BASE_BINS = [
    14469, 36, 41, 46, 47, 49, 28, 22, 44, 24, 38, 15, 39, 49, 32, 42,
    31, 29, 22, 33, 32, 27, 40, 28, 47, 12, 31, 32, 42, 20, 27, 35,
    118, 22, 22, 31, 22, 13, 27, 26, 27, 17, 27, 33, 15, 29, 29, 30,
    33, 32, 27, 38, 31, 16, 35, 23, 22, 24, 19, 18, 25, 23, 20, 22,
    102, 15, 22, 13, 19, 19, 18, 24, 13, 26, 10, 15, 26, 16, 14, 19,
    16, 20, 18, 26, 18, 49, 15, 19, 24, 22, 19, 17, 15, 20, 21, 22,
    103, 27, 50, 38, 55, 31, 496, 25, 19, 15, 25, 24, 18, 53, 32, 13,
    19, 19, 21, 20, 29, 18, 28, 30, 19, 15, 14, 23, 28, 12, 33, 131,
    41, 35, 33, 29, 8, 15, 13, 17, 28, 33, 41, 21, 35, 23, 26, 33,
    19, 20, 74, 34, 12, 24, 15, 20, 19, 71, 20, 9, 20, 18, 22, 84,
    20, 19, 27, 7, 31, 18, 21, 24, 13, 14, 40, 20, 39, 16, 27, 24,
    29, 17, 18, 27, 16, 14, 16, 26, 13, 17, 14, 22, 20, 15, 20, 99,
    15, 9, 18, 16, 15, 20, 31, 13, 28, 35, 27, 48, 52, 48, 33, 47,
    32, 47, 42, 13, 28, 21, 25, 26, 30, 25, 15, 23, 21, 27, 24, 115,
    41, 30, 16, 20, 26, 17, 24, 36, 24, 32, 24, 60, 28, 33, 25, 37,
    48, 32, 31, 26, 19, 51, 34, 50, 31, 43, 43, 53, 76, 57, 50, 13659,
]

_COLLECTORS = [
    ("fp2", "100", 0.5, 3), ("browser", "101", 0, 1),
    ("capabilities", "102", 2, 8), ("gpu", "103", 3, 12),
    ("dnt", "104", 0, 1), ("math", "105", 0, 1),
    ("screen", "106", 0, 1), ("navigator", "107", 0, 1),
    ("auto", "108", 0, 1), ("stealth", "undefined", 1, 4),
    ("subtle", "110", 0, 1), ("canvas", "111", 80, 200),
    ("formdetector", "112", 0, 3), ("be", "undefined", 0, 1),
]


class WafError(RuntimeError):
    """The WAF challenge could not be solved (or none was served)."""


def _encrypt_signal(plaintext):
    """AES-GCM encrypt the fingerprint exactly the way the browser script does."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    ct = AESGCM(_WAF_KEY).encrypt(iv, plaintext.encode(), None)
    tag = ct[-16:]
    enc = ct[:-16]
    return f"{base64.b64encode(iv).decode()}::{tag.hex()}::{enc.hex()}"


def _encode_fp(obj):
    raw = json.dumps(obj, separators=(",", ":"))
    crc = binascii.crc32(raw.encode()) & 0xFFFFFFFF
    return f"{crc:08X}#{raw}"


def _rand_canvas(rng=None):
    """The canvas hash and histogram for THIS machine.

    Drawn from the identity RNG, not the global one: a real browser returns
    the SAME canvas hash on every challenge, so a value that changed each
    time was itself a bot signal. Called without an rng it still uses the
    identity RNG, because that is the only correct answer here.
    """
    rng = rng or ds_identity.fingerprint_rng()
    bins = []
    for v in _BASE_BINS:
        if v > 500:
            bins.append(v + rng.randint(-200, 200))
        elif v > 80:
            bins.append(v + rng.randint(-15, 15))
        else:
            bins.append(max(1, v + rng.randint(-3, 3)))
    return rng.randint(100000000, 999999999), bins


def _build_metrics(has_token=False):
    enc_t, crypt_t = random.uniform(0.5, 3), random.uniform(2, 8)
    collectors = [(n, mid, round(random.uniform(lo, hi), 1)) for n, mid, lo, hi in _COLLECTORS]
    fp_metrics = {n: int(v) for n, _, v in collectors}
    coll = sum(v for _, _, v in collectors)
    acq = round(coll + enc_t + crypt_t + random.uniform(2, 6), 1)
    chall = random.uniform(2, 8)
    cookie = random.uniform(0.1, 1)
    total = round(acq + chall + cookie, 1)
    m = [{"name": "2", "value": round(enc_t, 1), "unit": "2"}]
    m += [{"name": mid, "value": round(v, 1), "unit": "2"} for _, mid, v in collectors]
    m += [
        {"name": "3", "value": round(crypt_t, 1), "unit": "2"},
        {"name": "7", "value": 1 if has_token else 0, "unit": "4"},
        {"name": "1", "value": acq, "unit": "2"},
        {"name": "4", "value": round(chall, 1), "unit": "2"},
        {"name": "5", "value": round(cookie, 1), "unit": "2"},
        {"name": "6", "value": total, "unit": "2"},
        {"name": "8", "value": 1, "unit": "4"},
    ]
    return m, fp_metrics


def _build_signal(fp_metrics):
    now = int(time.time() * 1000)
    # One RNG for the whole signal, seeded from the machine identity: the GPU
    # and the canvas are properties of THIS browser and must not differ between
    # challenges. Timings and the envelope id stay on the global `random`
    # below, because those legitimately vary per challenge.
    fp_rng = ds_identity.fingerprint_rng()
    gpu = fp_rng.choice(_GPU_POOL)
    ch, cb = _rand_canvas(fp_rng)
    return {
        "metrics": fp_metrics, "start": now, "flashVersion": None,
        "plugins": _PLUGINS, "dupedPlugins": f"{_PLUGIN_STR}||{_SCREEN}",
        "screenInfo": _SCREEN, "referrer": "", "userAgent": _UA, "location": _SITE + "/",
        "webDriver": False,
        "capabilities": {
            "css": {"textShadow": 1, "WebkitTextStroke": 1, "boxShadow": 1,
                    "borderRadius": 1, "borderImage": 1, "opacity": 1,
                    "transform": 1, "transition": 1},
            "js": {"audio": True, "geolocation": True, "localStorage": "supported",
                   "touch": False, "video": True, "webWorker": True},
            "elapsed": fp_metrics["capabilities"],
        },
        "gpu": gpu, "dnt": None, "math": _MATH,
        "automation": {
            "wd": {"properties": {"document": [], "window": [], "navigator": []}},
            "phantom": {"properties": {"window": []}},
        },
        "stealth": {"t1": 0, "t2": 0, "i": 1, "mte": 0, "mtd": False},
        "crypto": {"crypto": 1, "subtle": 1, "encrypt": True, "decrypt": True,
                   "wrapKey": True, "unwrapKey": True, "sign": True, "verify": True,
                   "digest": True, "deriveBits": True, "deriveKey": True,
                   "getRandomValues": True, "randomUUID": True},
        "canvas": {"hash": ch, "emailHash": None, "histogramBins": cb},
        "formDetected": False, "numForms": 0, "numFormElements": 0,
        "be": {"si": False}, "end": now + 1, "errors": [], "version": "2.4.0",
        "id": str(uuid.uuid4()),
    }


def _nav_headers():
    return {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,"
                  "image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Not)A;Brand";v="99", "Chromium";v="134", "Google Chrome";v="134"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent": _UA,
    }


def _api_headers(same_origin):
    return {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "ect": "4g",
        "origin": _SITE,
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": _SITE + "/",
        "sec-ch-ua": '"Not)A;Brand";v="99", "Chromium";v="134", "Google Chrome";v="134"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin" if same_origin else "cross-site",
        "user-agent": _UA,
    }


def _check_zeros(h, difficulty):
    z = 0
    for b in h:
        if b == 0:
            z += 8
        else:
            for i in range(7, -1, -1):
                if (b & (1 << i)) == 0:
                    z += 1
                else:
                    break
            break
    return z >= difficulty


def _solve_pow(challenge_input, checksum, difficulty, ctype, memory=128):
    if ctype == "HashcashScrypt":
        combined = challenge_input + checksum
        salt = checksum.encode()
        for n in range(100000000):
            h = hashlib.scrypt(f"{combined}{n}".encode(), salt=salt,
                               n=memory, r=8, p=1, dklen=32)
            if _check_zeros(h, difficulty):
                return str(n)
    elif ctype == "SHA256":
        base = (challenge_input + checksum).encode()
        for n in range(100000000):
            h = hashlib.sha256(base + str(n).encode()).digest()
            if _check_zeros(h, difficulty):
                return str(n)
    raise WafError(f"unsupported pow challenge type: {ctype}")


def _solve_bandwidth(difficulty):
    size = _BWDTH_SIZES.get(difficulty, 1024)
    return base64.b64encode(b"\x00" * size).decode()


def _discover_challenge(session):
    """GET the site and extract the challenge base URL + gokuProps.

    Returns (challenge_base_url, same_origin, goku_props). Raises WafError when
    the page is NOT a WAF challenge (e.g. already solved, or a real page).
    """
    r = session.get(_SITE + "/", headers=_nav_headers(), impersonate="chrome120", timeout=30)
    if r.status_code != 202 or r.headers.get("x-amzn-waf-action") != "challenge":
        # Either already solved or a network block — no challenge to solve.
        raise WafError(f"no WAF challenge served (HTTP {r.status_code}, "
                       f"waf-action={r.headers.get('x-amzn-waf-action')!r})")
    html = r.text

    m = _RE_CHAL_SAME.search(html)
    if m:
        chal_url = _SITE + m.group(1)
        same = True
    else:
        m = _RE_CHAL_EXT.search(html)
        if not m:
            m = _RE_CHAL_SDK.search(html)
        if not m:
            raise WafError("challenge URL not found in WAF page")
        chal_url = m.group(1)
        same = False

    goku = None
    gm = _RE_GOKU.search(html)
    if gm:
        goku = json.loads(gm.group(1))
    return chal_url, same, goku


def solve_waf(session, site=None, ua=None):
    """Solve the AWS WAF challenge for `session` and return the aws-waf-token.

    `session` is a curl_cffi Session (keeps cookies). On success the session's
    cookie jar is NOT modified here — the caller sets `aws-waf-token` to the
    returned value and persists it. Raises WafError on any failure.
    """
    global _SITE, _DOMAIN, _UA
    if site:
        _SITE = site.rstrip("/")
        _DOMAIN = _SITE.split("//", 1)[1].split("/")[0]
    if ua:
        _UA = ua

    try:
        from curl_cffi import requests as cffi  # noqa: F401
    except Exception as e:
        raise WafError(f"curl_cffi unavailable: {e}") from e

    chal_url, same, goku = _discover_challenge(session)
    hdrs = _api_headers(same)
    metrics, fp_metrics = _build_metrics(has_token=False)
    signal = _build_signal(fp_metrics)
    encoded = _encode_fp(signal)
    checksum = encoded.split("#")[0]
    encrypted = _encrypt_signal(encoded)

    r = session.get(f"{chal_url}/inputs?client=browser", headers=hdrs, timeout=30)
    try:
        inputs = r.json()
    except Exception:
        raise WafError(f"/inputs returned non-JSON: {r.text[:150]}") from None
    challenge = inputs.get("challenge")
    if not challenge or "input" not in challenge:
        raise WafError(f"/inputs missing challenge: {inputs}")

    decoded = json.loads(base64.b64decode(challenge["input"]))
    ctype = decoded.get("challenge_type", "")
    difficulty = decoded.get("difficulty", 1)
    memory = decoded.get("memory", 128)
    endpoint = _ENDPOINT.get(ctype, "verify")

    if ctype == "NetworkBandwidth":
        solution_data = _solve_bandwidth(difficulty)
        meta = {
            "challenge": challenge, "solution": None,
            "signals": [{"name": "Zoey", "value": {"Present": encrypted}}],
            "checksum": checksum, "existing_token": None, "client": "Browser",
            "domain": _DOMAIN, "metrics": metrics,
        }
        if goku:
            meta["goku_props"] = goku
        boundary = "----WebKitFormBoundary" + "".join(
            random.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; "
            f"name=\"solution_data\"\r\n\r\n{solution_data}",
            f"--{boundary}\r\nContent-Disposition: form-data; "
            f"name=\"solution_metadata\"\r\n\r\n"
            f"{json.dumps(meta, separators=(',', ':'))}",
            f"--{boundary}--\r\n",
        ]
        body = "\r\n".join(parts)
        content_type = f"multipart/form-data; boundary={boundary}"
    else:
        solution = _solve_pow(challenge["input"], checksum, difficulty, ctype, memory)
        body = json.dumps({
            "challenge": challenge, "solution": solution,
            "signals": [{"name": "Zoey", "value": {"Present": encrypted}}],
            "checksum": checksum, "existing_token": None, "client": "Browser",
            "domain": _DOMAIN, "metrics": metrics,
            **({"goku_props": goku} if goku else {}),
        }, separators=(",", ":"))
        content_type = "text/plain;charset=UTF-8"

    post_headers = dict(hdrs)
    post_headers["content-type"] = content_type
    r = session.post(f"{chal_url}/{endpoint}", data=body, headers=post_headers, timeout=30)
    try:
        result = r.json()
    except Exception:
        raise WafError(f"/{endpoint} returned non-JSON: {r.text[:150]}") from None
    token = result.get("token")
    if not token:
        raise WafError(f"/{endpoint} returned no token: {result}")
    return token


if __name__ == "__main__":
    from curl_cffi import requests as cffi
    s = cffi.Session()
    tok = solve_waf(s)
    print(tok)
