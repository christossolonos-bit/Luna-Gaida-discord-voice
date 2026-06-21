import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, ChevronRight, CreditCard, KeyRound, LogOut, MessageSquare, Mic, Send, Settings, Shield, Sparkles, Volume2 } from 'lucide-react';
import { api, json, loadMe, type Guild, type Me } from './api';
import './styles.css';
import './chat.css';
import './admin.css';
import './voice-changer.css';
import { AdminPanel } from './AdminPanel';

interface RuntimePayload {
  runtime: {
    planSlug: string;
    planKind: string;
    features: Record<string, boolean | number>;
    settings: GuildSettings;
    personality: Personality;
  };
  credentials: Array<{ provider: string; fingerprint: string }>;
  usage: { unlimited: boolean; messagesUsed: number; messageLimit: number; creditsUsed: number; creditLimit: number };
  subscription: { status: string; currentPeriodEnd: string } | null;
}

interface GuildSettings {
  listeningChannelIds: string[];
  voiceWatchChannelIds: string[];
  nickname: string | null;
  avatarUrl: string | null;
  nsfwEnabled: boolean;
  textProvider: 'auto' | 'groq' | 'gemini';
  voiceProvider: 'auto' | 'gemini';
  browserTextEnabled: boolean;
  browserVoiceEnabled: boolean;
  voiceChanger: { enabled: boolean; name: string; ffmpegFilter: string };
  musicVolume: number;
  musicDuckVolume: number;
}

