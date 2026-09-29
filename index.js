// Miss总结插件 - SillyTavern Extension
// 兼容性策略：只静态导入 getContext（所有版本必有），其余全部运行时防御性获取
import { getContext } from '../../../extensions.js';

const MODULE = 'missSummary';

const $ = window.jQuery;

const log = (...args) => console.log('[MissSummary]', ...args);

// ---- 运行时依赖获取（全部带兜底，避免版本差异导致模块崩溃）----

let _stMod = null;
async function stMod() {
    if (_stMod) {
        return _stMod;
    }
    try {
        _stMod = await import('../../../../script.js');
    } catch (e) {
        log('script.js import failed', e);
    }
    return _stMod;
}

// ST Popup API：定位/主题/手机适配全部由 ST 官方弹窗系统管理
let _popupMod = null;
async function popupMod() {
    if (_popupMod) {
        return _popupMod;
    }
    try {
        _popupMod = await import('../../../popup.js');
    } catch (e) {
        log('popup.js import failed', e);
    }
    return _popupMod;
}

async function extMod() {
    try {
        return await import('../../../extensions.js');
    } catch (e) {
        log('extensions.js import failed', e);
        return null;
    }
}

async function getEventSource() {
    if (window.eventSource) {
        return window.eventSource;
    }
    const mod = await stMod();
    return mod?.eventSource || null;
}

async function getEventTypes() {
    if (window.event_types) {
        return window.event_types;
    }
    const mod = await stMod();
    return mod?.event_types || {
        CHAT_CHANGED: 'CHAT_CHANGED',
        MESSAGE_SENT: 'MESSAGE_SENT',
        MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
        GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
        SETTINGS_UPDATED: 'SETTINGS_UPDATED',
    };
}

async function getExtSettings() {
    const ctx = getContext();
    if (ctx?.extensionSettings) {
        return ctx.extensionSettings;
    }
    const em = await extMod();
    if (em?.extension_settings) {
        return em.extension_settings;
    }
    // 最终兜底：挂在 ST 全局 settings 对象上
    const st = await stMod();
    if (st?.extension_settings) {
        return st.extension_settings;
    }
    return (window.extension_settings = window.extension_settings || {});
}

async function getSaveSettingsFn() {
    const em = await extMod();
    return em?.saveSettingsDebounced || (() => {
        const st = window.saveSettingsDebounced;
        if (typeof st === 'function') {
            st();
        }
    });
}

async function getSaveMetadataFn() {
    const ctx = getContext();
    if (typeof ctx?.saveMetadata === 'function') {
        return ctx.saveMetadata;
    }
    const mod = await stMod();
    if (mod?.saveMetadataDebounced) {
        return mod.saveMetadataDebounced;
    }
    if (window.saveMetadataDebounced) {
        return window.saveMetadataDebounced;
    }
    return () => { };
}

async function getSetExtensionPrompt() {
    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt === 'function') {
        return ctx.setExtensionPrompt;
    }
    const mod = await stMod();
    return mod?.setExtensionPrompt || (() => { });
}

function getPromptTypes() {
    return window.extension_prompt_types || { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 };
}

function getPromptRoles() {
    return window.extension_prompt_roles || { SYSTEM: 'system', USER: 'user', ASSISTANT: 'assistant' };
}
// ---- 本地保存包装 ----
async function saveSettings() {
    try {
        const fn = await getSaveSettingsFn();
        fn();
    } catch (e) {
        log('saveSettings failed', e);
    }
}

async function saveMetadata() {
    try {
        const fn = await getSaveMetadataFn();
        fn();
    } catch (e) {
        log('saveMetadata failed', e);
    }
}


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

let _settings = null;
async function s() {
    if (!_settings) {
        const es = await getExtSettings();
        if (es[MODULE] === undefined) {
            es[MODULE] = defaultSettings();
        }
        for (const key of Object.keys(defaultSettings())) {
            if (es[MODULE][key] === undefined) {
                es[MODULE][key] = defaultSettings()[key];
            }
        }
        _settings = es[MODULE];
    }
    return _settings;
}

function sSync() {
    // 设置初始化后可同步访问
    return _settings || defaultSettings();
}

let lastTokenCount = 0;
let busy = false;
const recordsOpen = new Set();
let editingId = null;
let $drawer = null;

console.log('[MissSummary] module evaluated');

