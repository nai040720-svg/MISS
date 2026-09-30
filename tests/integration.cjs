/* Real SillyTavern HTTP integration. No browser required. Run with ST_ROOT=/path/to/SillyTavern. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const {spawn} = require('node:child_process');
const stRoot = process.env.ST_ROOT;
if (!stRoot) throw new Error('Set ST_ROOT to an installed official SillyTavern checkout');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miss-integration-'));
const base = 'http://127.0.0.1:8765';
const seen = [];
let mode = 'normal';
const provider = http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):null;seen.push({url:req.url,authorization:req.headers.authorization,body});
 if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:[{id:'miss-mock'}]}));
 if(mode==='failure'){res.writeHead(503,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'mock unavailable'}}));}
 if(mode==='delayed') await new Promise(r=>setTimeout(r,100));
 res.setHeader('Content-Type',body?.stream?'text/event-stream':'application/json');
 if(body?.stream){res.write('data: '+JSON.stringify({choices:[{delta:{content:'MOCK '}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{content:'MEMORY'}}]})+'\n\n');return res.end('data: [DONE]\n\n');}
 res.end(JSON.stringify({choices:[{message:{content:'MOCK MEMORY'}}]}));
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let child;
(async()=>{
 await new Promise(resolve=>provider.listen(9876,'127.0.0.1',resolve));
 child=spawn(process.execPath,['--require',path.join(__dirname,'loopback-only.cjs'),'server.js','--dataRoot',root,'--port','8765','--browserLaunchEnabled','false'],{cwd:stRoot,stdio:['ignore','pipe','pipe']});
 let serverLog='';child.stdout.on('data',x=>serverLog+=x);child.stderr.on('data',x=>serverLog+=x);
 let cookies='';let csrf='';
 async function request(route,body){
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{cookie:cookies,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const additions=response.headers.getSetCookie();if(additions.length)cookies=additions.map(x=>x.split(';')[0]).join('; ');
  return response;
 }
 let ready=false;for(let i=0;i<600;i++){try{const r=await request('/csrf-token');if(r.ok){csrf=(await r.json()).token;ready=true;break;}}catch{}await pause(100);}
 if(!ready)throw new Error('ST startup failed: '+serverLog);
 async function post(route,body){const r=await request(route,body);if(!r.ok)throw new Error(route+' HTTP '+r.status+': '+await r.text());return r.json();}
 const html=await(await request('/')).text();assert(html.includes('SillyTavern'));
 const plugin=await request('/scripts/extensions/third-party/MISS/index.js');assert.equal(plugin.status,200);
 assert((await plugin.text()).includes('function summarize'));
 console.log('PASS real ST server serves application and installed MISS extension');
 let metadata={missSummary:{summaries:[],lastMessageId:-1}};
 let chat=[{name:'Mock',is_user:false,mes:'prose<summary>fixture memory</summary>',send_date:'2026-09-30'}, {name:'Mock',is_user:false,mes:'<summary>second memory</summary>',send_date:'2026-09-30'}];
 const settings={};
 async function saveChat(){await post('/api/chats/save',{avatar_url:'default_Seraphina.png',file_name:'MISS Mock',force:true,chat:[{user_name:'Tester',character_name:'Mock',chat_metadata:metadata},...chat]});}
 const ctx={mainApi:'openai',chatId:'MISS Mock',characterId:0,characters:[{name:'Mock',avatar:'default_Seraphina.png'}],getRequestHeaders:()=>({}),name2:'Mock',chat,chatMetadata:metadata,extensionSettings:settings,
 chatCompletionSettings:{openai_max_tokens:777,temp_openai:0.75},saveMetadata:saveChat,saveChat,
 saveSettingsDebounced:()=>post('/api/settings/save',{extension_settings:settings}),getTokenCountAsync:async text=>text.length,
 setExtensionPrompt:()=>{},getPresetManager:()=>({getAllPresets:()=>[]})};
 const jq=()=>({length:0,toggleClass(){return this;},prop(){return this;},text(){return this;},attr(){return this;}});
 const sandbox={console,window:{jQuery:jq,toastr:{info:()=>{},success:()=>{},warning:()=>{},error:()=>{}}},jQuery:()=>{},getContext:()=>ctx,setTimeout,clearTimeout,TextDecoder,crypto:require('node:crypto').webcrypto,structuredClone,
 fetch:(route,opts)=>request(route,opts?.body?JSON.parse(opts.body):undefined),__wm:{
 loadWorldInfo:name=>post('/api/worldinfo/get',{name}),saveWorldInfo:(name,data)=>post('/api/worldinfo/edit',{name,data}),updateWorldInfoList:()=>post('/api/settings/get',{})},
 __st:{getRequestHeaders:()=>({})}};
 let source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8').replace(/^import .*;$/m,'');
 source+='\n_stMod=__st;_stModule=__st;_wiMod=__wm;_settings=defaultSettings();getContext().extensionSettings[MODULE]=_settings;_settings.tag="summary";_settings.subApi={type:"openai",source:"custom",url:"http://127.0.0.1:9876/v1",key:"fake-secondary-key",model:"miss-mock",temperature:""};globalThis.api={runSummary,reSummarizeAll,summaryRecords,extractRecords,saveEdit,subApiGenerate,subApiFetchModels,saveSettings,onGeneration,onChatChanged,settings:_settings};';
 vm.createContext(sandbox);vm.runInContext(source,sandbox);const api=sandbox.api;
 await saveChat();
 // A fake main credential exists only in this new test data directory; it must stay byte-identical.
 const secretPath=path.join(root,'default-user','secrets.json');const fakeSecrets='{"api_key_custom":"fake-main-sentinel"}';fs.writeFileSync(secretPath,fakeSecrets);
 await api.runSummary(false);
 assert.equal(metadata.missSummary.summaries.length,1);
 assert.equal(seen[0].authorization,'Bearer fake-secondary-key');
 assert.equal(seen[0].body.temperature,0.75);assert.equal(seen[0].body.max_tokens,777);
 const book=metadata.world_info;let world=await post('/api/worldinfo/get',{name:book});assert.equal(Object.values(world.entries)[0].content,'MOCK MEMORY');
 console.log('PASS summary through actual ST proxy -> local mock -> persisted chat and World Info');
 await api.saveEdit(api.summaryRecords()[0],'EDITED MEMORY');world=await post('/api/worldinfo/get',{name:book});assert.equal(Object.values(world.entries).length,1);assert.equal(Object.values(world.entries)[0].content,'EDITED MEMORY');
 await api.reSummarizeAll();world=await post('/api/worldinfo/get',{name:book});assert.equal(Object.values(world.entries).length,1);assert.equal(Object.values(world.entries)[0].content,'MOCK MEMORY');
 console.log('PASS real World Info edit and replacement without duplicate entries');
 api.settings.subApi.stream=true;assert.equal(await api.subApiGenerate([{role:'user',content:'SSE fixture'}]),'MOCK MEMORY');api.settings.subApi.stream=false;
 const models=await api.subApiFetchModels();assert.equal(models.models[0],'miss-mock');
 api.settings.subApi.key='';await api.subApiGenerate([{role:'user',content:'no key fixture'}]);assert.notEqual(seen.at(-1).authorization,'Bearer fake-main-sentinel');api.settings.subApi.key='fake-secondary-key';
 console.log('PASS streaming SSE, model listing, and keyless route never inheriting the main secret');
 assert.equal(fs.readFileSync(secretPath,'utf8'),fakeSecrets);
 await api.saveSettings();await pause(100);const saved=await post('/api/settings/get',{});assert.equal(JSON.parse(saved.settings).extension_settings.missSummary.tag,'summary');
 console.log('PASS settings persisted and fake main secrets unchanged');
 api.settings.autoHideFloors=true;await api.onGeneration();assert.equal(chat[0].is_system,true);api.settings.autoHideFloors=false;await api.onGeneration();assert.equal(chat[0].is_system,false);
 const savedChat=await post('/api/chats/get',{avatar_url:'default_Seraphina.png',file_name:'MISS Mock'});assert.equal(savedChat[0].chat_metadata.missSummary.summaries[0].content,'MOCK MEMORY');
 console.log('PASS hidden-floor restoration and chat metadata disk round trip');
 mode='failure';const previous=metadata.missSummary.summaries.length;chat.push({mes:'<summary>unsaved</summary>',is_user:false});await api.runSummary(false);assert.equal(metadata.missSummary.summaries.length,previous);
 console.log('PASS mock provider failure leaves prior memory intact without main-provider fallback');
 fs.writeFileSync(path.join(root,'server.log'),serverLog);
 console.log(JSON.stringify({stRoot,dataRoot:root,mockRequests:seen.length,realProviderRequests:0,uiBrowserE2E:'not run (environment blocks browser sockets / localhost access)'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{child?.kill('SIGTERM');provider.close();});
