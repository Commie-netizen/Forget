import React, { useRef, useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Field, Notice } from '../components/Card.jsx';
import { Confirm } from '../components/Modal.jsx';
import Progress from '../components/Progress.jsx';
import { nf, fmtDate } from '../lib.js';

const NAMES = {twitter:'Twitter/X',reddit:'Reddit',facebook:'Facebook',instagram:'Instagram'};
const DEFAULT_REDIRECT = 'http://127.0.0.1:53682/forget/callback';
const DEV_PORTAL = {twitter:"developer.x.com (Native App, public client)",reddit:"reddit.com/prefs/apps (installed app)"};
const readPref = (k, d='') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const writePref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* optional local preference */ } };
export default function Social() {
  const { page: provider, reloadSocial } = useApp();
  const base=`/social/${provider}`, name=NAMES[provider], assisted=['facebook','instagram'].includes(provider);
  const account=useLoad(()=>api.get(`${base}/status`),{poll:true});
  const jobs=useLoad(()=>api.get(`${base}/jobs`),{enabled:!assisted,poll:true});
  const [token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[info,setInfo]=useState('');
  const [items,setItems]=useState([]),[next,setNext]=useState(null),[loaded,setLoaded]=useState(false),[selected,setSelected]=useState(new Set());
  const [query,setQuery]=useState(''),[since,setSince]=useState(''),[until,setUntil]=useState(''),[confirm,setConfirm]=useState(false);
  const [exclude,setExclude]=useState(''),[manual,setManual]=useState(false);
  const [clientId,setClientId]=useState(()=>readPref(`forget.oauth.${provider}.clientId`)),[redirectUri,setRedirectUri]=useState(()=>readPref(`forget.oauth.${provider}.redirect`,DEFAULT_REDIRECT));
  const lastIdx=useRef(-1);
  const connected=account.data?.connected;
  const active=(jobs.data||[]).some(j=>['queued','running','paused'].includes(j.status));
  const excluded=exclude.split(',').map(w=>w.trim().toLowerCase()).filter(Boolean);
  const visible=items.filter(m=>(!query||m.text.toLowerCase().includes(query.toLowerCase()))&&(!excluded.length||!excluded.some(w=>m.text.toLowerCase().includes(w)))&&(!since||(m.date&&Date.parse(m.date)>=Date.parse(since)))&&(!until||(m.date&&Date.parse(m.date)<Date.parse(until)+86400000)));
  // Shift+click applies the clicked state to the range from the last clicked item (in the filtered list).
  function toggle(idx,shift){const m=visible[idx];setSelected(s=>{const n=new Set(s),on=!n.has(m.id);const a=shift&&lastIdx.current>=0?Math.min(lastIdx.current,idx):idx,b=shift&&lastIdx.current>=0?Math.max(lastIdx.current,idx):idx;for(const x of visible.slice(a,b+1)){if(on){if(n.size<500)n.add(x.id);}else n.delete(x.id);}return n;});lastIdx.current=idx;}
  async function act(fn){setBusy(true);setError('');setInfo('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function load(more=false){await act(async()=>{const r=await api.get(`${base}/posts`+api.qs({after:more?next:null}));setItems(old=>more?[...new Map([...old,...r.items].map(x=>[x.id,x])).values()]:r.items);setNext(r.next);setLoaded(true);if(!more)setSelected(new Set());});}
  async function connected_(){setItems([]);setSelected(new Set());setLoaded(false);await account.reload();await reloadSocial();}
  async function connect(e){e.preventDefault();await act(async()=>{await api.post(`${base}/connect`,{token});setToken('');await connected_();});}
  async function oauth(e){e.preventDefault();await act(async()=>{writePref(`forget.oauth.${provider}.clientId`,clientId.trim());writePref(`forget.oauth.${provider}.redirect`,redirectUri.trim());await api.post(`${base}/oauth`,{clientId:clientId.trim(),redirectUri:redirectUri.trim()});await connected_();});}
  return <>
    <PageHeader title={name} subtitle={assisted?"Personal account · guided cleanup in the official interface.":"Your posts · selection, local archive, and deletion via API."}/>
    {(error||account.error) && <Notice tone="error">{error||account.error}</Notice>}
    {info&&<Notice tone="info">{info}</Notice>}
    {assisted ? <>
      <Card title={`Clean up my account on ${name}`} subtitle="A dedicated window keeps your session local and lets you control the selection.">
        <div className="stack">
          <Notice>This is a guided process: you select and confirm deletions in {name}. Forget does not automate these clicks or read your password.</Notice>
          <ol className="summary">
            <li>Open the window and log in directly on {name}.</li>
            <li>{provider==='facebook'?"From your profile, open Activity log / Manage posts.":"Open More → Your activity → Photos and videos → Posts."}</li>
            <li>Filter by date, select items, and use the platform’s controls.</li>
            <li>Review and confirm in the official window. Available options may vary by account.</li>
          </ol>
          <p className="muted small">This process does not create a Forget archive or report deletion counts. Export your data from the platform to keep a copy.</p>
          <div><button className="btn primary" disabled={busy} onClick={()=>act(async()=>{await api.post(`${base}/window`);setInfo("Window open. Log in and delete content directly on the platform.");})}>{busy?"Opening…":`Open ${name}`}</button></div>
        </div>
      </Card>
    </> : <>
      <Card title={connected?`Connected: ${account.data.user.name}`:"Connect my account"} subtitle="User OAuth authentication through your platform API access.">
        {connected?<div className="row wrap"><span className="grow muted small">{account.data.persistence==='encrypted'?"Token encrypted locally.":"Token kept in memory for this session only."}{account.data.oauth?.renewable?" Automatic renewal active.":''}</span><button className="btn" disabled={busy||active} onClick={()=>act(async()=>{await api.del(`${base}/connect`);setItems([]);setSelected(new Set());setLoaded(false);await account.reload();await reloadSocial();})}>Disconnect</button></div>:<div className="stack"><form className="stack" onSubmit={oauth}>
          <p className="muted">Official OAuth login: the {name} page opens for you to log in and authorize access. Forget never sees your password.</p>
          <p className="muted small">First create your own application on {DEV_PORTAL[provider]}, register the exact redirect URL below, then copy its Client ID. Forget does not provide or include credentials.</p>
          <div className="grid-fields"><Field label="Your application’s Client ID"><input value={clientId} onChange={e=>setClientId(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Client ID…"/></Field>
          <Field label="Registered redirect URL" hint="Intercepted by Forget; nothing listens on this port."><input value={redirectUri} onChange={e=>setRedirectUri(e.target.value)} spellCheck={false}/></Field></div>
          <p className="muted small">Requested permissions: {account.data?.oauth?.scopes||account.data?.scopes||"loading…"}</p>
          <div><button className="btn primary" disabled={busy||!clientId.trim()||!redirectUri.trim()}>{busy?"Connecting…":`Log in with ${name}`}</button> <button type="button" className="btn link" onClick={()=>setManual(v=>!v)}>{manual?"Hide manual entry":"I already have an access token"}</button></div>
        </form>{manual&&<form className="stack" onSubmit={connect}>
          <p className="muted">Use an OAuth token for your own account, issued by an authorized application. Login cookies and application-only tokens will not work.</p>
          <Field label="User OAuth token" hint={`Required permissions: ${account.data?.scopes||"loading…"}`}><input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder="Access token…"/></Field>
          <p className="muted small">{provider==='twitter'?"Access to X endpoints depends on your API plan and available credits.":"Reddit API access must be authorized for your application."} The token may expire; reconnect the account if needed.</p>
          <div><button className="btn primary" disabled={busy||!token.trim()}>{busy?"Checking…":"Verify and connect"}</button></div>
        </form>}</div>}
      </Card>
      {connected&&<Card title="My posts" subtitle={provider==='reddit'?"Posts and comments from the connected account.":"Posts from the connected account available through the timeline API."}>
        <div className="stack">
          <div className="row wrap"><button className="btn primary" disabled={busy||active} onClick={()=>load(false)}>{loaded?"Refresh":"Load my posts"}</button><span className="muted small">{nf(items.length)} loaded · {nf(selected.size)} selected</span></div>
          <div className="grid-fields"><Field label="Contains"><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Word or phrase…"/></Field><Field label="Exclude (comma-separated words)"><input value={exclude} onChange={e=>setExclude(e.target.value)} placeholder="keep, important…"/></Field><Field label="From (UTC)"><input type="date" value={since} max={until||undefined} onChange={e=>setSince(e.target.value)}/></Field><Field label="Until (UTC)"><input type="date" value={until} min={since||undefined} onChange={e=>setUntil(e.target.value)}/></Field></div>
          <div className="row wrap"><button className="btn sm" disabled={active||!visible.length} onClick={()=>setSelected(new Set(visible.slice(0,500).map(m=>m.id)))}>Select results (max. 500)</button><button className="btn sm" disabled={active||!visible.length} onClick={()=>setSelected(s=>{const n=new Set(s);for(const m of visible){if(n.has(m.id))n.delete(m.id);else if(n.size<500)n.add(m.id);}return n;})}>Invert selection</button><button className="btn sm" disabled={active||!selected.size} onClick={()=>setSelected(new Set())}>Deselect all</button><span className="muted small">Shift+click to select a range.</span></div>
          <div className="conversation-table">{visible.map((m,idx)=><label className="conversation-row" key={m.id} onClick={e=>{if(e.target.tagName!=='INPUT'){e.preventDefault();if(!active)toggle(idx,e.shiftKey);}}}><input type="checkbox" checked={selected.has(m.id)} disabled={active||(!selected.has(m.id)&&selected.size>=500)} onClick={e=>{e.preventDefault();toggle(idx,e.shiftKey);}} onChange={()=>{}}/><span className="grow"><span className="muted small">{m.kind} · {m.date?fmtDate(m.date):"Unknown date"}</span><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{m.text||"(no text)"}</p></span></label>)}{loaded&&!visible.length&&<p style={{padding:16}} className="muted">No posts match these filters in the loaded pages.</p>}</div>
          {next&&<button className="btn" disabled={busy||active} onClick={()=>load(true)}>Load next page</button>}
          <div className="execution-bar"><p className="muted small">Text and metadata are archived before deletion. Media is not downloaded.</p><button className="btn danger-solid" disabled={busy||active||!selected.size} onClick={()=>setConfirm(true)}>Delete {nf(selected.size)} items…</button></div>
        </div>
      </Card>}
      {(jobs.data||[]).length>0&&<Card title="Operation progress"><div className="stack">
        {account.data?.waitMs>1000&&<Notice>Waiting for the next request: about {Math.ceil(account.data.waitMs/1000)} s. Platform rate limits are respected.</Notice>}
        {jobs.error&&<Notice tone="error">{jobs.error}</Notice>}
        {(jobs.data||[]).map(j=><div className="job" key={j.id}><div className="row wrap"><strong>{{queued:"Queued",running:"Running",paused:"Paused",cancelled:"Cancelled",failed:"Stopped on error",done:"Completed",interrupted:"Interrupted"}[j.status]||j.status}</strong><span className="grow">{j.deleted}/{j.total} deleted · {j.failed} failures</span>{['running','queued','paused'].includes(j.status)&&<><button className="btn sm" disabled={busy} onClick={()=>act(async()=>{await api.post(`${base}/jobs/${j.id}/${j.status==='paused'?'resume':'pause'}`);await jobs.reload(true);})}>{j.status==='paused'?"Resume":'Pause'}</button><button className="btn sm danger" disabled={busy} onClick={()=>act(async()=>{await api.post(`${base}/jobs/${j.id}/cancel`);await jobs.reload(true);})}>Stop</button></>}</div><Progress value={j.deleted} max={j.total} label="Deletion progress"/>{j.error&&<Notice tone="error">{j.error}</Notice>}</div>)}
      </div></Card>}
    </>}
    <Confirm open={confirm} title={`Delete on ${name}?`} confirmLabel="Delete permanently" danger requireText="DELETE" busy={busy} onCancel={()=>setConfirm(false)} onConfirm={()=>act(async()=>{await api.post(`${base}/jobs`,{ids:[...selected],confirm:true});setConfirm(false);setSelected(new Set());await jobs.reload(true);})}>
      <p>{nf(selected.size)} items selected on account {account.data?.user?.name}. Some may be hidden by the current filters.</p><Notice tone="warn">Deletion is permanent. A local archive of text and metadata will be created before each deletion.</Notice>
    </Confirm>
  </>;
}
