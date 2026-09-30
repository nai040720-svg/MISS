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
    { mes: '<summary>一号摘要</summary><memory>另一个标签</memory>' },
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
vm.runInContext("_settings.jailbreakPrompt = '破限'; _settings.summaryPrompt = '总结'", sandbox);
const messages = vm.runInContext("buildSummaryMessages('正文')", sandbox);
assert.deepEqual(Array.from(messages, m => m.content), ['破限', '正文', '总结']);

vm.runInContext('s = async () => { throw new Error("settings unavailable") }', sandbox);
ready();
assert.equal(menuInserted, true, 'settings failure must not block menu insertion');
console.log('PASS: syntax, unified records, hidden floor filter, prompt order, menu startup');

