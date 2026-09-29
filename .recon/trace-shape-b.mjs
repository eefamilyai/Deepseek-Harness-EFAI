import { DsmlTranslator } from './packages/llm/llm-text-toolcalls/lib/index.js'
const LT=String.fromCharCode(60), GT=String.fromCharCode(62), SL=String.fromCharCode(47)
const op=(n,a='')=>LT+n+(a?' '+a:'')+GT, sh=(n)=>LT+SL+n+GT
const TOOLS=[
 {name:'pwsh',description:'Run a PowerShell command.',parameters:{type:'object',properties:{command:{type:'string'},description:{type:'string'}},required:['command','description']}},
 {name:'get_goal',description:'Read the goal.',parameters:{type:'object',properties:{},required:[]}},
 {name:'list_agents',description:'List agents.',parameters:{type:'object',properties:{scope:{type:'string'}},required:[]}},
 {name:'read',description:'Read a file.',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}},
]
const INDEX=new Map(TOOLS.map(t=>[t.name,t]))
const block =
  op('tool_calls')+'\n'+
  op('parameter','name="command"')+'Write-Host "x"'+sh('parameter')+' '+sh('invoke')+
  op('parameter','name="description"')+'Inspect state'+sh('parameter')+
  op('parameter','name="get_goal"')+sh('invoke')+' '+
  op('parameter','name="list_agents"')+' '+
  op('parameter','scope')+'children'+sh('parameter')+' '+
  sh('invoke')+' '+sh('tool_calls')
const t=new DsmlTranslator(INDEX)
const out=[...t.push(block),...t.end()]
for (const e of out) console.log(e.kind, JSON.stringify(e).slice(0,400))
