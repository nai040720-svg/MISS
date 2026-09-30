const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8').replace(/^import .*;$/m, '');
const tests = String.raw`
let current;
const events=[];
const requests=[];
let pending;
function getContext(){return current;}
function setBusy(){}
function toast(...args){events.push(['toast',...args]);}
function renderRecords(){events.push('records');}
function renderSummaries(){events.push('summaries');}
function renderAll(){}
function markMessageHiddenDom(){}
async function getPromptTypesAsync(){return {NONE:-1,IN_CHAT:1};}
async function getPromptRolesAsync(){return {SYSTEM:0};}
async function getSetExtensionPrompt(){return (...a)=>events.push(['prompt',...a]);}
const mk=(name='A')=>({name2:name, mainApi:'openai',chatId:name,characterId:0,characters:[{name,avatar:'fixture.png'}],getRequestHeaders:()=>({}), chatMetadata:{missSummary:{summaries:[],lastMessageId:-1}},
chat:[{mes:'<summary>old</summary>',is_user:false},{mes:'user',is_user:true},{mes:'<summary>new</summary>',is_user:false}],
saveMetadata:async()=>events.push(['save',current.name2]),saveChat:async()=>events.push('chatSaved'), saveSettingsDebounced:()=>events.push('settingsSaved'),
chatCompletionSettings:{openai_max_tokens:777,temp_openai:0.85},getTokenCountAsync:async text=>text.length,
getPresetManager:()=>({getAllPresets:()=>['Normal','Summary'],getSelectedPresetName:()=>selected,
findPreset:name=>name,selectPreset:async name=>{await Promise.resolve();selected=name;events.push(['preset',name]);}})});
let selected='Normal';
async function setup(){current=mk(); _settings={...defaultSettings(),tag:'summary',wiEnabled:false,subApi:{type:'openai',source:'custom',url:'http://127.0.0.1:9876/v1',key:'fake-test-key',temperature:''}};busy=false; events.length=0;requests.length=0;}
let provider=async()=>({choices:[{message:{content:'MOCK SUMMARY'}}]});
async function fetch(url, options){if(url==='/api/worldinfo/edit'){const {name,data}=JSON.parse(options.body);worlds[name]=structuredClone(data);return {ok:true};}if(url.includes('/chats/'))return {ok:true,json:async()=>({ok:true})};requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>provider()};}
async function getSTModule(){return {getRequestHeaders:()=>({'Content-Type':'application/json'})};}
const worlds={};
async function wiMod(){return {world_info_position:{atDepth:4},loadWorldInfo:async name=>worlds[name],saveWorldInfo:async(name,data)=>{worlds[name]=structuredClone(data);},updateWorldInfoList:async()=>{}};}
async function getEventSource(){return null;}
async function getEventTypes(){return {};}
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
let count=0;
async function test(name, fn){await setup();await fn();console.log('PASS',name);count++;}
(async()=>{
await test('01 chat-switch cancels result before metadata/world writes',async()=>{provider=()=>new Promise(resolve=>pending=resolve);const a=current;const running=runSummary(true);await flush();current=mk('B');pending({choices:[{message:{content:'A SUMMARY'}}]});await running;assert.equal(a.chatMetadata.missSummary.summaries.length,0);assert.equal(current.chatMetadata.missSummary.summaries.length,0);});
provider=async()=>({choices:[{message:{content:'MOCK SUMMARY'}}]});
await test('02 hide only summarized range; preserve user-hidden; inject memory',async()=>{_settings.autoHideFloors=true;await onGeneration();assert(!current.chat[0].is_system);current.chatMetadata.missSummary.summaries=[{content:'old memory',upTo:0}];await onGeneration();assert(current.chat[0].is_system);assert(!current.chat[1].is_system);assert(events.some(x=>Array.isArray(x)&&x[0]==='prompt'&&x[2]==='old memory'));});
await test('03 shared lock prevents merge from swallowing in-flight new summary',async()=>{current.chatMetadata.missSummary.summaries=[{content:'old',upTo:0}];current.chatMetadata.missSummary.lastMessageId=0;provider=()=>new Promise(resolve=>pending=resolve);const run=runSummary(true);await flush();await reSummarizeAll();assert.equal(requests.length,1);pending({choices:[{message:{content:'fresh'}}]});await run;assert.equal(current.chatMetadata.missSummary.summaries.length,2);assert.equal(current.chatMetadata.missSummary.lastMessageId,2);});
provider=async()=>({choices:[{message:{content:'MOCK SUMMARY'}}]});
await test('04 scoped credentials never write secrets or inherit main key',async()=>{await subApiGenerate([{role:'user',content:'x'}]);assert.equal(requests.length,1);assert.equal(requests[0].body.proxy_password,'fake-test-key');assert.equal(requests[0].body.reverse_proxy,_settings.subApi.url);assert.equal(requests[0].body.chat_completion_source,'openai');});
await test('05 supported settings persistence',async()=>{await saveSettings();assert(events.includes('settingsSaved'));});
await test('06 editing and merging synchronize owned WI entries only',async()=>{_settings.wiEnabled=true;current.chatMetadata.world_info='test';worlds.test={entries:{9:{uid:9,content:'unrelated lore'}}};await runSummary(false);let store=getStore();assert.equal(Object.keys(worlds.test.entries).length,2);await saveEdit(summaryRecords()[0],'edited');assert(Object.values(worlds.test.entries).some(x=>x.content==='edited'));await reSummarizeAll();assert.equal(Object.keys(worlds.test.entries).length,2);assert.equal(worlds.test.entries[9].content,'unrelated lore');assert.equal(store.lastMessageId,2);});
await test('07 tag edits use exact span; repeated and multiple tags remain independent',async()=>{current.chat[0].mes='same<summary>same</summary><summary>second</summary><other>third</other>' ;_settings.tag='summary,other';const records=extractRecords().filter(r=>r.msgId===0);assert.equal(records.length,3);await saveEdit(records[1],'updated');assert.equal(current.chat[0].mes,'same<summary>same</summary><summary>updated</summary><other>third</other>');});
await test('08 token cache invalidates chat changes and new messages',async()=>{_lastPromptTokens=9999;current.getTokenCountAsync=async text=>text.length;await onChatChanged();assert.equal(_lastPromptTokens,0);let n=await updateTokens();current.chat.push({mes:'x'.repeat(1000)});await updateTokens();assert(lastTokenCount>n);});
await test('09 reject unsupported API source/type before network; never fallback',async()=>{_settings.subApi.type='kobold';await assert.rejects(()=>subApiGenerate([]));assert.equal(requests.length,0);let called=false;current.generateQuietPrompt=()=>{called=true;};await assert.rejects(()=>generateSummaryText('secret'));assert(!called);});
await test('10 presets are API-qualified names, no cross-family index selection',async()=>{const list=collectPresets();assert.equal(JSON.parse(list[0].value).api,'openai');assert.equal(await applyPreset(JSON.stringify({api:'kobold',name:'Summary'})),false);assert.equal(await applyPreset('0'),false);});
await test('11 raising keep count or disabling hides restores only own messages',async()=>{current.chatMetadata.missSummary.summaries=[{content:'memory',upTo:2}];_settings.keepVisibleFloors=1;await onGeneration();assert(current.chat[0].extra.missSummaryHidden);_settings.keepVisibleFloors=5;await onGeneration();assert.equal(current.chat[0].is_system,false);current.chat[1].is_system=true;_settings.keepVisibleFloors=0;await onGeneration();assert.equal(current.chat[1].is_system,true);});
await test('12 successful summary refreshes summary UI',async()=>{await runSummary(false);assert(events.includes('summaries'));});
await test('13 blank temperature inherits main value; zero stays zero',async()=>{await subApiGenerate([]);assert.equal(requests[0].body.temperature,0.85);_settings.subApi.temperature=0;await subApiGenerate([]);assert.equal(requests[1].body.temperature,0);});
await test('14 reply length uses documented context settings',async()=>{await subApiGenerate([]);assert.equal(requests[0].body.max_tokens,777);});
await test('15 preset selection awaits actual application',async()=>{selected='Normal';await applyPreset(JSON.stringify({api:'openai',name:'Summary'}));assert.equal(selected,'Summary');});
await test('16 no-record early return does not restore or apply a preset',async()=>{_settings.tag='absent';_settings.boundPreset=JSON.stringify({api:'openai',name:'Summary'});await runSummary(true);assert(!events.some(x=>Array.isArray(x)&&x[0]==='preset'));});
await test('17 resummary applies bound preset and restores only after switching',async()=>{_settings.subApi.url='';selected='Normal';_settings.boundPreset=JSON.stringify({api:'openai',name:'Summary'});current.chatMetadata.missSummary.summaries=[{content:'memory',upTo:0}];current.generateQuietPrompt=async()=>{assert.equal(selected,'Summary');return 'merged';};await reSummarizeAll();assert.equal(selected,'Normal');assert.equal(getStore().summaries[0].content,'merged');});

await test('18 legacy summary migration replaces only unique matching MISS entries',async()=>{_settings.wiEnabled=true;current.chatMetadata.world_info='legacy';current.chatMetadata.missSummary.summaries=[{content:'legacy memory',upTo:0}];worlds.legacy={entries:{0:{uid:0,comment:'Miss总结 2026/09/30',content:'legacy memory',constant:true},1:{uid:1,comment:'user lore',content:'unrelated'}}};await saveEdit(summaryRecords()[0],'migrated edit');assert.equal(Object.keys(worlds.legacy.entries).length,2);assert.equal(worlds.legacy.entries[1].content,'unrelated');assert(Object.values(worlds.legacy.entries).some(x=>x.content==='migrated edit'));});
await test('19 reused WI uid never overwrites or deletes unrelated lore',async()=>{_settings.wiEnabled=true;current.chatMetadata.world_info='reuse';worlds.reuse={entries:{}};await runSummary(false);const rec=summaryRecords()[0];const uid=rec.entry.wiUid;worlds.reuse.entries[uid]={uid,comment:'User replacement',content:'KEEP'};await saveEdit(rec,'new edit');assert.equal(worlds.reuse.entries[uid].content,'KEEP');await reSummarizeAll();assert.equal(worlds.reuse.entries[uid].content,'KEEP');});
await test('20 preset restoration never overwrites a different chat preset',async()=>{_settings.subApi.url='';_settings.boundPreset=JSON.stringify({api:'openai',name:'Summary'});selected='Normal';current.generateQuietPrompt=()=>new Promise(resolve=>pending=resolve);const run=runSummary(false);await flush();current=mk('B');selected='B preset';pending('A summary');await run;assert.equal(selected,'B preset');});
await test('21 persistent destination is serialized before asynchronous chat change',async()=>{const originalFetch=fetch;const writes=[];fetch=async(url,options)=>{writes.push(JSON.parse(options.body));current=mk('B');return {ok:true};};const a=current;await saveMetadata(captureChat());assert.equal(writes[0].file_name,'A');assert.equal(writes[0].chat[0].chat_metadata.missSummary.lastMessageId,-1);fetch=originalFetch;});
await test('22 retry recognizes stable summary ID after interrupted WI write',async()=>{_settings.wiEnabled=true;current.chatMetadata.world_info='retry';worlds.retry={entries:{}};const summary={id:'stable-test-id',title:'memory',content:'memory',upTo:0};getStore().summaries=[summary];worlds.retry.entries[3]={uid:3,missSummaryId:summary.id,comment:'Miss总结: memory',content:'memory'};await syncSummaryWorldInfo();assert.equal(Object.keys(worlds.retry.entries).length,1);assert.equal(summary.wiUid,3);});

await test('24 failed World Info edit retains updated fallback injection',async()=>{_settings.wiEnabled=true;current.chatMetadata.world_info='failure';worlds.failure={entries:{}};await runSummary(false);const originalFetch=fetch;fetch=async(url,options)=>url==='/api/worldinfo/edit'?{ok:false,status:500}:originalFetch(url,options);await saveEdit(summaryRecords()[0],'unsynced new memory');await onGeneration();assert(events.some(x=>Array.isArray(x)&&x[0]==='prompt'&&x[2]==='unsynced new memory'));fetch=originalFetch;});
await test('25 chat save error rolls back summary list and cursor',async()=>{const originalFetch=fetch;fetch=async(url,options)=>url.includes('/chats/')?{ok:false,status:500}:originalFetch(url,options);await runSummary(false);assert.equal(getStore().summaries.length,0);assert.equal(getStore().lastMessageId,-1);fetch=originalFetch;});
await test('26 group persistence captures group chat id',async()=>{current.groupId='group-id';current.chatId='group-chat-id';const originalFetch=fetch;let sent;fetch=async(url,options)=>{sent={url,body:JSON.parse(options.body)};return {ok:true};};await saveMetadata();assert.equal(sent.url,'/api/chats/group/save');assert.equal(sent.body.id,'group-chat-id');assert.equal(sent.body.force,false);fetch=originalFetch;});
await test('27 ambiguous legacy entries are preserved and synchronization warns',async()=>{_settings.wiEnabled=true;current.chatMetadata.world_info='ambiguous';getStore().summaries=[{content:'same',upTo:0}];worlds.ambiguous={entries:{0:{uid:0,comment:'Miss总结 old',content:'same'},1:{uid:1,comment:'Miss总结 old',content:'same'}}};await assert.rejects(()=>syncSummaryWorldInfo());assert.equal(Object.keys(worlds.ambiguous.entries).length,2);});
await test('23 summary buttons invoke their intended handler exactly once',async()=>{const normal=runSummary,merge=reSummarizeAll;const clicks=[];runSummary=()=>clicks.push('normal');reSummarizeAll=()=>clicks.push('merge');$drawer=makeJq('drawer');await bindUi();for(const binding of bindings){if(binding.event==='click' && binding.selector.split(',').map(x=>x.trim()).includes('#miss-resummarize-btn'))binding.handler();}assert.deepEqual(clicks,['merge']);runSummary=normal;reSummarizeAll=merge;});
console.log(count+' regression cases passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
const bindings=[];
const makeJq=selector=>({length:1,text(){return this;},val(){return this;},prop(){return this;},toggleClass(){return this;},on(event,delegate,handler){bindings.push({event,selector:typeof delegate==='string'?delegate:selector,handler:handler||delegate});return this;}});
const jq=makeJq;
vm.runInNewContext(source+'\n$drawer={length:1};\n'+tests,{console,assert,process,bindings,makeJq,crypto:require('node:crypto').webcrypto,structuredClone,window:{jQuery:jq},jQuery:()=>{},setTimeout,clearTimeout,TextDecoder});
