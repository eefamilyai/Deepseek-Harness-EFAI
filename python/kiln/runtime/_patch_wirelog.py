# Wire ds_wirelog into ds_direct: install at session construction, and record a
# verdict WITH its preamble at each of the four _Muted raise sites.
#
# Written as a script because multi-line `edit` calls kept arriving mangled.
# Every replacement is checked by exact count: 1 -> apply, 0 -> already done,
# anything else -> refuse and change nothing.
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "ds_direct.py")

# 1) import
OLD_IMPORT = '''import ds_hif
import ds_identity
'''
NEW_IMPORT = '''import ds_hif
import ds_identity
import ds_wirelog
'''

# 2) install at construction. Session.get/post both delegate to Session.request,
#    so ONE wrap here covers login, PoW, upload and completion alike.
OLD_INIT = '''    def __init__(self, account):
        self.sess = cffi.Session()
        self.account = account
'''
NEW_INIT = '''    def __init__(self, account):
        self.sess = cffi.Session()
        # Journal every request this account makes, when enabled (KILN_DS_WIRELOG=1
        # or a `ds_wirelog.on` marker). One wrap covers every call site because
        # Session.get/post both delegate to Session.request. Off by default, and
        # header VALUES are never written -- only short fingerprints -- so this
        # cannot leak a token into a log.
        ds_wirelog.install(self.sess, account=getattr(account, "id", None))
        self.account = account
'''

# 3) the four _Muted raise sites. Each records the verdict TOGETHER with the ring
#    of requests that preceded it -- the whole point, because the mute always
#    lands long after the request that caused it.
SITES = [
    (
        "pow",
        '''            muted = _mute_of(payload)
            if muted:
                raise _Muted(
                    "DeepSeek has muted this account: %s. Re-logging in will not "
                    "clear it; switch to another account or wait for it to lift."
                    % muted)''',
        '''            muted = _mute_of(payload)
            if muted:
                ds_wirelog.verdict("mute", muted,
                                   account=getattr(self.account, "id", None))
                raise _Muted(
                    "DeepSeek has muted this account: %s. Re-logging in will not "
                    "clear it; switch to another account or wait for it to lift."
                    % muted)''',
    ),
    (
        "upload",
        '''        muted = _mute_of(payload)
        if muted:
            raise _Muted(
                "DeepSeek has muted this account: %s. Re-logging in will not "
                "clear it; switch to another account or wait for it to lift."
                % muted)''',
        '''        muted = _mute_of(payload)
        if muted:
            ds_wirelog.verdict("mute", muted,
                               account=getattr(self.account, "id", None))
            raise _Muted(
                "DeepSeek has muted this account: %s. Re-logging in will not "
                "clear it; switch to another account or wait for it to lift."
                % muted)''',
    ),
    (
        "stream",
        '''            muted = _mute_verdict_in(raw_sink)
            if muted:
                _persist_cookies(client)
                raise _Muted(''',
        '''            muted = _mute_verdict_in(raw_sink)
            if muted:
                _persist_cookies(client)
                ds_wirelog.verdict("mute", muted,
                                   account=getattr(client.account, "id", None))
                raise _Muted(''',
    ),
    (
        "vision",
        '''        muted = _mute_verdict_in(raw_sink)
        if muted:
            raise _Muted(
                "DeepSeek has muted this account: %s. This is an account-level "''',
        '''        muted = _mute_verdict_in(raw_sink)
        if muted:
            ds_wirelog.verdict("mute", muted,
                               account=getattr(client.account, "id", None))
            raise _Muted(
                "DeepSeek has muted this account: %s. This is an account-level "''',
    ),
]


def apply(src, label, old, new):
    n = src.count(old)
    print("  %-8s occurrences=%d" % (label, n))
    if n != 1:
        return None
    return src.replace(old, new)


def main():
    src = io.open(TARGET, encoding="utf-8").read()
    print("--- ds_direct.py ---")
    for label, old, new in [("import", OLD_IMPORT, NEW_IMPORT), ("init", OLD_INIT, NEW_INIT)]:
        out = apply(src, label, old, new)
        if out is None:
            print("    REFUSED -- nothing written")
            return 1
        src = out
    for label, old, new in SITES:
        out = apply(src, label, old, new)
        if out is None:
            print("    REFUSED -- nothing written")
            return 1
        src = out
    io.open(TARGET, "w", encoding="utf-8", newline="").write(src)
    print("WROTE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
