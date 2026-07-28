import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')
const context = vm.createContext({})

const alignmentStart = html.indexOf('function normalizeToken')
const alignmentEnd = html.indexOf('let pendingSeek', alignmentStart)
assert.ok(alignmentStart >= 0 && alignmentEnd > alignmentStart)
vm.runInContext(html.slice(alignmentStart, alignmentEnd), context)

const transcript = {
  sentenceAlignment: [
    { text: 'des Morgens verkündet.', start: 22.44, end: 23.18 },
    { text: 'Sehr gerne, da muss ich darauf konzentrieren.', start: 23.18, end: 24.76 },
    { text: 'Einen schönen guten Morgen.', start: 28.38, end: 30 },
  ],
  wordAlignment: [
    { word: 'des', start: 22.44, end: 22.7 },
    { word: 'Morgens', start: 22.7, end: 23.16 },
    { word: 'verkündet.', start: 23.16, end: 23.18 },
    { word: 'Sehr', start: 23.18, end: 23.32 },
    { word: 'gerne,', start: 23.32, end: 23.56 },
    { word: 'da', start: 23.84, end: 23.98 },
    { word: 'muss', start: 23.98, end: 24.12 },
    { word: 'ich', start: 24.12, end: 24.18 },
    { word: 'darauf', start: 24.18, end: 24.3 },
    { word: 'konzentrieren.', start: 24.3, end: 24.76 },
    { word: 'Einen', start: 28.38, end: 29.26 },
    { word: 'schönen', start: 29.26, end: 29.62 },
    { word: 'guten', start: 29.62, end: 29.82 },
    { word: 'Morgen.', start: 29.82, end: 30 },
  ],
}

context.transcript = transcript
vm.runInContext('buildSentenceRenderMaps(transcript)', context)

assert.equal(transcript.sentenceAlignment[0].alignedWords.at(-1).word, 'verkündet.')
assert.equal(transcript.sentenceAlignment[1].alignedWords[0].word, 'Sehr')
assert.equal(
  transcript.sentenceAlignment[1].alignedWords.some((word) => word.word === 'verkündet.'),
  false,
)
assert.equal(transcript.sentenceAlignment[1].renderMap.length, 7)
assert.equal(transcript.sentenceAlignment[1].playbackStart, 23.18)

context.sentences = transcript.sentenceAlignment
assert.equal(vm.runInContext('findActiveSentenceIndex(sentences, 23.179)', context), 0)
assert.equal(vm.runInContext('findActiveSentenceIndex(sentences, 23.18)', context), 1)
assert.equal(vm.runInContext('findActiveSentenceIndex(sentences, 27)', context), 1)
assert.equal(vm.runInContext('findActiveSentenceIndex(sentences, 28.38)', context), 2)

const imperfectAsr = {
  sentenceAlignment: [
    { text: 'Sehr wirklich gerne', start: 1, end: 2 },
  ],
  wordAlignment: [
    { text: 'Sehr', start: 1, end: 1.2 },
    { text: 'völlig', start: 1.2, end: 1.6 },
    { text: 'gerne', start: 1.6, end: 2 },
  ],
}
context.imperfectAsr = imperfectAsr
vm.runInContext('buildSentenceRenderMaps(imperfectAsr)', context)
assert.equal(
  imperfectAsr.sentenceAlignment[0].alignedWords.map((word) => word.text).join('|'),
  'Sehr|völlig|gerne',
)
assert.equal(imperfectAsr.sentenceAlignment[0].renderMap.length, 3)

const renderStart = html.indexOf('function renderSentence(sentence, activeWord)')
const renderEnd = html.indexOf('// === Reset karaoke state', renderStart)
assert.ok(renderStart >= 0 && renderEnd > renderStart)
context.escapeHtml = (value) => String(value)
context.formatTime = (value) => `time:${value}`
context.showTranslation = false
vm.runInContext(html.slice(renderStart, renderEnd), context)
context.unmappedSentence = {
  text: 'Fallback sentence',
  start: 23.18,
  renderMap: [],
}
const fallbackHtml = vm.runInContext('renderSentence(unmappedSentence, null)', context)
assert.match(fallbackHtml, /karaoke-timestamp/)
assert.match(fallbackHtml, /time:23\.18/)
assert.match(fallbackHtml, /Fallback sentence/)

console.log('alignment regression tests passed')