interface Personality {
  name: string;
  tone: string;
  traits: string[];
  likes: string[];
  dislikes: string[];
  boundaries: string[];
  speakingStyle: string;
  relationshipRules: string;
  customInstructions: string;
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [payload, setPayload] = useState<RuntimePayload | null>(null);
  const [tab, setTab] = useState<'chat' | 'settings' | 'personality' | 'providers' | 'billing' | 'admin'>('settings');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadMe().then(async (identity) => {
      setMe(identity);
      const result = await api<{ guilds: Guild[] }>('/api/guilds');
      setGuilds(result.guilds);
      setSelected(result.guilds[0]?.id ?? null);
    }).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setPayload(null);
    void api<RuntimePayload>(`/api/guilds/${selected}/settings`).then(setPayload).catch((cause) => setError(cause.message));
  }, [selected]);

  const guild = useMemo(() => guilds.find((item) => item.id === selected), [guilds, selected]);

  if (!me) return <Login />;

  async function save(next: RuntimePayload) {
    if (!selected) return;
    setError('');
    try {
      const result = await api<{ runtime: RuntimePayload['runtime'] }>(`/api/guilds/${selected}/settings`, {
        method: 'PUT', body: json({ settings: next.runtime.settings, personality: next.runtime.personality })
      });
      setPayload({ ...next, runtime: result.runtime });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="shell">
    <aside>
      <div className="brand"><span><Sparkles size={19} /></span><div>Giada<small>Control center</small></div></div>
      <label className="guild-label">Discord server</label>
      <select value={selected ?? ''} onChange={(event) => setSelected(event.target.value)}>
        {guilds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <nav>
        <Nav active={tab === 'chat'} icon={<MessageSquare />} onClick={() => setTab('chat')}>Browser chat</Nav>
        <Nav active={tab === 'settings'} icon={<Settings />} onClick={() => setTab('settings')}>General</Nav>
        <Nav active={tab === 'personality'} icon={<Bot />} onClick={() => setTab('personality')}>Personality</Nav>
        <Nav active={tab === 'providers'} icon={<KeyRound />} onClick={() => setTab('providers')}>Providers</Nav>
        <Nav active={tab === 'billing'} icon={<CreditCard />} onClick={() => setTab('billing')}>Plan & usage</Nav>
        {me.owner && <Nav active={tab === 'admin'} icon={<Shield />} onClick={() => setTab('admin')}>Administration</Nav>}
      </nav>
      <div className="account"><div className="avatar">{me.user.username.slice(0, 1).toUpperCase()}</div><div>{me.user.username}<small>{me.owner ? 'Platform owner' : 'Server admin'}</small></div><button title="Log out" onClick={() => void api('/api/logout', { method: 'POST' }).then(() => location.reload())}><LogOut /></button></div>
    </aside>
    <main>
      <header><div><p>{guild?.name ?? 'Server'}</p><h1>{titleFor(tab)}</h1></div>{payload && <span className={`plan ${payload.runtime.planKind}`}>{payload.runtime.planSlug}</span>}</header>
      {error && <div className="notice error">{error}</div>}
      {saved && <div className="notice saved">Settings saved</div>}
      {!payload ? <div className="loading">Loading server configuration…</div> : <>
        {tab === 'chat' && <BrowserChat guildId={selected!} voiceEnabled={payload.runtime.features.geminiVoice === true && payload.runtime.settings.browserVoiceEnabled} />}
        {tab === 'settings' && <General guildId={selected!} payload={payload} onSave={save} />}
        {tab === 'personality' && <PersonalityEditor payload={payload} onSave={save} />}
        {tab === 'providers' && <Providers guildId={selected!} payload={payload} reload={() => selected && api<RuntimePayload>(`/api/guilds/${selected}/settings`).then(setPayload)} />}
        {tab === 'billing' && <Billing guildId={selected!} payload={payload} />}
        {tab === 'admin' && me.owner && <AdminPanel />}
      </>}
    </main>
  </div>;
}

function Login() {
  return <div className="login"><div className="login-card"><div className="logo-large"><Sparkles /></div><p>GIADA CONTROL CENTER</p><h1>Every server,<br />its own character.</h1><span>Configure personality, voice, providers, and usage from one secure dashboard.</span><a href="/api/auth/discord">Continue with Discord <ChevronRight /></a><small>Only server owners and administrators can change settings.</small></div></div>;
}

function General({ guildId, payload, onSave }: { guildId: string; payload: RuntimePayload; onSave: (value: RuntimePayload) => void }) {
  const [state, setState] = useState(payload);
  useEffect(() => setState(payload), [payload]);
  const settings = state.runtime.settings;
  const set = (patch: Partial<GuildSettings>) => setState({ ...state, runtime: { ...state.runtime, settings: { ...settings, ...patch } } });
  return <form onSubmit={(event) => { event.preventDefault(); void onSave(state); }}>
    <Section title="Bot identity" description="Discord applies these values only in this server." icon={<Bot />}>
      <div className="grid"><Field label="Server nickname"><input disabled={!state.runtime.features.customIdentity} value={settings.nickname ?? ''} maxLength={32} onChange={(e) => set({ nickname: e.target.value || null })} /></Field><Field label="Avatar image"><input disabled={!state.runtime.features.customIdentity} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const form = new FormData(); form.append('file', file); void api<{ runtime: RuntimePayload['runtime'] }>(`/api/guilds/${guildId}/avatar`, { method: 'POST', body: form }).then(({ runtime }) => setState({ ...state, runtime })); }} /></Field></div>
    </Section>
    <Section title="Response settings" description="Choose enabled modalities and server behavior." icon={<MessageSquare />}>
      <div className="grid"><Field label="Text provider"><select value={settings.textProvider} onChange={(e) => set({ textProvider: e.target.value as GuildSettings['textProvider'] })}><option value="auto">Automatic</option><option value="groq">Groq</option><option value="gemini">Gemini Live</option></select></Field><Field label="Voice provider"><select value={settings.voiceProvider} onChange={(e) => set({ voiceProvider: e.target.value as GuildSettings['voiceProvider'] })}><option value="auto">Automatic</option><option value="gemini">Gemini Live</option></select></Field></div>
      <Toggle label="NSFW responses" detail="Still restricted to Discord age-restricted channels." value={settings.nsfwEnabled} disabled={!state.runtime.features.nsfw} onChange={(value) => set({ nsfwEnabled: value })} />
      <Toggle label="Browser text chat" detail="Uses this server's personality and allowance." value={settings.browserTextEnabled} disabled={!state.runtime.features.browserChat} onChange={(value) => set({ browserTextEnabled: value })} />
      <div className="grid"><Field label="Always-listen channel IDs"><input value={settings.listeningChannelIds.join(', ')} onChange={(e) => set({ listeningChannelIds: splitList(e.target.value) })} /></Field><Field label="Voice-watch channel IDs"><input value={settings.voiceWatchChannelIds.join(', ')} onChange={(e) => set({ voiceWatchChannelIds: splitList(e.target.value) })} /></Field></div>
    </Section>
    <Section title="Voice changer" description="FFmpeg filter applied to generated speech, not music." icon={<Volume2 />}>
      <Toggle label="Enable voice changer" detail={state.runtime.features.voiceChanger ? 'Applied to Discord and browser voice.' : 'Not available on this plan.'} value={settings.voiceChanger.enabled} disabled={!state.runtime.features.voiceChanger} onChange={(enabled) => set({ voiceChanger: { ...settings.voiceChanger, enabled } })} />
      <VoiceChangerEditor value={settings.voiceChanger} disabled={!state.runtime.features.voiceChanger} onChange={(voiceChanger) => set({ voiceChanger })} />
    </Section>
    <button className="primary">Save changes</button>
  </form>;
}

