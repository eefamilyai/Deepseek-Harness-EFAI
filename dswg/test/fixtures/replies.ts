/**
 * Reply fixtures: the shapes a long context actually produces.
 *
 * Each entry is a model reply and the tool names reading it must produce. The
 * captured ones are real replies from this machine's transcripts; the rest are
 * the shapes those transcripts named. The point of the list is regression
 * pressure in both directions: a shape that stops being read is a turn the model
 * spends for nothing, and a shape that starts being read is code being executed.
 *
 * @module dswg/test/fixtures/replies
 */

/** One reply and what reading it must produce. */
export interface ReplyFixture {
  /** Short label, used in the test name. */
  name: string
  /** The reply exactly as the model wrote it. */
  text: string
  /** Tool names the reply must yield, in order. */
  expect: string[]
  /** Where the shape comes from, for whoever reads a failure. */
  origin: string
}

/** The tools every fixture request declares. */
export const FIXTURE_TOOLS = ["read","write","edit","glob","grep","kernel","skill","pwsh","todo_write","subagent","job_output","get_weather"] as const

/** Replies that carry a call. */
export const CALL_REPLIES: ReplyFixture[] = [
  {
    "name": "captured-344",
    "text": "The user wants a commit and push. Let me load the required skills first — `dsh-harness-edit` before committing, `dsh-github` for the operation, and `dsh-pre-push-checks` before pushing.\n\n<tool_calls>\n\n<invoke name=\"skill\">\n<parameter name=\"name\">dsh-harness-edit</parameter>\n</parameter>\n</invoke>\n<invoke name=\"skill\">\n<parameter name=\"name\">dsh-github</parameter>\n</parameter>\n</invoke>\n<invoke name=\"skill\">\n<parameter name=\"name\">dsh-pre-push-checks</parameter>\n</parameter>\n</invoke>\n</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n",
    "expect": [
      "skill",
      "skill",
      "skill"
    ],
    "origin": "captured reply 344"
  },
  {
    "name": "captured-490",
    "text": "<invoke name=\"read\">\n<parameter name=\"file_path\" string=\"true\">D:\\deepseek-kernel-harness\\python\\kiln\\runtime\\ds_direct.py</parameter>\n<parameter name=\"offset\" string=\"false\">1135</parameter>\n<parameter name=\"limit\" string=\"false\">90</parameter>\n</parameter>\n</invoke>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n\n",
    "expect": [
      "read"
    ],
    "origin": "captured reply 490"
  },
  {
    "name": "captured-674",
    "text": "tsx produced no output at all — let me stop fighting the runner and use the repo's own test harness instead, which is the native path for this package.\n\n<tool_calls>\n<invoke name=\"write\">\n<parameter name=\"file_path\">D:\\deepseek-kernel-harness\\packages\\llm\\llm-dsml\\tests\\probe-stray-closer.spec.ts</parameter>\n<parameter name=\"content\">import { describe, expect, it } from 'vitest'\nimport { DsmlTranslator } from '../src/dsml.ts'\nimport type { ToolSchema } from '@deepseek-ai/dsh-llm'\n\nconst schema = (name: string, props: Record<string, unknown>, required: string[] = []): ToolSchema => ({\n  name,\n  description: `${name} tool`,\n  parameters: { type: 'object', properties: props, required },\n}) as unknown as ToolSchema\n\nconst tools = new Map<string, ToolSchema>([\n  ['skill', schema('skill', { name: { type: 'string' } }, ['name'])],\n  ['read', schema('read', { path: { type: 'string' } }, ['path'])],\n  ['kernel', schema('kernel', { code: { type: 'string' } }, ['code'])],\n])\n\nconst P = '\\uFF5C'\nconst dsml = (attrs: string) => `<${P}${P}DSML${P}${P}${attrs}>`\n\nfunction run(text: string) {\n  const t = new DsmlTranslator(tools, { notes: true })\n  return [...t.push(text.endsWith('\\n') ? text : `${text}\\n`), ...t.end()]\n}\n\ndescribe('probe: stray duplicate </parameter>', () => {\n  it('A — native DSML, stray closer per invoke (the reported shape)', () => {\n    const text = [\n      dsml(' calls>'),\n      `${dsml(' invoke name=\"skill\"')} ${dsml(' parameter name=\"name\"')}dsh-harness-edit</parameter> </parameter> </invoke>`,\n      `${dsml(' invoke name=\"skill\"')} ${dsml(' parameter name=\"name\"')}dsh-github</parameter> </parameter> </invoke>`,\n      `${dsml(' invoke name=\"skill\"')} ${dsml(' parameter name=\"name\"')}dsh-pre-push-checks</parameter> </parameter> </invoke>`,\n      '</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n',\n      '',\n    ].join('\\n')\n    const events = run(text)\n    // eslint-disable-next-line no-console\n    console.log('A events:', JSON.stringify(events, null, 2))\n    expect(events.filter(e => e.kind === 'tool-call')).toHaveLength(3)\n  })\n\n  it('B — taught xml, stray closer per invoke', () => {\n    const text = [\n      '<tool_calls>',\n      '<invoke name=\"skill\"> <parameter name=\"name\">dsh-harness-edit</parameter> </parameter> </invoke>',\n      '<invoke name=\"skill\"> <parameter name=\"name\">dsh-github</parameter> </parameter> </invoke>',\n      '<invoke name=\"skill\"> <parameter name=\"name\">dsh-pre-push-checks</parameter> </parameter> </invoke>',\n      '</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n',\n      '',\n    ].join('\\n')\n    const events = run(text)\n    // eslint-disable-next-line no-console\n    console.log('B events:', JSON.stringify(events, null, 2))\n    expect(events.filter(e => e.kind === 'tool-call')).toHaveLength(3)\n  })\n\n  it('C — control: well-formed still dispatches', () => {\n    const events = run('",
    "expect": [
      "write"
    ],
    "origin": "captured reply 674"
  },
  {
    "name": "captured-816",
    "text": "Rename landed, `tsc exit: 0`. Now the tests plus a probe against your exact block — placeholders keep the literal tags out of my own payload:\n\n<tool_calls>\n<invoke name=\"kernel\">\n<parameter name=\"code\"># Write a probe for the surplus-closer block, then run the dsml tests\nfrom pathlib import Path\nimport subprocess\n\nroot = Path(r\"D:\\deepseek-kernel-harness\")\nGT = chr(62)\nPOPEN = \"<\" + \"parameter\"\nPCLOSE = \"<\" + \"/parameter\" + GT\nIOPEN = \"<\" + \"invoke\"\nICLOSE = \"<\" + \"/invoke\" + GT\nTCO = \"<\" + \"tool_calls\" + GT\nTCC = \"<\" + \"/tool_calls\" + GT\n\nbody = '''import { DsmlTranslator } from \"file:///D:/deepseek-kernel-harness/packages/llm/llm-dsml/src/dsml.ts\"\n\ntype Schema = { name: string; description: string; parameters: Record<string, unknown> }\nconst schema = (name: string, props: Record<string, unknown>, required: string[] = []): Schema => ({\n  name,\n  description: name + \" tool\",\n  parameters: { type: \"object\", properties: props, required },\n})\nconst tools = new Map<string, Schema>([\n  [\"skill\", schema(\"skill\", { name: { type: \"string\" } }, [\"name\"])],\n  [\"read\", schema(\"read\", { file_path: { type: \"string\" } }, [\"file_path\"])],\n])\n\nfunction run(label: string, text: string) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  const t = new (DsmlTranslator as any)(tools, { notes: true })\n  const events = [...t.push(text.endsWith(\"\\\\n\") ? text : text + \"\\\\n\"), ...t.end()]\n  console.log(\"=== \" + label + \" ===\")\n  for (const e of events) {\n    if (e.kind === \"tool-call\") console.log(\"  CALL  \" + e.name + \" \" + e.arguments)\n    else console.log(\"  TEXT  \" + JSON.stringify(String(e.text).slice(0, 300)))\n  }\n  if (!events.some((e: { kind: string }) => e.kind === \"tool-call\")) console.log(\"  >>> NO CALLS DISPATCHED <<<\")\n  console.log()\n}\n\n// A: the user's exact shape - each argument closed, one surplus closer, wrapper closed.\nrun(\"A surplus closer (user's block)\", [\n  \"@@TCO@@\",\n  \"@@IOPEN@@ name=\\\\\"skill\\\\\"> @@POPEN@@ name=\\\\\"name\\\\\">dsh-harness-edit@@PCLOSE@@ @@PCLOSE@@ @@ICLOSE@@\",\n  \"@@IOPEN@@ name=\\\\\"skill\\\\\"> @@POPEN@@ name=\\\\\"name\\\\\">dsh-github@@PCLOSE@@ @@PCLOSE@@ @@ICLOSE@@\",\n  \"@@IOPEN@@ name=\\\\\"skill\\\\\"> @@POPEN@@ name=\\\\\"name\\\\\">dsh-pre-push-checks@@PCLOSE@@ @@PCLOSE@@ @@ICLOSE@@\",\n  \"@@TCC@@\",\n].join(\"\\\\n\"))\n\n// B: the control - the same three calls written correctly.\nrun(\"B well-formed control\", [\n  \"@@TCO@@\",\n  \"@@IOPEN@@ name=\\\\\"skill\\\\\">@@POPEN@@ name=\\\\\"name\\\\\">dsh-harness-edit@@PCLOSE@@@@ICLOSE@@\",\n  \"@@IOPEN@@ name=\\\\\"skill\\\\\">@@POPEN@@ name=\\\\\"name\\\\\">dsh-github@@PCLOSE@@@@ICLOSE@@\",\n  \"@@TCC@@\",\n].join(\"\\\\n\"))\n\n// C: a genuinely unfinished call - last opener never closed. Must stay prose.\nrun(\"C truncated call (must NOT dispatch)\", [\n  \"@@TCO@@\",\n  \"@@IOPEN@@ name=\\\\\"skill\\\\\">@@POPEN@@ name=\\\\\"name\\\\\">dsh-harness-edit\",\n].join(\"\\\\n\"))\n\n// D: no </invoke>, wrapper closed, parameters all closed, one surplus closer.\nrun(\"D wrapper-closed with surplus closer\", [\n  \"@@TCO@@\",\n  \"@@IOPEN@@ name=\\\\\"read\\\\\">@@POPEN@@ name=\\\\\"file_path\\\\\">D:/x.ts@@PCLOSE@@@@PCLOSE@@\",\n  \"@@TCC@@\",\n].join(\"\\\\n\"))\n'''\n\nfor token, value in ((\"@@TCO@@\", TCO), (\"@@TCC@@\", TCC), (\"@@IOPEN@@\", IOPEN),\n                     (\"@@ICLOSE@@\", ICLOSE), (\"@@POPEN@@\", POPEN), (\"@@PCLOSE@@\", PCLOSE)):\n    body = body.replace(token, value)\n\nprobe = root / \".research-compaction\" / \"probe-dsml.mts\"\nprobe.write_text(body, encoding=\"utf-8\")\nprint(\"probe bytes:\", probe.stat().st_size)\n\nr = subprocess.run([\"pnpm\", \"exec\", \"tsx\", str(probe)], cwd=root,\n                   capture_output=True, text=True, shell=True)\nprint(\"=== probe exit:\", r.returncode, \"===\")\nprint(r.stdout)\nprint(r.stderr[-2000:])\n</parameter>\n</invoke>\n</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n",
    "expect": [
      "kernel"
    ],
    "origin": "captured reply 816"
  },
  {
    "name": "captured-838",
    "text": "Using `write` directly, with the probe building its tags from char codes so no literal tag sits in my payload:\n\n<tool_calls>\n<invoke name=\"write\">\n<parameter name=\"file_path\">D:\\deepseek-kernel-harness\\.research-compaction\\probe-dsml.mts</parameter>\n<parameter name=\"content\">// Probe: what does the DSML reader do with a surplus closer, and with a real truncation?\n// Every tag is built from char codes so this file itself contains no literal markup.\nimport { DsmlTranslator } from \"file:///D:/deepseek-kernel-harness/packages/llm/llm-dsml/src/dsml.ts\"\n\nconst LT = String.fromCharCode(60)\nconst GT = String.fromCharCode(62)\nconst TCO = LT + \"tool_calls\" + GT\nconst TCC = LT + \"/tool_calls\" + GT\nconst IO = LT + \"invoke\"\nconst IC = LT + \"/invoke\" + GT\nconst PO = LT + \"parameter\"\nconst PC = LT + \"/parameter\" + GT\n\ntype Schema = { name: string; description: string; parameters: Record<string, unknown> }\nconst schema = (n: string, p: Record<string, unknown>, r: string[] = []): Schema => ({\n  name: n,\n  description: n,\n  parameters: { type: \"object\", properties: p, required: r },\n})\nconst tools = new Map<string, Schema>([\n  [\"skill\", schema(\"skill\", { name: { type: \"string\" } }, [\"name\"])],\n  [\"read\", schema(\"read\", { file_path: { type: \"string\" } }, [\"file_path\"])],\n])\n\nfunction run(label: string, text: string): void {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  const t = new (DsmlTranslator as any)(tools, { notes: true })\n  const ev = [...t.push(text.endsWith(\"\\n\") ? text : text + \"\\n\"), ...t.end()]\n  console.log(\"=== \" + label + \" ===\")\n  for (const e of ev) {\n    if (e.kind === \"tool-call\") console.log(\"  CALL  \" + e.name + \" \" + e.arguments)\n    else console.log(\"  TEXT  \" + JSON.stringify(String(e.text).slice(0, 260)))\n  }\n  if (!ev.some((e: { kind: string }) => e.kind === \"tool-call\")) console.log(\"  >>> NO CALLS <<<\")\n  console.log()\n}\n\nconst skill = (n: string) => IO + ' name=\"skill\"' + GT + PO + ' name=\"name\"' + GT + n + PC\n\n// A: the user's exact shape — each argument closed, one surplus closer, then </invoke>.\nconst A = [TCO, skill(\"dsh-harness-edit\") + \" \" + PC + \" \" + IC,\n                   skill(\"dsh-github\") + \" \" + PC + \" \" + IC,\n                   skill(\"dsh-pre-push-checks\") + \" \" + PC + \" \" + IC, TCC].join(\"\\n\")\n\n// B: control — the same call written correctly.\nconst B = [TCO, skill(\"dsh-github\") + IC, TCC].join(\"\\n\")\n\n// C: a genuinely unfinished call — the last opener never closes. Must stay prose.\nconst C = [TCO, IO + ' name=\"skill\"' + GT + PO + ' name=\"name\"' + GT + \"dsh-harness-edit\"].join(\"\\n\")\n\n// D: no </invoke>, wrapper closes it, all arguments closed, one surplus closer.\nconst D = [TCO, IO + ' name=\"read\"' + GT + PO + ' name=\"file_path\"' + GT + \"D:/x.ts\" + PC + PC, TCC].join(\"\\n\")\n\nrun(\"A  surplus closer (user's block)\", A)\nrun(\"B  well-formed control\", B)\nrun(\"C  truncated (must NOT dispatch)\", C)\nrun(\"D  wrapper-closed, surplus closer\", D)\n</parameter>\n</invoke>\n</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n",
    "expect": [
      "write"
    ],
    "origin": "captured reply 838"
  },
  {
    "name": "captured-1160",
    "text": "<tool_calls>\n<invoke name=\"edit\">\n<parameter name=\"file_path\">D:\\deepseek-kernel-harness\\packages\\llm\\llm-dsml\\src\\dsml.ts</parameter>\n<parameter name=\"old_string\">  const open = (body.match(/<parameter\\b/gi) ?? []).length\n  const close = (body.match(/<\\/parameter\\s*>/gi) ?? []).length\n  return open > close\n}\n\n/** Escape a tool name for embedding in a `RegExp`. Names are identifiers, but a stray metachar must never widen the match. */</parameter>\n<parameter name=\"new_string\">  const counts = parameterCounts(body)\n  return counts.open > counts.close\n}\n\n/**\n * How many parameter openers and closers a body holds.\n *\n * The two counts answer two different questions and must not be collapsed into\n * one boolean. {@link unfinished} asks whether an opener is still waiting for\n * its closer; the surplus-closer check in `parseCalls` asks whether a FINISHED\n * body closed one time too many. Reading them against each other made a\n * complete call carrying a stray closer look truncated, so it fell through to\n * prose and drew a note telling the model its tool did not exist.\n *\n * A parameter element never nests, so counting is exact.\n * @param body - the text between one invoke's tags, or up to the next invoke.\n * @returns the opener count and the closer count, uncompared.\n */\nfunction parameterCounts(body: string): { readonly open: number; readonly close: number } {\n  return {\n    open: (body.match(/<parameter\\b/gi) ?? []).length,\n    close: (body.match(/<\\/parameter\\s*>/gi) ?? []).length,\n  }\n}\n\n/** Escape a tool name for embedding in a `RegExp`. Names are identifiers, but a stray metachar must never widen the match. */</parameter>\n</invoke>\n</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n",
    "expect": [
      "edit"
    ],
    "origin": "captured reply 1160"
  },
  {
    "name": "captured-17659",
    "text": "Both edits landed, but the type-check section now references `_region`, which is defined further down. Reading the file to fix the ordering.\n\n<tool_calls>\n<invoke name=\"read\">\n<｜｜DSML｜｜ file_path=\"D:\\deepseek-kernel-harness\\python\\kiln\\runtime\\test_ds_direct_biz_verdict.py\">\n<parameter name=\"offset\">100</invoke>\n<parameter name=\"limit\">60</invoke>\n</invoke>\n</tool_calls>\n\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n",
    "expect": [
      "read"
    ],
    "origin": "captured reply 17659"
  },
  {
    "name": "taught-envelope",
    "text": "Let me look.\n<tool_call>{\"name\":\"read\",\"arguments\":{\"file_path\":\"a.ts\"}}</tool_call>\n",
    "expect": [
      "read"
    ],
    "origin": "the taught envelope"
  },
  {
    "name": "special-token",
    "text": "On it.\n<|tool_call|>{\"name\":\"glob\",\"arguments\":{\"pattern\":\"**/*.ts\"}}<|/tool_call|>\n",
    "expect": [
      "glob"
    ],
    "origin": "DeepSeek special tokens"
  },
  {
    "name": "piped-single",
    "text": "Working.\n<｜tool_call｜>{\"name\":\"grep\",\"arguments\":{\"pattern\":\"x\"}}<｜/tool_call｜>\n",
    "expect": [
      "grep"
    ],
    "origin": "single-pipe token spelling"
  },
  {
    "name": "dsml-double-pipe",
    "text": "Go.\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"read\">\n<｜｜DSML｜｜parameter name=\"file_path\" string=\"true\">src/a.ts</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>\n",
    "expect": [
      "read"
    ],
    "origin": "DSML with double pipes"
  },
  {
    "name": "invoke-with-stray-closer",
    "text": "<tool_calls>\n<invoke name=\"skill\">\n<parameter name=\"name\">dsh-github</parameter>\n</parameter>\n</invoke>\n</tool_calls>",
    "expect": [
      "skill"
    ],
    "origin": "a stray closer between parameters"
  },
  {
    "name": "orphan-invoke",
    "text": "<invoke name=\"read\">\n<parameter name=\"file_path\" string=\"true\">src/a.ts</parameter>\n</invoke>\n",
    "expect": [
      "read"
    ],
    "origin": "an invoke with no wrapper"
  },
  {
    "name": "orphan-invoke-bare-tag",
    "text": "<invoke name=\"write\">\n<parameter name=\"file_path\">a.md</parameter>\n<content># Title\n\nBody.\n</parameter>\n</invoke>\n",
    "expect": [
      "write"
    ],
    "origin": "a bare element naming its argument"
  },
  {
    "name": "invoke-json-body",
    "text": "<invoke name=\"get_weather\">{\"city\":\"Lima\"}</invoke>\n",
    "expect": [
      "get_weather"
    ],
    "origin": "an invoke holding one JSON object"
  },
  {
    "name": "fenced-json",
    "text": "Sure.\n```json\n{\"name\":\"read\",\"arguments\":{\"file_path\":\"b.ts\"}}\n```\n",
    "expect": [
      "read"
    ],
    "origin": "a fenced JSON object"
  },
  {
    "name": "bare-json-at-line",
    "text": "Calling now.\n{\"name\":\"glob\",\"arguments\":{\"pattern\":\"*.md\"}}\n",
    "expect": [
      "glob"
    ],
    "origin": "a bare object at the start of a line"
  },
  {
    "name": "flattened-one-line",
    "text": "<tool_calls><invoke name=\"kernel\"><parameter name=\"code\">print(1)</parameter></invoke></tool_calls>",
    "expect": [
      "kernel"
    ],
    "origin": "a block flattened onto one line"
  },
  {
    "name": "orphan-closer-blob",
    "text": "Here is the result.\n{\"name\":\"read\",\"arguments\":{\"file_path\":\"/etc/hosts\"}}</tool_call>",
    "expect": [
      "read"
    ],
    "origin": "an object with only its closer"
  },
  {
    "name": "call-syntax",
    "text": "I will run get_weather(city=\"Berlin\") now.",
    "expect": [
      "get_weather"
    ],
    "origin": "function-call syntax"
  },
  {
    "name": "truncated-args",
    "text": "Running.\n<tool_call>{\"name\":\"kernel\",\"arguments\":{\"code\":\"print(1)\"",
    "expect": [
      "kernel"
    ],
    "origin": "JSON cut off by the length limit"
  },
  {
    "name": "multi-call",
    "text": "<tool_calls><invoke name=\"read\"><parameter name=\"file_path\">a</parameter></invoke><invoke name=\"read\"><parameter name=\"file_path\">b</parameter></invoke></tool_calls>",
    "expect": [
      "read",
      "read"
    ],
    "origin": "two calls in one block"
  },
  {
    "name": "name-case",
    "text": "<tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"c.ts\"}}</tool_call>",
    "expect": [
      "read"
    ],
    "origin": "a name in the wrong case"
  },
  {
    "name": "missing-required",
    "text": "<tool_call>{\"name\":\"read\",\"arguments\":{}}</tool_call>",
    "expect": [
      "read"
    ],
    "origin": "a call missing a required argument"
  }
]

