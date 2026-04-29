/**
 * SillyTavern-PresetHistory v2.2.0
 *
 * 预设版本历史扩展 —— 自动 + 手动备份预设，一键回退
 * 拦截 /api/settings/save 请求，提取预设数据，按名字保存快照。
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
    autoSavePreset: false,
    lockParams: false,    // 锁定参数（温度、top_p等）
    lockPrompts: false,   // 锁定条目（内容、顺序、开关）
    maxSnapshotsPerPreset: 30,
    snapshots: {},
};

// ========== Settings ==========

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    var s = extension_settings[EXT_NAME];
    for (var key in DEFAULTS) {
        if (s[key] === undefined) {
            var val = DEFAULTS[key];
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
    var d = new Date(ts);
    function pad(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h.toString(16);
}

function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function deepClone(obj) {
    try { return structuredClone(obj); }
    catch (e) { return JSON.parse(JSON.stringify(obj)); }
}

// ========== 从请求体里提取预设 ==========

// 缓存最后一次拦截到的完整请求体（给手动备份用）
var lastInterceptedBody = null;

/**
 * 从 settings save 的请求体里找到预设名和预设数据。
 * ST 保存 settings 时会把所有东西一起发过去，
 * 我们只关心聊天补全(Chat Completion)相关的部分。
 *
 * 会尝试多个可能的字段名来兼容不同版本。
 */
function extractPresetInfo(body) {
    if (!body || typeof body !== 'object') return null;

    // ---- 尝试找预设名 ----
    var nameFields = [
        'preset_settings_openai',   // 一些版本用这个
        'openai_setting',           // 另一些版本
    ];
    var presetName = null;
    for (var i = 0; i < nameFields.length; i++) {
        if (body[nameFields[i]] && typeof body[nameFields[i]] === 'string') {
            presetName = body[nameFields[i]];
            break;
        }
    }

    // ---- 尝试找预设数据 ----
    // 方案A：body里有独立的 oai_settings / openai_settings 对象
    var dataFields = ['oai_settings', 'openai_settings'];
    var presetData = null;
    for (var j = 0; j < dataFields.length; j++) {
        if (body[dataFields[j]] && typeof body[dataFields[j]] === 'object' && Object.keys(body[dataFields[j]]).length > 0) {
            presetData = body[dataFields[j]];
            break;
        }
    }

    // 方案B：如果没有独立的对象，说明预设字段直接铺在 body 顶层
    // 用特征字段检测是不是预设数据，确认后保存全部字段
    if (!presetData) {
        var checkFields = ['temp_openai', 'top_p_openai', 'freq_pen_openai',
            'openai_max_context', 'stream_openai', 'prompts', 'prompt_order'];
        var found = 0;
        for (var k = 0; k < checkFields.length; k++) {
            if (body[checkFields[k]] !== undefined) found++;
        }
        // 至少找到5个特征字段 → 确认是预设数据 → 保存body全部字段
        if (found >= 5) {
            presetData = body;
        }
    }

    // 如果还是没有，也试试 prompt_manager_settings, prompts, prompt_order
    // 因为这些是预设的核心（条目列表和顺序）
    if (!presetData && body.prompts && body.prompt_order) {
        presetData = {
            prompts: body.prompts,
            prompt_order: body.prompt_order,
        };
        if (body.prompt_manager_settings) presetData.prompt_manager_settings = body.prompt_manager_settings;
    }

    if (!presetData) return null;

    // 如果没从请求体找到名字，从页面上的预设下拉菜单读
    if (!presetName) {
        var presetSelectors = ['#settings_perset_openai', '#settings_preset_openai', 'select[name="preset_openai"]'];
        for (var s = 0; s < presetSelectors.length; s++) {
            var $ps = jQuery(presetSelectors[s]);
            if ($ps.length) {
                var selectedText = $ps.find('option:selected').text().trim();
                if (selectedText) {
                    presetName = selectedText;
                    break;
                }
            }
        }
    }

    if (!presetName) presetName = '当前预设';

    return { name: presetName, data: presetData };
}

