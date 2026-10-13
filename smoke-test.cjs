const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync('index.js', 'utf8')
    .replace(/^import \{ getContext \} from '[^']+';\s*/m, '');
new vm.Script(source, { filename: 'index.js' });

let ready;
let menuInserted = false;
const rendered = {};
const timers = [];
const chat = [
    { mes: '开场白' },
    { mes: '剧情片段<summary>一号摘要</summary><memory>另一个标签</memory>' },
    { mes: '无标签正文' },
    { mes: '<summary>隐藏摘要</summary>', is_system: true },
];
const context = {
    chat,
    chatMetadata: {
        missSummary: { summaries: [], lastMessageId: -1, hiddenMessageIds: { '3': false } },
    },
};
const jquery = arg => {
    if (typeof arg === 'function') {
        ready = arg;
        return;
    }
    return {
        on() { return this; }, is() { return false; }, each() { return this; }, hide() { return this; }, length: 1,
        html(value) { if (value !== undefined) rendered[arg] = value; return this; },
        text(value) { if (value !== undefined) rendered[arg] = value; return this; },
    };
};
const sandbox = {
    console: { log() {}, error() {} },
    window: { jQuery: jquery },
    jQuery: jquery,
    getContext: () => context,
    document: {
        getElementById: id => id === 'extensionsMenu'
            ? { insertAdjacentHTML: () => { menuInserted = true; } }
            : null,
    },
    setTimeout: fn => { timers.push(fn); },
    TextDecoder,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'index.js' });
vm.runInContext("_settings = { tag: 'summary,memory', sendFullChat: true, captureAllRecords: false }", sandbox);

const unified = vm.runInContext('buildUnifiedRecords()', sandbox);
assert.equal(unified.length, 4);
assert.equal(unified[1].content, '一号摘要\n另一个标签');
assert.equal(unified[2].content, '无标签正文');
assert.equal(unified[1].msgId, 1);
assert.equal(unified[2].title, '无标签正文');
vm.runInContext('getStore().captureAllRecords = true; _settings.sendFullChat = false', sandbox);
assert.deepEqual(Array.from(vm.runInContext('allRecords()', sandbox), r => r.msgId), [0, 1, 2, 3]);
assert.equal(vm.runInContext('currentSummaryMode()', sandbox), 'unified');
vm.runInContext('_settings.sendFullChat = true', sandbox);

const sent = vm.runInContext('getSummaryInputRecords()', sandbox);
assert.deepEqual(Array.from(sent, r => r.msgId), [0, 1, 2]);
assert.equal(sent.some(r => r.msgId === 3), false);
assert.equal(sent[1].content.includes('剧情片段'), true, 'full mode must include chat text outside tags');
assert.equal(sent[1].content.includes('一号摘要'), true);
assert.equal(sent[1].content.match(/一号摘要/g).length, 1, 'tag content must not be duplicated');
vm.runInContext("_settings.jailbreakPrompt = '破限'; _settings.summaryPrompt = '总结'", sandbox);
const messages = vm.runInContext("buildSummaryMessages('正文')", sandbox);
assert.deepEqual(Array.from(messages, m => m.content), ['破限', '正文', '总结']);

vm.runInContext('s = async () => { throw new Error("settings unavailable") }', sandbox);
ready();
assert.equal(menuInserted, true, 'settings failure must not block menu insertion');

