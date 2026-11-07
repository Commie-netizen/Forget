import React, { useRef, useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Field, Notice } from '../components/Card.jsx';
import { Confirm } from '../components/Modal.jsx';
import Progress from '../components/Progress.jsx';
import { nf, fmtDate } from '../lib.js';

const NAMES = {twitter:'Twitter/X',reddit:'Reddit',facebook:'Facebook',instagram:'Instagram'};
const DEFAULT_REDIRECT = 'http://127.0.0.1:53682/forget/callback';
const DEV_PORTAL = {twitter:'developer.x.com (application de type « Native App », client public)',reddit:'reddit.com/prefs/apps (type « installed app »)'};
const readPref = (k, d='') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const writePref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* préférence locale facultative */ } };
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
  // Maj+clic : applique l'état du clic à toute la plage depuis le dernier élément cliqué (dans la liste filtrée).
  function toggle(idx,shift){const m=visible[idx];setSelected(s=>{const n=new Set(s),on=!n.has(m.id);const a=shift&&lastIdx.current>=0?Math.min(lastIdx.current,idx):idx,b=shift&&lastIdx.current>=0?Math.max(lastIdx.current,idx):idx;for(const x of visible.slice(a,b+1)){if(on){if(n.size<500)n.add(x.id);}else n.delete(x.id);}return n;});lastIdx.current=idx;}
  async function act(fn){setBusy(true);setError('');setInfo('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function load(more=false){await act(async()=>{const r=await api.get(`${base}/posts`+api.qs({after:more?next:null}));setItems(old=>more?[...new Map([...old,...r.items].map(x=>[x.id,x])).values()]:r.items);setNext(r.next);setLoaded(true);if(!more)setSelected(new Set());});}
  async function connected_(){setItems([]);setSelected(new Set());setLoaded(false);await account.reload();await reloadSocial();}
  async function connect(e){e.preventDefault();await act(async()=>{await api.post(`${base}/connect`,{token});setToken('');await connected_();});}
  async function oauth(e){e.preventDefault();await act(async()=>{writePref(`forget.oauth.${provider}.clientId`,clientId.trim());writePref(`forget.oauth.${provider}.redirect`,redirectUri.trim());await api.post(`${base}/oauth`,{clientId:clientId.trim(),redirectUri:redirectUri.trim()});await connected_();});}
  return <>
    <PageHeader title={name} subtitle={assisted?'Compte personnel · nettoyage assisté dans l’interface officielle.':'Vos publications · sélection, archive locale et suppression via API.'}/>
    {(error||account.error) && <Notice tone="error">{error||account.error}</Notice>}
    {info&&<Notice tone="info">{info}</Notice>}
    {assisted ? <>
      <Card title={`Nettoyer mon compte ${name}`} subtitle="Une fenêtre dédiée conserve votre session localement et vous laisse contrôler la sélection.">
        <div className="stack">
          <Notice>Ce parcours est assisté : vous sélectionnez et confirmez les suppressions dans {name}. Forget n’automatise pas ces clics et ne lit pas votre mot de passe.</Notice>
          <ol className="summary">
            <li>Ouvrez la fenêtre et connectez-vous directement sur {name}.</li>
            <li>{provider==='facebook'?'Dans votre profil, ouvrez Historique personnel / Gérer les publications.':'Ouvrez Plus → Votre activité → Photos et vidéos → Publications.'}</li>
            <li>Filtrez la période, sélectionnez les éléments et utilisez les commandes proposées par la plateforme.</li>
            <li>Vérifiez puis confirmez dans la fenêtre officielle. Les options disponibles peuvent varier selon le compte.</li>
          </ol>
          <p className="muted small">Ce parcours ne crée pas d’archive Forget et ne remonte pas de compteur de suppression. Exportez vos données depuis la plateforme si vous souhaitez en conserver une copie.</p>
          <div><button className="btn primary" disabled={busy} onClick={()=>act(async()=>{await api.post(`${base}/window`);setInfo('Fenêtre ouverte. La connexion et les suppressions se font directement sur la plateforme.');})}>{busy?'Ouverture…':`Ouvrir ${name}`}</button></div>
        </div>
      </Card>
    </> : <>
      <Card title={connected?`Connecté : ${account.data.user.name}`:'Connecter mon compte'} subtitle="Authentification OAuth utilisateur via votre accès API à la plateforme.">
        {connected?<div className="row wrap"><span className="grow muted small">{account.data.persistence==='encrypted'?'Jeton chiffré localement.':'Jeton conservé en mémoire pour cette session uniquement.'}{account.data.oauth?.renewable?' Renouvellement automatique actif.':''}</span><button className="btn" disabled={busy||active} onClick={()=>act(async()=>{await api.del(`${base}/connect`);setItems([]);setSelected(new Set());setLoaded(false);await account.reload();await reloadSocial();})}>Déconnecter</button></div>:<div className="stack"><form className="stack" onSubmit={oauth}>
          <p className="muted">Connexion OAuth officielle : la page de {name} s’ouvre, vous vous connectez et autorisez l’accès. Forget ne voit jamais votre mot de passe.</p>
          <p className="muted small">Créez d’abord votre propre application sur {DEV_PORTAL[provider]}, déclarez-y exactement l’URL de redirection ci-dessous, puis copiez son Client ID. Aucun identifiant n’est fourni ni intégré à Forget.</p>
          <div className="grid-fields"><Field label="Client ID de votre application"><input value={clientId} onChange={e=>setClientId(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Client ID…"/></Field>
          <Field label="URL de redirection déclarée" hint="Interceptée par Forget, rien n’écoute sur ce port."><input value={redirectUri} onChange={e=>setRedirectUri(e.target.value)} spellCheck={false}/></Field></div>
          <p className="muted small">Autorisations demandées : {account.data?.oauth?.scopes||account.data?.scopes||'chargement…'}</p>
          <div><button className="btn primary" disabled={busy||!clientId.trim()||!redirectUri.trim()}>{busy?'Connexion…':`Se connecter avec ${name}`}</button> <button type="button" className="btn link" onClick={()=>setManual(v=>!v)}>{manual?'Masquer la saisie manuelle':'J’ai déjà un jeton d’accès'}</button></div>
        </form>{manual&&<form className="stack" onSubmit={connect}>
          <p className="muted">Utilisez un jeton OAuth de votre propre compte, délivré par une application autorisée. Les cookies de connexion et les jetons d’application seuls ne conviennent pas.</p>
          <Field label="Jeton OAuth utilisateur" hint={`Permissions nécessaires : ${account.data?.scopes||'chargement…'}`}><input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder="Jeton d’accès…"/></Field>
          <p className="muted small">{provider==='twitter'?'L’accès aux endpoints X dépend de votre offre API et des crédits disponibles.':'L’accès à l’API Reddit doit être autorisé pour votre application.'} Le jeton peut expirer ; reconnectez le compte si nécessaire.</p>
          <div><button className="btn primary" disabled={busy||!token.trim()}>{busy?'Vérification…':'Vérifier et connecter'}</button></div>
        </form>}</div>}
      </Card>
      {connected&&<Card title="Mes publications" subtitle={provider==='reddit'?'Publications et commentaires du compte connecté.':'Publications du compte connecté accessibles via la timeline API.'}>
        <div className="stack">
          <div className="row wrap"><button className="btn primary" disabled={busy||active} onClick={()=>load(false)}>{loaded?'Actualiser':'Charger mes publications'}</button><span className="muted small">{nf(items.length)} chargées · {nf(selected.size)} sélectionnées</span></div>
          <div className="grid-fields"><Field label="Contient"><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Mot ou expression…"/></Field><Field label="Exclure (mots séparés par des virgules)"><input value={exclude} onChange={e=>setExclude(e.target.value)} placeholder="à garder, important…"/></Field><Field label="Depuis le (UTC)"><input type="date" value={since} max={until||undefined} onChange={e=>setSince(e.target.value)}/></Field><Field label="Jusqu’au (UTC)"><input type="date" value={until} min={since||undefined} onChange={e=>setUntil(e.target.value)}/></Field></div>
          <div className="row wrap"><button className="btn sm" disabled={active||!visible.length} onClick={()=>setSelected(new Set(visible.slice(0,500).map(m=>m.id)))}>Sélectionner les résultats (max. 500)</button><button className="btn sm" disabled={active||!visible.length} onClick={()=>setSelected(s=>{const n=new Set(s);for(const m of visible){if(n.has(m.id))n.delete(m.id);else if(n.size<500)n.add(m.id);}return n;})}>Inverser</button><button className="btn sm" disabled={active||!selected.size} onClick={()=>setSelected(new Set())}>Tout désélectionner</button><span className="muted small">Maj+clic : sélection d’une plage.</span></div>
          <div className="conversation-table">{visible.map((m,idx)=><label className="conversation-row" key={m.id} onClick={e=>{if(e.target.tagName!=='INPUT'){e.preventDefault();if(!active)toggle(idx,e.shiftKey);}}}><input type="checkbox" checked={selected.has(m.id)} disabled={active||(!selected.has(m.id)&&selected.size>=500)} onClick={e=>{e.preventDefault();toggle(idx,e.shiftKey);}} onChange={()=>{}}/><span className="grow"><span className="muted small">{m.kind} · {m.date?fmtDate(m.date):'Date inconnue'}</span><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{m.text||'(sans texte)'}</p></span></label>)}{loaded&&!visible.length&&<p style={{padding:16}} className="muted">Aucune publication pour ces filtres dans les pages chargées.</p>}</div>
          {next&&<button className="btn" disabled={busy||active} onClick={()=>load(true)}>Charger la page suivante</button>}
          <div className="execution-bar"><p className="muted small">Texte et métadonnées archivés avant suppression. Les médias ne sont pas téléchargés.</p><button className="btn danger-solid" disabled={busy||active||!selected.size} onClick={()=>setConfirm(true)}>Supprimer {nf(selected.size)} éléments…</button></div>
        </div>
      </Card>}
      {(jobs.data||[]).length>0&&<Card title="Suivi des opérations"><div className="stack">
        {account.data?.waitMs>1000&&<Notice>Attente de la prochaine requête : environ {Math.ceil(account.data.waitMs/1000)} s. Les limites de la plateforme sont respectées.</Notice>}
        {jobs.error&&<Notice tone="error">{jobs.error}</Notice>}
        {(jobs.data||[]).map(j=><div className="job" key={j.id}><div className="row wrap"><strong>{{queued:'En file',running:'En cours',paused:'En pause',cancelled:'Annulé',failed:'Arrêté sur erreur',done:'Terminé',interrupted:'Interrompu'}[j.status]||j.status}</strong><span className="grow">{j.deleted}/{j.total} supprimés · {j.failed} échec(s)</span>{['running','queued','paused'].includes(j.status)&&<><button className="btn sm" disabled={busy} onClick={()=>act(async()=>{await api.post(`${base}/jobs/${j.id}/${j.status==='paused'?'resume':'pause'}`);await jobs.reload(true);})}>{j.status==='paused'?'Reprendre':'Pause'}</button><button className="btn sm danger" disabled={busy} onClick={()=>act(async()=>{await api.post(`${base}/jobs/${j.id}/cancel`);await jobs.reload(true);})}>Arrêter</button></>}</div><Progress value={j.deleted} max={j.total} label="Progression de la suppression"/>{j.error&&<Notice tone="error">{j.error}</Notice>}</div>)}
      </div></Card>}
    </>}
    <Confirm open={confirm} title={`Supprimer sur ${name} ?`} confirmLabel="Supprimer définitivement" danger requireText="SUPPRIMER" busy={busy} onCancel={()=>setConfirm(false)} onConfirm={()=>act(async()=>{await api.post(`${base}/jobs`,{ids:[...selected],confirm:true});setConfirm(false);setSelected(new Set());await jobs.reload(true);})}>
      <p>{nf(selected.size)} éléments sélectionnés sur le compte {account.data?.user?.name}. Certains peuvent être masqués par les filtres actuels.</p><Notice tone="warn">La suppression est définitive. Une archive locale du texte et des métadonnées sera créée avant chaque suppression.</Notice>
    </Confirm>
  </>;
}
