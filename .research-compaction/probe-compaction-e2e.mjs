
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)

// 1. The built summarizer module: does it export the instruction builders?
const sum = await import('file:///D:/deepseek-kernel-harness/packages/compaction/compaction-basic/lib/types/summarizer.js')
console.log('SUMMARIZER EXPORTS:', Object.keys(sum).sort().join(' '))

// 2. `/compact <text>` admission: the command definition must carry an input descriptor.
const cc = await import('file:///D:/deepseek-kernel-harness/packages/compaction/command-compact/lib/index.js')
console.log('COMMAND-COMPACT EXPORTS:', Object.keys(cc).sort().join(' '))

// 3. buildCompactionInstruction: does the per-call instruction survive into the trailing message?
if (typeof sum.buildCompactionInstruction === 'function') {
  const out = sum.buildCompactionInstruction('standing rule', 'The gist of the workspace, also mostly parser problems')
  console.log('HAS_EXTRAS:', out.includes('standing rule'), out.includes('The gist of the workspace'))
  console.log('EXCERPT:', out.slice(-320).replace(/\s+/g, ' '))
}

// 4. Source-of-truth grep on the built bytes: are the fork's markers really in the artifact?
const fs = await import('node:fs')
for (const rel of ['packages/compaction/compaction-basic/lib/types/summarizer.js',
                   'packages/compaction/command-compact/lib/index.js',
                   'packages/llm/llm-dsml/lib/index.js']) {
  const t = fs.readFileSync('D:/deepseek-kernel-harness/' + rel, 'utf8')
  console.log(rel.split('/').pop(),
    '| summarized-conversation:', t.includes('summarized-conversation'),
    '| transcript-summarization engine:', t.includes('transcript-summarization engine'),
    '| <instruction> hint:', t.includes('[<instruction>]'),
    '| orphanParameterCall:', t.includes('orphanParameterCall'))
}
