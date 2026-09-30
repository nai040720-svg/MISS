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

async function getPromptTypesAsync() {
    if (window.extension_prompt_types) {
        return window.extension_prompt_types;
    }
    const mod = await stMod();
    return mod?.extension_prompt_types || { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
}

async function getPromptRolesAsync() {
    if (window.extension_prompt_roles) {
        return window.extension_prompt_roles;
    }
    const mod = await stMod();
    return mod?.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
}

function getPromptTypes() {
    // ST 真实值：NONE=-1, IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2（不挂全局，需从模块取）
    return window.extension_prompt_types || { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
}

function getPromptRoles() {
    // ST 真实值：SYSTEM=0, USER=1, ASSISTANT=2（数字枚举，非字符串）
    return window.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
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
        // await 确保聊天元数据（含世界书绑定）真正落盘后再继续
        await fn();
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
        summaryPrompt: '',  // 提示词完全由用户在「提示词」分类填写，插件不内置
        jailbreakPrompt: '',
        autoSummarize: true,
        autoHideFloors: false,
        sendFullChat: false,
        captureAllRecords: false,
        capturedRecords: [],
        // 副API设置
        subApi: { type: 'openai', source: 'custom', url: '', key: '', model: '', connected: false, stream: false, temperature: '' },
        subApiSaved: {},   // { name: {type, source, url, key, model, stream} }
        subApiActive: '',  // 当前启用的副API配置名（''=用上面手动填写的）
        // 世界书
        wiEnabled: true,
        wiCounter: 0,
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
let initialized = false;
let uiBound = false;
let subApiUiBound = false;
let eventsBound = false;

console.log('[MissSummary] module evaluated');

jQuery(() => {
    log('jQuery ready fired');
    // 菜单入口不依赖设置、弹窗和预设初始化。
    addMenuButton();
    init().catch(err => {
        console.error('[MissSummary] init failed', err);
        // 加载失败自动重试（应对 ST 各版本模块加载时序差异）
        setTimeout(() => init().catch(e => console.error('[MissSummary] retry failed', e)), 1500);
    });
});

async function init() {
    if (initialized) {
        return;
    }
    const ctx = getContext();
    if (!ctx) {
        log('context not ready, retrying');
        setTimeout(() => init().catch(e => log('retry init failed', e)), 1500);
        return;
    }
    log('step 1/6: settings');
    await s();
    log('step 2/6: drawer');
    buildDrawer();
    log('step 3/6: menu button');
    addMenuButton();
    log('step 4/6: bind ui');
    if (!uiBound) {
        await bindUi();
        uiBound = true;
    }
    if (!subApiUiBound) {
        bindSubApiUi();
        subApiUiBound = true;
    }
    try { renderSubApi(); } catch (e) { log('sub API render failed', e); }
    log('step 5/6: presets');
    try { await refreshPresets(); } catch (e) { log('preset refresh failed', e); }
    log('step 6/6: render');
    try { renderAll(); } catch (e) { log('initial render failed', e); }

    const es = await getEventSource();
    const et = await getEventTypes();
    if (es && et && !eventsBound) {
        es.on(et.CHAT_CHANGED, onChatChanged);
        es.on(et.MESSAGE_SENT, onMessageChanged);
        es.on(et.MESSAGE_RECEIVED, onMessageChanged);
        es.on(et.GENERATION_AFTER_COMMANDS, onGeneration);
        es.on(et.SETTINGS_UPDATED, refreshPresets);
        await hookTokenEvents();
        eventsBound = true;
    } else {
        log('event source not available, event hooks disabled');
    }

    initialized = true;
    log('loaded, version 0.3.1');
}

// ---------------- UI 构建 ----------------

function buildDrawer() {
    if (document.getElementById('missSummarySettings')) {
        return;
    }    const html = `
    <div id="missSummarySettings" class="extension_settings">
        <div class="inline-drawer-content" style="display:block;">
            <div class="miss-nav">
                <button class="miss-nav-btn active" data-tab="setup"><i class="fa-solid fa-sliders"></i> 初始设置</button>
                    <button class="miss-nav-btn" data-tab="memory"><i class="fa-solid fa-brain"></i> 记忆总结</button>
                    <button class="miss-nav-btn" data-tab="prompts"><i class="fa-solid fa-feather"></i> 提示词</button>
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
                        <div class="miss-hint">选择一个预设并绑定摘要标签，切换预设即可使用对应的摘要标签抓取，无需手动保存。</div>
                    </div>

                    <div class="miss-field">
                        <div class="miss-collapse-header interactable" id="miss-subapi-toggle" tabindex="0">
                            <b><i class="fa-solid fa-plug"></i> 副API设置</b>
                            <i class="fa-solid fa-circle-chevron-down miss-collapse-icon"></i>
                        </div>
                        <div class="miss-collapse-body" id="miss-subapi-body" style="display:none;">
                            <div class="miss-field">
                                <label for="miss-subapi-type"><i class="fa-solid fa-network-wired"></i> API 类型</label>
                                <select id="miss-subapi-type" class="miss-input">
                                    <option value="openai">Chat 补全（OpenAI 兼容 / Claude / Gemini 等）</option>
                                </select>
                            </div>
                            <div class="miss-field" id="miss-subapi-source-row">
                                <label for="miss-subapi-source"><i class="fa-solid fa-diagram-project"></i> Chat 补全来源</label>
                                <select id="miss-subapi-source" class="miss-input">
                                    <option value="custom">自定义（兼容 OpenAI）</option>
                                    <option value="openai">OpenAI</option>
                                    <option value="claude">Claude</option>
                                    <option value="makersuite">Google AI (Gemini)</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="deepseek">DeepSeek</option>
                                    <option value="groq">Groq</option>
                                    <option value="mistralai">MistralAI</option>
                                    <option value="cohere">Cohere</option>
                                </select>
                            </div>
                            <div class="miss-field">
                                <label for="miss-subapi-url"><i class="fa-solid fa-globe"></i> API 地址（含端口，如 http://127.0.0.1:5000/v1）</label>
                                <input id="miss-subapi-url" class="miss-input" type="text" placeholder="http://127.0.0.1:5000/v1">
                            </div>
                            <div class="miss-field">
                                <label for="miss-subapi-key"><i class="fa-solid fa-key"></i> API 密钥（本地服务可留空）</label>
                                <input id="miss-subapi-key" class="miss-input" type="password" placeholder="sk-...">
                            </div>
                            <div class="miss-field">
                                <label for="miss-subapi-model"><i class="fa-solid fa-cube"></i> 模型</label>
                                <div class="miss-inline-row">
                                    <input id="miss-subapi-model" class="miss-input" type="text" placeholder="模型名，或点右侧拉取">
                                    <button id="miss-subapi-models-btn" class="miss-btn" title="拉取模型列表"><i class="fa-solid fa-cloud-arrow-down"></i></button>
                                </div>
                            </div>
                            <div class="miss-inline-row" style="margin-top:4px;">
                                <button id="miss-subapi-connect-btn" class="miss-btn" style="flex:1;"><i class="fa-solid fa-plug-circle-check"></i> 连接</button>
                                <button id="miss-subapi-test-btn" class="miss-btn" style="flex:1;"><i class="fa-solid fa-paper-plane"></i> 发送测试消息</button>
                            </div>
                            <div class="miss-field" style="margin-top:8px;">
                                <label for="miss-subapi-temperature" title="留空=跟随酒馆主API的温度设置；填写后副API总结使用此温度（0=最严谨，2=最随机）"><i class="fa-solid fa-temperature-half"></i> 副API温度（留空=跟随酒馆设置）</label>
                                <input id="miss-subapi-temperature" class="miss-input" type="number" min="0" max="2" step="0.1" placeholder="留空=跟随酒馆（当前温度显示在下方状态）">
                            </div>
                            <label class="miss-check" title="仅对插件总结生效：开启后副API以流式(SSE)方式返回总结内容；不影响酒馆主聊天的流式设置">
                                <input id="miss-subapi-stream-chk" type="checkbox"> 总结时开启 AI 流式传输（仅对插件总结生效）
                            </label>
                            <div id="miss-subapi-status" class="miss-hint" style="margin-top:6px;">未连接。总结时如绑定了副API将使用此 API 生成摘要；未绑定则使用酒馆当前连接的 API。</div>

                            <div class="miss-field" style="margin-top:12px;">
                                <div class="miss-collapse-header interactable" id="miss-subapi-saved-toggle" tabindex="0">
                                    <b><i class="fa-solid fa-floppy-disk"></i> 保存与选择 API</b>
                                    <i class="fa-solid fa-circle-chevron-down miss-collapse-icon"></i>
                                </div>
                                <div class="miss-collapse-body" id="miss-subapi-saved-body" style="display:none;">
                                    <div class="miss-inline-row">
                                        <input id="miss-subapi-save-name" class="miss-input" type="text" placeholder="为当前副API配置起一个名字">
                                        <button id="miss-subapi-save-btn" class="miss-btn primary" title="保存当前配置"><i class="fa-solid fa-check"></i></button>
                                    </div>
                                    <div class="miss-inline-row" style="margin-top:6px;">
                                        <select id="miss-subapi-saved-select" class="miss-input"></select>
                                        <button id="miss-subapi-saved-delete" class="miss-btn" title="删除所选"><i class="fa-solid fa-trash"></i></button>
                                    </div>
                                    <div class="miss-hint">保存多个副API配置后，在此选择即可立即切换启用哪个副API。</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="miss-panel" id="miss-panel-memory">
                    <div class="miss-field">
                        <button id="miss-capture-records-btn" class="miss-btn" style="width:100%;"><i class="fa-solid fa-download"></i> 抓取无标签正文</button>
                        <div class="miss-hint">按楼层统一整理：有摘要标签的楼层只取标签正文；无标签楼层取整条正文。显示倒序，发送给 AI 时正序。</div>
                    </div>
                    <div class="miss-field">
                        <div class="miss-collapse-header interactable" id="miss-records-toggle" tabindex="0"><b><i class="fa-solid fa-scroll"></i> 记录（统一楼层记录）<span id="miss-records-count">0</span></b><i class="fa-solid fa-circle-chevron-down miss-collapse-icon"></i></div>
                        <div class="miss-collapse-body" id="miss-records-body" style="display:none;"><div class="miss-records-scroll"><div id="miss-records-list"></div></div></div>
                    </div>
                    <div class="miss-field">
                        <div class="miss-collapse-header interactable" id="miss-summaries-toggle" tabindex="0"><b><i class="fa-solid fa-brain"></i> 大总结内容（<span id="miss-summaries-count">0</span>） <button id="miss-delete-summaries-btn" class="miss-btn danger" style="float:right;" title="删除全部大总结内容"><i class="fa-solid fa-trash"></i> 删除</button></b><i class="fa-solid fa-circle-chevron-down miss-collapse-icon"></i></div>
                        <div class="miss-collapse-body" id="miss-summaries-body" style="display:none;"><div class="miss-records-scroll"><div id="miss-summaries-list"></div></div><div class="miss-inline-row" style="margin-top:6px;"><button id="miss-resummarize-btn" class="miss-btn primary" style="flex:1;"><i class="fa-solid fa-rotate-right"></i> 重新总结</button></div><div class="miss-hint">重新总结发送当前所有未隐藏统一记录；删除只删除大总结及世界书条目。</div></div>
                    </div>
                    <div class="miss-field">
                        <div class="miss-collapse-header interactable" id="miss-summary-settings-toggle" tabindex="0"><b><i class="fa-solid fa-gauge-high"></i> 总结设置</b><i class="fa-solid fa-circle-chevron-down miss-collapse-icon"></i></div>
                        <div class="miss-collapse-body" id="miss-summary-settings-body" style="display:none;">
                            <div class="miss-token-box"><div class="miss-token-label">当前总 Token（预设 + 聊天记录 + 提示词）</div><div class="miss-token-value"><span id="miss-token-display">0</span></div></div>
                            <div class="miss-grid"><div><label for="miss-token-threshold">Token 总结</label><input id="miss-token-threshold" class="miss-input" type="number" min="0" placeholder="0=关闭"></div><div><label for="miss-floor-threshold">楼层总结</label><input id="miss-floor-threshold" class="miss-input" type="number" min="0" placeholder="0=关闭"></div><div><label for="miss-keep-floors">隐藏楼层（保留最近 N 个角色楼）</label><input id="miss-keep-floors" class="miss-input" type="number" min="0" placeholder="0=关闭"></div></div>
                        </div>
                        <label class="miss-check"><input id="miss-auto-chk" type="checkbox"> 自动总结（达到阈值时自动触发）</label>
                        <label class="miss-check"><input id="miss-hide-floors-chk" type="checkbox"> 自动隐藏已总结楼层</label>
                        <label class="miss-check" title="只发送当前未隐藏楼层；已隐藏楼层视为已经总结过"><input id="miss-full-chat-chk" type="checkbox"> 总结时发送全文（当前未隐藏聊天正文 + 摘要正文）</label>
                        <div class="miss-inline-row" style="margin-top:6px;"><button id="miss-summarize-btn" class="miss-btn primary" style="flex:1;"><i class="fa-solid fa-wand-magic-sparkles"></i> 立即总结</button></div>
                    </div>
                </div>

                <div class="miss-panel" id="miss-panel-prompts">
                    <div class="miss-field">
                        <label for="miss-jailbreak-prompt" style="margin-top:8px;"><i class="fa-solid fa-unlock"></i> 破限提示词（身份：系统，位于最前）</label>
                        <textarea id="miss-jailbreak-prompt" class="miss-input" rows="4" placeholder="自定义破限提示词，总结时以系统身份插在最前"></textarea>
                        <div class="miss-hint">总结请求时以 <b>system</b> 角色放在第一条；留空则不发送。</div>
                    </div>
                    <div class="miss-field">
                        <label for="miss-summary-prompt-p"><i class="fa-solid fa-feather"></i> 总结提示词（身份：系统，位于破限之后）</label>
                        <textarea id="miss-summary-prompt-p" class="miss-input" rows="4" placeholder="总结指令，将以系统身份发送"></textarea>
                        <div class="miss-hint">最终结构：[system 破限] → [user 摘要正文] → [system 总结指令]。</div>
                    </div>
                </div>
            </div>
    </div>`;

    // 面板不再注入扩展设置区（功能1：只在魔法棒弹窗中显示）
    // 先挂到一个隐藏容器保证 jQuery 选择器可用，openPanel 时再搬进 ST Popup
    if (!document.getElementById('missSummarySettings')) {
        const holder = document.createElement('div');
        holder.id = 'missSummaryHolder';
        holder.style.display = 'none';
        holder.innerHTML = html;
        document.body.appendChild(holder);
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
        if (attempt < 120) {
            setTimeout(() => addMenuButton(attempt + 1), 1000);
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
        // 注意：callGenericPopup 会 await 到关闭才 resolve，
        // 所以必须在调用前完成渲染
        renderAll();
        updateTokens();
        const result = await pm.callGenericPopup($(block), pm.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: '关闭',
            onClosing: () => {
                // 关闭后面板搬回隐藏容器（扩展区不再显示，功能1）
                const holder = document.getElementById('missSummaryHolder');
                if (block && holder && !holder.contains(block)) {
                    holder.appendChild(block);
                }
                return true;
            },
        });
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
        // 把面板搬回隐藏容器（扩展区不显示，功能1）
        const block = document.getElementById('missSummarySettings');
        const holder = document.getElementById('missSummaryHolder');
        if (block && holder && !holder.contains(block)) {
            holder.appendChild(block);
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
    // 兼容旧版本：将字符串或旧字段迁移为统一的 content
    st.summaries = st.summaries
        .map(item => {
            if (typeof item === 'string') {
                return { title: item.slice(0, 24), content: item };
            }
            if (!item || typeof item !== 'object') {
                return null;
            }
            const content = String(item.content ?? item.text ?? item.summary ?? '').trim();
            if (!content) {
                return null;
            }
            return { ...item, content, title: String(item.title || content.split('\n')[0]).slice(0, 24) };
        })
        .filter(Boolean);
    if (!st.hiddenMessageIds || typeof st.hiddenMessageIds !== 'object') {
        st.hiddenMessageIds = {};
    }
    st.sendFullChat = !!st.sendFullChat;
    st.captureAllRecords = !!st.captureAllRecords;
    if (!Array.isArray(st.capturedRecords)) st.capturedRecords = [];
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

// 多标签清洗：逗号/顿号分隔，逐段清洗后重新拼接（保留多标签格式）
function cleanTagList(raw) {
    const parts = String(raw ?? '')
        .split(/[,，、]/)
        .map(t => cleanTagName(t))
        .filter(Boolean);
    return [...new Set(parts)].join(',');
}

function extractRecords() {
    const ctx = getContext();
    // Bug3：支持逗号分隔的多标签（中英文逗号、顿号），每个标签独立抓取
    const rawTags = String(sSync().tag || '').trim();
    if (!rawTags || !Array.isArray(ctx.chat)) {
        return [];
    }
    const tags = [...new Set(rawTags.split(/[,，、]/).map(t => cleanTagName(t)).filter(Boolean))];
    if (!tags.length) {
        return [];
    }
    const records = [];
    ctx.chat.forEach((m, idx) => {
        if (!m || typeof m.mes !== 'string') {
            return;
        }
        for (const tag of tags) {
            const re = new RegExp(`<${escapeReg(tag)}[^>]*>([\\s\\S]*?)</\\s*${escapeReg(tag)}\\s*>`, 'gi');
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
                continue;
            }
            const content = parts.join('\n');
            const title = (content.split('\n')[0] || '').trim().slice(0, 24) || `楼层 ${idx + 1}`;            records.push({ id: `m${idx}_${tag}`, type: 'extract', title, content, floor: idx + 1, msgId: idx, tag });
        }
    });
    return records;
}

function buildUnifiedRecords() {
    const ctx = getContext();
    if (!Array.isArray(ctx?.chat)) return [];
    const rawTags = String(sSync().tag || '').trim();
    const tags = [...new Set(rawTags.split(/[,，、]/).map(t => cleanTagName(t)).filter(Boolean))];
    const records = [];
    ctx.chat.forEach((m, idx) => {
        if (!m || typeof m.mes !== 'string') return;
        const tagged = [];
        for (const tag of tags) {
            const re = new RegExp(`<${escapeReg(tag)}[^>]*>([\\s\\S]*?)</\\s*${escapeReg(tag)}\\s*>`, 'gi');
            let mm;
            while ((mm = re.exec(m.mes)) !== null) {
                const t = String(mm[1] || '').trim();
                if (t) tagged.push(t);
            }
        }
        const content = tagged.length ? tagged.join('\n') : String(m.mes).trim();
        if (!content) return;
        records.push({
            id: `m${idx}_${tagged.length ? 'tag' : 'context'}`,
            type: tagged.length ? 'extract' : 'context',
            title: tagged.length ? (content.split('\n')[0] || `楼层 ${idx + 1}`).slice(0, 24) : `楼层 ${idx + 1}（无标签正文）`,
            content, msgId: idx, floor: idx + 1, sourceMessage: m.mes
        });
    });
    return records;
}
function isRecordHidden(record) {
    const st = getStore();
    const id = String(record.msgId);
    const hiddenByPlugin = Object.prototype.hasOwnProperty.call(st.hiddenMessageIds || {}, id);
    const hiddenInChat = !!getContext()?.chat?.[record.msgId]?.is_system;
    return hiddenByPlugin || hiddenInChat;
}
function allRecords() {
    return (sSync().captureAllRecords ? buildUnifiedRecords() : extractRecords());
}
function getSummarySourceRecords() {
    const st = sSync();
    const records = (st.sendFullChat || st.captureAllRecords) ? buildUnifiedRecords() : extractRecords();
    return records.filter(r => !isRecordHidden(r));
}
function getSummaryInputRecords() {
    return getSummarySourceRecords().sort((a, b) => a.msgId - b.msgId);
}
function getTaggedContents(records = extractRecords()) {
    return records.map(record => String(record?.content || '').trim()).filter(Boolean);
}
function captureAllRecords() {
    const st = getStore();
    st.captureAllRecords = true;
    st.capturedRecords = buildUnifiedRecords();
    saveMetadata();
    renderRecords();
    toast(`✅ 已抓取 ${st.capturedRecords.length} 条统一记录（标签正文 + 无标签正文）`, 'success');
}

function summaryRecords() {
    const store = getStore();
    return store.summaries.map((it, i) => ({
        id: `s${i}`,
        type: 'summary',
        title: it.title,
        content: it.content,
        entry: it,
        floor: (typeof it.upTo === 'number' ? it.upTo : -1) + 1,
    }));
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
    $('#miss-summary-prompt-p', $drawer).val(st.summaryPrompt || '');
    $('#miss-jailbreak-prompt', $drawer).val(st.jailbreakPrompt || '');
    $('#miss-auto-chk', $drawer).prop('checked', !!st.autoSummarize);
    $('#miss-hide-floors-chk', $drawer).prop('checked', !!st.autoHideFloors);
    $('#miss-full-chat-chk', $drawer).prop('checked', !!st.sendFullChat);
    renderRecords();
    renderSummaries();
    updateTokens();
}

function renderRecords() {
    const $list = $('#miss-records-list', $drawer);
    if (!$list.length) return;
    const recs = allRecords().sort((a, b) => b.msgId - a.msgId);
    $('#miss-records-count', $drawer).text(String(recs.length));
    if (!recs.length) { $list.html('<div class="miss-hint" style="padding:8px 4px;">暂无记录 — 点击「抓取无标签正文」或先设置摘要标签。</div>'); return; }
    $list.html(recs.map(r => {
        const open = recordsOpen.has(r.id) ? ' open' : '';
        const badge = r.type === 'context' ? '无标签正文' : `楼层 ${r.floor}`;
        const isEditing = editingId === r.id;
        const body = isEditing ? `<textarea class="miss-input" data-role="edit-text" rows="6">${escapeHtml(r.content)}</textarea><div class="miss-record-editbar"><button class="miss-btn" data-act="cancel-edit">取消</button><button class="miss-btn primary" data-act="save-edit">保存修改</button></div>` : `<div class="miss-record-content">${escapeHtml(r.content).replace(/\n/g, '<br>')}</div><div class="miss-record-editbar"><button class="miss-btn" data-act="start-edit">编辑模式</button></div>`;
        return `<div class="miss-record${open}" data-id="${r.id}"><div class="miss-record-header"><span class="miss-record-title">${escapeHtml(r.title)}</span><span class="miss-record-badge">${badge}</span></div><div class="miss-record-body">${body}</div></div>`;
    }).join(''));
}

// 渲染「已总结摘要」折叠栏
function renderSummaries() {
    const $list = $('#miss-summaries-list', $drawer);
    const $count = $('#miss-summaries-count', $drawer);
    if (!$list.length) {
        return;
    }
    const recs = summaryRecords();
    if ($count.length) {
        $count.text(String(recs.length));
    }
    if (!recs.length) {
        $list.html('<div class="miss-hint" style="padding:8px 4px;">暂无已总结摘要 — 点击「立即总结」或等待自动总结。</div>');
        return;
    }
    const html = recs.map(r => {
        const open = recordsOpen.has(r.id) ? ' open' : '';
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
                <span class="miss-record-badge">总结到 ${r.floor} 楼</span>
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

async function deleteSummaryWorldInfoEntries() {
    const name = String(getContext()?.chatMetadata?.world_info || '').trim();
    if (!name) return;
    const wm = await wiMod();
    if (!wm?.loadWorldInfo || !wm?.saveWorldInfo) throw new Error('世界书模块不可用');
    const world = await wm.loadWorldInfo(name);
    if (!world?.entries) return;
    let changed = false;
    for (const [key, entry] of Object.entries(world.entries)) {
        if (String(entry?.comment || '').startsWith('Miss总结')) {
            delete world.entries[key];
            changed = true;
        }
    }
    if (changed) await wm.saveWorldInfo(name, world);
}
async function deleteAllSummaries() {
    if (!window.confirm('确定删除全部大总结内容及其世界书条目吗？聊天原文和楼层记录不会删除。')) return;
    try {
        await deleteSummaryWorldInfoEntries();
        const st = getStore();
        st.summaries = [];
        st.lastMessageId = -1;
        await saveMetadata();
        renderSummaries();
        toast('✅ 已删除全部大总结内容', 'success');
    } catch (e) {
        toast(`❌ 删除失败：${e?.message || e}`, 'error');
    }
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
        sSync().tag = cleanTagList($(this).val());
        // 输入框回显规范化后的标签名（多标签逗号分隔）
        $(this).val(sSync().tag);
        saveSettings();
        recordsOpen.clear();
        editingId = null;
        renderRecords();
    });

    $('#miss-extract-btn', $drawer).on('click', async () => {
        // 先把输入框当前值清洗同步到设置（用户可能没触发 change 就点抓取）
        sSync().tag = cleanTagList($('#miss-tag-input', $drawer).val());
        $('#miss-tag-input', $drawer).val(sSync().tag);
        saveSettings();
        if (!sSync().tag) {
            toast('❌ 摘要标签为空，请先填写标签名（如 summary 或 <summary>，支持逗号分隔多个）', 'error');
            return;
        }
        recordsOpen.clear();
        editingId = null;
        renderRecords();
        const n = extractRecords().length;
        // 标签已保存 + 抓取结果，用 ST 弹窗明确告知
        await popupConfirm(n
            ? `✅ 摘要标签已保存：「${sSync().tag}」\n\n已抓取到 ${n} 条摘要内容，可在「记忆总结」页查看。`
            : `✅ 摘要标签已保存：「${sSync().tag}」\n\n⚠️ 当前聊天中未抓取到 <${sSync().tag}>...</${sSync().tag}> 包裹的内容。`);
    });

    $('#miss-preset-select', $drawer).on('change', function () {
        sSync().boundPreset = String($(this).val() || '');
        saveSettings();
        toast(sSync().boundPreset ? `已绑定预设：${sSync().boundPreset}` : '已取消预设绑定');
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
    $('#miss-summary-prompt, #miss-summary-prompt-p', $drawer).on('change', function () {
        // 两个输入框双向同步（同一份数据，两个分类入口）
        sSync().summaryPrompt = String($(this).val() || '');
        $('#miss-summary-prompt', $drawer).val(sSync().summaryPrompt);
        $('#miss-summary-prompt-p', $drawer).val(sSync().summaryPrompt);
        saveSettings();
    });
    $('#miss-jailbreak-prompt', $drawer).on('change', function () {
        sSync().jailbreakPrompt = String($(this).val() || '');
        saveSettings();
    });
    $('#miss-auto-chk', $drawer).on('change', function () {
        sSync().autoSummarize = $(this).prop('checked');
        saveSettings();
    });
    $('#miss-hide-floors-chk', $drawer).on('change', function () {
        sSync().autoHideFloors = $(this).prop('checked');
        saveSettings();
        toast(sSync().autoHideFloors ? '✅ 自动隐藏已开启：总结过的楼层将不再发送给 AI' : '自动隐藏已关闭', 'info');
    });
    $('#miss-full-chat-chk', $drawer).on('change', function () {
        sSync().sendFullChat = $(this).prop('checked'); saveSettings();
        toast(sSync().sendFullChat ? '✅ 全文模式已开启：只发送当前未隐藏统一记录' : '已关闭全文模式', 'info');
    });
    $drawer.on('click', '#miss-capture-records-btn', () => captureAllRecords());
    $drawer.on('click', '#miss-delete-summaries-btn', e => { e.stopPropagation(); deleteAllSummaries(); });
    $('#miss-summarize-btn', $drawer).on('click', () => runSummary(true));

    // 已总结摘要折叠栏：展开/收起
    $drawer.on('click', '#miss-summaries-toggle', function () {
        $('#miss-summaries-body', $drawer).slideToggle(150);
        $(this).find('.miss-collapse-icon').toggleClass('open');
    });

    // 记录（标签抓取）折叠栏：展开/收起（功能2）
    $drawer.on('click', '#miss-records-toggle', function () {
        $('#miss-records-body', $drawer).slideToggle(150);
        $(this).find('.miss-collapse-icon').toggleClass('open');
    });
    $drawer.on('click', '#miss-summary-settings-toggle', function () {
        $('#miss-summary-settings-body', $drawer).slideToggle(150);
        $(this).find('.miss-collapse-icon').toggleClass('open');
    });

    // 两个列表共用交互（记录 + 已总结摘要）：展开收起
    $('#miss-records-list, #miss-summaries-list', $drawer).on('click', '.miss-record-header', function () {
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

    // 编辑操作：按所在列表查找记录来源
    $('#miss-records-list, #miss-summaries-list', $drawer).on('click', '[data-act]', async function (e) {
        e.stopPropagation();
        const act = $(this).data('act');
        const $rec = $(this).closest('.miss-record');
        const id = $rec.data('id');
        const $scope = $(this).closest('#miss-records-list').length ? 'records' : 'summaries';
        const rec = $scope === 'summaries'
            ? summaryRecords().find(r => r.id === id)
            : allRecords().find(r => r.id === id);
        if (!rec) {
            return;
        }
        if (act === 'start-edit') {
            editingId = id;
            $rec.addClass('open');
            recordsOpen.add(id);
            $scope === 'summaries' ? renderSummaries() : renderRecords();
            $(`#${$scope === 'summaries' ? 'miss-summaries' : 'miss-records'}-list [data-role="edit-text"]`).trigger('focus');
        } else if (act === 'cancel-edit') {
            editingId = null;
            $scope === 'summaries' ? renderSummaries() : renderRecords();
        } else if (act === 'save-edit') {
            const newText = String($rec.find('[data-role="edit-text"]').val() || '').trim();
            if (!newText) {
                toast('内容不能为空', 'warning');
                return;
            }
            await saveEdit(rec, newText);
        }
    });

    // 重新总结：把所有已总结摘要合并后再总结一次
    $drawer.on('click', '#miss-resummarize-btn', () => reSummarizeAll());
}

// 重新总结所有已总结摘要
async function reSummarizeAll() {
    const store = getStore();
    const summaries = Array.isArray(store.summaries) ? store.summaries : [];
    // 重新总结读取当前未隐藏的统一记录，不依赖旧 AI 摘要标题。
    const sourceRecords = getSummaryInputRecords();
    if (!sourceRecords.length) {
        toast('没有可重新总结的摘要标签内容', 'warning');
        return;
    }

    busy = true;
    setBusy(true);
    toast('🔄 开始重新总结…', 'info');
    const prevPreset = currentPresetName();
    try {
        const st = sSync();
        const chatText = sourceRecords.map(r => r.content).join('\n\n');

        let text, via;
        try {
            ({ text, via } = await generateSummaryText(chatText));
        } catch (e) {
            throw e;
        }
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error('重新总结失败（模型未返回内容）');
        }
        const content = text.trim();
        const title = (content.split('\n')[0] || '').trim().slice(0, 24)
            || `重总摘要 ${summaries.length + 1}`;

        // 重新总结 = 把之前所有摘要全部重新总结成一份，【替换】旧摘要列表
        // （不是在已总结的基础上追加；不推进总结点，upTo 取旧摘要最大值）
        let maxOldUpTo = -1;
        for (const s of summaries) {
            if (typeof s.upTo === 'number' && s.upTo > maxOldUpTo) {
                maxOldUpTo = s.upTo;
            }
        }
        store.summaries = [{ title, content, ts: Date.now(), upTo: maxOldUpTo, resummarized: true }];
        await saveMetadata();

        // 写入世界书
        let wiName = '';
        if (sSync().wiEnabled) {
            try {
                const wiTarget = await ensureChatWorldInfo();
                wiName = await saveSummaryToWorldInfo(wiTarget, content);
            } catch (e) {
                log('worldinfo write failed (resummarize)', e);
            }
        }

        recordsOpen.clear();
        editingId = null;
        renderSummaries();
        renderRecords();
        await updateTokens();
        await popupConfirm(
            `✅ 重新总结完成！\n\n`
            + `整合了 ${sourceRecords.length} 条当前未隐藏记录\n`
            + `生成通道：${via === 'subapi' ? '副API' : '酒馆当前API'}\n`
            + `新摘要标题：${title}\n`
            + (wiName ? `已写入世界书：「${wiName}」` : ''),
        );
    } catch (e) {
        console.error('[MissSummary] resummarize failed', e);
        toast(`❌ 重新总结失败：${e?.message || e}`, 'error');
    } finally {
        busy = false;
        setBusy(false);
        if (st_b() && prevPreset) {
            setTimeout(() => applyPreset(prevPreset).catch(() => { }), 50);
        }
    }
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

// 同步隐藏状态到聊天 DOM（与 ST /hide 行为一致，幽灵图标 .mes_ghost 随 is_system 属性显示）
function markMessageHiddenDom(messageId, hidden) {
    try {
        const block = window.jQuery(`.mes[mesid="${messageId}"]`);
        if (block.length) {
            block.attr('is_system', String(hidden));
        }
    } catch { /* ignore */ }
}

function restorePluginHiddenMessages(chat, store) {
    const hidden = store.hiddenMessageIds || {};
    let changed = false;
    for (const [rawId, original] of Object.entries(hidden)) {
        const id = Number(rawId);
        const message = chat[id];
        if (message) {
            message.is_system = !!original;
            markMessageHiddenDom(id, !!original);
            changed = true;
        }
        delete hidden[rawId];
    }
    return changed;
}

function hideMessageByPlugin(message, id, store) {
    store.hiddenMessageIds = store.hiddenMessageIds || {};
    if (!Object.prototype.hasOwnProperty.call(store.hiddenMessageIds, String(id))) {
        store.hiddenMessageIds[String(id)] = !!message.is_system;
    }
    message.is_system = true;
    markMessageHiddenDom(id, true);
}

async function onGeneration() {
    const st = sSync();
    const keep = Number(st.keepVisibleFloors) || 0;
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (!chat.length) {
        return;
    }

    const store = getStore();
    let changed = restorePluginHiddenMessages(chat, store);

    if (st.autoHideFloors) {
        // ===== 自动隐藏（用户最终规则：总结确认后，只保留最近一层角色的所有聊天内容，
        //       该角色楼之后的用户楼层也保留，其余全部隐藏含摘要不注入）=====
        // 从尾部往前找最近 1 个角色楼层，保留起点 = 它；之前全部隐藏（含用户楼）
        let counted = 0;
        let keepStartIdx = chat.length;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system) {
                counted++;
                keepStartIdx = i;
                if (counted >= 1) {
                    break;
                }
            }
        }
        for (let i = 0; i < keepStartIdx; i++) {
            const m = chat[i];
            if (m && !m.is_system) {
                hideMessageByPlugin(m, i, store);
                changed = true;
            }
        }
        if (changed) {
            log(`自动隐藏：只保留最近一层角色内容（第 ${keepStartIdx} 楼起），之前全部隐藏（含用户楼层与摘要）`);
        }
    } else if (keep > 0 && chat.length > keep) {
        // ===== 自定义隐藏楼层 N（用户最终规则）=====
        // 保留最近 N 个角色楼层 + 这段区间内的用户楼层（跟随之），其余全部隐藏只显示摘要
        // 例（keep=2）：0角(隐,摘要) 1用(隐) 2角(隐,摘要) 3用(隐) 4角(留) 5用(留) 6角(留)
        // 从尾部往前数 N 个角色楼层，保留起点 = 第 N 个角色楼；它之前的全部隐藏（含用户楼）
        let counted = 0;
        let keepStartIdx = chat.length; // 保留区间起点（之前全部隐藏）
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system) {
                counted++;
                keepStartIdx = i;
                if (counted >= keep) {
                    break;
                }
            }
        }
        // 隐藏 0 .. keepStartIdx-1（含用户楼层与更早的角色楼层）
        for (let i = 0; i < keepStartIdx; i++) {
            const m = chat[i];
            if (m && !m.is_system) {
                hideMessageByPlugin(m, i, store);
                changed = true;            }
        }
        if (changed) {
            log(`自定义隐藏楼层：保留最近 ${keep} 个角色楼层及其间的用户楼层（第 ${keepStartIdx} 楼起），之前全部隐藏（只显示摘要）`);
        }
    }

    if (changed) {
        await saveMetadata();
    }

    try {        // 注入摘要规则（功能4 最终版）：
        // - 自动隐藏开启 → 不注入摘要（什么也不给）
        // - 自定义隐藏楼层 → 注入摘要（补全被隐藏楼层的内容）
        const injectEnabled = !st.autoHideFloors;
        const pt = await getPromptTypesAsync();
        const pr = await getPromptRolesAsync();
        const sep = await getSetExtensionPrompt();
        const texts = injectEnabled ? getStore().summaries.map(x => x.content).filter(Boolean) : [];
        if (texts.length) {
            // 直接注入摘要正文（不加插件内置的前缀/说明，遵守提示词只由用户规定）
            const injection = texts.join('\n---\n');
            sep(MODULE, injection, pt.IN_CHAT, 4, false, pr.SYSTEM);
        } else {
            sep(MODULE, '', pt.NONE, 0);
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
    const newCount = new Set(extractRecords()
        .filter(record => record.msgId > lastId)
        .map(record => record.msgId)).size;

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
            toast('⏳ 正在总结中，请稍候…', 'warning');
        }
        return;
    }
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (!chat.length) {
        if (manual) {
            toast('❌ 当前没有可总结的聊天记录', 'error');
        }
        return;
    }

    const stPre = sSync();
    const hasSubApi = stPre.subApi?.url && normalizeSubUrl(stPre.subApi.url);
    // 副API 与 主API 都不可用 → 提前明确告知（不默默失败）
    if (!hasSubApi && !window.__missApiChecked) {
        // 主API连接状态从 ST 全局读取（online_status !== 'no_connection'）
        try {
            const mod = await getSTModule();
            const online = String(mod?.online_status || '');
            if (online === 'no_connection') {
                toast('❌ 未连接任何API（副API未填写，主API未连接），无法总结。请先在副API设置中连接，或连接酒馆主API。', 'error');
                return;
            }
        } catch { /* 无法判断时不拦截 */ }
    }

    busy = true;
    setBusy(true);
    if (manual) {
        toast('🚀 开始总结…', 'info');
    }
    const prevPreset = currentPresetName();
    try {
        const st = sSync();
        const store = getStore();
        const lastId = typeof store.lastMessageId === 'number' ? store.lastMessageId : -1;

        // 统一记录按楼层升序发送；隐藏楼层始终排除。
        let allRecords = getSummaryInputRecords();
        const useFull = !!st.sendFullChat || !!st.captureAllRecords;
        if (!useFull) allRecords = allRecords.filter(r => r.msgId > lastId);
        if (!allRecords.length) {
            if (manual) {
                toast('没有新的摘要内容需要总结', 'info');
            }
            return;
        }
        // 本次实际总结覆盖到的最后一楼（用于下次总结起点与隐藏范围）
        const lastSummarizedFloor = Math.max(...allRecords.map(r => r.msgId));

        // 只发送正文，标题仅用于界面显示。
        const chatText = allRecords.map(r => r.content).join('\n\n');
        // 提示词结构由 buildSummaryMessages 构造
        const prompt = chatText;

        if (st.boundPreset) {
            const ok = await applyPreset(st.boundPreset);
            if (!ok) {
                toast(`⚠️ 未找到预设「${st.boundPreset}」，使用当前预设总结`);
            }
        }

        let text, via;
        try {
            ({ text, via } = await generateSummaryText(prompt));
        } catch (e) {
            log('generateSummaryText failed', e);
            throw e;
        }
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error('总结生成失败（模型未返回内容）');
        }
        const content = text.trim();
        const title = (content.split('\n')[0] || '').trim().slice(0, 24)
            || `摘要 ${store.summaries.length + 1}`;
        store.summaries.push({ title, content, ts: Date.now(), upTo: lastSummarizedFloor });
        store.lastMessageId = lastSummarizedFloor;
        await saveMetadata();

        // 功能2：自动写入聊天世界书
        let wiName = '';
        if (sSync().wiEnabled) {
            try {
                const wiTarget = await ensureChatWorldInfo();
                wiName = await saveSummaryToWorldInfo(wiTarget, content);
            } catch (e) {
                log('worldinfo write failed', e);
                toast(`⚠️ 世界书写入失败：${e?.message || e}`, 'warning');
            }
        }

        renderRecords();
        await updateTokens();

        // 勾选自动隐藏时，完成总结后立即应用隐藏规则，不等待下一次生成
        if (sSync().autoHideFloors) {
            await onGeneration();
            toast('✅ 已立即隐藏旧楼层（摘要通过世界书保留）', 'success');
        } else if (manual) {
            await popupConfirm(
                `✅ 总结已完成！\n\n`
                + `生成通道：${via === 'subapi' ? '副API' : '酒馆当前API'}\n`
                + `摘要标题：${title}\n`
                + (wiName ? `已写入世界书：「${wiName}」（已绑定聊天世界书，条目蓝灯@D999）\n\n摘要可在「记忆总结」页查看。` : '\n摘要已存入记录。'),
            );
        }
        // 未勾选自动隐藏时，保留原有的手动确认流程
        if (!sSync().autoHideFloors) {
            const wantHide = await popupYesNo(
                `总结已完成并写入世界书。\n\n是否要隐藏以上所有楼层（包括摘要）？\n`
                + `选择「是」：只保留最近一层角色的所有聊天内容，其余楼层与摘要全部隐藏。\n`
                + `选择「否」：保留所有楼层，仅按「隐藏楼层」设置正常隐藏。`,
            );
            if (wantHide) {
                sSync().autoHideFloors = true;
                saveSettings();
                if ($drawer && $drawer.length) {
                    $('#miss-hide-floors-chk', $drawer).prop('checked', true);
                }
                await onGeneration();
                toast('✅ 已隐藏以上楼层（含摘要），只保留最近一层角色内容', 'success');
            }
        }
    } catch (e) {
        console.error('[MissSummary] summarize failed', e);
        toast(`❌ 总结失败：${e?.message || e}`, 'error');
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

// ---------------- 世界书 ----------------
// 依赖 world-info.js：loadWorldInfo / saveWorldInfo / world_info_position
// 聊天世界书绑定 = chat_metadata.world_info（METADATA_KEY）

let _wiMod = null;
async function wiMod() {
    if (_wiMod) {
        return _wiMod;
    }
    try {
        _wiMod = await import('../../../world-info.js');
    } catch (e) {
        log('world-info.js import failed', e);
    }
    return _wiMod;
}

function nextWiCounter() {
    const st = sSync();
    st.wiCounter = Number(st.wiCounter) || 0;
    st.wiCounter += 1;
    saveSettings();
    return st.wiCounter;
}

/**
 * 将总结内容写入世界书：
 * - 世界书名 = 传入的 name（如「总结1」，数字按总结次数递增）
 * - 条目开蓝灯（constant=true，常驻注入）
 * - 位置 = atDepth(4)，depth = 999（系统插入深度@D999）
 * - 自动绑定到当前聊天的「聊天世界书」（chat_metadata.world_info）
 */
/**
 * 解析总结要写入的世界书名（功能3 智能绑定）：
 * 1. 当前聊天已绑定聊天世界书 → 直接注入该世界书（第一优先）
 * 2. 未绑定 → 自动创建「{角色名}总结世界书」并绑定为聊天世界书
 */
async function ensureChatWorldInfo() {
    const wm = await wiMod();
    if (!wm?.loadWorldInfo || !wm?.saveWorldInfo) {
        throw new Error('world-info 模块不可用');
    }
    const ctx = getContext();
    if (!ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') {
        ctx.chatMetadata = {};
    }
    // 1) 已绑定聊天世界书：直接复用
    const bound = String(ctx.chatMetadata.world_info || '').trim();
    if (bound) {
        return bound;
    }
    // 2) 未绑定：创建「{角色名}总结世界书」
    const charName = String(ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '').trim() || '角色';
    const baseName = `${charName}总结世界书`;
    // 重名处理：已存在同名全局文件时追加序号（带上限防死循环）
    let name = baseName;
    let n = 2;
    const MAX_TRIES = 50;
    while (n - 2 < MAX_TRIES && await worldExists(name)) {
        name = `${baseName}${n}`;
        n++;
    }
    await wm.saveWorldInfo(name, { entries: {} }, true);
    try {
        if (typeof wm.updateWorldInfoList === 'function') {
            await wm.updateWorldInfoList();
        }
    } catch { /* ignore */ }
    // 绑定为聊天世界书
    ctx.chatMetadata.world_info = name;
    try {
        const mod = await getSTModule();
        if (mod?.saveMetadata) {
            await mod.saveMetadata();
        }
        if (window.jQuery) {
            window.jQuery('.chat_lorebook_button').addClass('world_set');
        }
    } catch (e) {
        log('auto bind chat world failed', e);
    }
    toast(`📖 角色卡未绑定聊天世界书，已自动创建「${name}」并绑定`, 'info');
    return name;
}

async function worldExists(name) {
    try {
        // 注意：loadWorldInfo 对不存在的文件后端返回 {entries:{}}（HTTP 200），
        // 无法用于探测存在性！改用 ST 的 world_names 列表（/api/settings/get 拉取）
        const mod = await getSTModule();
        const headers = mod.getRequestHeaders ? mod.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/settings/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
        });
        if (!resp.ok) {
            return false;
        }
        const data = await resp.json().catch(() => ({}));
        const names = Array.isArray(data?.world_names) ? data.world_names : [];
        return names.includes(String(name));
    } catch {
        return false;
    }
}

async function saveSummaryToWorldInfo(name, content) {
    const wm = await wiMod();
    if (!wm?.loadWorldInfo || !wm?.saveWorldInfo) {
        throw new Error('world-info 模块不可用');
    }
    const ctx = getContext();
    // 世界书内容：可能已存在（同名则追加条目）
    let data = null;
    try {
        data = await wm.loadWorldInfo(name);
    } catch { /* 不存在 */ }
    if (!data || typeof data !== 'object' || !data.entries) {
        data = { entries: {} };
    }
    // 插件只维护一个摘要条目，避免每次总结都把旧摘要重复注入
    const managed = Object.entries(data.entries)
        .filter(([, entry]) => String(entry?.comment || '').startsWith('Miss总结'));
    const numericUids = Object.keys(data.entries).map(Number).filter(Number.isInteger);
    const uid = managed.length
        ? Number(managed[0][0])
        : (numericUids.length ? Math.max(...numericUids) + 1 : 0);
    for (const [oldUid] of managed.slice(1)) {
        delete data.entries[oldUid];
    }
    const pos = wm.world_info_position?.atDepth ?? 4;
    data.entries[uid] = {
        uid,
        key: [],
        keysecondary: [],
        comment: 'Miss总结（自动维护）',
        content: String(content || ''),
        constant: true,        // 蓝灯：常驻
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: pos,         // @D 系统插入深度
        depth: 999,            // 插入深度 999
        role: 0,               // system
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        probability: 100,
        useProbability: true,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        sticky: null,
        cooldown: null,
        delay: null,
    };
    await wm.saveWorldInfo(name, data, true);

    // 刷新 ST 世界书下拉列表（否则新世界书在 UI 列表里看不到）
    try {
        if (typeof wm.updateWorldInfoList === 'function') {
            await wm.updateWorldInfoList();
        }
    } catch (e) {
        log('updateWorldInfoList failed', e);
    }

    // 绑定为聊天世界书（不是角色世界书、不是全局）
    try {
        const ctx2 = getContext();
        if (ctx2 && typeof ctx2 === 'object') {
            if (!ctx2.chatMetadata || typeof ctx2.chatMetadata !== 'object') {
                ctx2.chatMetadata = {};
            }
            ctx2.chatMetadata.world_info = name;
        }
        const mod = await getSTModule();
        if (mod?.saveMetadata) {
            await mod.saveMetadata();
        }
        // 刷新世界书下拉与聊天绑定状态
        try {
            const es = await getEventSource();
            const et = await getEventTypes();
            if (es && et?.WORLDINFO_UPDATED && es.emit) {
                await es.emit(et.WORLDINFO_UPDATED, name, data);
            }
        } catch { /* ignore */ }
        if (typeof $ === 'function' && window.jQuery) {
            window.jQuery('.chat_lorebook_button').addClass('world_set');
        }
    } catch (e) {
        log('chat world bind failed', e);
    }
    return name;
}

// ---------------- 编辑摘要 ----------------

async function saveEdit(rec, newText) {
    const ctx = getContext();
    if (rec.type === 'extract') {
        const m = ctx.chat?.[rec.msgId];
        if (m && typeof m.mes === 'string' && m.mes.includes(rec.content)) {
            m.mes = m.mes.replace(rec.content, newText);
            ctx.saveChat?.();
        }
    } else if (rec.type === 'context') {
        const m = ctx.chat?.[rec.msgId];
        if (m) { m.mes = newText; ctx.saveChat?.(); }
    } else if (rec.entry) {
        rec.entry.content = newText;
        await saveMetadata();
        if (sSync().wiEnabled) {
            try {
                const wiTarget = await ensureChatWorldInfo();
                await saveSummaryToWorldInfo(wiTarget, newText);
            } catch (e) {
                log('worldinfo write failed (edit)', e);
            }
        }
    }
    editingId = null;
    renderRecords();
    updateTokens();
    toast('✅ 已保存并覆盖到聊天');
}

// ---------------- 副API ----------------
// 走 ST 后端代理：/api/backends/chat-completions/generate + chat_completion_source=custom
// 密钥通过 /api/secrets/write 写入 api_key_custom，由后端读取

function normalizeSubUrl(url) {
    let u = String(url || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) {
        u = `http://${u}`;
    }
    return u;
}

async function writeSecretKey(key) {
    try {
        const mod = await getSTModule();
        const headers = mod.getRequestHeaders ? mod.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/secrets/write', {
            method: 'POST',
            headers,
            body: JSON.stringify({ key: 'api_key_custom', value: String(key || '') }),
        });
        return resp.ok;
    } catch (e) {
        log('writeSecretKey failed', e);
        return false;
    }
}

function parseSseContent(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) {
        return '';
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
        return '';
    }
    try {
        const chunk = JSON.parse(payload);
        return chunk?.choices?.[0]?.delta?.content
            ?? chunk?.choices?.[0]?.text
            ?? '';
    } catch {
        return '';
    }
}

async function subApiGenerate(messages, options = {}) {
    const st = sSync();
    const cfg = st.subApi || {};
    const url = normalizeSubUrl(cfg.url);
    if (!url) {
        throw new Error('副API地址为空');
    }
    const source = String(cfg.source || 'custom');
    // 先写入密钥到 ST secrets（CUSTOM 源从后端读取）
    if (cfg.key) {
        await writeSecretKey(cfg.key);
    }
    const stream = !!cfg.stream;
    // max_tokens / temperature：跟随酒馆当前设置（测试调用可显式覆盖）
    let maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : undefined;
    let temperature;
    try {
        const mod = await getSTModule();
        const oai = mod?.oai_settings;
        // openai_max_tokens = 酒馆「回复长度」；temp_openai = 酒馆「温度」
        const ot = Number(oai?.openai_max_tokens);
        if (maxTokens === undefined && Number.isFinite(ot) && ot > 0) {
            maxTokens = ot;
        }
        const tp = Number(oai?.temp_openai);
        if (Number.isFinite(tp)) {
            temperature = tp;
        }
    } catch { /* 取不到就跟随 API 默认 */ }
    // 用户在副API设置里自定义了温度则覆盖酒馆值
    const userTemp = Number(cfg.temperature);
    if (Number.isFinite(userTemp)) {
        temperature = userTemp;
    }
    const body = {
        chat_completion_source: source,
        model: String(cfg.model || 'gpt-4o-mini'),
        messages,
        max_tokens: maxTokens,
        temperature,
        stream,
        custom_url: url,
        custom_include_headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : undefined,
    };
    const mod = await getSTModule();
    const headers = mod.getRequestHeaders ? mod.getRequestHeaders() : { 'Content-Type': 'application/json' };
    const resp = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    // 流式：聚合 SSE 分片直到 [DONE]
    if (stream && resp.ok && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                text += parseSseContent(line);
            }
        }
        if (buffer.trim()) {
            text += parseSseContent(buffer);
        }
        const out = String(text || '').trim();
        if (!out) {
            throw new Error('副API流式返回为空');
        }
        return out;
    }

    // 非流式
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
        throw new Error(data?.error?.message || data?.response || `HTTP ${resp.status}`);
    }
    const text = data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.content?.[0]?.text
        ?? '';
    const out = String(text || '').trim();
    if (!out) {
        throw new Error('副API未返回内容');
    }
    return out;
}

