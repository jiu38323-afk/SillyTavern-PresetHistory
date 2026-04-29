/**
 * SillyTavern-PresetHistory v2.0.0
 *
 * 预设版本历史扩展 —— 自动 + 手动备份预设，一键回退
 * 工作原理：拦截浏览器对 /api/settings/save 的请求，从请求体中提取每种预设的当前数据，
 * 按预设名分组保存为快照。基于内容 hash 去重，避免重复存储。
 *
 * by Elvis & 小九
 */

const MODULE_NAME = 'preset-history';
const SETTINGS_SAVE_ENDPOINT = '/api/settings/save';

// ─── 默认配置 ──────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    enabled: true,
    autoSnapshot: true,
    maxSnapshotsPerPreset: 30,
    snapshots: {}, // { "presetType::presetName": [ {id, ts, label, hash, data} ] }
};

// 预设类型映射：从 settings.json 字段名 → 我们内部的类型 key 和显示名
// 这是基于 ST 1.13~1.17 的 settings 结构推测的字段
// 如果 ST 改了字段名，我们多试几个候选
const PRESET_TYPE_MAP = [
    {
        type: 'openai',
        label: 'Chat Completion (OpenAI/Claude/Gemini)',
        // 数据字段（候选）
        dataFields: ['oai_settings', 'openai_settings'],
        // 当前预设名字段（候选）
        nameFields: ['preset_settings_openai', 'openai_setting'],
    },
    {
        type: 'textgenerationwebui',
        label: 'Text Completion',
        dataFields: ['textgenerationwebui_settings', 'textgen_settings'],
        nameFields: ['preset_settings_textgenerationwebui', 'textgenerationwebui_preset'],
    },
    {
        type: 'kobold',
        label: 'KoboldAI',
        dataFields: ['kai_settings'],
        nameFields: ['preset_settings_kobold', 'kai_preset'],
    },
    {
        type: 'novel',
        label: 'NovelAI',
        dataFields: ['nai_settings'],
        nameFields: ['preset_settings_novel', 'nai_preset'],
    },
    // 模板类预设（在 power_user 下）
    {
        type: 'context',
        label: 'Context Template',
        dataFields: [],
        nameFields: [],
        powerUserField: 'context',
    },
    {
        type: 'instruct',
        label: 'Instruct Template',
        dataFields: [],
        nameFields: [],
        powerUserField: 'instruct',
    },
    {
        type: 'sysprompt',
        label: 'System Prompt',
        dataFields: [],
        nameFields: [],
        powerUserField: 'sysprompt',
    },
];

// ─── ST Context 访问 ──────────────────────────────────────
function getST() {
    return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : {};
}

function getSettings() {
    const ctx = getST();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    // 合并新字段（在升级版本时不丢老配置）
    const s = ctx.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = structuredClone(DEFAULT_SETTINGS[key]);
    }
    return s;
}

function persist() {
    const ctx = getST();
    ctx.saveSettingsDebounced?.();
}

// ─── 工具 ──────────────────────────────────────────────────
function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 简单字符串 hash（FNV-1a 变体），用于去重
function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h.toString(16);
}

function snapshotKey(type, name) {
    return `${type}::${name}`;
}

function pickField(obj, candidates) {
    for (const f of candidates) {
        if (obj && obj[f] !== undefined) return obj[f];
    }
    return undefined;
}

// ─── 快照核心逻辑 ──────────────────────────────────────────

/**
 * 从 request body 中提取所有可识别的预设数据，并尝试存快照
 * @param {object} body 解析后的 request body
 * @param {string} source 'auto' | 'manual'
 * @param {string} customLabel 用户自定义标签（仅 manual）
 * @returns {Array} 本次创建的快照列表
 */
function extractAndSnapshot(body, source = 'auto', customLabel = '') {
    const created = [];

    for (const cfg of PRESET_TYPE_MAP) {
        let data, name;

        if (cfg.powerUserField) {
            // power_user 下的子字段
            const pu = body.power_user;
            if (!pu) continue;
            data = pu[cfg.powerUserField];
            name = data?.preset || data?.name;
        } else {
            data = pickField(body, cfg.dataFields);
            name = pickField(body, cfg.nameFields);
        }

        if (!data) continue;
        if (!name || typeof name !== 'string') name = '(unnamed)';

        // 计算 hash 做去重
        let serialized;
        try {
            serialized = JSON.stringify(data);
        } catch (e) {
            console.warn(`[PresetHistory] Failed to serialize ${cfg.type}::${name}:`, e);
            continue;
        }
        const h = hash(serialized);

        // 去重：跟最新快照比对
        const settings = getSettings();
        const key = snapshotKey(cfg.type, name);
        const existing = settings.snapshots[key] || [];
        if (existing.length > 0 && existing[0].hash === h) {
            // 内容一致，跳过（仅 auto 模式跳过；manual 不跳过，用户主动想存的就存）
            if (source === 'auto') continue;
        }

        const snap = {
            id: newId(),
            ts: Date.now(),
            label: customLabel || (source === 'auto' ? 'Auto' : 'Manual'),
            source: source,
            hash: h,
            data: structuredClone(data),
        };

        settings.snapshots[key] = [snap, ...existing].slice(0, settings.maxSnapshotsPerPreset);
        created.push({ type: cfg.type, name, snap });
    }

    if (created.length > 0) {
        persist();
        console.log(`[PresetHistory] Saved ${created.length} snapshot(s):`,
            created.map(c => `${c.type}::${c.name}`).join(', '));
    }
    return created;
}