// ========== 快照核心 ==========

function saveSnapshot(presetName, data, source, customLabel) {
    // 用白名单提取用户关心的字段来做hash，排除每次保存都可能变的元数据
    var hashFields = [
        'prompts', 'prompt_order',
        'temp_openai', 'top_p_openai', 'top_k_openai', 'min_p_openai', 'top_a_openai',
        'freq_pen_openai', 'pres_pen_openai', 'repetition_penalty_openai',
        'openai_max_context', 'openai_max_tokens', 'stream_openai',
        'main_prompt', 'jailbreak_prompt', 'nsfw_prompt',
        'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt',
        'send_if_empty', 'wrap_in_quotes',
        'chat_completion_source', 'openai_model', 'claude_model',
    ];
    var coreData = {};
    for (var fi = 0; fi < hashFields.length; fi++) {
        if (data[hashFields[fi]] !== undefined) coreData[hashFields[fi]] = data[hashFields[fi]];
    }

    var coreStr;
    try { coreStr = JSON.stringify(coreData); } catch (e) { return null; }
    var h = hash(coreStr);

    // 如果白名单全空，用完整数据
    if (Object.keys(coreData).length === 0) {
        try { h = hash(JSON.stringify(data)); } catch (e) { return null; }
    }

    var settings = getSettings();
    var key = presetName;
    var existing = settings.snapshots[key] || [];

    if (source === 'auto') {
        if (existing.length === 0) {
            // 没备份过 → 存第一份作为基线
            console.log('[PresetHistory] 首次备份: ' + presetName);
        } else if (existing[0].hash === h) {
            // 有备份，内容一样 → 跳过
            return null;
        } else if (restoredToHash && restoredToHash === h) {
            // 刚恢复到这个版本，跳过（不重复存恢复后的状态）
            console.log('[PresetHistory] 恢复后的保存，跳过');
            restoredToHash = '';
            return null;
        } else {
            // 有备份，内容不同 → 存新版本
            console.log('[PresetHistory] 内容变化，备份: ' + presetName);
        }
    }

    var snap = {
        id: newId(),
        ts: Date.now(),
        label: customLabel || (source === 'auto' ? '自动备份' : '手动备份'),
        hash: h,
        data: deepClone(data),
    };
    settings.snapshots[key] = [snap].concat(existing).slice(0, settings.maxSnapshotsPerPreset);
    saveSettingsDebounced();
    return snap;
}

function getSnapshots(presetName) {
    return getSettings().snapshots[presetName] || [];
}

function deleteSnap(presetName, id) {
    var s = getSettings();
    if (!s.snapshots[presetName]) return;
    s.snapshots[presetName] = s.snapshots[presetName].filter(function (x) { return x.id !== id; });
    if (s.snapshots[presetName].length === 0) delete s.snapshots[presetName];
    saveSettingsDebounced();
}

function getAllPresetNames() {
    var s = getSettings();
    var names = [];
    for (var k in s.snapshots) {
        if (s.snapshots[k].length > 0) names.push({ name: k, count: s.snapshots[k].length });
    }
    return names;
}

// ========== Fetch 拦截器 ==========

var fetchPatched = false;
var originalFetch = null;
var isRestoring = false;
var restoredToHash = ''; // 刚恢复到的版本的hash，用于跳过恢复后的重复备份

