import {createServer} from 'node:net';
import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CredentialClient,MAX_CREDENTIAL_FRAME} from './client.js';

export async function loginBroker(client:CredentialClient):Promise<{path:string;close():Promise<void>}> {
  const dir=await mkdtemp(join(tmpdir(),'whippet-login-'));await chmod(dir,0o700);const path=join(dir,'login.sock');
  const sockets=new Set<import('node:net').Socket>();
  const server=createServer((socket)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>undefined);socket.setTimeout(15000,()=>socket.destroy());
    let buffer=Buffer.alloc(0),received=false;
    socket.on('data',(data)=>{
      if(received){socket.destroy();return;}buffer=Buffer.concat([buffer,data]);if(buffer.length>MAX_CREDENTIAL_FRAME){socket.destroy();return;}const n=buffer.indexOf(10);if(n<0)return;received=true;
      void (async()=>{try{const req=JSON.parse(buffer.subarray(0,n).toString('utf8'));if(Object.keys(req).length!==1)throw new Error();
        if(Array.isArray(req.secrets)){if(req.secrets.length>256||req.secrets.some((v:unknown)=>typeof v!=='string'||Buffer.byteLength(v)>4096))throw new Error();for(const value of req.secrets)client.secrets.add(value);socket.end('{"ok":true}\n');return;}
        if(typeof req.roleId!=='string')throw new Error();const credentials=await client.resolve(req.roleId);if(!socket.destroyed)socket.end(JSON.stringify({credentials})+'\n');}catch{if(!socket.destroyed)socket.end('{"error":"credential_operation_failed"}\n');}finally{buffer=Buffer.alloc(0);}})();
    });
  });
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});await chmod(path,0o600);}
  catch{server.close();await rm(dir,{recursive:true,force:true});throw new Error('credential_broker_unavailable');}
  return {path,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>((resolve)=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}};
}