(async () => {
    await reviewRegression();
    await connectionRegression();
    // 副API请求与同时进行的主聊天只读取各自的认证，不写共享 secrets。
    const mainConfig = Object.freeze({ temp_openai: 0.8, openai_max_tokens: 777, model: 'main-model', key: 'main-secret' });
    const beforeMain = JSON.stringify(mainConfig);
    sandbox.mainConfig = mainConfig;
    vm.runInContext(`
        getSTModule = async () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), oai_settings: mainConfig });
        _settings.subApi = { url: 'https://summary.invalid/v1', source: 'openai', key: 'summary-secret', model: 'summary-model', temperature: '', stream: false };
        _settings.boundPreset = 'summary-preset';
    `, sandbox);
    const requests = [];
    sandbox.fetch = async (url, options) => {
        assert.ok(['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'].includes(url), 'no shared settings or secret writes');
        const body = JSON.parse(options.body);
        assert.equal(body.chat_completion_source, 'custom');
        assert.equal(body.custom_url, 'https://summary.invalid/v1');
        assert.equal(typeof body.custom_include_headers, 'string', 'backend expects YAML text, not an object');
        const upstreamHeaders = { Authorization: 'Bearer main-secret', ...JSON.parse(body.custom_include_headers) };
        assert.notEqual(upstreamHeaders.Authorization, 'Bearer main-secret');
        requests.push({ url, body, auth: upstreamHeaders.Authorization });
        return { ok: true, json: async () => url.endsWith('/status')
            ? { data: [{ id: 'summary-model' }] }
            : { choices: [{ message: { content: '连接成功' }, finish_reason: 'stop' }] } };
    };
    const simultaneous = await Promise.all([
        vm.runInContext('subApiTest()', sandbox),
        vm.runInContext('subApiFetchModels()', sandbox),
        Promise.resolve().then(() => assert.equal(JSON.stringify(mainConfig), beforeMain)),
    ]);
    assert.equal(simultaneous[0].ok, true);
    assert.equal(simultaneous[1].ok, true);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.auth === 'Bearer summary-secret'));
    assert.equal(requests.find(r => r.url.endsWith('/generate')).body.stream, false);
    assert.equal(requests.find(r => r.url.endsWith('/generate')).body.max_tokens, undefined);
    assert.equal(vm.runInContext('st_b()', sandbox), false, 'independent summary must never switch the main preset');
    vm.runInContext("_settings.subApi.key = ''", sandbox);
    await vm.runInContext("subApiGenerate([{role:'user', content:'test'}])", sandbox);
    assert.equal(requests.at(-1).auth, '', 'keyless endpoint must not inherit main auth');
    assert.equal(requests.at(-1).body.temperature, 0.8, 'summary settings remain unchanged');
    let mainCalls = 0;
    context.generateQuietPrompt = async () => { mainCalls++; return '主连接结果'; };
    sandbox.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: '副密钥无效' } }) });
    await assert.rejects(vm.runInContext("generateSummaryText('测试')", sandbox), /副密钥无效/);
    assert.equal(mainCalls, 0, 'failed sub API must not take over the main connection');
    vm.runInContext("_settings.subApi.url = ''", sandbox);
    assert.equal((await vm.runInContext("generateSummaryText('测试')", sandbox)).via, 'main');
    assert.equal(mainCalls, 1);
    assert.equal(JSON.stringify(mainConfig), beforeMain);
    vm.runInContext("_settings.boundPreset = ''; _settings.subApi = {}", sandbox);
    vm.runInContext(`
        getPromptRegexEngine = async () => ({
            getRegexedString: (input, placement, options) => {
                if (!options.isPrompt) throw new Error('prompt flag missing');
                globalThis.regexCalls = (globalThis.regexCalls || []).concat([{ placement, depth: options.depth }]);
                return input.replace(/秘密内容/g, '');
            },
        });
    `, sandbox);
    vm.runInContext("_settings.removeWrappedTags = 'think,wordcount'", sandbox);
    chat[1].mes += '秘密内容<think>不发送的思考</think><style>.a{color:red}</style>\n```js\nalert(1)\n```\n字数：1234';
    chat[2].mes += '秘密内容<wordcount>统计一千字</wordcount><div><b>保留的剧情</b></div>';
    const filteredFull = await vm.runInContext("prepareSummaryInputRecords(getSummaryInputRecords('full'), 'full')", sandbox);
    assert.equal(filteredFull.some(r => r.content.includes('秘密内容')), false);
    assert.equal(chat[1].mes.includes('秘密内容'), true, 'stored chat must stay unchanged');
    assert.equal(filteredFull.find(r => r.msgId === 1).content.includes('剧情片段'), true);
    assert.equal(filteredFull.find(r => r.msgId === 1).content.includes('一号摘要'), true);
    assert.equal(filteredFull.find(r => r.msgId === 1).content.match(/一号摘要/g).length, 1);
    assert.equal(filteredFull.find(r => r.msgId === 1).content.includes('不发送的思考'), false);
    assert.equal(filteredFull.find(r => r.msgId === 1).content.includes('color:red'), false);
    assert.equal(filteredFull.find(r => r.msgId === 1).content.includes('alert(1)'), false);
    assert.equal(filteredFull.find(r => r.msgId === 1).content.includes('字数：1234'), false);
    assert.equal(filteredFull.find(r => r.msgId === 2).content.includes('统计一千字'), false);
    assert.equal(filteredFull.find(r => r.msgId === 2).content.includes('保留的剧情'), true);
    const filteredUnified = await vm.runInContext("prepareSummaryInputRecords(getSummaryInputRecords('unified'), 'unified')", sandbox);
    assert.equal(filteredUnified.find(r => r.msgId === 2).content.includes('无标签正文'), true);
    assert.equal(filteredUnified.find(r => r.msgId === 1).content.includes('剧情片段'), false);
    assert.equal(sandbox.regexCalls[0].depth, 2);
    await vm.runInContext('renderRecords()', sandbox);
    assert.match(rendered['#miss-records-list'], /无标签正文<\/span><span class="miss-record-badge">楼层 3 · 无标签正文/);
    assert.doesNotMatch(rendered['#miss-records-list'], /秘密内容|不发送的思考|统计一千字|alert\(1\)/);
    vm.runInContext("editingId = 'm2_context'", sandbox);
    await vm.runInContext('renderRecords()', sandbox);
    assert.match(rendered['#miss-records-list'], /秘密内容/, 'edit mode must show original message, not silently overwrite it');
    vm.runInContext('editingId = null', sandbox);
    assert.equal(vm.runInContext("cleanSummaryContent('<summary>保留</summary><think>删<think>深删</think>也删</think>正文', 'full', 'full')", sandbox), '正文\n\n保留');
    assert.equal(vm.runInContext("cleanSummaryContent('正文```js代码```<summary>摘要</summary>字数：12', 'full', 'full')", sandbox), '正文\n\n摘要');
    assert.equal(vm.runInContext("cleanSummaryContent('正文<pre><code>console.log(1)</code></pre><summary>摘要</summary>', 'full', 'full')", sandbox), '正文\n\n摘要');
    assert.equal(vm.runInContext("cleanSummaryContent('正文<summary>不保留</summary>', 'full', 'full')", sandbox), '正文\n\n不保留');
    vm.runInContext("_settings.removeWrappedTags = 'think,summary'", sandbox);
    assert.equal(vm.runInContext("cleanSummaryContent('正文<summary>不保留</summary>', 'full', 'full')", sandbox), '正文');
    vm.runInContext("_settings.removeWrappedTags = 'think,wordcount'", sandbox);
    const filteredTags = await vm.runInContext("prepareSummaryInputRecords(getSummaryInputRecords('tags'), 'tags')", sandbox);
    assert.equal(filteredTags.find(r => r.msgId === 1).content, '一号摘要\n另一个标签');
    vm.runInContext('getPromptRegexEngine = async () => { throw new Error("正则引擎不可用") }', sandbox);
    await assert.rejects(vm.runInContext("prepareSummaryInputRecords(getSummaryInputRecords('full'), 'full')", sandbox), /正则引擎不可用/);
    await vm.runInContext('renderRecords()', sandbox);
    assert.match(rendered['#miss-records-list'], /无法生成安全预览/);
    assert.doesNotMatch(rendered['#miss-records-list'], /秘密内容/);
    vm.runInContext('getPromptRegexEngine = async () => ({ getRegexedString: input => input.replace(/秘密内容/g, "") })', sandbox);
    context.chatMetadata.missSummary.summaries = [{
        title: '旧总结', content: '旧内容', sourceMsgIds: [3], from: 3, upTo: 3,
    }];
    context.saveChat = async () => {};
    sandbox.window.confirm = () => true;
    vm.runInContext(`
        setBusy = () => {};
        currentPresetName = () => null;
        generateSummaryText = async text => {
            await onGeneration();
            globalThis.lastResummaryInput = text;
            return { text: '新总结', via: 'subapi' };
        };
        saveMetadata = async () => {};
        syncStoredSummariesWorldInfo = async () => {};
        renderSummaries = () => {};
        renderRecords = () => {};
        updateTokens = async () => {};
        popupConfirm = async () => { globalThis.wasTemporarilyVisible = !getContext().chat[3].is_system; };
    `, sandbox);
    await vm.runInContext('reSummarizeAt(0)', sandbox);
    assert.equal(sandbox.lastResummaryInput.includes('隐藏摘要'), true);
    assert.equal(sandbox.lastResummaryInput.includes('剧情片段'), false, 'one summary must not read other floors');
    assert.equal(sandbox.wasTemporarilyVisible, true);
    assert.equal(chat[3].is_system, true, 'previous hidden state must be restored');
    assert.equal(context.chatMetadata.missSummary.summaries[0].content, '新总结');

    context.chatMetadata.missSummary.summaries.push({
        title: '另一条', content: '另一条内容', sourceMsgIds: [1], from: 1, upTo: 1,
    });
    await vm.runInContext('deleteSummaryAt(0)', sandbox);
    assert.equal(context.chatMetadata.missSummary.summaries.length, 1);
    assert.equal(context.chatMetadata.missSummary.summaries[0].title, '另一条');
    assert.equal(chat[3].is_system, false, 'deleted summary floor must become visible');

    vm.runInContext(`
        window.__missApiChecked = true;
        _settings.wiEnabled = false;
        _settings.autoHideFloors = false;
        _settings.subApi = { url: 'https://summary.invalid/v1' };
        _settings.boundPreset = 'summary-preset';
        applyPreset = async () => { throw new Error('must not change main preset'); };
        generateSummaryText = async text => { globalThis.lastSummaryInput = text; return { text: '大总结', via: 'subapi' }; };
    `, sandbox);
    await vm.runInContext('runSummary(true)', sandbox);
    assert.equal(sandbox.lastSummaryInput.includes('剧情片段'), true);
    assert.equal(sandbox.lastSummaryInput.includes('不发送的思考'), false);
    assert.equal(sandbox.lastSummaryInput.includes('秘密内容'), false);
    assert.equal(sandbox.lastSummaryInput.includes('统计一千字'), false);
    assert.equal(sandbox.lastSummaryInput.includes('一号摘要'), true);
    assert.equal(context.chatMetadata.missSummary.summaries.at(-1).content, '大总结');

    vm.runInContext(`
        _settings.subApi = { url: 'https://example.invalid', source: 'custom', stream: true };
        getSTModule = async () => ({ getRequestHeaders: () => ({}) });
    `, sandbox);
    sandbox.fetch = async () => ({
        ok: true,
        body: {
            getReader: () => {
                let read = false;
                return { read: async () => read
                    ? { done: true }
                    : (read = true, { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n') }) };
            },
        },
    });
    await assert.rejects(
        vm.runInContext("subApiGenerate([{ role: 'user', content: '测试' }])", sandbox),
        /连接中断/,
    );
    sandbox.fetch = async () => ({
        ok: true,
        body: {
            getReader: () => {
                let read = false;
                return { read: async () => read
                    ? { done: true }
                    : (read = true, { done: false, value: new TextEncoder().encode(
                        'data: {"choices":[{"delta":{"content":"部分"},"finish_reason":"length"}]}\n'
                        + 'data: [DONE]\n',
                    ) }) };
            },
        },
    });
    await assert.rejects(
        vm.runInContext("subApiGenerate([{ role: 'user', content: '测试' }])", sandbox),
        /已截断/,
    );
    sandbox.fetch = async () => ({ ok: true, json: async () => ({
        choices: [{ finish_reason: 'length', message: { content: '部分' } }],
    }) });
    vm.runInContext('_settings.subApi.stream = false', sandbox);
    await assert.rejects(
        vm.runInContext("subApiGenerate([{ role: 'user', content: '测试' }])", sandbox),
        /已截断/,
    );
    sandbox.popupText = '';
    vm.runInContext("popupConfirm = async message => { globalThis.popupText = message }; toast = () => {}", sandbox);
    await vm.runInContext("showSummaryFailure(new Error('连接中断'), '总结')", sandbox);
    assert.equal(sandbox.popupText.includes('连接中断'), true);
    assert.equal(vm.runInContext("cleanTagList('[小冰块][/小冰块], [Anti-truncation][/Anti-truncation]')", sandbox), '小冰块,Anti-truncation');
    vm.runInContext("_settings.tag = '小冰块,Anti-truncation'; _settings.removeWrappedTags = ''", sandbox);
    assert.equal(vm.runInContext("cleanSummaryContent('[小冰块]甲[/小冰块]<Anti-truncation>乙</Anti-truncation>', 'tags', 'extract')", sandbox), '甲\n乙');
    chat.push({ mes: '[小冰块]角色摘要[/小冰块]', is_system: true });
    assert.equal(vm.runInContext('buildUnifiedRecords().at(-1).content', sandbox), '角色摘要');
    vm.runInContext("_settings.removeWrappedTags = '小冰块,Anti-truncation'", sandbox);
    assert.equal(vm.runInContext("cleanSummaryContent('正文[小冰块]删[/小冰块][Anti-truncation]删[/Anti-truncation]', 'full', 'full')", sandbox), '正文');
    assert.equal(vm.runInContext("cleanTagList('think,小冰块,Anti-truncation')", sandbox), 'think,小冰块,Anti-truncation');
    vm.runInContext("_settings.removeWrappedTags = 'think,小冰块,Anti-truncation'", sandbox);
    assert.equal(vm.runInContext("cleanSummaryContent('正文<think>删一</think>[小冰块]删二[/小冰块][Anti-truncation]删三[/Anti-truncation]', 'full', 'full')", sandbox), '正文');
    vm.runInContext("_settings.removeWrappedTags = 'Anti-truncation'", sandbox);
    vm.runInContext("_settings.summarizeUserInput = false", sandbox);
    chat.push({ mes: '隐藏的用户输入', is_user: true, is_system: true });
    assert.equal(vm.runInContext("getSummaryInputRecords('full', true).some(r => r.msgId === 5)", sandbox), false);
    assert.deepEqual(Array.from(vm.runInContext('hiddenSummaryCandidates()', sandbox)), [4]);
    vm.runInContext('$drawer = { length: 1 }; hiddenSelectionChat = null; renderHiddenSummaryPicker()', sandbox);
    assert.deepEqual(Array.from(vm.runInContext('selectedHiddenMessageIds()', sandbox)), [4]);
    vm.runInContext('selectedHiddenIds.clear()', sandbox);
    assert.deepEqual(Array.from(vm.runInContext('selectedHiddenMessageIds()', sandbox)), []);
    vm.runInContext('selectHiddenFloors(hiddenSummaryCandidates())', sandbox);
    assert.deepEqual(Array.from(vm.runInContext('selectedHiddenMessageIds()', sandbox)), [4]);
    await vm.runInContext('withVisibleHiddenFloors([4], async () => { if (getContext().chat[4].is_system) throw Error("not visible"); })', sandbox);
    assert.equal(chat[4].is_system, true);
    vm.runInContext(`
        _settings.wiEnabled = false;
        selectedHiddenMessageIds = () => [4];
        currentPresetName = () => null;
        setBusy = () => {};
        renderHiddenSummaryPicker = () => {};
        renderSummaries = () => {};
        renderRecords = () => {};
        updateTokens = async () => {};
        saveMetadata = async () => {};
        getPromptRegexEngine = async () => ({ getRegexedString: input => input });
        generateSummaryText = async text => { globalThis.catchupInput = text; return { text: '补总结结果', via: 'subapi' }; };
        showSummaryFailure = async error => { throw error };
    `, sandbox);
    const priorPointer = context.chatMetadata.missSummary.lastMessageId;
    await vm.runInContext('summarizeHiddenSelection()', sandbox);
    assert.equal(sandbox.catchupInput.includes('角色摘要'), true);
    assert.equal(sandbox.catchupInput.includes('隐藏的用户输入'), false);
    assert.equal(chat[4].is_system, true);
    assert.deepEqual(Array.from(context.chatMetadata.missSummary.summaries.at(-1).sourceMsgIds), [4]);
    assert.equal(context.chatMetadata.missSummary.lastMessageId, priorPointer);
    assert.deepEqual(Array.from(vm.runInContext('hiddenSummaryCandidates()', sandbox)), []);

    console.log('PASS: API isolation, no shared secret writes, no fallback or preset switching, keyless auth, summary and hidden-floor regression');
})().catch(error => { console.error(error); process.exitCode = 1; });

async function connectionRegression() {
    const handlers = new Map();
    const notices = [];
    const jq = () => ({ on(event, selector, fn) { handlers.set(selector, fn); return this; }, prop() { return this; } });
    const main = Object.freeze({ url: 'https://main.invalid/v1', model: 'main-model', key: 'main-secret' });
    const box = { console: { log() {}, error() {} }, window: { jQuery: jq }, jQuery: () => {}, TextDecoder,
        getContext: () => { throw new Error('connection/test must never read character or chat'); },
        notices, main, setTimeout() {} };
    vm.createContext(box);
    vm.runInContext(source, box);
    const run = code => vm.runInContext(code, box);
    run(`
        _settings={subApi:{url:'https://sub.invalid/v1',key:'sub-secret',model:'sub-model',stream:true},boundPreset:'summary-preset'};
        $drawer={on:(...args)=>globalThis.register(...args)};
        getSTModule=async()=>({getRequestHeaders:()=>({'Content-Type':'application/json'})});
        saveSettings=async()=>{};renderSubApi=()=>{};readSubApiForm=()=>_settings.subApi;
        toast=(text)=>notices.push(text);
    `);
    box.register = (event, selector, fn) => handlers.set(selector, fn);
    run('bindSubApiUi()');
    const calls = [];
    box.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body });
        assert.equal(body.custom_url, 'https://sub.invalid/v1');
        assert.equal(JSON.parse(body.custom_include_headers).Authorization, 'Bearer sub-secret');
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'sub-model' }] }) };
    };
    await handlers.get('#miss-subapi-connect-btn').call({});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/backends/chat-completions/status');
    assert.equal(calls[0].body.messages, undefined);
    assert.equal(calls[0].body.model, undefined);
    assert.equal(run('_settings.subApi.validation'), 'status');
    assert.equal(run('st_b()'), false);

    box.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.stream, false, 'test must ignore summary streaming');
        assert.equal(body.max_tokens, undefined, 'test must not force 30 tokens');
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hello' }, finish_reason: 'length' }] }) };
    };
    await handlers.get('#miss-subapi-test-btn').call({});
    assert.equal(run('_settings.subApi.validation'), 'unknown');
    assert.match(notices.at(-1), /接口已响应/);
    assert.doesNotMatch(notices.at(-1), /连接失败/);
    for (const [data, expected] of [
        [{ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] }, true],
        [{ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, false],
    ]) {
        box.fetch = async () => ({ ok: true, status: 200, json: async () => data });
        const result = await run('subApiTest()');
        assert.equal(result.ok, expected);
        if (!expected) assert.equal(result.unverified, true);
    }
    for (const status of [401, 403, 404, 405, 501]) {
        box.fetch = async () => ({ ok: false, status, json: async () => ({ message: 'HTTP ' + status }) });
        const result = await run('subApiCheckConnection()');
        assert.equal(result.ok, false);
        assert.equal(result.unverified, [404, 405, 501].includes(status));
    }
    box.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: true, bypass: true }) });
    assert.equal((await run('subApiCheckConnection()')).unverified, true);
    box.fetch = async () => ({ ok: true, status: 200, json: async () => { throw Error('HTML response'); } });
    assert.match((await run('subApiTest()')).error, /JSON/);
    run("_settings.subApi.model=''");
    box.fetch = async () => { throw Error('must validate model before request'); };
    assert.match((await run('subApiTest()')).error, /模型/);
    run("_settings.subApi.model='sub-model';globalThis.oldCfg={..._settings.subApi};_settings.subApi.url='https://new.invalid/v1'");
    assert.equal(run("applySubApiCheck(oldCfg,{ok:true},'test')"), false);

    // 两个实际模拟请求均进入网络等待，再一起释放；副连接不占用酒馆全局生成锁。
    run("_settings.subApi.url='https://sub.invalid/v1';_settings.subApi.key='';globalThis.mainGenerating=true");
    const pending = [];
    box.fetch = (url, options) => {
        const body = JSON.parse(options.body);
        pending.push(body);
        if (body.custom_url === main.url) {
            assert.equal(JSON.parse(body.custom_include_headers).Authorization, 'Bearer main-secret');
            assert.equal(body.model, main.model);
        } else {
            assert.equal(body.custom_url, 'https://sub.invalid/v1');
            assert.equal(JSON.parse(body.custom_include_headers).Authorization, '');
            assert.equal(body.model, 'sub-model');
        }
        return new Promise(resolve => {
            releases.push(() => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] }) }));
        });
    };
    const releases = [];
    const mainRequest = box.fetch('/api/backends/chat-completions/generate', { body: JSON.stringify({
        custom_url: main.url, model: main.model, custom_include_headers: JSON.stringify({ Authorization: 'Bearer main-secret' }),
    }) });
    const subRequest = run('subApiTest()');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pending.length, 2, 'main and sub requests must be in flight together');
    releases.forEach(release => release());
    const results = await Promise.all([mainRequest, subRequest]);
    assert.equal(results[1].ok, true);
    assert.equal(run('mainGenerating'), true);
    assert.deepEqual(main, { url: 'https://main.invalid/v1', model: 'main-model', key: 'main-secret' });
    console.log('PASS: distinct connect/test handlers, no-chat operation, test truncation, auth/status failures, stale config and simultaneous main/sub requests');
}