interface VoiceProfileValues {
  highpass: number; lowpass: number; trebleGain: number; trebleFrequency: number;
  compressorThreshold: number; compressorRatio: number; compressorAttack: number;
  compressorRelease: number; pitchSemitones: number; volume: number;
}

const defaultVoiceValues: VoiceProfileValues = {
  highpass: 100, lowpass: 13_500, trebleGain: 2.5, trebleFrequency: 4_000,
  compressorThreshold: -18, compressorRatio: 2.4, compressorAttack: 5,
  compressorRelease: 65, pitchSemitones: 2, volume: 0.95
};

const voicePresets = [
  { name: 'bypass', label: 'Bypass', enabled: false, values: { ...defaultVoiceValues, pitchSemitones: 0, trebleGain: 0, volume: 1 } },
  { name: 'anime-girl', label: 'Anime girl', enabled: true, values: defaultVoiceValues }
];

function VoiceChangerEditor({ value, disabled, onChange }: { value: GuildSettings['voiceChanger']; disabled: boolean; onChange: (value: GuildSettings['voiceChanger']) => void }) {
  const values = parseVoiceFilter(value.ffmpegFilter);
  const profile = voicePresets.some((preset) => preset.name === value.name) ? value.name : 'custom';
  const update = (patch: Partial<VoiceProfileValues>) => {
    const name = profile === 'custom' ? value.name : `${value.name}-custom`;
    onChange({ ...value, name, ffmpegFilter: buildVoiceFilter({ ...values, ...patch }) });
  };
  const numeric = (label: string, key: keyof VoiceProfileValues, min: number, max: number, step: number) => <Field label={label}><input disabled={disabled} type="number" min={min} max={max} step={step} value={values[key]} onChange={(event) => update({ [key]: Number(event.target.value) })} /></Field>;
  return <div className="voice-editor">
    <div className="grid">
      <Field label="Current profile"><select disabled={disabled} value={profile} onChange={(event) => {
        const preset = voicePresets.find((item) => item.name === event.target.value);
        if (preset) onChange({ enabled: preset.enabled, name: preset.name, ffmpegFilter: preset.name === 'bypass' ? 'anull' : buildVoiceFilter(preset.values) });
      }}>{voicePresets.map((preset) => <option key={preset.name} value={preset.name}>{preset.label}</option>)}{profile === 'custom' && <option value="custom">Custom ({value.name})</option>}</select></Field>
      <Field label="Profile name"><input disabled={disabled} value={value.name} maxLength={80} onChange={(event) => onChange({ ...value, name: event.target.value })} /></Field>
    </div>
    <div className="voice-control-group"><strong>Pitch and level</strong><div className="grid">{numeric('Pitch (semitones)', 'pitchSemitones', -12, 12, 0.1)}{numeric('Output volume', 'volume', 0, 3, 0.01)}</div></div>
    <div className="voice-control-group"><strong>Frequency shaping</strong><div className="grid">{numeric('High-pass frequency (Hz)', 'highpass', 20, 2_000, 1)}{numeric('Low-pass frequency (Hz)', 'lowpass', 1_000, 20_000, 1)}{numeric('Treble gain (dB)', 'trebleGain', -20, 20, 0.1)}{numeric('Treble frequency (Hz)', 'trebleFrequency', 1_000, 12_000, 1)}</div></div>
    <div className="voice-control-group"><strong>Compressor</strong><div className="grid">{numeric('Threshold (dB)', 'compressorThreshold', -60, 0, 0.1)}{numeric('Ratio', 'compressorRatio', 1, 20, 0.1)}{numeric('Attack (ms)', 'compressorAttack', 0.01, 2_000, 0.1)}{numeric('Release (ms)', 'compressorRelease', 0.01, 9_000, 0.1)}</div></div>
  </div>;
}

