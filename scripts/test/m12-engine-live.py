#!/usr/bin/env python3
"""Run only the M12 spike subset using the existing controlled model configuration.

Does not create/install an environment, touch DBs, or print credentials.
Each invocation requires a new output directory; no automatic model retries.
"""
import argparse
import os
from pathlib import Path
import stat
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
MODEL_ENV = Path('/Users/kywk/.local/share/whippet/m10z-20261115/model.env')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['pi', 'vercel'], required=True)
    parser.add_argument('--tasks', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--with-reference-context', action='store_true')
    args = parser.parse_args()
    if MODEL_ENV.is_symlink() or not MODEL_ENV.is_file() or stat.S_IMODE(MODEL_ENV.stat().st_mode) != 0o600:
        raise ValueError('controlled_model_configuration_unavailable')
    settings = {}
    allowed = {'WHIPPET_AI_ENABLED', 'WHIPPET_AI_BASE_URL', 'WHIPPET_AI_MODEL', 'WHIPPET_AI_REASONING_EFFORT', 'OPENCODE_API_KEY'}
    for line in MODEL_ENV.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if separator and key in allowed:
            settings[key] = value
    if not settings.get('OPENCODE_API_KEY'):
        raise ValueError('controlled_model_key_missing')
    # Do not pass unrelated credentials from the invoking shell to the harness.
    child = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR', 'LANG'] if key in os.environ}
    child.update(settings)
    argv = ['node', str(REPO / 'scripts/test/m12-engine-live.mjs'), '--engine', args.engine,
            '--tasks', args.tasks, '--out', str(args.out.resolve())]
    if args.with_reference_context:
        argv.append('--with-reference-context')
    result = subprocess.run(argv, cwd=REPO, env=child)
    return result.returncode

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"STOP","reason":"controlled_launch_failed"}', file=sys.stderr)
        sys.exit(2)