async function reviewRegression() {
    function fixture(chat, summaries = []) {
        let current = { name: 'A', chat, chatMetadata: { missSummary: { summaries, lastMessageId: -1, hiddenMessageIds: {} } }, saveChat: async () => {} };
        const original = current;
        const jq = arg => {
            if (typeof arg === 'function') return;
            return new Proxy({ length: 1 }, { get: (object, key) => key in object ? object[key] : (() => key === 'is' ? false : jq('stub')) });
        };
        const box = { console: { log() {}, error() {} }, window: { jQuery: jq, __missApiChecked: true },
            jQuery: jq, getContext: () => current, setTimeout: () => {}, TextDecoder };
        vm.createContext(box);
        vm.runInContext(source, box);
        vm.runInContext(`
            _settings = { tag: 'summary,memory', sendFullChat: false, subApi: { url: 'https://example.invalid' }, wiEnabled: false, autoHideFloors: false };
            setBusy=()=>{}; currentPresetName=()=>null; saveMetadata=async()=>{}; renderRecords=()=>{};
            renderSummaries=()=>{}; renderHiddenSummaryPicker=()=>{}; renderAll=()=>{}; updateTokens=async()=>{};
            toast=()=>{}; popupConfirm=async()=>{}; popupYesNo=async()=>false; markMessageHiddenDom=()=>{};
            getPromptRegexEngine=async()=>({getRegexedString:x=>x}); showSummaryFailure=async e=>{globalThis.failure=e.message};
            getPromptTypesAsync=async()=>({IN_CHAT:1,NONE:-1}); getPromptRolesAsync=async()=>({SYSTEM:0});
            getSetExtensionPrompt=async()=>((...args)=>{globalThis.injected=args[1]});
        `, box);
        return { box, ctx: original, run: code => vm.runInContext(code, box), switchTo: next => { current = next; } };
    }
    const redo = fixture([{ mes: '<summary>来源</summary>' }], [{ content: '旧总结', sourceMsgIds: [0], upTo: 0 }]);
    redo.run("generateSummaryText=async()=>({text:'新总结',via:'subapi'})");
    await redo.run('reSummarizeAt(0)');
    assert.equal(redo.ctx.chatMetadata.missSummary.summaries[0].content, '新总结');

    const edited = fixture([{ mes: '前文<summary>甲</summary>中间[memory]乙[/memory]后文' }]);
    const raw = edited.ctx.chat[0].mes;
    await edited.run("saveEdit(buildUnifiedRecords()[0],'<summary>新甲</summary>\\n[memory]新乙[/memory]')");
    assert.equal(edited.ctx.chat[0].mes, '前文<summary>新甲</summary>中间[memory]新乙[/memory]后文');
    const saved = edited.ctx.chat[0].mes;
    await edited.run("saveEdit(buildUnifiedRecords()[0],'缺少标签')");
    assert.equal(edited.ctx.chat[0].mes, saved);
    assert.notEqual(saved, raw);

    for (const action of ['summarizeHiddenSelection()', 'runSummary(true)', 'reSummarizeAt(0)']) {
        const change = fixture([{ mes: '<summary>A剧情</summary>', is_system: action.startsWith('summarizeHidden') }],
            action.startsWith('reSummarize') ? [{ content: 'A旧总结', sourceMsgIds: [0], upTo: 0 }] : []);
        const other = { name: 'B', chat: [{ mes: 'B剧情' }], chatMetadata: { missSummary: { summaries: [], lastMessageId: -1, hiddenMessageIds: {} } } };
        change.box.changeChat = () => change.switchTo(other);
        change.run("selectedHiddenMessageIds=()=>[0]; generateSummaryText=async()=>{changeChat();return {text:'A的新总结',via:'subapi'}}");
        await change.run(action);
        assert.equal(other.chatMetadata.missSummary.summaries.length, 0, action + ' must not write into B');
        assert.match(change.box.failure, /聊天已切换/);
    }

    const duringWrite = fixture([{ mes: 'A' }]);
    const writeTarget = { chat: [{ mes: 'B' }], chatMetadata: {}, saveChat: async () => {} };
    duringWrite.box.changeChat = () => duringWrite.switchTo(writeTarget);
    duringWrite.run('wiMod=async()=>{changeChat();return {loadWorldInfo:async()=>({entries:{}}),saveWorldInfo:async()=>{throw Error("must not write")}}}');
    await assert.rejects(duringWrite.run('ensureChatWorldInfo()'), /聊天已切换/);
    assert.equal(writeTarget.chatMetadata.world_info, undefined);

    const changedSource = fixture([{ mes: '<summary>原剧情</summary>' }]);
    changedSource.run("generateSummaryText=async()=>{getContext().chat[0].mes='<summary>改写剧情</summary>';return {text:'过期结果',via:'subapi'}}");
    await changedSource.run('runSummary(true)');
    assert.equal(changedSource.ctx.chatMetadata.missSummary.summaries.length, 0);
    assert.match(changedSource.box.failure, /来源消息被修改或删除/);

    const moved = fixture([{ mes: 'A' }, { mes: 'B' }, { mes: 'C' }, { mes: 'D' }], [{ content: 'B的总结', sourceMsgIds: [1], upTo: 1 }]);
    moved.run('getStore(); _settings.autoHideFloors=true; summaryWorldState=async()=>({active:true,current:true})');
    moved.ctx.chat.splice(0, 1);
    await moved.run('onGeneration()');
    assert.equal(moved.ctx.chat[0].mes, 'B');
    assert.equal(moved.ctx.chat[0].is_system, true);
    assert.notEqual(moved.ctx.chat[1].is_system, true, 'C must not inherit B coverage');
    moved.ctx.chat[0].mes = '修改后的B';
    await moved.run('onGeneration()');
    assert.equal(moved.ctx.chat[0].is_system, false, 'edited source must be visible again');
    assert.equal(moved.run('allSummarizedMessageIds().size'), 0);
    moved.ctx.chat[0] = { mes: '新插入楼层' };
    assert.deepEqual(Array.from(moved.run('getStore().summaries[0].sourceMsgIds')), []);

    const failedWorld = fixture([{ mes: '<summary>旧剧情</summary>' }, { mes: '<summary>新剧情</summary>' }]);
    failedWorld.run("_settings.wiEnabled=true; _settings.autoHideFloors=true; generateSummaryText=async()=>({text:'大总结',via:'subapi'}); ensureChatWorldInfo=async()=>{throw Error('write failed')}");
    await failedWorld.run('runSummary(true)');
    assert.notEqual(failedWorld.ctx.chat[0].is_system, true, 'failed world write must not hide the source');
    assert.equal(failedWorld.ctx.chatMetadata.missSummary.summaries.length, 1, 'keep the generated result');

    const channels = fixture([{ mes: '正文' }], [{ content: '记忆', sourceMsgIds: [0], upTo: 0 }]);
    channels.ctx.chatMetadata.world_info = 'book';
    channels.run("wiMod=async()=>({loadWorldInfo:async()=>({entries:{0:{comment:'Miss总结',constant:true,disable:false,content:'记忆'}}})})");
    await channels.run('onGeneration()');
    assert.equal(channels.box.injected, '', 'active world memory must not be injected twice');
    delete channels.ctx.chatMetadata.world_info;
    await channels.run('onGeneration()');
    assert.equal(channels.box.injected, '记忆', 'without a world entry use the direct channel');

    channels.run('_lastPromptTokens=12345; lastTokenCount=12345');
    await channels.run('onChatChanged()');
    assert.equal(channels.run('_lastPromptTokens'), 0);
    assert.equal(channels.run('lastTokenCount'), 0);
    console.log('PASS: seven review regressions (chat scope, message identity, memory readiness, redo, multi-tag edit, single injection, token reset)');
}
