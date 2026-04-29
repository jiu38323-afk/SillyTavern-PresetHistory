/**
 * SillyTavern-PresetHistory v2.1.0
 *
 * 预设版本历史扩展 —— 自动 + 手动备份预设，一键回退
 * 工作原理：拦截浏览器对 /api/settings/save 的请求，提取预设数据，
 * 按预设名分组保存为快照。基于内容 hash 去重。
 *
 * by Elvis & 小九
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXT_NAME = 'preset-history';
const SETTINGS_SAVE_ENDPOINT = '/api/settings/save';

const DEFAULTS = {
    enabled: true,
    autoSnapshot: true,
    maxSnapshotsPerPreset: 30,
    snapshots: {},
};

const PRESET_TYPE_MAP = [
    {
        type: 'openai',
        label: 'Chat Completion (OpenAI/Claude/Gemini)',
        dataFields: ['oai_settings', 'openai_settings'],
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

// ========== Settings ==========

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const s = extension_settings[EXT_NAME];
    for (const [key, val] of Object.entries(DEFAULTS)) {
        if (s[key] === undefined) {
            s[key] = (typeof val === 'object' && val !== null) ? JSON.parse(JSON.stringify(val)) : val;
        }
    }
    return s;
}

// ========== 工具 ==========

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h.toString(16);
}

function snapshotKey(type, name) { return type + '::' + name; }

function pickField(obj, candidates) {
    for (const f of candidates) {
        if (obj && obj[f] !== undefined) return obj[f];
    }
    return undefined;
}

function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function deepClone(obj) {
    try { return structuredClone(obj); }
    catch (e) { return JSON.parse(JSON.stringify(obj)); }
}

// ========== 快照核心 ==========

function extractAndSnapshot(body, source, customLabel) {
    const created = [];
    for (const cfg of PRESET_TYPE_MAP) {
        let data, name;
        if (cfg.powerUserField) {
            const pu = body.power_user;
            if (!pu) continue;
            data = pu[cfg.powerUserField];
            name = data ? (data.preset || data.name) : undefined;
        } else {
            data = pickField(body, cfg.dataFields);
            name = pickField(body, cfg.nameFields);
        }
        if (!data) continue;
        if (!name || typeof name !== 'string') name = '(unnamed)';

        let serialized;
        try { serialized = JSON.stringify(data); } catch (e) { continue; }
        const h = hash(serialized);

        const settings = getSettings();
        const key = snapshotKey(cfg.type, name);
        const existing = settings.snapshots[key] || [];

        if (source === 'auto' && existing.length > 0 && existing[0].hash === h) continue;

        const snap = {
            id: newId(),
            ts: Date.now(),
            label: customLabel || (source === 'auto' ? '自动备份' : '手动备份'),
            source: source,
            hash: h,
            data: deepClone(data),
        };
        settings.snapshots[key] = [snap].concat(existing).slice(0, settings.maxSnapshotsPerPreset);
        created.push({ type: cfg.type, name: name, snap: snap });
    }
    if (created.length > 0) {
        saveSettingsDebounced();
        console.log('[PresetHistory] 已保存 ' + created.length + ' 个快照');
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
    s.snapshots[k] = s.snapshots[k].filter(function (x) { return x.id !== id; });
    if (s.snapshots[k].length === 0) delete s.snapshots[k];
    saveSettingsDebounced();
}

function getAllPresetGroups() {
    const s = getSettings();
    const groups = {};
    for (const k of Object.keys(s.snapshots)) {
        if (s.snapshots[k].length === 0) continue;
        const parts = k.split('::');
        const type = parts[0];
        const name = parts.slice(1).join('::');
        if (!groups[type]) groups[type] = [];
        groups[type].push({ name: name, count: s.snapshots[k].length });
    }
    return groups;
}

// ========== Fetch 拦截器 ==========

let fetchPatched = false;
let originalFetch = null;

function installFetchInterceptor() {
    if (fetchPatched) return;
    originalFetch = window.fetch;
    window.fetch = async function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            if (method === 'POST' && url.indexOf(SETTINGS_SAVE_ENDPOINT) !== -1) {
                var settings = getSettings();
                if (settings.autoSnapshot) {
                    try {
                        var body = init && init.body;
                        if (typeof body === 'string') {
                            var parsed = JSON.parse(body);
                            extractAndSnapshot(parsed, 'auto', '');
                            setTimeout(renderSnapshotList, 0);
                        }
                    } catch (e) {
                        console.warn('[PresetHistory] Parse error:', e);
                    }
                }
            }
        } catch (e) {
            console.warn('[PresetHistory] Interceptor error:', e);
        }
        return originalFetch.apply(this, arguments);
    };
    fetchPatched = true;
    console.log('[PresetHistory] Fetch interceptor installed.');
}

// ========== 恢复 ==========

async function restoreSnapshot(type, name, snap) {
    const cfg = PRESET_TYPE_MAP.find(function (c) { return c.type === type; });
    if (!cfg) { toastr.error('未知的预设类型'); return false; }

    try {
        const current = fetchCurrentSettings();
        if (current) extractAndSnapshot(current, 'manual', '恢复前的备份: ' + snap.label);
    } catch (e) { console.warn('[PresetHistory] Pre-restore backup failed:', e); }

    try {
        const current = fetchCurrentSettings();
        if (!current || Object.keys(current).length === 0) {
            toastr.error('无法读取当前设置。');
            return false;
        }
        if (cfg.powerUserField) {
            if (!current.power_user) current.power_user = {};
            current.power_user[cfg.powerUserField] = deepClone(snap.data);
        } else {
            current[cfg.dataFields[0]] = deepClone(snap.data);
        }
        const fetchFn = originalFetch || window.fetch;
        const resp = await fetchFn.call(window, SETTINGS_SAVE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(current),
        });
        if (!resp.ok) {
            toastr.error('恢复失败: ' + resp.status);
            return false;
        }
        toastr.success('已恢复，正在刷新页面...');
        setTimeout(function () { location.reload(); }, 1500);
        return true;
    } catch (e) {
        toastr.error('恢复失败: ' + e.message);
        return false;
    }
}

function fetchCurrentSettings() {
    const obj = {};
    if (typeof window.oai_settings !== 'undefined') obj.oai_settings = window.oai_settings;
    if (typeof window.textgenerationwebui_settings !== 'undefined') obj.textgenerationwebui_settings = window.textgenerationwebui_settings;
    if (typeof window.kai_settings !== 'undefined') obj.kai_settings = window.kai_settings;
    if (typeof window.nai_settings !== 'undefined') obj.nai_settings = window.nai_settings;
    if (typeof window.power_user !== 'undefined') obj.power_user = window.power_user;
    return Object.keys(obj).length > 0 ? obj : null;
}

// ========== UI ==========

function addUI() {
    const html = '<div id="ph_settings">'
        + '<div class="inline-drawer">'
        + '<div class="inline-drawer-toggle inline-drawer-header">'
        + '<b>📸 预设历史版本</b>'
        + '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>'
        + '</div>'
        + '<div class="inline-drawer-content">'
        + '<label class="checkbox_label"><input id="ph_auto_snapshot" type="checkbox" /><span>保存时自动备份</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">每次保存预设或编辑条目时，自动备份一份当前版本。</small>'
        + '<div style="margin:6px 0"><label>每个预设最多保留 <input id="ph_max_snapshots" type="number" min="1" max="500" style="width:60px" /> 个版本</label>'
        + '<br/><small style="opacity:0.6">超出后自动删除最老的。</small></div>'
        + '<hr style="margin:8px 0" />'
        + '<div style="margin:6px 0"><input id="ph_manual_label" type="text" placeholder="可选备注，例如「调温度之前」..." style="width:100%;box-sizing:border-box;margin-bottom:6px" />'
        + '<button id="ph_manual_now" class="menu_button" style="font-size:12px;padding:4px 8px">📸 立即备份当前状态</button></div>'
        + '<hr style="margin:8px 0" />'
        + '<div style="margin:6px 0"><label style="display:block;margin-bottom:4px;font-weight:600">预设类型</label>'
        + '<select id="ph_filter_type" style="width:100%;box-sizing:border-box"></select></div>'
        + '<div style="margin:6px 0"><label style="display:block;margin-bottom:4px;font-weight:600">预设名称</label>'
        + '<select id="ph_filter_name" style="width:100%;box-sizing:border-box"></select></div>'
        + '<div id="ph_snapshot_list" style="max-height:400px;overflow-y:auto;border:1px solid rgba(128,128,128,0.3);border-radius:6px;padding:4px;margin-top:6px">'
        + '<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">还没有备份。</div></div>'
        + '</div></div></div>';

    var $target = jQuery('#extensions_settings2, #extensions_settings').first();
    if ($target.length) $target.append(html);
    else jQuery('#top-settings-holder').append(html);

    var s = getSettings();
    jQuery('#ph_auto_snapshot').prop('checked', s.autoSnapshot).on('change', function () {
        s.autoSnapshot = this.checked; saveSettingsDebounced();
        if (s.autoSnapshot) installFetchInterceptor();
    });
    jQuery('#ph_max_snapshots').val(s.maxSnapshotsPerPreset).on('change', function () {
        var v = parseInt(this.value, 10);
        if (!isNaN(v) && v > 0 && v <= 500) {
            s.maxSnapshotsPerPreset = v; saveSettingsDebounced();
            for (var k in s.snapshots) {
                if (s.snapshots[k].length > v) s.snapshots[k] = s.snapshots[k].slice(0, v);
            }
            renderSnapshotList();
        }
    });
    jQuery('#ph_manual_now').on('click', manualSnapshotNow);
    jQuery('#ph_filter_type').on('change', function () { renderNameFilter(); renderSnapshotList(); });
    jQuery('#ph_filter_name').on('change', renderSnapshotList);
    renderSnapshotList();
}

function renderTypeFilter() {
    var $sel = jQuery('#ph_filter_type');
    var groups = getAllPresetGroups();
    var cur = $sel.val();
    $sel.empty();
    var types = Object.keys(groups);
    if (types.length === 0) { $sel.append('<option value="">(还没有备份)</option>'); return; }
    for (var i = 0; i < types.length; i++) {
        var t = types[i];
        var cfg = PRESET_TYPE_MAP.find(function (c) { return c.type === t; });
        var label = cfg ? cfg.label : t;
        $sel.append('<option value="' + t + '">' + label + ' (' + groups[t].length + ')</option>');
    }
    if (cur && types.indexOf(cur) !== -1) $sel.val(cur);
}

function renderNameFilter() {
    var $sel = jQuery('#ph_filter_name');
    var type = jQuery('#ph_filter_type').val();
    var groups = getAllPresetGroups();
    var list = type ? (groups[type] || []) : [];
    var cur = $sel.val();
    $sel.empty();
    if (list.length === 0) { $sel.append('<option value="">(无预设)</option>'); return; }
    for (var i = 0; i < list.length; i++) {
        $sel.append('<option value="' + list[i].name + '">' + list[i].name + ' — ' + list[i].count + ' 个备份</option>');
    }
    if (cur && list.find(function (x) { return x.name === cur; })) $sel.val(cur);
}

function renderSnapshotList() {
    var $list = jQuery('#ph_snapshot_list');
    if ($list.length === 0) return;
    renderTypeFilter();
    renderNameFilter();
    var type = jQuery('#ph_filter_type').val();
    var name = jQuery('#ph_filter_name').val();
    $list.empty();
    if (!type || !name) {
        $list.html('<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">请选择预设类型和名称。</div>');
        return;
    }
    var snaps = getSnapshots(type, name);
    if (snaps.length === 0) {
        $list.html('<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">这个预设还没有备份。</div>');
        return;
    }
    for (var i = 0; i < snaps.length; i++) {
        (function (snap) {
            var $item = jQuery(
                '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,0.2);gap:6px">'
                + '<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">'
                + '<span style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHTML(snap.label) + '</span>'
                + '<span style="font-size:0.75em;opacity:0.6;font-family:monospace">' + fmtTime(snap.ts) + '</span></div>'
                + '<div style="display:flex;gap:4px;flex-shrink:0">'
                + '<button class="ph-restore menu_button" title="恢复" style="font-size:12px;padding:3px 6px">⏪</button>'
                + '<button class="ph-export menu_button" title="导出" style="font-size:12px;padding:3px 6px">📤</button>'
                + '<button class="ph-delete menu_button" title="删除" style="font-size:12px;padding:3px 6px">🗑️</button>'
                + '</div></div>'
            );
            $item.find('.ph-restore').on('click', async function () {
                if (!confirm('要把「' + name + '」恢复到这个版本吗？\n' + snap.label + '\n' + fmtTime(snap.ts) + '\n\n当前预设会被覆盖，页面会自动刷新。')) return;
                await restoreSnapshot(type, name, snap);
            });
            $item.find('.ph-export').on('click', function () {
                var blob = new Blob([JSON.stringify(snap.data, null, 2)], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = name + '_' + fmtTime(snap.ts).replace(/[.: ]/g, '-') + '.json';
                a.click();
                URL.revokeObjectURL(url);
                toastr.success('已导出。');
            });
            $item.find('.ph-delete').on('click', function () {
                if (!confirm('删除这个备份？\n' + snap.label)) return;
                deleteSnap(type, name, snap.id);
                renderSnapshotList();
                toastr.info('已删除。');
            });
            $list.append($item);
        })(snaps[i]);
    }
    $list.append('<div style="padding:4px 8px;text-align:center;font-size:0.8em;opacity:0.5;border-top:1px solid rgba(128,128,128,0.2);margin-top:2px">' + snaps.length + ' / 最多 ' + getSettings().maxSnapshotsPerPreset + ' 个</div>');
}

function manualSnapshotNow() {
    var customLabel = jQuery('#ph_manual_label').val().trim();
    var current = fetchCurrentSettings();
    if (!current) { toastr.error('读不到当前预设数据，请稍后再试。'); return; }
    var created = extractAndSnapshot(current, 'manual', customLabel || '手动备份');
    if (created.length === 0) { toastr.warning('没有检测到可备份的预设数据。'); return; }
    toastr.success('已保存 ' + created.length + ' 个备份。');
    jQuery('#ph_manual_label').val('');
    renderSnapshotList();
}

// ========== 初始化 ==========

jQuery(async function () {
    getSettings();
    addUI();
    if (getSettings().autoSnapshot) installFetchInterceptor();
    console.log('[PresetHistory] v2.1.0 已加载');
});
