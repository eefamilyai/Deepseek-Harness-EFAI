
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find(t => t.type === 'page' && t.url.startsWith('dsh-app://'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }))
const out = []
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
    if (/error|fail|skills|warn/i.test(text) || msg.params.type === 'error') out.push(`[${msg.params.type}] ${text}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') out.push('[exception] ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text))
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') out.push('[log] ' + msg.params.entry.text)
}
ws.onopen = () => { send('Runtime.enable'); send('Log.enable'); setTimeout(() => send('Page.reload'), 300) }
setTimeout(() => { console.log(out.join('\n').slice(0, 8000)); process.exit(0) }, 25000)
