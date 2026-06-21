import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, ChevronRight, CreditCard, KeyRound, LogOut, MessageSquare, Mic, Send, Settings, Shield, Sparkles, Volume2 } from 'lucide-react';
import { api, json, loadMe } from './api';
import './styles.css';
import './chat.css';
import './admin.css';
import './voice-changer.css';
import { AdminPanel } from './AdminPanel';
function App() {
    const [me, setMe] = useState(null);
    const [guilds, setGuilds] = useState([]);
    const [selected, setSelected] = useState(null);
    const [payload, setPayload] = useState(null);
    const [tab, setTab] = useState('settings');
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        void loadMe().then(async (identity) => {
            setMe(identity);
            const result = await api('/api/guilds');
            setGuilds(result.guilds);
            setSelected(result.guilds[0]?.id ?? null);
        }).catch(() => setMe(null));
    }, []);
    useEffect(() => {
        if (!selected)
            return;
        setPayload(null);
        void api(`/api/guilds/${selected}/settings`).then(setPayload).catch((cause) => setError(cause.message));
    }, [selected]);
    const guild = useMemo(() => guilds.find((item) => item.id === selected), [guilds, selected]);
    if (!me)
        return _jsx(Login, {});
    async function save(next) {
        if (!selected)
            return;
        setError('');
        try {
            const result = await api(`/api/guilds/${selected}/settings`, {
                method: 'PUT', body: json({ settings: next.runtime.settings, personality: next.runtime.personality })
            });
            setPayload({ ...next, runtime: result.runtime });
            setSaved(true);
            setTimeout(() => setSaved(false), 1800);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    return _jsxs("div", { className: "shell", children: [_jsxs("aside", { children: [_jsxs("div", { className: "brand", children: [_jsx("span", { children: _jsx(Sparkles, { size: 19 }) }), _jsxs("div", { children: ["Giada", _jsx("small", { children: "Control center" })] })] }), _jsx("label", { className: "guild-label", children: "Discord server" }), _jsx("select", { value: selected ?? '', onChange: (event) => setSelected(event.target.value), children: guilds.map((item) => _jsx("option", { value: item.id, children: item.name }, item.id)) }), _jsxs("nav", { children: [_jsx(Nav, { active: tab === 'chat', icon: _jsx(MessageSquare, {}), onClick: () => setTab('chat'), children: "Browser chat" }), _jsx(Nav, { active: tab === 'settings', icon: _jsx(Settings, {}), onClick: () => setTab('settings'), children: "General" }), _jsx(Nav, { active: tab === 'personality', icon: _jsx(Bot, {}), onClick: () => setTab('personality'), children: "Personality" }), _jsx(Nav, { active: tab === 'providers', icon: _jsx(KeyRound, {}), onClick: () => setTab('providers'), children: "Providers" }), _jsx(Nav, { active: tab === 'billing', icon: _jsx(CreditCard, {}), onClick: () => setTab('billing'), children: "Plan & usage" }), me.owner && _jsx(Nav, { active: tab === 'admin', icon: _jsx(Shield, {}), onClick: () => setTab('admin'), children: "Administration" })] }), _jsxs("div", { className: "account", children: [_jsx("div", { className: "avatar", children: me.user.username.slice(0, 1).toUpperCase() }), _jsxs("div", { children: [me.user.username, _jsx("small", { children: me.owner ? 'Platform owner' : 'Server admin' })] }), _jsx("button", { title: "Log out", onClick: () => void api('/api/logout', { method: 'POST' }).then(() => location.reload()), children: _jsx(LogOut, {}) })] })] }), _jsxs("main", { children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx("p", { children: guild?.name ?? 'Server' }), _jsx("h1", { children: titleFor(tab) })] }), payload && _jsx("span", { className: `plan ${payload.runtime.planKind}`, children: payload.runtime.planSlug })] }), error && _jsx("div", { className: "notice error", children: error }), saved && _jsx("div", { className: "notice saved", children: "Settings saved" }), !payload ? _jsx("div", { className: "loading", children: "Loading server configuration\u2026" }) : _jsxs(_Fragment, { children: [tab === 'chat' && _jsx(BrowserChat, { guildId: selected, voiceEnabled: payload.runtime.features.geminiVoice === true && payload.runtime.settings.browserVoiceEnabled }), tab === 'settings' && _jsx(General, { guildId: selected, payload: payload, onSave: save }), tab === 'personality' && _jsx(PersonalityEditor, { payload: payload, onSave: save }), tab === 'providers' && _jsx(Providers, { guildId: selected, payload: payload, reload: () => selected && api(`/api/guilds/${selected}/settings`).then(setPayload) }), tab === 'billing' && _jsx(Billing, { guildId: selected, payload: payload }), tab === 'admin' && me.owner && _jsx(AdminPanel, {})] })] })] });
}
function Login() {
    return _jsx("div", { className: "login", children: _jsxs("div", { className: "login-card", children: [_jsx("div", { className: "logo-large", children: _jsx(Sparkles, {}) }), _jsx("p", { children: "GIADA CONTROL CENTER" }), _jsxs("h1", { children: ["Every server,", _jsx("br", {}), "its own character."] }), _jsx("span", { children: "Configure personality, voice, providers, and usage from one secure dashboard." }), _jsxs("a", { href: "/api/auth/discord", children: ["Continue with Discord ", _jsx(ChevronRight, {})] }), _jsx("small", { children: "Only server owners and administrators can change settings." })] }) });
}
function General({ guildId, payload, onSave }) {
    const [state, setState] = useState(payload);
    useEffect(() => setState(payload), [payload]);
    const settings = state.runtime.settings;
    const set = (patch) => setState({ ...state, runtime: { ...state.runtime, settings: { ...settings, ...patch } } });
    return _jsxs("form", { onSubmit: (event) => { event.preventDefault(); void onSave(state); }, children: [_jsx(Section, { title: "Bot identity", description: "Discord applies these values only in this server.", icon: _jsx(Bot, {}), children: _jsxs("div", { className: "grid", children: [_jsx(Field, { label: "Server nickname", children: _jsx("input", { disabled: !state.runtime.features.customIdentity, value: settings.nickname ?? '', maxLength: 32, onChange: (e) => set({ nickname: e.target.value || null }) }) }), _jsx(Field, { label: "Avatar image", children: _jsx("input", { disabled: !state.runtime.features.customIdentity, type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", onChange: (e) => { const file = e.target.files?.[0]; if (!file)
                                    return; const form = new FormData(); form.append('file', file); void api(`/api/guilds/${guildId}/avatar`, { method: 'POST', body: form }).then(({ runtime }) => setState({ ...state, runtime })); } }) })] }) }), _jsxs(Section, { title: "Response settings", description: "Choose enabled modalities and server behavior.", icon: _jsx(MessageSquare, {}), children: [_jsxs("div", { className: "grid", children: [_jsx(Field, { label: "Text provider", children: _jsxs("select", { value: settings.textProvider, onChange: (e) => set({ textProvider: e.target.value }), children: [_jsx("option", { value: "auto", children: "Automatic" }), _jsx("option", { value: "groq", children: "Groq" }), _jsx("option", { value: "gemini", children: "Gemini Live" })] }) }), _jsx(Field, { label: "Voice provider", children: _jsxs("select", { value: settings.voiceProvider, onChange: (e) => set({ voiceProvider: e.target.value }), children: [_jsx("option", { value: "auto", children: "Automatic" }), _jsx("option", { value: "gemini", children: "Gemini Live" })] }) })] }), _jsx(Toggle, { label: "NSFW responses", detail: "Still restricted to Discord age-restricted channels.", value: settings.nsfwEnabled, disabled: !state.runtime.features.nsfw, onChange: (value) => set({ nsfwEnabled: value }) }), _jsx(Toggle, { label: "Browser text chat", detail: "Uses this server's personality and allowance.", value: settings.browserTextEnabled, disabled: !state.runtime.features.browserChat, onChange: (value) => set({ browserTextEnabled: value }) }), _jsxs("div", { className: "grid", children: [_jsx(Field, { label: "Always-listen channel IDs", children: _jsx("input", { value: settings.listeningChannelIds.join(', '), onChange: (e) => set({ listeningChannelIds: splitList(e.target.value) }) }) }), _jsx(Field, { label: "Voice-watch channel IDs", children: _jsx("input", { value: settings.voiceWatchChannelIds.join(', '), onChange: (e) => set({ voiceWatchChannelIds: splitList(e.target.value) }) }) })] })] }), _jsxs(Section, { title: "Voice changer", description: "FFmpeg filter applied to generated speech, not music.", icon: _jsx(Volume2, {}), children: [_jsx(Toggle, { label: "Enable voice changer", detail: state.runtime.features.voiceChanger ? 'Applied to Discord and browser voice.' : 'Not available on this plan.', value: settings.voiceChanger.enabled, disabled: !state.runtime.features.voiceChanger, onChange: (enabled) => set({ voiceChanger: { ...settings.voiceChanger, enabled } }) }), _jsx(VoiceChangerEditor, { guildId: guildId, value: settings.voiceChanger, profiles: state.voiceProfiles, disabled: !state.runtime.features.voiceChanger, onProfilesChange: (voiceProfiles) => setState({ ...state, voiceProfiles }), onChange: (voiceChanger) => set({ voiceChanger }) })] }), _jsx("button", { className: "primary", children: "Save changes" })] });
}
const defaultVoiceValues = {
    highpass: 100, lowpass: 13_500, trebleGain: 2.5, trebleFrequency: 4_000,
    compressorThreshold: -18, compressorRatio: 2.4, compressorAttack: 5,
    compressorRelease: 65, pitchSemitones: 2, volume: 0.95
};
const voicePresets = [
    { name: 'bypass', label: 'Bypass', enabled: false, values: { ...defaultVoiceValues, pitchSemitones: 0, trebleGain: 0, volume: 1 } },
    { name: 'anime-girl', label: 'Anime girl', enabled: true, values: defaultVoiceValues }
];
function VoiceChangerEditor({ guildId, value, profiles, disabled, onChange, onProfilesChange }) {
    const [profileError, setProfileError] = useState('');
    const values = parseVoiceFilter(value.ffmpegFilter);
    const customProfile = profiles.find((item) => item.name === value.name && item.ffmpegFilter === value.ffmpegFilter);
    const builtinProfile = voicePresets.find((preset) => preset.name === value.name);
    const selectedProfile = customProfile ? `custom:${customProfile.id}` : builtinProfile ? `builtin:${builtinProfile.name}` : 'unsaved';
    const update = (patch) => {
        const name = selectedProfile === 'unsaved' || customProfile ? value.name : `${value.name}-custom`;
        onChange({ ...value, name, ffmpegFilter: buildVoiceFilter({ ...values, ...patch }) });
    };
    const numeric = (label, key, min, max, step) => _jsx(Field, { label: label, children: _jsx("input", { disabled: disabled, type: "number", min: min, max: max, step: step, value: values[key], onChange: (event) => update({ [key]: Number(event.target.value) }) }) });
    return _jsxs("div", { className: "voice-editor", children: [_jsxs("div", { className: "grid", children: [_jsx(Field, { label: "Current profile", children: _jsxs("select", { disabled: disabled, value: selectedProfile, onChange: (event) => {
                                const [kind, id] = event.target.value.split(':');
                                const preset = kind === 'builtin' ? voicePresets.find((item) => item.name === id) : undefined;
                                const saved = kind === 'custom' ? profiles.find((item) => item.id === id) : undefined;
                                if (preset)
                                    onChange({ enabled: preset.enabled, name: preset.name, ffmpegFilter: preset.name === 'bypass' ? 'anull' : buildVoiceFilter(preset.values) });
                                if (saved)
                                    onChange({ enabled: true, name: saved.name, ffmpegFilter: saved.ffmpegFilter });
                            }, children: [voicePresets.map((preset) => _jsx("option", { value: `builtin:${preset.name}`, children: preset.label }, preset.name)), profiles.map((item) => _jsx("option", { value: `custom:${item.id}`, children: item.name }, item.id)), selectedProfile === 'unsaved' && _jsxs("option", { value: "unsaved", children: ["Unsaved (", value.name, ")"] })] }) }), _jsx(Field, { label: "Profile name", children: _jsx("input", { disabled: disabled, value: value.name, maxLength: 80, onChange: (event) => onChange({ ...value, name: event.target.value }) }) })] }), _jsxs("div", { className: "voice-profile-actions", children: [_jsx("button", { type: "button", disabled: disabled || !value.name.trim(), onClick: () => {
                            setProfileError('');
                            void api(`/api/guilds/${guildId}/voice-profiles`, { method: 'POST', body: json({ name: value.name, ffmpegFilter: value.ffmpegFilter }) })
                                .then(({ profile }) => onProfilesChange([...profiles, profile].sort((a, b) => a.name.localeCompare(b.name))))
                                .catch((error) => setProfileError(error instanceof Error ? error.message : String(error)));
                        }, children: "Create profile" }), customProfile && _jsx("button", { type: "button", className: "danger", disabled: disabled, onClick: () => {
                            if (!confirm(`Delete voice profile “${customProfile.name}”?`))
                                return;
                            setProfileError('');
                            void api(`/api/guilds/${guildId}/voice-profiles/${customProfile.id}`, { method: 'DELETE' })
                                .then(() => onProfilesChange(profiles.filter((item) => item.id !== customProfile.id)))
                                .catch((error) => setProfileError(error instanceof Error ? error.message : String(error)));
                        }, children: "Delete profile" }), profileError && _jsx("small", { className: "profile-error", children: profileError })] }), _jsxs("div", { className: "voice-control-group", children: [_jsx("strong", { children: "Pitch and level" }), _jsxs("div", { className: "grid", children: [numeric('Pitch (semitones)', 'pitchSemitones', -12, 12, 0.1), numeric('Output volume', 'volume', 0, 3, 0.01)] })] }), _jsxs("div", { className: "voice-control-group", children: [_jsx("strong", { children: "Frequency shaping" }), _jsxs("div", { className: "grid", children: [numeric('High-pass frequency (Hz)', 'highpass', 20, 2_000, 1), numeric('Low-pass frequency (Hz)', 'lowpass', 1_000, 20_000, 1), numeric('Treble gain (dB)', 'trebleGain', -20, 20, 0.1), numeric('Treble frequency (Hz)', 'trebleFrequency', 1_000, 12_000, 1)] })] }), _jsxs("div", { className: "voice-control-group", children: [_jsx("strong", { children: "Compressor" }), _jsxs("div", { className: "grid", children: [numeric('Threshold (dB)', 'compressorThreshold', -60, 0, 0.1), numeric('Ratio', 'compressorRatio', 1, 20, 0.1), numeric('Attack (ms)', 'compressorAttack', 0.01, 2_000, 0.1), numeric('Release (ms)', 'compressorRelease', 0.01, 9_000, 0.1)] })] })] });
}
function parseVoiceFilter(filter) {
    if (filter.trim() === 'anull')
        return { ...defaultVoiceValues, pitchSemitones: 0, trebleGain: 0, volume: 1 };
    const read = (pattern, fallback) => Number(filter.match(pattern)?.[1] ?? fallback);
    const sampleRate = read(/asetrate=([\d.]+)/, 24_000 * Math.pow(2, defaultVoiceValues.pitchSemitones / 12));
    return {
        highpass: read(/highpass=f=([\d.]+)/, defaultVoiceValues.highpass), lowpass: read(/lowpass=f=([\d.]+)/, defaultVoiceValues.lowpass),
        trebleGain: read(/treble=g=(-?[\d.]+):f=/, defaultVoiceValues.trebleGain), trebleFrequency: read(/treble=g=-?[\d.]+:f=([\d.]+)/, defaultVoiceValues.trebleFrequency),
        compressorThreshold: read(/acompressor=threshold=(-?[\d.]+)dB/, defaultVoiceValues.compressorThreshold), compressorRatio: read(/acompressor=[^,]*ratio=([\d.]+)/, defaultVoiceValues.compressorRatio),
        compressorAttack: read(/acompressor=[^,]*attack=([\d.]+)/, defaultVoiceValues.compressorAttack), compressorRelease: read(/acompressor=[^,]*release=([\d.]+)/, defaultVoiceValues.compressorRelease),
        pitchSemitones: Number((12 * Math.log2(sampleRate / 24_000)).toFixed(2)), volume: read(/(?:^|,)volume=([\d.]+)/, defaultVoiceValues.volume)
    };
}
function buildVoiceFilter(values) {
    const sampleRate = Math.round(24_000 * Math.pow(2, values.pitchSemitones / 12));
    const tempo = Number((24_000 / sampleRate).toFixed(6));
    return `highpass=f=${values.highpass},lowpass=f=${values.lowpass},treble=g=${values.trebleGain}:f=${values.trebleFrequency},acompressor=threshold=${values.compressorThreshold}dB:ratio=${values.compressorRatio}:attack=${values.compressorAttack}:release=${values.compressorRelease},asetrate=${sampleRate},aresample=24000,atempo=${tempo},volume=${values.volume}`;
}
function PersonalityEditor({ payload, onSave }) {
    const [state, setState] = useState(payload);
    useEffect(() => setState(payload), [payload]);
    const profile = state.runtime.personality;
    const set = (patch) => setState({ ...state, runtime: { ...state.runtime, personality: { ...profile, ...patch } } });
    return _jsxs("form", { onSubmit: (e) => { e.preventDefault(); void onSave(state); }, children: [_jsxs(Section, { title: "Fixed server personality", description: "The model cannot revise or self-develop these values.", icon: _jsx(Sparkles, {}), children: [_jsxs("div", { className: "grid", children: [_jsx(Field, { label: "Character name", children: _jsx("input", { value: profile.name, onChange: (e) => set({ name: e.target.value }) }) }), _jsx(Field, { label: "Tone", children: _jsx("input", { value: profile.tone, onChange: (e) => set({ tone: e.target.value }) }) })] }), _jsx(Field, { label: "Traits (comma separated)", children: _jsx("input", { value: profile.traits.join(', '), onChange: (e) => set({ traits: splitList(e.target.value) }) }) }), _jsx(Field, { label: "Speaking style", children: _jsx("textarea", { value: profile.speakingStyle, onChange: (e) => set({ speakingStyle: e.target.value }) }) }), _jsx(Field, { label: "Relationship rules", children: _jsx("textarea", { value: profile.relationshipRules, onChange: (e) => set({ relationshipRules: e.target.value }) }) }), _jsx(Field, { label: "Additional system instructions", children: _jsx("textarea", { className: "large", value: profile.customInstructions, onChange: (e) => set({ customInstructions: e.target.value }) }) })] }), _jsx("button", { className: "primary", disabled: !state.runtime.features.customPersonality, children: "Save personality" }), !state.runtime.features.customPersonality && _jsx("p", { className: "hint", children: "Custom personality is not enabled by this plan." })] });
}
function Providers({ guildId, payload, reload }) {
    const [values, setValues] = useState({});
    return _jsx(Section, { title: "Bring your own keys", description: "Keys are encrypted before storage and never displayed again.", icon: _jsx(KeyRound, {}), children: ['gemini', 'groq', 'nvidia'].map((provider) => {
            const credential = payload.credentials.find((item) => item.provider === provider);
            return _jsxs("div", { className: "credential", children: [_jsxs("div", { children: [_jsx("strong", { children: provider === 'nvidia' ? 'NVIDIA NIM' : provider[0].toUpperCase() + provider.slice(1) }), _jsx("small", { children: credential ? `Configured · ${credential.fingerprint}` : 'Not configured' })] }), _jsx("input", { type: "password", placeholder: "Paste API key", value: values[provider] ?? '', onChange: (e) => setValues({ ...values, [provider]: e.target.value }) }), _jsx("button", { onClick: () => void api(`/api/guilds/${guildId}/credentials/${provider}`, { method: 'PUT', body: json({ value: values[provider] }) }).then(() => { setValues({ ...values, [provider]: '' }); reload(); }), children: "Save key" }), credential && _jsx("button", { className: "danger", onClick: () => void api(`/api/guilds/${guildId}/credentials/${provider}`, { method: 'DELETE' }).then(reload), children: "Remove" })] }, provider);
        }) });
}
function Billing({ guildId, payload }) {
    const usage = payload.usage;
    const [plans, setPlans] = useState([]);
    useEffect(() => { void api('/api/plans').then((result) => setPlans(result.plans)); }, []);
    return _jsxs(_Fragment, { children: [_jsxs("div", { className: "metrics", children: [_jsx(Metric, { label: "Messages", value: usage.unlimited ? 'Unlimited' : `${usage.messagesUsed} / ${usage.messageLimit}` }), _jsx(Metric, { label: "Credits", value: usage.unlimited ? 'Unlimited' : `${usage.creditsUsed} / ${usage.creditLimit}` }), _jsx(Metric, { label: "Plan", value: payload.runtime.planSlug })] }), _jsxs(Section, { title: "Subscription", description: payload.subscription ? `Status: ${payload.subscription.status}` : 'This server has no paid subscription.', icon: _jsx(CreditCard, {}), children: [payload.subscription && _jsx("button", { onClick: () => void api('/api/billing/portal', { method: 'POST', body: json({ guildId }) }).then(({ url }) => location.href = url), children: "Open billing portal" }), _jsx("div", { className: "plan-grid", children: plans.filter((plan) => plan.kind === 'paid').map((plan) => _jsxs("div", { className: "plan-card", children: [_jsx("strong", { children: plan.name }), _jsx("p", { children: plan.description }), _jsxs("b", { children: [plan.priceAmount == null ? 'Unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.priceCurrency }).format(plan.priceAmount / 100), " / month"] }), _jsx("button", { disabled: plan.priceAmount == null, onClick: () => void api('/api/billing/checkout', { method: 'POST', body: json({ guildId, planId: plan.id }) }).then(({ url }) => location.href = url), children: "Choose plan" })] }, plan.id)) })] })] });
}
function Admin() {
    const [plans, setPlans] = useState([]);
    const [keys, setKeys] = useState([]);
    const [editing, setEditing] = useState(null);
    const [featureJson, setFeatureJson] = useState('{}');
    const [newKey, setNewKey] = useState({ provider: 'groq', label: '', value: '' });
    const [privateGuild, setPrivateGuild] = useState('');
    const reload = () => { void api('/api/admin/plans').then((r) => setPlans(r.plans)); void api('/api/admin/provider-keys').then((r) => setKeys(r.keys)); };
    useEffect(reload, []);
    const edit = (plan) => { const value = plan ?? { name: '', slug: '', kind: 'paid', published: false, priceAmount: 999, priceCurrency: 'eur', features: {} }; setEditing(value); setFeatureJson(JSON.stringify(value.features, null, 2)); };
    return _jsxs(_Fragment, { children: [_jsxs(Section, { title: "Plans", description: "Entitlement changes apply immediately; allowance changes apply on the next cycle.", icon: _jsx(Shield, {}), children: [_jsx("button", { onClick: () => edit(), children: "Create paid plan" }), plans.map((plan) => _jsxs("button", { className: "row plan-row", onClick: () => edit(plan), children: [_jsxs("div", { children: [_jsx("strong", { children: plan.name }), _jsxs("small", { children: [plan.slug, " \u00B7 ", plan.kind] })] }), _jsx("span", { children: plan.published ? 'Published' : 'Hidden' })] }, plan.id))] }), editing && _jsxs(Section, { title: editing.id ? `Edit ${editing.name}` : 'New plan', description: "Prices are monthly in the smallest currency unit. A changed price creates a new Stripe Price.", icon: _jsx(CreditCard, {}), children: [_jsxs("div", { className: "grid", children: [_jsx(Field, { label: "Name", children: _jsx("input", { value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), _jsx(Field, { label: "Slug", children: _jsx("input", { value: editing.slug, onChange: (e) => setEditing({ ...editing, slug: e.target.value }) }) }), _jsx(Field, { label: "Monthly price", children: _jsx("input", { type: "number", value: editing.priceAmount ?? '', onChange: (e) => setEditing({ ...editing, priceAmount: Number(e.target.value) }) }) }), _jsx(Field, { label: "Currency", children: _jsx("input", { value: editing.priceCurrency ?? 'eur', onChange: (e) => setEditing({ ...editing, priceCurrency: e.target.value }) }) })] }), _jsx(Toggle, { label: "Published", detail: "Visible for checkout.", value: editing.published, onChange: (published) => setEditing({ ...editing, published }) }), _jsx(Field, { label: "Feature configuration (JSON)", children: _jsx("textarea", { className: "large", value: featureJson, onChange: (e) => setFeatureJson(e.target.value) }) }), _jsx("button", { onClick: () => void api('/api/admin/plans', { method: 'PUT', body: json({ ...editing, features: JSON.parse(featureJson) }) }).then(() => { setEditing(null); reload(); }), children: "Save plan" })] }), _jsxs(Section, { title: "Shared provider keys", description: "Stored encrypted in PostgreSQL. Rate-limited Groq keys rotate automatically.", icon: _jsx(KeyRound, {}), children: [keys.map((key) => _jsxs("div", { className: "row", children: [_jsxs("div", { children: [_jsx("strong", { children: key.label }), _jsxs("small", { children: [key.provider, " \u00B7 ", key.fingerprint] })] }), _jsx("button", { className: "danger", onClick: () => void api(`/api/admin/provider-keys/${key.id}`, { method: 'DELETE' }).then(reload), children: "Remove" })] }, key.id)), _jsxs("div", { className: "credential", children: [_jsxs("select", { value: newKey.provider, onChange: (e) => setNewKey({ ...newKey, provider: e.target.value }), children: [_jsx("option", { value: "groq", children: "Groq shared pool" }), _jsx("option", { value: "gemini_paid", children: "Gemini Live paid pool" }), _jsx("option", { value: "gemini_private", children: "Gemini Live private pool" }), _jsx("option", { value: "nvidia", children: "NVIDIA NIM shared" })] }), _jsx("input", { placeholder: "Label", value: newKey.label, onChange: (e) => setNewKey({ ...newKey, label: e.target.value }) }), _jsx("input", { type: "password", placeholder: "API key", value: newKey.value, onChange: (e) => setNewKey({ ...newKey, value: e.target.value }) }), _jsx("button", { onClick: () => void api('/api/admin/provider-keys', { method: 'POST', body: json(newKey) }).then(() => { setNewKey({ provider: 'groq', label: '', value: '' }); reload(); }), children: "Add" })] })] }), _jsx(Section, { title: "Private guild access", description: "Assign or remove the owner-only Private plan by guild ID.", icon: _jsx(Shield, {}), children: _jsxs("div", { className: "credential", children: [_jsx("input", { placeholder: "Discord guild ID", value: privateGuild, onChange: (e) => setPrivateGuild(e.target.value) }), _jsx("button", { onClick: () => void api(`/api/admin/private-guilds/${privateGuild}`, { method: 'PUT', body: json({ assigned: true }) }), children: "Assign" }), _jsx("button", { className: "danger", onClick: () => void api(`/api/admin/private-guilds/${privateGuild}`, { method: 'PUT', body: json({ assigned: false }) }), children: "Remove" })] }) })] });
}
function BrowserChat({ guildId, voiceEnabled }) {
    const [messages, setMessages] = useState([]);
    const [text, setText] = useState('');
    const [status, setStatus] = useState('connecting');
    const [socket, setSocket] = useState(null);
    const [recording, setRecording] = useState(false);
    const audio = useMemo(() => new PcmPlayer(), []);
    useEffect(() => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/realtime?surface=browser&guildId=${guildId}`);
        ws.onopen = () => { setStatus('connected'); ws.send(JSON.stringify({ type: 'connect', surface: 'browser' })); };
        ws.onclose = (event) => setStatus(event.reason || 'disconnected');
        ws.onmessage = (event) => {
            const value = JSON.parse(event.data);
            if (value.type === 'status')
                setStatus(value.status ?? value.reason ?? 'unknown');
            if (value.type === 'transcript' && value.text)
                setMessages((current) => mergeBrowserTranscript(current, {
                    speaker: value.speaker ?? 'assistant',
                    text: value.text,
                    final: value.final === true
                }));
            if (value.type === 'audio' && value.data)
                void audio.enqueue(value.data);
        };
        setSocket(ws);
        return () => { ws.close(); void audio.close(); };
    }, [guildId, audio]);
    const send = () => {
        if (!text.trim() || socket?.readyState !== WebSocket.OPEN)
            return;
        setMessages((current) => [...current, { speaker: 'user', text: text.trim(), final: true }]);
        socket.send(JSON.stringify({ type: 'text', text: text.trim(), requestId: crypto.randomUUID() }));
        setText('');
    };
    return _jsxs("section", { className: "chat", children: [_jsxs("div", { className: "chat-status", children: [_jsx("span", { className: status === 'connected' ? 'online' : '' }), status] }), _jsxs("div", { className: "messages", children: [messages.length === 0 && _jsx("div", { className: "empty", children: "Start a conversation using this server's personality." }), messages.map((message, index) => _jsx("div", { className: `bubble ${message.speaker}`, children: message.text }, index))] }), _jsxs("div", { className: "composer", children: [_jsx("button", { className: recording ? 'recording' : '', disabled: !voiceEnabled, onPointerDown: () => void startMicrophone(socket).then(() => setRecording(true)), onPointerUp: () => { stopMicrophone(socket); setRecording(false); }, children: _jsx(Mic, {}) }), _jsx("input", { value: text, placeholder: "Message Giada\u2026", onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter')
                            send(); } }), _jsx("button", { onClick: send, children: _jsx(Send, {}) })] })] });
}
function mergeBrowserTranscript(current, incoming) {
    const normalized = incoming.text.replace(/\s+/g, ' ').trim();
    if (!normalized)
        return current;
    const next = [...current];
    const last = next[next.length - 1];
    if (last?.speaker === incoming.speaker && last.final && normalized === last.text)
        return current;
    if (last?.speaker === incoming.speaker && !last.final) {
        next[next.length - 1] = { ...last, text: appendBrowserTranscript(last.text, normalized), final: incoming.final };
        return next.slice(-100);
    }
    next.push({ ...incoming, text: normalized });
    return next.slice(-100);
}
function appendBrowserTranscript(previous, incoming) {
    if (incoming.startsWith(previous))
        return incoming;
    if (previous.endsWith(incoming))
        return previous;
    const previousLast = previous.at(-1) ?? '';
    const incomingFirst = incoming.at(0) ?? '';
    const needsSpace = !previous.endsWith(' ') && !incoming.startsWith(' ')
        && !/^[,.;:!?)]$/.test(incomingFirst) && previousLast !== '('
        && ((/[\p{L}\p{N}"']$/u.test(previousLast) && /^[\p{L}\p{N}"'(]$/u.test(incomingFirst))
            || (/[.!?]$/.test(previousLast) && /^[\p{L}\p{N}"'(]$/u.test(incomingFirst)));
    return `${previous}${needsSpace ? ' ' : ''}${incoming}`;
}
let activeMic = null;
async function startMicrophone(socket) {
    if (activeMic || socket.readyState !== WebSocket.OPEN)
        return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
        const samples = downsample(event.inputBuffer.getChannelData(0), context.sampleRate, 16000);
        const pcm = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i += 1)
            pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
        socket.send(JSON.stringify({ type: 'audio', data: bytesToBase64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=16000' }));
    };
    source.connect(processor);
    processor.connect(context.destination);
    activeMic = { stream, context, processor };
    socket.send(JSON.stringify({ type: 'activityStart' }));
}
function stopMicrophone(socket) {
    if (!activeMic)
        return;
    activeMic.processor.disconnect();
    activeMic.stream.getTracks().forEach((track) => track.stop());
    void activeMic.context.close();
    activeMic = null;
    if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'activityEnd' }));
}
class PcmPlayer {
    context = null;
    nextTime = 0;
    async enqueue(base64) {
        this.context ??= new AudioContext({ sampleRate: 24000 });
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < channel.length; i += 1)
            channel[i] = view.getInt16(i * 2, true) / 32768;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.nextTime = Math.max(this.nextTime, this.context.currentTime);
        source.start(this.nextTime);
        this.nextTime += buffer.duration;
    }
    async close() { if (this.context)
        await this.context.close(); this.context = null; }
}
function downsample(input, from, to) { const ratio = from / to; const output = new Float32Array(Math.floor(input.length / ratio)); for (let i = 0; i < output.length; i += 1)
    output[i] = input[Math.floor(i * ratio)]; return output; }
function bytesToBase64(bytes) { let value = ''; for (let i = 0; i < bytes.length; i += 0x8000)
    value += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(value); }
function Nav({ active, icon, children, onClick }) { return _jsxs("button", { className: active ? 'active' : '', onClick: onClick, children: [icon, children] }); }
function Section({ title, description, icon, children }) { return _jsxs("section", { children: [_jsxs("div", { className: "section-head", children: [_jsx("span", { children: icon }), _jsxs("div", { children: [_jsx("h2", { children: title }), _jsx("p", { children: description })] })] }), _jsx("div", { className: "section-body", children: children })] }); }
function Field({ label, children }) { return _jsxs("label", { className: "field", children: [_jsx("span", { children: label }), children] }); }
function Toggle({ label, detail, value, disabled, onChange }) { return _jsxs("label", { className: `toggle-row ${disabled ? 'disabled' : ''}`, children: [_jsxs("div", { children: [_jsx("strong", { children: label }), _jsx("small", { children: detail })] }), _jsx("input", { type: "checkbox", checked: value, disabled: disabled, onChange: (e) => onChange(e.target.checked) }), _jsx("i", {})] }); }
function Metric({ label, value }) { return _jsxs("div", { className: "metric", children: [_jsx("small", { children: label }), _jsx("strong", { children: value })] }); }
function splitList(value) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function titleFor(tab) { return { chat: 'Browser chat', settings: 'Server settings', personality: 'Personality', providers: 'AI providers', billing: 'Plan and usage', admin: 'Platform administration' }[tab] ?? tab; }
createRoot(document.getElementById('root')).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