jQuery(() => {
    log('jQuery ready fired');
    init().catch(err => {
        console.error('[MissSummary] init failed', err);
        // 加载失败自动重试（应对 ST 各版本模块加载时序差异）
        setTimeout(() => init().catch(e => console.error('[MissSummary] retry failed', e)), 1500);
    });
});

async function init() {
    const ctx = getContext();
    if (!ctx) {
        log('context not ready, skip');
        return;
    }
    log('step 1/6: settings');
    await s();
    log('step 2/6: drawer');
    buildDrawer();
    log('step 3/6: menu button');
    addMenuButton();
    log('step 4/6: bind ui');
    await bindUi();
    log('step 5/6: presets');
    await refreshPresets();
    log('step 6/6: render');
    renderAll();

    const es = await getEventSource();
    const et = await getEventTypes();
    if (es && et) {
        es.on(et.CHAT_CHANGED, onChatChanged);
        es.on(et.MESSAGE_SENT, onMessageChanged);
        es.on(et.MESSAGE_RECEIVED, onMessageChanged);
        es.on(et.GENERATION_AFTER_COMMANDS, onGeneration);
        es.on(et.SETTINGS_UPDATED, refreshPresets);
        await hookTokenEvents();
    } else {
        log('event source not available, event hooks disabled');
    }

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

async function openPanel() {
    // 收起魔法棒菜单：点击会冒泡到 ST 全局监听自动关闭，
    // 这里补一次按钮点击确保 isDropdownVisible 内部状态同步，防止菜单残留
    const $menu = $('#extensionsMenu');
    const $wandBtn = $('#extensionsMenuButton');
    if ($menu.is(':visible') && Number($menu.css('opacity')) > 0.9) {
        $wandBtn.trigger('click');
    }
    // 旧版抽屉式菜单兜底
    $('#extensionsMenuPopout').parent().removeClass('openDrawer');

    const block = document.getElementById('missSummarySettings');
    if (!block) {
        toast('插件面板未就绪，请稍候重试');
        return;
    }

    // 使用 ST 官方 Popup 承载面板：定位/缩放/主题/手机适配全部由 ST 管理，
    // 彻底避免 movingUI/transform 导致的 fixed 定位错位问题
    const pm = await popupMod();
    if (pm?.callGenericPopup && pm?.POPUP_TYPE?.TEXT) {
        // 面板搬进弹窗内容区（事件绑定在 $drawer 委托上，搬动不影响）
        const result = await pm.callGenericPopup($(block), pm.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: '关闭',
            onClosing: () => {
                // 关闭后面板搬回扩展设置区，保持扩展面板里也始终可用
                const host = document.getElementById('extensions_settings2')
                    || document.getElementById('extensions_settings');
                if (block && host && !host.contains(block)) {
                    host.insertAdjacentElement('afterbegin', block);
                }
                return true;
            },
        });
        renderAll();
        updateTokens();
        return result;
    }

    // 兜底：ST Popup 不可用时使用自绘弹窗
    let $modal = $('#missSummaryModal');
    if (!$modal.length) {
        $('body').append(`
            <div id="missSummaryModal" class="miss-modal-overlay">
                <div class="miss-modal-window">
                    <div class="miss-modal-header">
                        <div class="miss-modal-title"><i class="fa-solid fa-brain"></i> Miss总结</div>
                        <button id="miss-modal-close" class="miss-modal-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="miss-modal-body"></div>
                </div>
            </div>`);
        $modal = $('#missSummaryModal');
        // 关闭：X 按钮 / 点击遮罩空白 / ESC
        $modal.on('click', '#miss-modal-close', closePanel);
        $modal.on('click', e => {
            if (e.target === $modal[0]) {
                closePanel();
            }
        });
        $(document).on('keydown.missModal', e => {
            if (e.key === 'Escape' && $modal.hasClass('visible')) {
                closePanel();
            }
        });
    }

    const $body = $modal.find('.miss-modal-body');
    if (!$body.find(block).length) {
        // 首次打开：搬入面板（事件绑定在 $drawer 委托上，搬动不影响）
        $body.append(block);
    }
    $modal.addClass('visible').css('display', 'flex').hide().fadeIn(180);
    renderAll();
    updateTokens();
}