function getSnapshots(type, name) {
    return getSettings().snapshots[snapshotKey(type, name)] || [];
}

function deleteSnap(type, name, id) {
    const s = getSettings();
    const k = snapshotKey(type, name);
    if (!s.snapshots[k]) return;
    s.snapshots[k] = s.snapshots[k].filter(x => x.id !== id);
    if (s.snapshots[k].length === 0) delete s.snapshots[k];
    persist();
}

function getAllPresetGroups() {
    const s = getSettings();
    const groups = {};
    for (const k of Object.keys(s.snapshots)) {
        if (s.snapshots[k].length === 0) continue;
        const [type, ...rest] = k.split('::');
        const name = rest.join('::');
        if (!groups[type]) groups[type] = [];
        groups[type].push({ name, count: s.snapshots[k].length });
    }
    return groups;
}

// ─── Fetch 拦截器 ─────────────────────────────────────────
let fetchPatched = false;
let originalFetch = null;

function installFetchInterceptor() {
    if (fetchPatched) return;

    originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input?.url || '');
            const method = (init?.method || (input?.method) || 'GET').toUpperCase();

            // 关心的只有 POST /api/settings/save
            if (method === 'POST' && url.includes(SETTINGS_SAVE_ENDPOINT)) {
                const settings = getSettings();
                if (settings.autoSnapshot) {
                    try {
                        let body = init?.body;
                        if (typeof body === 'string') {
                            const parsed = JSON.parse(body);
                            extractAndSnapshot(parsed, 'auto');
                            // 异步刷新 UI（不阻塞请求）
                            setTimeout(() => renderSnapshotList(), 0);
                        }
                    } catch (e) {
                        console.warn('[PresetHistory] Failed to parse settings save body:', e);
                    }
                }
            }
        } catch (e) {
            console.warn('[PresetHistory] Interceptor error (non-fatal):', e);
        }

        return originalFetch.apply(this, arguments);
    };

    fetchPatched = true;
    console.log('[PresetHistory] Fetch interceptor installed.');
}

function uninstallFetchInterceptor() {
    if (!fetchPatched) return;
    window.fetch = originalFetch;
    originalFetch = null;
    fetchPatched = false;
    console.log('[PresetHistory] Fetch interceptor removed.');
}

// ─── 恢复（写回） ─────────────────────────────────────────

/**
 * 把快照数据写回 ST。
 * 策略：直接修改 ST 全局 settings 对象的对应字段，然后触发保存。
 * 这种方式避开了直接调用 ST 内部 API 的兼容性问题。
 */
async function restoreSnapshot(type, name, snap) {
    const ctx = getST();
    if (!ctx) {
        toastr.error('SillyTavern context not available.');
        return false;
    }

    // 找到对应的字段配置
    const cfg = PRESET_TYPE_MAP.find(c => c.type === type);
    if (!cfg) {
        toastr.error(`Unknown preset type: ${type}`);
        return false;
    }

    // 备份当前状态（恢复也是一次"修改"，先存一份当前的）
    try {
        const currentSettingsRaw = await fetchCurrentSettings();
        if (currentSettingsRaw) {
            extractAndSnapshot(currentSettingsRaw, 'manual', `Before restore: ${snap.label}`);
        }
    } catch (e) {
        console.warn('[PresetHistory] Pre-restore backup failed:', e);
    }

    // 用快照数据覆盖当前 settings 的对应字段，然后回写
    try {
        const current = await fetchCurrentSettings();
        if (!current) {
            toastr.error('Could not read current settings.');
            return false;
        }

        if (cfg.powerUserField) {
            if (!current.power_user) current.power_user = {};
            current.power_user[cfg.powerUserField] = structuredClone(snap.data);
        } else {
            // 写到第一个候选字段
            const targetField = cfg.dataFields[0];
            current[targetField] = structuredClone(snap.data);
        }

        // 调用 settings/save 写回
        const resp = await originalFetch.call(window, SETTINGS_SAVE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(current),
        });

        if (!resp.ok) {
            toastr.error(`Restore failed: ${resp.status} ${resp.statusText}`);
            return false;
        }

        toastr.success(`Restored "${name}" to: ${snap.label}\nReloading page...`);
        setTimeout(() => location.reload(), 1500);
        return true;
    } catch (e) {
        console.error('[PresetHistory] Restore error:', e);
        toastr.error('Restore failed: ' + e.message);
        return false;
    }
}