function parseVoiceFilter(filter: string): VoiceProfileValues {
  if (filter.trim() === 'anull') return { ...defaultVoiceValues, pitchSemitones: 0, trebleGain: 0, volume: 1 };
  const read = (pattern: RegExp, fallback: number) => Number(filter.match(pattern)?.[1] ?? fallback);
  const sampleRate = read(/asetrate=([\d.]+)/, 24_000 * Math.pow(2, defaultVoiceValues.pitchSemitones / 12));
  return {
    highpass: read(/highpass=f=([\d.]+)/, defaultVoiceValues.highpass), lowpass: read(/lowpass=f=([\d.]+)/, defaultVoiceValues.lowpass),
    trebleGain: read(/treble=g=(-?[\d.]+):f=/, defaultVoiceValues.trebleGain), trebleFrequency: read(/treble=g=-?[\d.]+:f=([\d.]+)/, defaultVoiceValues.trebleFrequency),
    compressorThreshold: read(/acompressor=threshold=(-?[\d.]+)dB/, defaultVoiceValues.compressorThreshold), compressorRatio: read(/acompressor=[^,]*ratio=([\d.]+)/, defaultVoiceValues.compressorRatio),
    compressorAttack: read(/acompressor=[^,]*attack=([\d.]+)/, defaultVoiceValues.compressorAttack), compressorRelease: read(/acompressor=[^,]*release=([\d.]+)/, defaultVoiceValues.compressorRelease),
    pitchSemitones: Number((12 * Math.log2(sampleRate / 24_000)).toFixed(2)), volume: read(/(?:^|,)volume=([\d.]+)/, defaultVoiceValues.volume)
  };
}

function buildVoiceFilter(values: VoiceProfileValues) {
  const sampleRate = Math.round(24_000 * Math.pow(2, values.pitchSemitones / 12));
  const tempo = Number((24_000 / sampleRate).toFixed(6));
  return `highpass=f=${values.highpass},lowpass=f=${values.lowpass},treble=g=${values.trebleGain}:f=${values.trebleFrequency},acompressor=threshold=${values.compressorThreshold}dB:ratio=${values.compressorRatio}:attack=${values.compressorAttack}:release=${values.compressorRelease},asetrate=${sampleRate},aresample=24000,atempo=${tempo},volume=${values.volume}`;
}

function PersonalityEditor({ payload, onSave }: { payload: RuntimePayload; onSave: (value: RuntimePayload) => void }) {
  const [state, setState] = useState(payload);
  useEffect(() => setState(payload), [payload]);
  const profile = state.runtime.personality;
  const set = (patch: Partial<Personality>) => setState({ ...state, runtime: { ...state.runtime, personality: { ...profile, ...patch } } });
  return <form onSubmit={(e) => { e.preventDefault(); void onSave(state); }}>
    <Section title="Fixed server personality" description="The model cannot revise or self-develop these values." icon={<Sparkles />}>
      <div className="grid"><Field label="Character name"><input value={profile.name} onChange={(e) => set({ name: e.target.value })} /></Field><Field label="Tone"><input value={profile.tone} onChange={(e) => set({ tone: e.target.value })} /></Field></div>
      <Field label="Traits (comma separated)"><input value={profile.traits.join(', ')} onChange={(e) => set({ traits: splitList(e.target.value) })} /></Field>
      <Field label="Speaking style"><textarea value={profile.speakingStyle} onChange={(e) => set({ speakingStyle: e.target.value })} /></Field>
      <Field label="Relationship rules"><textarea value={profile.relationshipRules} onChange={(e) => set({ relationshipRules: e.target.value })} /></Field>
      <Field label="Additional system instructions"><textarea className="large" value={profile.customInstructions} onChange={(e) => set({ customInstructions: e.target.value })} /></Field>
    </Section>
    <button className="primary" disabled={!state.runtime.features.customPersonality}>Save personality</button>
    {!state.runtime.features.customPersonality && <p className="hint">Custom personality is not enabled by this plan.</p>}
  </form>;
}

