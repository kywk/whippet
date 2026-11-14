import { randomUUID } from "node:crypto";
import { CredentialError, KnownSecrets, validCredentialText, type CredentialResolver, type LoginValues } from "../login/client.js";
import { origin } from "../workspace-context.js";
import type { SessionInput } from "./session.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export class SessionCredentialClient implements CredentialResolver {
  readonly secrets = new KnownSecrets();
  private pending?: { requestId: string; callId: string; roleId: string; resolve: (value: LoginValues) => void; reject: () => void; timer: NodeJS.Timeout };
  private count = 0;
  private closed = false;

  constructor(private readonly input: SessionInput, private readonly send: (frame: unknown) => Promise<void>) {}

  resolve(roleId: string, callId?: string): Promise<LoginValues> {
    const role = this.input.workspaceContext.config?.loginRoles.find(item => item.roleId === roleId);
    const ref = this.input.workspaceContext.roleRefs.find(item => item.roleId === roleId);
    if (this.closed || this.pending || ++this.count > 20 || !uuid.test(roleId) || !callId || !uuid.test(callId) ||
        !role || !ref?.configured || !ref.secretRef || !ref.secretVersion) return Promise.reject(new CredentialError());
    const requestId = randomUUID();
    return new Promise<LoginValues>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 12000);
      this.pending = { requestId, callId, roleId, resolve, reject: () => reject(new CredentialError()), timer };
      void this.send({ kind: "credential_request", sessionId: this.input.sessionId, leaseId: this.input.leaseId, callId, requestId, roleId }).catch(() => this.fail());
    });
  }

  receive(frame: unknown): void {
    const p = this.pending;
    if (!p) return;
    try {
      if (!keys(frame, ["kind", "sessionId", "leaseId", "callId", "requestId", "credentials"]) &&
          !keys(frame, ["kind", "sessionId", "leaseId", "callId", "requestId", "error"])) throw new CredentialError();
      if (frame.kind !== "credential_response" || frame.sessionId !== this.input.sessionId || frame.leaseId !== this.input.leaseId ||
          frame.callId !== p.callId || frame.requestId !== p.requestId || "error" in frame) throw new CredentialError();
      const value = frame.credentials;
      if (!keys(value, ["sessionId", "leaseId", "workspaceId", "roleId", "loginOrigin", "username", "password"])) throw new CredentialError();
      const role = this.input.workspaceContext.config?.loginRoles.find(item => item.roleId === p.roleId);
      if (!role || value.sessionId !== this.input.sessionId || value.leaseId !== this.input.leaseId ||
          value.workspaceId !== this.input.workspaceId || value.roleId !== p.roleId || origin(value.loginOrigin) !== origin(role.loginOrigin) ||
          !validCredentialText(value.username) || !validCredentialText(value.password)) throw new CredentialError();
      this.secrets.add(value.username); this.secrets.add(value.password);
      this.pending = undefined; clearTimeout(p.timer);
      p.resolve({ loginOrigin: value.loginOrigin, username: value.username, password: value.password } as LoginValues);
    } catch { this.fail(); }
  }

  private fail(): void {
    const p = this.pending; this.pending = undefined;
    if (p) { clearTimeout(p.timer); p.reject(); }
  }
  close(): void { this.closed = true; this.fail(); this.secrets.clear(); }
}