async function fetchCurrentSettings() {
    // ST 没有公开的 GET /api/settings 端点，但可以通过 ctx 获取
    // 退而求其次：从 ST 全局变量收集
    const ctx = getST();

    // 尝试方式1：ctx 直接提供
    if (ctx && typeof ctx === 'object') {
        // 构造一个 settings-like 的对象
        const synthesized = {};

        // OpenAI/Chat Completion
        if (ctx.chatCompletionSettings) synthesized.oai_settings = ctx.chatCompletionSettings;
        // 通过全局变量（不可靠但常见）
        if (typeof window.oai_settings !== 'undefined') synthesized.oai_settings = window.oai_settings;
        if (typeof window.textgenerationwebui_settings !== 'undefined') synthesized.textgenerationwebui_settings = window.textgenerationwebui_settings;
        if (typeof window.kai_settings !== 'undefined') synthesized.kai_settings = window.kai_settings;
        if (typeof window.nai_settings !== 'undefined') synthesized.nai_settings = window.nai_settings;
        if (typeof window.power_user !== 'undefined') synthesized.power_user = window.power_user;

        if (Object.keys(synthesized).length > 0) return synthesized;
    }

    // 实在拿不到就返回空
    console.warn('[PresetHistory] Could not synthesize current settings; restore may be partial.');
    return {};
}

// ─── UI ────────────────────────────────────────────────────

function buildSettingsHTML() {
    return `
    <div id="ph_settings" class="ph-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📸 Preset History</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="ph-row">
                    <label class="checkbox_label" for="ph_auto_snapshot">
                        <input type="checkbox" id="ph_auto_snapshot" />
                        <span>Auto-snapshot on save</span>
                    </label>
                    <small class="ph-hint">Automatically saves a snapshot every time SillyTavern saves your settings (which happens when you save a preset or edit an item).</small>
                </div>

                <div class="ph-row">
                    <label for="ph_max_snapshots">Max snapshots per preset</label>
                    <input id="ph_max_snapshots" type="number" min="1" max="500" class="text_pole" />
                    <small class="ph-hint">When exceeded, the oldest snapshot is automatically deleted.</small>
                </div>

                <hr />

                <div class="ph-row">
                    <button id="ph_manual_now" class="menu_button">
                        📸 Snapshot Current State Now
                    </button>
                    <small class="ph-hint">Reads your current preset state from SillyTavern and saves a snapshot immediately.</small>
                </div>

                <div class="ph-row">
                    <input id="ph_manual_label" type="text" class="text_pole" placeholder="Optional label, e.g. 'Before adjusting temperature'..." />
                </div>

                <hr />

                <h4>Snapshot History</h4>

                <div class="ph-row">
                    <label for="ph_filter_type">Preset Type</label>
                    <select id="ph_filter_type" class="text_pole"></select>
                </div>

                <div class="ph-row">
                    <label for="ph_filter_name">Preset Name</label>
                    <select id="ph_filter_name" class="text_pole"></select>
                </div>

                <div id="ph_snapshot_list" class="ph-snapshot-list">
                    <div class="ph-empty">No snapshots yet.</div>
                </div>

            </div>
        </div>
    </div>
    `;
}

function renderTypeFilter() {
    const $sel = $('#ph_filter_type');
    const groups = getAllPresetGroups();
    const currentVal = $sel.val();
    $sel.empty();

    const types = Object.keys(groups);
    if (types.length === 0) {
        $sel.append('<option value="">(no snapshots yet)</option>');
        return;
    }

    for (const t of types) {
        const cfg = PRESET_TYPE_MAP.find(c => c.type === t);
        const label = cfg ? cfg.label : t;
        $sel.append(`<option value="${t}">${label} (${groups[t].length})</option>`);
    }

    if (currentVal && types.includes(currentVal)) $sel.val(currentVal);
}

function renderNameFilter() {
    const $sel = $('#ph_filter_name');
    const type = $('#ph_filter_type').val();
    const groups = getAllPresetGroups();
    const list = type ? (groups[type] || []) : [];
    const currentVal = $sel.val();
    $sel.empty();

    if (list.length === 0) {
        $sel.append('<option value="">(no presets)</option>');
        return;
    }

    for (const item of list) {
        $sel.append(`<option value="${item.name}">${item.name} — ${item.count} snapshots</option>`);
    }

    if (currentVal && list.find(i => i.name === currentVal)) $sel.val(currentVal);
}

