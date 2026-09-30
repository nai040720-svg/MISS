const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync('index.js', 'utf8')
    .replace(/^import \{ getContext \} from '[^']+';\s*/m, '');
new vm.Script(source, { filename: 'index.js' });

let ready;
let menuInserted = false;
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
    return { on() { return this; }, length: 1 };
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
    context.chatMetadata.missSummary.summaries = [{
        title: '旧总结', content: '旧内容', sourceMsgIds: [3], from: 3, upTo: 3,
    }];
    context.saveChat = async () => {};
    sandbox.window.confirm = () => true;
    vm.runInContext(`
        setBusy = () => {};
        currentPresetName = () => null;
        generateSummaryText = async text => { globalThis.lastResummaryInput = text; return { text: '新总结', via: 'subapi' }; };
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
    console.log('PASS: syntax, full chat, per-summary redo/delete, hidden state, API interruption popup');
})().catch(error => { console.error(error); process.exitCode = 1; });