function closePanel() {
    const $modal = $('#missSummaryModal');
    if (!$modal.length) {
        return;
    }
    $modal.removeClass('visible').fadeOut(150, () => {
        // 把面板搬回扩展设置区，保持扩展面板里也始终可用
        const block = document.getElementById('missSummarySettings');
        const host = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (block && host && !host.contains(block)) {
            host.insertAdjacentElement('afterbegin', block);
        }
        $modal.css('display', '');
    });
}

// ---------------- 数据 ----------------

function getStore() {
    const ctx = getContext();
    if (!ctx) {
        return { summaries: [], lastMessageId: -1 };
    }
    if (!ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') {
        try {
            ctx.chatMetadata = {};
        } catch {
            return { summaries: [], lastMessageId: -1 };
        }
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

// 智能提取标签名：容忍用户粘贴完整标签 <tag>...</tag>、属性、尖括号、空格
function cleanTagName(raw) {
    let t = String(raw ?? '').trim();
    if (!t) {
        return '';
    }
    // 收集所有标签结构中的标识符：<tag> </tag> <tag attr> 等
    const names = [];
    const re = /<\/?\s*([A-Za-z_][\w.-]*)\s*[^>]*>/g;
    const rest = t.replace(re, (full, name) => {
        names.push(name);
        return ' ';
    });
    const cleaned = rest.replace(/[<>/]/g, ' ').trim();
    if (names.length) {
        return names[0];
    }
    const m = cleaned.match(/^([A-Za-z_][\w.-]*)/);
    return m ? m[1] : '';
}

function extractRecords() {
    const ctx = getContext();
    const tag = String(sSync().tag || '').trim();
    if (!tag || !Array.isArray(ctx.chat)) {
        return [];
    }
    // 大小写不敏感 + 容忍属性/空白：<tag ...>...</tag>
    const re = new RegExp(`<${escapeReg(tag)}[^>]*>([\\s\\S]*?)</\\s*${escapeReg(tag)}\\s*>`, 'gi');
    const records = [];
    ctx.chat.forEach((m, idx) => {
        if (!m || typeof m.mes !== 'string') {
            return;
        }
        re.lastIndex = 0;
        const parts = [];
        let mm;
        while ((mm = re.exec(m.mes)) !== null) {
            const t = String(mm[1] || '').trim();
            if (t) {
                parts.push(t);
            }
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
        _stModule = await stMod();
        return _stModule;
    } catch (e) {
        log('script.js dynamic import failed', e);
        return null;
    }
}

// ---------------- 渲染 ----------------

function renderAll() {
    const st = sSync();
    $('#miss-tag-input', $drawer).val(st.tag);    $('#miss-preset-select', $drawer).val(st.boundPreset);
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
    const st = sSync();
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

// ---- 精确 Token 统计：监听 ST 生成前的最终 prompt 事件 ----
// CHAT_COMPLETION_PROMPT_READY: chat API 最终消息数组（含全部预设/角色卡/聊天/注入）
// GENERATE_AFTER_COMBINE_PROMPTS: 文本补全 API 最终合并后的字符串
let _lastPromptTokens = 0;
let _tokenCountFn = null;

async function hookTokenEvents() {
    const es = await getEventSource();
    const et = await getEventTypes();
    if (!es || !et) {
        return;
    }
    if (et.CHAT_COMPLETION_PROMPT_READY) {
        es.on(et.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    }
    if (et.GENERATE_AFTER_COMBINE_PROMPTS) {
        es.on(et.GENERATE_AFTER_COMBINE_PROMPTS, onPromptReady);
    }
}

async function onPromptReady(data) {
    try {
        let text = '';
        if (Array.isArray(data?.chat)) {
            // chat completion：拼接全部 role 消息（这就是发给 AI 的完整内容）
            text = data.chat
                .map(m => (typeof m === 'string' ? m : `${m?.role ? m.role + ': ' : ''}${m?.content || ''}`))
                .join('\n');
        } else if (typeof data?.prompt === 'string') {
            text = data.prompt;
        } else {
            return;
        }
        const n = await countTokens(text);
        if (n > 0) {
            _lastPromptTokens = n;
            paintTokenDisplay(n);
        }
    } catch (e) {
        log('onPromptReady failed', e);
    }
}

async function countTokens(text) {
    if (!text) {
        return 0;
    }
    const ctx = getContext();
    if (typeof ctx?.getTokenCountAsync === 'function') {
        try { return await ctx.getTokenCountAsync(text); } catch { /* fallthrough */ }
    }
    if (typeof ctx?.getTokenCount === 'function') {
        try { return ctx.getTokenCount(text); } catch { /* fallthrough */ }
    }
    return Math.ceil(text.length / 3.5); // 近似兜底（英文≈4字符/token）
}

function paintTokenDisplay(n) {
    lastTokenCount = Number(n) || 0;
    const $el = $('#miss-token-display', $drawer);
    if ($el.length) {
        $el.text(String(lastTokenCount));
    }
}

async function updateTokens() {
    if (!$drawer || !$drawer.length) {
        return lastTokenCount;
    }
    // 优先展示最近一次真实生成的精确值
    if (_lastPromptTokens > 0) {
        paintTokenDisplay(_lastPromptTokens);
        return lastTokenCount;
    }
    // 无生成记录时：用与 ST 相同口径估算（系统提示 + 角色卡描述/场景/Personality + 作者注 + 世界书 + 全部楼层 + 注入）
    const ctx = getContext();
    let text = '';
    try {
        const ch = ctx.characters?.[ctx.characterId];
        if (ch) {
            text += `${ch.description || ''}\n${ch.personality || ''}\n${ch.scenario || ''}\n${ch.first_mes || ''}\n${ch.mes || ''}\n`;
        }
    } catch { /* ignore */ }
    try { text += `${ctx.name1 || ''}\n${ctx.name2 || ''}\n`; } catch { /* ignore */ }
    try {
        text += `${ctx.chatMetadata?.note_prompt || ''}\n`;
    } catch { /* ignore */ }
    try {
        text += (ctx.chat || [])
            .map(m => `${m?.is_user ? (ctx.name1 || '用户') : (ctx.name2 || '角色')}: ${m?.mes || ''}`)
            .join('\n') + '\n';
    } catch { /* ignore */ }
    try {
        const sum = getStore().summaries.map(x => x.content).join('\n');
        if (sum) {
            text += sum + '\n';
        }
    } catch { /* ignore */ }

    const n = await countTokens(text);
    paintTokenDisplay(n);
    return lastTokenCount;
}

function refreshPresets() {
    const $sel = $('#miss-preset-select', $drawer);
    if (!$sel.length) {
        return;
    }
    const presets = collectPresets();
    const current = sSync().boundPreset;
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

async function bindUi() {
    $drawer.on('click', '.miss-nav-btn', function () {
        const tab = $(this).data('tab');
        $('.miss-nav-btn', $drawer).removeClass('active');
        $(this).addClass('active');
        $('.miss-panel', $drawer).removeClass('active');
        $(`#miss-panel-${tab}`, $drawer).addClass('active');
    });

    $('#miss-tag-input', $drawer).on('change', function () {
        sSync().tag = cleanTagName($(this).val());
        // 输入框回显规范化后的标签名
        $(this).val(sSync().tag);
        saveSettings();
        recordsOpen.clear();
        editingId = null;
        renderRecords();
    });

    $('#miss-extract-btn', $drawer).on('click', () => {
        // 先把输入框当前值清洗同步到设置（用户可能没触发 change 就点抓取）
        sSync().tag = cleanTagName($('#miss-tag-input', $drawer).val());
        $('#miss-tag-input', $drawer).val(sSync().tag);
        saveSettings();
        if (!sSync().tag) {
            toast('❌ 摘要标签为空，请先填写标签名（如 summary 或 <summary>）');
            return;
        }
        recordsOpen.clear();
        editingId = null;
        renderRecords();
        const n = extractRecords().length;
        toast(n ? `✅ 已抓取 ${n} 条「${sSync().tag}」摘要` : `未抓取到 <${sSync().tag}>...</${sSync().tag}> 包裹的内容`);
    });

    $('#miss-preset-select', $drawer).on('change', function () {
        sSync().boundPreset = String($(this).val() || '');
        saveSettings();
        toast(sSync().boundPreset ? `已绑定预设：${sSync().boundPreset}` : '已取消预设绑定');
    });

    $('#miss-save-btn', $drawer).on('click', async () => {
        const name = await openSaveModal();
        if (!name) {
            return;
        }
        await saveSnapshot(name);
    });

    $('#miss-saved-select', $drawer).on('change', async function () {
        const name = String($(this).val() || '');
        if (name) {
            await applySnapshot(name);
        }
    });

    $('#miss-saved-delete', $drawer).on('click', () => {
        const st = sSync();
        const name = st.savedActive;
        if (!name || !st.savedPresets[name]) {
            toast('请先选择一个已保存的设置');
            return;
        }
        delete st.savedPresets[name];
        st.savedActive = '';
        saveSettings();
        renderSavedSelect();
        toast(`已删除「${name}」`);
    });

    $('#miss-token-threshold', $drawer).on('change', function () {
        sSync().tokenThreshold = Math.max(0, Number($(this).val()) || 0);
        saveSettings();
    });
    $('#miss-floor-threshold', $drawer).on('change', function () {
        sSync().floorThreshold = Math.max(0, Number($(this).val()) || 0);
        saveSettings();
    });
    $('#miss-keep-floors', $drawer).on('change', function () {
        sSync().keepVisibleFloors = Math.max(0, Number($(this).val()) || 0);
        saveSettings();
    });
    $('#miss-summary-prompt', $drawer).on('change', function () {
        sSync().summaryPrompt = String($(this).val() || '');
        saveSettings();
    });
    $('#miss-auto-chk', $drawer).on('change', function () {
        sSync().autoSummarize = $(this).prop('checked');
        saveSettings();
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

    $('#miss-records-list', $drawer).on('click', '[data-act]', async function (e) {
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
            await saveEdit(rec, newText);
        }
    });
}

async function onChatChanged() {
    recordsOpen.clear();
    editingId = null;
    try {
        const sep = await getSetExtensionPrompt();
        sep(MODULE, '', getPromptTypes().NONE, 0);
    } catch { /* ignore */ }
    renderAll();
}

const debouncedAuto = debounce(() => {
    updateTokens().then(checkAuto).catch(e => log(e));
}, 1200);

function onMessageChanged() {
    debouncedAuto();
}

async function onGeneration() {
    const keep = Number(sSync().keepVisibleFloors) || 0;
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
            const sep = await getSetExtensionPrompt();
            sep(MODULE, injection, getPromptTypes().IN_CHAT, 4, false, getPromptRoles().SYSTEM);
        } else {
            const sep = await getSetExtensionPrompt();
        sep(MODULE, '', getPromptTypes().NONE, 0);
        }
    } catch (e) {
        log('inject failed', e);
    }
}

// ---------------- 总结 ----------------

async function checkAuto() {
    const st = sSync();
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
        const st = sSync();
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
        await saveMetadata();

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
    return Boolean(sSync().boundPreset);
}

function setBusy(on) {
    $('#miss-status-dot', $drawer).toggleClass('busy', !!on);
    const $btn = $('#miss-summarize-btn', $drawer);
    $btn.prop('disabled', !!on).toggleClass('disabled', !!on);
}

// ---------------- 保存的设置 ----------------

async function saveSnapshot(name) {
    const st = sSync();
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
    saveSettings();
    renderSavedSelect();
    toast(`✅ 已保存「${name}」`);
}

async function applySnapshot(name) {
    const st = sSync();
    const snap = st.savedPresets?.[name];
    if (!snap) {
        return;
    }
    st.tag = cleanTagName(snap.tag || '');
    st.boundPreset = snap.boundPreset || '';
    st.tokenThreshold = Number(snap.tokenThreshold) || 0;
    st.floorThreshold = Number(snap.floorThreshold) || 0;
    st.keepVisibleFloors = Number(snap.keepVisibleFloors) || 0;
    st.summaryPrompt = snap.summaryPrompt || defaultSettings().summaryPrompt;
    st.autoSummarize = snap.autoSummarize !== false;
    st.savedActive = name;
    saveSettings();
    recordsOpen.clear();
    editingId = null;
    refreshPresets();
    renderAll();
    toast(`已切换到「${name}」`);
}

// ---------------- 编辑摘要 ----------------

async function saveEdit(rec, newText) {
    const ctx = getContext();
    if (rec.type === 'extract') {
        const m = ctx.chat?.[rec.msgId];
        if (m && typeof m.mes === 'string' && m.mes.includes(rec.content)) {
            m.mes = m.mes.split(rec.content).join(newText);
            ctx.saveChat?.();
        }
    } else if (rec.entry) {
        rec.entry.content = newText;
        await saveMetadata();
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
