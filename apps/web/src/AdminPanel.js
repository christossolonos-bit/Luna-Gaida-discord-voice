import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { CreditCard, KeyRound, Shield } from 'lucide-react';
import { api, json } from './api';
const emptyKey = { provider: 'groq', label: '', value: '' };
export function AdminPanel() {
    const [plans, setPlans] = useState([]);
    const [keys, setKeys] = useState([]);
    const [guilds, setGuilds] = useState([]);
    const [editingPlan, setEditingPlan] = useState(null);
    const [featureJson, setFeatureJson] = useState('{}');
    const [newKey, setNewKey] = useState(emptyKey);
    const [editingKey, setEditingKey] = useState(null);
    const [privateGuildId, setPrivateGuildId] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const reload = async () => {
        const [planResult, keyResult, guildResult] = await Promise.all([
            api('/api/admin/plans'),
            api('/api/admin/provider-keys'),
            api('/api/admin/guilds')
        ]);
        setPlans(planResult.plans);
        setKeys(keyResult.keys);
        setGuilds(guildResult.guilds);
    };
    useEffect(() => { void reload().catch(showError); }, []);
    const showError = (cause) => {
        setMessage('');
        setError(cause instanceof Error ? cause.message : String(cause));
    };
    const showSuccess = (value) => {
        setError('');
        setMessage(value);
    };
    const editPlan = (plan) => {
        const value = plan ?? {
            name: '', slug: '', kind: 'paid', published: false,
            priceAmount: 999, priceCurrency: 'eur', features: {}
        };
        setEditingPlan(value);
        setFeatureJson(JSON.stringify(value.features, null, 2));
    };
    const savePlan = async () => {
        if (!editingPlan)
            return;
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
        if (!editingKey)
            return;
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
    const removeKey = async (id) => {
        await api(`/api/admin/provider-keys/${id}`, { method: 'DELETE' });
        if (editingKey?.id === id)
            setEditingKey(null);
        await reload();
        showSuccess('Provider key removed.');
    };
    const setPrivate = async (guild, assigned) => {
        await api(`/api/admin/private-guilds/${guild.id}`, {
            method: 'PUT',
            body: json({ assigned })
        });
        await reload();
        showSuccess(`${guild.name} ${assigned ? 'assigned to' : 'removed from'} Private.`);
    };
    const assignPrivateById = async () => {
        const guildId = privateGuildId.trim();
        if (!/^\d+$/.test(guildId))
            throw new Error('Enter a valid Discord guild ID.');
        await api(`/api/admin/private-guilds/${guildId}`, {
            method: 'PUT',
            body: json({ assigned: true })
        });
        setPrivateGuildId('');
        await reload();
        showSuccess(`Guild ${guildId} assigned to Private.`);
    };
    return _jsxs(_Fragment, { children: [error && _jsx("div", { className: "notice error", children: error }), message && _jsx("div", { className: "notice saved", children: message }), _jsxs(AdminSection, { title: "Plans", description: "Entitlement changes apply immediately; allowances change next cycle.", icon: _jsx(Shield, {}), children: [_jsx("button", { onClick: () => editPlan(), children: "Create paid plan" }), plans.map((plan) => _jsxs("button", { className: "row plan-row", onClick: () => editPlan(plan), children: [_jsxs("div", { children: [_jsx("strong", { children: plan.name }), _jsxs("small", { children: [plan.slug, " \u00B7 ", plan.kind] })] }), _jsx("span", { children: plan.published ? 'Published' : 'Hidden' })] }, plan.id))] }), editingPlan && _jsxs(AdminSection, { title: editingPlan.id ? `Edit ${editingPlan.name}` : 'New plan', description: "Changing the price creates a new Stripe Price.", icon: _jsx(CreditCard, {}), children: [_jsxs("div", { className: "grid", children: [_jsx(AdminField, { label: "Name", children: _jsx("input", { value: editingPlan.name, onChange: (event) => setEditingPlan({ ...editingPlan, name: event.target.value }) }) }), _jsx(AdminField, { label: "Slug", children: _jsx("input", { value: editingPlan.slug, onChange: (event) => setEditingPlan({ ...editingPlan, slug: event.target.value }) }) }), _jsx(AdminField, { label: "Monthly price", children: _jsx("input", { type: "number", value: editingPlan.priceAmount ?? '', onChange: (event) => setEditingPlan({ ...editingPlan, priceAmount: Number(event.target.value) }) }) }), _jsx(AdminField, { label: "Currency", children: _jsx("input", { value: editingPlan.priceCurrency ?? 'eur', onChange: (event) => setEditingPlan({ ...editingPlan, priceCurrency: event.target.value }) }) })] }), _jsxs("label", { className: "toggle-row", children: [_jsxs("div", { children: [_jsx("strong", { children: "Published" }), _jsx("small", { children: "Visible during checkout." })] }), _jsx("input", { type: "checkbox", checked: editingPlan.published, onChange: (event) => setEditingPlan({ ...editingPlan, published: event.target.checked }) }), _jsx("i", {})] }), _jsx(AdminField, { label: "Feature configuration (JSON)", children: _jsx("textarea", { className: "large", value: featureJson, onChange: (event) => setFeatureJson(event.target.value) }) }), _jsx("button", { onClick: () => void savePlan().catch(showError), children: "Save plan" }), _jsx("button", { className: "danger", onClick: () => setEditingPlan(null), children: "Cancel" })] }), _jsxs(AdminSection, { title: "Shared provider keys", description: "Edit metadata or replace a key without exposing its current plaintext value.", icon: _jsx(KeyRound, {}), children: [keys.map((key) => _jsxs("div", { className: "row", children: [_jsxs("div", { children: [_jsx("strong", { children: key.label }), _jsxs("small", { children: [providerLabel(key.provider), " \u00B7 ", key.fingerprint, " \u00B7 ", key.enabled ? 'enabled' : 'disabled'] })] }), _jsxs("div", { className: "row-actions", children: [_jsx("button", { onClick: () => setEditingKey({ ...key, value: '' }), children: "Edit" }), _jsx("button", { className: "danger", onClick: () => void removeKey(key.id).catch(showError), children: "Remove" })] })] }, key.id)), editingKey && _jsxs("div", { className: "credential key-editor", children: [_jsx("select", { value: editingKey.provider, onChange: (event) => setEditingKey({ ...editingKey, provider: event.target.value }), children: providerOptions() }), _jsx("input", { value: editingKey.label, placeholder: "Label", onChange: (event) => setEditingKey({ ...editingKey, label: event.target.value }) }), _jsx("input", { type: "password", value: editingKey.value, placeholder: "New key (leave blank to keep current)", onChange: (event) => setEditingKey({ ...editingKey, value: event.target.value }) }), _jsxs("label", { className: "key-enabled", children: [_jsx("input", { type: "checkbox", checked: editingKey.enabled, onChange: (event) => setEditingKey({ ...editingKey, enabled: event.target.checked }) }), " Enabled"] }), _jsx("button", { onClick: () => void saveKey().catch(showError), children: "Save" }), _jsx("button", { className: "danger", onClick: () => setEditingKey(null), children: "Cancel" })] }), _jsxs("div", { className: "credential key-editor", children: [_jsx("select", { value: newKey.provider, onChange: (event) => setNewKey({ ...newKey, provider: event.target.value }), children: providerOptions() }), _jsx("input", { placeholder: "Label", value: newKey.label, onChange: (event) => setNewKey({ ...newKey, label: event.target.value }) }), _jsx("input", { type: "password", placeholder: "API key", value: newKey.value, onChange: (event) => setNewKey({ ...newKey, value: event.target.value }) }), _jsx("button", { onClick: () => void addKey().catch(showError), children: "Add key" })] })] }), _jsxs(AdminSection, { title: "Private guild access", description: "Private overrides billing plans and persists across Stripe subscription updates.", icon: _jsx(Shield, {}), children: [_jsxs("div", { className: "credential private-assign-form", children: [_jsx("input", { placeholder: "Discord guild ID", value: privateGuildId, onChange: (event) => setPrivateGuildId(event.target.value) }), _jsx("button", { onClick: () => void assignPrivateById().catch(showError), children: "Assign Private" })] }), !guilds.length && _jsx("p", { className: "hint", children: "No guilds are currently assigned to Private." }), guilds.map((guild) => _jsxs("div", { className: "row", children: [_jsxs("div", { children: [_jsx("strong", { children: guild.name }), _jsxs("small", { children: [guild.id, " \u00B7 base plan: ", guild.basePlanSlug ?? 'free'] })] }), _jsxs("div", { className: "row-actions", children: [_jsx("span", { className: "private-state active", children: "Private" }), _jsx("button", { className: "danger", onClick: () => void setPrivate(guild, false).catch(showError), children: "Remove Private" })] })] }, guild.id))] })] });
}
function AdminSection({ title, description, icon, children }) {
    return _jsxs("section", { children: [_jsxs("div", { className: "section-head", children: [_jsx("span", { children: icon }), _jsxs("div", { children: [_jsx("h2", { children: title }), _jsx("p", { children: description })] })] }), _jsx("div", { className: "section-body", children: children })] });
}
function AdminField({ label, children }) {
    return _jsxs("label", { className: "field", children: [_jsx("span", { children: label }), children] });
}
function providerLabel(provider) {
    return ({ groq: 'Groq shared pool', gemini_paid: 'Gemini Live paid pool', gemini_private: 'Gemini Live private pool', nvidia: 'NVIDIA NIM shared' })[provider];
}
function providerOptions() {
    return _jsxs(_Fragment, { children: [_jsx("option", { value: "groq", children: "Groq shared pool" }), _jsx("option", { value: "gemini_paid", children: "Gemini Live paid pool" }), _jsx("option", { value: "gemini_private", children: "Gemini Live private pool" }), _jsx("option", { value: "nvidia", children: "NVIDIA NIM shared" })] });
}