function installFetchInterceptor() {
    if (fetchPatched) return;
    originalFetch = window.fetch;
    window.fetch = async function (input, init) {
        // 不在恢复中才做快照
        if (!isRestoring) {
            try {
                var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

                if (method === 'POST' && (url.indexOf('/api/settings/save') !== -1 || url.indexOf('/api/presets/save') !== -1)) {
                var settings = getSettings();
                // 恢复抑制期内跳过自动备份
                if (settings.autoSnapshot) {
                    try {
                        var body = init && init.body;
                        if (typeof body === 'string') {
                            var parsed = JSON.parse(body);
                            lastInterceptedBody = parsed; // 缓存给手动备份用
                            var info = extractPresetInfo(parsed);
                            if (info) {
                                // 自动生成标签：对比上一个备份找出改了什么
                                var autoLabel = '';
                                var existingSnaps = getSnapshots(info.name);
                                if (existingSnaps.length > 0) {
                                    var diffs = diffPresets(existingSnaps[0].data, info.data, 'changelog');
                                    // 过滤掉"没有检测到差异"
                                    var realDiffs = diffs.filter(function (d) { return d !== '没有检测到差异'; });
                                    if (realDiffs.length > 0) {
                                        autoLabel = realDiffs.slice(0, 3).join('；');
                                    } else {
                                        autoLabel = '自动备份';
                                    }
                                } else {
                                    autoLabel = '首次备份';
                                }
                                var snap = saveSnapshot(info.name, info.data, 'auto', autoLabel);
                                if (snap) {
                                    console.log('[PresetHistory] 自动备份: ' + info.name);
                                    setTimeout(renderSnapshotList, 0);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[PresetHistory] Parse error:', e);
                    }
                }
            }
        } catch (e) {
            console.warn('[PresetHistory] Interceptor error:', e);
        }
        } // end if (!isRestoring)
        return originalFetch.apply(this, arguments);
    };
    fetchPatched = true;
    console.log('[PresetHistory] 拦截器已安装');
}

// ========== 对比 ==========

/**
 * 对比两组预设数据的差异
 * oldData = 旧版本, newData = 新版本
 * mode = 'changelog'(自动标签用) 或 'restore'(恢复确认用)
 */
function diffPresets(oldData, newData, mode) {
    if (!mode) mode = 'restore';
    var diffs = [];

    var oldPrompts = (oldData && oldData.prompts) || [];
    var newPrompts = (newData && newData.prompts) || [];

    // 条目内容索引 (identifier → prompt对象)
    var oldContentMap = {};
    for (var i = 0; i < oldPrompts.length; i++) {
        oldContentMap[oldPrompts[i].identifier] = oldPrompts[i];
    }
    var newContentMap = {};
    for (var j = 0; j < newPrompts.length; j++) {
        newContentMap[newPrompts[j].identifier] = newPrompts[j];
    }

    // 从 prompt_order 里提取开关状态和顺序
    // prompt_order 结构: [ { character_id, order: [{identifier, enabled}, ...] } ]
    var oldOrder = [];
    var newOrder = [];
    var oldEnabledMap = {};
    var newEnabledMap = {};

    var oldPO = (oldData && oldData.prompt_order) || [];
    var newPO = (newData && newData.prompt_order) || [];
    if (oldPO.length > 0 && oldPO[0] && oldPO[0].order) {
        oldOrder = oldPO[0].order;
        for (var oi = 0; oi < oldOrder.length; oi++) {
            oldEnabledMap[oldOrder[oi].identifier] = !!oldOrder[oi].enabled;
        }
    }
    if (newPO.length > 0 && newPO[0] && newPO[0].order) {
        newOrder = newPO[0].order;
        for (var ni = 0; ni < newOrder.length; ni++) {
            newEnabledMap[newOrder[ni].identifier] = !!newOrder[ni].enabled;
        }
    }

    // 用来查名字的辅助函数
    function getName(id) {
        if (newContentMap[id]) return newContentMap[id].name || '未命名';
        if (oldContentMap[id]) return oldContentMap[id].name || '未命名';
        return '未命名';
    }

    // 新增的条目：区分"创建"和"绑定"
    // prompts里新增但order里没有 = 创建了条目（还没绑定）
    for (var pk in newContentMap) {
        if (!oldContentMap[pk] && !newEnabledMap[pk]) {
            if (mode === 'changelog') {
                diffs.push('创建了条目「' + getName(pk) + '」');
            } else {
                diffs.push('「' + getName(pk) + '」会被创建');
            }
        }
    }

    // order里新增 = 绑定到预设
    for (var nk in newEnabledMap) {
        if (oldEnabledMap[nk] === undefined) {
            var isAlsoNewInPrompts = !oldContentMap[nk];
            if (mode === 'changelog') {
                diffs.push((isAlsoNewInPrompts ? '新增了' : '绑定了') + '「' + getName(nk) + '」');
            } else {
                diffs.push('「' + getName(nk) + '」' + (isAlsoNewInPrompts ? '会被新增' : '会被绑定'));
            }
        }
    }

    // 删除的条目：区分"从预设移除"和"彻底删除"
    for (var ok in oldEnabledMap) {
        if (newEnabledMap[ok] === undefined) {
            var stillInPrompts = !!newContentMap[ok];
            if (mode === 'changelog') {
                diffs.push((stillInPrompts ? '从预设移除了' : '删除了') + '「' + getName(ok) + '」');
            } else {
                diffs.push('恢复后会找回「' + getName(ok) + '」');
            }
        }
    }

    // 开关变化
    for (var ek in oldEnabledMap) {
        if (newEnabledMap[ek] !== undefined && oldEnabledMap[ek] !== newEnabledMap[ek]) {
            if (mode === 'changelog') {
                diffs.push((newEnabledMap[ek] ? '开启' : '关闭') + '了「' + getName(ek) + '」');
            } else {
                diffs.push('「' + getName(ek) + '」' + (newEnabledMap[ek] ? '会被开启' : '会被关闭'));
            }
        }
    }

    // 内容修改（比较prompts数组里的content和name）
    for (var mk in oldContentMap) {
        if (newContentMap[mk]) {
            var op = oldContentMap[mk];
            var np = newContentMap[mk];
            var changes = [];
            if ((op.content || '') !== (np.content || '')) changes.push('内容');
            if ((op.name || '') !== (np.name || '')) changes.push('名称');
            if (changes.length > 0) {
                if (mode === 'changelog') {
                    diffs.push('修改了「' + (np.name || '未命名') + '」' + changes.join('、'));
                } else {
                    diffs.push('「' + (op.name || '未命名') + '」' + changes.join('、') + '不同');
                }
            }
        }
    }

    // 顺序变化
    var oldIds = oldOrder.map(function (x) { return x.identifier; }).join(',');
    var newIds = newOrder.map(function (x) { return x.identifier; }).join(',');
    if (oldIds !== newIds && oldOrder.length > 0 && newOrder.length > 0) {
        // 排除纯增删导致的顺序差异，只看共有条目的相对顺序
        var commonOld = oldOrder.filter(function (x) { return newEnabledMap[x.identifier] !== undefined; }).map(function (x) { return x.identifier; });
        var commonNew = newOrder.filter(function (x) { return oldEnabledMap[x.identifier] !== undefined; }).map(function (x) { return x.identifier; });
        if (commonOld.join(',') !== commonNew.join(',')) {
            diffs.push('条目顺序变化');
        }
    }

    // 参数变化
    var settingFields = ['temp_openai', 'top_p_openai', 'freq_pen_openai', 'pres_pen_openai',
        'openai_max_context', 'openai_max_tokens', 'min_p_openai', 'top_k_openai'];
    var settingChanges = [];
    for (var sf = 0; sf < settingFields.length; sf++) {
        var field = settingFields[sf];
        if (oldData[field] !== undefined && newData[field] !== undefined && oldData[field] !== newData[field]) {
            settingChanges.push(field.replace(/_openai$/, '').replace(/_/g, ' '));
        }
    }
    if (settingChanges.length > 0) {
        diffs.push('参数变化: ' + settingChanges.join(', '));
    }

    if (diffs.length === 0) {
        diffs.push('没有检测到差异');
    }

    return diffs;
}

// ========== 恢复 ==========

// 从 session cookie 里提取 CSRF 令牌
// ST 把 CSRF token 存在 session cookie 里，格式是 base64 编码的 JSON: {"csrfToken":"xxx"}
function getCsrfToken() {
    try {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i].trim();
            // session cookie 的名字是 session-xxxxxxxx=base64data
            if (c.match(/^session-[a-f0-9]+=/) && !c.includes('.sig')) {
                var val = c.split('=').slice(1).join('=');
                var decoded = atob(val);
                var obj = JSON.parse(decoded);
                if (obj.csrfToken) return obj.csrfToken;
            }
        }
    } catch (e) {
        console.warn('[PresetHistory] Failed to extract CSRF token:', e);
    }
    return '';
}

async function restoreSnapshot(presetName, snap) {
    try {
        // 先备份当前的
        if (lastInterceptedBody) {
            var currentInfo = extractPresetInfo(lastInterceptedBody);
            if (currentInfo) {
                saveSnapshot(currentInfo.name, currentInfo.data, 'manual', '已恢复至版本：' + snap.label);
            }
        }

        var bodyToSend = deepClone(snap.data);

        // 通过ST自带的预设导入功能恢复（绕过CSRF问题）
        // 把快照数据包装成File对象，塞进ST的导入文件输入框
        var jsonStr = JSON.stringify(bodyToSend, null, 2);
        var file = new File([jsonStr], presetName + '.json', { type: 'application/json' });

        var $fileInput = jQuery('#openai_preset_import_file');
        if ($fileInput.length === 0) {
            toastr.error('找不到预设导入入口，请手动导入。');
            return false;
        }

        // 创建一个新的FileList塞进去
        var dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        $fileInput[0].files = dataTransfer.files;

        // 记录恢复目标的hash，恢复后的自动保存如果匹配就跳过
        restoredToHash = snap.hash || '';

        // 触发change事件，让ST的导入逻辑接管
        $fileInput[0].dispatchEvent(new Event('input', { bubbles: true }));

        toastr.success('正在通过导入恢复「' + presetName + '」...\n请在弹出的对话框中确认。');
        return true;
    } catch (e) {
        toastr.error('恢复失败: ' + e.message);
        return false;
    }
}

// ========== 锁定功能 ==========

var lockStyleAdded = false;

function applyLocks() {
    var s = getSettings();

    // 添加锁定样式（只加一次）
    if (!lockStyleAdded) {
        var style = document.createElement('style');
        style.id = 'ph-lock-styles';
        style.textContent = ''
            + '.ph-locked-params #range_block_openai { pointer-events: none; opacity: 0.5; position: relative; }'
            + '.ph-locked-params #range_block_openai::after { content: "🔒 参数已锁定"; position: absolute; top: 4px; right: 8px; font-size: 12px; opacity: 0.8; }'
            + '.ph-locked-prompts #completion_prompt_manager { pointer-events: none; opacity: 0.5; position: relative; }'
            + '.ph-locked-prompts #completion_prompt_manager::after { content: "🔒 条目已锁定"; position: absolute; top: 4px; right: 8px; font-size: 12px; opacity: 0.8; }'
            + '.ph-locked-prompts .completion_prompt_manager_popup { pointer-events: none; opacity: 0.5; }'
            + '.ph-locked-prompts .prompt-manager-prompt-controls { pointer-events: none; }'
            + '.ph-locked-prompts .prompt_manager_prompt_toggle { pointer-events: none; }'
            + '.ph-locked-prompts .ui-sortable-handle { cursor: default !important; }'
            ;
        document.head.appendChild(style);
        lockStyleAdded = true;
    }

    var $body = jQuery('body');

    if (s.lockParams) {
        $body.addClass('ph-locked-params');
    } else {
        $body.removeClass('ph-locked-params');
    }

    if (s.lockPrompts) {
        $body.addClass('ph-locked-prompts');
    } else {
        $body.removeClass('ph-locked-prompts');
    }
}

// ========== 自动保存预设 ==========

var autoSaveInstalled = false;
var autoSaveTimer = null;

function triggerPresetSave() {
    // 防抖2秒，避免连续操作触发多次保存
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
        var s = getSettings();
        if (!s.autoSavePreset) return;
        var $btn = jQuery('#update_oai_preset');
        if ($btn.length) {
            // 静默保存：临时屏蔽toastr提示
            var origSuccess = toastr.success;
            toastr.success = function () {};
            $btn.trigger('click');
            setTimeout(function () { toastr.success = origSuccess; }, 500);
            console.log('[PresetHistory] 静默自动保存预设');
        }
    }, 2000);
}