function renderSnapshotList() {
    const $list = $('#ph_snapshot_list');
    if ($list.length === 0) return; // UI 还没渲染

    renderTypeFilter();
    renderNameFilter();

    const type = $('#ph_filter_type').val();
    const name = $('#ph_filter_name').val();

    $list.empty();

    if (!type || !name) {
        $list.html('<div class="ph-empty">Select a preset type and name to view snapshots.</div>');
        return;
    }

    const snaps = getSnapshots(type, name);
    if (snaps.length === 0) {
        $list.html('<div class="ph-empty">No snapshots for this preset.</div>');
        return;
    }

    for (const snap of snaps) {
        const $item = $(`
            <div class="ph-snapshot-item" data-id="${snap.id}">
                <div class="ph-snapshot-info">
                    <span class="ph-snapshot-label">${escapeHTML(snap.label)}</span>
                    <span class="ph-snapshot-time">${fmtTime(snap.ts)}</span>
                </div>
                <div class="ph-snapshot-actions">
                    <button class="ph-btn ph-btn-restore menu_button" title="Restore">⏪</button>
                    <button class="ph-btn ph-btn-export menu_button" title="Export JSON">📤</button>
                    <button class="ph-btn ph-btn-delete menu_button" title="Delete">🗑️</button>
                </div>
            </div>
        `);

        $item.find('.ph-btn-restore').on('click', async () => {
            const ok = confirm(`Restore "${name}" to:\n${snap.label}\n${fmtTime(snap.ts)}\n\nThis will overwrite your current preset and reload the page.`);
            if (!ok) return;
            await restoreSnapshot(type, name, snap);
        });

        $item.find('.ph-btn-export').on('click', () => {
            const blob = new Blob([JSON.stringify(snap.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name}_${fmtTime(snap.ts).replace(/[.: ]/g, '-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toastr.success('Exported.');
        });

        $item.find('.ph-btn-delete').on('click', () => {
            if (!confirm(`Delete this snapshot?\n${snap.label}`)) return;
            deleteSnap(type, name, snap.id);
            renderSnapshotList();
            toastr.info('Deleted.');
        });

        $list.append($item);
    }

    $list.append(`<div class="ph-stats">${snaps.length} of max ${getSettings().maxSnapshotsPerPreset}</div>`);
}

function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

async function manualSnapshotNow() {
    const customLabel = $('#ph_manual_label').val().trim();
    const current = await fetchCurrentSettings();
    if (!current || Object.keys(current).length === 0) {
        toastr.error('Could not read your current preset state.');
        return;
    }
    const created = extractAndSnapshot(current, 'manual', customLabel || 'Manual snapshot');
    if (created.length === 0) {
        toastr.warning('No preset data detected to snapshot.');
        return;
    }
    toastr.success(`Saved ${created.length} snapshot(s).`);
    $('#ph_manual_label').val('');
    renderSnapshotList();
}

function bindUI() {
    const settings = getSettings();

    $('#ph_auto_snapshot')
        .prop('checked', settings.autoSnapshot)
        .on('change', function () {
            settings.autoSnapshot = $(this).prop('checked');
            persist();
            if (settings.autoSnapshot) installFetchInterceptor();
            else uninstallFetchInterceptor();
        });

    $('#ph_max_snapshots')
        .val(settings.maxSnapshotsPerPreset)
        .on('change', function () {
            const v = parseInt($(this).val(), 10);
            if (!isNaN(v) && v > 0 && v <= 500) {
                settings.maxSnapshotsPerPreset = v;
                persist();
                // 应用新限制（裁剪超出的）
                for (const k of Object.keys(settings.snapshots)) {
                    if (settings.snapshots[k].length > v) {
                        settings.snapshots[k] = settings.snapshots[k].slice(0, v);
                    }
                }
                renderSnapshotList();
            }
        });

    $('#ph_manual_now').on('click', manualSnapshotNow);

    $('#ph_filter_type').on('change', () => {
        renderNameFilter();
        renderSnapshotList();
    });

    $('#ph_filter_name').on('change', renderSnapshotList);
}

// ─── 初始化 ───────────────────────────────────────────────
jQuery(async () => {
    console.log('[PresetHistory] Loading v2.0.0...');

    // 渲染 UI
    $('#extensions_settings2').append(buildSettingsHTML());
    bindUI();

    // 安装拦截器
    if (getSettings().autoSnapshot) installFetchInterceptor();

    // 初次渲染列表
    renderSnapshotList();

    console.log('[PresetHistory] Ready.');
});
