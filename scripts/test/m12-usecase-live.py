#!/usr/bin/env python3
"""One explicitly requested M12 representative flow; never retries a model Run."""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
CONTROLLED = Path.home() / '.local/share/whippet/m10z-20261115/model.env'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--database', required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--server', type=Path, required=True)
    p.add_argument('--manager-test', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--synthetic', action='store_true')
    args = p.parse_args()
    if not args.database.startswith('postgres://postgres:postgres@127.0.0.1:') or '/whippet_m12_w14?' not in args.database:
        raise ValueError('owned_database_required')
    if not args.image.startswith('sha256:') or len(args.image) != 71:
        raise ValueError('pinned_candidate_image_required')
    env = {k: os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG'] if k in os.environ}
    if not args.synthetic:
        info = CONTROLLED.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('controlled_configuration_required')
        allowed = {'WHIPPET_AI_ENABLED','WHIPPET_AI_BASE_URL','WHIPPET_AI_MODEL','WHIPPET_AI_REASONING_EFFORT','OPENCODE_API_KEY'}
        for line in CONTROLLED.read_text().splitlines():
            key,sep,value = line.partition('=')
            if sep and key in allowed:
                env[key] = value
        if not env.get('OPENCODE_API_KEY'):
            raise ValueError('controlled_model_key_missing')
    out = args.out.resolve()
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    env.update(TEST_DATABASE_URL=args.database, WHIPPET_M12_USECASE_MODE='synthetic' if args.synthetic else 'live',
        WHIPPET_M12_USECASE_OUT=str(out), WHIPPET_M12_USECASE_SERVER=str(args.server.resolve()), WHIPPET_M12_USECASE_IMAGE=args.image,
        WHIPPET_M12_MODULE_MANAGER_TEST=str(args.manager_test.resolve()))
    (out/'intent.json').write_text(json.dumps({'mode':env['WHIPPET_M12_USECASE_MODE'],'image':args.image,
        'engine':'vercel','scope':'one owned Plan, no model retries/failover or baseline mutations',
        'budget':'original per-skill snapshots; no increase','provider2':'UNVERIFIED: no second authorized profile/key supplied'},indent=2)+'\n')
    result = subprocess.run([str(args.binary.resolve()),'-test.run=^TestM12RepresentativeUseCaseFlow$','-test.v','-test.timeout=15m'],cwd=REPO,env=env)
    return result.returncode

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"STOP","reason":"controlled_launch_failed"}',file=sys.stderr)
        sys.exit(2)
