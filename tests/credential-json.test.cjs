const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseCredentialJson:parse}=require('../dist/credential-json');
const {parseCredentialDocument:document}=require('../dist/credential-document');
const native=name=>({name,auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:'access-'+name,refresh_token:'refresh-'+name,account_id:name}});
const a=native('A'),b=native('B'),ja=JSON.stringify(a),jb=JSON.stringify(b);
const extract=text=>document(Buffer.from(text),'codex').entries;
const two=text=>assert.deepEqual(extract(text).map(e=>JSON.parse(e.data).tokens.account_id),['A','B']);

for(const [name,text] of [
 ['comma-separated objects',ja+',\n'+jb],
 ['JSON text sequence','\x1e'+ja+'\n\x1e'+jb],
 ['multiple JSON blocks','```json\n'+ja+'\n```\n\n```json\n'+jb+'\n```'],
 ['tilde-fenced JSONL','~~~jsonl\n'+ja+'\n'+jb+'\n~~~'],
 ['wrapped JSON Lines string',JSON.stringify({payload:ja+'\n'+jb})],
]) test('account boundaries: '+name,()=>two(text));

test('valid JSON always retains its original structure, even with delimiter-like string contents',()=>{
 const special='string }{ , // /* */ ] [ \\" \\\\ ```json\n';
 const value={name:special,'字段😀': [null, false, 1.2e-4],accounts:[{...a,note:special},{...b,note:'https://example.test/path//?x=/*x*/'}],literal:'{"tokens":{"access_token":"fake"}}'};
 assert.deepEqual(parse(JSON.stringify(value)),value);
 const tokens={access_token:special,refresh_token:'refresh"}{\\token',account_id:'A'};
 const entries=extract(JSON.stringify({tokens})+jb);
 assert.deepEqual(JSON.parse(entries[0].data).tokens,tokens);
 assert.equal(entries.length,2);
});

test('outside comments may be removed but strings containing comments, commas and URLs are unchanged',()=>{
 const value={...a,tokens:{...a.tokens,access_token:'https://example.test/a//b/*c*/?v=,}'}},str=JSON.stringify(value);
 assert.deepEqual(parse('// heading\n'+str.slice(0,-1)+', /* trailing */ }\n// end'),value);
});

test('truncated, mismatched and unexplained separators never partially import earlier valid accounts',()=>{
 for(const text of [ja+'\n{"tokens":',ja+',',ja+',,'+jb,ja+'\n文字说明\n'+jb,ja+';'+jb,'prefix '+ja,ja+' trailing',ja+' [}',ja+' {"text":"unterminated', '```json\n'+ja, '```json\n'+ja+'\n```\nexplanation', '[ '+ja+jb+' ]',ja+'/* unclosed']){
  assert.throws(()=>extract(text),/JSON/);
 }
});

test('duplicate keys including escaped spellings are rejected instead of silently overwriting an account',()=>{
 for(const text of ['{"tokens":{},"tokens":{}}','{"tokens":{"access_token":"first","access_token":"second"}}','{"tokens":{},"to\\u006bens":{}}',ja+'\n{"tokens":{},"tokens":{}}']){
  assert.throws(()=>parse(text),/重复字段/);
 }
 assert.deepEqual(parse('[{"name":"same"},{"name":"same"}]'),[{name:'same'},{name:'same'}]);
});

test('metadata named tokens is not mistaken for a native account and empty API key does not conflict with OAuth',()=>{
 for(const tokens of [{total:300,used:20},'unlimited',null])two(JSON.stringify({tokens,accounts:[a,b]}));
 const entries=extract(JSON.stringify({...a,OPENAI_API_KEY:''}));
 assert.equal(entries.length,1);assert.equal(entries[0].error,undefined);
 two(JSON.stringify({tokens:[a,b]}));
});

test('balanced objects with missing credentials stay separate from other valid objects',()=>{
 const entries=extract('{"tokens":{"access_token":"unpaired"}}\n'+jb);
 assert.equal(entries.length,2);assert.match(entries[0].error,/不完整/);
 assert.equal(JSON.parse(entries[1].data).tokens.refresh_token,'refresh-B');
});

test('resource bounds apply to sequences and fenced sequences as well as arrays',()=>{
 assert.throws(()=>parse(Array(201).fill(ja).join('\n')),/200/);
 assert.throws(()=>parse(Array(201).fill('```json\n'+ja+'\n```').join('\n')),/200/);
});

test('native token containers encoded twice retain their parent auth mode and token metadata',()=>{
 const tokens={...a.tokens,login_owner_id:'owner',oauth_provenance:{issuer:'https://auth.openai.com',client_id:'fixture'}};
 const result=extract(JSON.stringify({auth_mode:'chatgpt',tokens:JSON.stringify(JSON.stringify(tokens))}));
 assert.deepEqual(JSON.parse(result[0].data),{auth_mode:'chatgpt',tokens});
});

test('UTF-8 BOM and explicit UTF-16 BOMs preserve account content; malformed bytes are never replaced',()=>{
 const json=JSON.stringify([a,b]);
 const le=Buffer.from('\ufeff'+json,'utf16le'),be=Buffer.from(le).swap16();
 for(const bytes of [Buffer.from('\ufeff'+json),le,be])assert.deepEqual(document(bytes,'codex').entries.map(e=>JSON.parse(e.data).tokens.account_id),['A','B']);
 assert.throws(()=>document(Buffer.concat([Buffer.from('{"tokens":"'),Buffer.from([0xff]),Buffer.from('"}')]),'codex'),/编码/);
 assert.throws(()=>document(le.subarray(0,le.length-1),'codex'),/编码/);
});
