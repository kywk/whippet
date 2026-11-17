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
    p.add_argument('--replay-artifacts', type=Path, help='explicit frozen real-model Module receipts; replay is marked synthetic/assisted')
    p.add_argument('--reviewed-plan', action='store_true', help='explicit assisted fixture Plan review; never reruns a failed planner')
    p.add_argument('--full', action='store_true', help='M12.Z: one reuse, two new modules and post-publication Run')
    args = p.parse_args()
    if not args.database.startswith('postgres://postgres:postgres@127.0.0.1:') or not any('/whippet_m12_w'+str(w)+'?' in args.database for w in [14,15]):
        raise ValueError('owned_database_required')
    if args.replay_artifacts and (not args.reviewed_plan or not args.replay_artifacts.resolve().is_relative_to(REPO/'docs/research/evidence/m12-wave15-20261117')):
        raise ValueError('owned_reviewed_replay_required')
    if args.reviewed_plan and not args.full:
        raise ValueError('reviewed_plan_requires_full_scope')
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
        WHIPPET_M12_USECASE_OUT=str(out), WHIPPET_M12_USECASE_REPLAY=str(args.replay_artifacts.resolve()) if args.replay_artifacts else '', WHIPPET_M12_USECASE_FULL='1' if args.full else '0', WHIPPET_M12_USECASE_REVIEWED_PLAN='1' if args.reviewed_plan else '0', WHIPPET_M12_USECASE_WAVE='15' if args.full else '14', WHIPPET_M12_USECASE_SERVER=str(args.server.resolve()), WHIPPET_M12_USECASE_IMAGE=args.image,
        WHIPPET_M12_MODULE_MANAGER_TEST=str(args.manager_test.resolve()))
    (out/'intent.json').write_text(json.dumps({'mode':env['WHIPPET_M12_USECASE_MODE'],'image':args.image,
        'engine':'vercel','scope':'one owned Plan, no model retries/failover or baseline mutations','newModules':2 if args.full else 1,'assistedPlanReview':args.reviewed_plan,'replayArtifacts':str(args.replay_artifacts.resolve()) if args.replay_artifacts else None,'postPublicationRun':args.full,
        'budget':'original per-skill snapshots; no increase','provider2':'UNVERIFIED: no second authorized profile/key supplied'},indent=2)+'\n')
    result = subprocess.run([str(args.binary.resolve()),'-test.run=^TestM12RepresentativeUseCaseFlow$','-test.v','-test.timeout=15m'],cwd=REPO,env=env)
    return result.returncode

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"STOP","reason":"controlled_launch_failed"}',file=sys.stderr)
        sys.exit(2)