/** Replies that carry none. */
export const PROSE_REPLIES: ReplyFixture[] = [
  {
    "name": "prose-quoting-python",
    "text": "The cell ran `grep(r\"x\", \"packages\")` and matched three files, so `read(p).close()` came next.",
    "expect": [],
    "origin": "prose quoting Python"
  },
  {
    "name": "prose-quoted-fixture",
    "text": "Example fixture:\n\n```ts\nconst D = '<tool_calls><invoke name=\"skill\"><parameter name=\"name\">dsh-github</parameter></invoke></tool_calls>'\n```\n",
    "expect": [],
    "origin": "a quoted fixture inside a code block"
  },
  {
    "name": "prose-only",
    "text": "Nothing to do — the file already contains what you asked for.",
    "expect": [],
    "origin": "an ordinary answer"
  },
  {
    "name": "code-listing-with-markup",
    "text": "Here is the test I would write:\n\n```ts\nconst events = run('<tool_calls>\\n<invoke name=\"skill\">\\n<parameter name=\"name\">x</parameter>\\n</invoke>\\n</tool_calls>')\nexpect(events).toHaveLength(1)\n```\n",
    "expect": [],
    "origin": "markup inside a code listing"
  }
]

/**
 * Replies that tried to call and cannot be read completely.
 *
 * Nothing is executed from these — the argument itself is what went missing — and
 * answering with the half-written block as prose would look to the model like an
 * action that returned nothing. They are reported so the turn can be retried.
 */
export const UNREADABLE_REPLIES: ReplyFixture[] = [
  {
    "name": "truncated-payload",
    "text": "<tool_calls> <parameter name=\"code\" string=\"true\">grep(r\"instruction\", \"packages\", include=\"*.ts\")</parameter>",
    "expect": [],
    "origin": "a call whose header was lost, so nothing can be run"
  }
]
