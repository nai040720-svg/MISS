// Miss总结插件 - SillyTavern Extension
import {
    extension_settings,
    getContext,
    saveSettingsDebounced,
} from '../../../extensions.js';
import {
    saveMetadataDebounced,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

const MODULE = 'missSummary';

const $ = window.jQuery;

const log = (...args) => console.log('[MissSummary]', ...args);

function defaultSettings() {
    return {
        tag: '',
        boundPreset: '',
        tokenThreshold: 0,
        floorThreshold: 0,
        keepVisibleFloors: 0,
        summaryPrompt: '请将以下聊天内容浓缩为一段简洁的第三人称记忆摘要，保留关键事件、人物关系与重要约定：\n\n',
        autoSummarize: true,
        savedPresets: {},
        savedActive: '',
    };
}

function s() {
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = defaultSettings();
    }
    for (const key of Object.keys(defaultSettings())) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = defaultSettings()[key];
        }
    }
    return extension_settings[MODULE];
}

let lastTokenCount = 0;
let busy = false;
const recordsOpen = new Set();
let editingId = null;

jQuery(() => {
    init().catch(err => {
        console.error('[MissSummary] init failed', err);
        // 加载失败自动重试（应对 ST 各版本模块加载时序差异）
        setTimeout(() => init().catch(e => console.error('[MissSummary] retry failed', e)), 1500);
    });
});

async function init() {
    const ctx = getContext();
    if (!ctx) {
        return;
    }
    s();
    buildDrawer();
    addMenuButton();
    bindUi();
    await refreshPresets();
    renderAll();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_SENT, onMessageChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGeneration);
    eventSource.on(event_types.SETTINGS_UPDATED, refreshPresets);

    log('loaded, version 0.1.0');
}

// ---------------- UI 构建 ----------------