function Providers({ guildId, payload, reload }: { guildId: string; payload: RuntimePayload; reload: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return <Section title="Bring your own keys" description="Keys are encrypted before storage and never displayed again." icon={<KeyRound />}>
    {(['gemini', 'groq', 'nvidia'] as const).map((provider) => {
      const credential = payload.credentials.find((item) => item.provider === provider);
      return <div className="credential" key={provider}><div><strong>{provider === 'nvidia' ? 'NVIDIA NIM' : provider[0]!.toUpperCase() + provider.slice(1)}</strong><small>{credential ? `Configured · ${credential.fingerprint}` : 'Not configured'}</small></div><input type="password" placeholder="Paste API key" value={values[provider] ?? ''} onChange={(e) => setValues({ ...values, [provider]: e.target.value })} /><button onClick={() => void api(`/api/guilds/${guildId}/credentials/${provider}`, { method: 'PUT', body: json({ value: values[provider] }) }).then(() => { setValues({ ...values, [provider]: '' }); reload(); })}>Save key</button>{credential && <button className="danger" onClick={() => void api(`/api/guilds/${guildId}/credentials/${provider}`, { method: 'DELETE' }).then(reload)}>Remove</button>}</div>;
    })}
  </Section>;
}

function Billing({ guildId, payload }: { guildId: string; payload: RuntimePayload }) {
  const usage = payload.usage;
  const [plans, setPlans] = useState<Array<{ id: string; name: string; description: string; kind: string; priceAmount: number | null; priceCurrency: string; features: Record<string, unknown> }>>([]);
  useEffect(() => { void api<{ plans: typeof plans }>('/api/plans').then((result) => setPlans(result.plans)); }, []);
  return <><div className="metrics"><Metric label="Messages" value={usage.unlimited ? 'Unlimited' : `${usage.messagesUsed} / ${usage.messageLimit}`} /><Metric label="Credits" value={usage.unlimited ? 'Unlimited' : `${usage.creditsUsed} / ${usage.creditLimit}`} /><Metric label="Plan" value={payload.runtime.planSlug} /></div><Section title="Subscription" description={payload.subscription ? `Status: ${payload.subscription.status}` : 'This server has no paid subscription.'} icon={<CreditCard />}>{payload.subscription && <button onClick={() => void api<{ url: string }>('/api/billing/portal', { method: 'POST', body: json({ guildId }) }).then(({ url }) => location.href = url)}>Open billing portal</button>}<div className="plan-grid">{plans.filter((plan) => plan.kind === 'paid').map((plan) => <div className="plan-card" key={plan.id}><strong>{plan.name}</strong><p>{plan.description}</p><b>{plan.priceAmount == null ? 'Unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.priceCurrency }).format(plan.priceAmount / 100)} / month</b><button disabled={plan.priceAmount == null} onClick={() => void api<{ url: string }>('/api/billing/checkout', { method: 'POST', body: json({ guildId, planId: plan.id }) }).then(({ url }) => location.href = url)}>Choose plan</button></div>)}</div></Section></>;
}

function Admin() {
  type AdminPlan = { id?: string; name: string; slug: string; kind: 'free' | 'paid' | 'private'; description?: string; published: boolean; archived?: boolean; sortOrder?: number; priceAmount?: number | null; priceCurrency?: string; features: Record<string, unknown> };
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [keys, setKeys] = useState<Array<{ id: string; provider: string; label: string; fingerprint: string }>>([]);
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  const [featureJson, setFeatureJson] = useState('{}');
  const [newKey, setNewKey] = useState({ provider: 'groq', label: '', value: '' });
  const [privateGuild, setPrivateGuild] = useState('');
  const reload = () => { void api<{ plans: AdminPlan[] }>('/api/admin/plans').then((r) => setPlans(r.plans)); void api<{ keys: typeof keys }>('/api/admin/provider-keys').then((r) => setKeys(r.keys)); };
  useEffect(reload, []);
  const edit = (plan?: AdminPlan) => { const value = plan ?? { name: '', slug: '', kind: 'paid', published: false, priceAmount: 999, priceCurrency: 'eur', features: {} }; setEditing(value); setFeatureJson(JSON.stringify(value.features, null, 2)); };
  return <><Section title="Plans" description="Entitlement changes apply immediately; allowance changes apply on the next cycle." icon={<Shield />}><button onClick={() => edit()}>Create paid plan</button>{plans.map((plan) => <button className="row plan-row" key={plan.id} onClick={() => edit(plan)}><div><strong>{plan.name}</strong><small>{plan.slug} · {plan.kind}</small></div><span>{plan.published ? 'Published' : 'Hidden'}</span></button>)}</Section>{editing && <Section title={editing.id ? `Edit ${editing.name}` : 'New plan'} description="Prices are monthly in the smallest currency unit. A changed price creates a new Stripe Price." icon={<CreditCard />}><div className="grid"><Field label="Name"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="Slug"><input value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} /></Field><Field label="Monthly price"><input type="number" value={editing.priceAmount ?? ''} onChange={(e) => setEditing({ ...editing, priceAmount: Number(e.target.value) })} /></Field><Field label="Currency"><input value={editing.priceCurrency ?? 'eur'} onChange={(e) => setEditing({ ...editing, priceCurrency: e.target.value })} /></Field></div><Toggle label="Published" detail="Visible for checkout." value={editing.published} onChange={(published) => setEditing({ ...editing, published })} /><Field label="Feature configuration (JSON)"><textarea className="large" value={featureJson} onChange={(e) => setFeatureJson(e.target.value)} /></Field><button onClick={() => void api('/api/admin/plans', { method: 'PUT', body: json({ ...editing, features: JSON.parse(featureJson) }) }).then(() => { setEditing(null); reload(); })}>Save plan</button></Section>}<Section title="Shared provider keys" description="Stored encrypted in PostgreSQL. Rate-limited Groq keys rotate automatically." icon={<KeyRound />}>{keys.map((key) => <div className="row" key={key.id}><div><strong>{key.label}</strong><small>{key.provider} · {key.fingerprint}</small></div><button className="danger" onClick={() => void api(`/api/admin/provider-keys/${key.id}`, { method: 'DELETE' }).then(reload)}>Remove</button></div>)}<div className="credential"><select value={newKey.provider} onChange={(e) => setNewKey({ ...newKey, provider: e.target.value })}><option value="groq">Groq shared pool</option><option value="gemini_paid">Gemini Live paid pool</option><option value="gemini_private">Gemini Live private pool</option><option value="nvidia">NVIDIA NIM shared</option></select><input placeholder="Label" value={newKey.label} onChange={(e) => setNewKey({ ...newKey, label: e.target.value })} /><input type="password" placeholder="API key" value={newKey.value} onChange={(e) => setNewKey({ ...newKey, value: e.target.value })} /><button onClick={() => void api('/api/admin/provider-keys', { method: 'POST', body: json(newKey) }).then(() => { setNewKey({ provider: 'groq', label: '', value: '' }); reload(); })}>Add</button></div></Section><Section title="Private guild access" description="Assign or remove the owner-only Private plan by guild ID." icon={<Shield />}><div className="credential"><input placeholder="Discord guild ID" value={privateGuild} onChange={(e) => setPrivateGuild(e.target.value)} /><button onClick={() => void api(`/api/admin/private-guilds/${privateGuild}`, { method: 'PUT', body: json({ assigned: true }) })}>Assign</button><button className="danger" onClick={() => void api(`/api/admin/private-guilds/${privateGuild}`, { method: 'PUT', body: json({ assigned: false }) })}>Remove</button></div></Section></>;
}

function BrowserChat({ guildId, voiceEnabled }: { guildId: string; voiceEnabled: boolean }) {
  const [messages, setMessages] = useState<Array<{ speaker: string; text: string }>>([]);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('connecting');
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [recording, setRecording] = useState(false);
  const audio = useMemo(() => new PcmPlayer(), []);
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/realtime?surface=browser&guildId=${guildId}`);
    ws.onopen = () => { setStatus('connected'); ws.send(JSON.stringify({ type: 'connect', surface: 'browser' })); };
    ws.onclose = (event) => setStatus(event.reason || 'disconnected');
    ws.onmessage = (event) => {
      const value = JSON.parse(event.data) as { type: string; speaker?: string; text?: string; data?: string; status?: string; reason?: string };
      if (value.type === 'status') setStatus(value.status ?? value.reason ?? 'unknown');
      if (value.type === 'transcript' && value.text) setMessages((current) => [...current, { speaker: value.speaker ?? 'assistant', text: value.text! }]);
      if (value.type === 'audio' && value.data) void audio.enqueue(value.data);
    };
    setSocket(ws);
    return () => { ws.close(); void audio.close(); };
  }, [guildId, audio]);
  const send = () => {
    if (!text.trim() || socket?.readyState !== WebSocket.OPEN) return;
    setMessages((current) => [...current, { speaker: 'user', text: text.trim() }]);
    socket.send(JSON.stringify({ type: 'text', text: text.trim(), requestId: crypto.randomUUID() }));
    setText('');
  };
  return <section className="chat"><div className="chat-status"><span className={status === 'connected' ? 'online' : ''} />{status}</div><div className="messages">{messages.length === 0 && <div className="empty">Start a conversation using this server's personality.</div>}{messages.map((message, index) => <div key={index} className={`bubble ${message.speaker}`}>{message.text}</div>)}</div><div className="composer"><button className={recording ? 'recording' : ''} disabled={!voiceEnabled} onPointerDown={() => void startMicrophone(socket!).then(() => setRecording(true))} onPointerUp={() => { stopMicrophone(socket); setRecording(false); }}><Mic /></button><input value={text} placeholder="Message Giada…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} /><button onClick={send}><Send /></button></div></section>;
}

let activeMic: { stream: MediaStream; context: AudioContext; processor: ScriptProcessorNode } | null = null;
async function startMicrophone(socket: WebSocket) {
  if (activeMic || socket.readyState !== WebSocket.OPEN) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const samples = downsample(event.inputBuffer.getChannelData(0), context.sampleRate, 16000);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767)));
    socket.send(JSON.stringify({ type: 'audio', data: bytesToBase64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=16000' }));
  };
  source.connect(processor); processor.connect(context.destination);
  activeMic = { stream, context, processor };
  socket.send(JSON.stringify({ type: 'activityStart' }));
}
function stopMicrophone(socket: WebSocket | null) {
  if (!activeMic) return;
  activeMic.processor.disconnect(); activeMic.stream.getTracks().forEach((track) => track.stop()); void activeMic.context.close(); activeMic = null;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'activityEnd' }));
}
class PcmPlayer {
  private context: AudioContext | null = null;
  private nextTime = 0;
  async enqueue(base64: string) {
    this.context ??= new AudioContext({ sampleRate: 24000 });
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.nextTime = Math.max(this.nextTime, this.context.currentTime); source.start(this.nextTime); this.nextTime += buffer.duration;
  }
  async close() { if (this.context) await this.context.close(); this.context = null; }
}
function downsample(input: Float32Array, from: number, to: number) { const ratio = from / to; const output = new Float32Array(Math.floor(input.length / ratio)); for (let i = 0; i < output.length; i += 1) output[i] = input[Math.floor(i * ratio)]!; return output; }
function bytesToBase64(bytes: Uint8Array) { let value = ''; for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(value); }

function Nav({ active, icon, children, onClick }: { active: boolean; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) { return <button className={active ? 'active' : ''} onClick={onClick}>{icon}{children}</button>; }
function Section({ title, description, icon, children }: { title: string; description: string; icon: React.ReactNode; children: React.ReactNode }) { return <section><div className="section-head"><span>{icon}</span><div><h2>{title}</h2><p>{description}</p></div></div><div className="section-body">{children}</div></section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Toggle({ label, detail, value, disabled, onChange }: { label: string; detail: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) { return <label className={`toggle-row ${disabled ? 'disabled' : ''}`}><div><strong>{label}</strong><small>{detail}</small></div><input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><i /></label>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><small>{label}</small><strong>{value}</strong></div>; }
function splitList(value: string) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function titleFor(tab: string) { return ({ chat: 'Browser chat', settings: 'Server settings', personality: 'Personality', providers: 'AI providers', billing: 'Plan and usage', admin: 'Platform administration' } as Record<string, string>)[tab] ?? tab; }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