function installAutoSave() {
    if (autoSaveInstalled) return;

    // 1. 条目保存按钮：保存条目后自动保存预设
    jQuery('#completion_prompt_manager_popup_entry_form_save').on('click.presetHistory', triggerPresetSave);

    // 2. 参数滑块/输入框变化：温度、top_p等
    var paramSelectors = [
        '#temp_openai', '#top_p_openai', '#top_k_openai', '#min_p_openai',
        '#freq_pen_openai', '#pres_pen_openai', '#repetition_penalty_openai',
        '#openai_max_context', '#openai_max_tokens'
    ];
    for (var i = 0; i < paramSelectors.length; i++) {
        jQuery(paramSelectors[i]).on('change.presetHistory', triggerPresetSave);
    }

    // 3. 条目开关变化
    jQuery(document).on('click.presetHistory', '.prompt_manager_prompt_toggle, .prompt-toggle, [data-pm-toggle]', triggerPresetSave);

    // 4. 条目拖拽排序完成
    jQuery(document).on('sortupdate.presetHistory', triggerPresetSave);

    autoSaveInstalled = true;
    console.log('[PresetHistory] 自动保存已安装');
}

// ========== UI ==========

function addUI() {
    var html = '<div id="ph_settings">'
        + '<div class="inline-drawer">'
        + '<div class="inline-drawer-toggle inline-drawer-header">'
        + '<b>📸 预设历史版本</b>'
        + '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>'
        + '</div>'
        + '<div class="inline-drawer-content">'

        + '<label class="checkbox_label"><input id="ph_auto_snapshot" type="checkbox" /><span>保存时自动备份</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">每次保存预设或编辑条目时，自动备份一份。</small>'

        + '<label class="checkbox_label"><input id="ph_auto_save_preset" type="checkbox" /><span>操作后自动保存预设</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">编辑条目后自动保存预设到文件，防止切换预设时丢失修改。默认关闭。</small>'

        + '<hr style="margin:8px 0" />'

        + '<label class="checkbox_label"><input id="ph_lock_params" type="checkbox" /><span>🔒 锁定参数</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:4px">锁住温度、Top P、频率惩罚等滑块，防止误触。</small>'

        + '<label class="checkbox_label"><input id="ph_lock_prompts" type="checkbox" /><span>🔒 锁定条目</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">锁住条目的内容编辑、开关和顺序拖拽。</small>'

        + '<div style="margin:6px 0"><label>每个预设最多保留 <input id="ph_max_snapshots" type="number" min="1" max="500" style="width:60px" /> 个版本</label>'
        + '<br/><small style="opacity:0.6">超出后自动删除最老的。</small></div>'

        + '<hr style="margin:8px 0" />'

        + '<div style="margin:6px 0">'
        + '<input id="ph_manual_label" type="text" placeholder="可选备注，例如「调温度之前」..." style="width:100%;box-sizing:border-box;margin-bottom:6px" />'
        + '<button id="ph_manual_now" class="menu_button" style="font-size:12px;padding:6px 12px;width:100%;white-space:nowrap;writing-mode:horizontal-tb">📸 立即备份当前状态</button>'
        + '<br/><small style="opacity:0.6">需要先保存过一次预设才能用。</small>'
        + '</div>'

        + '<hr style="margin:8px 0" />'

        + '<div style="margin:6px 0"><label style="display:block;margin-bottom:4px;font-weight:600">选择预设</label>'
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

    // 操作后自动保存预设
    jQuery('#ph_auto_save_preset').prop('checked', s.autoSavePreset).on('change', function () {
        s.autoSavePreset = this.checked; saveSettingsDebounced();
        if (s.autoSavePreset) installAutoSave();
    });
    if (s.autoSavePreset) installAutoSave();

    // 锁定参数
    jQuery('#ph_lock_params').prop('checked', s.lockParams).on('change', function () {
        s.lockParams = this.checked; saveSettingsDebounced();
        applyLocks();
    });

    // 锁定条目
    jQuery('#ph_lock_prompts').prop('checked', s.lockPrompts).on('change', function () {
        s.lockPrompts = this.checked; saveSettingsDebounced();
        applyLocks();
    });

    applyLocks();
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
    jQuery('#ph_filter_name').on('change', renderSnapshotList);

    // 监听ST的预设下拉菜单变化，自动跟着切换
    var presetSelectors = ['#settings_perset_openai', '#settings_preset_openai'];
    for (var pi = 0; pi < presetSelectors.length; pi++) {
        var $ps = jQuery(presetSelectors[pi]);
        if ($ps.length) {
            $ps.on('change', function () {
                // 重置选择，让renderNameFilter自动选中新的当前预设
                jQuery('#ph_filter_name').val('');
                renderSnapshotList();
            });
            break;
        }
    }

    renderSnapshotList();
}

