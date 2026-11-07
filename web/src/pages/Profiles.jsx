import React, { useState } from 'react';
import * as api from '../api.js';
import { useApp } from '../hooks.js';
import { Card, PageHeader, Notice, Field } from '../components/Card.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Badge from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';
import { toList } from '../lib.js';

const EMPTY = { primaryName: '', primaryAddress: '', dateOfBirth: '', emails: '', phones: '' };
const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function Profiles() {
  const { profiles, reloadProfiles, activeId, setActiveId } = useApp();
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function edit(p) {
    setEditId(p.id);
    setForm({
      primaryName: p.primaryName || '',
      primaryAddress: p.primaryAddress || '',
      dateOfBirth: p.dateOfBirth || '',
      emails: toList(p.emails).join(', '),
      phones: toList(p.phones).join(', '),
    });
  }
  function reset() {
    setEditId(null);
    setForm(EMPTY);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      primaryName: form.primaryName.trim(),
      primaryAddress: form.primaryAddress.trim(),
      dateOfBirth: form.dateOfBirth,
      emails: split(form.emails),
      phones: split(form.phones),
    };
    try {
      if (editId) await api.updateProfile(editId, body);
      else {
        const p = await api.createProfile(body);
        if (!activeId && p?.id) setActiveId(p.id);
      }
      reset();
      await reloadProfiles(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const p = toDelete;
    try {
      await api.deleteProfile(p.id);
      if (editId === p.id) reset();
      setToDelete(null);
      await reloadProfiles(true);
    } catch (err) {
      setToDelete(null);
      setError(err.message);
    }
  }

  return (
    <>
      <PageHeader title="Profils" subtitle="Les informations recherchées chez les data brokers." />
      <Notice tone="error">{error}</Notice>
      <div className="cols">
        <Card title={`Profils (${profiles.length})`}>
          {profiles.length === 0 ? (
            <EmptyState icon="users" title="Aucun profil">Créez-en un pour lancer des analyses.</EmptyState>
          ) : (
            <ul className="list">
              {profiles.map((p) => (
                <li key={p.id} className="row wrap">
                  <div className="grow">
                    <strong>{p.primaryName}</strong> {p.id === activeId && <Badge tone="green">Actif</Badge>}
                    <div className="muted small">
                      {[p.primaryAddress, p.dateOfBirth, toList(p.emails).join(', '), toList(p.phones).join(', ')].filter(Boolean).join(' · ') || 'Aucun détail'}
                    </div>
                  </div>
                  <div className="actions">
                    {p.id !== activeId && <button type="button" className="btn sm" onClick={() => setActiveId(p.id)}>Activer</button>}
                    <button type="button" className="btn sm" onClick={() => edit(p)}>Modifier</button>
                    <button type="button" className="btn sm danger" onClick={() => setToDelete(p)}>Supprimer</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={editId ? 'Modifier le profil' : 'Nouveau profil'}>
          <form onSubmit={submit} className="stack">
            <Field label="Nom complet"><input value={form.primaryName} onChange={set('primaryName')} required /></Field>
            <Field label="Adresse"><input value={form.primaryAddress} onChange={set('primaryAddress')} /></Field>
            <Field label="Date de naissance"><input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
            <Field label="E-mails (séparés par des virgules)"><input value={form.emails} onChange={set('emails')} placeholder="a@exemple.fr, b@exemple.fr" /></Field>
            <Field label="Téléphones (séparés par des virgules)"><input value={form.phones} onChange={set('phones')} placeholder="+33 6 00 00 00 00" /></Field>
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy}>{editId ? 'Enregistrer' : 'Créer'}</button>
              {editId && <button type="button" className="btn" onClick={reset}>Annuler</button>}
            </div>
          </form>
        </Card>
      </div>
      <Modal
        open={!!toDelete}
        title="Supprimer ce profil ?"
        onClose={() => setToDelete(null)}
        footer={
          <>
            <button type="button" className="btn" data-autofocus onClick={() => setToDelete(null)}>Annuler</button>
            <button type="button" className="btn danger-solid" onClick={remove}>Supprimer</button>
          </>
        }
      >
        <p>Le profil « {toDelete?.primaryName} » sera supprimé.</p>
      </Modal>
    </>
  );
}
