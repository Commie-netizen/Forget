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
      <PageHeader title="Profiles" subtitle="The information to search for at data brokers." />
      <Notice tone="error">{error}</Notice>
      <div className="cols">
        <Card title={`Profiles (${profiles.length})`}>
          {profiles.length === 0 ? (
            <EmptyState icon="users" title="No profiles">Create one to start scanning.</EmptyState>
          ) : (
            <ul className="list">
              {profiles.map((p) => (
                <li key={p.id} className="row wrap">
                  <div className="grow">
                    <strong>{p.primaryName}</strong> {p.id === activeId && <Badge tone="green">Active</Badge>}
                    <div className="muted small">
                      {[p.primaryAddress, p.dateOfBirth, toList(p.emails).join(', '), toList(p.phones).join(', ')].filter(Boolean).join(' · ') || "No details"}
                    </div>
                  </div>
                  <div className="actions">
                    {p.id !== activeId && <button type="button" className="btn sm" onClick={() => setActiveId(p.id)}>Activate</button>}
                    <button type="button" className="btn sm" onClick={() => edit(p)}>Edit</button>
                    <button type="button" className="btn sm danger" onClick={() => setToDelete(p)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={editId ? "Edit profile" : "New profile"}>
          <form onSubmit={submit} className="stack">
            <Field label="Full name"><input value={form.primaryName} onChange={set('primaryName')} required /></Field>
            <Field label="Address"><input value={form.primaryAddress} onChange={set('primaryAddress')} /></Field>
            <Field label="Date of birth"><input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
            <Field label="Emails (comma-separated)"><input value={form.emails} onChange={set('emails')} placeholder="a@example.com, b@example.com" /></Field>
            <Field label="Phone numbers (comma-separated)"><input value={form.phones} onChange={set('phones')} placeholder="+1 202 555 0123" /></Field>
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy}>{editId ? "Save" : "Create"}</button>
              {editId && <button type="button" className="btn" onClick={reset}>Cancel</button>}
            </div>
          </form>
        </Card>
      </div>
      <Modal
        open={!!toDelete}
        title="Delete this profile?"
        onClose={() => setToDelete(null)}
        footer={
          <>
            <button type="button" className="btn" data-autofocus onClick={() => setToDelete(null)}>Cancel</button>
            <button type="button" className="btn danger-solid" onClick={remove}>Delete</button>
          </>
        }
      >
        <p>The profile "{toDelete?.primaryName}" will be deleted.</p>
      </Modal>
    </>
  );
}
