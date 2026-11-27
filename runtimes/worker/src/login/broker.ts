import {createServer} from 'node:net';
import {chmod,chown,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CredentialClient,MAX_CREDENTIAL_FRAME} from './client.js';
import {parseUniqueJSON} from '../strict-json.js';

export async function loginBroker(client:CredentialClient,uid?:number):Promise<{path:string;close():Promise<void>}> {
  const dir=await mkdtemp(join(tmpdir(),'whippet-login-'));await chmod(dir,0o700);const path=join(dir,'login.sock');
  const sockets=new Set<import('node:net').Socket>();
  const server=createServer((socket)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>undefined);socket.setTimeout(15000,()=>socket.destroy());
    let buffer=Buffer.alloc(0),received=false;
    socket.on('data',(data)=>{
      if(received){socket.destroy();return;}buffer=Buffer.concat([buffer,data]);if(buffer.length>MAX_CREDENTIAL_FRAME){socket.destroy();return;}const n=buffer.indexOf(10);if(n<0)return;received=true;
      void (async () => {
        try {
          const req = parseUniqueJSON(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, n))) as Record<string, unknown>;
          const size = Object.keys(req).length;
          if (size === 1 && Array.isArray(req.secrets)) {
            if (req.secrets.length > 256 || req.secrets.some((v: unknown) => typeof v !== "string" || Buffer.byteLength(v) > 4096)) throw new Error();
            for (const value of req.secrets) client.secrets.add(value);
            socket.end('{"ok":true}\n');
          } else if (size === 1 && typeof req.roleId === "string") {
            const credentials = await client.resolve(req.roleId);
            if (!socket.destroyed) socket.end(JSON.stringify({ credentials }) + "\n");
            credentials.username = ""; credentials.password = "";
          } else if (size === 2 && typeof req.accountId === "string" && typeof req.targetOrigin === "string") {
            const binding = client.accountBinding(req.accountId, req.targetOrigin);
            if (!binding) throw new Error();
            const values = await client.resolveAccount(req.accountId, req.targetOrigin);
            const { accountId, targetOrigin, entryUrl, form } = binding;
            const { loginOrigin, username, password } = values;
            if (!socket.destroyed) socket.end(JSON.stringify({ credentials: { accountId, targetOrigin, entryUrl, form, loginOrigin, username, password } }) + "\n");
            values.username = ""; values.password = "";
          } else throw new Error();
        } catch {
          if (!socket.destroyed) socket.end('{"error":"credential_operation_failed"}\n');
        } finally { buffer = Buffer.alloc(0); }
      })();
    });
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});
    await chmod(path,0o600);
    if(uid!==undefined){await chown(path,uid,uid);await chmod(dir,0o711);}
  }
  catch{server.close();await rm(dir,{recursive:true,force:true});throw new Error('credential_broker_unavailable');}
  return {path,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>((resolve)=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}};
}
