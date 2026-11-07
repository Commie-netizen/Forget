import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initStore } from '../src/discord/store.mjs';
import { socialRouter } from '../src/social/index.mjs';
const db=new DatabaseSync(':memory:');initStore(db);
let now=Date.now(),deletes=0,foreign=false,rateOnce=false,rateSeen=false;
const calls=[];
const xitem={id:'123',author_id:'42',text:'CURRENT tweet',created_at:'2025-01-01T00:00:00Z'};
const ritem={name:'t3_abc',author:'alice',selftext:'CURRENT reddit',created_utc:1735689600,permalink:'/r/test/comments/abc'};
const response=data=>new Response(JSON.stringify(data));
const app=socialRouter(db,{now:()=>now,sleep:ms=>new Promise(r=>setImmediate(()=>{now+=ms;r();})),fetchImpl:async(url,init)=>{
  const u=new URL(url);calls.push({url,method:init.method,at:now});
  assert(['api.x.com','oauth.reddit.com'].includes(u.hostname));
  if(rateOnce&&!rateSeen){rateSeen=true;return new Response('rate limited',{status:429,headers:{'Retry-After':'2'}});}
  if(u.pathname==='/2/users/me')return response({data:{id:'42',username:'alice'}});
  if(u.pathname==='/api/v1/me')return response({id:'42',name:'alice'});
  if(u.pathname==='/2/users/42/tweets')return response({data:[xitem],meta:{}});
  if(u.pathname==='/user/alice/overview')return response({data:{children:[{data:ritem}],after:null}});
  if(init.method==='GET'&&u.pathname==='/2/tweets/123')return response({data:{...xitem,author_id:foreign?'99':'42'}});
  if(u.pathname==='/api/info')return response({data:{children:[{data:{...ritem,author:foreign?'bob':'alice'}}]}});
  if(init.method==='DELETE'||u.pathname==='/api/del'){
    const p=u.hostname==='api.x.com'?'twitter':'reddit';
    assert(db.prepare('SELECT content FROM discordArchive WHERE platform=?').get(p)?.content.startsWith('CURRENT'));
    if(p==='reddit')assert.equal(init.body,'id=t3_abc');
    deletes++;return response(p==='twitter'?{data:{deleted:true}}:{});
  }
  throw new Error('Unexpected mock call');
}});
const req=async(method,path,body)=>{const r=await app.request(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
async function finished(p,id){for(let i=0;i<10000;i++){const j=(await req('GET',`/${p}/jobs`)).data.find(j=>j.id===id);if(!['queued','running','paused'].includes(j.status))return j;await new Promise(r=>setImmediate(r));}throw new Error('job timeout');}
try{
  assert.equal((await req('GET','/')).data.length,4);
  assert.equal((await req('POST','/twitter/jobs',{ids:['123'],confirm:true})).status,409);
  assert.equal((await req('POST','/facebook/connect',{token:'test'})).status,400);
  globalThis.__FORGET_CIPHER={encrypt:t=>'cipher:'+t,decrypt:t=>t.slice(7)};
  for(const p of ['twitter','reddit']){
    const connected=await req('POST',`/${p}/connect`,{token:'SECRET'});assert.equal(connected.status,200);
    assert(!JSON.stringify(connected.data).includes('SECRET'));assert.equal(connected.data.persistence,'encrypted');
    assert.equal(db.prepare('SELECT secret FROM socialAccount WHERE provider=?').get(p).secret,'cipher:SECRET');
    const mid=p==='twitter'?'123':'t3_abc';
    assert.equal((await req('POST',`/${p}/jobs`,{ids:[mid],confirm:true})).status,400); // not previewed
    assert.equal((await req('GET',`/${p}/posts`)).data.items.length,1);
    assert.equal((await req('POST',`/${p}/jobs`,{ids:[mid]})).status,400);
    const id=(await req('POST',`/${p}/jobs`,{ids:[mid,mid],confirm:true})).data.jobId;
    assert.equal((await req('DELETE',`/${p}/connect`)).status,409);
    assert.equal((await finished(p,id)).deleted,1);
  }
  assert.equal(deletes,2);
  await req('GET','/twitter/posts');foreign=true;
  const foreignJob=(await req('POST','/twitter/jobs',{ids:['123'],confirm:true})).data.jobId;
  assert.equal((await finished('twitter',foreignJob)).status,'failed');assert.equal(deletes,2);foreign=false;
  const paused=(await req('POST','/twitter/jobs',{ids:['123'],confirm:true})).data.jobId;
  await req('POST',`/twitter/jobs/${paused}/pause`);
  assert.equal((await req('GET','/twitter/jobs')).data.find(j=>j.id===paused).status,'paused');
  await req('POST',`/twitter/jobs/${paused}/cancel`);
  assert.equal((await finished('twitter',paused)).status,'cancelled');assert.equal(deletes,2);
  rateOnce=true;const before=calls.length;
  await req('GET','/twitter/posts');
  assert(calls[before+1].at-calls[before].at>=2100);rateOnce=false;
  assert.equal((await req('POST','/facebook/window')).status,409);
  db.prepare("INSERT OR REPLACE INTO setting VALUES ('privacy.offline','false')").run();
  assert.equal((await req('POST','/facebook/window')).status,501);
  let opened='';globalThis.__FORGET_SOCIAL_WINDOW=p=>{opened=p;};
  const result=await req('POST','/instagram/window');assert.equal(opened,'instagram');assert.equal(result.data.authenticated,false);
  await req('DELETE','/twitter/connect');assert.equal((await req('GET','/twitter/status')).data.connected,false);
  console.log('PASS social: 4 platforms, OAuth identity, encrypted secrets, preview binding, confirmations, ownership, archive before delete, both providers, cancellation/pause, 429 cooldown, offline assisted windows, disconnect');
}finally{delete globalThis.__FORGET_CIPHER;delete globalThis.__FORGET_SOCIAL_WINDOW;db.close();}