async function subApiTest() {
    try {
        const out = await subApiGenerate(
            [{ role: 'user', content: '请只回复两个字：连接成功' }],
            { maxTokens: 30 },
        );
        return { ok: true, text: out.slice(0, 60) };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

async function subApiFetchModels() {
    try {
        const st = sSync();
        const cfg = st.subApi || {};
        const url = normalizeSubUrl(cfg.url);
        if (!url) {
            return { ok: false, error: '副API地址为空' };
        }
        const source = String(cfg.source || 'custom');
        if (cfg.key) {
            await writeSecretKey(cfg.key);
        }
        const mod = await getSTModule();
        const headers = mod.getRequestHeaders ? mod.getRequestHeaders() : { 'Content-Type': 'application/json' };
        // 复用后端 status 端点拉取模型列表（source=custom 时读 custom_url）
        const resp = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                chat_completion_source: source,
                reverse_proxy: url,
                proxy_password: cfg.key || '',
                custom_url: url,
                custom_include_headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : undefined,
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) {
            throw new Error(data?.error?.message || `HTTP ${resp.status}`);
        }
        const ids = (data?.data || [])
            .map(m => m?.id || m?.model || m?.name)
            .filter(Boolean);
        return { ok: true, models: [...new Set(ids)].sort() };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

// 构造总结消息数组：破限提示词 → 摘要信息 → 总结提示词
function buildSummaryMessages(chatText) {
    const st = sSync();
    const msgs = [];
    const jb = String(st.jailbreakPrompt || '').trim();
    const sp = String(st.summaryPrompt || '').trim();

    if (jb) {
        msgs.push({ role: 'system', content: jb });
    }
    // 摘要正文必须位于两个提示词之间
    msgs.push({ role: 'user', content: chatText });
    if (sp) {
        msgs.push({ role: 'system', content: sp });
    }
    return msgs;
}

// 总结时选用的生成通道：副API → 酒馆当前 API
async function generateSummaryText(chatText) {
    const st = sSync();
    const messages = buildSummaryMessages(chatText);

    if (st.subApi?.url) {
        try {
            return { text: await subApiGenerate(messages), via: 'subapi' };
        } catch (e) {
            log('subApi generate failed, fallback to ST API', e);
            toast(`⚠️ 副API失败（${e?.message || e}），改用酒馆当前API`, 'warning');
        }
    }
    // 主 API 按 messages 原顺序拼接，保持：破限提示词 → 摘要信息 → 总结提示词
    const prompt = messages.map(message => message.content).filter(Boolean).join('\n\n');
    const ctx = getContext();
    let out;
    try {
        // responseLength：给总结留足输出空间（覆盖酒馆回复长度设置，避免总结被截断）
        out = await ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: 1024 });
    } catch (e) {
        log('object-arg generateQuietPrompt failed', e);
    }
    if (typeof out !== 'string' || !out.trim()) {
        try {
            out = await ctx.generateQuietPrompt(prompt, false, false, null, null, 1024);
        } catch (e) {
            log('positional generateQuietPrompt failed', e);
        }
    }
    if (typeof out !== 'string' || !out.trim()) {
        throw new Error('总结生成失败（模型未返回内容）');
    }
    return { text: out.trim(), via: 'main' };
}

// ---------------- 副API UI ----------------

function renderSubApi() {
    if (!$drawer || !$drawer.length) {
        return;
    }
    const st = sSync();
    const cfg = st.subApi || {};
    $('#miss-subapi-type', $drawer).val(cfg.type || 'openai');
    $('#miss-subapi-source', $drawer).val(cfg.source || 'custom');
    $('#miss-subapi-url', $drawer).val(cfg.url || '');
    $('#miss-subapi-key', $drawer).val(cfg.key || '');
    $('#miss-subapi-model', $drawer).val(cfg.model || '');
    $('#miss-subapi-stream-chk', $drawer).prop('checked', !!cfg.stream);
    $('#miss-subapi-temperature', $drawer).val(cfg.temperature ?? '');
    $('#miss-subapi-source-row', $drawer).toggle(String(cfg.type || 'openai') === 'openai');
    // 已保存列表
    const names = Object.keys(st.subApiSaved || {});
    const $sel = $('#miss-subapi-saved-select', $drawer);
    $sel.empty().append('<option value="">— 选择已保存的副API —</option>');
    for (const n of names) {
        $sel.append($('<option></option>').val(n).text(n));
    }
    $sel.val(st.subApiActive && names.includes(st.subApiActive) ? st.subApiActive : '');
    // 状态行
    const $status = $('#miss-subapi-status', $drawer);
    if (cfg.connected) {
        $status.html(`<span style="color:var(--green,#4caf50);">● 已连接</span> ${escapeHtml(cfg.model || cfg.url || '')}（总结时将使用此副API）`);
    } else {
        $status.text('未连接。总结时如已填写副API将使用它生成摘要；未填写则使用酒馆当前连接的API。');
    }
}

function readSubApiForm() {
    const st = sSync();
    st.subApi = st.subApi || { type: 'openai', source: 'custom', url: '', key: '', model: '', connected: false, stream: false };
    st.subApi.type = 'openai';
    st.subApi.source = String($('#miss-subapi-source', $drawer).val() || 'custom');
    st.subApi.url = normalizeSubUrl($('#miss-subapi-url', $drawer).val());
    st.subApi.key = String($('#miss-subapi-key', $drawer).val() || '');
    st.subApi.model = String($('#miss-subapi-model', $drawer).val() || '').trim();
    st.subApi.stream = $('#miss-subapi-stream-chk', $drawer).prop('checked');
    const rawTemp = $('#miss-subapi-temperature', $drawer).val();
    st.subApi.temperature = rawTemp === '' || rawTemp == null ? '' : Math.min(2, Math.max(0, Number(rawTemp)));
    return st.subApi;
}

function bindSubApiUi() {
    // 折叠条展开/收起
    $drawer.on('click', '#miss-subapi-toggle', function () {
        $('#miss-subapi-body', $drawer).slideToggle(150);
        $(this).find('.miss-collapse-icon').toggleClass('open');
    });
    $drawer.on('click', '#miss-subapi-saved-toggle', function () {
        $('#miss-subapi-saved-body', $drawer).slideToggle(150);
        $(this).find('.miss-collapse-icon').toggleClass('open');
    });

    $drawer.on('change', '#miss-subapi-type', function () {
        readSubApiForm();
        saveSettings();
        renderSubApi();
    });
    $drawer.on('change', '#miss-subapi-source, #miss-subapi-url, #miss-subapi-key, #miss-subapi-model, #miss-subapi-temperature', function () {
        readSubApiForm();
        saveSettings();
    });
    $drawer.on('change', '#miss-subapi-stream-chk', function () {
        readSubApiForm();
        saveSettings();
        toast(sSync().subApi.stream ? '✅ 总结流式传输已开启' : '总结流式传输已关闭');
    });

    $drawer.on('click', '#miss-subapi-connect-btn', async function () {
        const $btn = $(this);
        $btn.prop('disabled', true);
        readSubApiForm();
        const st = sSync();
        st.subApi.connected = false;
        saveSettings();
        renderSubApi();
        try {
            const r = await subApiTest();
            if (r.ok) {
                sSync().subApi.connected = true;
                saveSettings();
                renderSubApi();
                toast(`✅ 副API连接成功：${r.text}`);
            } else {
                renderSubApi();
                toast(`❌ 连接失败：${r.error}`);
            }
        } finally {
            $btn.prop('disabled', false);
        }
    });

    $drawer.on('click', '#miss-subapi-test-btn', async function () {
        const $btn = $(this);
        $btn.prop('disabled', true);
        readSubApiForm();
        try {
            const r = await subApiTest();
            toast(r.ok ? `✅ 测试消息返回：${r.text}` : `❌ 测试失败：${r.error}`);
            if (r.ok) {
                sSync().subApi.connected = true;
                saveSettings();
                renderSubApi();
            }
        } finally {
            $btn.prop('disabled', false);
        }
    });

    $drawer.on('click', '#miss-subapi-models-btn', async function () {
        const $btn = $(this);
        $btn.prop('disabled', true);
        readSubApiForm();
        try {
            const r = await subApiFetchModels();
            if (!r.ok) {
                toast(`❌ 拉取模型失败：${r.error}`);
                return;
            }
            if (!r.models?.length) {
                toast('未拉取到模型列表');
                return;
            }
            const $input = $('#miss-subapi-model', $drawer);
            const current = String($input.val() || '');
            // 拉取到的模型替换为下拉选择（保留手输能力：双击还原为 input）
            const $sel = $('<select id="miss-subapi-model" class="miss-input"></select>');
            for (const m of r.models) {
                $sel.append($('<option></option>').val(m).text(m));
            }
            $sel.val(current && r.models.includes(current) ? current : r.models[0]);
            $input.replaceWith($sel);
            readSubApiForm();
            saveSettings();
            toast(`✅ 已拉取 ${r.models.length} 个模型`);
            // 换回文本框：双击下拉框
            $sel.on('dblclick', () => {
                const v = String($sel.val() || '');
                const $inp = $('<input id="miss-subapi-model" class="miss-input" type="text" placeholder="模型名，或点右侧拉取">').val(v);
                $sel.replaceWith($inp);
            });
        } finally {
            $btn.prop('disabled', false);
        }
    });

    // 保存当前副API配置
    $drawer.on('click', '#miss-subapi-save-btn', async () => {
        const name = String($('#miss-subapi-save-name', $drawer).val() || '').trim()
            || autoSubApiName();
        const st = sSync();
        st.subApiSaved = st.subApiSaved || {};
        readSubApiForm();
        st.subApiSaved[name] = {
            type: st.subApi.type,
            source: st.subApi.source,
            url: st.subApi.url,
            key: st.subApi.key,
            model: st.subApi.model,
            connected: !!st.subApi.connected,
            stream: !!st.subApi.stream,
            temperature: st.subApi.temperature ?? '',
            savedAt: Date.now(),
        };
        st.subApiActive = name;
        saveSettings();
        $('#miss-subapi-save-name', $drawer).val('');
        renderSubApi();
        toast(`✅ 已保存副API「${name}」并启用`);
    });

    // 切换副API
    $drawer.on('change', '#miss-subapi-saved-select', async function () {
        const name = String($(this).val() || '');
        if (!name) {
            return;
        }
        await applySubApiSnapshot(name);
    });

    // 删除所选副API
    $drawer.on('click', '#miss-subapi-saved-delete', () => {
        const st = sSync();
        const name = String($('#miss-subapi-saved-select', $drawer).val() || '');
        if (!name || !st.subApiSaved?.[name]) {
            toast('请先在下方选择栏选择一个已保存的副API');
            return;
        }
        delete st.subApiSaved[name];
        if (st.subApiActive === name) {
            st.subApiActive = '';
        }
        saveSettings();
        renderSubApi();
        toast(`已删除副API「${name}」`);
    });
}

function autoSubApiName() {
    const st = sSync();
    const taken = new Set(Object.keys(st.subApiSaved || {}));
    for (let i = 1; i <= 10; i++) {
        if (!taken.has(String(i))) {
            return String(i);
        }
    }
    let n = 11;
    while (taken.has(String(n))) {
        n++;
    }
    return String(n);
}

async function applySubApiSnapshot(name) {
    const st = sSync();
    const snap = st.subApiSaved?.[name];
    if (!snap) {
        return;
    }
    st.subApi = {
        type: snap.type || 'openai',
        source: snap.source || 'custom',
        url: snap.url || '',
        key: snap.key || '',
        model: snap.model || '',
        connected: !!snap.connected,
        stream: !!snap.stream,
        temperature: snap.temperature ?? '',
    };
    st.subApiActive = name;
    saveSettings();
    renderSubApi();
    toast(`已切换到副API「${name}」`);
}

// ---------------- 弹窗 / 提示 ----------------
// 统一使用 SillyTavern 自带通知（toastr）与弹窗（callGenericPopup）

function toastrFn() {
    return window.toastr || null;
}

// info/success/warning/error 四级通知，全部走 ST 自带 toastr
function toast(msg, type = 'info') {
    const t = toastrFn();
    if (t && typeof t[type] === 'function') {
        t[type](String(msg), 'Miss总结', { timeOut: 4000, preventDuplicates: false });
        return;
    }
    // 极端兜底：toastr 不可用时走 ST Popup
    popupMod().then(pm => {
        if (pm?.callGenericPopup && pm?.POPUP_TYPE?.TEXT) {
            pm.callGenericPopup(String(msg), pm.POPUP_TYPE.TEXT, '', { okButton: '确定' });
        } else {
            console.log('[MissSummary toast]', msg);
        }
    });
}

// 需要用户确认的重要结果弹窗（ST 自带样式）
async function popupConfirm(message) {
    const pm = await popupMod();
    if (pm?.callGenericPopup && pm?.POPUP_TYPE?.TEXT) {
        await pm.callGenericPopup(String(message), pm.POPUP_TYPE.TEXT, '', { okButton: '确定' });
        return;
    }
    toastrFn()?.info?.(String(message), 'Miss总结');
}

// 是/否询问弹窗（ST 原生 CONFIRM），返回 true=用户点是
async function popupYesNo(message) {
    const pm = await popupMod();
    if (pm?.callGenericPopup && pm?.POPUP_TYPE?.CONFIRM) {
        const r = await pm.callGenericPopup(String(message), pm.POPUP_TYPE.CONFIRM, '', {
            okButton: '是，隐藏并只保留最近一层角色内容',
            cancelButton: '否，保留所有楼层',
        });
        return r === pm.POPUP_RESULT?.AFFIRMATIVE || r === 1 || r === true;
    }
    toastrFn()?.info?.(String(message), 'Miss总结');
    return false;
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