function renderNameFilter() {
    var $sel = jQuery('#ph_filter_name');
    var cur = $sel.val();
    $sel.empty();

    // 从ST页面上的预设下拉菜单读取所有预设名字 + 当前选中的预设
    var allPresets = [];
    var currentSTPreset = '';
    var presetSelectors = ['#settings_perset_openai', '#settings_preset_openai', 'select[name="preset_openai"]'];
    for (var si = 0; si < presetSelectors.length; si++) {
        var $stSelect = jQuery(presetSelectors[si]);
        if ($stSelect.length) {
            currentSTPreset = $stSelect.find('option:selected').text().trim();
            $stSelect.find('option').each(function () {
                var val = jQuery(this).val();
                var text = jQuery(this).text().trim();
                if (val && text) allPresets.push(text);
            });
            break;
        }
    }

    // 获取有备份的预设
    var backedUp = getAllPresetNames();
    var backupMap = {};
    for (var i = 0; i < backedUp.length; i++) {
        backupMap[backedUp[i].name] = backedUp[i].count;
    }

    // 合并：当前预设排第一，有备份的排前面，没备份的排后面
    var seen = {};
    var options = [];

    // 当前预设排第一
    if (currentSTPreset) {
        var count = backupMap[currentSTPreset] || 0;
        options.push({ name: currentSTPreset, count: count, current: true });
        seen[currentSTPreset] = true;
    }

    // 有备份的排前面
    for (var b = 0; b < backedUp.length; b++) {
        var bName = backedUp[b].name;
        if (!seen[bName]) {
            options.push({ name: bName, count: backedUp[b].count, current: false });
            seen[bName] = true;
        }
    }

    // 没备份的排后面
    for (var a = 0; a < allPresets.length; a++) {
        if (!seen[allPresets[a]]) {
            options.push({ name: allPresets[a], count: 0, current: false });
            seen[allPresets[a]] = true;
        }
    }

    if (options.length === 0) {
        $sel.append('<option value="">(还没有预设)</option>');
        return;
    }

    for (var j = 0; j < options.length; j++) {
        var displayName = escapeHTML(options[j].name);
        var prefix = options[j].current ? '▶ ' : '';
        var suffix = options[j].count > 0 ? ' — ' + options[j].count + ' 个备份' : ' — 未备份';
        $sel.append('<option value="' + displayName + '">' + prefix + displayName + suffix + '</option>');
    }

    // 优先选当前ST预设，否则保持用户之前的选择
    if (currentSTPreset && !cur) {
        $sel.val(escapeHTML(currentSTPreset));
    } else if (cur && options.find(function (x) { return x.name === cur; })) {
        $sel.val(cur);
    } else if (currentSTPreset) {
        $sel.val(escapeHTML(currentSTPreset));
    }
}

