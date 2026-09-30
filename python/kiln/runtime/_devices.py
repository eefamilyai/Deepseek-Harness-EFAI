# Does every account send the SAME x-device-id?
#
# The operator's second suspicion, in their words: "a device_id is tied to 1
# browser, so if i login then again login without signing out, theres definitely
# something suspicious."
#
# That theory has a testable form I had not run. If several ACCOUNTS all present
# ONE device id, then from DeepSeek's side a single device is running a fleet of
# accounts -- which is the classic multi-account pattern, and is exactly what a
# device-bound anti-abuse rule would act on. If instead each account has its own
# device id, that shape does not exist.
#
# `_device_id_for(acct)` decides the value, so this reads it directly rather than
# inferring from logs. It prints a FINGERPRINT of each id, not the id: the value
# is a credential-adjacent identifier and does not need to be in a report.
#
# Read-only. Touches no account and sends nothing.
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402


def fp(s):
    if not s:
        return "(empty)"
    return hashlib.sha256(str(s).encode()).hexdigest()[:12]


def main():
    accts = ds._read_accounts_from_disk()
    print("=== %d account(s) in the pool ===" % len(accts))
    print()
    rows = []
    for a in accts:
        try:
            did = ds._device_id_for(a)
        except Exception as e:  # noqa: BLE001
            did = None
            print("  %-34s _device_id_for raised: %s" % (a.id, e))
        rows.append((a.id, did))
    print("  %-34s %-14s %s" % ("account", "device fp", "source"))
    print("  " + "-" * 62)
    for aid, did in rows:
        # `device_id` on the account object means it was configured explicitly;
        # otherwise the value is derived. Distinguishing them matters: a shared
        # DERIVED value is a code behaviour, a shared CONFIGURED value is a choice.
        configured = str(getattr(a, "device_id", "") or "").strip()
        src = "configured" if configured else "derived"
        print("  %-34s %-14s %s" % (aid, fp(did), src))

    print()
    distinct = {fp(d) for _, d in rows}
    print("=== verdict ===")
    print("  distinct device fingerprints: %d across %d account(s)"
          % (len(distinct), len(rows)))
    if len(distinct) == 1 and len(rows) > 1:
        print("  *** EVERY account presents the SAME device id. From DeepSeek's")
        print("      side one device is running %d accounts -- the multi-account" % len(rows))
        print("      shape a device-bound rule would act on. Worth acting on.")
    else:
        print("  Each account presents a DIFFERENT device id, so the fleet does not")
        print("  look like one device running many accounts. The operator's")
        print("  device-reuse theory is not supported by the device ids either.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
