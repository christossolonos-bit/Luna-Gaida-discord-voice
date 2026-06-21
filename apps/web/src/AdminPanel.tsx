import { useEffect, useState, type ReactNode } from 'react';
import { CreditCard, KeyRound, Shield } from 'lucide-react';
import { api, json } from './api';

type Provider = 'groq' | 'gemini_paid' | 'gemini_private' | 'nvidia';

interface ProviderKey {
  id: string;
  provider: Provider;
  label: string;
  fingerprint: string;
  enabled: boolean;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
}

interface AdminGuild {
  id: string;
  name: string;
  icon: string | null;
  privateAssigned: boolean;
  basePlanSlug: string | null;
}

interface AdminPlan {
  id?: string;
  name: string;
  slug: string;
  kind: 'free' | 'paid' | 'private';
  description?: string;
  published: boolean;
  archived?: boolean;
  sortOrder?: number;
  priceAmount?: number | null;
  priceCurrency?: string;
  features: Record<string, unknown>;
}

const emptyKey = { provider: 'groq' as Provider, label: '', value: '' };

export function AdminPanel() {
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [guilds, setGuilds] = useState<AdminGuild[]>([]);
  const [editingPlan, setEditingPlan] = useState<AdminPlan | null>(null);
  const [featureJson, setFeatureJson] = useState('{}');
  const [newKey, setNewKey] = useState(emptyKey);
  const [editingKey, setEditingKey] = useState<(ProviderKey & { value: string }) | null>(null);
  const [privateGuildId, setPrivateGuildId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = async () => {
    const [planResult, keyResult, guildResult] = await Promise.all([
      api<{ plans: AdminPlan[] }>('/api/admin/plans'),
      api<{ keys: ProviderKey[] }>('/api/admin/provider-keys'),
      api<{ guilds: AdminGuild[] }>('/api/admin/guilds')
    ]);
    setPlans(planResult.plans);
    setKeys(keyResult.keys);
    setGuilds(guildResult.guilds);
  };

  useEffect(() => { void reload().catch(showError); }, []);

  const showError = (cause: unknown) => {
    setMessage('');
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  const showSuccess = (value: string) => {
    setError('');
    setMessage(value);
  };

  const editPlan = (plan?: AdminPlan) => {
    const value = plan ?? {
      name: '', slug: '', kind: 'paid' as const, published: false,
      priceAmount: 999, priceCurrency: 'eur', features: {}
    };
    setEditingPlan(value);
    setFeatureJson(JSON.stringify(value.features, null, 2));
  };

  const savePlan = async () => {
    if (!editingPlan) return;
    await api('/api/admin/plans', {
      method: 'PUT',
      body: json({ ...editingPlan, features: JSON.parse(featureJson) })
    });
    setEditingPlan(null);
    await reload();
    showSuccess('Plan saved.');
  };

  const addKey = async () => {
    await api('/api/admin/provider-keys', { method: 'POST', body: json(newKey) });
    setNewKey(emptyKey);
    await reload();
    showSuccess('Provider key added.');
  };

  const saveKey = async () => {
    if (!editingKey) return;
    await api(`/api/admin/provider-keys/${editingKey.id}`, {
      method: 'PATCH',
      body: json({
        provider: editingKey.provider,
        label: editingKey.label,
        enabled: editingKey.enabled,
        ...(editingKey.value.trim() ? { value: editingKey.value.trim() } : {})
      })
    });
    setEditingKey(null);
    await reload();
    showSuccess('Provider key entry updated.');
  };

  const removeKey = async (id: string) => {
    await api(`/api/admin/provider-keys/${id}`, { method: 'DELETE' });
    if (editingKey?.id === id) setEditingKey(null);
    await reload();
    showSuccess('Provider key removed.');
  };

  const setPrivate = async (guild: AdminGuild, assigned: boolean) => {
    await api(`/api/admin/private-guilds/${guild.id}`, {
      method: 'PUT',
      body: json({ assigned })
    });
    await reload();
    showSuccess(`${guild.name} ${assigned ? 'assigned to' : 'removed from'} Private.`);
  };

  const assignPrivateById = async () => {
    const guildId = privateGuildId.trim();
    if (!/^\d+$/.test(guildId)) throw new Error('Enter a valid Discord guild ID.');
    await api(`/api/admin/private-guilds/${guildId}`, {
      method: 'PUT',
      body: json({ assigned: true })
    });
    setPrivateGuildId('');
    await reload();
    showSuccess(`Guild ${guildId} assigned to Private.`);
  };

  return <>
    {error && <div className="notice error">{error}</div>}
    {message && <div className="notice saved">{message}</div>}

    <AdminSection title="Plans" description="Entitlement changes apply immediately; allowances change next cycle." icon={<Shield />}>
      <button onClick={() => editPlan()}>Create paid plan</button>
      {plans.map((plan) => <button className="row plan-row" key={plan.id} onClick={() => editPlan(plan)}>
        <div><strong>{plan.name}</strong><small>{plan.slug} · {plan.kind}</small></div>
        <span>{plan.published ? 'Published' : 'Hidden'}</span>
      </button>)}
    </AdminSection>

    {editingPlan && <AdminSection title={editingPlan.id ? `Edit ${editingPlan.name}` : 'New plan'} description="Changing the price creates a new Stripe Price." icon={<CreditCard />}>
      <div className="grid">
        <AdminField label="Name"><input value={editingPlan.name} onChange={(event) => setEditingPlan({ ...editingPlan, name: event.target.value })} /></AdminField>
        <AdminField label="Slug"><input value={editingPlan.slug} onChange={(event) => setEditingPlan({ ...editingPlan, slug: event.target.value })} /></AdminField>
        <AdminField label="Monthly price"><input type="number" value={editingPlan.priceAmount ?? ''} onChange={(event) => setEditingPlan({ ...editingPlan, priceAmount: Number(event.target.value) })} /></AdminField>
        <AdminField label="Currency"><input value={editingPlan.priceCurrency ?? 'eur'} onChange={(event) => setEditingPlan({ ...editingPlan, priceCurrency: event.target.value })} /></AdminField>
      </div>
      <label className="toggle-row"><div><strong>Published</strong><small>Visible during checkout.</small></div><input type="checkbox" checked={editingPlan.published} onChange={(event) => setEditingPlan({ ...editingPlan, published: event.target.checked })} /><i /></label>
      <AdminField label="Feature configuration (JSON)"><textarea className="large" value={featureJson} onChange={(event) => setFeatureJson(event.target.value)} /></AdminField>
      <button onClick={() => void savePlan().catch(showError)}>Save plan</button>
      <button className="danger" onClick={() => setEditingPlan(null)}>Cancel</button>
    </AdminSection>}

    <AdminSection title="Shared provider keys" description="Edit metadata or replace a key without exposing its current plaintext value." icon={<KeyRound />}>
      {keys.map((key) => <div className="row" key={key.id}>
        <div>
          <strong>{key.label}</strong>
          <small>{providerLabel(key.provider)} · {key.fingerprint} · {key.enabled ? 'enabled' : 'disabled'}</small>
        </div>
        <div className="row-actions">
          <button onClick={() => setEditingKey({ ...key, value: '' })}>Edit</button>
          <button className="danger" onClick={() => void removeKey(key.id).catch(showError)}>Remove</button>
        </div>
      </div>)}

      {editingKey && <div className="credential key-editor">
        <select value={editingKey.provider} onChange={(event) => setEditingKey({ ...editingKey, provider: event.target.value as Provider })}>{providerOptions()}</select>
        <input value={editingKey.label} placeholder="Label" onChange={(event) => setEditingKey({ ...editingKey, label: event.target.value })} />
        <input type="password" value={editingKey.value} placeholder="New key (leave blank to keep current)" onChange={(event) => setEditingKey({ ...editingKey, value: event.target.value })} />
        <label className="key-enabled"><input type="checkbox" checked={editingKey.enabled} onChange={(event) => setEditingKey({ ...editingKey, enabled: event.target.checked })} /> Enabled</label>
        <button onClick={() => void saveKey().catch(showError)}>Save</button>
        <button className="danger" onClick={() => setEditingKey(null)}>Cancel</button>
      </div>}

      <div className="credential key-editor">
        <select value={newKey.provider} onChange={(event) => setNewKey({ ...newKey, provider: event.target.value as Provider })}>{providerOptions()}</select>
        <input placeholder="Label" value={newKey.label} onChange={(event) => setNewKey({ ...newKey, label: event.target.value })} />
        <input type="password" placeholder="API key" value={newKey.value} onChange={(event) => setNewKey({ ...newKey, value: event.target.value })} />
        <button onClick={() => void addKey().catch(showError)}>Add key</button>
      </div>
    </AdminSection>

    <AdminSection title="Private guild access" description="Private overrides billing plans and persists across Stripe subscription updates." icon={<Shield />}>
      <div className="credential private-assign-form">
        <input placeholder="Discord guild ID" value={privateGuildId} onChange={(event) => setPrivateGuildId(event.target.value)} />
        <button onClick={() => void assignPrivateById().catch(showError)}>Assign Private</button>
      </div>
      {!guilds.length && <p className="hint">No guilds are currently assigned to Private.</p>}
      {guilds.map((guild) => <div className="row" key={guild.id}>
        <div><strong>{guild.name}</strong><small>{guild.id} · base plan: {guild.basePlanSlug ?? 'free'}</small></div>
        <div className="row-actions">
          <span className="private-state active">Private</span>
          <button className="danger" onClick={() => void setPrivate(guild, false).catch(showError)}>Remove Private</button>
        </div>
      </div>)}
    </AdminSection>
  </>;
}

function AdminSection({ title, description, icon, children }: { title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return <section><div className="section-head"><span>{icon}</span><div><h2>{title}</h2><p>{description}</p></div></div><div className="section-body">{children}</div></section>;
}

function AdminField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function providerLabel(provider: Provider) {
  return ({ groq: 'Groq shared pool', gemini_paid: 'Gemini Live paid pool', gemini_private: 'Gemini Live private pool', nvidia: 'NVIDIA NIM shared' })[provider];
}

function providerOptions() {
  return <>
    <option value="groq">Groq shared pool</option>
    <option value="gemini_paid">Gemini Live paid pool</option>
    <option value="gemini_private">Gemini Live private pool</option>
    <option value="nvidia">NVIDIA NIM shared</option>
  </>;
}