function renderSnapshotList() {
    var $list = jQuery('#ph_snapshot_list');
    if ($list.length === 0) return;
    renderNameFilter();

    var name = jQuery('#ph_filter_name').val();
    $list.empty();

    if (!name) {
        $list.html('<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">还没有备份。保存一次预设后会自动出现。</div>');
        return;
    }

    var snaps = getSnapshots(name);
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
                // 对比当前和备份的差异
                var diffText = '';
                if (lastInterceptedBody) {
                    var currentInfo = extractPresetInfo(lastInterceptedBody);
                    if (currentInfo) {
                        var diffs = diffPresets(currentInfo.data, snap.data, 'restore');
                        diffText = '\n\n【当前 vs 备份的区别】\n' + diffs.join('\n');
                    }
                }
                if (!confirm('要把「' + name + '」恢复到这个版本吗？\n' + snap.label + '\n' + fmtTime(snap.ts) + diffText + '\n\n当前预设会被覆盖，页面会自动刷新。')) return;
                await restoreSnapshot(name, snap);
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
                deleteSnap(name, snap.id);
                renderSnapshotList();
                toastr.info('已删除。');
            });
            $list.append($item);
        })(snaps[i]);
    }
    $list.append('<div style="padding:4px 8px;text-align:center;font-size:0.8em;opacity:0.5;border-top:1px solid rgba(128,128,128,0.2);margin-top:2px">' + snaps.length + ' / 最多 ' + getSettings().maxSnapshotsPerPreset + ' 个</div>');
}