function buildDrawer() {
    if (document.getElementById('missSummarySettings')) {
        return;
    }    const html = `
    <div id="missSummarySettings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Miss总结插件</b>
                <span id="miss-status-dot" class="miss-dot"></span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="miss-nav">
                    <button class="miss-nav-btn active" data-tab="setup"><i class="fa-solid fa-sliders"></i> 初始设置</button>
                    <button class="miss-nav-btn" data-tab="memory"><i class="fa-solid fa-brain"></i> 记忆总结</button>
                </div>

                <div class="miss-panel active" id="miss-panel-setup">
                    <div class="miss-field">
                        <label for="miss-tag-input"><i class="fa-solid fa-tags"></i> 摘要标签</label>
                        <div class="miss-inline-row">
                            <input id="miss-tag-input" class="miss-input" type="text" placeholder="例如：summary，插件将抓取 &lt;summary&gt;...&lt;/summary&gt; 内容">
                            <button id="miss-extract-btn" class="miss-btn" title="立即抓取"><i class="fa-solid fa-download"></i></button>
                        </div>
                        <div class="miss-hint">填写标签后，插件会自动抓取聊天气泡中被该标签包裹的内容。</div>
                    </div>

                    <div class="miss-field">
                        <label for="miss-preset-select"><i class="fa-solid fa-link"></i> 绑定预设</label>
                        <select id="miss-preset-select" class="miss-input">
                            <option value="">不绑定（默认）</option>
                        </select>
                        <div class="miss-hint">选择一个预设，总结时将临时使用该预设生成，完成后自动恢复原预设。</div>
                    </div>

                    <div class="miss-field">
                        <label><i class="fa-solid fa-floppy-disk"></i> 保存初始设置</label>
                        <div class="miss-inline-row">
                            <input id="miss-save-name" class="miss-input" type="text" placeholder="为本次设置起一个名字">
                            <button id="miss-save-btn" class="miss-btn primary"><i class="fa-solid fa-check"></i> 保存</button>
                        </div>
                        <div class="miss-inline-row" style="margin-top:6px;">
                            <select id="miss-saved-select" class="miss-input"></select>
                            <button id="miss-saved-delete" class="miss-btn" title="删除所选"><i class="fa-solid fa-trash"></i></button>
                        </div>
                        <div class="miss-hint">保存多个配置后，可在此选择栏切换，插件会立即跳转到对应设置。</div>
                    </div>
                </div>

                <div class="miss-panel" id="miss-panel-memory">
                    <div class="miss-field">
                        <label><i class="fa-solid fa-scroll"></i> 记录</label>
                        <div class="miss-records-scroll">
                            <div id="miss-records-list"></div>
                        </div>
                    </div>

                    <div class="miss-field">
                        <label><i class="fa-solid fa-gauge-high"></i> 总结设置</label>
                        <div class="miss-token-box">
                            <div class="miss-token-label">当前总 Token（预设 + 聊天记录 + 提示词）</div>
                            <div class="miss-token-value"><span id="miss-token-display">0</span></div>
                        </div>
                        <div class="miss-grid">
                            <div>
                                <label for="miss-token-threshold">Token 总结</label>
                                <input id="miss-token-threshold" class="miss-input" type="number" min="0" placeholder="0=关闭">
                            </div>
                            <div>
                                <label for="miss-floor-threshold">楼层总结</label>
                                <input id="miss-floor-threshold" class="miss-input" type="number" min="0" placeholder="0=关闭">
                            </div>
                            <div>
                                <label for="miss-keep-floors">隐藏楼层</label>
                                <input id="miss-keep-floors" class="miss-input" type="number" min="0" placeholder="0=关闭">
                            </div>
                        </div>
                        <label for="miss-summary-prompt" style="margin-top:8px;">总结提示词</label>
                        <textarea id="miss-summary-prompt" class="miss-input" rows="3"></textarea>
                        <label class="miss-check"><input id="miss-auto-chk" type="checkbox"> 自动总结（达到阈值时触发）</label>
                        <div class="miss-inline-row" style="margin-top:6px;">
                            <button id="miss-summarize-btn" class="miss-btn primary" style="flex:1;"><i class="fa-solid fa-wand-magic-sparkles"></i> 立即总结</button>
                        </div>
                        <div class="miss-hint">总结针对当前打开的角色卡聊天记录，更换角色后 Token 数与记录会实时更新。隐藏楼层：仅保留最近 N 楼发给 AI，更早的楼层自动隐藏，只注入摘要内容。</div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (host) {
        host.insertAdjacentHTML('afterbegin', html);
    }
    $drawer = $('#missSummarySettings');
}

function addMenuButton(attempt = 0) {
    if (document.getElementById('miss-menu-item')) {
        return;
    }
    // 魔法棒菜单 = #extensionsMenu（聊天框左侧 wand 图标弹出的扩展菜单）
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        if (attempt < 20) {
            setTimeout(() => addMenuButton(attempt + 1), 500);
        } else {
            console.error('[MissSummary] extensionsMenu not found after retries');
        }
        return;
    }
    menu.insertAdjacentHTML('afterbegin', `
        <div id="miss-menu-item" class="list-group-item flex-container flexGap5 interactable" title="Miss总结插件">
            <div class="fa-fw fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span>Miss总结</span>
        </div>`);
    $('#miss-menu-item').on('click', openPanel);
    log('menu button injected into extensionsMenu (wand)');
}

function openPanel() {
    // 关闭魔法棒菜单
    $('#extensionsMenuPopout').parent().removeClass('openDrawer');
    $('.drawer-toggle .fa-wand-magic-sparkles, #leftNavDrawerIcon .fa-wand-magic-sparkles')
        .closest('.drawer-toggle').removeClass('openIcon');

    const block = document.getElementById('missSummarySettings');
    if (!block) {
        toast('插件面板未就绪，请稍候重试');
        return;
    }
    // 打开扩展抽屉
    const drawerContent = block.closest('.drawer-content');
    const drawer = drawerContent ? drawerContent.closest('.drawer') : null;
    if (drawer && !drawer.classList.contains('openDrawer')) {
        const toggle = drawer.querySelector('.drawer-toggle');
        if (toggle) {
            toggle.click();
        }
    }
    setTimeout(() => {
        block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 350);
}

// ---------------- 数据 ----------------

function getStore() {
    const ctx = getContext();
    if (!ctx.chatMetadata) {
        ctx.chatMetadata = {};
    }
    if (!ctx.chatMetadata[MODULE]) {
        ctx.chatMetadata[MODULE] = { summaries: [], lastMessageId: -1 };
    }
    const st = ctx.chatMetadata[MODULE];
    if (!Array.isArray(st.summaries)) {
        st.summaries = [];
    }
    return st;
}

function extractRecords() {
    const ctx = getContext();
    const tag = String(s().tag || '').trim();
    if (!tag || !Array.isArray(ctx.chat)) {
        return [];
    }
    const re = new RegExp(`<${escapeReg(tag)}>([\\s\\S]*?)</${escapeReg(tag)}>`, 'g');
    const records = [];
    ctx.chat.forEach((m, idx) => {
        if (!m || typeof m.mes !== 'string') {
            return;
        }
        re.lastIndex = 0;
        const parts = [];
        let mm;
        while ((mm = re.exec(m.mes)) !== null) {
            parts.push(mm[1].trim());
        }
        if (!parts.length) {
            return;
        }
        const content = parts.join('\n');
        const title = (content.split('\n')[0] || '').trim().slice(0, 24) || `楼层 ${idx + 1}`;
        records.push({ id: `m${idx}`, type: 'extract', title, content, floor: idx + 1, msgId: idx });
    });
    return records;
}

function allRecords() {
    const store = getStore();
    const summaryRecords = store.summaries.map((it, i) => ({
        id: `s${i}`,
        type: 'summary',
        title: it.title,
        content: it.content,
        entry: it,
        floor: (typeof it.upTo === 'number' ? it.upTo : -1) + 1,
    }));
    return [...extractRecords(), ...summaryRecords];
}

let _stModule = null;
async function getSTModule() {
    if (_stModule) {
        return _stModule;
    }
    try {
        _stModule = await import('../../../../script.js');
        return _stModule;
    } catch (e) {
        log('script.js dynamic import failed', e);
        return null;
    }
}

// ---------------- 渲染 ----------------

function renderAll() {
    const st = s();
    $('#miss-tag-input', $drawer).val(st.tag);
    $('#miss-preset-select', $drawer).val(st.boundPreset);
    $('#miss-token-threshold', $drawer).val(st.tokenThreshold || '');
    $('#miss-floor-threshold', $drawer).val(st.floorThreshold || '');
    $('#miss-keep-floors', $drawer).val(st.keepVisibleFloors || '');
    $('#miss-summary-prompt', $drawer).val(st.summaryPrompt || '');
    $('#miss-auto-chk', $drawer).prop('checked', !!st.autoSummarize);
    renderSavedSelect();
    renderRecords();
    updateTokens();
}

function renderSavedSelect() {
    const st = s();
    const names = Object.keys(st.savedPresets || {});
    const $sel = $('#miss-saved-select', $drawer);
    $sel.empty().append('<option value="">— 选择已保存的设置 —</option>');
    for (const name of names) {
        $sel.append($('<option></option>').val(name).text(name));
    }
    $sel.val(st.savedActive && names.includes(st.savedActive) ? st.savedActive : '');
}

function renderRecords() {
    const $list = $('#miss-records-list', $drawer);
    if (!$list.length) {
        return;
    }
    const recs = allRecords();
    if (!recs.length) {
        $list.html('<div class="miss-hint" style="padding:8px 4px;">暂无记录 — 在「初始设置」填写摘要标签后点击抓取，或等待自动总结。</div>');
        return;
    }
    const html = recs.map(r => {
        const open = recordsOpen.has(r.id) ? ' open' : '';
        const badge = r.type === 'summary' ? 'AI摘要' : `楼层 ${r.floor}`;
        const isEditing = editingId === r.id;
        const body = isEditing
            ? `<textarea class="miss-input" data-role="edit-text" rows="6">${escapeHtml(r.content)}</textarea>
               <div class="miss-record-editbar">
                   <button class="miss-btn" data-act="cancel-edit">取消</button>
                   <button class="miss-btn primary" data-act="save-edit"><i class="fa-solid fa-check"></i> 保存修改</button>
               </div>`
            : `<div class="miss-record-content">${escapeHtml(r.content).replace(/\n/g, '<br>')}</div>
               <div class="miss-record-editbar">
                   <button class="miss-btn" data-act="start-edit"><i class="fa-solid fa-pen"></i> 编辑模式</button>
               </div>`;
        return `<div class="miss-record${open}" data-id="${r.id}">
            <div class="miss-record-header">
                <span class="miss-record-title">${escapeHtml(r.title)}</span>
                <span class="miss-record-badge">${badge}</span>
            </div>
            <div class="miss-record-body">${body}</div>
        </div>`;
    }).join('');
    $list.html(html);
}

async function updateTokens() {
    const ctx = getContext();
    let text = '';
    try {
        // 预设提示词 token：从脚本上下文防御性获取，避免版本差异
        const mod = await getSTModule();
        const oai = mod?.oai_settings;
        if (oai?.prompts) {
            text += JSON.stringify(oai.prompts) + '\n';
        }
    } catch { /* ignore */ }
    try {
        text += (ctx.chat || [])
            .map(m => `${m?.is_user ? '用户' : '角色'}: ${m?.mes || ''}`)
            .join('\n') + '\n';
        text += getStore().summaries.map(x => x.content).join('\n');
    } catch { /* ignore */ }

    let n = null;
    if (typeof ctx.getTokenCountAsync === 'function') {
        try { n = await ctx.getTokenCountAsync(text); } catch { /* ignore */ }
    }
    if (n == null && typeof ctx.getTokenCount === 'function') {
        try { n = ctx.getTokenCount(text); } catch { /* ignore */ }
    }
    if (n == null) {
        n = Math.ceil(text.length / 2.2);
    }
    lastTokenCount = Number(n) || 0;
    $('#miss-token-display', $drawer).text(String(lastTokenCount));
    return lastTokenCount;
}

function refreshPresets() {
    const $sel = $('#miss-preset-select', $drawer);
    if (!$sel.length) {
        return;
    }
    const presets = collectPresets();
    const current = s().boundPreset;
    $sel.empty().append('<option value="">不绑定（默认）</option>');
    for (const p of presets) {
        $sel.append($('<option></option>').val(p.value).text(p.text));
    }
    $sel.val(current || '');
}

function collectPresets() {
    const out = [];
    const seen = new Set();
    // ST 版本差异：预设下拉可能在主设置或弹窗中，遍历所有已知选择器
    const selectors = '#settings_preset_openai, #settings_preset, [id^="settings_preset_openai"]';
    $(selectors).each(function () {
        $(this).find('option').each(function () {
            const value = String($(this).val() || '').trim();
            const text = String($(this).text() || '').trim();
            if (value && !seen.has(value)) {
                seen.add(value);
                out.push({ value, text: text || value });
            }
        });
    });
    // 兜底：通过文件系统预设列表（openai 预设目录）
    if (!out.length) {
        try {
            const ctx = getContext();
            const names = ctx.getChatCompletionPresets?.() || [];
            for (const n of names) {
                const name = typeof n === 'string' ? n : n?.name;
                if (name && !seen.has(name)) {
                    seen.add(name);
                    out.push({ value: name, text: name });
                }
            }
        } catch { /* ignore */ }
    }
    return out;
}

async function applyPreset(name) {
    if (!name) {
        return false;
    }
    const ctx = getContext();
    try {
        for (const type of ['openai', 'textcompletion', 'kobold', 'novel']) {
            const pm = ctx.getPresetManager?.(type);
            if (pm && typeof pm.selectPresetByName === 'function') {
                const names = (pm.getAllPresets?.() || [])
                    .map(p => (typeof p === 'string' ? p : p?.name))
                    .filter(Boolean);
                if (names.includes(name)) {
                    await pm.selectPresetByName(name);
                    return true;
                }
            }
        }
    } catch (e) {
        log('preset manager switch failed', e);
    }
    for (const selector of ['#settings_preset_openai', '#settings_preset']) {
        const $sel = $(selector);
        if (!$sel.length) {
            continue;
        }
        const opt = $sel.find('option').toArray()
            .find(o => String(o.value) === name || String(o.text) === name);
        if (opt) {
            $sel.val(opt.value).trigger('change');
            return true;
        }
    }
    // 兜底：直接设置 API 预设名并保存
    try {
        const ctx = getContext();
        const mod = await getSTModule();
        if (mod?.oai_settings && typeof mod?.saveSettingsDebounced === 'function') {
            mod.oai_settings.preset_settings_openai = name;
            mod.saveSettingsDebounced();
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

function currentPresetName() {
    for (const selector of ['#settings_preset_openai', '#settings_preset']) {
        const $sel = $(selector);
        if ($sel.length && $sel.val()) {
            return String($sel.find('option:selected').text() || $sel.val());
        }
    }
    // 兜底：预设管理器
    try {
        const ctx = getContext();
        const pm = ctx.getPresetManager?.('openai');
        const name = pm?.getSelectedPresetName?.() || pm?.selected?.name;
        if (name) {
            return String(name);
        }
    } catch { /* ignore */ }
    return null;
}

// ---------------- 事件 ----------------

function bindUi() {
    $drawer.on('click', '.miss-nav-btn', function () {
        const tab = $(this).data('tab');
        $('.miss-nav-btn', $drawer).removeClass('active');
        $(this).addClass('active');
        $('.miss-panel', $drawer).removeClass('active');
        $(`#miss-panel-${tab}`, $drawer).addClass('active');
    });

    $('#miss-tag-input', $drawer).on('change', function () {
        s().tag = String($(this).val() || '').trim();
        saveSettingsDebounced();
        recordsOpen.clear();
        editingId = null;
        renderRecords();
    });

    $('#miss-extract-btn', $drawer).on('click', () => {
        recordsOpen.clear();
        editingId = null;
        renderRecords();
        const n = extractRecords().length;
        toast(n ? `✅ 已抓取 ${n} 条「${s().tag}」摘要` : '未抓取到匹配的摘要内容');
    });

    $('#miss-preset-select', $drawer).on('change', function () {
        s().boundPreset = String($(this).val() || '');
        saveSettingsDebounced();
        toast(s().boundPreset ? `已绑定预设：${s().boundPreset}` : '已取消预设绑定');
    });

    $('#miss-save-btn', $drawer).on('click', async () => {
        const name = await openSaveModal();
        if (!name) {
            return;
        }
        saveSnapshot(name);
    });

    $('#miss-saved-select', $drawer).on('change', function () {
        const name = String($(this).val() || '');
        if (name) {
            applySnapshot(name);
        }
    });

    $('#miss-saved-delete', $drawer).on('click', () => {
        const st = s();
        const name = st.savedActive;
        if (!name || !st.savedPresets[name]) {
            toast('请先选择一个已保存的设置');
            return;
        }
        delete st.savedPresets[name];
        st.savedActive = '';
        saveSettingsDebounced();
        renderSavedSelect();
        toast(`已删除「${name}」`);
    });

    $('#miss-token-threshold', $drawer).on('change', function () {
        s().tokenThreshold = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });
    $('#miss-floor-threshold', $drawer).on('change', function () {
        s().floorThreshold = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });
    $('#miss-keep-floors', $drawer).on('change', function () {
        s().keepVisibleFloors = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });
    $('#miss-summary-prompt', $drawer).on('change', function () {
        s().summaryPrompt = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#miss-auto-chk', $drawer).on('change', function () {
        s().autoSummarize = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#miss-summarize-btn', $drawer).on('click', () => runSummary(true));

    $('#miss-records-list', $drawer).on('click', '.miss-record-header', function () {
        const id = $(this).closest('.miss-record').data('id');
        const $rec = $(this).closest('.miss-record');
        if (recordsOpen.has(id)) {
            recordsOpen.delete(id);
            $rec.removeClass('open');
        } else {
            recordsOpen.add(id);
            $rec.addClass('open');
        }
    });

    $('#miss-records-list', $drawer).on('click', '[data-act]', function (e) {
        e.stopPropagation();
        const act = $(this).data('act');
        const $rec = $(this).closest('.miss-record');
        const id = $rec.data('id');
        const rec = allRecords().find(r => r.id === id);
        if (!rec) {
            return;
        }
        if (act === 'start-edit') {
            editingId = id;
            $rec.addClass('open');
            recordsOpen.add(id);
            renderRecords();
            $('#miss-records-list [data-role="edit-text"]').trigger('focus');
        } else if (act === 'cancel-edit') {
            editingId = null;
            renderRecords();
        } else if (act === 'save-edit') {
            const newText = String($rec.find('[data-role="edit-text"]').val() || '').trim();
            if (!newText) {
                toast('内容不能为空');
                return;
            }
            saveEdit(rec, newText);
        }
    });
}

function onChatChanged() {
    recordsOpen.clear();
    editingId = null;
    try {
        setExtensionPrompt(MODULE, '', extension_prompt_types.NONE, 0);
    } catch { /* ignore */ }
    renderAll();
}

const debouncedAuto = debounce(() => {
    updateTokens().then(checkAuto).catch(e => log(e));
}, 1200);

function onMessageChanged() {
    debouncedAuto();
}

function onGeneration() {
    const keep = Number(s().keepVisibleFloors) || 0;
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];

    if (keep > 0 && chat.length > keep) {
        let changed = false;
        const from = chat.length - keep;
        for (let i = 0; i < from; i++) {
            const m = chat[i];
            if (m && !m.is_system) {
                m.is_system = true;
                changed = true;
            }
        }
        if (changed) {
            log(`隐藏楼层：已隐藏前 ${from} 楼，仅保留最近 ${keep} 楼`);
        }
    }

    try {
        const texts = getStore().summaries.map(x => x.content).filter(Boolean);
        if (texts.length) {
            const injection = '[以下是更早剧情的记忆摘要]\n' + texts.join('\n---\n');
            setExtensionPrompt(MODULE, injection, extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
        } else {
            setExtensionPrompt(MODULE, '', extension_prompt_types.NONE, 0);
        }
    } catch (e) {
        log('inject failed', e);
    }
}

// ---------------- 总结 ----------------

async function checkAuto() {
    const st = s();
    if (!st.autoSummarize || busy) {
        return;
    }
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const store = getStore();
    const lastId = typeof store.lastMessageId === 'number' ? store.lastMessageId : -1;
    const newCount = chat.length - 1 - lastId;

    let trigger = false;
    if (st.floorThreshold > 0 && newCount >= st.floorThreshold) {
        trigger = true;
    }
    if (st.tokenThreshold > 0 && lastTokenCount >= st.tokenThreshold) {
        trigger = true;
    }
    if (trigger) {
        await runSummary(false);
    }
}

async function runSummary(manual) {
    if (busy) {
        if (manual) {
            toast('正在总结中，请稍候…');
        }
        return;
    }
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (!chat.length) {
        if (manual) {
            toast('当前没有可总结的聊天记录');
        }
        return;
    }

    busy = true;
    setBusy(true);
    const prevPreset = currentPresetName();
    try {
        const st = s();
        const store = getStore();
        const lastId = typeof store.lastMessageId === 'number' ? store.lastMessageId : -1;
        const msgs = chat.slice(lastId + 1).filter(m => m && !m.is_system && typeof m.mes === 'string');

        if (!msgs.length) {
            if (manual) {
                toast('没有新的楼层需要总结');
            }
            return;
        }

        const chatText = msgs
            .map(m => `${m.is_user ? '用户' : '角色'}: ${m.mes}`)
            .join('\n');
        const prompt = String(st.summaryPrompt || '') + chatText;

        if (st.boundPreset) {
            const ok = await applyPreset(st.boundPreset);
            if (!ok) {
                toast(`⚠️ 未找到预设「${st.boundPreset}」，使用当前预设总结`);
            }
        }

        let out;
        try {
            out = await ctx.generateQuietPrompt({ quietPrompt: prompt });
        } catch (e) {
            log('object-arg generateQuietPrompt failed', e);
        }
        if (typeof out !== 'string' || !out.trim()) {
            try {
                out = await ctx.generateQuietPrompt(prompt, false, false);
            } catch (e) {
                log('positional generateQuietPrompt failed', e);
            }
        }
        if (typeof out !== 'string' || !out.trim()) {
            throw new Error('总结生成失败（模型未返回内容）');
        }

        const content = out.trim();
        const title = (content.split('\n')[0] || '').trim().slice(0, 24)
            || `摘要 ${store.summaries.length + 1}`;
        store.summaries.push({ title, content, ts: Date.now(), upTo: chat.length - 1 });
        store.lastMessageId = chat.length - 1;
        saveMetadataDebounced();

        renderRecords();
        await updateTokens();
        if (manual) {
            toast('✅ 记忆总结完成');
        }
    } catch (e) {
        console.error('[MissSummary] summarize failed', e);
        toast('❌ ' + (e?.message || '总结失败'));
    } finally {
        busy = false;
        setBusy(false);
        if (st_b() && prevPreset) {
            setTimeout(() => applyPreset(prevPreset).catch(() => { }), 50);
        }
    }
}

function st_b() {
    return Boolean(s().boundPreset);
}

function setBusy(on) {
    $('#miss-status-dot', $drawer).toggleClass('busy', !!on);
    const $btn = $('#miss-summarize-btn', $drawer);
    $btn.prop('disabled', !!on).toggleClass('disabled', !!on);
}

// ---------------- 保存的设置 ----------------

function saveSnapshot(name) {
    const st = s();
    st.savedPresets = st.savedPresets || {};
    st.savedPresets[name] = {
        tag: st.tag,
        boundPreset: st.boundPreset,
        tokenThreshold: st.tokenThreshold,
        floorThreshold: st.floorThreshold,
        keepVisibleFloors: st.keepVisibleFloors,
        summaryPrompt: st.summaryPrompt,
        autoSummarize: st.autoSummarize,
        savedAt: Date.now(),
    };
    st.savedActive = name;
    saveSettingsDebounced();
    renderSavedSelect();
    toast(`✅ 已保存「${name}」`);
}

function applySnapshot(name) {
    const st = s();
    const snap = st.savedPresets?.[name];
    if (!snap) {
        return;
    }
    st.tag = snap.tag || '';
    st.boundPreset = snap.boundPreset || '';
    st.tokenThreshold = Number(snap.tokenThreshold) || 0;
    st.floorThreshold = Number(snap.floorThreshold) || 0;
    st.keepVisibleFloors = Number(snap.keepVisibleFloors) || 0;
    st.summaryPrompt = snap.summaryPrompt || defaultSettings().summaryPrompt;
    st.autoSummarize = snap.autoSummarize !== false;
    st.savedActive = name;
    saveSettingsDebounced();
    recordsOpen.clear();
    editingId = null;
    refreshPresets();
    renderAll();
    toast(`已切换到「${name}」`);
}

// ---------------- 编辑摘要 ----------------

function saveEdit(rec, newText) {
    const ctx = getContext();
    if (rec.type === 'extract') {
        const m = ctx.chat?.[rec.msgId];
        if (m && typeof m.mes === 'string' && m.mes.includes(rec.content)) {
            m.mes = m.mes.split(rec.content).join(newText);
            ctx.saveChat?.();
        }
    } else if (rec.entry) {
        rec.entry.content = newText;
        saveMetadataDebounced();
    }
    editingId = null;
    renderRecords();
    updateTokens();
    toast('✅ 已保存并覆盖到聊天');
}

// ---------------- 弹窗 / 提示 ----------------

function openSaveModal() {
    const overlay = $(`
        <div id="miss_modal_overlay">
            <div class="miss-modal">
                <h4><i class="fa-solid fa-floppy-disk"></i> 保存初始设置</h4>
                <div class="miss-hint" style="margin-bottom:8px;">为本次配置起一个名字：</div>
                <input class="miss-input" id="miss-save-name-input" type="text" placeholder="例如：轻量记忆 / 完整记忆…" maxlength="30">
                <div class="miss-modal-actions">
                    <button class="miss-btn" id="miss-modal-cancel">取消</button>
                    <button class="miss-btn primary" id="miss-modal-ok"><i class="fa-solid fa-check"></i> 保存</button>
                </div>
            </div>
        </div>`);
    $('body').append(overlay);
    const $input = overlay.find('#miss-save-name-input');
    setTimeout(() => $input.trigger('focus'), 50);
    const close = () => overlay.remove();
    return new Promise(resolve => {
        overlay.find('#miss-modal-cancel').on('click', () => { close(); resolve(null); });
        overlay.on('click', e => {
            if (e.target === overlay[0]) { close(); resolve(null); }
        });
        const ok = () => {
            const v = String($input.val() || '').trim();
            if (!v) {
                toast('请输入保存名称');
                return;
            }
            close();
            resolve(v);
        };
        overlay.find('#miss-modal-ok').on('click', ok);
        $input.on('keydown', e => {
            if (e.key === 'Enter') { ok(); }
            if (e.key === 'Escape') { close(); resolve(null); }
        });
    });
}

function toast(msg) {
    let $wrap = $('#miss_toast');
    if (!$wrap.length) {
        $wrap = $('<div id="miss_toast"></div>');
        $('body').append($wrap);
    }
    const $el = $('<div class="miss-toast"></div>').text(msg);
    $wrap.append($el);
    setTimeout(() => {
        $el.fadeOut(250, () => $el.remove());
    }, 2600);
}

// ---------------- 工具 ----------------

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeReg(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, wait) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}
