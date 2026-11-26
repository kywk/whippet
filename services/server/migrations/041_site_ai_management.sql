ALTER TABLE managers
 ADD COLUMN dispatch_state text NOT NULL DEFAULT 'enabled' CHECK (dispatch_state IN ('enabled','paused','draining','removed')),
 ADD COLUMN dispatch_workspace_ids uuid[],
 ADD COLUMN dispatch_revision integer NOT NULL DEFAULT 1 CHECK (dispatch_revision > 0),
 ADD COLUMN last_heartbeat_at timestamptz,
 ADD CHECK ((dispatch_state='removed') = COALESCE(cardinality(dispatch_workspace_ids)=0,false));

ALTER TABLE agent_tokens
 ADD COLUMN claim_paused boolean NOT NULL DEFAULT false,
 ADD COLUMN control_revision integer NOT NULL DEFAULT 1 CHECK (control_revision > 0),
 ADD COLUMN successor_id uuid UNIQUE REFERENCES agent_tokens(id),
 ADD COLUMN interactive_at timestamptz,
 ADD COLUMN claim_at timestamptz,
 ADD UNIQUE (id,workspace_id),
 ADD CHECK (successor_id IS NULL OR (revoked_at IS NOT NULL AND successor_id<>id));

ALTER TABLE workspaces ADD COLUMN agent_routing_revision integer NOT NULL DEFAULT 1 CHECK (agent_routing_revision > 0);

CREATE TABLE site_ai_agents (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 name text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 mode text NOT NULL CHECK (mode IN ('managed','self_managed')),
 engine text NOT NULL CHECK (engine IN ('builtin','vercel','pi')),
 provider text NOT NULL CHECK (provider IN ('opencode','openai-responses')),
 model text NOT NULL,
 runtime jsonb,
 key_version integer CHECK (key_version > 0),
 key_configured boolean NOT NULL DEFAULT false,
 token_id uuid UNIQUE,
 probe_id uuid,
 status text NOT NULL CHECK (status IN ('waiting_connection','verifying','ready','failed','disabled')),
 reason text,
 verified_at timestamptz,
 verified_skills text[] NOT NULL DEFAULT '{}',
 verified_manager_id text REFERENCES managers(id),
 verified_worker_revision text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id),
 FOREIGN KEY(token_id,workspace_id) REFERENCES agent_tokens(id,workspace_id),
 CHECK ((mode='managed' AND runtime IS NOT NULL AND key_version IS NOT NULL AND token_id IS NULL) OR
        (mode='self_managed' AND engine<>'builtin' AND runtime IS NULL AND key_version IS NULL AND NOT key_configured AND token_id IS NOT NULL))
);
CREATE INDEX site_ai_agents_workspace_id ON site_ai_agents(workspace_id,id);
ALTER TABLE agent_tokens ADD COLUMN issued_agent_id uuid,
 ADD FOREIGN KEY(issued_agent_id,workspace_id) REFERENCES site_ai_agents(id,workspace_id);

CREATE TABLE site_ai_agent_keys (
 agent_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 version integer NOT NULL CHECK (version > 0),
 nonce bytea NOT NULL,
 ciphertext bytea NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY (agent_id,version),
 FOREIGN KEY (agent_id,workspace_id) REFERENCES site_ai_agents(id,workspace_id)
);
CREATE UNIQUE INDEX site_ai_one_active_key ON site_ai_agent_keys(agent_id) WHERE revoked_at IS NULL;

CREATE TABLE site_ai_agent_routes (
 workspace_id uuid NOT NULL,
 skill_id text NOT NULL CHECK (skill_id IN ('test-author','workspace-author','acceptance-summary','module-authoring','usecase-planner')),
 agent_id uuid NOT NULL,
 PRIMARY KEY (workspace_id,skill_id),
 FOREIGN KEY (agent_id,workspace_id) REFERENCES site_ai_agents(id,workspace_id)
);

CREATE TABLE site_ai_run_bindings (
 run_id uuid PRIMARY KEY REFERENCES runs(id),
 workspace_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 secret_version integer CHECK (secret_version > 0),
 token_id uuid,
 FOREIGN KEY (agent_id,workspace_id) REFERENCES site_ai_agents(id,workspace_id),
 FOREIGN KEY (token_id,workspace_id) REFERENCES agent_tokens(id,workspace_id),
 CHECK ((secret_version IS NOT NULL) <> (token_id IS NOT NULL))
);
CREATE TRIGGER immutable_site_ai_run_binding BEFORE UPDATE OR DELETE ON site_ai_run_bindings
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
CREATE INDEX site_ai_run_bindings_by_agent ON site_ai_run_bindings(agent_id,secret_version);
CREATE INDEX site_ai_run_bindings_by_token ON site_ai_run_bindings(token_id) WHERE token_id IS NOT NULL;

CREATE TABLE site_ai_provisions (
 id uuid PRIMARY KEY,
 agent_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 manager_id text NOT NULL REFERENCES managers(id),
 manager_epoch uuid NOT NULL,
 worker_revision text NOT NULL,
 skills text[] NOT NULL,
 secret_version integer NOT NULL,
 runtime jsonb NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','sent','cancelling','done')),
 result_status text CHECK (result_status IN ('succeeded','failed','cancelled','timed_out')),
 result_code text,
 reclaimed boolean NOT NULL DEFAULT false,
 deadline_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (agent_id,workspace_id) REFERENCES site_ai_agents(id,workspace_id),
 FOREIGN KEY (agent_id,secret_version) REFERENCES site_ai_agent_keys(agent_id,version),
 CHECK ((state='done') = reclaimed),
 CHECK (NOT reclaimed OR result_status IS NOT NULL)
);
CREATE UNIQUE INDEX site_ai_provisions_one_per_agent ON site_ai_provisions(agent_id) WHERE NOT reclaimed;
CREATE INDEX site_ai_provisions_manager_active ON site_ai_provisions(manager_id) WHERE NOT reclaimed;
CREATE INDEX site_ai_provisions_workspace_active ON site_ai_provisions(workspace_id) WHERE NOT reclaimed;

CREATE TABLE site_ai_mcp_registrations (
 token_id uuid PRIMARY KEY REFERENCES agent_tokens(id),
 id uuid NOT NULL UNIQUE,
 engine text NOT NULL,
 provider text NOT NULL,
 model text NOT NULL,
 skills text[] NOT NULL,
 expires_at timestamptz NOT NULL,
 challenge_id uuid UNIQUE,
 challenge_expires_at timestamptz,
 probe_status text CHECK (probe_status IN ('passed','provider_auth_failed','provider_unavailable','probe_failed')),
 CHECK ((challenge_id IS NULL) = (challenge_expires_at IS NULL))
);

CREATE TABLE site_ai_requests (
 actor_kind text NOT NULL CHECK (actor_kind IN ('user','bootstrap')),
 actor_id text NOT NULL,
 operation text NOT NULL CHECK (operation IN ('create_agent','reissue_access')),
 request_id uuid NOT NULL,
 fingerprint bytea NOT NULL,
 target_id uuid NOT NULL,
 PRIMARY KEY (actor_kind,actor_id,operation,request_id)
);