function manualSnapshotNow() {
    if (!lastInterceptedBody) {
        toastr.warning('还没有拦截到数据。请先随便改一下预设并保存，让扩展捕获一次数据。');
        return;
    }
    var customLabel = jQuery('#ph_manual_label').val().trim();
    var info = extractPresetInfo(lastInterceptedBody);
    if (!info) {
        toastr.error('无法从缓存数据中提取预设信息。');
        return;
    }
    var snap = saveSnapshot(info.name, info.data, 'manual', customLabel || '手动备份');
    if (snap) {
        toastr.success('已备份：' + info.name);
    } else {
        toastr.info('内容没有变化，跳过。');
    }
    jQuery('#ph_manual_label').val('');
    renderSnapshotList();
}

// ========== 初始化 ==========

jQuery(async function () {
    getSettings();

    // 清理旧版本(v2.1)残留的带 :: 前缀的数据
    var s = getSettings();
    var keysToDelete = [];
    for (var k in s.snapshots) {
        if (k.indexOf('::') !== -1) keysToDelete.push(k);
    }
    if (keysToDelete.length > 0) {
        for (var d = 0; d < keysToDelete.length; d++) {
            delete s.snapshots[keysToDelete[d]];
        }
        saveSettingsDebounced();
        console.log('[PresetHistory] 已清理 ' + keysToDelete.length + ' 个旧版本残留数据');
    }

    addUI();
    if (getSettings().autoSnapshot) installFetchInterceptor();
    console.log('[PresetHistory] v2.2.0 已加载');
    toastr.success('预设历史版本 v2.2.0 已加载', '📸');
});
