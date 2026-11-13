#!/usr/bin/env python3
"""Add a *new* Whippet Agent token to the macOS login Keychain.

The token is read from a hidden terminal prompt and passed to Security.framework
in process memory. Duplicate items are never modified.
"""

import argparse
import ctypes
import getpass
import sys


MAX_TOKEN = 8192


def add_new(service, account, token):
    if not service or not account or not isinstance(token, str):
        return "invalid_input"
    try:
        service_bytes = service.encode("utf-8")
        account_bytes = account.encode("utf-8")
        token_bytes = token.encode("ascii")
    except UnicodeError:
        return "invalid_input"
    if (not token_bytes or len(token_bytes) > MAX_TOKEN
        or any(c < 33 or c > 126 for c in token_bytes)
        or any(c in service_bytes + account_bytes for c in (0, 10, 13))):
        return "invalid_input"
    try:
        security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        add = security.SecKeychainAddGenericPassword
        add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
                        ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                        ctypes.c_void_p, ctypes.c_void_p]
        add.restype = ctypes.c_int32
        service_buffer = ctypes.create_string_buffer(service_bytes)
        account_buffer = ctypes.create_string_buffer(account_bytes)
        token_buffer = ctypes.create_string_buffer(token_bytes)
        try:
            status = add(None, len(service_bytes), service_buffer,
                         len(account_bytes), account_buffer,
                         len(token_bytes), token_buffer, None)
        finally:
            ctypes.memset(token_buffer, 0, len(token_buffer))
    except (OSError, AttributeError, ValueError):
        return "keychain_unavailable"
    if status == 0:
        return "created"
    if status == -25299:  # errSecDuplicateItem
        return "item_exists"
    return "keychain_unavailable"


def main():
    parser = argparse.ArgumentParser(description="Create a new Whippet Keychain item")
    parser.add_argument("--keychain-service", required=True)
    parser.add_argument("--keychain-account", required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        print("terminal_required", file=sys.stderr)
        return 2
    token = getpass.getpass("New Whippet Agent token: ")
    outcome = add_new(args.keychain_service, args.keychain_account, token)
    print(outcome)
    return 0 if outcome == "created" else 1


if __name__ == "__main__":
    sys.exit(main())
